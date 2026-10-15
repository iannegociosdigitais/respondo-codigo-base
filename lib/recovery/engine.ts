import type { SupabaseClient } from "@supabase/supabase-js";
import { syncAbandonedCheckouts } from "@/lib/recovery/sync";
import { emailAddressProblem } from "@/lib/email/address-check";
import { verifyEmailAddress } from "@/lib/email/verify";
import { applyStop, checkStopRules } from "@/lib/recovery/stop-rules";
import { clickLink, HOLD_LEGACY_COUPON_CARTS, hasLegacyCoupon, unsubscribeLink } from "@/lib/recovery/links";
import { chatIdFromPhone } from "@/lib/recovery/phone";
import { isAllowedNow, localParts, nextAllowedTime, scheduleAfter, tzForCountry } from "@/lib/recovery/schedule";
import { buildRecoveryEmailHtml, buildRecoveryEmailText, emailLabels, pickLocalized, pickStepBody, pickStepSubject, renderTemplate, type TemplateVars } from "@/lib/recovery/templates";
import { bumpSessionSent, pickSessionDetailed, restrictSession } from "@/lib/recovery/sessions";
import { RECOVERY_MISSING_TABLE, type RecoveryDiscount, type RecoveryItem, type RecoveryRow, type RecoverySettings, type RecoveryStep, type WhatsappSessionRow } from "@/lib/recovery/types";
import { unsubscribeHeaders } from "@/lib/email/resend";
import { marketingConfigured, sendMarketingEmail, type MarketingProvider } from "@/lib/email/marketing";
import { checkSenderDns, evaluateEmailHealth, warmupCap, type EmailHealth, type SenderDns } from "@/lib/email/deliverability";
import { runWatchdog, WATCHDOG_BUDGET_MS, type WatchdogResult } from "@/lib/recovery/watchdog";
import { createAlert, lastResolvedAlertAt, sendAlertEmail } from "@/lib/recovery/alerts";
import { SendError } from "@/lib/email/send-error";
import { createWelcomeRuns, processWelcomeRuns } from "@/lib/recovery/welcome";
import { checkNumber, sendText, wahaConfigured, WahaError } from "@/lib/whatsapp/waha";
import { shortenLinks } from "@/lib/recovery/short-links";
import { loadAllShopifyCreds } from "@/lib/agent/analyze";
import { decrypt } from "@/lib/crypto";
import { loadProducts, personaFor, routeProduct, type Product, type Products } from "@/lib/agent/products";
import { cleanItemTitle } from "@/lib/receipts/build";
import { formatMoney } from "@/lib/forms/format";
import { stripDashes } from "@/lib/text/dashes";
import { portugueseLeak } from "@/lib/text/lang-leak";
import type { ShopifyAuth } from "@/lib/shopify/abandoned";

// MOTOR da régua de recuperação (spec §3) e do pós-compra (spec v2 §1). Roda
// a cada minuto (pg_cron → /api/cron/recovery-tick). Em cada tick:
//   1. sincroniza os checkouts das últimas 2h (o poll-inboxes faz o completo);
//   2. mede a saúde do e-mail por loja (bounce/reclamação 24h) e pausa o
//      canal da loja que passou do limite (alerta por e-mail);
//   3. agenda o 1º passo de quem ainda não tem próximo envio;
//   4. processa os vencidos do carrinho, canal por canal, até 50 por tick;
//   5. pós-compra: cria os runs dos primeiros pedidos pagos e processa os
//      vencidos (lib/recovery/welcome.ts);
//   6. vigilância (watchdog) do WAHA, das sessões e dos alertas.
//
// Regras de ouro (não negociáveis):
//   - a TRAVA (dedupe_key em recovery_events) é gravada ANTES de enviar, igual
//     ao email_log; chave repetida = já saiu = avança sem enviar;
//   - falha DEFINITIVA de envio (4xx, restrição, credencial, validação) libera
//     a chave (dedupe_key = null) pra tentar de novo (no máximo 3 vezes por
//     passo). Falha AMBÍGUA (timeout, abort, 5xx, resposta perdida depois de
//     conectar) MANTÉM a chave, registra failed com detail.ambiguous = true,
//     NÃO retenta, avança o passo e abre um alerta (a mensagem pode ter saído;
//     reenviar duplicaria pro cliente);
//   - atraso máximo de 12 h: passo vencido há mais que isso NÃO sai (reabilitar
//     um canal parado não despeja backlog): reagenda a partir de agora, mesmo
//     passo, e registra skipped 'atrasado' uma vez por passo. Com o canal
//     desligado (gate) o next_at NÃO é empurrado, senão o atraso nunca passaria
//     de 30 min; processDue nem lê as lojas com o canal desligado;
//   - WhatsApp, 1º contato (wa_step = 0) só nas WA_FIRST_CONTACT_MAX_HOURS
//     (14 dias, a janela da régua) depois do abandono. O WhatsApp não usa o
//     production_since do e-mail: ao ligar, chama todo carrinho ativo com
//     número, do mais recente ao mais antigo, 1 pessoa nova por vez;
//   - recusa por COTA do provedor (429: cota diária/mensal, limite de taxa)
//     libera a trava sem contar tentativa, não avança, adia 60 min e segura
//     os e-mails da loja no resto do tick (e por 60 min nos seguintes);
//   - nunca avança o passo sem ter enviado (exceto chave duplicada, passo com
//     desconto sem cupom cadastrado e passo sem texto no idioma do cliente
//     nem em inglês: registra skipped e avança sem mandar);
//   - idioma: o do cliente, senão inglês, senão NÃO SAI. Nunca hebraico pra
//     quem não é hebraico, nunca português;
//   - intervalo mínimo (min_gap_hours, padrão 2 h): nunca dois e-mails de
//     marketing pro mesmo endereço em menos de N horas entre fluxos/lojas
//     diferentes; dentro do mesmo carrinho/run vale min(N, delay do passo);
//   - modo de teste: destinatário vira test_email/test_phone, is_test = true e
//     a chave ganha sufixo :test:<minuto>; o cliente real NUNCA recebe. O
//     passo do carrinho real AVANÇA mesmo em teste (decisão do Ian, 09/10:
//     o teste mostra a régua andando de verdade), por isso o teste é contido:
//     no máximo TEST_MAX_PER_TICK carrinhos por loja e canal por tick e
//     TEST_DAILY_CAP envios de teste por loja e canal por dia (contando
//     recovery_events sent com is_test = true, inclusive os do botão
//     "Testar este passo"). Links de clique/descadastro e a tag "test" do
//     provedor marcam o envio como teste: clique, descadastro, bounce ou
//     reclamação do e-mail de teste não atingem o cliente real;
//   - e-mail de produção: o teto diário é o de aquecimento (warmupCap), o DNS
//     do remetente precisa estar ok (SPF, DKIM, DMARC) e a loja não pode
//     estar com bounce/reclamação acima do limite (evaluateEmailHealth);
//   - qualquer dúvida (gate, horário, teto, regra de parada, cupom ausente,
//     idioma vazado, sessão sem número, credencial Shopify ausente, provedor
//     sem configuração, DNS sem verificação) = NÃO envia. Falhar fechado.

export type StepChannel = "email" | "whatsapp";

// Modo de teste: contenção (ver cabeçalho).
export const TEST_MAX_PER_TICK = 5;
export const TEST_DAILY_CAP = 20;

export interface WelcomeResult {
  created: number;
  sent: number;
  skipped: number;
  stopped: number;
}

export interface TickResult {
  skipped?: "migration_missing";
  synced: number;
  scheduled: number;
  sent: { email: number; whatsapp: number };
  skippedCount: number;
  stopped: number;
  errors: string[];
  welcome: WelcomeResult;
  // saúde do e-mail por loja avaliada neste tick (só lojas com envio nas últimas 24h)
  health?: Array<{ storeId: string; action: EmailHealth["action"]; reason: string | null; sent24h: number }>;
  // lojas cujo e-mail foi DESLIGADO neste tick por bounce/reclamação
  pausedEmail?: string[];
  watchdog?: WatchdogResult;
  partial?: boolean; // deadline estourou antes de acabar
  ms?: number;
}

export type StoreCred = ShopifyAuth & { storeId: string };

export interface TickContext {
  admin: SupabaseClient;
  now: Date;
  nowIso: string;
  deadline?: number;
  onlyStoreId: string | null;
  settings: Map<string, RecoverySettings>;
  steps: RecoveryStep[]; // todos os fluxos (carrinho e pos_compra), só os ligados
  discounts: RecoveryDiscount[];
  creds: StoreCred[];
  storeNames: Map<string, string>;
  products: Map<string, Products>;
  dailySent: Map<string, number>; // "<loja>:<canal>" (reais) e "<loja>:<canal>:test" (de teste)
  testThisTick: Map<string, number>; // "<loja>:<canal>" → carrinhos de teste processados neste tick
  health: Map<string, EmailHealth>; // loja → saúde do e-mail (24h), quando avaliada
  dns: Map<string, SenderDns>; // from_email → verificação de DNS (uma por tick)
  touchedStores: Set<string>;
  result: TickResult;
  waLastNewContact?: Map<string, number>; // "<loja>:<teste?>" → instante (ms) do último 1º contato de WhatsApp
  waNewContactCount?: Map<string, number>; // loja → 1ºs contatos de WhatsApp nas últimas 24 h (teto diário de contatos novos)
  paceLast?: Map<string, number>; // "<loja>:<canal>:<teste?>" → instante (ms) da última mensagem automática (trava anti-rajada)
  emailQuotaBlocked?: Set<string>; // lojas com recusa por cota do provedor nos últimos 60 min (e-mail segurado)
}

