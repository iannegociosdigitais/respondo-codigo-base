import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { phoneFromChatId } from "@/lib/recovery/phone";
import { isPortuguese, translateToPortuguese } from "@/lib/ai/translate-reply";
import { defaultRecoverySettings, findRecoveryForChat, findRecoveryForPhone, handleInboundWhatsapp, loadRecoverySettings, sendMediaAck, sendStopConfirmation } from "@/lib/recovery/agent";
import { isStopMessage } from "@/lib/recovery/agent-prompt";
import { STOP_THRESHOLD, stopProbability } from "@/lib/recovery/message-signals";
import { RECOVERY_MISSING_TABLE } from "@/lib/recovery/types";
import { sessionStatusPatch } from "@/lib/recovery/sessions";
import { phoneFromLid, type WahaWebhookEvent } from "@/lib/whatsapp/waha";
import { ensureOwnerSandbox, isOwnerSandbox, isTestPhone } from "@/lib/recovery/sandbox";

// O agente espera 12 s (debounce) antes de responder, mais a chamada à
// OpenAI e o "digitando" do WAHA: cabe folgado em 60 s.
// 120 s: espera de 6 s + verificação de compra na Shopify + modelo forte do
// vendedor + digitação simulada. Com 60 s a função podia morrer antes de responder.
export const maxDuration = 120;

// Webhook do WAHA (WhatsApp). Verifica o HMAC-SHA512 do corpo cru com
// WAHA_WEBHOOK_SECRET (cabeçalho X-Webhook-Hmac). Sem segredo configurado,
// recusa tudo (falha fechado).
//
//  message        → resposta do cliente: grava em whatsapp_messages (com
//                   tradução), PAUSA os envios agendados do carrinho dele
//                   (e-mail e WhatsApp), não muda o status, e chama o agente
//                   vendedor (lib/recovery/agent.ts). Palavra de parada =
//                   supressão + confirmação curta, sem agente. O WAHA
//                   reentrega o mesmo evento (retries): a mesma mensagem
//                   (message_id) nunca é tratada duas vezes.
//  message.ack    → entregue (2) / lido (3) na recovery_events do envio e
//                   em whatsapp_messages.ack. Ack de envio de teste fica
//                   marcado is_test.
//  session.status → estado da sessão (QR, WORKING, FAILED) em whatsapp_sessions.

const isDuplicate = (err: { code?: string; message?: string } | null | undefined) => Boolean(err && (err.code === "23505" || /duplicate key|unique/i.test(err.message ?? "")));

