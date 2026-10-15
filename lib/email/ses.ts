// Envio de e-mail de MARKETING (recuperação de carrinho e pós-compra) pelo
// Amazon SES (API v2). Alternativa ao Resend, escolhida por loja em
// recovery_settings.email_provider = 'ses'. Nunca pela caixa de suporte.
//
// ============================================================================
// O QUE O IAN PRECISA FAZER (uma vez; ~30 min, sem código)
// ============================================================================
// 1. Conta AWS e região: escolher UMA região para o SES (sugestão eu-west-1,
//    Irlanda) e colocar em AWS_SES_REGION. Tudo abaixo é feito nessa região.
// 2. Identidade do domínio (SES → Identities → Create identity → Domain):
//    usar um subdomínio só de marketing por marca, ex.: mail.olavita.co.il
//    (nunca o domínio da loja nem o da caixa de suporte). Marcar "Easy DKIM"
//    (RSA_2048) e gravar os 3 CNAMEs <token>._domainkey.mail.<marca> no DNS.
//    Esperar ficar "Verified" e DKIM "Successful".
// 3. MAIL FROM personalizado (na identidade → Custom MAIL FROM domain):
//    bounce.mail.<marca>. Gravar o MX e o TXT (SPF "v=spf1 include:
//    amazonses.com ~all") que o console mostra. Sem isso o SPF alinha com
//    amazonses.com e o DMARC da marca falha.
// 4. DMARC no domínio raiz da marca (se ainda não tiver):
//    _dmarc.<marca> TXT "v=DMARC1; p=none; rua=mailto:<e-mail do Ian>".
// 5. Acesso de produção (SES → Account dashboard → Request production
//    access): enquanto a conta está em sandbox, só manda para endereços
//    verificados e 200/dia. Pedir com o caso de uso "e-mails de recuperação
//    de carrinho e pós-compra para clientes que compraram/iniciaram compra,
//    com descadastro em um clique". Leva até 24 h.
// 6. Configuration set "respondo" (SES → Configuration sets → Create):
//    SES_CONFIGURATION_SET=respondo. Dentro dele, Event destinations → Add:
//    tipos Send, Delivery, Bounce, Complaint, Reject, Open, Click, Rendering
//    failure, Delivery delay; destino Amazon SNS → criar o tópico
//    "respondo-ses-events". No tópico SNS → Create subscription → protocolo
//    HTTPS → endpoint https://SEU-APP/api/webhooks/ses
//    com "Raw message delivery" DESLIGADO (a rota precisa do envelope assinado
//    do SNS). A rota confirma a assinatura sozinha (SubscriptionConfirmation).
//    Open/Click só funcionam se a identidade/configuration set tiver tracking
//    ligado (padrão: ligado).
// 7. Usuário IAM só para o app (IAM → Users → Create): sem console, política
//    inline com ses:SendEmail (envio) e, para o painel de entregabilidade,
//    ses:GetAccount, ses:GetEmailIdentity e ses:BatchGetMetricData.
//    Criar access key → AWS_ACCESS_KEY_ID e AWS_SECRET_ACCESS_KEY no Vercel e
//    no .env.local. Nunca a chave da conta raiz.
// 8. (Opcional) VDM ligado (SES → Virtual Deliverability Manager → Enable)
//    para getSesMetrics() devolver números; sem VDM a função devolve null e
//    o painel usa só os eventos do banco.
//
// Env: AWS_SES_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//      SES_CONFIGURATION_SET (OBRIGATÓRIO em produção, ou seja, com o modo de
//        teste desligado: sem ele o bounce e a reclamação NÃO chegam ao
//        webhook e a lista de supressão não se alimenta; o motor recusa enviar
//        e o PUT de settings recusa sair do modo de teste),
//      SES_SNS_TOPIC_ARN (OBRIGATÓRIO para o webhook /api/webhooks/ses: ARN do
//        tópico SNS "respondo-ses-events", ex.: arn:aws:sns:eu-west-1:123456789012:respondo-ses-events;
//        aceita vários separados por vírgula. Sem ela o webhook recusa tudo com
//        401, inclusive a confirmação da assinatura do tópico. Defina a variável
//        ANTES de criar a assinatura HTTPS no SNS).
// Sem credencial: sesConfigured() = false e sendSesEmail lança (falha fechado).
// As funções de status (getSes*) nunca lançam: devolvem null.
import { SendError, networkErrorAmbiguous } from "@/lib/email/send-error";
import { BatchGetMetricDataCommand, GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client, type BatchGetMetricDataQuery, type MessageHeader, type MessageTag, type Metric } from "@aws-sdk/client-sesv2";

