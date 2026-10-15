// Envio de e-mail de MARKETING (recuperação de carrinho) pelo Resend, via API
// HTTPS, num subdomínio separado por marca. Nunca pela caixa de suporte
// (Hostinger/Gmail): uma campanha ruim derrubaria a entrega dos comprovantes
// e das respostas. Transacional (comprovante, aviso) continua no SMTP de hoje.
//
// Env: RESEND_API_KEY (re_...). Sem ela, nada é enviado (falha fechado).
import { SendError, networkErrorAmbiguous } from "@/lib/email/send-error";

export interface ResendEmail {
  from: string; // "Monique da Olavita <monique@hello.olavita.co.il>"
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | null;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  // mesma chave em duas chamadas = o Resend não manda duas vezes (24h)
  idempotencyKey?: string;
}

export const resendConfigured = () => Boolean(process.env.RESEND_API_KEY);

// Recusa por cota ou limite de taxa do Resend (HTTP 429 ou o nome do erro).
const RESEND_QUOTA_NAMES = new Set(["daily_quota_exceeded", "monthly_quota_exceeded", "rate_limit_exceeded"]);
export function isResendQuotaError(status: number, name?: string | null): boolean {
  return status === 429 || RESEND_QUOTA_NAMES.has(String(name ?? "").trim().toLowerCase());
}

export async function sendResendEmail(input: ResendEmail): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY não configurada: e-mail de recuperação não enviado.");
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey.slice(0, 256);
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      // Sem resposta em 20 s = ambíguo (o Resend pode ter aceitado).
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        reply_to: input.replyTo ?? undefined,
        headers: input.headers,
        // só ASCII, _ e - nos valores de tag (regra do Resend)
        tags: input.tags ? Object.entries(input.tags).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })) : undefined,
      }),
    });
  } catch (err) {
    // Timeout, abort ou queda de rede: ambíguo, a menos que a conexão nem tenha aberto.
    throw new SendError(`Resend sem resposta: ${err instanceof Error ? err.message : String(err)}`, networkErrorAmbiguous(err));
  }
  // Corpo ilegível depois de conectar = resposta perdida (ambíguo se for 2xx/5xx).
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  // 5xx, ou 2xx sem id: o Resend pode ter aceitado o e-mail. 4xx é recusa
  // definitiva. 429 (daily_quota_exceeded, monthly_quota_exceeded,
  // rate_limit_exceeded) é recusa por COTA: definitiva, mas não queima
  // tentativa do passo (SendError.quota; ver lib/recovery/engine.ts).
  if (!res.ok || !json.id) throw new SendError(`Resend ${res.status}: ${json.message ?? json.name ?? "sem id"}`, res.status >= 500 || res.ok, res.status, isResendQuotaError(res.status, json.name));
  return { id: json.id };
}

// Cabeçalhos de descadastro em um clique (Gmail/Yahoo exigem de quem manda
// em massa; a gente manda sempre, mesmo abaixo do limite, porque reduz
// reclamação de spam: o botão "Cancelar inscrição" do Gmail usa isso).
export const unsubscribeHeaders = (url: string): Record<string, string> => ({
  "List-Unsubscribe": `<${url}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});
