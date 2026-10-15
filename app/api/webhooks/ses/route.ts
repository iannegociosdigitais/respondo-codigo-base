import { NextResponse } from "next/server";
import { createPublicKey, verify as cryptoVerify, X509Certificate, type KeyObject } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECOVERY_MISSING_TABLE } from "@/lib/recovery/types";

export const maxDuration = 30;

// Webhook do Amazon SES via SNS (e-mail de recuperação e pós-compra).
//
// O SNS chama esta rota com um envelope JSON assinado. ANTES de qualquer
// coisa a assinatura é verificada (verifySnsSignature): certificado baixado
// de SigningCertURL (só https em sns.<região>.amazonaws.com, cache em
// memória), string canônica montada por tipo de mensagem, RSA-SHA1
// (SignatureVersion 1) ou RSA-SHA256 (SignatureVersion 2). Inválida → 401.
//
//  SubscriptionConfirmation → visita SubscribeURL (mesma trava de host) → 200
//  Notification → Message é o evento do SES:
//    Delivery → delivered, Open → opened, Click → clicked,
//    Bounce → bounced (Permanent: supressão + régua para),
//    Complaint → complained (supressão + régua para),
//    Reject / Rendering Failure → failed; Send / DeliveryDelay → ignorado.
//  Alvo: mail.tags.run_id (pós-compra) ou mail.tags.recovery_id (carrinho);
//  senão o evento 'sent' com message_id = mail.messageId.
//  Dedupe: dedupe_key = "ses:<MessageId do SNS>" (o SNS reenvia com o mesmo id).
//  A trava de dedupe é gravada POR ÚLTIMO, depois da supressão e do status
//  (erro em qualquer escrita = 500 sem trava, o SNS reentrega e reaplica; a
//  supressão é idempotente).
//
// Tópico: SES_SNS_TOPIC_ARN (um ou vários ARNs separados por vírgula) é
// OBRIGATÓRIO. O TopicArn de TODA mensagem (inclusive SubscriptionConfirmation)
// precisa estar na lista, senão 401: qualquer tópico SNS de qualquer conta
// consegue ter assinatura válida, só o ARN prova que é o NOSSO. Sem a variável,
// tudo é recusado (401), exceto UnsubscribeConfirmation (200 'ignorado').
// Bounce/Complaint só SUPRIMEM e param a régua quando mail.messageId casa com
// um evento 'sent' nosso (recovery_events.message_id); sem casar, só registra.
//
// Pré-requisito na AWS: assinatura SNS HTTPS com "raw message delivery"
// DESLIGADO (ver o topo de lib/email/ses.ts).

// ---------------------------------------------------------------------------
// Verificação da assinatura do SNS
// ---------------------------------------------------------------------------

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion?: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

export type CertFetcher = (url: string) => Promise<string>;

export type SnsVerifyResult = { ok: true; message: SnsEnvelope } | { ok: false; reason: string };

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

// URL do SNS aceita: https, host sns.<região>.amazonaws.com e, para o
// certificado, caminho terminando em .pem.
export function snsUrlAllowed(raw: unknown, opts: { pem?: boolean } = {}): boolean {
  if (typeof raw !== "string" || !raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!SNS_HOST.test(u.hostname)) return false;
  if (opts.pem && !u.pathname.toLowerCase().endsWith(".pem")) return false;
  return true;
}