export interface SesEmail {
  // "Monique da Olavita <monique@mail.olavita.co.il>" (nome com acento ou
  // hebraico é codificado em RFC 2047 aqui; o SES exige ASCII no cabeçalho)
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | null;
  // List-Unsubscribe / List-Unsubscribe-Post etc.
  headers?: Record<string, string>;
  // viram EmailTags (nome e valor só [A-Za-z0-9_-], até 256 caracteres) e
  // voltam nos eventos como mail.tags = { chave: ["valor"] }
  tags?: Record<string, string>;
  configurationSet?: string | null;
}

export const sesConfigured = (): boolean => Boolean(process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

export const sesRegion = (): string | null => process.env.AWS_SES_REGION?.trim() || null;

export const sesConfigurationSet = (): string | null => process.env.SES_CONFIGURATION_SET?.trim() || null;

// Um cliente por (região, chave): reaproveita a conexão entre chamadas da
// mesma instância serverless.
let cachedClient: { key: string; client: SESv2Client } | null = null;

function client(): SESv2Client {
  const region = process.env.AWS_SES_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error("Amazon SES não configurado (AWS_SES_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY): e-mail não enviado.");
  }
  const key = `${region}|${accessKeyId}`;
  if (cachedClient?.key === key) return cachedClient.client;
  const c = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
  cachedClient = { key, client: c };
  return c;
}

const TAG_CLEAN = /[^A-Za-z0-9_-]/g;

// Tags do SES: nome e valor só com letras, números, _ e -, até 256 chars.
// O que não couber vira "_" (igual à regra do Resend em lib/email/resend.ts).
export function sesTags(tags?: Record<string, string>): MessageTag[] | undefined {
  if (!tags) return undefined;
  const out: MessageTag[] = [];
  for (const [rawName, rawValue] of Object.entries(tags)) {
    const Name = rawName.replace(TAG_CLEAN, "_").slice(0, 256);
    const Value = String(rawValue ?? "").replace(TAG_CLEAN, "_").slice(0, 256);
    if (!Name || !Value) continue;
    out.push({ Name, Value });
  }
  return out.length ? out : undefined;
}

