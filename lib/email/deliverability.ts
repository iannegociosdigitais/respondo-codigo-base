// Entregabilidade do e-mail de marketing (recuperação de carrinho e
// pós-compra): DNS do remetente (SPF/DKIM/DMARC), lint do conteúdo, rampa de
// aquecimento, saúde (bounce/reclamação) e o relatório da aba
// "Entregabilidade". Tudo tolerante: DNS fora do ar, SES sem credencial ou
// tabela ausente nunca derrubam o cron; na dúvida a resposta é "não está ok"
// (falhar fechado), nunca "ok".
//
// A lógica de DNS e a classificação de provedor do destinatário foram copiadas
// de app/api/deliverability/route.ts (uma rota não exporta funções).
import { promises as dns } from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RECOVERY_MISSING_TABLE, type RecoverySettings } from "@/lib/recovery/types";
import { resendConfigured } from "@/lib/email/resend";

export type EmailProvider = RecoverySettings["email_provider"];
export type DmarcPolicy = "none" | "quarantine" | "reject";

// Registro que precisa existir no DNS para o remetente ficar ok.
export interface DnsRecordNeeded {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  note: string;
}

export interface SenderDns {
  domain: string;
  spf: string | null;
  dkim: boolean;
  dkimSelectors: string[];
  dmarc: string | null;
  dmarcPolicy: DmarcPolicy | null;
  ok: boolean;
  problems: string[];
  // Extras (sempre preenchidos por checkSenderDns; opcionais no tipo para
  // quem monta um SenderDns à mão com só os 8 campos da spec).
  spfHost?: string | null; // onde o SPF foi achado (domínio, send.<dom> ou bounce.<dom>)
  dmarcHost?: string | null; // _dmarc.<dom> ou _dmarc.<domínio organizacional>
  dkimSource?: "dns" | "ses" | null;
  hints?: string[]; // avisos que não impedem o envio
  needed?: DnsRecordNeeded[]; // registros que precisam existir
  checkedAt?: string;
  fromCache?: boolean;
}

export interface EmailHealth {
  sent24h: number;
  bounced24h: number; // só bounces PERMANENTES (os transitórios vão em bouncedSoft24h)
  bouncedSoft24h?: number;
  complained24h: number;
  bounceRate: number | null;
  complaintRate: number | null;
  action: "ok" | "pausar" | "alertar";
  reason: string | null;
}

// Forma esperada do que o módulo "ses" exporta em lib/email/ses.ts. Lido por
// import dinâmico: sem o arquivo ou sem credencial, tudo vira null.
export interface SesAccountStatus {
  sendingEnabled: boolean;
  enforcementStatus: string | null;
  dailyQuota: number | null;
  sentLast24h: number | null;
  maxSendRate: number | null;
  productionAccess: boolean;
  vdmEnabled: boolean;
}
export interface SesIdentityStatus {
  verified: boolean;
  dkimStatus: string | null;
  mailFromStatus: string | null;
}
type SesModule = {
  getSesAccountStatus?: () => Promise<SesAccountStatus | null>;
  getSesIdentityStatus?: (domain: string) => Promise<SesIdentityStatus | null>;
};

export const sesEnvConfigured = () => Boolean(process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

async function loadSes(): Promise<SesModule | null> {
  try {
    // O arquivo é do módulo "ses" e pode ainda não existir quando este aqui
    // compila: o ts-ignore cobre só a ausência (com o arquivo presente, o
    // caminho literal é empacotado normalmente). Sem ele, cai no catch.
    // @ts-ignore módulo escrito por outro agente
    return (await import("@/lib/email/ses")) as unknown as SesModule;
  } catch {
    return null;
  }
}

// Status da conta SES: null quando o módulo não existe, não há credencial ou a
// AWS recusou. Nunca lança.
export async function sesAccountStatusSafe(): Promise<SesAccountStatus | null> {
  if (!sesEnvConfigured()) return null;
  try {
    const mod = await loadSes();
    if (!mod?.getSesAccountStatus) return null;
    return (await mod.getSesAccountStatus()) ?? null;
  } catch {
    return null;
  }
}

export async function sesIdentityStatusSafe(domain: string): Promise<SesIdentityStatus | null> {
  if (!sesEnvConfigured()) return null;
  try {
    const mod = await loadSes();
    if (!mod?.getSesIdentityStatus) return null;
    return (await mod.getSesIdentityStatus(domain)) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. DNS do remetente
// ---------------------------------------------------------------------------

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}
async function cname(name: string): Promise<string[]> {
  try {
    return await dns.resolveCname(name);
  } catch {
    return [];
  }
}

// Seletores de DKIM conhecidos: os da rota antiga + Resend (resend, rs1, rs2)
// + os mais comuns. Os 3 CNAMEs do SES (<token>._domainkey) não são
// previsíveis: para eles a resposta vem de getSesIdentityStatus.
const DKIM_SELECTORS = ["resend", "rs1", "rs2", "hostingermail-a", "hostingermail1", "google", "default", "selector1", "selector2", "k1", "k2", "s1", "s2", "mail", "dkim"];

// Sufixos públicos de dois níveis mais prováveis aqui (Israel, Brasil,
// Europa). Serve só para achar o domínio organizacional do DMARC.
const TWO_LEVEL_TLDS = new Set(["co.il", "org.il", "net.il", "ac.il", "com.br", "net.br", "org.br", "co.uk", "org.uk", "com.au", "co.jp", "co.nz", "com.tr", "com.mx", "co.za", "com.ar", "com.pl"]);
export function organizationalDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const n = TWO_LEVEL_TLDS.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-n).join(".");
}