// String canônica do SNS: campos em ordem alfabética, "Nome\nValor\n" cada.
// Notification: Message, MessageId, [Subject], Timestamp, TopicArn, Type.
// SubscriptionConfirmation / UnsubscribeConfirmation: Message, MessageId,
// SubscribeURL, Timestamp, Token, TopicArn, Type. Tipo desconhecido → null.
export function snsCanonicalString(msg: SnsEnvelope): string | null {
  const pick = (names: string[]): string | null => {
    let out = "";
    for (const name of names) {
      const value = (msg as unknown as Record<string, unknown>)[name];
      if (name === "Subject" && (value === undefined || value === null)) continue;
      if (typeof value !== "string") return null;
      out += `${name}\n${value}\n`;
    }
    return out;
  };
  if (msg.Type === "Notification") return pick(["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]);
  if (msg.Type === "SubscriptionConfirmation" || msg.Type === "UnsubscribeConfirmation") return pick(["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]);
  return null;
}

// Cache do certificado por URL (a instância serverless costuma viver minutos;
// o SNS reutiliza a mesma URL por muito tempo). Limitado para não crescer.
const certCache = new Map<string, string>();
const CERT_CACHE_MAX = 20;

const defaultFetchCert: CertFetcher = async (url) => {
  const hit = certCache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
  if (!res.ok) throw new Error(`certificado ${res.status}`);
  const pem = (await res.text()).trim();
  if (!/-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/.test(pem)) throw new Error("certificado não é PEM");
  if (certCache.size >= CERT_CACHE_MAX) {
    const first = certCache.keys().next().value;
    if (first !== undefined) certCache.delete(first);
  }
  certCache.set(url, pem);
  return pem;
};

// Aceita o certificado X.509 do SNS ou (nos testes) uma chave pública PEM.
function publicKeyFromPem(pem: string): KeyObject {
  if (/-----BEGIN CERTIFICATE-----/.test(pem)) return new X509Certificate(pem).publicKey;
  return createPublicKey(pem);
}

function parseEnvelope(body: unknown): SnsEnvelope | null {
  let obj: unknown = body;
  if (typeof body === "string") {
    try {
      obj = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const field of ["Type", "MessageId", "Message", "Timestamp", "Signature", "SigningCertURL"]) {
    if (typeof o[field] !== "string" || !(o[field] as string).length) return null;
  }
  return o as unknown as SnsEnvelope;
}

// `body`: envelope do SNS (objeto já parseado ou o texto cru). `fetchCert`:
// injetável para teste (recebe a SigningCertURL e devolve o PEM).
export async function verifySnsSignature(body: unknown, fetchCert: CertFetcher = defaultFetchCert): Promise<SnsVerifyResult> {
  const msg = parseEnvelope(body);
  if (!msg) return { ok: false, reason: "envelope incompleto" };
  const version = msg.SignatureVersion ?? "1";
  const algorithm = version === "1" ? "sha1" : version === "2" ? "sha256" : null;
  if (!algorithm) return { ok: false, reason: `SignatureVersion desconhecida: ${version}` };
  if (!snsUrlAllowed(msg.SigningCertURL, { pem: true })) return { ok: false, reason: "SigningCertURL fora do domínio do SNS" };
  const canonical = snsCanonicalString(msg);
  if (canonical === null) return { ok: false, reason: `tipo de mensagem desconhecido ou campo ausente: ${msg.Type}` };
  const signature = Buffer.from(msg.Signature, "base64");
  if (!signature.length) return { ok: false, reason: "assinatura vazia" };
  let key: KeyObject;
  try {
    key = publicKeyFromPem(await fetchCert(msg.SigningCertURL));
  } catch (err) {
    return { ok: false, reason: `certificado: ${err instanceof Error ? err.message : String(err)}` };
  }
  let valid = false;
  try {
    valid = cryptoVerify(algorithm, Buffer.from(canonical, "utf8"), key, signature);
  } catch (err) {
    return { ok: false, reason: `verificação: ${err instanceof Error ? err.message : String(err)}` };
  }
  return valid ? { ok: true, message: msg } : { ok: false, reason: "assinatura não confere" };
}

// ---------------------------------------------------------------------------
// Evento do SES (conteúdo de Message)
// ---------------------------------------------------------------------------

interface SesEvent {
  eventType?: string;
  // formato antigo (notificações de bounce/complaint/delivery da identidade)
  notificationType?: string;
  mail?: {
    messageId?: string;
    timestamp?: string;
    source?: string;
    destination?: string[];
    tags?: Record<string, string[] | string>;
    commonHeaders?: { subject?: string };
  };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: Array<{ emailAddress?: string; status?: string; diagnosticCode?: string }> };
  complaint?: { complaintFeedbackType?: string; timestamp?: string; complainedRecipients?: Array<{ emailAddress?: string }> };
  delivery?: { recipients?: string[]; timestamp?: string; smtpResponse?: string };
  click?: { link?: string; timestamp?: string };
  open?: { timestamp?: string };
  reject?: { reason?: string };
  failure?: { errorMessage?: string; templateName?: string };
}

const EVENT_MAP: Record<string, string> = {
  delivery: "delivered",
  open: "opened",
  click: "clicked",
  bounce: "bounced",
  complaint: "complained",
  reject: "failed",
  "rendering failure": "failed",
  renderingfailure: "failed",
};

// mail.tags vem como { chave: ["valor"] }; fica só o primeiro valor.
const flatTags = (tags: Record<string, string[] | string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!tags || typeof tags !== "object") return out;
  for (const [k, v] of Object.entries(tags)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string") out[k] = first;
  }
  return out;
};

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

type Target = { kind: "recovery" | "run"; id: string; store_id: string; step: number | null };

export async function POST(request: Request) {
  const raw = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "json inválido" }, { status: 400 });
  }

  const verified = await verifySnsSignature(parsed);
  if (!verified.ok) {
    console.warn("webhook ses: assinatura recusada:", verified.reason);
    return NextResponse.json({ error: "assinatura inválida" }, { status: 401 });
  }
  const sns = verified.message;

  // Tópico permitido (SES_SNS_TOPIC_ARN). Falha fechado: sem a variável nada
  // é processado, nem a confirmação da assinatura.
  const allowedTopics = (process.env.SES_SNS_TOPIC_ARN ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (allowedTopics.length === 0) {
    if (sns.Type === "UnsubscribeConfirmation") return NextResponse.json({ ok: true, ignored: "UnsubscribeConfirmation" });
    console.warn("webhook ses: SES_SNS_TOPIC_ARN não configurada; mensagem recusada.");
    return NextResponse.json({ error: "SES_SNS_TOPIC_ARN não configurada" }, { status: 401 });
  }
  if (!sns.TopicArn || !allowedTopics.includes(sns.TopicArn)) {
    console.warn("webhook ses: TopicArn fora da lista permitida:", sns.TopicArn ?? "(vazio)");
    return NextResponse.json({ error: "tópico não permitido" }, { status: 401 });
  }

  if (sns.Type === "SubscriptionConfirmation") {
    if (!snsUrlAllowed(sns.SubscribeURL)) return NextResponse.json({ error: "SubscribeURL fora do domínio do SNS" }, { status: 400 });
    try {
      const res = await fetch(sns.SubscribeURL as string, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
      console.log("webhook ses: assinatura do tópico confirmada:", sns.TopicArn ?? "", res.status);
      return NextResponse.json({ ok: true, subscribed: res.ok });
    } catch (err) {
      console.error("webhook ses: falha ao confirmar assinatura:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "não consegui confirmar a assinatura" }, { status: 502 });
    }
  }
  if (sns.Type !== "Notification") return NextResponse.json({ ok: true, ignored: sns.Type });

  let event: SesEvent;
  try {
    event = JSON.parse(sns.Message) as SesEvent;
  } catch {
    // Mensagem de teste do console do SNS ("Hello from SNS") ou outra coisa.
    return NextResponse.json({ ok: true, ignored: "mensagem não é JSON" });
  }
  if (!event || typeof event !== "object") return NextResponse.json({ ok: true, ignored: "evento vazio" });

  const eventType = String(event.eventType ?? event.notificationType ?? "").trim();
  const type = EVENT_MAP[eventType.toLowerCase()];
  if (!type) return NextResponse.json({ ok: true, ignored: eventType || "sem eventType" });

  const admin = createAdminClient();
  const now = new Date().toISOString();
  try {
    const tags = flatTags(event.mail?.tags);
    const messageId = event.mail?.messageId ?? null;

    // Evento 'sent' do envio (gravado pelo motor com message_id do SES): diz
    // se foi teste e serve de fallback para achar o alvo.
    type SentEvent = { recovery_id: string | null; run_id: string | null; store_id: string; step: number | null; is_test: boolean };
    let sentEvent: SentEvent | null = null;
    if (messageId) {
      const { data, error: sentErr } = await admin.from("recovery_events").select("recovery_id, run_id, store_id, step, is_test").eq("message_id", messageId).eq("type", "sent").order("created_at", { ascending: false }).limit(1).maybeSingle();
      // Sem saber se o envio é nosso não dá pra decidir supressão: 500 (o SNS reentrega).
      if (sentErr) throw new Error(sentErr.message);
      sentEvent = (data as SentEvent | null) ?? null;
    }
    // Envio de teste (foi pro test_email): fica registrado como teste e NÃO
    // mexe em status nem em supressão.
    const isTest = tags.test === "1" || Boolean(sentEvent?.is_test);

    // O envio nosso que casa com o messageId manda no alvo (as tags vêm da
    // mensagem e só valem quando não há envio correspondente).
    let target: Target | null = null;
    if (sentEvent?.run_id) target = { kind: "run", id: sentEvent.run_id, store_id: sentEvent.store_id, step: sentEvent.step };
    else if (sentEvent?.recovery_id) target = { kind: "recovery", id: sentEvent.recovery_id, store_id: sentEvent.store_id, step: sentEvent.step };
    if (!target && isUuid(tags.run_id)) {
      const { data } = await admin.from("post_purchase_runs").select("id, store_id, step").eq("id", tags.run_id).maybeSingle();
      if (data) target = { kind: "run", id: data.id as string, store_id: data.store_id as string, step: (data.step as number | null) ?? null };
    }
    if (!target && isUuid(tags.recovery_id)) {
      const { data } = await admin.from("cart_recoveries").select("id, store_id, step").eq("id", tags.recovery_id).maybeSingle();
      if (data) target = { kind: "recovery", id: data.id as string, store_id: data.store_id as string, step: (data.step as number | null) ?? null };
    }
    if (!target) return NextResponse.json({ ok: true, unknown: true });

    const to = (event.bounce?.bouncedRecipients?.[0]?.emailAddress ?? event.complaint?.complainedRecipients?.[0]?.emailAddress ?? event.delivery?.recipients?.[0] ?? event.mail?.destination?.[0] ?? null)?.toLowerCase() ?? null;
    const stepFromTag = tags.step ? Number(tags.step) : NaN;
    const step = Number.isFinite(stepFromTag) ? stepFromTag : target.step;
    const ts = event.bounce?.timestamp ?? event.complaint?.timestamp ?? event.delivery?.timestamp ?? event.click?.timestamp ?? event.open?.timestamp ?? event.mail?.timestamp ?? sns.Timestamp;

    // 1) Efeitos de parada/supressão PRIMEIRO (cada escrita é conferida; erro
    //    = 500 sem a trava de dedupe, e o SNS reentrega). Todos idempotentes.
    //    Envio de teste não mexe em nada. Bounce/complaint só vale se o
    //    messageId casa com um envio nosso (sentEvent).
    if (!isTest) {
      const touch = target.kind === "run"
        ? await admin.from("post_purchase_runs").update({ last_event_at: now, updated_at: now }).eq("id", target.id)
        : await admin.from("cart_recoveries").update({ last_event_at: now, updated_at: now }).eq("id", target.id);
      if (touch.error) throw new Error(touch.error.message);

      if ((type === "bounced" || type === "complained") && to && sentEvent) {
        // Bounce transitório (caixa cheia, servidor fora) não suprime: o SES
        // já tentou de novo por conta própria. Permanente ou reclamação: nunca
        // mais e a régua para.
        const hard = type === "complained" || /^permanent$/i.test(event.bounce?.bounceType ?? "");
        if (hard) {
          const sup = await admin.from("recovery_suppressions").upsert({ channel: "email", address: to, reason: type, source: "ses" }, { onConflict: "channel,address", ignoreDuplicates: true });
          if (sup.error) throw new Error(sup.error.message);
          const stop = target.kind === "run"
            ? await admin.from("post_purchase_runs").update({ status: "parado_suprimido", stop_reason: type, next_at: null, updated_at: now }).eq("id", target.id).in("status", ["ativo", "pausado"])
            : await admin.from("cart_recoveries").update({ status: "parado_suprimido", stop_reason: type, next_send_at: null, email_next_at: null, wa_next_at: null, updated_at: now }).eq("id", target.id).in("status", ["ativo", "pausado"]);
          if (stop.error) throw new Error(stop.error.message);
        }
      } else if ((type === "bounced" || type === "complained") && to && !sentEvent) {
        console.warn("webhook ses: bounce/complaint sem envio nosso correspondente (messageId", messageId ?? "?", "); só registrado, sem supressão.");
      }
    }

    // 2) Trava de dedupe POR ÚLTIMO.
    const { error } = await admin.from("recovery_events").insert({
      recovery_id: target.kind === "recovery" ? target.id : null,
      run_id: target.kind === "run" ? target.id : null,
      store_id: target.store_id,
      step,
      channel: "email",
      type,
      dedupe_key: `ses:${sns.MessageId}`,
      provider: "ses",
      message_id: messageId,
      to_address: to,
      is_test: isTest,
      detail: {
        eventType,
        bounce: event.bounce ? { type: event.bounce.bounceType ?? null, subType: event.bounce.bounceSubType ?? null, diagnostic: event.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? null } : null,
        complaint: event.complaint ? { feedbackType: event.complaint.complaintFeedbackType ?? null } : null,
        link: event.click?.link ?? null,
        reason: event.reject?.reason ?? event.failure?.errorMessage ?? null,
        smtp: event.delivery?.smtpResponse ?? null,
        created_at: ts ?? null,
        ...(!isTest && (type === "bounced" || type === "complained") && !sentEvent ? { unmatched: true } : {}),
      },
    });
    if (error) {
      // Reentrega do SNS: já processado (efeitos acima são idempotentes).
      if (/duplicate key/i.test(error.message)) return NextResponse.json({ ok: true, duplicate: true });
      throw new Error(error.message);
    }
    if (isTest) return NextResponse.json({ ok: true, test: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("webhook ses:", message);
    // Migration 0018 ainda não rodou: responder 200 para o SNS não ficar
    // reenviando por horas; o evento se perde (não há onde gravar).
    if (RECOVERY_MISSING_TABLE.test(message)) return NextResponse.json({ ok: true, skipped: "tabela ausente" });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
