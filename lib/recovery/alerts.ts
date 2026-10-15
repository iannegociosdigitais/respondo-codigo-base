import type { SupabaseClient } from "@supabase/supabase-js";
import { marketingConfigured, sendMarketingEmail } from "@/lib/email/marketing";
import { sendReply } from "@/lib/email/send-reply";
import { RECOVERY_MISSING_TABLE, type RecoveryAlert, type RecoverySettings } from "@/lib/recovery/types";

// Alertas operacionais da recuperação de carrinho (tabela recovery_alerts):
// a vigilância do tick (lib/recovery/watchdog.ts) cria, o painel mostra e o
// dono recebe por e-mail. NADA aqui lança: erro vira console.error e um
// resultado vazio/false, pra vigilância nunca derrubar o tick da régua.

export type AlertKind = RecoveryAlert["kind"];

// Último recurso quando não há ALERT_EMAIL nem e-mail de teste em loja alguma.
export const DEFAULT_ALERT_EMAIL = "dono@suaempresa.com";

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Erro de tabela ausente (migration 0018 não rodou) é esperado e silencioso;
// o resto vai pro log.
function logDbError(where: string, message: string): void {
  if (RECOVERY_MISSING_TABLE.test(message)) return;
  console.error(`alertas ${where}:`, message);
}

// Quem recebe os alertas: ALERT_EMAIL da Vercel; senão o e-mail de teste de
// alguma loja; senão o do Ian.
export function alertRecipient(settings: Array<Pick<RecoverySettings, "test_email">> = []): string {
  const env = process.env.ALERT_EMAIL?.trim();
  if (env && env.includes("@")) return env;
  const fromStore = settings.map((s) => (s.test_email ?? "").trim()).find((e) => e.includes("@"));
  return fromStore || DEFAULT_ALERT_EMAIL;
}

// --- E-mail de alerta ----------------------------------------------------------

export interface AlertEmailInput {
  to: string;
  subject: string;
  text: string;
  // Configurações das lojas já carregadas pelo tick (evita consulta); sem
  // elas, o from_email do Resend é lido do banco.
  settings?: Array<Pick<RecoverySettings, "from_email" | "from_name">>;
}

export type AlertEmailResult = { ok: true; via: "resend" | "caixa"; id: string | null } | { ok: false; via: "resend" | "caixa" | "nenhum"; error: string };

// Manda o e-mail de alerta pro dono. Ordem: Resend (com o remetente de
// alguma loja) e, sem Resend, a caixa de e-mail conectada mais recente.
// Sem nenhum meio, devolve ok=false e o alerta fica só no painel.
export async function sendAlertEmail(admin: SupabaseClient, input: AlertEmailInput): Promise<AlertEmailResult> {
  const to = (input.to ?? "").trim();
  if (!to.includes("@")) return { ok: false, via: "nenhum", error: "destinatário do alerta inválido" };
  const subject = (input.subject ?? "").trim() || "[Respondo] Alerta da recuperação de carrinho";
  const text = (input.text ?? "").trim();

  // 1) Resend: tenta o remetente de cada loja, uma de cada vez, até um aceitar.
  // Domínio não verificado numa loja (Resend 403) não pode derrubar o alerta:
  // em 10/10 o aviso de bounce não saiu porque o 1º remetente da lista era de
  // uma loja sem domínio verificado e a caixa de reserva tinha senha recusada.
  try {
    if (marketingConfigured("resend")) {
      for (const from of await resendSenders(admin, input.settings)) {
        try {
          const r = await sendMarketingEmail("resend", { from, to, subject, text, html: textToHtml(text) });
          return { ok: true, via: "resend", id: r.id };
        } catch (err) {
          console.error("alerta por Resend:", errMsg(err));
        }
      }
    }
  } catch (err) {
    console.error("alerta: remetentes do Resend:", errMsg(err));
  }

  // 2) Caixas de e-mail conectadas (SMTP da própria loja): as que sincronizam
  // primeiro (credencial viva), até 3 tentativas.
  let accounts: ConnectedAccount[] = [];
  try {
    accounts = await connectedAccounts(admin, 3);
  } catch (err) {
    console.error("alerta: caixa conectada:", errMsg(err));
  }
  if (accounts.length === 0) {
    console.warn("alerta sem meio de envio (nem Resend com from_email, nem caixa conectada): fica só no painel.");
    return { ok: false, via: "nenhum", error: "nenhum meio de envio configurado" };
  }
  let lastError = "";
  for (const account of accounts) {
    try {
      const r = await sendReply({
        emailAccount: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
        to,
        subject,
        body: text,
        fromName: "Respondo",
        inReplyTo: null,
        references: [],
      });
      return { ok: true, via: "caixa", id: r.messageId };
    } catch (err) {
      lastError = errMsg(err);
      console.error("alerta pela caixa conectada:", lastError);
    }
  }
  return { ok: false, via: "caixa", error: lastError };
}

interface ConnectedAccount {
  smtp_host: string;
  smtp_port: number;
  email_address: string;
  credential_encrypted: string;
}