// "Monique da Olavita <monique@mail.x.com>" ou "monique@mail.x.com" → domínio.
export function senderDomain(fromEmail: string): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(fromEmail ?? "");
  return m ? m[1].toLowerCase().replace(/\.$/, "") : null;
}

const DNS_CACHE_MS = 10 * 60 * 1000;
const dnsCache = new Map<string, { at: number; value: SenderDns }>();

export interface CheckSenderDnsOptions {
  // provedor da loja: decide onde procurar SPF e se vale consultar o SES
  provider?: EmailProvider | null;
  // ignora o cache de 10 min (botão "Checar DNS agora")
  force?: boolean;
}

export async function checkSenderDns(fromEmail: string, opts: CheckSenderDnsOptions = {}): Promise<SenderDns> {
  const domain = senderDomain(fromEmail);
  const checkedAt = new Date().toISOString();
  if (!domain) {
    return { domain: String(fromEmail ?? ""), spf: null, dkim: false, dkimSelectors: [], dmarc: null, dmarcPolicy: null, ok: false, problems: ["Remetente inválido: configure um e-mail de remetente (ex.: monique@mail.marca.com)."], spfHost: null, dmarcHost: null, dkimSource: null, hints: [], needed: [], checkedAt, fromCache: false };
  }
  const provider = opts.provider ?? null;
  const key = `${domain}|${provider ?? "?"}`;
  const cached = dnsCache.get(key);
  if (cached && !opts.force && Date.now() - cached.at < DNS_CACHE_MS) return { ...cached.value, fromCache: true };
  let value: SenderDns;
  try {
    value = await lookupSenderDns(domain, provider, checkedAt);
  } catch (e) {
    // DNS fora do ar = não dá para afirmar nada = não ok (falhar fechado).
    value = { domain, spf: null, dkim: false, dkimSelectors: [], dmarc: null, dmarcPolicy: null, ok: false, problems: [`Não foi possível consultar o DNS: ${e instanceof Error ? e.message : String(e)}`], spfHost: null, dmarcHost: null, dkimSource: null, hints: [], needed: [], checkedAt, fromCache: false };
  }
  dnsCache.set(key, { at: Date.now(), value });
  return value;
}

const SPF_INCLUDE = "v=spf1 include:amazonses.com ~all"; // Resend e SES usam a mesma inclusão