const MIN = 60_000;
// Ritmo de conversas NOVAS no WhatsApp (pedido do Ian, 09/10): no máximo uma
// pessoa nova a cada N minutos por loja, somando todos os números. Os passos
// seguintes de quem já recebeu o 1º contato não esperam esse ritmo.
export const WA_NEW_CONTACT_GAP_MIN = 10;
// TRAVA ANTI-RAJADA (Ian, 10/10: "nunca chamar tudo de uma vez, gasta
// crédito e fica spam"): mensagens AUTOMÁTICAS saem uma de cada vez por loja
// e canal, com um intervalo mínimo entre duas quaisquer, de qualquer cliente
// e qualquer passo: régua e retomadas do WhatsApp (PACE_GAP_SEC.whatsapp),
// e-mails de carrinho e de boas-vindas (PACE_GAP_SEC.email). Vale o último
// envio gravado no banco (dois ticks ao mesmo tempo também esperam) e a marca
// na memória do tick logo depois de cada envio (um tick nunca solta duas).
// As respostas do agente a uma mensagem da cliente não entram (são conversa).
export const PACE_GAP_SEC: Record<StepChannel, number> = { whatsapp: 120, email: 60 };
// 1º contato de WhatsApp (wa_step = 0) só até N horas depois do abandono.
// Ian (09/10, noite): ao ligar o WhatsApp, chamar TODOS os carrinhos ativos
// com número (a régua dura 14 dias; depois disso o carrinho já fechou como
// janela_expirada). O ritmo de 1 pessoa nova a cada WA_NEW_CONTACT_GAP_MIN
// espalha esse lote, do abandono mais recente para o mais antigo.
export const WA_FIRST_CONTACT_MAX_HOURS = 14 * 24;
// WhatsApp (Ian, 10/10): carrinho que ACABOU de cair chama na hora, a qualquer
// horário (2h da manhã inclusive). Abandono há menos de WA_FRESH_HOURS = sem
// horário silencioso em nenhum passo do WhatsApp (1º contato e os seguintes).
// Os antigos (o lote) só saem dentro do dia: das WA_DAY_START_HOUR (9h, fuso
// do cliente) até o fim do quiet_hours da loja. O e-mail não muda.
export const WA_DAY_START_HOUR = 9;
export const WA_FRESH_HOURS = 6;
const NO_QUIET_HOURS: RecoverySettings["quiet_hours"] = { start: 0, end: 0, shabbat: false }; // start >= end = sem horário silencioso
export function isFreshCart(rec: Pick<RecoveryRow, "abandoned_at"> | null | undefined, now: Date): boolean {
  const at = rec?.abandoned_at ? new Date(rec.abandoned_at).getTime() : NaN;
  return Number.isFinite(at) && now.getTime() - at < WA_FRESH_HOURS * 3600_000;
}
export function quietFor(settings: Pick<RecoverySettings, "quiet_hours"> | null | undefined, channel: StepChannel, rec?: Pick<RecoveryRow, "abandoned_at"> | null, now?: Date): RecoverySettings["quiet_hours"] {
  const q = settings?.quiet_hours ?? null;
  if (channel !== "whatsapp") return q;
  if (rec && isFreshCart(rec, now ?? new Date())) return NO_QUIET_HOURS;
  return { ...(q ?? {}), start: WA_DAY_START_HOUR };
}
export function waFirstContactAllowed(abandonedAt: string | null | undefined, now: Date): boolean {
  const at = abandonedAt ? new Date(abandonedAt).getTime() : NaN;
  return Number.isFinite(at) && now.getTime() - at <= WA_FIRST_CONTACT_MAX_HOURS * 3600_000;
}
// Primeiro nome como a cliente digitou, com a 1ª letra maiúscula quando veio
// tudo minúsculo em letras latinas ("lionl" → "Lionl"; hebraico não muda).
export function displayFirstName(firstName: string | null | undefined): string {
  const n = (firstName ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[a-zà-ÿ]/.test(n) && n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}
// Recusa por cota do provedor de e-mail: a loja fica sem e-mail por N min.
export const EMAIL_QUOTA_BACKOFF_MIN = 60;
// Passos de e-mail do carrinho que só saem para quem abriu ou clicou antes.
export const ENGAGED_ONLY_EMAIL_STEPS = new Set([5, 6, 7]);
// Endereços pessoais que nunca podem ser remetente ou resposta de e-mail para cliente.
export const PERSONAL_ADDRESS_RE = /dono@suaempresa\.com/i;
const HOUR = 60 * MIN;
const nextField = (ch: StepChannel) => (ch === "email" ? "email_next_at" : "wa_next_at") as "email_next_at" | "wa_next_at";
const stepField = (ch: StepChannel) => (ch === "email" ? "email_step" : "wa_step") as "email_step" | "wa_step";
export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (v: number | string | null | undefined) => {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const providerOf = (settings: Pick<RecoverySettings, "email_provider"> | null | undefined): MarketingProvider => (settings?.email_provider === "ses" ? "ses" : settings?.email_provider === "activecampaign" ? "activecampaign" : "resend");

// --- Gate de envio (regra 2.1) ------------------------------------------------

export function canSend(settings: RecoverySettings | null | undefined, channel: StepChannel): boolean {
  if (!settings?.enabled) return false;
  if (channel === "email") {
    // Produção + SES exige SES_CONFIGURATION_SET (sem ele bounce e reclamação não chegam).
    if (!settings.email_enabled || !marketingConfigured(providerOf(settings), { production: !settings.test_mode })) return false;
    return settings.test_mode ? Boolean(settings.test_email?.trim()) : true;
  }
  if (!settings.whatsapp_enabled || !wahaConfigured()) return false;
  return settings.test_mode ? Boolean(settings.test_phone?.trim()) : true;
}

// Pra quem vai de verdade: em teste, SEMPRE o destino de teste da loja.
export function destinationFor(settings: RecoverySettings, channel: StepChannel, rec: Pick<RecoveryRow, "email" | "phone">): string | null {
  if (settings.test_mode) return (channel === "email" ? settings.test_email : settings.test_phone)?.trim() || null;
  return (channel === "email" ? rec.email : rec.phone)?.trim() || null;
}

export const dedupeKeyFor = (rec: Pick<RecoveryRow, "checkout_id">, channel: StepChannel, position: number, isTest: boolean, now = new Date()) =>
  `recovery:${rec.checkout_id}:${channel}:${position}${isTest ? `:test:${now.toISOString().slice(0, 16)}` : ""}`;

// --- Escrita na linha do recovery (regra 2.8) ---------------------------------

async function patchRec(admin: SupabaseClient, rec: RecoveryRow, patch: Partial<RecoveryRow>): Promise<void> {
  const merged = { ...rec, ...patch };
  const nexts = [merged.email_next_at, merged.wa_next_at].filter((x): x is string => Boolean(x)).map((x) => new Date(x).getTime());
  const full: Partial<RecoveryRow> = {
    ...patch,
    step: (merged.email_step ?? 0) + (merged.wa_step ?? 0),
    next_send_at: nexts.length > 0 ? new Date(Math.min(...nexts)).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from("cart_recoveries").update(full).eq("id", rec.id);
  if (error) throw new Error(error.message);
  Object.assign(rec, full);
}

// Alvo de um evento: carrinho (recovery_id) ou run do pós-compra (run_id).
export type EventTarget = { store_id: string; recovery_id?: string | null; run_id?: string | null };

export async function logEvent(admin: SupabaseClient, target: EventTarget, input: { channel: StepChannel | "system"; step: number | null; type: "skipped" | "failed" | "stopped"; reason: string; detail?: unknown; isTest?: boolean; code?: string | null; to?: string | null }): Promise<void> {
  const { error } = await admin.from("recovery_events").insert({
    recovery_id: target.recovery_id ?? null,
    run_id: target.run_id ?? null,
    store_id: target.store_id,
    step: input.step,
    channel: input.channel,
    type: input.type,
    discount_code: input.code ?? null,
    to_address: input.to ?? null,
    is_test: input.isTest ?? false,
    detail: { reason: input.reason, detail: input.detail ?? null },
  });
  if (error) console.error("recovery_events log:", error.message);
}

// Já existe um skipped com esse motivo hoje (UTC) pra esse alvo? Usado pelos
// avisos que não podem virar um evento por tick (intervalo mínimo, aguardando
// envio).
export async function skippedToday(admin: SupabaseClient, target: EventTarget, reason: string, now = new Date()): Promise<boolean> {
  const start = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  let q = admin.from("recovery_events").select("id", { count: "exact", head: true }).eq("type", "skipped").eq("detail->>reason", reason).gte("created_at", start);
  q = target.run_id ? q.eq("run_id", target.run_id) : q.eq("recovery_id", target.recovery_id ?? "");
  const { count, error } = await q;
  if (error) return true; // na dúvida, não registra de novo
  return (count ?? 0) > 0;
}

// --- Trava: grava antes, envia depois ----------------------------------------

// "missing_recovery": o recovery/run não existe (FK). Só acontece com o
// carrinho ou pedido fictício do botão "Testar este passo"; no tick nunca.
export type Claim = { ok: true; id: string; createdAt: string | null } | { ok: false; reason: "duplicate" | "missing_recovery" | "error"; message: string };

export async function claimEvent(admin: SupabaseClient, input: { target: EventTarget; channel: StepChannel; position: number; dedupeKey: string; code: string | null; to: string; language: string; isTest: boolean }): Promise<Claim> {
  const { data, error } = await admin
    .from("recovery_events")
    .insert({
      recovery_id: input.target.recovery_id ?? null,
      run_id: input.target.run_id ?? null,
      store_id: input.target.store_id,
      step: input.position,
      channel: input.channel,
      type: "queued",
      dedupe_key: input.dedupeKey,
      discount_code: input.code,
      to_address: input.to,
      language: input.language,
      is_test: input.isTest,
    })
    .select("id, created_at")
    .single();
  if (error || !data) {
    const message = error?.message ?? "sem resposta do banco";
    if (error?.code === "23505" || /duplicate key/i.test(message)) return { ok: false, reason: "duplicate", message };
    if (error?.code === "23503" || /foreign key/i.test(message)) return { ok: false, reason: "missing_recovery", message };
    return { ok: false, reason: "error", message };
  }
  return { ok: true, id: data.id as string, createdAt: (data.created_at as string | null) ?? null };
}

export async function markEventSent(admin: SupabaseClient, id: string, extra: { messageId: string | null; provider: string }): Promise<void> {
  const { error } = await admin.from("recovery_events").update({ type: "sent", message_id: extra.messageId, provider: extra.provider }).eq("id", id);
  // A trava já está gravada: mesmo que este update falhe, não há reenvio.
  if (error) console.error("recovery_events markSent:", error.message);
}

// Falhou de verdade: libera a chave pra nova tentativa, mantém o histórico.
export async function markEventFailed(admin: SupabaseClient, id: string, message: string): Promise<void> {
  const { error } = await admin.from("recovery_events").update({ type: "failed", dedupe_key: null, detail: { error: message.slice(0, 500) } }).eq("id", id);
  if (error) console.error("recovery_events markFailed:", error.message);
}

// Recusa por COTA do provedor (429): libera a chave como a falha definitiva,
// mas marca detail.quota = true: countFailed não conta como tentativa do passo
// e quotaBlockedStores segura a loja por EMAIL_QUOTA_BACKOFF_MIN.
export async function markEventQuota(admin: SupabaseClient, id: string, message: string): Promise<void> {
  const { error } = await admin.from("recovery_events").update({ type: "failed", dedupe_key: null, detail: { error: message.slice(0, 500), quota: true } }).eq("id", id);
  if (error) console.error("recovery_events markQuota:", error.message);
}

// Falha AMBÍGUA (a mensagem pode ter saído): mantém a chave de dedupe (nada
// reenvia por este passo) e marca detail.ambiguous = true.
export async function markEventAmbiguous(admin: SupabaseClient, id: string, message: string): Promise<void> {
  const { error } = await admin.from("recovery_events").update({ type: "failed", detail: { error: message.slice(0, 500), ambiguous: true } }).eq("id", id);
  if (error) console.error("recovery_events markAmbiguous:", error.message);
}

// Registra a falha ambígua e abre um alerta 'envio' para o Ian conferir no
// provedor se a mensagem saiu. Nunca lança.
export async function registerAmbiguousSend(admin: SupabaseClient, input: { claimId: string; storeId: string; channel: StepChannel; position: number; label: string; error: string }): Promise<void> {
  await markEventAmbiguous(admin, input.claimId, input.error);
  try {
    await createAlert(admin, {
      kind: "envio",
      key: `ambiguo:${input.claimId}`,
      storeId: input.storeId,
      message: `Envio ambíguo (${input.channel}, passo ${input.position}, ${input.label}): ${input.error.slice(0, 300)}. O provedor pode ter entregado a mensagem, por isso o passo NÃO foi retentado (evita duplicar pro cliente) e a régua avançou. Confira no provedor se a mensagem saiu.`,
    });
  } catch (err) {
    console.error("alerta de envio ambíguo:", errMsg(err));
  }
}

// --- Atraso máximo do passo (12 h) ---------------------------------------------

export const MAX_STEP_LATE_MS = 12 * HOUR;

// O passo venceu há mais de 12 h? (Tick parado, canal desligado e religado.)
export const isTooLate = (dueAt: string | null | undefined, now: Date): boolean => {
  if (!dueAt) return false;
  const due = new Date(dueAt).getTime();
  return Number.isFinite(due) && now.getTime() - due > MAX_STEP_LATE_MS;
};

// Já existe skipped 'atrasado' desse passo? (1 evento por passo, mesmo que ele atrase de novo.)
export async function lateSkippedBefore(admin: SupabaseClient, target: EventTarget, channel: StepChannel, position: number): Promise<boolean> {
  let q = admin.from("recovery_events").select("id", { count: "exact", head: true }).eq("type", "skipped").eq("channel", channel).eq("step", position).eq("detail->>reason", "atrasado");
  q = target.run_id ? q.eq("run_id", target.run_id) : q.eq("recovery_id", target.recovery_id ?? "");
  const { count, error } = await q;
  if (error) return true; // na dúvida, não registra de novo
  return (count ?? 0) > 0;
}

// Reagenda o passo atrasado a partir de AGORA (mesmo passo) e registra o
// skipped 'atrasado' uma vez por passo. Devolve o novo horário. Mínimo de 60
// min: passo com delay 0 não pode sair no próprio tick seguinte (seria despejar
// o backlog do mesmo jeito).
export async function rescheduleLateStep(admin: SupabaseClient, input: { target: EventTarget; channel: StepChannel; position: number; delayMinutes: number; countryCode: string | null; language?: string | null; quiet: RecoverySettings["quiet_hours"]; dueAt: string; now: Date; isTest: boolean }): Promise<string> {
  if (!(await lateSkippedBefore(admin, input.target, input.channel, input.position))) {
    await logEvent(admin, input.target, { channel: input.channel, step: input.position, type: "skipped", reason: "atrasado", detail: { dueAt: input.dueAt, lateHours: Math.round(((input.now.getTime() - new Date(input.dueAt).getTime()) / HOUR) * 10) / 10 }, isTest: input.isTest });
  }
  return scheduleAfter(input.now, Math.max(60, input.delayMinutes), input.countryCode, input.quiet, input.language).toISOString();
}

// Tentativas que falharam neste passo. Recusa por cota (detail.quota) não
// conta: a culpa é do provedor, não do passo. Erro de banco = 0 (como antes).
export async function countFailed(admin: SupabaseClient, target: EventTarget, channel: StepChannel, position: number): Promise<number> {
  let q = admin.from("recovery_events").select("detail").eq("channel", channel).eq("step", position).eq("type", "failed").limit(200);
  q = target.run_id ? q.eq("run_id", target.run_id) : q.eq("recovery_id", target.recovery_id ?? "");
  const { data } = await q;
  return countNonQuotaFailures((data ?? []) as Array<{ detail: unknown }>);
}
export const countNonQuotaFailures = (rows: Array<{ detail: unknown }>) => rows.filter((e) => (e.detail as { quota?: unknown } | null)?.quota !== true).length;

// Lojas com recusa por cota do provedor de e-mail nos últimos
// EMAIL_QUOTA_BACKOFF_MIN minutos (uma consulta por tick, guardada no ctx).
// Erro de banco = nenhuma (o provedor só recusaria de novo).
export async function quotaBlockedStores(ctx: Pick<TickContext, "admin" | "now" | "emailQuotaBlocked">): Promise<Set<string>> {
  if (ctx.emailQuotaBlocked) return ctx.emailQuotaBlocked;
  const since = new Date(ctx.now.getTime() - EMAIL_QUOTA_BACKOFF_MIN * MIN).toISOString();
  const { data, error } = await ctx.admin.from("recovery_events").select("store_id").eq("channel", "email").eq("type", "failed").eq("detail->>quota", "true").gte("created_at", since).limit(500);
  if (error) console.error("quotaBlockedStores:", error.message);
  ctx.emailQuotaBlocked = new Set((error ? [] : data ?? []).map((r) => String(r.store_id)).filter(Boolean));
  return ctx.emailQuotaBlocked;
}

// --- Intervalo mínimo entre e-mails de marketing (spec v2 §1.2) ----------------

// Padrão do intervalo mínimo quando a coluna vier nula ou inválida. (A
// migration 0018 criou a coluna com default 16; a 0020 troca por 2. O código
// trata o valor do banco normalmente, qualquer que seja.)
export const DEFAULT_MIN_GAP_HOURS = 2;

// Intervalo mínimo entre e-mails de marketing REAIS (sent, não-teste) pro mesmo
// endereço. Dois casos:
//   - mesmo carrinho ou mesmo run (passos seguidos de um MESMO fluxo): o gap
//     efetivo é min(min_gap_hours, delay do passo em horas). A própria régua já
//     espaça os passos pelo delay configurado, então um passo com delay de 30
//     min não fica preso pelas 2 h do gap (o gap vira 30 min e o delay manda);
//   - outro carrinho, pós-compra x carrinho ou outra loja: min_gap_hours cheio
//     (a pessoa não deve receber dois e-mails de fluxos diferentes colados).
// `same` identifica o fluxo e o delay do passo que vai sair; sem ele vale o gap
// cheio contra tudo. Se faltar tempo → bloqueado até `until`. Erro de banco =
// bloqueado (falha fechado).
export async function minGapBlock(admin: SupabaseClient, to: string, settings: RecoverySettings, now = new Date(), same?: { target: EventTarget; delayMinutes: number }): Promise<{ blocked: false } | { blocked: true; until: Date; lastAt: string }> {
  const hours = Number(settings.min_gap_hours);
  const gap = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MIN_GAP_HOURS;
  const sameGap = same ? Math.min(gap, Math.max(0, Number(same.delayMinutes) || 0) / 60) : gap;
  const since = new Date(now.getTime() - gap * HOUR).toISOString();
  const { data, error } = await admin
    .from("recovery_events")
    .select("created_at, recovery_id, run_id")
    .eq("type", "sent")
    .eq("channel", "email")
    .eq("is_test", false)
    .ilike("to_address", to.trim())
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("minGapBlock:", error.message);
    return { blocked: true, until: new Date(now.getTime() + 30 * MIN), lastAt: now.toISOString() };
  }
  let until = 0;
  let lastAt = "";
  for (const e of (data ?? []) as Array<{ created_at: string; recovery_id: string | null; run_id: string | null }>) {
    const sameFlow = Boolean(same) && ((Boolean(same?.target.recovery_id) && e.recovery_id === same?.target.recovery_id) || (Boolean(same?.target.run_id) && e.run_id === same?.target.run_id));
    const end = new Date(e.created_at).getTime() + (sameFlow ? sameGap : gap) * HOUR;
    if (end > now.getTime() && end > until) {
      until = end;
      lastAt = e.created_at;
    }
  }
  if (!until) return { blocked: false };
  return { blocked: true, until: new Date(until), lastAt };
}

// --- DNS do remetente (spec v2 §6) ------------------------------------------------

// Uma verificação por remetente por tick (o módulo de entregabilidade ainda
// cacheia 10 min por domínio). Erro na verificação = não ok (falha fechado).
export async function senderDns(ctx: Pick<TickContext, "dns">, fromEmail: string): Promise<SenderDns> {
  const key = fromEmail.trim().toLowerCase();
  const cached = ctx.dns.get(key);
  if (cached) return cached;
  let r: SenderDns;
  try {
    r = await checkSenderDns(key);
  } catch (err) {
    const domain = key.split("@")[1] ?? key;
    r = { domain, spf: null, dkim: false, dkimSelectors: [], dmarc: null, dmarcPolicy: null, ok: false, problems: [`erro na verificação: ${errMsg(err)}`] };
  }
  ctx.dns.set(key, r);
  return r;
}

// --- Marca, persona e variáveis ----------------------------------------------

export interface BrandInfo { brand: string; product: Product | null }

// Fonte das variáveis: carrinho (RecoveryRow) ou run do pós-compra, que têm
// os mesmos campos de itens, valor e nome.
export interface VarSource {
  store_id: string;
  language: string | null;
  items: RecoveryItem[];
  total: number | string | null;
  currency: string | null;
  first_name: string | null;
  total_discount?: number | string | null; // cupom do site já aplicado no carrinho (só carrinho)
}

// Porcentagem que a mensagem fala (Ian, 09/10: "sempre cita 15, 25 e 30%",
// os números do nome dos cupons VOLTA15/VOLTA25/VOLTA30), mesmo que o
// cupom na Shopify seja menor (5%, 9%, 10% do subtotal ≈ 15/25/30% sobre o
// valor que a cliente já via).
export function nominalPercent(code: string | null | undefined): number | null {
  const m = /(\d{1,2})\s*$/.exec(code ?? "");
  return m ? Number(m[1]) : null;
}

// Quanto o cupom extra (percent sobre o SUBTOTAL, que é como a Shopify
// calcula, em paralelo com o cupom do site) tira deste carrinho, e quanto o
// pedido fica. Subtotal = total + desconto do site, com teto (ver abaixo)
// (carrinho antigo guardou o preço de lista antigo, maior que o de hoje):
// melhor prometer um pouco menos do que o checkout mostra do que mais.
// Economia arredondada para baixo e preço final para cima.
export function extraSavings(src: Pick<VarSource, "total" | "total_discount">, percent: number | null | undefined): { saving: number; final: number; savingExact: number; subtotal: number; effectivePct: number; totalPct: number | null } | null {
  const total = Number(src.total);
  if (!percent || !Number.isFinite(total) || total <= 0) return null;
  const disc = Number(src.total_discount ?? 0);
  // Teto pelo preço de hoje (Olavita IL, 09/10): kit de 4 = ₪892,50 → ₪315
  // (2,84×), kit de 2 = ₪595 → ₪198 (3,01×), pote avulso = ₪297,50 → ₪149
  // (2×). Carrinho antigo guardou o preço de lista antigo (₪1.020), maior.
  const cap = total < 180 ? 2 : total < 300 ? 3.01 : 2.84;
  const subtotal = Math.min(total + (Number.isFinite(disc) && disc > 0 ? disc : 0), total * cap);
  const savingExact = (percent / 100) * subtotal;
  const finalExact = total - savingExact;
  return {
    saving: Math.floor(savingExact),
    final: Math.ceil(finalExact),
    savingExact,
    subtotal,
    // Desconto extra sobre o preço que ela já via (o "15% em cima" do Ian).
    effectivePct: Math.floor((100 * savingExact) / total + 0.05),
    // Desconto total sobre o preço cheio do carrinho (só com cupom do site).
    totalPct: disc > 0 ? 100 * (1 - finalExact / subtotal) : null,
  };
}

export function resolveBrand(products: Products | null, src: Pick<VarSource, "store_id" | "language" | "items">, storeName: string | null): BrandInfo {
  const product = products ? routeProduct(products, { storeId: src.store_id, recipients: [], texts: [], language: src.language, orderTitles: (src.items ?? []).map((i) => i.title).filter(Boolean) }) : null;
  return { brand: product?.name ?? storeName ?? "", product };
}

// Nome da vendedora: o configurado na loja, desde que caiba no alfabeto do
// idioma (נועה num texto búlgaro travaria na trava de idioma); senão a persona
// do produto/idioma (Olavita em hebraico = נועה, por exemplo).
export function agentNameFor(settings: RecoverySettings, info: BrandInfo, lang: string): string {
  const configured = settings.agent_name?.trim();
  if (configured && portugueseLeak(configured, lang).length === 0) return configured;
  return personaFor(info.product, info.brand, lang).name;
}

const foreignScript = (text: string, lang: string) => portugueseLeak(text, lang).some((x) => x.startsWith("alfabeto"));
const stripQty = (title: string) => title.replace(/^\s*\d+\s*[×x]\s*/i, "").replace(/^\s*\+\s*/, "").trim();

export function buildVars(src: VarSource, info: BrandInfo, lang: string, extra: { agent: string; link: string; code: string | null; percent: number | null; pedido?: string | null; rastreio?: string | null; linkRastreio?: string | null }): TemplateVars {
  const items = src.items ?? [];
  const firstTitle = items[0]?.title ? stripQty(cleanItemTitle(items[0].title)) : "";
  const fallbackProduct = info.product?.name || info.brand;
  const produto = firstTitle && !foreignScript(firstTitle, lang) ? firstTitle : fallbackProduct;
  const itens = items
    .map((i) => {
      const t = cleanItemTitle(i.title ?? "");
      return `${Number(i.quantity) || 1}× ${foreignScript(t, lang) ? fallbackProduct : t}`;
    })
    .join(", ");
  const total = src.total == null || src.total === "" ? NaN : Number(src.total);
  const valor = Number.isFinite(total) && src.currency ? formatMoney(total, src.currency, lang) : "";
  // Nome em alfabeto que não bate com o idioma do texto (דנה num e-mail em
  // inglês) travaria na trava de idioma: sai sem nome, que é natural.
  const rawName = displayFirstName(src.first_name);
  const nome = rawName && !foreignScript(rawName, lang) ? rawName : "";
  return {
    nome,
    produto,
    itens,
    valor,
    link: extra.link,
    cupom: extra.code ?? "",
    // "15% em cima do valor com desconto" (o cupom é % do subtotal na Shopify).
    desconto: (() => {
      const nominal = nominalPercent(extra.code);
      if (nominal) return `${nominal}%`;
      const x = extraSavings(src, extra.percent);
      return x ? `${x.effectivePct}%` : extra.percent ? `${extra.percent}%` : "";
    })(),
    economia: (() => {
      const x = extraSavings(src, extra.percent);
      return x && src.currency ? formatMoney(x.saving, src.currency, lang) : "";
    })(),
    preco_final: (() => {
      const x = extraSavings(src, extra.percent);
      return x && src.currency ? formatMoney(x.final, src.currency, lang) : "";
    })(),
    marca: info.brand,
    agente: extra.agent,
    pedido: extra.pedido ?? "",
    rastreio: extra.rastreio ?? "",
    link_rastreio: extra.linkRastreio ?? "",
  };
}

// --- Montagem do passo ----------------------------------------------------------

export interface PreparedStep {
  lang: string;
  text: string; // WhatsApp: a mensagem; e-mail: corpo em texto (já renderizado)
  textPt: string | null; // variante em PT (body.pt) pro painel
  subject?: string;
  preheader?: string; // prévia (step.preview[lang]) renderizada
  buttonLabel?: string; // rótulo do botão (step.button[lang]) renderizado
  html?: string;
  emailText?: string;
  code: string | null;
  percent: number | null;
  link: string;
  unsubscribeUrl?: string;
  // o passo pedia desconto mas a loja não tem cupom ativo com esse percentual
  noCoupon?: { percent: number };
}

// "sem_idioma": não há texto no idioma do cliente nem em inglês (o motor
// registra skipped e avança o passo). "sem_texto": texto vazio depois de
// renderizar. "idioma": vazou português ou alfabeto estranho.
export type PrepareOutcome = PreparedStep | { error: "sem_idioma" | "sem_texto" | "idioma"; detail?: string };

function findDiscount(discounts: RecoveryDiscount[], storeId: string, percent: number): RecoveryDiscount | null {
  return discounts.find((d) => d.store_id === storeId && d.active && Number(d.percent) === percent) ?? null;
}

// Prévia e botão do passo, no idioma do corpo (senão en, senão vazio),
// renderizados com as mesmas variáveis e passados pela trava de idioma.
export function renderExtras(step: Pick<RecoveryStep, "preview" | "button">, lang: string, vars: TemplateVars): { preheader: string; buttonLabel: string } | { error: "idioma"; detail: string } {
  const preheader = stripDashes(renderTemplate(pickLocalized(step.preview, lang), vars));
  const buttonLabel = stripDashes(renderTemplate(pickLocalized(step.button, lang), vars));
  for (const [what, text] of [["prévia", preheader], ["botão", buttonLabel]] as const) {
    const leak = portugueseLeak(text, lang);
    if (leak.length > 0) return { error: "idioma", detail: `${what}: ${leak.join(", ")}` };
  }
  return { preheader, buttonLabel };
}

// `isTest`: os links de clique e descadastro levam t:1 (as rotas públicas não
// gravam nada), já que o carrinho emprestado pro teste é de um cliente real.
export function prepareStep(input: { rec: RecoveryRow; step: RecoveryStep; settings: RecoverySettings; channel: StepChannel; discounts: RecoveryDiscount[]; products: Products | null; storeName: string | null; variantIndex?: number; isTest?: boolean; allowPt?: boolean }): PrepareOutcome {
  const { rec, step, settings, channel } = input;
  const isTest = Boolean(input.isTest);
  const wanted = pct(step.discount_percent);
  let percent: number | null = null;
  let code: string | null = null;
  let noCoupon: PreparedStep["noCoupon"];
  if (wanted) {
    const d = findDiscount(input.discounts, rec.store_id, wanted);
    if (d) {
      code = d.code;
      percent = wanted;
    } else {
      noCoupon = { percent: wanted }; // o envio é bloqueado (regra 2.5), nunca inventa código
      percent = wanted; // só pra prévia/lint mostrar "25%" em vez de vazio; o passo NÃO sai sem cupom
    }
  }
  const body = pickStepBody(step, rec.language, rec.country_code, input.variantIndex, Boolean(input.isTest && input.allowPt));
  if (!body) return { error: "sem_idioma", detail: `passo ${step.position} (${channel}) sem texto em ${rec.language ?? "?"} nem em en` };
  const lang = body.lang;
  const info = resolveBrand(input.products, rec, input.storeName);
  const agent = agentNameFor(settings, info, lang);
  const link = clickLink(rec.id, step.position, channel, code, isTest);
  const unsubscribeUrl = channel === "email" ? unsubscribeLink(rec.id, "email", isTest) : undefined;
  const vars = buildVars(rec, info, lang, { agent, link, code, percent });

  const text = stripDashes(renderTemplate(body.text, vars));
  if (!text) return { error: "sem_texto", detail: "texto vazio depois de renderizar" };
  const leak = portugueseLeak(text, lang);
  if (leak.length > 0) return { error: "idioma", detail: leak.join(", ") };
  const textPt = body.textPt ? renderTemplate(body.textPt, vars) : null;

  const out: PreparedStep = { lang, text, textPt, code, percent, link, unsubscribeUrl, noCoupon };
  if (channel === "email") {
    const subject = stripDashes(renderTemplate(pickStepSubject(step, lang), vars)) || emailLabels(lang).cart;
    if (portugueseLeak(subject, lang).length > 0) return { error: "idioma", detail: `assunto: ${portugueseLeak(subject, lang).join(", ")}` };
    const extras = renderExtras(step, lang, vars);
    if ("error" in extras) return extras;
    out.subject = subject;
    out.preheader = extras.preheader || undefined;
    out.buttonLabel = extras.buttonLabel || undefined;
    out.html = buildRecoveryEmailHtml({
      brand: info.brand,
      language: lang,
      bodyHtmlOrText: text,
      items: rec.items ?? [],
      total: rec.total,
      currency: rec.currency,
      link,
      buttonLabel: out.buttonLabel,
      unsubscribeUrl: unsubscribeUrl as string,
      subject,
      preheader: out.preheader,
      discountCode: code,
      discountPercent: percent,
    });
    out.emailText = buildRecoveryEmailText({ bodyText: text, link, unsubscribeUrl: unsubscribeUrl as string, language: lang });
  }
  return out;
}

// --- Envio --------------------------------------------------------------------------

// `ambiguous`: falha depois de conectar (timeout, abort, 5xx, resposta perdida);
// a mensagem pode ter saído, então o passo não é retentado. `quota`: recusa
// por cota/limite do provedor (429), definitiva e sem contar tentativa.
export type SendOutcome = { ok: true; messageId: string | null; provider: string } | { ok: false; error: string; restriction?: boolean; ambiguous?: boolean; quota?: boolean };

// E-mail de marketing pelo provedor da loja (Resend ou SES). `tags` já vêm
// completas (recovery_id ou run_id, step, channel, store_id, flow); aqui só
// entra test=1 quando é teste.
const sesWithoutConfigurationSet = (provider: MarketingProvider) => provider === "ses" && marketingConfigured("ses") && !marketingConfigured("ses", { production: true });

export async function deliverEmail(input: { settings: RecoverySettings; prepared: PreparedStep; to: string; dedupeKey: string; isTest: boolean; tags: Record<string, string> }): Promise<SendOutcome> {
  const { settings, prepared } = input;
  const fromEmail = settings.from_email?.trim();
  if (!fromEmail) return { ok: false, error: "sem_remetente" };
  const provider = providerOf(settings);
  const production = !settings.test_mode && !input.isTest;
  // Trava (Ian, 09/10): o e-mail pessoal do dono nunca aparece para cliente,
  // nem como remetente nem como "responder para".
  if (PERSONAL_ADDRESS_RE.test(`${fromEmail} ${settings.reply_to ?? ""}`)) return { ok: false, error: "remetente_pessoal_bloqueado" };
  if (!marketingConfigured(provider, { production })) return { ok: false, error: sesWithoutConfigurationSet(provider) ? "ses_sem_configuration_set" : "provedor_nao_configurado" };
  try {
    const r = await sendMarketingEmail(provider, {
      from: settings.from_name?.trim() ? `${settings.from_name.trim()} <${fromEmail}>` : fromEmail,
      to: input.to,
      subject: prepared.subject ?? "",
      html: prepared.html ?? "",
      text: prepared.emailText,
      replyTo: settings.reply_to?.trim() || null,
      headers: prepared.unsubscribeUrl ? unsubscribeHeaders(prepared.unsubscribeUrl) : undefined,
      // test=1: o webhook sabe que bounce/reclamação/abertura desse e-mail é
      // de teste e não deve suprimir nem parar o carrinho/run real.
      tags: { ...input.tags, ...(input.isTest ? { test: "1" } : {}) },
      idempotencyKey: input.dedupeKey,
      preheader: prepared.preheader ?? null,
      link: prepared.link ?? null,
      coupon: prepared.code ?? null,
    }, { production });
    return { ok: true, messageId: r.id, provider: r.provider };
  } catch (err) {
    const ambiguous = err instanceof SendError && err.ambiguous;
    // Ambíguo vence a cota (a mensagem pode ter saído: nunca retentar).
    return { ok: false, error: errMsg(err), ambiguous, quota: !ambiguous && err instanceof SendError && err.quota };
  }
}

async function deliverWhatsapp(admin: SupabaseClient, input: { session: WhatsappSessionRow; chatId: string; to: string; prepared: PreparedStep; rec: RecoveryRow; position: number; isTest: boolean }): Promise<SendOutcome> {
  const { session, prepared, rec } = input;
  // Link curto no domínio da loja (nunca o domínio do painel). Sem ele, não envia.
  let text: string;
  try {
    text = await shortenLinks(admin, prepared.text);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  try {
    const r = await sendText(session.name, input.chatId, text, { humanize: true });
    const nowIso = new Date().toISOString();
    const { error } = await admin.from("whatsapp_messages").insert({
      session: session.name,
      chat_id: input.chatId,
      phone: input.to,
      direction: "outbound",
      author: "regua",
      message_id: r.messageId,
      body: text,
      body_pt: prepared.textPt,
      step: input.position,
      ack: 0,
      status: input.isTest ? "test" : "sent",
      is_test: input.isTest, // fora do chat do cliente no painel
      recovery_id: rec.id,
      raw: r.raw ?? null,
      sent_at: nowIso,
    });
    if (error) console.error("whatsapp_messages insert:", error.message);
    await bumpSessionSent(admin, session);
    return { ok: true, messageId: r.messageId, provider: "waha" };
  } catch (err) {
    return { ok: false, error: errMsg(err), restriction: err instanceof WahaError && err.isRestriction, ambiguous: err instanceof WahaError && err.isAmbiguous };
  }
}

// --- Tick ------------------------------------------------------------------------------

// Passos do CARRINHO (flow = carrinho). O pós-compra tem o seu (welcome.ts).
const stepsFor = (ctx: TickContext, storeId: string, channel: StepChannel) =>
  ctx.steps.filter((s) => s.store_id === storeId && s.channel === channel && s.enabled && (s.flow ?? "carrinho") === "carrinho").sort((a, b) => a.position - b.position);
// Próximo passo HABILITADO depois da posição dada (0 = o primeiro). Passo do
// meio desligado não trunca a régua: o seguinte habilitado assume o lugar, e o
// contador (email_step/wa_step) vai pra posição do passo realmente tratado.
const nextStepAfter = (ctx: TickContext, storeId: string, channel: StepChannel, afterPosition: number) => stepsFor(ctx, storeId, channel).find((s) => s.position > afterPosition) ?? null;
export const overDeadline = (ctx: Pick<TickContext, "deadline">) => Boolean(ctx.deadline && Date.now() > ctx.deadline);

export async function productsFor(ctx: TickContext, storeId: string): Promise<Products> {
  let p = ctx.products.get(storeId);
  if (!p) {
    p = await loadProducts(ctx.admin, storeId);
    ctx.products.set(storeId, p);
  }
  return p;
}

// Enviados hoje, por loja e canal (reais ou de teste, separados). Uma
// consulta por trio por tick. Carrinho e pós-compra dividem o mesmo teto.
export const dailyKey = (storeId: string, channel: StepChannel, isTest: boolean) => `${storeId}:${channel}${isTest ? ":test" : ""}`;

export async function dailyCount(ctx: TickContext, storeId: string, channel: StepChannel, isTest: boolean): Promise<number> {
  const key = dailyKey(storeId, channel, isTest);
  const cached = ctx.dailySent.get(key);
  if (cached != null) return cached;
  const start = `${ctx.nowIso.slice(0, 10)}T00:00:00.000Z`;
  let q = ctx.admin.from("recovery_events").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("channel", channel).eq("type", "sent").eq("is_test", isTest).gte("created_at", start);
  // WhatsApp: o daily_cap_whatsapp é só dos envios da RÉGUA (step preenchido).
  // As respostas do agente e as mensagens do humano entram em recovery_events
  // como 'sent' com step nulo e não consomem o teto da régua.
  if (channel === "whatsapp") q = q.not("step", "is", null);
  const { count } = await q;
  ctx.dailySent.set(key, count ?? 0);
  return count ?? 0;
}

// Ritmo de 1º contato no WhatsApp: instante a partir do qual a loja pode
// abrir uma conversa NOVA. Lê o último envio do 1º passo de WhatsApp da loja
// (uma consulta por loja por tick) e o que já saiu neste tick.
const waKey = (storeId: string, isTest: boolean) => `${storeId}:${isTest ? "t" : "p"}`;
async function waNewContactFreeAt(ctx: TickContext, storeId: string, isTest: boolean): Promise<number> {
  const gap = WA_NEW_CONTACT_GAP_MIN * MIN;
  ctx.waLastNewContact ??= new Map();
  const key = waKey(storeId, isTest);
  if (!ctx.waLastNewContact.has(key)) {
    const first = nextStepAfter(ctx, storeId, "whatsapp", 0);
    let last = 0;
    if (first) {
      const { data, error } = await ctx.admin
        .from("recovery_events")
        .select("created_at")
        .eq("store_id", storeId)
        .eq("channel", "whatsapp")
        .eq("type", "sent")
        .eq("is_test", isTest)
        .eq("step", first.position)
        .order("created_at", { ascending: false })
        .limit(1);
      // Erro de banco: trata como "acabou de abrir uma conversa" (espera o intervalo).
      last = error ? ctx.now.getTime() : data?.[0]?.created_at ? new Date(data[0].created_at as string).getTime() : 0;
    }
    ctx.waLastNewContact.set(key, last);
  }
  return (ctx.waLastNewContact.get(key) as number) + gap;
}
function markWaNewContact(ctx: TickContext, storeId: string, isTest: boolean): void {
  ctx.waLastNewContact ??= new Map();
  ctx.waLastNewContact.set(waKey(storeId, isTest), Date.now());
  if (!isTest && ctx.waNewContactCount?.has(storeId)) ctx.waNewContactCount.set(storeId, (ctx.waNewContactCount.get(storeId) as number) + 1);
}

// Teto de CONTATOS NOVOS por dia no WhatsApp: DESLIGADO por decisão do Ian
// (12/10: "todos os carrinhos abandonados, independente da quantidade"; 100
// carrinhos = 100 contatos). Fica só como válvula: WA_NEW_CONTACTS_PER_DAY no
// ambiente liga um teto fixo (janela móvel de 24 h; os que ficam de fora
// seguem pelo e-mail e são tentados de hora em hora). Sem a variável, não há
// teto: só valem o ritmo entre contatos e a trava do próprio WhatsApp
// (Reachout Timelock, lida do perfil do número). Aviso dado ao Ian: no dia 10
// o número fez 16 contatos novos e o WhatsApp aplicou a trava.
export function waNewContactDailyCap(_now: Date): number {
  const fixed = Number(process.env.WA_NEW_CONTACTS_PER_DAY);
  return Number.isFinite(fixed) && fixed > 0 ? Math.floor(fixed) : Number.POSITIVE_INFINITY;
}
// Janela móvel de 24 h. Erro de banco = trata como "teto cheio" (falha fechado).
async function waNewContactsLast24h(ctx: TickContext, storeId: string): Promise<number> {
  ctx.waNewContactCount ??= new Map();
  if (!ctx.waNewContactCount.has(storeId)) {
    const first = nextStepAfter(ctx, storeId, "whatsapp", 0);
    let n = 0;
    if (first) {
      const { count, error } = await ctx.admin
        .from("recovery_events")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId)
        .eq("channel", "whatsapp")
        .in("type", ["sent", "queued"])
        .eq("is_test", false)
        .eq("step", first.position)
        .gte("created_at", new Date(ctx.now.getTime() - 24 * 3600_000).toISOString());
      n = error ? Number.MAX_SAFE_INTEGER : count ?? 0;
    }
    ctx.waNewContactCount.set(storeId, n);
  }
  return ctx.waNewContactCount.get(storeId) as number;
}

// Última mensagem AUTOMÁTICA da loja no canal (trava gravada ou enviada):
// régua do WhatsApp (passo preenchido) e retomadas do agente; e-mails de
// carrinho e de boas-vindas. `excludeId` = a própria trava (conferência de
// concorrência depois de gravar). Erro de banco = "acabou de sair uma"
// (espera o intervalo: falha fechado).
export async function lastAutomaticSends(admin: SupabaseClient, storeId: string, channel: StepChannel, isTest: boolean, sinceIso: string | null, limit = 1): Promise<Array<{ id: string; created_at: string }> | null> {
  let q = admin
    .from("recovery_events")
    .select("id, created_at")
    .eq("store_id", storeId)
    .eq("channel", channel)
    .eq("is_test", isTest)
    .in("type", ["queued", "sent"]);
  q = channel === "whatsapp" ? q.or("step.not.is.null,dedupe_key.like.wa-nudge*,dedupe_key.like.wa-retry*") : q.not("step", "is", null);
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    console.error("trava anti-rajada:", error.message);
    return null;
  }
  return (data ?? []) as Array<{ id: string; created_at: string }>;
}
const paceKey = (storeId: string, channel: StepChannel, isTest: boolean) => `${storeId}:${channel}:${isTest ? "t" : "p"}`;
// Instante (ms) a partir do qual a loja pode soltar a próxima mensagem
// automática no canal. Uma consulta por loja e canal por tick.
export async function paceFreeAt(ctx: Pick<TickContext, "admin" | "paceLast">, storeId: string, channel: StepChannel, isTest: boolean): Promise<number> {
  ctx.paceLast ??= new Map();
  const key = paceKey(storeId, channel, isTest);
  if (!ctx.paceLast.has(key)) {
    const rows = await lastAutomaticSends(ctx.admin, storeId, channel, isTest, null);
    ctx.paceLast.set(key, rows === null ? Date.now() : rows[0] ? new Date(rows[0].created_at).getTime() : 0);
  }
  return (ctx.paceLast.get(key) as number) + PACE_GAP_SEC[channel] * 1000;
}
export function markPace(ctx: Pick<TickContext, "paceLast">, storeId: string, channel: StepChannel, isTest: boolean, at = Date.now()): void {
  ctx.paceLast ??= new Map();
  ctx.paceLast.set(paceKey(storeId, channel, isTest), at);
}
// Conferência DEPOIS de gravar a trava (dois ticks ao mesmo tempo): se outra
// mensagem automática da loja no canal foi travada antes da nossa dentro do
// intervalo, a nossa desiste (trava liberada, nada sai) e espera a vez.
// Empate no mesmo instante: o menor id segue. Erro de banco = desiste.
export async function paceConflict(admin: SupabaseClient, input: { claimId: string; claimAt: string | null; storeId: string; channel: StepChannel; isTest: boolean }): Promise<boolean> {
  const mine = input.claimAt ? new Date(input.claimAt).getTime() : Date.now();
  const since = new Date(mine - PACE_GAP_SEC[input.channel] * 1000).toISOString();
  const rows = await lastAutomaticSends(admin, input.storeId, input.channel, input.isTest, since, 20);
  if (rows === null) return true;
  return rows.some((r) => {
    if (r.id === input.claimId) return false;
    const t = new Date(r.created_at).getTime();
    return t < mine || (t === mine && r.id < input.claimId);
  });
}
// Libera a trava de uma mensagem que desistiu antes de sair (nada saiu):
// trava anti-rajada ou, na resposta atrasada, modelo ainda indisponível.
export async function releasePacedClaim(admin: SupabaseClient, id: string, reason = "ritmo_anti_rajada"): Promise<void> {
  const { error } = await admin.from("recovery_events").update({ type: "skipped", dedupe_key: null, detail: { reason } }).eq("id", id).eq("type", "queued");
  if (error) console.error("recovery_events releasePaced:", error.message);
}

export function bumpDaily(ctx: TickContext, storeId: string, channel: StepChannel, isTest: boolean): void {
  const dk = dailyKey(storeId, channel, isTest);
  ctx.dailySent.set(dk, (ctx.dailySent.get(dk) ?? 0) + 1);
}

// Teto diário efetivo de e-mail REAL da loja: o de aquecimento (rampa desde
// production_since, congelada se bounce/reclamação subiram), limitado ao
// daily_cap_email configurado.
export function effectiveEmailCap(ctx: Pick<TickContext, "health">, settings: RecoverySettings): number {
  const h = ctx.health.get(settings.store_id);
  const cap = warmupCap(settings, h ? { bounceRate: h.bounceRate, complaintRate: h.complaintRate } : undefined);
  return Number.isFinite(cap) ? Math.max(0, Math.min(settings.daily_cap_email, cap)) : 0;
}

// Quantos e-mails reais já podem ter saído hoje a esta hora: o teto
// distribuído em linha reta na janela permitida (quiet_hours, padrão 9h-21h)
// do fuso do cliente, mais uma folga de PACING_BURST para não travar o
// primeiro e-mail do carrinho recém-abandonado.
export const PACING_BURST = 3;
export function pacedAllowance(cap: number, now: Date, countryCode: string | null | undefined, quiet: RecoverySettings["quiet_hours"], language?: string | null): number {
  const start = Number.isFinite(Number(quiet?.start)) ? Number(quiet?.start) : 9;
  const end = Number.isFinite(Number(quiet?.end)) ? Number(quiet?.end) : 21;
  if (!(end > start) || cap <= 0) return cap;
  const p = localParts(now, quiet?.tz || tzForCountry(countryCode, language));
  const minutes = p.hour * 60 + p.minute - start * 60;
  const frac = Math.min(1, Math.max(0, minutes / ((end - start) * 60)));
  return Math.min(cap, Math.ceil(cap * frac) + PACING_BURST);
}

// Próximo passo agendado (ou null quando a régua do canal acabou).
function nextAtAfter(ctx: TickContext, rec: RecoveryRow, channel: StepChannel, position: number, settings: RecoverySettings | undefined): string | null {
  const next = nextStepAfter(ctx, rec.store_id, channel, position);
  if (!next) return null;
  return nextAllowedTime(new Date(ctx.now.getTime() + Math.max(0, next.delay_minutes) * MIN), rec.country_code, quietFor(settings, channel, rec, ctx.now), rec.language).toISOString();
}

async function advance(ctx: TickContext, rec: RecoveryRow, channel: StepChannel, step: RecoveryStep, settings: RecoverySettings, sent: { code: string | null; percent: number | null; session?: WhatsappSessionRow | null } | null): Promise<void> {
  const patch: Partial<RecoveryRow> = {
    [stepField(channel)]: step.position,
    [nextField(channel)]: nextAtAfter(ctx, rec, channel, step.position, settings),
    last_event_at: ctx.nowIso,
  };
  if (sent) {
    patch.first_contact_at = rec.first_contact_at ?? ctx.nowIso;
    patch.last_outbound_at = ctx.nowIso;
    if (sent.code && sent.percent) {
      patch.offered_discount_code = sent.code;
      patch.offered_discount_percent = sent.percent;
    }
    if (sent.session) patch.waha_session = sent.session.name;
  }
  await patchRec(ctx.admin, rec, patch);
}

// 3) Agendamento inicial: 1º passo de cada canal pra quem ainda não tem data.

// Corte de lançamento (proteção contra "estourar o atraso"): em PRODUÇÃO só
// entram carrinhos abandonados DEPOIS de production_since (o momento em que o
// modo de teste foi desligado). Sem isso, ao ligar, todo carrinho dos últimos
// 10 dias estaria "atrasado" e receberia o 1º passo de uma vez. Sem
// production_since em produção = ninguém entra (falha fechado). Em modo de
// teste só entram carrinhos das últimas 24 h (a régua de teste vai pro dono).
function launchCutoff(settings: RecoverySettings | undefined, now: Date): number | null {
  if (!settings) return null;
  if (settings.test_mode) return now.getTime() - 24 * 3600e3;
  if (!settings.production_since) return null;
  return new Date(settings.production_since).getTime();
}
// WhatsApp em produção não usa o production_since do e-mail: vale a janela
// do 1º contato (WA_FIRST_CONTACT_MAX_HOURS). O gate (production_since
// gravado = loja lançada) continua valendo para os dois canais.
function cutoffFor(settings: RecoverySettings | undefined, now: Date, channel: StepChannel): number | null {
  const cut = launchCutoff(settings, now);
  if (cut === null || channel !== "whatsapp" || settings?.test_mode) return cut;
  return now.getTime() - WA_FIRST_CONTACT_MAX_HOURS * HOUR;
}
const eligibleByCutoff = (rec: Pick<RecoveryRow, "abandoned_at">, settings: RecoverySettings | undefined, now: Date, channel: StepChannel) => {
  const cut = cutoffFor(settings, now, channel);
  return cut !== null && new Date(rec.abandoned_at).getTime() >= cut;
};

// Idiomas liberados da loja (send_languages, migration 0021). Lista vazia ou
// ausente = todos. Compara pelas 2 primeiras letras (he, he-IL).
export function languageAllowed(settings: Pick<RecoverySettings, "send_languages"> | undefined | null, language: string | null | undefined): boolean {
  const list = (settings?.send_languages ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(String(language ?? "").trim().toLowerCase().slice(0, 2));
}

async function scheduleInitial(ctx: TickContext): Promise<void> {
  for (const channel of ["email", "whatsapp"] as StepChannel[]) {
    if (overDeadline(ctx)) return;
    const contact = channel === "email" ? "email" : "phone";
    // Só lojas com passo habilitado no canal E com corte de lançamento válido:
    // sem isso o limit(300) seria ocupado por carrinhos que nunca agendam
    // (loja sem passos, produção sem production_since) e travaria os
    // carrinhos de verdade. Uma consulta por loja, com o corte e os idiomas
    // liberados DELA: carrinho de mercado não liberado (ex.: Bulgária numa
    // loja lançada só em hebraico) nunca ocupa a fila.
    const storeIds = [...new Set(ctx.steps.filter((x) => x.channel === channel && x.enabled && (x.flow ?? "carrinho") === "carrinho").map((x) => x.store_id))].filter((id) => (!ctx.onlyStoreId || id === ctx.onlyStoreId) && launchCutoff(ctx.settings.get(id), ctx.now) !== null);
    const rows: RecoveryRow[] = [];
    for (const storeId of storeIds) {
      if (overDeadline(ctx)) return;
      const st = ctx.settings.get(storeId);
      const langs = (st?.send_languages ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
      // WhatsApp: o 1º contato só nas WA_FIRST_CONTACT_MAX_HOURS depois do
      // abandono, então nem agenda carrinho mais velho que isso.
      const cutMs = cutoffFor(st, ctx.now, channel) as number;
      let q = ctx.admin
        .from("cart_recoveries")
        .select("*")
        .eq("store_id", storeId)
        .eq("status", "ativo")
        .eq(stepField(channel), 0)
        .is(nextField(channel), null)
        .is("last_inbound_at", null) // já conversando no WhatsApp: o agente cuida, nada agendado
        .not(contact, "is", null)
        .gte("abandoned_at", new Date(cutMs).toISOString()) // anterior ao corte (ou, no WhatsApp, à janela de 24 h) nunca agenda
        .order("abandoned_at", { ascending: false })
        .limit(300);
      if (langs.length > 0) q = q.in("language", langs);
      // Número já checado e sem WhatsApp (whatsapp_exists = false) não volta a ser
      // agendado a cada tick; null (nunca checado) e true entram.
      if (channel === "whatsapp") q = q.or("whatsapp_exists.is.null,whatsapp_exists.eq.true");
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as RecoveryRow[]));
    }
    for (const rec of rows) {
      if (HOLD_LEGACY_COUPON_CARTS && hasLegacyCoupon(rec.discount_codes)) continue; // cupom antigo: espera a decisão do dono (links.ts)
      const first = nextStepAfter(ctx, rec.store_id, channel, 0); // primeiro habilitado (passo 1 desligado não trava a régua)
      if (!first) continue; // loja sem passos no canal: fica null
      const settings = ctx.settings.get(rec.store_id);
      if (!eligibleByCutoff(rec, settings, ctx.now, channel)) continue; // anterior ao lançamento: nunca agenda
      if (!languageAllowed(settings, rec.language)) continue; // idioma não liberado na loja
      if (channel === "whatsapp" && !waFirstContactAllowed(rec.abandoned_at, ctx.now)) continue; // fora da janela do 1º contato
      const at = nextAllowedTime(new Date(new Date(rec.abandoned_at).getTime() + Math.max(0, first.delay_minutes) * MIN), rec.country_code, quietFor(settings, channel, rec, ctx.now), rec.language);
      try {
        await patchRec(ctx.admin, rec, { [nextField(channel)]: at.toISOString() });
        ctx.result.scheduled += 1;
        ctx.touchedStores.add(rec.store_id);
      } catch (err) {
        ctx.result.errors.push(`agendar ${rec.checkout_name ?? rec.id} ${channel}: ${errMsg(err)}`);
      }
    }
  }
}

// 4) Um recovery vencido num canal.
async function processOne(ctx: TickContext, rec: RecoveryRow, channel: StepChannel): Promise<void> {
  const { admin, now, nowIso } = ctx;
  const nf = nextField(channel);
  const inMin = (m: number) => new Date(now.getTime() + m * MIN).toISOString();
  const target: EventTarget = { store_id: rec.store_id, recovery_id: rec.id };
  ctx.touchedStores.add(rec.store_id);

  // Cupom antigo dos anúncios: o link de recuperação abre no preço errado, então
  // o carrinho espera a decisão do dono (links.ts). Só empurra a data (sem
  // evento, sem consumir o passo): ao liberar, volta sozinho.
  if (HOLD_LEGACY_COUPON_CARTS && hasLegacyCoupon(rec.discount_codes)) {
    await patchRec(admin, rec, { [nf]: inMin(360) });
    return;
  }

  // Cliente respondeu no WhatsApp: a régua agendada para, o agente conversa.
  if (channel === "whatsapp" && rec.last_inbound_at) {
    await patchRec(admin, rec, { wa_next_at: null, last_event_at: nowIso });
    await logEvent(admin, target, { channel, step: rec.wa_step + 1, type: "skipped", reason: "cliente_respondeu" });
    ctx.result.skippedCount += 1;
    return;
  }

  const step = nextStepAfter(ctx, rec.store_id, channel, rec[stepField(channel)]);
  if (!step) {
    await patchRec(admin, rec, { [nf]: null });
    return;
  }
  const position = step.position;
  const settings = ctx.settings.get(rec.store_id);
  // WhatsApp, 1º contato fora da janela (abandono há mais de 24 h): o canal
  // não abre conversa com esse carrinho (desagenda e registra uma vez).
  if (channel === "whatsapp" && (rec.wa_step ?? 0) === 0 && !waFirstContactAllowed(rec.abandoned_at, now)) {
    await patchRec(admin, rec, { wa_next_at: null, last_event_at: nowIso });
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "whatsapp_fora_da_janela", detail: { abandonedAt: rec.abandoned_at, maxHours: WA_FIRST_CONTACT_MAX_HOURS }, isTest: settings?.test_mode ?? false });
    ctx.result.skippedCount += 1;
    return;
  }
  // Gate desligado: não consome o passo e NÃO mexe no next_at. Empurrar a
  // data a cada tick zerava o atraso e, ao religar o canal, todo o backlog
  // saía de uma vez; parado, o passo envelhece e isTooLate trata na volta.
  // (processDue já pula as lojas com o canal desligado; isto é só defesa.)
  if (!settings || !canSend(settings, channel)) return;
  // Carrinho agendado antes do lançamento (ex.: durante o teste) nunca sai pro cliente real.
  if (!settings.test_mode && !eligibleByCutoff(rec, settings, now, channel)) {
    await patchRec(admin, rec, { [nf]: null });
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "anterior_ao_lancamento" });
    ctx.result.skippedCount += 1;
    return;
  }
  // Idioma não liberado na loja (send_languages): desagenda o canal. Vale em
  // teste e em produção (carrinho agendado durante o teste não vaza).
  if (!languageAllowed(settings, rec.language)) {
    await patchRec(admin, rec, { [nf]: null });
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "idioma_nao_liberado", detail: { language: rec.language, liberados: settings.send_languages ?? [] }, isTest: settings.test_mode });
    ctx.result.skippedCount += 1;
    return;
  }
  // Atraso máximo: passo vencido há mais de 12 h não sai (reabilitar um canal
  // parado não despeja backlog). Reagenda a partir de agora, mesmo passo.
  if (isTooLate(rec[nf], now)) {
    const at = await rescheduleLateStep(admin, { target, channel, position, delayMinutes: step.delay_minutes, countryCode: rec.country_code, language: rec.language, quiet: quietFor(settings, channel, rec, now), dueAt: rec[nf] as string, now, isTest: settings.test_mode });
    await patchRec(admin, rec, { [nf]: at, last_event_at: nowIso });
    ctx.result.skippedCount += 1;
    return;
  }
  // Horário silencioso / shabbat no fuso do cliente (WhatsApp de carrinho
  // recém-abandonado não tem: ver quietFor).
  const quiet = quietFor(settings, channel, rec, now);
  if (!isAllowedNow(now, rec.country_code, quiet, rec.language)) {
    await patchRec(admin, rec, { [nf]: nextAllowedTime(now, rec.country_code, quiet, rec.language).toISOString() });
    return;
  }
  // Teto diário da loja: envios reais contam no daily_cap_* (e-mail: teto de
  // aquecimento); envios de teste têm teto próprio (TEST_DAILY_CAP) e limite
  // por tick (TEST_MAX_PER_TICK), porque em teste o passo do carrinho real
  // avança (ver cabeçalho).
  const testKey = `${rec.store_id}:${channel}`;
  if (settings.test_mode) {
    if ((ctx.testThisTick.get(testKey) ?? 0) >= TEST_MAX_PER_TICK) {
      // Cota do tick esgotada: empurra 10 min (sem consumir o passo, sem
      // evento) pra não travar a fila das outras lojas.
      await patchRec(admin, rec, { [nf]: inMin(10) });
      return;
    }
    if ((await dailyCount(ctx, rec.store_id, channel, true)) >= TEST_DAILY_CAP) {
      await patchRec(admin, rec, { [nf]: inMin(60) });
      return;
    }
  } else {
    const cap = channel === "email" ? effectiveEmailCap(ctx, settings) : settings.daily_cap_whatsapp;
    const sentToday = await dailyCount(ctx, rec.store_id, channel, false);
    if (sentToday >= cap) {
      await patchRec(admin, rec, { [nf]: inMin(60) });
      return;
    }
    // E-mail espalhado ao longo do dia (pedido do Ian, 09/10): o teto do dia
    // é liberado aos poucos dentro da janela de envio no fuso do cliente, em
    // vez de sair tudo às 9h. Adia 10 min sem consumir o passo.
    if (channel === "email" && sentToday >= pacedAllowance(cap, now, rec.country_code, settings.quiet_hours, rec.language)) {
      await patchRec(admin, rec, { [nf]: inMin(10) });
      return;
    }
  }
  // Trava anti-rajada e ritmo de conversas novas (antes das consultas à
  // Shopify: quem só está esperando a vez não gasta consulta). Adia sem
  // consumir o passo e sem evento. `firstContact` é lido AGORA: depois do
  // envio, advance() já mudou rec.wa_step (era esse o erro que soltou 6
  // primeiros contatos juntos às 9h12 de 10/10).
  // Carrinho que acabou de cair (WA_FRESH_HOURS) não espera os 10 min do
  // lote de antigos ("teve carrinho abandonado já chama"), só a trava
  // anti-rajada; o envio dele conta como conversa nova para o lote.
  const firstContact = channel === "whatsapp" && (rec.wa_step ?? 0) === 0;
  {
    const freeAt = Math.max(await paceFreeAt(ctx, rec.store_id, channel, settings.test_mode), firstContact && !isFreshCart(rec, now) ? await waNewContactFreeAt(ctx, rec.store_id, settings.test_mode) : 0);
    if (freeAt > Date.now()) {
      await patchRec(admin, rec, { [nf]: new Date(freeAt + Math.floor(Math.random() * 20_000)).toISOString() });
      return;
    }
  }
  // Teto diário de contatos novos, só se WA_NEW_CONTACTS_PER_DAY estiver definido
  // (ver waNewContactDailyCap). Sem evento: só adia o carrinho em 1 h, sem consumir o passo.
  const newContactCap = firstContact && !settings.test_mode ? waNewContactDailyCap(now) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(newContactCap) && (await waNewContactsLast24h(ctx, rec.store_id)) >= newContactCap) {
    await patchRec(admin, rec, { [nf]: inMin(60) });
    return;
  }
  // As 9 regras de parada, consultando a Shopify ao vivo.
  const check = await checkStopRules(admin, rec, { channel, withDiscount: Boolean(pct(step.discount_percent)), requireConsent: settings.require_consent, maxDays: settings.max_days, creds: ctx.creds, now });
  if (!check.ok) {
    if (check.terminal) {
      await applyStop(admin, rec, check);
      ctx.result.stopped += 1;
      return;
    }
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: check.reason, detail: check.detail });
    // sem_contato e cliente_respondeu (WhatsApp: o agente cuida) param o
    // canal; o resto tenta de novo em 6h.
    const pause = check.reason === "sem_contato" || check.reason === "cliente_respondeu";
    await patchRec(admin, rec, { [nf]: pause ? null : inMin(6 * 60), last_event_at: nowIso });
    ctx.result.skippedCount += 1;
    return;
  }
  // Passos do meio só para quem se engajou (pedido do Ian, 09/10): no
  // Klaviyo, do dia 5 ao dia 9 a régua não vendeu nada e gerou descadastro.
  // Sem abertura nem clique em e-mail anterior deste carrinho, o passo é
  // pulado (registrado) e a régua segue para o próximo.
  if (channel === "email" && !settings.test_mode && ENGAGED_ONLY_EMAIL_STEPS.has(position)) {
    const { data: eng, error: engErr } = await admin.from("recovery_events").select("id").eq("recovery_id", rec.id).in("type", ["opened", "clicked"]).eq("is_test", false).limit(1);
    if (!engErr && (eng ?? []).length === 0) {
      await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "sem_engajamento" });
      await advance(ctx, rec, channel, step, settings, null);
      ctx.result.skippedCount += 1;
      return;
    }
  }
  if (channel === "email" && !settings.from_email?.trim()) {
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "sem_remetente" });
    await patchRec(admin, rec, { [nf]: inMin(6 * 60), last_event_at: nowIso });
    ctx.result.skippedCount += 1;
    return;
  }
  // DNS do remetente (SPF, DKIM, DMARC): em produção, sem isso nada sai; em
  // teste só avisa no log.
  if (channel === "email") {
    const dns = await senderDns(ctx, settings.from_email as string);
    if (!dns.ok) {
      if (!settings.test_mode) {
        await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "dns_nao_verificado", detail: { domain: dns.domain, problems: dns.problems } });
        await patchRec(admin, rec, { [nf]: inMin(6 * 60), last_event_at: nowIso });
        ctx.result.skippedCount += 1;
        return;
      }
      console.warn(`recovery: DNS do remetente ${settings.from_email} sem verificação (${dns.problems.join("; ")}); em teste segue.`);
    }
  }
  const to = destinationFor(settings, channel, rec);
  if (!to) {
    await patchRec(admin, rec, { [nf]: inMin(30) });
    return;
  }
  // Endereço do cliente com erro de digitação ou domínio sem MX: em produção
  // o canal de e-mail para aqui (evita bounce permanente, que derruba a conta
  // do Resend acima de 4%). Em teste o destino é o test_email: só registra.
  if (channel === "email") {
    const problem = await emailAddressProblem(rec.email);
    if (problem && !settings.test_mode) {
      await patchRec(admin, rec, { email_next_at: null, last_event_at: nowIso });
      await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "email_invalido", detail: { problem } });
      ctx.result.skippedCount += 1;
      return;
    }
    // Verificação na caixa (QuickEmailVerification), só antes do 1º e-mail do
    // carrinho: inválido ou descartável vira supressão permanente.
    if (!settings.test_mode && (rec.email_step ?? 0) === 0 && rec.email) {
      const verdict = await verifyEmailAddress(rec.email);
      if (verdict?.block) {
        const sup = await admin.from("recovery_suppressions").upsert({ store_id: null, channel: "email", address: rec.email.trim().toLowerCase(), reason: "bounced", source: "qev" }, { onConflict: "channel,address", ignoreDuplicates: true });
        if (sup.error) console.error("supressão qev:", sup.error.message);
        await patchRec(admin, rec, { email_next_at: null, last_event_at: nowIso });
        await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "email_invalido", detail: { verificador: "qev", result: verdict.result, reason: verdict.reason, did_you_mean: verdict.didYouMean } });
        ctx.result.skippedCount += 1;
        return;
      }
    }
  }
  // Intervalo mínimo entre e-mails de marketing pro mesmo endereço (qualquer
  // loja, qualquer fluxo): adia sem consumir o passo, 1 evento por dia.
  if (channel === "email") {
    const gap = await minGapBlock(admin, to, settings, now, { target, delayMinutes: step.delay_minutes });
    if (gap.blocked) {
      if (!(await skippedToday(admin, target, "intervalo_minimo", now))) {
        await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "intervalo_minimo", detail: { lastAt: gap.lastAt, until: gap.until.toISOString() } });
      }
      await patchRec(admin, rec, { [nf]: nextAllowedTime(gap.until, rec.country_code, settings.quiet_hours, rec.language).toISOString(), last_event_at: nowIso });
      ctx.result.skippedCount += 1;
      return;
    }
  }

  // WhatsApp: número da loja (rotação) e existência do número do cliente.
  let session: WhatsappSessionRow | null = null;
  let chatId = "";
  if (channel === "whatsapp") {
    const picked = await pickSessionDetailed(admin, rec.store_id, rec);
    if (!picked.session) {
      // "aguardar": o número fixo do cliente está WORKING mas no teto ou
      // restrito; não troca de número, espera 60 min. "sem_sessao": nenhum
      // número da loja serve agora, tenta em 30 min.
      const wait = picked.reason === "aguardar";
      await logEvent(admin, target, { channel, step: position, type: "skipped", reason: wait ? "aguardar_numero" : "sem_sessao", detail: wait ? { session: rec.waha_session } : undefined });
      await patchRec(admin, rec, { wa_next_at: inMin(wait ? 60 : 30), last_event_at: nowIso });
      ctx.result.skippedCount += 1;
      return;
    }
    session = picked.session;
    chatId = chatIdFromPhone(to);
    if (!settings.test_mode) {
      if (rec.whatsapp_checked_at == null) {
        try {
          const r = await checkNumber(session.name, to);
          await patchRec(admin, rec, { whatsapp_exists: r.exists, whatsapp_checked_at: nowIso });
          if (r.chatId) chatId = r.chatId;
        } catch (err) {
          if (err instanceof WahaError && err.isRestriction) await restrictSession(admin, session.name, 24, err.message);
          await logEvent(admin, target, { channel, step: position, type: "failed", reason: "check_number", detail: errMsg(err) });
          await patchRec(admin, rec, { wa_next_at: inMin(30), last_event_at: nowIso });
          ctx.result.errors.push(`${rec.checkout_name ?? rec.id} whatsapp: ${errMsg(err)}`);
          return;
        }
      }
      if (rec.whatsapp_exists === false) {
        await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "sem_whatsapp" });
        // stop_reason 'sem_whatsapp' no carrinho (o e-mail segue; o canal não volta a ser agendado).
        await patchRec(admin, rec, { wa_next_at: null, stop_reason: "sem_whatsapp", last_event_at: nowIso });
        ctx.result.skippedCount += 1;
        return;
      }
    }
  }

  // Texto, cupom, link, HTML.
  const prepared = prepareStep({ rec, step, settings, channel, discounts: ctx.discounts, products: await productsFor(ctx, rec.store_id), storeName: ctx.storeNames.get(rec.store_id) ?? null, isTest: settings.test_mode });
  if ("error" in prepared) {
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: prepared.error, detail: prepared.detail, isTest: settings.test_mode });
    ctx.result.skippedCount += 1;
    if (prepared.error === "sem_idioma") {
      // Sem texto no idioma do cliente nem em inglês: o passo não existe pra
      // essa pessoa. Avança pra não travar a régua (spec v2 §1.2).
      await advance(ctx, rec, channel, step, settings, null);
      return;
    }
    await patchRec(admin, rec, { [nf]: inMin(6 * 60), last_event_at: nowIso });
    return;
  }
  if (prepared.noCoupon) {
    // Passo com desconto e sem cupom cadastrado com esse percentual: o texto
    // sairia prometendo "{{desconto}} com o cupom {{cupom}}" vazios. NÃO
    // envia: registra sem_cupom e avança o passo (decisão do Ian, 09/10).
    await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "sem_cupom", detail: { percent: prepared.noCoupon.percent }, isTest: settings.test_mode });
    await advance(ctx, rec, channel, step, settings, null);
    ctx.result.skippedCount += 1;
    return;
  }

  // TRAVA antes de enviar.
  const dedupeKey = dedupeKeyFor(rec, channel, position, settings.test_mode, now);
  const claim = await claimEvent(admin, { target, channel, position, dedupeKey, code: prepared.code, to, language: prepared.lang, isTest: settings.test_mode });
  if (!claim.ok) {
    if (claim.reason === "duplicate") {
      // Já saiu antes (outro tick, outra instância): avança sem enviar.
      await advance(ctx, rec, channel, step, settings, null);
      return;
    }
    ctx.result.errors.push(`${rec.checkout_name ?? rec.id} ${channel}: trava não gravada: ${claim.message}`);
    await patchRec(admin, rec, { [nf]: inMin(30) });
    return;
  }
  // Outra mensagem automática da loja no canal travada antes da nossa (outro
  // tick ao mesmo tempo): a nossa desiste e espera a vez.
  if (await paceConflict(admin, { claimId: claim.id, claimAt: claim.createdAt, storeId: rec.store_id, channel, isTest: settings.test_mode })) {
    await releasePacedClaim(admin, claim.id);
    markPace(ctx, rec.store_id, channel, settings.test_mode);
    await patchRec(admin, rec, { [nf]: new Date(Date.now() + PACE_GAP_SEC[channel] * 1000 + Math.floor(Math.random() * 20_000)).toISOString() });
    return;
  }

  let outcome: SendOutcome;
  try {
    outcome = channel === "email"
      ? await deliverEmail({ settings, prepared, to, dedupeKey, isTest: settings.test_mode, tags: { recovery_id: rec.id, step: String(position), channel: "email", store_id: rec.store_id, flow: "carrinho" } })
      : await deliverWhatsapp(admin, { session: session as WhatsappSessionRow, chatId, to, prepared, rec, position, isTest: settings.test_mode });
  } catch (err) {
    outcome = { ok: false, error: errMsg(err) };
  }
  // Qualquer tentativa conta para a trava anti-rajada (falha ambígua pode ter saído).
  markPace(ctx, rec.store_id, channel, settings.test_mode);

  if (!outcome.ok && outcome.ambiguous) {
    // Falha ambígua: a mensagem pode ter saído. Mantém a trava, não retenta,
    // avança o passo e abre alerta (nunca reenviar pro mesmo cliente).
    await registerAmbiguousSend(admin, { claimId: claim.id, storeId: rec.store_id, channel, position, label: rec.checkout_name ?? rec.id, error: outcome.error });
    ctx.result.errors.push(`${rec.checkout_name ?? rec.id} ${channel} passo ${position}: envio ambíguo (não retentado): ${outcome.error}`);
    await advance(ctx, rec, channel, step, settings, null);
    return;
  }
  if (!outcome.ok && outcome.quota) {
    // Cota/limite do provedor: libera a trava SEM contar tentativa, não
    // avança, adia 60 min e segura os outros e-mails da loja neste tick (e,
    // via quotaBlockedStores, nos ticks dos próximos 60 min).
    await markEventQuota(admin, claim.id, outcome.error);
    (ctx.emailQuotaBlocked ??= new Set()).add(rec.store_id);
    ctx.result.errors.push(`${rec.checkout_name ?? rec.id} ${channel} passo ${position}: cota do provedor (adiado ${EMAIL_QUOTA_BACKOFF_MIN} min, sem contar tentativa): ${outcome.error}`);
    await patchRec(admin, rec, { [nf]: inMin(EMAIL_QUOTA_BACKOFF_MIN), last_event_at: nowIso });
    return;
  }
  if (!outcome.ok) {
    await markEventFailed(admin, claim.id, outcome.error);
    if (outcome.restriction && session) await restrictSession(admin, session.name, 24, outcome.error);
    ctx.result.errors.push(`${rec.checkout_name ?? rec.id} ${channel} passo ${position}: ${outcome.error}`);
    const failures = await countFailed(admin, target, channel, position);
    if (failures >= 3) {
      // Três falhas no mesmo passo: pula o passo (registrado) e segue a régua.
      await logEvent(admin, target, { channel, step: position, type: "skipped", reason: "max_tentativas", detail: outcome.error });
      await advance(ctx, rec, channel, step, settings, null);
    } else {
      await patchRec(admin, rec, { [nf]: inMin(30), last_event_at: nowIso });
    }
    return;
  }

  await markEventSent(admin, claim.id, { messageId: outcome.messageId, provider: outcome.provider });
  await advance(ctx, rec, channel, step, settings, { code: prepared.code, percent: prepared.percent, session });
  ctx.result.sent[channel] += 1;
  bumpDaily(ctx, rec.store_id, channel, settings.test_mode);
  if (firstContact) markWaNewContact(ctx, rec.store_id, settings.test_mode);
  if (settings.test_mode) ctx.testThisTick.set(testKey, (ctx.testThisTick.get(testKey) ?? 0) + 1);
}