function verify(raw: string, header: string | null): boolean {
  const secret = process.env.WAHA_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = createHmac("sha512", secret).update(raw).digest("hex");
  const got = header.trim().toLowerCase();
  return expected.length === got.length && timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

// Chat "@lid": o id não é telefone. Alguns engines do WAHA mandam o número
// de verdade dentro de _data (senderPn, remoteJidAlt, SenderAlt...).
const LID_PN_KEYS = ["senderPn", "remoteJidAlt", "SenderAlt", "ChatAlt", "participantAlt", "pn"];
function phoneFromLidPayload(data: unknown): string | null {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!d) return null;
  for (const level of [d, d.key, d.Info]) {
    if (!level || typeof level !== "object") continue;
    for (const k of LID_PN_KEYS) {
      const v = (level as Record<string, unknown>)[k];
      if (typeof v !== "string" || /@lid$/i.test(v)) continue;
      const digits = v.split("@")[0].split(":")[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    }
  }
  return null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verify(raw, request.headers.get("x-webhook-hmac"))) {
    return NextResponse.json({ error: "assinatura inválida" }, { status: 401 });
  }
  let event: WahaWebhookEvent;
  try {
    event = JSON.parse(raw) as WahaWebhookEvent;
  } catch {
    return NextResponse.json({ error: "json inválido" }, { status: 400 });
  }
  const admin = createAdminClient();
  const now = new Date().toISOString();
  try {
    if (event.event === "session.status") {
      const p = event.payload as { status?: string; data?: unknown };
      // A trava de contatos novos (reachoutTimelock) vem junto: grava restricted_until e não apaga a marca.
      const { data: cur } = await admin.from("whatsapp_sessions").select("restricted_until, detail").eq("name", event.session).maybeSingle();
      const patch = sessionStatusPatch(cur as { restricted_until: string | null; detail: unknown } | null, p.data);
      await admin.from("whatsapp_sessions").upsert({ name: event.session, status: p.status ?? null, me_id: event.me?.id ?? null, me_name: event.me?.pushName ?? null, last_event_at: now, ...patch, updated_at: now }, { onConflict: "name" });
      return NextResponse.json({ ok: true });
    }

    if (event.event === "message.ack") {
      const p = event.payload as { id?: string; ack?: number; ackName?: string };
      if (!p.id) return NextResponse.json({ ok: true, ignored: true });
      // O ack pode vir com o chat em LID (true_<lid>@lid_<chave>) enquanto o
      // envio gravou true_<telefone>@c.us_<chave>: casa pela chave da mensagem.
      const key = p.id.split("_").pop() ?? "";
      let msgId = p.id;
      if (key.length >= 12) {
        const { data: same } = await admin.from("whatsapp_messages").select("message_id").eq("message_id", p.id).limit(1).maybeSingle();
        if (!same) {
          const { data: byKey } = await admin.from("whatsapp_messages").select("message_id").like("message_id", `%\_${key}`).limit(1).maybeSingle();
          if (byKey?.message_id) msgId = String(byKey.message_id);
        }
      }
      // Ack da mensagem no chat ao vivo (-1 erro, 0 pendente, 1 servidor, 2 entregue, 3 lido).
      if (typeof p.ack === "number") await admin.from("whatsapp_messages").update({ ack: p.ack }).eq("message_id", msgId).lt("ack", p.ack);
      const type = p.ack === 3 || p.ack === 4 ? "read" : p.ack === 2 ? "delivered" : null;
      if (!type) return NextResponse.json({ ok: true, ignored: true });
      const [{ data: msg }, { data: sent }] = await Promise.all([
        admin.from("whatsapp_messages").select("is_test, status").eq("message_id", msgId).limit(1).maybeSingle(),
        admin.from("recovery_events").select("recovery_id, store_id, step, is_test").eq("message_id", msgId).eq("type", "sent").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (!sent) return NextResponse.json({ ok: true, unknown: true });
      // Envio de teste (foi pro telefone de teste): o ack fica marcado como
      // teste e não conta como entrega ao cliente.
      const isTest = Boolean(sent.is_test || msg?.is_test || msg?.status === "test" || msg?.status === "teste");
      await admin.from("recovery_events").insert({ recovery_id: sent.recovery_id, store_id: sent.store_id, step: sent.step, channel: "whatsapp", type, dedupe_key: `wa-ack:${msgId}:${type}`, provider: "waha", message_id: msgId, is_test: isTest });
      await admin.from("cart_recoveries").update({ last_event_at: now, updated_at: now }).eq("id", sent.recovery_id);
      return NextResponse.json({ ok: true, test: isTest || undefined });
    }

    if (event.event === "message") {
      const p = event.payload as { id?: string; from?: string; fromMe?: boolean; body?: string; hasMedia?: boolean; media?: { url?: string | null } | null; timestamp?: number; _data?: unknown };
      if (p.fromMe || !p.from) return NextResponse.json({ ok: true, ignored: true });
      // Só conversa individual (grupo = @g.us, status = status@broadcast).
      const isLid = /@lid$/i.test(p.from);
      if (!/@c\.us$/i.test(p.from) && !isLid) return NextResponse.json({ ok: true, ignored: true });
      const body = (p.body ?? "").trim();
      const messageId = p.id ?? `${p.from}:${p.timestamp ?? now}`;

      // Loja do número que recebeu: a pessoa pode ter carrinho em duas
      // marcas e a resposta tem que ser da marca cujo número ela chamou.
      const { data: sessionRow } = await admin.from("whatsapp_sessions").select("store_id").eq("name", event.session).maybeSingle();
      const sessionStoreId = ((sessionRow as { store_id?: string | null } | null)?.store_id as string | null | undefined) ?? null;

      // Telefone: @c.us traz o número no id; @lid é um id opaco, resolvido
      // pelo payload ou pelo mapa de lids do WAHA. Sem telefone, o carrinho
      // vem da última mensagem que NÓS mandamos nesse chat (mesma sessão).
      let phone: string | null = isLid ? (phoneFromLidPayload(p._data) ?? (await phoneFromLid(event.session, p.from))) : phoneFromChatId(p.from);
      let rec = phone ? await findRecoveryForPhone(admin, phone, sessionStoreId) : null;
      if (!rec && isLid) rec = await findRecoveryForChat(admin, event.session, p.from);
      if (!phone && rec) phone = rec.phone;
      // Telefone de teste da loja escrevendo para o número dela: conversa de
      // teste com o agente (carrinho-sandbox), mesmo com o canal desligado.
      if ((!rec || isOwnerSandbox(rec)) && phone && sessionStoreId) {
        const st = await loadRecoverySettings(admin, sessionStoreId);
        if (st && isTestPhone(st, phone)) {
          const cmd = sandboxCommand(p.body ?? "");
          rec = await ensureOwnerSandbox(admin, { storeId: sessionStoreId, phone, settings: st, reset: Boolean(cmd), language: cmd?.language ?? null });
        }
      }
      const sandbox = isOwnerSandbox(rec);

      // Grava a mensagem. message_id repetido = reentrega do WAHA (retries):
      // a linha já existe, segue só pra conferir se o tratamento terminou.
      const ins = await admin
        .from("whatsapp_messages")
        .insert({ session: event.session, chat_id: p.from, phone, direction: "inbound", author: "cliente", message_id: p.id ?? null, body: body || null, body_pt: null, has_media: Boolean(p.hasMedia), media_url: p.media?.url ?? null, recovery_id: rec?.id ?? null, raw: event.payload, sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now })
        .select("id")
        .maybeSingle();
      let duplicateMessage = false;
      if (ins.error) {
        if (!isDuplicate(ins.error)) throw new Error(ins.error.message);
        duplicateMessage = true;
      }
      const messageRowId = (ins.data as { id?: string } | null)?.id ?? null;

      // Número desconhecido: só a mensagem fica gravada; ninguém responde.
      if (!rec) return NextResponse.json({ ok: true, matched: false, duplicate: duplicateMessage || undefined });

      // No sandbox, "pare" não suprime o telefone de teste (o agente responde normal).
      // Parada = palavra de parada no começo da mensagem (determinístico) OU a
      // Decisions API com certeza de que ela pede para não ser mais contactada
      // ("בבקשה תפסיקו לשלוח לי", "не пишите мне больше", "don't contact me
      // again": as palavras sozinhas pegavam 8 de 27 frases nos testes). A API
      // falhando = só a palavra, como antes.
      let stop = !sandbox && isStopMessage(body);
      let stopVia: "palavra" | "leitura_rapida" | null = stop ? "palavra" : null;
      if (!stop && !sandbox && body) {
        // A última mensagem NOSSA dá contexto a respostas curtas ("לא.", "די").
        const { data: lastOut } = await admin.from("whatsapp_messages").select("body").eq("recovery_id", rec.id).eq("direction", "outbound").order("created_at", { ascending: false }).limit(1).maybeSingle();
        const p = await stopProbability(body, (lastOut as { body?: string | null } | null)?.body ?? null, { timeoutMs: 3_500 });
        if (p !== null && p >= STOP_THRESHOLD) {
          stop = true;
          stopVia = "leitura_rapida";
        }
      }

      // Ordem importa (reentrega do WAHA): primeiro os EFEITOS de parada e
      // supressão (idempotentes, cada escrita conferida: erro = 500 sem a
      // trava, o WAHA reentrega e reaplica); a trava por mensagem
      // (wa-in:<mensagem>) é gravada DEPOIS deles; só a primeira entrega segue
      // para o que é caro e não idempotente (tradução, contador, confirmação
      // de parada, agente).
      // 1) Cliente respondeu: pausa o que estava agendado (e-mail e WhatsApp),
      //    não muda o status (o agente ou o humano continuam a conversa).
      const pauseRes = await admin
        .from("cart_recoveries")
        .update({ last_inbound_at: now, wa_next_at: null, email_next_at: null, next_send_at: null, last_event_at: now, updated_at: now })
        .eq("id", rec.id);
      if (pauseRes.error) throw new Error(pauseRes.error.message);
      // 2) Palavra de parada: supressão + status.
      if (stop) {
        const address = phone ?? rec.phone;
        if (address) {
          const supRes = await admin.from("recovery_suppressions").upsert({ channel: "whatsapp", address, reason: "replied_stop", source: "waha" }, { onConflict: "channel,address", ignoreDuplicates: true });
          if (supRes.error) throw new Error(supRes.error.message);
        }
        const stopRes = await admin
          .from("cart_recoveries")
          .update({ status: "parado_descadastrou", stop_reason: "pediu_para_parar", wa_next_at: null, email_next_at: null, next_send_at: null, updated_at: now })
          .eq("id", rec.id)
          .in("status", ["ativo", "pausado"]);
        if (stopRes.error) throw new Error(stopRes.error.message);
      }

      // 3) Trava por mensagem, por último dos efeitos: se o WAHA repetir o
      //    webhook, não contamos a mesma mensagem duas vezes, não confirmamos
      //    a parada de novo nem chamamos o agente de novo.
      const { error: evErr } = await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: rec.step, channel: "whatsapp", type: stop ? "unsubscribed" : "replied", dedupe_key: `wa-in:${messageId}`, provider: "waha", message_id: p.id ?? null, language: rec.language, detail: { body: body.slice(0, 500), has_media: Boolean(p.hasMedia), lid: isLid || undefined, stop_via: stopVia || undefined } });
      if (evErr && !isDuplicate(evErr)) throw new Error(evErr.message);
      const firstDelivery = !evErr;
      // Reentrega de mensagem já tratada: 200 e nada mais caro (sem agente,
      // sem segunda confirmação, sem contar de novo). Os efeitos acima já
      // foram reaplicados de forma idempotente.
      if (!firstDelivery) return NextResponse.json({ ok: true, matched: true, duplicate: true });

      // Primeira entrega: contador de não lidas (não idempotente, por isso depois da trava).
      const unreadRes = await admin.from("cart_recoveries").update({ unread_count: (rec.unread_count ?? 0) + 1 }).eq("id", rec.id);
      if (unreadRes.error) console.warn("webhook waha: unread_count:", unreadRes.error.message);
      rec.unread_count = (rec.unread_count ?? 0) + 1;

      // Tradução pra você ler no painel; erro de tradução não trava nada.
      if (body && !isPortuguese(rec.language)) {
        try {
          const bodyPt = await translateToPortuguese(body, rec.language);
          if (bodyPt) {
            const upd = admin.from("whatsapp_messages").update({ body_pt: bodyPt });
            if (messageRowId) await upd.eq("id", messageRowId);
            else if (p.id) await upd.eq("message_id", p.id);
          }
        } catch (err) {
          console.warn("webhook waha: tradução falhou:", err instanceof Error ? err.message : err);
        }
      }

      const settings = (await loadRecoverySettings(admin, rec.store_id)) ?? defaultRecoverySettings(rec.store_id);

      if (stop) {
        await sendStopConfirmation(admin, { recovery: rec, settings, sessionName: event.session, messageId });
        return NextResponse.json({ ok: true, matched: true, stopped: true });
      }

      if (sandbox && sandboxCommand(body)) {
        if (messageRowId) await admin.from("whatsapp_messages").update({ recovery_id: null }).eq("id", messageRowId);
        return NextResponse.json({ ok: true, matched: true, sandboxReset: true });
      }

      // Áudio/imagem sem texto: o agente não ouve nem vê. Imagem = "recebi,
      // vou conferir com a equipe" e a equipe é chamada (pode ser o
      // comprovante); áudio = pede para escrever; figurinha = ignora.
      if (!body) {
        if (p.hasMedia) {
          const kind = mediaKind(p);
          if (kind === "sticker") return NextResponse.json({ ok: true, matched: true, media: true, sticker: true });
          await sendMediaAck(admin, { recovery: rec, settings, sessionName: event.session, messageId, kind: kind === "audio" ? "audio" : "imagem" });
        }
        return NextResponse.json({ ok: true, matched: true, media: Boolean(p.hasMedia) });
      }

      // Agente vendedor (com debounce de 12 s lá dentro; só a última
      // mensagem responde). Só na primeira entrega do evento: a trava
      // wa-agent:<mensagem> fica gravada antes do modelo e nunca é
      // sobrescrita. Erros viram needs_human, nunca 500.
      await handleInboundWhatsapp(admin, { recovery: rec, settings, messageId });
      return NextResponse.json({ ok: true, matched: true });
    }

    return NextResponse.json({ ok: true, ignored: event.event });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("webhook waha:", msg);
    // Migration 0018 ainda não rodou: não adianta o WAHA repetir.
    if (RECOVERY_MISSING_TABLE.test(msg)) return NextResponse.json({ ok: true, skipped: "migration_missing" });
    // 500 faz o WAHA tentar de novo (retries configurados na sessão).
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}


// Tipo da mídia recebida: o WAHA traz o mimetype em media quando baixa o
// arquivo; senão o tipo aparece no payload bruto (_data).
function mediaKind(p: { media?: unknown; _data?: unknown }): "imagem" | "audio" | "sticker" | "outro" {
  const mt = String((p.media as { mimetype?: string } | null | undefined)?.mimetype ?? "");
  let raw = "";
  try {
    raw = JSON.stringify(p._data ?? {}).slice(0, 6000);
  } catch {
    raw = "";
  }
  if (/sticker/i.test(raw) || mt === "image/webp") return "sticker";
  if (/^audio\//i.test(mt) || /audioMessage|"ptt"/i.test(raw)) return "audio";
  if (/^image\//i.test(mt) || /imageMessage/i.test(raw)) return "imagem";
  return "outro";
}

// Comandos do dono na conversa-sandbox: "reset" (recomeça em português),
// "reset he" / "עברית" / "hebraico" (recomeça como cliente de Israel, em hebraico).
function sandboxCommand(body: string): { language: "pt" | "he" | null } | null {
  const t = body.trim().toLowerCase();
  if (/^reset(?:\s+(?:pt|portugu[eê]s|br))?$/i.test(t)) return { language: "pt" };
  if (/^(?:reset\s+(?:he|il|hebraico|עברית)|עברית|hebraico)$/i.test(t)) return { language: "he" };
  return null;
}
