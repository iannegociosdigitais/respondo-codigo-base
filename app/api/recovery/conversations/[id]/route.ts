import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryRow, RecoverySettings, RecoveryStep, WhatsappMessageRow } from "@/lib/recovery/types";
import { nextAllowedTime } from "@/lib/recovery/schedule";
import { authorize, dbError, isUuid, jsonError, loadStore, nowIso, parseBody, phoneSuppressed, STOPPED_BY_CUSTOMER } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Uma conversa: o carrinho inteiro, as mensagens de WhatsApp, a linha do
// tempo de eventos, o pedido recuperado (se houver), as sessões WORKING da
// loja, um resumo das chaves da loja (modo de teste etc., para o composer
// avisar) e se o telefone está suprimido. PATCH edita notas, tags e status
// (só pausar/reativar/encerrar); reativar reagenda a régua.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const admin = createAdminClient();

  const recRes = await admin.from("cart_recoveries").select("*").eq("id", id).maybeSingle();
  if (recRes.error) return dbError(recRes.error);
  const recovery = recRes.data as RecoveryRow | null;
  if (!recovery) return jsonError("conversa não encontrada", 404);

  const [store, msgRes, evRes, sessRes, setRes, suppressed] = await Promise.all([
    loadStore(admin, recovery.store_id),
    admin.from("whatsapp_messages").select("*").eq("recovery_id", id).order("created_at", { ascending: true }).limit(500),
    admin.from("recovery_events").select("id, step, channel, type, created_at, detail, discount_code, is_test").eq("recovery_id", id).order("created_at", { ascending: true }).limit(500),
    admin.from("whatsapp_sessions").select("name").eq("store_id", recovery.store_id).eq("active", true).eq("status", "WORKING"),
    admin.from("recovery_settings").select("enabled, whatsapp_enabled, agent_enabled, test_mode, test_phone").eq("store_id", recovery.store_id).maybeSingle(),
    phoneSuppressed(admin, recovery.phone),
  ]);
  if (msgRes.error) return dbError(msgRes.error);
  if (evRes.error) return dbError(evRes.error);
  // Sem linha de configuração = tudo desligado e em modo de teste (padrões da migration).
  const st = (setRes.data ?? null) as Pick<RecoverySettings, "enabled" | "whatsapp_enabled" | "agent_enabled" | "test_mode" | "test_phone"> | null;
  const settings = {
    enabled: st?.enabled ?? false,
    whatsappEnabled: st?.whatsapp_enabled ?? false,
    agentEnabled: st?.agent_enabled ?? false,
    testMode: st?.test_mode ?? true,
    testPhone: st?.test_phone ?? null,
  };

  const order = recovery.recovered_order_name || recovery.recovered_order_id
    ? { name: recovery.recovered_order_name ?? recovery.recovered_order_id, createdAt: recovery.recovered_at, total: recovery.recovered_amount == null ? null : Number(recovery.recovered_amount), currency: recovery.recovered_currency ?? recovery.currency }
    : null;

  return NextResponse.json({
    recovery,
    store: store ?? { id: recovery.store_id, name: recovery.store_id },
    messages: (msgRes.data ?? []) as WhatsappMessageRow[],
    events: (evRes.data ?? []).map((e) => ({ id: e.id, step: e.step, channel: e.channel, type: e.type, createdAt: e.created_at, detail: e.detail, discountCode: e.discount_code, isTest: Boolean(e.is_test) })),
    order,
    sessions: (sessRes.data ?? []).map((s) => String(s.name)),
    settings,
    // Cliente pediu para parar (status) ou telefone suprimido: o envio humano
    // é recusado (409) e o composer deve avisar.
    suppressed: suppressed || STOPPED_BY_CUSTOMER.has(recovery.status),
  });
}