async function processDue(ctx: TickContext, channel: StepChannel): Promise<void> {
  // Só lojas com o canal LIGADO (gate) e, no e-mail, sem recusa por cota do
  // provedor nos últimos 60 min. Com o gate desligado processOne não mexe no
  // next_at (ver cabeçalho): sem este filtro os mesmos 50 vencidos voltariam
  // a cada tick e travariam a fila das outras lojas.
  const quotaBlocked = channel === "email" ? await quotaBlockedStores(ctx) : new Set<string>();
  const storeIds = dueStoreIds(ctx, channel, quotaBlocked);
  if (storeIds.length === 0) return;
  let q = ctx.admin
    .from("cart_recoveries")
    .select("*")
    .eq("status", "ativo")
    .lte(nextField(channel), ctx.nowIso)
    .neq("agent_mode", "pausado") // pausado à mão: não mexe
    // Prioridade quando o teto do dia aperta: passos iniciais primeiro (no
    // histórico do Klaviyo os 3 primeiros toques trazem ~95% da receita) e,
    // no mesmo passo, o carrinho mais recente (o mais quente).
    .order(stepField(channel), { ascending: true })
    .order("abandoned_at", { ascending: false })
    .limit(50);
  q = q.in("store_id", storeIds);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  for (const rec of (data ?? []) as RecoveryRow[]) {
    if (overDeadline(ctx)) {
      ctx.result.partial = true;
      return;
    }
    // Cota do provedor estourou neste tick pra essa loja: o resto espera
    // (sem mexer no next_at; o próximo tick nem lê essa loja por 60 min).
    if (channel === "email" && ctx.emailQuotaBlocked?.has(rec.store_id)) continue;
    try {
      await processOne(ctx, rec, channel);
    } catch (err) {
      ctx.result.errors.push(`${rec.checkout_name ?? rec.id} ${channel}: ${errMsg(err)}`);
      console.error("recovery tick:", channel, rec.id, err);
    }
  }
}

