import { NextResponse } from "next/server";
import { shortenLinks } from "@/lib/recovery/short-links";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryRow, RecoverySettings, WhatsappMessageRow, WhatsappSessionRow } from "@/lib/recovery/types";
import { pickSession } from "@/lib/recovery/sessions";
import { chatIdFromPhone, normalizePhone } from "@/lib/recovery/phone";
import { getSession, sendText, wahaConfigured, WahaError } from "@/lib/whatsapp/waha";
import { translateReplyForCustomer } from "@/lib/ai/translate-reply";
import { stripDashes } from "@/lib/text/dashes";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { authorize, dbError, errMessage, isUuid, jsonError, nowIso, parseBody, phoneSuppressed, STOPPED_BY_CUSTOMER } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Envio humano pelo chat ao vivo. Ao enviar (e SÓ se o envio deu certo), você
// ASSUME a conversa (agent_mode = humano): o agente para de responder até
// você devolver. Envio falho ou recusado não muda nada na conversa. Envio de
// TESTE (foi para o test_phone, não para o cliente) também não assume a
// conversa nem mexe nos horários da régua.
// Mesmas travas do agente e do motor: WhatsApp ligado na loja, WAHA
// configurado, sessão WORKING, e em MODO DE TESTE a mensagem vai para o
// test_phone da loja (is_test = true), nunca para o cliente real. A chave
// geral da régua (enabled) NÃO é exigida: responder um cliente que escreveu
// não é régua. Cliente que pediu para parar (status) ou telefone suprimido
// = 409, nada sai. Falha fechado em qualquer erro.