async function lookupSenderDns(domain: string, provider: EmailProvider | null, checkedAt: string): Promise<SenderDns> {
  const org = organizationalDomain(domain);
  const [spfSelf, spfSend, spfBounce, dmarcSelf, dmarcOrg, dkimHits] = await Promise.all([
    txt(domain),
    txt(`send.${domain}`),
    txt(`bounce.${domain}`),
    txt(`_dmarc.${domain}`),
    org !== domain ? txt(`_dmarc.${org}`) : Promise.resolve([] as string[]),
    Promise.all(DKIM_SELECTORS.map(async (sel) => {
      const host = `${sel}._domainkey.${domain}`;
      const [t, c] = await Promise.all([txt(host), cname(host)]);
      return t.some((v) => /(^|;)\s*p=/i.test(v)) || c.length > 0 ? sel : null;
    })),
  ]);
  const pickSpf = (list: string[]) => list.find((t) => /^v=spf1\b/i.test(t.trim())) ?? null;
  const pickDmarc = (list: string[]) => list.find((t) => /^v=DMARC1\b/i.test(t.trim())) ?? null;

  // SPF: quem recebe checa o domínio do Return-Path, que no Resend é
  // send.<dom> e no SES (MAIL FROM personalizado) é bounce.<dom>. Vale
  // qualquer um dos três.
  let spf: string | null = null;
  let spfHost: string | null = null;
  for (const [host, list] of [[domain, spfSelf], [`send.${domain}`, spfSend], [`bounce.${domain}`, spfBounce]] as Array<[string, string[]]>) {
    const found = pickSpf(list);
    if (found) {
      spf = found;
      spfHost = host;
      break;
    }
  }

  // DMARC: sem registro no subdomínio, vale o do domínio organizacional
  // (política dos subdomínios = sp=, senão p=).
  let dmarc = pickDmarc(dmarcSelf);
  let dmarcHost: string | null = dmarc ? `_dmarc.${domain}` : null;
  let dmarcPolicy: DmarcPolicy | null = null;
  if (!dmarc && org !== domain) {
    dmarc = pickDmarc(dmarcOrg);
    dmarcHost = dmarc ? `_dmarc.${org}` : null;
  }
  if (dmarc) {
    const sp = dmarcHost === `_dmarc.${org}` && org !== domain ? /(?:^|;)\s*sp=(\w+)/i.exec(dmarc)?.[1] : null;
    const p = /(?:^|;)\s*p=(\w+)/i.exec(dmarc)?.[1] ?? null;
    const raw = (sp ?? p ?? "").toLowerCase();
    dmarcPolicy = raw === "none" || raw === "quarantine" || raw === "reject" ? raw : null;
  }

  // DKIM: TXT com p= ou CNAME em algum seletor conhecido; senão, se o
  // provedor é o SES (ou não se sabe), a identidade no SES com DKIM SUCCESS.
  const dkimSelectors = dkimHits.filter((s): s is string => Boolean(s));
  let dkim = dkimSelectors.length > 0;
  let dkimSource: SenderDns["dkimSource"] = dkim ? "dns" : null;
  let sesIdentity: SesIdentityStatus | null = null;
  if (!dkim && provider !== "resend" && sesEnvConfigured()) {
    sesIdentity = await sesIdentityStatusSafe(domain);
    if (sesIdentity && String(sesIdentity.dkimStatus ?? "").toUpperCase() === "SUCCESS") {
      dkim = true;
      dkimSource = "ses";
      dkimSelectors.push("amazonses");
    }
  }

  const problems: string[] = [];
  const hints: string[] = [];
  const needed: DnsRecordNeeded[] = [];
  if (!spf) {
    if (provider === "ses") {
      problems.push(`SPF ausente: crie um TXT em bounce.${domain} com "${SPF_INCLUDE}" e configure bounce.${domain} como MAIL FROM da identidade no SES.`);
      needed.push({ type: "TXT", name: `bounce.${domain}`, value: SPF_INCLUDE, note: "SPF do MAIL FROM personalizado do Amazon SES" });
    } else if (provider === "resend") {
      problems.push(`SPF ausente: crie o TXT em send.${domain} com "${SPF_INCLUDE}" (o Resend mostra esse registro em Domains).`);
      needed.push({ type: "TXT", name: `send.${domain}`, value: SPF_INCLUDE, note: "SPF do Return-Path do Resend" });
    } else {
      problems.push(`SPF ausente: crie um TXT em ${domain} (ou em send./bounce.${domain}) com "${SPF_INCLUDE}".`);
      needed.push({ type: "TXT", name: domain, value: SPF_INCLUDE, note: "SPF do remetente" });
    }
  }
  if (!dkim) {
    if (provider === "ses") {
      problems.push(`DKIM ausente: a identidade ${domain} no Amazon SES ainda não tem o DKIM verificado${sesIdentity ? ` (status ${sesIdentity.dkimStatus ?? "desconhecido"})` : sesEnvConfigured() ? " (identidade não encontrada na conta)" : " (credencial da AWS não configurada aqui)"}. Crie os 3 CNAMEs <token>._domainkey.${domain} que o SES mostra em Identities.`);
      needed.push({ type: "CNAME", name: `<token>._domainkey.${domain}`, value: "<token>.dkim.amazonses.com", note: "3 registros (Easy DKIM) com os tokens que o SES mostra na identidade" });
    } else if (provider === "resend") {
      problems.push(`DKIM ausente: crie o TXT resend._domainkey.${domain} com o valor "p=..." que o Resend mostra em Domains.`);
      needed.push({ type: "TXT", name: `resend._domainkey.${domain}`, value: "p=<chave pública mostrada pelo Resend>", note: "DKIM do Resend" });
    } else {
      problems.push(`DKIM ausente: nenhum seletor conhecido (${DKIM_SELECTORS.slice(0, 3).join(", ")}…) em _domainkey.${domain}${sesEnvConfigured() ? " e a identidade no SES não tem DKIM verificado" : ""}.`);
      needed.push({ type: "TXT", name: `resend._domainkey.${domain}`, value: "p=<chave pública do provedor>", note: "DKIM (Resend) ou os 3 CNAMEs do Amazon SES" });
    }
  }
  if (!dmarc) {
    problems.push(`DMARC ausente: crie um TXT em _dmarc.${org} com "v=DMARC1; p=none; rua=mailto:dmarc@${org}" (vale para todos os subdomínios).`);
    needed.push({ type: "TXT", name: `_dmarc.${org}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${org}`, note: "DMARC do domínio (começa em p=none, só monitora)" });
  } else {
    if (dmarcPolicy === "none") hints.push(`DMARC em p=none (só monitora). Quando SPF e DKIM estiverem passando, suba para p=quarantine em ${dmarcHost}.`);
    if (!/rua=/i.test(dmarc)) hints.push("DMARC sem rua=: você não recebe os relatórios de quem está usando o domínio.");
  }
  if (dkimSource === "ses" && provider == null) hints.push("DKIM verificado só na Amazon SES: se a loja enviar pelo Resend, o Resend precisa do próprio registro resend._domainkey.");
  if (spf && spfHost === domain && provider === "resend") hints.push(`O SPF está em ${domain}; o Resend checa send.${domain}. Confira o registro em Domains no Resend.`);

  return { domain, spf, dkim, dkimSelectors, dmarc, dmarcPolicy, ok: Boolean(spf) && dkim && Boolean(dmarc), problems, spfHost, dmarcHost, dkimSource, hints, needed, checkedAt, fromCache: false };
}