// Lojas cujos vencidos do canal podem ser processados neste tick: gate ligado
// (canSend), fora das bloqueadas por cota e dentro de onlyStoreId.
export function dueStoreIds(ctx: Pick<TickContext, "settings" | "onlyStoreId">, channel: StepChannel, blocked: Set<string> = new Set()): string[] {
  return [...ctx.settings.values()].filter((s) => canSend(s, channel) && !blocked.has(s.store_id) && (!ctx.onlyStoreId || s.store_id === ctx.onlyStoreId)).map((s) => s.store_id);
}

// --- Saúde do e-mail (spec v2 §6) ------------------------------------------------

// Lojas com envio REAL de e-mail nas últimas 24h → evaluateEmailHealth. Com
// action = 'pausar': desliga recovery_settings.email_enabled, grava alerta
// kind='envio' (um aberto por loja) e manda o e-mail de alerta. Nunca lança.
async function checkEmailHealth(ctx: TickContext): Promise<void> {
  const { admin } = ctx;
  const since = new Date(ctx.now.getTime() - 24 * HOUR).toISOString();
  let q = admin.from("recovery_events").select("store_id").eq("type", "sent").eq("channel", "email").eq("is_test", false).gte("created_at", since).limit(2000);
  if (ctx.onlyStoreId) q = q.eq("store_id", ctx.onlyStoreId);
  const { data, error } = await q;
  if (error) {
    ctx.result.errors.push(`saúde do e-mail: ${error.message}`);
    return;
  }
  const storeIds = [...new Set((data ?? []).map((r) => String(r.store_id)).filter(Boolean))];
  if (storeIds.length === 0) return;
  ctx.result.health = [];
  for (const storeId of storeIds) {
    if (overDeadline(ctx)) return;
    let health: EmailHealth;
    try {
      health = await evaluateEmailHealth(admin, storeId);
    } catch (err) {
      ctx.result.errors.push(`saúde do e-mail ${storeId}: ${errMsg(err)}`);
      continue;
    }
    ctx.health.set(storeId, health);
    ctx.result.health.push({ storeId, action: health.action, reason: health.reason, sent24h: health.sent24h });
    const settings = ctx.settings.get(storeId);
    if (!settings || health.action === "ok") continue;
    if (health.action === "alertar") {
      // Só alerta (sem pausar): alerta 'envio' próprio da loja + e-mail.
      await raiseSendingAlert(ctx, settings, health, "alertar");
      continue;
    }
    if (settings.email_enabled) {
      const { error: upErr } = await admin.from("recovery_settings").update({ email_enabled: false, updated_at: ctx.nowIso }).eq("store_id", storeId);
      if (upErr) {
        ctx.result.errors.push(`pausar e-mail ${storeId}: ${upErr.message}`);
        continue;
      }
      settings.email_enabled = false; // o resto do tick já vê o canal desligado
      ctx.result.pausedEmail = [...(ctx.result.pausedEmail ?? []), storeId];
    }
    await raiseSendingAlert(ctx, settings, health, "pausar");
  }
}

