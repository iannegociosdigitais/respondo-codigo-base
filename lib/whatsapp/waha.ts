import { chatIdFromPhone } from "@/lib/recovery/phone";
import { APP_URL } from "@/lib/forms/token";
import { networkErrorAmbiguous } from "@/lib/email/send-error";

// Cliente do WAHA (WhatsApp HTTP API, https://waha.devlike.pro), que roda num
// servidor seu via Docker (infra/waha/docker-compose.yml). Desde a versão
// 2026.6.1 tudo que era "Plus" está na imagem grátis (Apache 2.0).
//
// Env: WAHA_URL (https://wa.seudominio.com), WAHA_API_KEY (valor em texto;
// no servidor fica só o hash sha512), WAHA_WEBHOOK_SECRET (HMAC dos webhooks).
// Sem WAHA_URL/WAHA_API_KEY nada é enviado (falha fechado).
//
// É API NÃO oficial: o próprio WAHA avisa que não há garantia contra bloqueio
// e recomenda a Meta Cloud API pra integração crítica. Por isso: só opt-in,
// cadência baixa, texto variado, horário local, "visto"+"digitando" antes de
// cada mensagem, e parar na hora que a pessoa responder.

export type WahaSessionStatus = "STOPPED" | "STARTING" | "SCAN_QR_CODE" | "WORKING" | "FAILED" | "PASSKEY_REQUIRED" | "PASSKEY_CONFIRMATION_REQUIRED" | string;

// Trava do próprio WhatsApp para contatos NOVOS (erro 463). `timeEnforcementEnds`
// é um timestamp Unix em SEGUNDOS (pode vir nulo). Conversas já abertas pelo
// cliente não são afetadas.
export interface ReachoutTimelock {
  isActive?: boolean;
  enforcementType?: string | null;
  timeEnforcementEnds?: number | null;
}

export interface WahaSession {
  name: string;
  status: WahaSessionStatus;
  me?: { id: string; pushName?: string; reachoutTimelock?: ReachoutTimelock | null } | null;
  config?: Record<string, unknown>;
}

export class WahaError extends Error {
  // status 0 = sem resposta HTTP (timeout, abort, queda de rede). `notSent`:
  // a conexão nem abriu (DNS, recusada), então nada foi enviado.
  constructor(public status: number, message: string, public body?: unknown, public notSent = false) {
    super(message);
  }
  // Ambígua: a mensagem pode ter sido aceita pelo WAHA (timeout/abort/queda
  // depois de conectar, ou 5xx). O motor não retenta o passo nesse caso.
  get isAmbiguous() {
    return (this.status === 0 && !this.notSent) || this.status >= 500;
  }
  // 463 = Reachout Timelock (bloqueio temporário pra contatos novos), 475 = Message
  // Capping. Nos dois casos: NÃO reiniciar nem deslogar a sessão; só esperar.
  get isRestriction() {
    return this.status === 463 || this.status === 475;
  }
}

export const wahaConfigured = () => Boolean(process.env.WAHA_URL && process.env.WAHA_API_KEY);