// "Nome <endereco>" → nome codificado em RFC 2047 quando tiver caractere fora
// do ASCII (hebraico, acento). O SES rejeita cabeçalho From/Reply-To com
// UTF-8 cru. Endereço sem nome passa como está.
export function encodeAddress(raw: string): string {
  const value = raw.trim();
  const m = value.match(/^(.*?)\s*<([^<>]+)>$/);
  if (!m) return value;
  const name = m[1].trim().replace(/^"(.*)"$/, "$1");
  const addr = m[2].trim();
  if (!name) return addr;
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(name)) return /[(),:;<>@"\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>` : `${name} <${addr}>`;
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${addr}>`;
}

const ERROR_HINTS: Record<string, string> = {
  MessageRejected: "o SES recusou a mensagem (conta em sandbox? remetente ou destinatário não verificado?)",
  MailFromDomainNotVerifiedException: "o domínio MAIL FROM não está verificado no SES",
  AccountSuspendedException: "a conta SES está suspensa",
  SendingPausedException: "o envio está pausado na conta ou no configuration set",
  NotFoundException: "configuration set ou identidade não existe nessa região",
  LimitExceededException: "cota diária do SES atingida",
  TooManyRequestsException: "taxa máxima de envio por segundo atingida",
  AccessDeniedException: "o usuário IAM não tem permissão (ses:SendEmail)",
  UnrecognizedClientException: "AWS_ACCESS_KEY_ID inválida",
  InvalidSignatureException: "AWS_SECRET_ACCESS_KEY inválida",
  CredentialsProviderError: "credenciais da AWS ausentes",
  BadRequestException: "pedido inválido (remetente, cabeçalho ou tag fora do padrão)",
  TimeoutError: "o SES não respondeu a tempo",
  AbortError: "o SES não respondeu a tempo",
};

// Erros em que o SES recusou o pedido ANTES de aceitar a mensagem (definitivos:
// nada saiu, retentar é seguro). Qualquer outro erro do SDK sem essa certeza é
// tratado como ambíguo (a mensagem pode ter sido aceita).
const DEFINITIVE_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "NotFoundException",
  "LimitExceededException",
  "TooManyRequestsException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "CredentialsProviderError",
  "BadRequestException",
  "ValidationException",
  "InvalidParameterValue",
]);

// O SES pode ter aceitado a mensagem? Timeout/abort, 5xx, falha de rede sem
// resposta e erro desconhecido = sim (ambíguo). Recusa 4xx conhecida = não.
export function sesErrorAmbiguous(err: unknown): boolean {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
  const meta = typeof err === "object" && err && "$metadata" in err ? ((err as { $metadata?: { httpStatusCode?: number } }).$metadata ?? null) : null;
  const fault = typeof err === "object" && err && "$fault" in err ? String((err as { $fault?: unknown }).$fault) : "";
  if (name === "TimeoutError" || name === "AbortError" || name === "RequestTimeout" || name === "RequestTimeoutException") return true;
  const status = meta?.httpStatusCode;
  if (typeof status === "number" && status >= 500) return true;
  if (fault === "server") return true;
  if (DEFINITIVE_ERRORS.has(name)) return false;
  if (typeof status === "number" && status >= 400) return false;
  return networkErrorAmbiguous(err);
}

// Erro do SDK vira Error legível para o evento 'failed' e para o painel, já
// classificado como definitivo ou ambíguo (SendError.ambiguous).
export function readableSesError(err: unknown): SendError {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
  const message = err instanceof Error ? err.message : String(err);
  const hint = ERROR_HINTS[name];
  const status = typeof err === "object" && err && "$metadata" in err ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
  return new SendError(`Amazon SES${name ? ` ${name}` : ""}: ${hint ? `${hint}. ` : ""}${message}`.trim(), sesErrorAmbiguous(err), status);
}

export async function sendSesEmail(input: SesEmail): Promise<{ id: string }> {
  const c = client();
  if (!input.to?.trim()) throw new Error("Amazon SES: destinatário vazio.");
  if (!input.from?.trim()) throw new Error("Amazon SES: remetente vazio.");
  const headers: MessageHeader[] = Object.entries(input.headers ?? {})
    .filter(([name, value]) => name && value != null && String(value).trim() !== "")
    .map(([Name, Value]) => ({ Name: Name.trim(), Value: String(Value).replace(/[\r\n]+/g, " ").trim() }));
  const configurationSet = input.configurationSet === undefined ? sesConfigurationSet() : input.configurationSet?.trim() || null;

  const command = new SendEmailCommand({
    FromEmailAddress: encodeAddress(input.from),
    Destination: { ToAddresses: [input.to.trim()] },
    ReplyToAddresses: input.replyTo?.trim() ? [encodeAddress(input.replyTo)] : undefined,
    ConfigurationSetName: configurationSet ?? undefined,
    EmailTags: sesTags(input.tags),
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: input.html, Charset: "UTF-8" },
          Text: input.text?.trim() ? { Data: input.text, Charset: "UTF-8" } : undefined,
        },
        Headers: headers.length ? headers : undefined,
      },
    },
  });

  let messageId: string | undefined;
  try {
    const res = await c.send(command, { abortSignal: AbortSignal.timeout(20_000) });
    messageId = res.MessageId;
  } catch (err) {
    throw readableSesError(err);
  }
  // Resposta sem MessageId: o SES pode ter aceitado (ambíguo).
  if (!messageId) throw new SendError("Amazon SES: resposta sem MessageId.", true);
  return { id: messageId };
}

// ---------------------------------------------------------------------------
// Status da conta, da identidade e métricas (painel de entregabilidade).
// Tolerantes: sem credencial ou sem permissão → null. Nunca lançam.
// ---------------------------------------------------------------------------

export interface SesAccountStatus {
  region: string;
  sendingEnabled: boolean;
  // HEALTHY | PROBATION | SHUTDOWN
  enforcementStatus: string | null;
  productionAccess: boolean;
  // true = conta em sandbox (só manda para endereços verificados)
  sandbox: boolean;
  // -1 = ilimitada
  dailyQuota: number | null;
  sentLast24h: number | null;
  maxSendRate: number | null;
  vdmEnabled: boolean;
  checkedAt: string;
}

export async function getSesAccountStatus(): Promise<SesAccountStatus | null> {
  if (!sesConfigured()) return null;
  try {
    const r = await client().send(new GetAccountCommand({}), { abortSignal: AbortSignal.timeout(8_000) });
    const production = Boolean(r.ProductionAccessEnabled);
    return {
      region: sesRegion() ?? "",
      sendingEnabled: Boolean(r.SendingEnabled),
      enforcementStatus: r.EnforcementStatus ?? null,
      productionAccess: production,
      sandbox: !production,
      dailyQuota: typeof r.SendQuota?.Max24HourSend === "number" ? r.SendQuota.Max24HourSend : null,
      sentLast24h: typeof r.SendQuota?.SentLast24Hours === "number" ? r.SendQuota.SentLast24Hours : null,
      maxSendRate: typeof r.SendQuota?.MaxSendRate === "number" ? r.SendQuota.MaxSendRate : null,
      vdmEnabled: r.VdmAttributes?.VdmEnabled === "ENABLED",
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("SES GetAccount:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface SesIdentityStatus {
  identity: string;
  // false = a identidade não existe nessa região (ainda não foi criada)
  found: boolean;
  verified: boolean;
  // PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE | NOT_STARTED
  dkimStatus: string | null;
  dkimSigningEnabled: boolean;
  // os 3 CNAMEs <token>._domainkey.<dominio> que precisam existir no DNS
  dkimTokens: string[];
  mailFromDomain: string | null;
  // PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE
  mailFromStatus: string | null;
  checkedAt: string;
}

const identityCache = new Map<string, { at: number; value: SesIdentityStatus | null }>();
const IDENTITY_CACHE_MS = 5 * 60 * 1000;

export async function getSesIdentityStatus(domain: string): Promise<SesIdentityStatus | null> {
  const identity = (domain ?? "").trim().toLowerCase().replace(/^.*@/, "");
  if (!identity || !sesConfigured()) return null;
  const hit = identityCache.get(identity);
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_MS) return hit.value;
  let value: SesIdentityStatus | null = null;
  try {
    const r = await client().send(new GetEmailIdentityCommand({ EmailIdentity: identity }), { abortSignal: AbortSignal.timeout(8_000) });
    value = {
      identity,
      found: true,
      verified: Boolean(r.VerifiedForSendingStatus),
      dkimStatus: r.DkimAttributes?.Status ?? null,
      dkimSigningEnabled: Boolean(r.DkimAttributes?.SigningEnabled),
      dkimTokens: r.DkimAttributes?.Tokens ?? [],
      mailFromDomain: r.MailFromAttributes?.MailFromDomain ?? null,
      mailFromStatus: r.MailFromAttributes?.MailFromDomainStatus ?? null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const name = typeof err === "object" && err && "name" in err ? String((err as { name?: unknown }).name) : "";
    if (name === "NotFoundException") {
      value = { identity, found: false, verified: false, dkimStatus: null, dkimSigningEnabled: false, dkimTokens: [], mailFromDomain: null, mailFromStatus: null, checkedAt: new Date().toISOString() };
    } else {
      console.warn("SES GetEmailIdentity:", err instanceof Error ? err.message : err);
      value = null;
    }
  }
  identityCache.set(identity, { at: Date.now(), value });
  return value;
}

export interface SesMetrics {
  since: string;
  until: string;
  configurationSet: string | null;
  // null = métrica não veio (sem VDM ou sem permissão nessa consulta)
  send: number | null;
  delivery: number | null;
  permanentBounce: number | null;
  transientBounce: number | null;
  complaint: number | null;
  open: number | null;
  click: number | null;
  checkedAt: string;
}

const METRIC_QUERIES: Array<{ id: keyof Omit<SesMetrics, "since" | "until" | "configurationSet" | "checkedAt">; metric: Metric }> = [
  { id: "send", metric: "SEND" },
  { id: "delivery", metric: "DELIVERY" },
  { id: "permanentBounce", metric: "PERMANENT_BOUNCE" },
  { id: "transientBounce", metric: "TRANSIENT_BOUNCE" },
  { id: "complaint", metric: "COMPLAINT" },
  { id: "open", metric: "OPEN" },
  { id: "click", metric: "CLICK" },
];

// Precisa de VDM ligado na conta e de ses:BatchGetMetricData. Sem isso → null.
export async function getSesMetrics(input: { since: Date | string; until?: Date | string; configurationSet?: string | null }): Promise<SesMetrics | null> {
  if (!sesConfigured()) return null;
  const since = new Date(input.since);
  const until = input.until ? new Date(input.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) return null;
  const configurationSet = input.configurationSet === undefined ? sesConfigurationSet() : input.configurationSet?.trim() || null;
  const queries: BatchGetMetricDataQuery[] = METRIC_QUERIES.map((q) => ({
    Id: q.id,
    Namespace: "VDM",
    Metric: q.metric,
    Dimensions: configurationSet ? { CONFIGURATION_SET: configurationSet } : undefined,
    StartDate: since,
    EndDate: until,
  }));
  try {
    const r = await client().send(new BatchGetMetricDataCommand({ Queries: queries }), { abortSignal: AbortSignal.timeout(10_000) });
    const results = r.Results ?? [];
    if (!results.length) {
      if (r.Errors?.length) console.warn("SES BatchGetMetricData:", r.Errors.map((e) => `${e.Id ?? "?"}: ${e.Code ?? ""} ${e.Message ?? ""}`).join("; "));
      return null;
    }
    const sum = (id: string): number | null => {
      const res = results.find((x) => x.Id === id);
      if (!res) return null;
      return (res.Values ?? []).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
    };
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      configurationSet,
      send: sum("send"),
      delivery: sum("delivery"),
      permanentBounce: sum("permanentBounce"),
      transientBounce: sum("transientBounce"),
      complaint: sum("complaint"),
      open: sum("open"),
      click: sum("click"),
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("SES BatchGetMetricData:", err instanceof Error ? err.message : err);
    return null;
  }
}