// ---------------------------------------------------------------------------
// 2. Lint do conteúdo
// ---------------------------------------------------------------------------

export interface LintInput {
  subject: string;
  html: string;
  text?: string | null;
  language?: string | null;
  // cabeçalhos que vão junto (List-Unsubscribe conta como descadastro)
  headers?: Record<string, string> | null;
}
export interface LintResult {
  score: number;
  warnings: string[];
}

const SHORTENERS = /https?:\/\/(?:www\.)?(bit\.ly|tinyurl\.com|cutt\.ly|t\.co|goo\.gl|is\.gd|rebrand\.ly|ow\.ly|buff\.ly|shorturl\.at|rb\.gy)\b/i;
const UNSUB_WORDS = /unsubscribe|opt[- ]?out|descadastr|cancelar (?:a )?inscri|désabonn|désinscri|se désinscrire|הסר|להסרה|הסרה|leiratkoz|dezabon|abonelik|отпис|wypisz|avsluta prenumeration/i;
const SPAM_WORDS: Record<string, string[]> = {
  en: ["free money", "100% free", "act now", "limited time", "winner", "guaranteed", "risk-free", "no obligation", "click here", "urgent", "miracle", "lose weight fast", "earn money", "$$$"],
  pt: ["ganhe dinheiro", "clique aqui", "urgente", "promoção imperdível", "garantido", "milagre", "renda extra", "100% grátis", "grátis!!!"],
  fr: ["cliquez ici", "urgent", "gagnez de l'argent", "garanti", "miracle", "offre limitée", "sans risque", "100% gratuit"],
  he: ["לחץ כאן", "דחוף", "מובטח", "כסף קל", "זכית", "הצעה מוגבלת", "חינם לגמרי", "נס"],
};