async function connectedAccounts(admin: SupabaseClient, limit: number): Promise<ConnectedAccount[]> {
  const { data, error } = await admin
    .from("store_email_accounts")
    .select("smtp_host, smtp_port, email_address, credential_encrypted")
    .not("connected_at", "is", null)
    .order("last_synced_at", { ascending: false, nullsFirst: false })
    .order("connected_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ConnectedAccount[]).filter((row) => row.smtp_host && row.email_address && row.credential_encrypted);
}

// "Respondo <from_email>" de cada loja com remetente configurado, sem repetir,
// na ordem recebida (o chamador põe a loja do assunto primeiro).
async function resendSenders(admin: SupabaseClient, settings?: Array<Pick<RecoverySettings, "from_email" | "from_name">>): Promise<string[]> {
  let rows = settings;
  if (!rows) {
    const { data, error } = await admin.from("recovery_settings").select("from_email, from_name").not("from_email", "is", null).limit(10);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as Array<Pick<RecoverySettings, "from_email" | "from_name">>;
  }
  const emails = rows.map((s) => (s.from_email ?? "").trim()).filter((e) => e.includes("@"));
  return [...new Set(emails)].map((e) => `Respondo <${e}>`);
}

function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;white-space:pre-wrap">${linked}</div>`;
}

// --- Leitura e resolução (painel) -------------------------------------------------

// Alertas abertos, mais recentes primeiro. Opcional: só de um tipo.
export async function listOpenAlerts(admin: SupabaseClient, opts: { kind?: AlertKind; limit?: number } = {}): Promise<RecoveryAlert[]> {
  let q = admin.from("recovery_alerts").select("*").is("resolved_at", null).order("created_at", { ascending: false }).limit(opts.limit ?? 50);
  if (opts.kind) q = q.eq("kind", opts.kind);
  const { data, error } = await q;
  if (error) {
    logDbError("listar abertos", error.message);
    return [];
  }
  return (data ?? []) as RecoveryAlert[];
}

// Marca um alerta como resolvido (botão "Resolvido" do painel). true = era
// aberto e foi fechado agora.
export async function resolveAlert(admin: SupabaseClient, id: string): Promise<boolean> {
  if (!id) return false;
  const { data, error } = await admin.from("recovery_alerts").update({ resolved_at: new Date().toISOString() }).eq("id", id).is("resolved_at", null).select("id");
  if (error) {
    logDbError("resolver", error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

// --- Primitivos usados pela vigilância ------------------------------------------

export async function findOpenAlert(admin: SupabaseClient, kind: AlertKind, key: string): Promise<RecoveryAlert | null> {
  const { data, error } = await admin.from("recovery_alerts").select("*").eq("kind", kind).eq("key", key).is("resolved_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    logDbError("buscar aberto", error.message);
    return null;
  }
  return (data as RecoveryAlert | null) ?? null;
}

// Quando foi criado o último alerta (aberto ou não) desse kind+key.
export async function lastAlertAt(admin: SupabaseClient, kind: AlertKind, key: string): Promise<Date | null> {
  const { data, error } = await admin.from("recovery_alerts").select("created_at").eq("kind", kind).eq("key", key).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    logDbError("último", error.message);
    return null;
  }
  const at = (data as { created_at: string } | null)?.created_at;
  return at ? new Date(at) : null;
}

// Quando o último alerta desse kind+key foi RESOLVIDO (à mão ou sozinho).
// Usado pra não recriar um alerta que o Ian acabou de dispensar. Erro de banco
// devolve `null` (sem trava).
export async function lastResolvedAlertAt(admin: SupabaseClient, kind: AlertKind, key: string): Promise<Date | null> {
  const { data, error } = await admin.from("recovery_alerts").select("resolved_at").eq("kind", kind).eq("key", key).not("resolved_at", "is", null).order("resolved_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    logDbError("último resolvido", error.message);
    return null;
  }
  const at = (data as { resolved_at: string } | null)?.resolved_at;
  return at ? new Date(at) : null;
}

export async function createAlert(admin: SupabaseClient, input: { kind: AlertKind; key: string; message: string; storeId?: string | null }): Promise<RecoveryAlert | null> {
  const { data, error } = await admin
    .from("recovery_alerts")
    .insert({ kind: input.kind, key: input.key, message: input.message.slice(0, 2000), store_id: input.storeId ?? null })
    .select("*")
    .single();
  if (error) {
    logDbError("criar", error.message);
    return null;
  }
  return data as RecoveryAlert;
}

// Fecha todos os abertos desse kind+key; devolve quantos fechou.
export async function resolveOpenAlerts(admin: SupabaseClient, kind: AlertKind, key: string): Promise<number> {
  const { data, error } = await admin.from("recovery_alerts").update({ resolved_at: new Date().toISOString() }).eq("kind", kind).eq("key", key).is("resolved_at", null).select("id");
  if (error) {
    logDbError("resolver abertos", error.message);
    return 0;
  }
  return (data ?? []).length;
}

// Fecha alertas pelos ids; devolve quantos fechou.
export async function resolveAlertsById(admin: SupabaseClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await admin.from("recovery_alerts").update({ resolved_at: new Date().toISOString() }).in("id", ids).is("resolved_at", null).select("id");
  if (error) {
    logDbError("resolver por id", error.message);
    return 0;
  }
  return (data ?? []).length;
}

// Histórico (abertos e resolvidos) de um tipo desde uma data, do mais antigo
// pro mais novo. Usado pela trava de "1 e-mail a cada 15 min" dos alertas de
// cliente precisando de humano.
export async function listRecentAlerts(admin: SupabaseClient, kind: AlertKind, sinceIso: string, limit = 500): Promise<RecoveryAlert[]> {
  const { data, error } = await admin.from("recovery_alerts").select("*").eq("kind", kind).gte("created_at", sinceIso).order("created_at", { ascending: true }).limit(limit);
  if (error) {
    logDbError("histórico", error.message);
    return [];
  }
  return (data ?? []) as RecoveryAlert[];
}