const PatchSchema = z.object({
  notes: z.string().max(10000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  status: z.enum(["pausado", "ativo", "concluido_sem_compra"]).optional(),
});

export async function PATCH(request: Request, { params }: Ctx) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const { data, response } = await parseBody(request, PatchSchema);
  if (response) return response;

  const patch: Record<string, unknown> = { updated_at: nowIso() };
  const warnings: string[] = [];
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.tags !== undefined) patch.tags = [...new Set(data.tags)];
  if (data.status !== undefined) {
    patch.status = data.status;
    if (data.status === "concluido_sem_compra") {
      patch.email_next_at = null;
      patch.wa_next_at = null;
      patch.next_send_at = null;
      patch.stop_reason = "encerrado_manual";
    }
  }
  if (Object.keys(patch).length === 1) return jsonError("nada para atualizar", 400);

  const admin = createAdminClient();

  // Reativar (pausado/encerrado → ativo): o motor só agenda quem tem
  // <canal>_step = 0, então um carrinho que já recebeu algum passo ficaria
  // "ativo" para sempre sem receber nada. Aqui reagendamos o próximo passo
  // de cada canal para agora (ou o próximo horário permitido).
  if (data.status === "ativo") {
    const curRes = await admin.from("cart_recoveries").select("*").eq("id", id).maybeSingle();
    if (curRes.error) return dbError(curRes.error);
    const cur = curRes.data as RecoveryRow | null;
    if (!cur) return jsonError("conversa não encontrada", 404);
    if (cur.status !== "ativo") {
      const [setRes, stepsRes] = await Promise.all([
        admin.from("recovery_settings").select("quiet_hours").eq("store_id", cur.store_id).maybeSingle(),
        admin.from("recovery_steps").select("*").eq("store_id", cur.store_id).eq("enabled", true).order("position", { ascending: true }),
      ]);
      if (setRes.error) return dbError(setRes.error);
      if (stepsRes.error) return dbError(stepsRes.error);
      const quiet = (setRes.data as Pick<RecoverySettings, "quiet_hours"> | null)?.quiet_hours ?? null;
      // Só a régua de carrinho (o campo flow pode não existir em bancos antigos: sem ele, é carrinho).
      const steps = ((stepsRes.data ?? []) as Array<RecoveryStep & { flow?: string }>).filter((st) => (st.flow ?? "carrinho") === "carrinho");
      const now = new Date();
      const soon = nextAllowedTime(now, cur.country_code, quiet).toISOString();
      const keepFuture = (v: string | null) => (v && new Date(v).getTime() > now.getTime() ? v : null);
      patch.stop_reason = null;

      const nextEmail = steps.find((st) => st.channel === "email" && st.position === (cur.email_step ?? 0) + 1);
      if (nextEmail) patch.email_next_at = keepFuture(cur.email_next_at) ?? soon;
      else {
        patch.email_next_at = null;
        if (cur.email) warnings.push("A régua de e-mail já terminou para este carrinho: nenhum e-mail novo será agendado.");
      }

      const nextWa = steps.find((st) => st.channel === "whatsapp" && st.position === (cur.wa_step ?? 0) + 1);
      if (!cur.phone) patch.wa_next_at = null;
      else if (cur.last_inbound_at) {
        // Cliente já respondeu: os passos agendados não voltam; o agente/humano conversa.
        patch.wa_next_at = null;
        warnings.push("O cliente já respondeu no WhatsApp: a régua de WhatsApp não volta, a conversa segue pelo chat.");
      } else if (nextWa) patch.wa_next_at = keepFuture(cur.wa_next_at) ?? soon;
      else {
        patch.wa_next_at = null;
        warnings.push("A régua de WhatsApp já terminou para este carrinho: nenhuma mensagem nova será agendada.");
      }

      const nexts = [patch.email_next_at, patch.wa_next_at].filter((x): x is string => typeof x === "string").map((x) => new Date(x).getTime());
      patch.next_send_at = nexts.length > 0 ? new Date(Math.min(...nexts)).toISOString() : null;
    }
  }

  const { data: recovery, error } = await admin.from("cart_recoveries").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return dbError(error);
  if (!recovery) return jsonError("conversa não encontrada", 404);
  return NextResponse.json({ ok: true, recovery: recovery as RecoveryRow, warnings });
}