function base(): { url: string; key: string } {
  const url = (process.env.WAHA_URL ?? "").replace(/\/$/, "");
  const key = process.env.WAHA_API_KEY ?? "";
  if (!url || !key) throw new Error("WAHA_URL / WAHA_API_KEY não configurados: WhatsApp desligado.");
  return { url, key };
}

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, accept = "application/json", timeoutMs = 30_000): Promise<T> {
  const { url, key } = base();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: { "X-Api-Key": key, Accept: accept, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Timeout, abort ou queda de rede: status 0. Ambíguo, exceto quando a
    // conexão nem abriu (nada foi enviado).
    throw new WahaError(0, `WAHA sem resposta em ${path}: ${err instanceof Error ? err.message : String(err)}`, undefined, !networkErrorAmbiguous(err));
  }
  if (accept !== "application/json") {
    if (!res.ok) throw new WahaError(res.status, `WAHA ${res.status} em ${path}`);
    return Buffer.from(await res.arrayBuffer()) as unknown as T;
  }
  // Corpo perdido depois de conectar = resposta perdida (ambíguo).
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new WahaError(0, `WAHA resposta interrompida em ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = typeof json === "object" && json && "message" in json ? String((json as { message: unknown }).message) : text.slice(0, 200);
    throw new WahaError(res.status, `WAHA ${res.status} em ${path}: ${msg}`, json);
  }
  return json as T;
}

// --- Sessões ---------------------------------------------------------------

export async function listSessions(): Promise<WahaSession[]> {
  return call<WahaSession[]>("GET", "/api/sessions?all=true");
}

// `timeoutMs` opcional (padrão 30 s): a vigilância do tick usa 5 s pra uma
// consulta lenta não estourar o maxDuration da rota.
export async function getSession(name: string, timeoutMs?: number): Promise<WahaSession | null> {
  try {
    return await call<WahaSession>("GET", `/api/sessions/${encodeURIComponent(name)}`, undefined, "application/json", timeoutMs);
  } catch (err) {
    if (err instanceof WahaError && err.status === 404) return null;
    throw err;
  }
}

// Teste local (WAHA em Docker no Mac + next dev): WAHA_WEBHOOK_URL=
// http://host.docker.internal:3000/api/webhooks/waha. Em produção fica vazio.
const webhookUrl = () => process.env.WAHA_WEBHOOK_URL || `${APP_URL}/api/webhooks/waha`;

// Segredo do HMAC dos webhooks. Sem ele a sessão nasceria sem assinatura e
// o /api/webhooks/waha recusaria TODOS os eventos (401) pra sempre: nenhuma
// resposta de cliente gravada, agente mudo, palavra de parada ignorada.
// Por isso: sem segredo, nem cria nem inicia (falha fechado, erro claro).
function requireWebhookSecret(): string {
  const secret = process.env.WAHA_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("WAHA_WEBHOOK_SECRET não configurado: a sessão não pode ser criada nem iniciada sem HMAC (o webhook recusaria todos os eventos). Defina a variável na Vercel e tente de novo.");
  return secret;
}

// Webhook da sessão aponta pro Respondo, com HMAC, só os eventos que usamos.
function sessionConfig() {
  return {
    webhooks: [
      {
        url: webhookUrl(),
        events: ["message", "message.ack", "session.status"],
        hmac: { key: requireWebhookSecret() },
        retries: { policy: "exponential", delaySeconds: 2, attempts: 5 },
      },
    ],
  };
}

// A sessão que já existe no WAHA aponta pro nosso webhook COM HMAC? Sessão
// criada antes de definir o segredo (ou apontando pra outra URL) precisa
// ter a configuração reaplicada.
function webhookConfigured(session: WahaSession): boolean {
  const hooks = (session.config as { webhooks?: unknown } | undefined)?.webhooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (!h || typeof h !== "object") return false;
    const { url, hmac } = h as { url?: unknown; hmac?: unknown };
    return url === webhookUrl() && Boolean(hmac && typeof hmac === "object" && (hmac as { key?: unknown }).key);
  });
}

// Cria (se não existir) e inicia a sessão. Depois disso o status fica
// SCAN_QR_CODE até alguém ler o QR no celular da marca. Sessão existente
// sem o webhook assinado ganha a configuração de novo (PUT) e, se estava
// rodando, é reiniciada pra configuração valer.
export async function ensureSession(name: string): Promise<WahaSession> {
  const config = sessionConfig();
  const existing = await getSession(name);
  if (!existing) {
    return call<WahaSession>("POST", "/api/sessions", { name, start: true, config });
  }
  if (!webhookConfigured(existing)) {
    try {
      await call("PUT", `/api/sessions/${encodeURIComponent(name)}`, { config });
      if (existing.status === "WORKING" || existing.status === "STARTING") await call("POST", `/api/sessions/${encodeURIComponent(name)}/restart`);
    } catch (err) {
      throw new Error(`a sessão ${name} está sem o webhook assinado (HMAC) e não consegui reaplicar a configuração: ${err instanceof Error ? err.message : String(err)}. Pare, apague e recrie a sessão.`);
    }
  }
  if (existing.status === "STOPPED" || existing.status === "FAILED") {
    await call("POST", `/api/sessions/${encodeURIComponent(name)}/start`);
  }
  return (await getSession(name)) ?? existing;
}

export const stopSession = (name: string) => call("POST", `/api/sessions/${encodeURIComponent(name)}/stop`);
export const restartSession = (name: string) => call("POST", `/api/sessions/${encodeURIComponent(name)}/restart`);
export const logoutSession = (name: string) => call("POST", `/api/sessions/${encodeURIComponent(name)}/logout`);

// PNG do QR code (pra mostrar na tela "Minhas lojas" e ler com o celular).
export const getQrPng = (name: string) => call<Buffer>("GET", `/api/${encodeURIComponent(name)}/auth/qr?format=image`, undefined, "image/png");

// Alternativa ao QR: código de pareamento digitado no celular.
export const requestPairingCode = (name: string, phoneE164: string) => call<{ code: string }>("POST", `/api/${encodeURIComponent(name)}/auth/request-code`, { phoneNumber: phoneE164.replace(/\D/g, "") });

export const getMe = (name: string) => call<{ id: string; pushName?: string } | null>("GET", `/api/sessions/${encodeURIComponent(name)}/me`);

// --- Contatos ----------------------------------------------------------------

// O número tem WhatsApp? Devolve o chatId certo (obrigatório pra Brasil).
export async function checkNumber(session: string, phoneE164: string): Promise<{ exists: boolean; chatId: string | null }> {
  const r = await call<{ numberExists: boolean; chatId?: string | null }>("GET", `/api/contacts/check-exists?phone=${phoneE164.replace(/\D/g, "")}&session=${encodeURIComponent(session)}`);
  return { exists: Boolean(r.numberExists), chatId: r.chatId ?? (r.numberExists ? chatIdFromPhone(phoneE164) : null) };
}

// Chat "@lid" (id anônimo que o WhatsApp usa pra alguns contatos) → telefone
// E.164, pelo mapa que o WAHA guarda na sessão. null quando não conhece.
export async function phoneFromLid(session: string, lid: string): Promise<string | null> {
  const id = lid.replace(/@lid$/i, "");
  if (!id) return null;
  try {
    const r = await call<{ pn?: string | null; phoneNumber?: string | null; chatId?: string | null } | null>("GET", `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(id)}`);
    const pn = r?.pn ?? r?.phoneNumber ?? r?.chatId ?? null;
    const digits = typeof pn === "string" ? pn.split("@")[0].split(":")[0].replace(/\D/g, "") : "";
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  } catch (err) {
    console.warn(`waha: não resolvi o lid ${id} na sessão ${session}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// --- Mensagens ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Tempo "digitando" proporcional ao texto, com variação, teto de 8s.
const typingDelay = (text: string) => Math.min(8000, Math.round((1500 + text.length * 35) * (0.7 + Math.random() * 0.6)));

function extractMessageId(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const r = res as { id?: unknown; key?: { id?: string } };
  if (typeof r.id === "string") return r.id;
  if (r.id && typeof r.id === "object" && "_serialized" in r.id) return String((r.id as { _serialized: unknown })._serialized);
  if (r.key?.id) return r.key.id;
  return null;
}

// Sequência que o WAHA recomenda pra parecer humano: visto → digitando →
// espera → para de digitar → envia. Erros em visto/digitando não impedem o envio.
export async function sendText(session: string, chatId: string, text: string, opts: { humanize?: boolean; linkPreview?: boolean } = {}): Promise<{ messageId: string | null; raw: unknown }> {
  if (opts.humanize !== false) {
    await call("POST", "/api/sendSeen", { session, chatId }).catch(() => null);
    await call("POST", "/api/startTyping", { session, chatId }).catch(() => null);
    await sleep(typingDelay(text));
    await call("POST", "/api/stopTyping", { session, chatId }).catch(() => null);
  }
  const raw = await call("POST", "/api/sendText", { session, chatId, text, linkPreview: opts.linkPreview ?? true });
  return { messageId: extractMessageId(raw), raw };
}

// Imagem por URL pública (JPEG funciona melhor; PNG/WebP converter antes).
export async function sendImage(session: string, chatId: string, imageUrl: string, caption?: string): Promise<{ messageId: string | null; raw: unknown }> {
  const raw = await call("POST", "/api/sendImage", { session, chatId, file: { mimetype: "image/jpeg", url: imageUrl, filename: "image.jpg" }, caption });
  return { messageId: extractMessageId(raw), raw };
}

// Payloads dos webhooks que tratamos (formato pode variar por engine; só
// usamos o que é comum a todos).
export interface WahaWebhookEvent {
  event: string;
  session: string;
  me?: { id: string; pushName?: string } | null;
  payload: Record<string, unknown>;
  timestamp?: number;
}