export function stripHtml(html: string): string {
  return (html ?? "")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function lintEmailContent(input: LintInput): LintResult {
  const subject = (input.subject ?? "").trim();
  const html = input.html ?? "";
  const text = (input.text ?? "").trim();
  const lang = (input.language ?? "").toLowerCase().slice(0, 2);
  const warnings: string[] = [];
  let penalty = 0;
  const warn = (msg: string, points: number) => {
    warnings.push(msg);
    penalty += points;
  };

  // Assunto
  if (!subject) warn("Assunto vazio.", 20);
  if (subject.length > 70) warn(`Assunto com ${subject.length} caracteres (acima de 70 corta no celular).`, 10);
  const letters = subject.replace(/[^\p{L}]/gu, "");
  const latinLetters = subject.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (latinLetters.length >= 4 && latinLetters === latinLetters.toUpperCase() && letters.length === latinLetters.length) warn("Assunto todo em maiúsculas.", 15);
  if (/!!!/.test(subject) || /\bGRÁTIS\b|\bFREE\b/.test(subject) || /\$\$\$/.test(subject)) warn("Assunto com \"!!!\", \"GRÁTIS\", \"FREE\" ou \"$$$\": cara de spam.", 15);

  // Links
  const hrefs: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hrefs.push(m[1]);
  const external = [...new Set(hrefs.filter((h) => /^https?:\/\//i.test(h) && !/\/api\/public\/u\//.test(h)))];
  if (external.length > 3) warn(`${external.length} links diferentes (o ideal é até 3: carrinho, descadastro e no máximo um extra).`, 10);
  const short = hrefs.find((h) => SHORTENERS.test(h));
  if (short) warn(`Link com encurtador (${/\/\/(?:www\.)?([^/]+)/.exec(short)?.[1] ?? short}): filtros de spam bloqueiam.`, 20);

  // Texto x imagem
  const visible = stripHtml(html);
  const hasImg = /<img\b/i.test(html);
  if (hasImg && visible.length < 200) warn(`Imagem com pouco texto (${visible.length} caracteres; o mínimo bom é 200).`, 15);
  else if (!hasImg && visible.length < 80) warn("Corpo quase vazio.", 10);

  // Descadastro
  const headerUnsub = Object.keys(input.headers ?? {}).some((k) => k.toLowerCase() === "list-unsubscribe");
  const hasUnsub = headerUnsub || /\/api\/public\/u\//.test(html) || UNSUB_WORDS.test(visible) || UNSUB_WORDS.test(html);
  if (!hasUnsub) warn("Sem link de descadastro (nem cabeçalho List-Unsubscribe): Gmail e Yahoo marcam como spam.", 25);

  // Variável que não foi substituída
  if (/\{\{\s*[\w.]+\s*\}\}/.test(subject) || /\{\{\s*[\w.]+\s*\}\}/.test(visible)) warn("Variável {{...}} sem substituir no texto.", 20);

  // Palavras de spam no idioma
  const lists = lang && SPAM_WORDS[lang] ? [SPAM_WORDS[lang], SPAM_WORDS.en] : Object.values(SPAM_WORDS);
  const haystack = `${subject}\n${visible}\n${text}`.toLowerCase();
  const found = [...new Set(lists.flat().filter((w) => haystack.includes(w.toLowerCase())))];
  if (found.length) warn(`Palavras que filtros de spam marcam: ${found.slice(0, 6).join(", ")}.`, Math.min(20, found.length * 5));

  // Tamanho e versão texto
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > 100 * 1024) warn(`HTML com ${Math.round(bytes / 1024)} KB (o Gmail corta acima de 102 KB).`, 10);
  if (!text) warn("Sem versão em texto puro (multipart/alternative).", 5);

  return { score: Math.max(0, Math.min(100, 100 - penalty)), warnings };
}

// ---------------------------------------------------------------------------
// 3. Rampa de aquecimento
// ---------------------------------------------------------------------------

export const WARMUP_START = 30;
export const WARMUP_FACTOR = 1.5;
export const WARMUP_STAGE_DAYS = 3;
export const WARMUP_BOUNCE_MAX = 0.02;

export interface WarmupStats {
  bounceRate?: number | null;
  complaintRate?: number | null;
}
export interface WarmupInfo {
  cap: number; // teto efetivo de hoje
  ramp: number; // valor da rampa (antes do min com daily_cap_email)
  dailyCap: number; // settings.daily_cap_email
  stage: number; // estágio em vigor (0 = 30/dia)
  days: number; // dias desde warmup_since (ou production_since)
  productionSince: string | null;
  frozen: boolean; // saúde ruim nas últimas 24 h: não subiu
}

// Rampa: 30 no dia em que o test_mode foi desligado, ×1,5 a cada 3 dias até o
// teto configurado. Com bounce ≥ 2% ou qualquer reclamação nas últimas 24 h a
// rampa não sobe: como não há estado guardado, "congelar" aqui é voltar ao
// estágio anterior (nunca aplicar o último aumento enquanto estiver ruim).
export function warmupInfo(settings: Pick<RecoverySettings, "daily_cap_email" | "production_since" | "warmup_since">, stats?: WarmupStats | null): WarmupInfo {
  const dailyCap = Math.max(0, Number(settings.daily_cap_email ?? 100) || 0);
  // warmup_since (coluna da migration 0019) é a data ORIGINAL do aquecimento e
  // nunca reinicia; production_since reinicia a cada saída do modo de teste.
  // Coluna ausente (0019 ainda não rodou) = usa production_since.
  const baseDate = settings.warmup_since ?? settings.production_since;
  const since = baseDate ? new Date(baseDate) : null;
  if (!since || Number.isNaN(since.getTime())) {
    return { cap: Math.min(dailyCap, WARMUP_START), ramp: WARMUP_START, dailyCap, stage: 0, days: 0, productionSince: null, frozen: false };
  }
  const days = Math.max(0, Math.floor((Date.now() - since.getTime()) / 86400000));
  const stage = Math.floor(days / WARMUP_STAGE_DAYS);
  const bounce = stats?.bounceRate ?? 0;
  const complaint = stats?.complaintRate ?? 0;
  const healthy = bounce < WARMUP_BOUNCE_MAX && complaint <= 0;
  const effectiveStage = healthy ? stage : Math.max(0, stage - 1);
  const ramp = Math.round(WARMUP_START * WARMUP_FACTOR ** effectiveStage);
  return { cap: Math.min(dailyCap, ramp), ramp, dailyCap, stage: effectiveStage, days, productionSince: since.toISOString(), frozen: !healthy && stage > 0 };
}

export function warmupCap(settings: Pick<RecoverySettings, "daily_cap_email" | "production_since" | "warmup_since">, stats?: WarmupStats | null): number {
  return warmupInfo(settings, stats).cap;
}

// ---------------------------------------------------------------------------
// 4. Saúde (últimas 24 h)
// ---------------------------------------------------------------------------

export const HEALTH_MIN_SENT = 20; // abaixo disso: sem volume pra decidir (ok)
export const HEALTH_MIN_SENT_PAUSE = 100; // pausar por TAXA só com pelo menos 100 envios em 24 h (fora o piso absoluto abaixo)
export const HEALTH_BOUNCE_PAUSE = 0.04; // AUP do Resend
export const HEALTH_COMPLAINT_PAUSE = 0.0008; // 0,08%
export const HEALTH_COMPLAINT_PAUSE_ABS = 3; // 3 reclamações pausam mesmo com pouco volume
export const HEALTH_BOUNCE_ALERT = 0.02;
// Piso absoluto de bounce (vale com pouco volume, ex.: aquecimento de 30 a
// 68/dia, em que HEALTH_MIN_SENT_PAUSE nunca é atingido): com pelo menos 30
// enviados, 3 bounces permanentes E taxa de 3% em 24 h, pausa.
export const HEALTH_BOUNCE_FLOOR_SENT = 30;
export const HEALTH_BOUNCE_FLOOR_ABS = 3;
export const HEALTH_BOUNCE_FLOOR_RATE = 0.03;

// Só o bounce PERMANENTE conta (endereço que não existe). Transitório (caixa
// cheia, servidor fora) e indeterminado não entram. Formato gravado pelos
// webhooks em recovery_events.detail.bounce: Resend { type, subType, message },
// SES { type: bounceType, subType, diagnostic }. type = 'Permanent' (ou 'hard').
// Sem detail.bounce.type NÃO conta como permanente: sem prova de que o
// endereço é inválido, não pausa o canal inteiro por causa disso.
export function isPermanentBounce(detail: unknown): boolean {
  const bounce = (detail as { bounce?: { type?: unknown; bounceType?: unknown } | null } | null)?.bounce;
  const type = bounce?.type ?? bounce?.bounceType;
  return typeof type === "string" && /^(permanent|hard)/i.test(type.trim());
}

export async function evaluateEmailHealth(admin: SupabaseClient, storeId: string): Promise<EmailHealth> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await admin
    .from("recovery_events")
    .select("type, detail")
    .eq("store_id", storeId)
    .eq("channel", "email")
    .eq("is_test", false)
    .in("type", ["sent", "bounced", "complained"])
    .gte("created_at", since)
    .limit(20000);
  if (error) {
    // Sem conseguir medir, não pausa (seria destrutivo) mas avisa.
    return { sent24h: 0, bounced24h: 0, complained24h: 0, bounceRate: null, complaintRate: null, action: "alertar", reason: `Não foi possível avaliar a saúde do e-mail: ${error.message}` };
  }
  let sent = 0;
  let bounced = 0; // só permanentes
  let softBounced = 0; // transitórios/indeterminados (informativo)
  let complained = 0;
  for (const r of (data ?? []) as Array<{ type: string; detail?: unknown }>) {
    if (r.type === "sent") sent += 1;
    else if (r.type === "bounced") {
      if (isPermanentBounce(r.detail)) bounced += 1;
      else softBounced += 1;
    } else if (r.type === "complained") complained += 1;
  }
  return classifyEmailHealth({ sent, bounced, softBounced, complained });
}

// Decisão (pura) a partir das contagens de 24 h. Separada da consulta para
// poder ser testada.
export function classifyEmailHealth(counts: { sent: number; bounced: number; softBounced?: number; complained: number }): EmailHealth {
  const { sent, bounced, complained } = counts;
  const softBounced = counts.softBounced ?? 0;
  const bounceRate = sent ? bounced / sent : null;
  const complaintRate = sent ? complained / sent : null;
  const pctText = (v: number | null) => (v == null ? "·" : `${(v * 100).toFixed(2).replace(".", ",")}%`);
  const base = { sent24h: sent, bounced24h: bounced, bouncedSoft24h: softBounced, complained24h: complained, bounceRate, complaintRate };
  // Reclamações absolutas: 3 em 24 h pausam mesmo antes de haver volume.
  if (complained >= HEALTH_COMPLAINT_PAUSE_ABS) {
    return { ...base, action: "pausar", reason: `${complained} reclamações de spam nas últimas 24 h (limite ${HEALTH_COMPLAINT_PAUSE_ABS}): e-mail pausado.` };
  }
  // Piso absoluto de bounce (aquecimento): 30+ enviados, 3+ bounces
  // permanentes e taxa de 3%+ pausam mesmo abaixo de HEALTH_MIN_SENT_PAUSE.
  if (sent >= HEALTH_BOUNCE_FLOOR_SENT && bounced >= HEALTH_BOUNCE_FLOOR_ABS && (bounceRate ?? 0) >= HEALTH_BOUNCE_FLOOR_RATE) {
    return { ...base, action: "pausar", reason: `${bounced} bounces permanentes em ${sent} enviados nas últimas 24 h (${pctText(bounceRate)}; piso de ${HEALTH_BOUNCE_FLOOR_ABS} bounces e 3%): e-mail pausado.` };
  }
  if (sent < HEALTH_MIN_SENT) {
    return { ...base, action: "ok", reason: `Menos de ${HEALTH_MIN_SENT} enviados nas últimas 24 h (${sent}): sem volume para decidir.` };
  }
  // Com 20 a 99 envios a taxa oscila demais: no máximo alerta, nunca pausa
  // (exceto pelo piso absoluto acima).
  const canPause = sent >= HEALTH_MIN_SENT_PAUSE;
  const lowVolume = `com ${sent} envios (menos de ${HEALTH_MIN_SENT_PAUSE}) só alerta`;
  if ((bounceRate ?? 0) >= HEALTH_BOUNCE_PAUSE) {
    return canPause
      ? { ...base, action: "pausar", reason: `Bounce permanente de ${pctText(bounceRate)} nas últimas 24 h (limite 4%): e-mail pausado.` }
      : { ...base, action: "alertar", reason: `Bounce permanente de ${pctText(bounceRate)} nas últimas 24 h (limite 4%), ${lowVolume}: confira a lista.` };
  }
  if ((complaintRate ?? 0) >= HEALTH_COMPLAINT_PAUSE) {
    return canPause
      ? { ...base, action: "pausar", reason: `Reclamação de spam em ${pctText(complaintRate)} nas últimas 24 h (limite 0,08%): e-mail pausado.` }
      : { ...base, action: "alertar", reason: `Reclamação de spam em ${pctText(complaintRate)} nas últimas 24 h (limite 0,08%), ${lowVolume}: confira o conteúdo e a lista.` };
  }
  if (complained > 0) {
    return { ...base, action: "alertar", reason: `${complained} reclamação(ões) de spam nas últimas 24 h: acompanhe.` };
  }
  if ((bounceRate ?? 0) >= HEALTH_BOUNCE_ALERT) {
    return { ...base, action: "alertar", reason: `Bounce permanente de ${pctText(bounceRate)} nas últimas 24 h (acima de 2%): confira a lista antes de continuar.` };
  }
  return { ...base, action: "ok", reason: null };
}

// ---------------------------------------------------------------------------
// 5. Relatório da aba Entregabilidade
// ---------------------------------------------------------------------------

// Classificação do provedor do destinatário (copiada de
// app/api/deliverability/route.ts).
export function recipientProvider(email: string): string {
  const d = (email.split("@")[1] ?? "").toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return "Gmail";
  if (/^walla\.(com|co\.il)$/.test(d)) return "Walla";
  if (/^(hotmail|outlook|live|msn)\./.test(d)) return "Hotmail / Outlook";
  if (/^(yahoo|ymail)\./.test(d)) return "Yahoo";
  if (/^(icloud|me|mac)\.com$/.test(d)) return "iCloud";
  if (/(orange|wanadoo|free|sfr|laposte|neuf|bbox)\.(fr|net)$/.test(d)) return "Provedores franceses";
  if (d.endsWith(".il") || /bezeqint|netvision|013/.test(d)) return "Israel (outros)";
  return "Outros";
}

export interface DayCounts { day: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number }
export interface ProviderCounts { provider: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number }
export interface DomainCounts { domain: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number }
export interface DeliverabilityRates { delivery: number | null; open: number | null; click: number | null; bounce: number | null; complaint: number | null; unsubscribe: number | null }
export interface SenderReport { storeId: string; store: string; fromEmail: string; provider: EmailProvider; dns: SenderDns }
export interface WarmupReport extends WarmupInfo { storeId: string; store: string; testMode: boolean }
export interface HealthReport extends EmailHealth { storeId: string; store: string; emailEnabled: boolean }

export interface DeliverabilityReport {
  days: number;
  storeId: string | null;
  migrationMissing: boolean;
  totals: { sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number; failed: number };
  byDay: DayCounts[];
  byProvider: ProviderCounts[];
  byDomain: DomainCounts[];
  rates: DeliverabilityRates;
  senders: SenderReport[];
  warmup: WarmupReport[];
  health: HealthReport[];
  providers: { resend: boolean; ses: boolean };
  ses: SesAccountStatus | null;
  generatedAt: string;
}

interface EventRow {
  recovery_id: string | null;
  run_id: string | null;
  store_id: string | null;
  step: number | null;
  type: string;
  provider: string | null;
  to_address: string | null;
  created_at: string;
}

const COUNTED_TYPES = new Set(["sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "failed"]);

export async function deliverabilityReport(admin: SupabaseClient, opts: { days: number; storeId?: string | null; forceDns?: boolean }): Promise<DeliverabilityReport> {
  const days = Math.min(Math.max(Math.floor(opts.days) || 30, 1), 180);
  const storeId = opts.storeId || null;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let evQuery = admin
    .from("recovery_events")
    .select("recovery_id, run_id, store_id, step, type, provider, to_address, created_at")
    .eq("channel", "email")
    .eq("is_test", false)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(20000);
  if (storeId) evQuery = evQuery.eq("store_id", storeId);
  let setQuery = admin.from("recovery_settings").select("*");
  if (storeId) setQuery = setQuery.eq("store_id", storeId);

  const [evRes, setRes, storesRes] = await Promise.all([evQuery, setQuery, admin.from("stores").select("id, name")]);
  const migrationMissing = Boolean((evRes.error && RECOVERY_MISSING_TABLE.test(evRes.error.message)) || (setRes.error && RECOVERY_MISSING_TABLE.test(setRes.error.message)));
  if (evRes.error && !migrationMissing) throw new Error(evRes.error.message);
  if (setRes.error && !migrationMissing) throw new Error(setRes.error.message);

  const storeName = new Map((storesRes.data ?? []).map((s) => [String(s.id), String(s.name ?? "")]));
  const events = (evRes.data ?? []) as EventRow[];
  const settings = (setRes.data ?? []) as RecoverySettings[];

  // Eventos de webhook (entregue/aberto/clicado/...) nem sempre trazem
  // provedor e destinatário: casa com o "sent" do mesmo alvo+passo.
  const keyOf = (e: EventRow) => `${e.recovery_id ?? e.run_id ?? "?"}:${e.step ?? 0}`;
  const sentIndex = new Map<string, { provider: string | null; to: string | null }>();
  for (const e of events) if (e.type === "sent") sentIndex.set(keyOf(e), { provider: e.provider, to: e.to_address });

  const byDay = new Map<string, DayCounts>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    byDay.set(d, { day: d, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 });
  }
  const byProvider = new Map<string, ProviderCounts>();
  const byDomain = new Map<string, DomainCounts>();
  const totals = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 };
  const seen = new Set<string>();

  for (const e of events) {
    if (!COUNTED_TYPES.has(e.type)) continue;
    const key = keyOf(e);
    // uma abertura/entrega por mensagem (o pixel dispara várias vezes)
    const dedupe = `${key}:${e.type}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const base = sentIndex.get(key);
    const provider = e.provider ?? base?.provider ?? "desconhecido";
    const to = e.to_address ?? base?.to ?? null;
    const type = e.type as keyof typeof totals;
    totals[type] += 1;
    if (type === "failed") continue;

    const day = byDay.get(e.created_at.slice(0, 10));
    if (day) day[type] += 1;

    const p = byProvider.get(provider) ?? byProvider.set(provider, { provider, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 }).get(provider)!;
    if (type !== "unsubscribed") p[type] += 1;

    if (to) {
      const label = recipientProvider(to);
      const d = byDomain.get(label) ?? byDomain.set(label, { domain: label, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 }).get(label)!;
      if (type !== "unsubscribed") d[type] += 1;
    }
  }

  // Entrega = enviados menos rejeitados (o "delivered" do webhook só existe
  // quando o provedor avisa; fica como confirmação, não como base da taxa).
  const landed = Math.max(0, totals.sent - totals.bounced);
  const rate = (n: number, d: number) => (d > 0 ? n / d : null);
  const rates: DeliverabilityRates = {
    delivery: rate(landed, totals.sent),
    open: rate(totals.opened, landed),
    click: rate(totals.clicked, landed),
    bounce: rate(totals.bounced, totals.sent),
    complaint: rate(totals.complained, totals.sent),
    unsubscribe: rate(totals.unsubscribed, totals.sent),
  };

  const nameOf = (id: string) => storeName.get(id) ?? id;
  const [health, senders, ses] = await Promise.all([
    Promise.all(settings.map(async (s) => ({ storeId: s.store_id, store: nameOf(s.store_id), emailEnabled: Boolean(s.email_enabled), ...(await evaluateEmailHealth(admin, s.store_id)) }))),
    Promise.all(settings.filter((s) => Boolean(s.from_email)).map(async (s) => ({ storeId: s.store_id, store: nameOf(s.store_id), fromEmail: String(s.from_email), provider: s.email_provider ?? "resend", dns: await checkSenderDns(String(s.from_email), { provider: s.email_provider ?? "resend", force: Boolean(opts.forceDns) }) }))),
    sesAccountStatusSafe(),
  ]);
  const warmup: WarmupReport[] = settings.map((s) => {
    const h = health.find((x) => x.storeId === s.store_id);
    return { storeId: s.store_id, store: nameOf(s.store_id), testMode: Boolean(s.test_mode), ...warmupInfo(s, h ? { bounceRate: h.bounceRate, complaintRate: h.complaintRate } : null) };
  });

  return {
    days,
    storeId,
    migrationMissing,
    totals,
    byDay: [...byDay.values()],
    byProvider: [...byProvider.values()].sort((a, b) => b.sent - a.sent),
    byDomain: [...byDomain.values()].sort((a, b) => b.sent - a.sent),
    rates,
    senders,
    warmup,
    health,
    providers: { resend: resendConfigured(), ses: sesEnvConfigured() },
    ses,
    generatedAt: new Date().toISOString(),
  };
}
