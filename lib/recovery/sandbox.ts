import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryRow, RecoverySettings } from "@/lib/recovery/types";

// Conversa de teste do dono com o agente (pedido do Ian, 09/10): quando o
// telefone de teste da loja (test_phone) escreve para um número da loja, o
// Respondo usa um carrinho-sandbox fixo (checkout_id "sandbox:<loja>"),
// copiado do carrinho mais recente num idioma liberado. O agente responde
// mesmo com o WhatsApp/agente desligados para clientes; tudo fica marcado
// como teste. A régua nunca agenda esse carrinho (email_step/wa_step = 99).
// "reset" (mensagem sozinha) recomeça a conversa do zero.

export const SANDBOX_PREFIX = "sandbox:";
export const isOwnerSandbox = (rec: Pick<RecoveryRow, "checkout_id"> | null | undefined) => Boolean(rec?.checkout_id?.startsWith(SANDBOX_PREFIX));
export const SANDBOX_STEP = 99;

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
export const isTestPhone = (settings: Pick<RecoverySettings, "test_phone"> | null | undefined, phone: string | null | undefined) => {
  const a = digits(settings?.test_phone);
  const b = digits(phone);
  return a.length >= 8 && a === b;
};

// Configuração em memória para a conversa-sandbox: canal e agente ligados,
// destino = o próprio telefone de teste, eventos marcados como teste.
export const sandboxSettings = (settings: RecoverySettings, rec: Pick<RecoveryRow, "phone">): RecoverySettings => ({
  ...settings,
  enabled: true,
  whatsapp_enabled: true,
  agent_enabled: true,
  test_mode: true,
  test_phone: rec.phone ?? settings.test_phone,
});

// `language` (pt ou he, só com reset): o dono testa em hebraico como uma cliente de Israel ("reset he") ou em português ("reset").
export async function ensureOwnerSandbox(admin: SupabaseClient, input: { storeId: string; phone: string; settings: RecoverySettings; reset?: boolean; language?: "pt" | "he" | null }): Promise<RecoveryRow> {
  const checkoutId = `${SANDBOX_PREFIX}${input.storeId}`;
  const now = new Date().toISOString();
  const live = { status: "ativo", needs_human: false, needs_human_reason: null, agent_mode: "agente", phone: input.phone, email_step: SANDBOX_STEP, wa_step: SANDBOX_STEP, email_next_at: null, wa_next_at: null, next_send_at: null, updated_at: now };
  const { data: existing, error } = await admin.from("cart_recoveries").select("*").eq("store_id", input.storeId).eq("checkout_id", checkoutId).maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) {
    const patch: Record<string, unknown> = { ...live };
    if (input.reset) {
      // Conversa nova: as mensagens antigas saem do histórico do agente.
      await admin.from("whatsapp_messages").update({ recovery_id: null }).eq("recovery_id", existing.id);
      Object.assign(patch, { offered_discount_code: null, offered_discount_percent: null, summary_pt: null, unread_count: 0, tags: ["teste_dono"], last_inbound_at: null, last_outbound_at: null, first_contact_at: null });
      if (input.language) Object.assign(patch, { language: input.language, country_code: input.language === "he" ? "IL" : "BR", first_name: input.language === "he" ? "איאן" : "Ian" });
    }
    const { data, error: upErr } = await admin.from("cart_recoveries").update(patch).eq("id", existing.id).select("*").single();
    if (upErr) throw new Error(upErr.message);
    return data as RecoveryRow;
  }

  // Modelo: o carrinho mais recente da loja num idioma liberado (produto e checkout reais).
  const langs = (input.settings.send_languages ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  let q = admin.from("cart_recoveries").select("*").eq("store_id", input.storeId).not("checkout_id", "like", `${SANDBOX_PREFIX}%`);
  if (langs.length > 0) q = q.in("language", langs);
  const { data: model, error: mErr } = await q.order("abandoned_at", { ascending: false }).limit(1).maybeSingle();
  if (mErr) throw new Error(mErr.message);
  if (!model) throw new Error("sandbox: a loja não tem carrinho para servir de modelo");
  const { id: _id, created_at: _c, ...base } = model as RecoveryRow;
  void _id;
  void _c;
  const row = {
    ...base,
    ...live,
    checkout_id: checkoutId,
    checkout_name: "#TESTE",
    email: null,
    first_name: input.language === "he" ? "איאן" : "Ian",
    last_name: null,
    language: input.language ?? "pt",
    country_code: input.language === "he" ? "IL" : "BR",
    abandoned_at: now,
    completed_at: null,
    tags: ["teste_dono"],
    notes: "Conversa de teste do dono com o agente. Não é cliente.",
    waha_session: null,
    whatsapp_exists: true,
    whatsapp_checked_at: now,
    first_contact_at: null,
    last_inbound_at: null,
    last_outbound_at: null,
    unread_count: 0,
    offered_discount_code: null,
    offered_discount_percent: null,
    summary_pt: null,
    recovered_order_id: null,
    recovered_order_name: null,
    recovered_at: null,
    recovered_amount: null,
    recovered_currency: null,
    recovered_channel: null,
    recovered_discount_code: null,
    attribution: null,
    stop_reason: null,
    last_event_at: now,
  };
  const { data, error: insErr } = await admin.from("cart_recoveries").insert(row).select("*").single();
  if (insErr) throw new Error(insErr.message);
  return data as RecoveryRow;
}
