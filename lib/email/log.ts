import type { SupabaseClient } from "@supabase/supabase-js";

// Registro único + trava de duplicidade dos e-mails automáticos (tabela
// email_log, migration 0017). Regra de ouro, por causa do bug de 20/09 (o
// mesmo comprovante saiu 15x): PRIMEIRO grava a linha com a chave única,
// DEPOIS envia. Se gravar falhar — chave repetida, tabela inexistente,
// banco fora — o envio NÃO acontece. Nunca "na dúvida, manda".
export type EmailKind = "receipt" | "auto_ack";

export const PUBLIC_BASE_URL = (() => {
  const raw = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  return !raw || /localhost|127\.0\.0\.1|\[::1\]/.test(raw) ? "https://SEU-APP" : raw;
})();

export const normEmail = (email: string) => email.trim().toLowerCase();

// Um comprovante por e-mail, pra sempre.
export const receiptKey = (email: string) => `receipt:${normEmail(email)}`;
// Um aviso de recebimento por e-mail por dia (UTC).
export const ackKey = (email: string, at = new Date()) => `ack:${normEmail(email)}:${at.toISOString().slice(0, 10)}`;

export interface ClaimInput {
  kind: EmailKind;
  storeId: string | null;
  conversationId?: string | null;
  from?: string | null;
  to: string;
  customerName?: string | null;
  brand?: string | null;
  language?: string | null;
  subject?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  trigger: "manual" | "auto" | "test";
  // null = sem trava (só pra teste mandado pro dono)
  dedupeKey: string | null;
}

export type ClaimResult = { ok: true; id: string } | { ok: false; reason: "duplicate" | "missing_table" | "error"; message: string };

export async function claimSend(admin: SupabaseClient, input: ClaimInput): Promise<ClaimResult> {
  const { data, error } = await admin
    .from("email_log")
    .insert({
      kind: input.kind,
      store_id: input.storeId,
      conversation_id: input.conversationId ?? null,
      from_address: input.from ?? null,
      to_address: normEmail(input.to),
      customer_name: input.customerName ?? null,
      brand: input.brand ?? null,
      language: input.language ?? null,
      subject: input.subject ?? null,
      order_id: input.orderId ?? null,
      order_name: input.orderName ?? null,
      status: "sending",
      is_test: input.trigger === "test",
      trigger: input.trigger,
      dedupe_key: input.dedupeKey,
    })
    .select("id")
    .single();
  if (error || !data) {
    const msg = error?.message ?? "sem resposta do banco";
    if (error?.code === "23505" || /duplicate key/i.test(msg)) return { ok: false, reason: "duplicate", message: "Já foi enviado pra esse e-mail." };
    if (/email_log|does not exist|schema cache/i.test(msg)) return { ok: false, reason: "missing_table", message: "Falta rodar a migration 0017_email_log.sql no Supabase (é ela que impede mandar em dobro)." };
    return { ok: false, reason: "error", message: `Não consegui registrar o envio (nada foi mandado): ${msg}` };
  }
  return { ok: true, id: data.id as string };
}

export async function markSent(admin: SupabaseClient, id: string, extra: { messageId?: string | null; language?: string | null; subject?: string | null } = {}): Promise<void> {
  const patch: Record<string, unknown> = { status: "sent", sent_at: new Date().toISOString(), message_id: extra.messageId ?? null };
  if (extra.language) patch.language = extra.language;
  if (extra.subject) patch.subject = extra.subject;
  const { error } = await admin.from("email_log").update(patch).eq("id", id);
  // A trava (dedupe_key) já está gravada desde o claim — mesmo que este
  // update falhe, não há risco de reenvio.
  if (error) console.error("email_log markSent:", error.message);
}

// Falhou de verdade (SMTP recusou): libera a chave pra permitir nova
// tentativa, mas deixa a linha como histórico.
export async function markFailed(admin: SupabaseClient, id: string, message: string): Promise<void> {
  const { error } = await admin.from("email_log").update({ status: "failed", error: message.slice(0, 500), dedupe_key: null }).eq("id", id);
  if (error) console.error("email_log markFailed:", error.message);
}

// Pixel de abertura (1x1) — só entra em envio real, nunca muda o texto.
export const openPixel = (logId: string) => `<img src="${PUBLIC_BASE_URL}/api/public/o/${logId}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;">`;
export const withPixel = (html: string, logId: string) => (html.includes("</body>") ? html.replace("</body>", `${openPixel(logId)}</body>`) : html + openPixel(logId));