const BodySchema = z.object({
  text: z.string().trim().min(1, "texto vazio").max(4000),
  translate: z.boolean().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

const today = () => new Date().toISOString().slice(0, 10);

// Sessão fixa do cliente, se ainda serve (ativa, WORKING, não restrita).
async function fixedSession(admin: ReturnType<typeof createAdminClient>, name: string | null): Promise<WhatsappSessionRow | null> {
  if (!name) return null;
  const { data } = await admin.from("whatsapp_sessions").select("*").eq("name", name).maybeSingle();
  const s = data as WhatsappSessionRow | null;
  if (!s || !s.active || s.status !== "WORKING") return null;
  if (s.restricted_until && new Date(s.restricted_until).getTime() > Date.now()) return null;
  return s;
}

export async function POST(request: Request, { params }: Ctx) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const { data, response } = await parseBody(request, BodySchema);
  if (response) return response;
  if (!wahaConfigured()) return jsonError("WhatsApp (WAHA) não configurado: nada enviado.", 503);

  const admin = createAdminClient();
  const recRes = await admin.from("cart_recoveries").select("*").eq("id", id).maybeSingle();
  if (recRes.error) return dbError(recRes.error);
  const rec = recRes.data as RecoveryRow | null;
  if (!rec) return jsonError("conversa não encontrada", 404);
  if (!rec.phone) return jsonError("este carrinho não tem telefone", 400);

  // Cliente pediu para parar (stop no WhatsApp, descadastro pelo link) ou
  // telefone suprimido: nada sai, nem à mão.
  if (STOPPED_BY_CUSTOMER.has(rec.status)) return jsonError("o cliente pediu para não receber mais mensagens; envio bloqueado.", 409);
  if (await phoneSuppressed(admin, rec.phone)) return jsonError("este telefone está na lista de supressão (pediu para parar); envio bloqueado.", 409);

  // Chaves da loja: WhatsApp precisa estar ligado; em modo de teste o
  // destino é o test_phone. Sem linha de configuração = desligado (padrão).
  const setRes = await admin.from("recovery_settings").select("*").eq("store_id", rec.store_id).maybeSingle();
  if (setRes.error) return dbError(setRes.error);
  const settings = setRes.data as RecoverySettings | null;
  if (!settings || !settings.whatsapp_enabled) return jsonError("o canal WhatsApp está desligado para esta loja (Configuração > WhatsApp). Nada enviado.", 503);
  let target = rec.phone;
  const isTest = settings.test_mode;
  if (isTest) {
    const raw = settings.test_phone?.trim();
    if (!raw) return jsonError("modo de teste ligado e a loja não tem telefone de teste: defina o test_phone na Configuração ou desligue o modo de teste. Nada enviado.", 409);
    const normalized = normalizePhone(raw, null);
    if (!normalized) return jsonError(`telefone de teste inválido (${raw}): use o formato internacional (+5511999998888). Nada enviado.`, 409);
    target = normalized;
  }

  // Sessão: a fixa do cliente ou uma da loja (rotação do motor).
  let session: WhatsappSessionRow | null = await fixedSession(admin, rec.waha_session);
  if (!session) {
    try {
      session = await pickSession(admin, rec.store_id, rec);
    } catch (err) {
      return jsonError(`sem sessão de WhatsApp disponível: ${errMessage(err)}`, 503);
    }
  }
  if (!session) return jsonError("nenhum número de WhatsApp conectado (sessão WORKING) para esta loja.", 503);

  // Confere ao vivo no WAHA: a sessão precisa estar WORKING agora.
  try {
    const live = await getSession(session.name);
    if (!live || live.status !== "WORKING") {
      await admin.from("whatsapp_sessions").update({ status: live?.status ?? "STOPPED", updated_at: nowIso() }).eq("name", session.name);
      return jsonError(`a sessão ${session.name} não está conectada (status ${live?.status ?? "inexistente"}).`, 503);
    }
  } catch (err) {
    return jsonError(`não consegui confirmar a sessão no WAHA: ${errMessage(err)}`, 503);
  }

  // Texto final no idioma do cliente, sem travessão, sem português vazado.
  const original = data.text;
  let text = original;
  if (data.translate) {
    try {
      text = await translateReplyForCustomer(original, rec.language);
    } catch (err) {
      return jsonError(`falha ao traduzir: ${errMessage(err)}`, 502);
    }
  }
  text = stripDashes(text).trim();
  if (!text) return jsonError("texto vazio depois da limpeza", 400);
  const leak = portugueseLeak(text, rec.language);
  if (leak.length > 0) return jsonError(`texto com português misturado (${leak.join(", ")}). Revise antes de enviar.`, 409);

  try {
    text = await shortenLinks(admin, text);
  } catch (err) {
    return jsonError(`link curto: ${errMessage(err)}`, 503);
  }
  const chatId = chatIdFromPhone(target);
  let sent: { messageId: string | null; raw: unknown };
  try {
    sent = await sendText(session.name, chatId, text, { humanize: true });
  } catch (err) {
    if (err instanceof WahaError && err.isRestriction) {
      await admin.from("whatsapp_sessions").update({ restricted_until: new Date(Date.now() + 24 * 3600e3).toISOString(), updated_at: nowIso() }).eq("name", session.name);
    }
    await admin.from("recovery_events").insert({ recovery_id: id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "failed", provider: "waha", to_address: target, language: rec.language, is_test: isTest, detail: { author: "humano", error: errMessage(err) } });
    return jsonError(`WhatsApp recusou o envio: ${errMessage(err)}`, 502);
  }

  const sentAt = nowIso();
  const msgRow = {
    session: session.name,
    chat_id: chatId,
    phone: target,
    direction: "outbound",
    author: "humano",
    message_id: sent.messageId,
    body: text,
    body_pt: data.translate && text !== original ? original : null,
    has_media: false,
    step: null,
    ack: 0,
    status: isTest ? "teste" : "sent",
    is_test: isTest,
    recovery_id: id,
    raw: sent.raw ?? null,
    sent_at: sentAt,
  };
  const msgRes = await admin.from("whatsapp_messages").insert(msgRow).select("*").maybeSingle();
  if (msgRes.error) return dbError(msgRes.error);

  await admin.from("recovery_events").insert({
    recovery_id: id,
    store_id: rec.store_id,
    step: null,
    channel: "whatsapp",
    type: "sent",
    dedupe_key: sent.messageId ? `wa-out:${sent.messageId}` : null,
    provider: "waha",
    message_id: sent.messageId,
    to_address: target,
    language: rec.language,
    is_test: isTest,
    detail: { author: "humano", translated: Boolean(data.translate && text !== original) },
  });

  // Só depois do envio OK: assume a conversa (o agente para) e desagenda o
  // próximo passo de WhatsApp. O e-mail da régua continua agendado. Teste não
  // mexe em nada do carrinho (a mensagem não chegou ao cliente).
  if (!isTest) {
    const assume = await admin.from("cart_recoveries").update({ agent_mode: "humano", needs_human: false, needs_human_reason: null, wa_next_at: null, next_send_at: rec.email_next_at, waha_session: session.name, unread_count: 0, last_outbound_at: sentAt, first_contact_at: rec.first_contact_at ?? sentAt, last_event_at: sentAt, updated_at: sentAt }).eq("id", id);
    if (assume.error) return jsonError(`Mensagem enviada ao cliente, mas não consegui assumir a conversa: ${assume.error.message}`, 500);
  }

  // Contador diário do número (zera quando muda o dia).
  const sameDay = session.sent_today_date === today();
  await admin.from("whatsapp_sessions").update({ sent_today: (sameDay ? session.sent_today : 0) + 1, sent_today_date: today(), last_used_at: sentAt, updated_at: sentAt }).eq("name", session.name);

  // isTest/to: o painel mostra "enviado para o telefone de teste".
  return NextResponse.json({ ok: true, message: (msgRes.data ?? msgRow) as WhatsappMessageRow, isTest, to: target });
}