const ALERT_REOPEN_MS = 12 * HOUR;

// mode 'pausar': o canal foi desligado. mode 'alertar': só aviso (o canal
// segue), com chave própria pra um aviso aberto não esconder uma pausa.
async function raiseSendingAlert(ctx: TickContext, settings: RecoverySettings, health: EmailHealth, mode: "pausar" | "alertar"): Promise<void> {
  const { admin } = ctx;
  const storeName = ctx.storeNames.get(settings.store_id) ?? settings.store_id;
  const key = mode === "pausar" ? `saude:${settings.store_id}` : `saude_alerta:${settings.store_id}`;
  const fmt = (r: number | null) => (r == null ? "?" : `${(r * 100).toFixed(2)}%`);
  const numbers = `nas últimas 24 h, ${health.sent24h} enviados, ${health.bounced24h} bounces permanentes (${fmt(health.bounceRate)}) e ${health.complained24h} reclamações (${fmt(health.complaintRate)}).`;
  const message = (mode === "pausar"
    ? `E-mail da loja ${storeName} DESLIGADO automaticamente: ${numbers} ${health.reason ?? ""} Veja Recuperação de carrinho → Entregabilidade, corrija a lista/remetente e religue o canal na Configuração.`
    : `Atenção ao e-mail da loja ${storeName} (o canal continua ligado): ${numbers} ${health.reason ?? ""} Veja Recuperação de carrinho → Entregabilidade antes que chegue ao limite de pausa.`
  ).replace(/\s{2,}/g, " ").trim();
  try {
    // Um alerta aberto por loja: não repete enquanto o anterior não for resolvido.
    const { data: open, error: openErr } = await admin.from("recovery_alerts").select("id").eq("kind", "envio").eq("key", key).is("resolved_at", null).limit(1);
    if (openErr) throw new Error(openErr.message);
    if ((open ?? []).length > 0) return;
    // Resolvido à mão há menos de 12 h: não recria o alerta (o Ian já sabe e
    // está mexendo nisso; na pausa, o canal já foi desligado acima).
    const resolvedAt = await lastResolvedAlertAt(admin, "envio", key);
    if (resolvedAt && ctx.now.getTime() - resolvedAt.getTime() < ALERT_REOPEN_MS) return;
    const { error: insErr } = await admin.from("recovery_alerts").insert({ kind: "envio", key, message, store_id: settings.store_id });
    if (insErr) throw new Error(insErr.message);
    const to = process.env.ALERT_EMAIL || settings.test_email?.trim() || "dono@suaempresa.com";
    const subject = mode === "pausar" ? `[Respondo] E-mail da loja ${storeName} pausado por bounce/reclamação` : `[Respondo] Alerta de bounce/reclamação no e-mail da loja ${storeName}`;
    await sendAlertEmail(admin, { to, subject, text: message, settings: [settings] });
  } catch (err) {
    console.error("alerta de envio:", err);
    ctx.result.errors.push(`alerta de envio ${storeName}: ${errMsg(err)}`);
  }
}

export async function runRecoveryTick(admin: SupabaseClient, opts: { deadline?: number; onlyStoreId?: string | null } = {}): Promise<TickResult> {
  const started = Date.now();
  const result: TickResult = { synced: 0, scheduled: 0, sent: { email: 0, whatsapp: 0 }, skippedCount: 0, stopped: 0, errors: [], welcome: { created: 0, sent: 0, skipped: 0, stopped: 0 } };

  // 1) Sync barato (2h). Tabela ausente = migration não rodou = nada a fazer.
  try {
    const sync = await syncAbandonedCheckouts(admin, { hours: 2, deadline: opts.deadline, onlyStoreId: opts.onlyStoreId ?? null });
    if (sync.skipped === "migration_missing") return { ...result, skipped: "migration_missing", ms: Date.now() - started };
    result.synced = sync.stores.reduce((n, s) => n + s.upserted, 0);
    for (const s of sync.stores) if (s.error) result.errors.push(`sync ${s.storeName}: ${s.error}`);
  } catch (err) {
    if (RECOVERY_MISSING_TABLE.test(errMsg(err))) return { ...result, skipped: "migration_missing", ms: Date.now() - started };
    result.errors.push(`sync: ${errMsg(err)}`);
  }

  // 2) Configuração, régua (todos os fluxos), cupons, credenciais (uma vez por tick).
  const [{ data: settingsRows, error: settingsError }, { data: stepRows, error: stepsError }, { data: discountRows, error: discountsError }, { data: storeRows }] = await Promise.all([
    admin.from("recovery_settings").select("*"),
    admin.from("recovery_steps").select("*").eq("enabled", true).order("position"),
    admin.from("recovery_discounts").select("*").eq("active", true),
    admin.from("stores").select("id, name"),
  ]);
  const firstError = settingsError ?? stepsError ?? discountsError;
  if (firstError) {
    if (RECOVERY_MISSING_TABLE.test(firstError.message)) return { ...result, skipped: "migration_missing", ms: Date.now() - started };
    throw new Error(firstError.message);
  }
  let creds: StoreCred[] = [];
  try {
    creds = (await loadAllShopifyCreds(admin, null)).map((c) => ({ shopDomain: c.shopDomain, accessToken: c.accessToken ?? decrypt(c.accessTokenEncrypted ?? ""), storeId: c.storeId }));
  } catch (err) {
    result.errors.push(`credenciais Shopify: ${errMsg(err)}`);
  }
  // Falha FECHADO: sem nenhuma credencial Shopify (chave de criptografia
  // errada, banco fora) não dá pra confirmar compra em lugar nenhum. Os
  // vencidos ficam na fila pro próximo tick; só o agendamento inicial roda.
  // (Loja específica sem credencial: checkStopRules devolve
  // erro_na_verificacao por carrinho, também sem enviar.)
  const canProcessDue = creds.length > 0;
  if (!canProcessDue) result.errors.push("credenciais Shopify indisponíveis: nenhum vencido processado neste tick (falha fechado)");

  const now = new Date();
  const ctx: TickContext = {
    admin,
    now,
    nowIso: now.toISOString(),
    deadline: opts.deadline,
    onlyStoreId: opts.onlyStoreId ?? null,
    settings: new Map(((settingsRows ?? []) as RecoverySettings[]).map((s) => [s.store_id, s])),
    steps: (stepRows ?? []) as RecoveryStep[],
    discounts: (discountRows ?? []) as RecoveryDiscount[],
    creds,
    storeNames: new Map(((storeRows ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name])),
    products: new Map(),
    dailySent: new Map(),
    testThisTick: new Map(),
    health: new Map(),
    dns: new Map(),
    touchedStores: new Set(),
    result,
  };

  // 2b) Saúde do e-mail por loja (pausa automática por bounce/reclamação).
  try {
    await checkEmailHealth(ctx);
  } catch (err) {
    result.errors.push(`saúde do e-mail: ${errMsg(err)}`);
  }

  // 3) Agendamento inicial.
  try {
    await scheduleInitial(ctx);
  } catch (err) {
    result.errors.push(`agendamento: ${errMsg(err)}`);
  }

  // 4) Vencidos, canal por canal (só com credencial Shopify carregada).
  for (const channel of canProcessDue ? (["email", "whatsapp"] as StepChannel[]) : []) {
    if (overDeadline(ctx)) {
      result.partial = true;
      break;
    }
    try {
      await processDue(ctx, channel);
    } catch (err) {
      result.errors.push(`${channel}: ${errMsg(err)}`);
    }
  }

  // 5) Pós-compra: cria runs dos primeiros pedidos pagos e processa os
  //    vencidos (mesma trava, mesmo teto, mesmo intervalo mínimo).
  if (canProcessDue) {
    for (const fn of [createWelcomeRuns, processWelcomeRuns]) {
      if (overDeadline(ctx)) {
        result.partial = true;
        break;
      }
      try {
        await fn(ctx);
      } catch (err) {
        result.errors.push(`pós-compra: ${errMsg(err)}`);
      }
    }
  }

  // 6) Carimbo do tick por loja processada.
  if (ctx.touchedStores.size > 0) {
    const stores = [...ctx.touchedStores].filter((id) => ctx.settings.has(id));
    if (stores.length > 0) await admin.from("recovery_settings").update({ last_tick_at: ctx.nowIso }).in("store_id", stores);
  }

  // 7) Vigilância (WAHA, sessões, falhas de envio, alertas). Nunca derruba o tick.
  // Orçamento próprio de 20 s, limitado a 7 s depois do deadline do tick (a rota
  // tem maxDuration de 60 s e o tick para em 50 s): a vigilância nunca estoura.
  try {
    const watchdogDeadline = Math.min(Date.now() + WATCHDOG_BUDGET_MS, opts.deadline ? opts.deadline + 7_000 : Number.POSITIVE_INFINITY);
    result.watchdog = await runWatchdog(admin, { settings: [...ctx.settings.values()], deadline: watchdogDeadline });
  } catch (err) {
    result.errors.push(`watchdog: ${errMsg(err)}`);
  }
  return { ...result, ms: Date.now() - started };
}

// --- Teste de um passo (botão "Testar este passo" do painel) ------------------

// Renderiza o passo pra um recovery e envia SÓ pro destino informado (o de
// teste). Sem gate de enabled (o teste é explícito), mas exige o provedor
// configurado. Não avança a régua do recovery. Com isTest, a trava ganha o
// sufixo :test:<minuto> (dá pra repetir a cada minuto), os links levam t:1
// (clique/descadastro não gravam nada) e o e-mail leva a tag test=1.
export async function sendStepTo(admin: SupabaseClient, input: { recovery: RecoveryRow; step: RecoveryStep; settings: RecoverySettings; channel: StepChannel; to: string; isTest: boolean; variantIndex?: number; allowPt?: boolean }): Promise<{ ok: boolean; preview: { subject?: string; text: string; html?: string }; error?: string }> {
  const { recovery: rec, step, settings, channel } = input;
  const to = input.to.trim();
  const empty = { text: "" };
  if (!to) return { ok: false, preview: empty, error: "Informe o destino de teste (e-mail ou telefone)." };
  if (channel === "email" && !marketingConfigured(providerOf(settings))) return { ok: false, preview: empty, error: providerOf(settings) === "ses" ? "Amazon SES não configurado (AWS_SES_REGION / credenciais)." : providerOf(settings) === "activecampaign" ? "ActiveCampaign não configurado (ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY)." : "RESEND_API_KEY não configurada." };
  if (channel === "email" && !settings.from_email?.trim()) return { ok: false, preview: empty, error: "Configure o remetente (from_email) da loja antes de testar." };
  if (channel === "whatsapp" && !wahaConfigured()) return { ok: false, preview: empty, error: "WAHA_URL / WAHA_API_KEY não configurados." };

  const [{ data: discountRows }, { data: store }, products] = await Promise.all([
    admin.from("recovery_discounts").select("*").eq("store_id", rec.store_id).eq("active", true),
    admin.from("stores").select("name").eq("id", rec.store_id).maybeSingle(),
    loadProducts(admin, rec.store_id),
  ]);
  const prepared = prepareStep({ rec, step, settings, channel, discounts: (discountRows ?? []) as RecoveryDiscount[], products, storeName: (store?.name as string | undefined) ?? null, variantIndex: input.variantIndex, isTest: input.isTest, allowPt: input.isTest && input.allowPt });
  if ("error" in prepared) return { ok: false, preview: empty, error: `${prepared.error}${prepared.detail ? `: ${prepared.detail}` : ""}` };
  const preview = { subject: prepared.subject, text: channel === "email" ? (prepared.emailText ?? prepared.text) : prepared.text, html: prepared.html };
  // Mesma regra do tick: passo com desconto sem cupom cadastrado não sai
  // (o texto prometeria um cupom vazio). A prévia volta pra mostrar o problema.
  if (prepared.noCoupon) return { ok: false, preview, error: `Este passo pede ${prepared.noCoupon.percent}% de desconto e a loja não tem cupom ativo com esse percentual. Cadastre o cupom na aba Configuração. Nada foi enviado.` };
  // Envio REAL (isTest = false) exige o DNS do remetente verificado.
  if (channel === "email" && !input.isTest) {
    const dns = await senderDns({ dns: new Map() }, settings.from_email as string);
    if (!dns.ok) return { ok: false, preview, error: `DNS do remetente ${settings.from_email} sem verificação (${dns.problems.join("; ")}). Nada foi enviado.` };
  }

  let session: WhatsappSessionRow | null = null;
  if (channel === "whatsapp") {
    const picked = await pickSessionDetailed(admin, rec.store_id, rec);
    if (!picked.session) return { ok: false, preview, error: picked.reason === "aguardar" ? `O número fixo deste carrinho (${rec.waha_session}) está no teto diário ou em restrição. Aguarde para testar.` : "Nenhum número de WhatsApp da loja está conectado (WORKING) e abaixo do teto diário." };
    session = picked.session;
  }

  const now = new Date();
  const target: EventTarget = { store_id: rec.store_id, recovery_id: rec.id };
  const dedupeKey = dedupeKeyFor(rec, channel, step.position, input.isTest, now);
  const claim = await claimEvent(admin, { target, channel, position: step.position, dedupeKey, code: prepared.code, to, language: prepared.lang, isTest: input.isTest });
  // Carrinho fictício (spec §5: a loja ainda não tem abandono com contato): não
  // dá pra gravar a trava, mas o destino é SEMPRE o de teste, então segue sem
  // evento. Fora do teste a trava é obrigatória (falha fechado).
  let claimId: string | null = null;
  if (claim.ok) claimId = claim.id;
  else if (claim.reason === "duplicate") return { ok: false, preview, error: input.isTest ? "Esse passo já foi testado neste minuto. Aguarde 1 minuto e tente de novo." : "Esse passo já foi enviado para esse carrinho." };
  else if (claim.reason === "missing_recovery" && input.isTest) console.warn("sendStepTo: carrinho fictício, teste sem trava:", claim.message);
  else return { ok: false, preview, error: `Não consegui registrar o envio (nada foi mandado): ${claim.message}` };

  let outcome: SendOutcome;
  try {
    outcome = channel === "email"
      ? await deliverEmail({ settings, prepared, to, dedupeKey, isTest: input.isTest, tags: { recovery_id: rec.id, step: String(step.position), channel: "email", store_id: rec.store_id, flow: "carrinho" } })
      : await deliverWhatsapp(admin, { session: session as WhatsappSessionRow, chatId: chatIdFromPhone(to), to, prepared, rec, position: step.position, isTest: input.isTest });
  } catch (err) {
    outcome = { ok: false, error: errMsg(err) };
  }
  if (!outcome.ok) {
    // Ambíguo: mantém a trava do minuto (não reenvia por engano); definitivo libera.
    if (claimId) await (outcome.ambiguous ? markEventAmbiguous(admin, claimId, outcome.error) : outcome.quota ? markEventQuota(admin, claimId, outcome.error) : markEventFailed(admin, claimId, outcome.error));
    if (outcome.restriction && session) await restrictSession(admin, session.name, 24, outcome.error);
    return { ok: false, preview, error: outcome.ambiguous ? `${outcome.error} (resposta ambígua: a mensagem pode ter saído, confira antes de testar de novo)` : outcome.error };
  }
  if (claimId) await markEventSent(admin, claimId, { messageId: outcome.messageId, provider: outcome.provider });
  return { ok: true, preview };
}

// Só a prévia (sem enviar nada): usado pelo painel pra mostrar como o passo
// fica pra um carrinho real.
export async function previewStep(admin: SupabaseClient, input: { recovery: RecoveryRow; step: RecoveryStep; settings: RecoverySettings; channel: StepChannel; variantIndex?: number }): Promise<PrepareOutcome> {
  const [{ data: discountRows }, { data: store }, products] = await Promise.all([
    admin.from("recovery_discounts").select("*").eq("store_id", input.recovery.store_id).eq("active", true),
    admin.from("stores").select("name").eq("id", input.recovery.store_id).maybeSingle(),
    loadProducts(admin, input.recovery.store_id),
  ]);
  return prepareStep({ rec: input.recovery, step: input.step, settings: input.settings, channel: input.channel, discounts: (discountRows ?? []) as RecoveryDiscount[], products, storeName: (store?.name as string | undefined) ?? null, variantIndex: input.variantIndex, isTest: input.settings.test_mode });
}
