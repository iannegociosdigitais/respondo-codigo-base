// AGENTE VENDEDOR do WhatsApp (recuperação de carrinho, §4 da spec).
//
// Quando o cliente responde à régua, o webhook do WAHA chama
// handleInboundWhatsapp: espera 12 s (se chegarem várias mensagens seguidas,
// só a última responde), monta o contexto (loja, marca, carrinho, cupons,
// conhecimento, histórico), pede uma decisão à OpenAI e passa a resposta
// pelos guardrails (sem travessão, sem português, desconto só dos
// cadastrados, link obrigatório na oferta, 350 caracteres). Assunto de
// suporte vira handoff pra humano. Qualquer erro = needs_human e nada sai.
//
// decideAgentReply(context) é a parte pura (contexto → decisão), sem banco e
// sem envio, pra dar pra testar com um carrinho fictício.
import { isOwnerSandbox, sandboxSettings } from "@/lib/recovery/sandbox";
import { shortenLinks } from "@/lib/recovery/short-links";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordUsage } from "@/lib/ai/usage";
import { hasHebrew } from "@/lib/ai/lang";
import { stripDashes } from "@/lib/text/dashes";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { loadProducts, personaFor, routeProduct } from "@/lib/agent/products";
import { formatMoney } from "@/lib/forms/format";
import { customerAmount, langFromCountry } from "@/lib/forms/money";
import { APP_URL } from "@/lib/forms/token";
import { HOLD_LEGACY_COUPON_CARTS, hasLegacyCoupon, makeRecoveryToken, type RecoveryTokenPayload } from "@/lib/recovery/links";
import { chatIdFromPhone, normalizePhone } from "@/lib/recovery/phone";
import { isTimelockDetail, pickSession, restrictSession } from "@/lib/recovery/sessions";
import { canSend, displayFirstName, extraSavings, markPace, nominalPercent, paceConflict, paceFreeAt, quietFor, releasePacedClaim } from "@/lib/recovery/engine";
import { applyStop, checkPurchased, type StopCheck, type StoreShopifyAuth } from "@/lib/recovery/stop-rules";
import { FLOW_PRODUCT_STOP, isFlowProduct } from "@/lib/recovery/product-gate";
import { loadAllShopifyCreds } from "@/lib/agent/analyze";
import { extractOrderNumbers, findPaidOrderByHint } from "@/lib/shopify/orders";
import { decrypt } from "@/lib/crypto";
import { isAllowedNow, localParts, tzForCountry } from "@/lib/recovery/schedule";
import { sendText, wahaConfigured, WahaError } from "@/lib/whatsapp/waha";
import { alertRecipient, createAlert, findOpenAlert, resolveOpenAlerts, sendAlertEmail } from "@/lib/recovery/alerts";
import { RECOVERY_MISSING_TABLE, type RecoveryDiscount, type RecoveryKnowledge, type RecoveryRow, type RecoverySettings, type WhatsappMessageRow, type WhatsappSessionRow } from "@/lib/recovery/types";
import {
  MAX_REPLY_CHARS,
  PAID_CLAIM_RE,
  GUARANTEE_RE,
  isPaidClaim,
  testUnnegated,
  scriptStepsFromNotes,
  PAYMENT_NOT_FOUND,
  PAYMENT_NOT_FOUND_AFTER_HINT,
  STOP_CONFIRMATION_PT,
  classifyCustomerMessage,
  shownPercent,
  SUPPORT_HARD_RE,
  SUPPORT_TOPIC_RE,
  WAIT_PHRASE_PT,
  buildAgentInput,
  buildAgentInstructions,
  languageName,
  offerableDiscounts,
  stopConfirmation,
  pickWaitPhrase,
  waitPhrase,
  type AgentContext,
  type AgentDiscountOption,
  type AgentHistoryEntry,
} from "@/lib/recovery/agent-prompt";

// O modelo diz o percentual mostrado (15) ou o interno (5): os dois valem.
const matchDiscount = (d: AgentDiscountOption, p: number | null | undefined) => p != null && (d.percent === p || shownPercent(d) === p);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Modelo do VENDEDOR: o forte (Ian, 10/10: "o agente está burro"). O suporte
// por e-mail continua no OPENAI_MODEL; aqui são poucas conversas por dia e
// cada resposta decide uma venda. RECOVERY_AGENT_MODEL no ambiente sobrepõe.
const AGENT_MODEL = process.env.RECOVERY_AGENT_MODEL || "gpt-5.4";

// Espera antes de responder: se o cliente manda 3 mensagens seguidas, só a
// chamada da última responde (as outras veem que não são mais a última).
const DEBOUNCE_MS = 6_000;
// Limite de segurança contra loop (conversa com outro robô, resposta automática):
// depois de tantas mensagens do agente nas últimas 24 h ele para e passa pra
// humano. A conversa-teste do dono não conta (ele testa à vontade).
const MAX_AGENT_MESSAGES = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// TRAVA ANTI-RAJADA NA CONVERSA (Ian, 10/10: "nunca mandar tudo de uma vez"):
// entre duas mensagens nossas no mesmo chat, pelo menos CHAT_MIN_GAP_MS (o
// envio espera o que faltar); mais de CHAT_BURST_MAX mensagens nossas em 10
// min no mesmo chat (laço com resposta automática, robô respondendo robô) =
// nada sai e a equipe assume. O teste do dono tem folga maior.
const CHAT_MIN_GAP_MS = 15_000;
const CHAT_BURST_MAX = 6;
const CHAT_BURST_MAX_OWNER = 12;

// OpenAI sem crédito ou fora do ar (10/10: os créditos acabaram às 9h e a
// Yael ficou sem responder). Não é erro da conversa: a etapa fixa do roteiro
// sai mesmo sem o modelo; o que precisa do modelo fica marcado
// "aguardando_modelo" e sai sozinho quando ele voltar (retryPendingReplies);
// o Ian recebe um alerta urgente.
export class ModelUnavailableError extends Error {}
function openAiUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number") return status === 401 || status === 403 || status === 429 || status >= 500;
  const msg = err instanceof Error ? err.message : String(err);
  return /insufficient_quota|no credits|billing|quota|rate limit|overloaded|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|connection error|^(?:401|403|429|5\d\d)\b/i.test(msg);
}
const MODEL_ALERT_KEY = "openai_indisponivel";
async function alertModelDown(admin: SupabaseClient, settings: RecoverySettings, detail: string, pending: number | null): Promise<void> {
  if (await findOpenAlert(admin, "outro", MODEL_ALERT_KEY)) return;
  const message = `A OpenAI recusou o pedido da Yael (${detail.slice(0, 200)}). Enquanto isso o roteiro fixo continua saindo (apresentação, condição e link), mas perguntas e mensagens livres ficam esperando. Recarregue os créditos em platform.openai.com → Settings → Billing; as respostas pendentes saem sozinhas quando o modelo voltar, uma de cada vez.`;
  const created = await createAlert(admin, { kind: "outro", key: MODEL_ALERT_KEY, storeId: settings.store_id, message });
  if (!created) return;
  const r = await sendAlertEmail(admin, {
    to: alertRecipient([settings]),
    subject: "[Respondo] URGENTE: OpenAI sem crédito ou fora do ar, a Yael não consegue responder",
    text: `${message}${pending ? `\n\nConversas esperando resposta agora: ${pending}.` : ""}\n\nAbra Recuperação de carrinho → Conversas para ver quem está esperando.`,
    settings: [settings],
  });
  if (!r.ok) console.error("agente: alerta da OpenAI não saiu por e-mail:", r.error);
}

// Doublecheck de compra (Ian, 10/10): antes de cada resposta e de cada
// retomada, confere na Shopify AO VIVO se o checkout virou pedido ou se o
// e-mail/telefone já pagou outro pedido. Credenciais de TODAS as lojas (a
// compra pode ter sido em outra loja). Erro de consulta nunca vira "não comprou":
// o estado fica "desconhecido" e o agente não manda link nem desconto.
async function purchaseDoubleCheck(admin: SupabaseClient, rec: RecoveryRow): Promise<StopCheck> {
  try {
    const creds: StoreShopifyAuth[] = (await loadAllShopifyCreds(admin, rec.store_id)).map((c) => ({ shopDomain: c.shopDomain, accessToken: c.accessToken ?? decrypt(c.accessTokenEncrypted ?? ""), storeId: c.storeId }));
    return await checkPurchased(rec, creds);
  } catch (err) {
    return { ok: false, reason: "erro_na_verificacao", detail: err instanceof Error ? err.message : String(err), terminal: false };
  }
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      }
    );
  });

// Nome, e-mail ou número do pedido na mensagem dela → pedido pago na Shopify
// (todas as lojas; janela: 72 h antes do abandono até agora). null = nada.
async function lookupPaidOrderFromMessage(admin: SupabaseClient, rec: RecoveryRow, text: string): Promise<{ found: { order: { id: string; name: string; createdAt: string }; via: string } | null; hint: string | null }> {
  const msg = (text ?? "").trim();
  if (!msg) return { found: null, hint: null };
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/i.exec(msg)?.[0]?.toLowerCase() ?? null;
  const numbers = extractOrderNumbers(msg);
  const bare = /^\W*#?(\d{4,6})\W*$/.exec(msg)?.[1];
  const orderNumber = numbers[0] ?? bare ?? null;
  // "no nome de Michal Cohen", "על שם מיכל כהן", "name: ...", ou a mensagem inteira quando é só um nome.
  const named = /(?:em nome d[eoa]|no nome d[eoa]|nome[:\s]+|על שם|בשם|under (?:the )?name|name[:\s]+|на имя|باسم)\s*([\p{L}'’ -]{2,40})/iu.exec(msg)?.[1]?.trim() ?? null;
  const onlyName = !email && !orderNumber && !/[\d?]/.test(msg) && msg.split(/\s+/).length <= 4 && /\p{L}/u.test(msg) && !isPaidClaim(msg) ? msg : null;
  const nameLike = named || onlyName;
  if (!email && !orderNumber && !nameLike) return { found: null, hint: null };
  const hint = [orderNumber ? `pedido ${orderNumber}` : null, email ? "e-mail informado" : null, nameLike ? `nome ${nameLike}` : null].filter(Boolean).join(", ");
  const sinceIso = new Date(new Date(rec.abandoned_at).getTime() - 72 * 3600_000).toISOString();
  const creds = await loadAllShopifyCreds(admin, rec.store_id);
  for (const c of creds) {
    try {
      const o = await findPaidOrderByHint({ shopDomain: c.shopDomain, accessToken: c.accessToken ?? decrypt(c.accessTokenEncrypted ?? "") }, { orderNumber, email, name: nameLike }, sinceIso);
      if (o) return { found: { order: { id: o.id, name: o.name, createdAt: o.createdAt }, via: orderNumber ? "pedido_numero" : email ? "pedido_email" : "pedido_nome" }, hint };
    } catch (err) {
      console.warn("agente: busca do pedido informado falhou:", err instanceof Error ? err.message : err);
    }
  }
  return { found: null, hint };
}

// Pergunta que o agente não soube responder: e-mail para a equipe (no máximo
// um por conversa a cada 30 min), com a pergunta exata, para responder pelo
// painel e acrescentar ao CONHECIMENTO. Conversa-teste do dono: não manda.
async function notifyTeamQuestion(admin: SupabaseClient, rec: RecoveryRow, settings: RecoverySettings, question: string): Promise<void> {
  if (isOwnerSandbox(rec) || settings.test_mode) return;
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recent } = await admin.from("recovery_events").select("id").eq("recovery_id", rec.id).eq("type", "handoff").eq("detail->>emailed", "true").gte("created_at", since).limit(1);
  if ((recent ?? []).length > 0) return;
  const who = [rec.first_name, rec.last_name].filter(Boolean).join(" ") || rec.phone || "cliente";
  const r = await sendAlertEmail(admin, {
    to: alertRecipient([settings]),
    subject: `[Respondo] Pergunta sem resposta no WhatsApp: ${who}`,
    text: `A Yael disse para ${who} que vai confirmar e já avisa:\n\n"${question}"\n\nResponda pelo painel (Recuperação de carrinho → Conversas) e, se for algo que vai se repetir, mande a resposta para entrar no conhecimento dela. A conversa continua com a Yael enquanto isso.`,
    settings: [settings],
  });
  await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "handoff", provider: "email", detail: { soft: true, emailed: r.ok, via: r.via, reason: question } });
}

export interface VerifiedPurchase {
  purchase: NonNullable<AgentContext["purchase"]>;
  stop: Exclude<StopCheck, { ok: true }> | null;
}
// Duas tentativas (erro de rede ou limite da Shopify costuma passar na
// segunda), no máximo ~20 s no total para não estourar a função do webhook.
async function verifyPurchase(admin: SupabaseClient, rec: RecoveryRow): Promise<VerifiedPurchase> {
  const timedOut: StopCheck = { ok: false, reason: "erro_na_verificacao", detail: "tempo esgotado na consulta da Shopify", terminal: false };
  let check = await withTimeout(purchaseDoubleCheck(admin, rec), 9_000, timedOut);
  if (!check.ok && !check.terminal) {
    await sleep(1_500);
    check = await withTimeout(purchaseDoubleCheck(admin, rec), 9_000, timedOut);
  }
  if (check.ok) return { purchase: { state: "nao_encontrado" }, stop: null };
  // Produto fora do fluxo NÃO é compra: o carrinho fecha, mas nunca vira "já pagou".
  if (check.reason === FLOW_PRODUCT_STOP) return { purchase: { state: "desconhecido", detail: check.reason }, stop: check };
  if (check.terminal) return { purchase: { state: "pago", order: check.reason === "comprou_checkout" ? null : (check.detail ?? null) }, stop: check };
  return { purchase: { state: "desconhecido", detail: check.detail ?? check.reason }, stop: null };
}

// Hora local da cliente agora, para o agente saber se a mensagem chegou de madrugada.
const WEEKDAYS_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export function localTimeLabel(countryCode: string | null, language: string | null, now: Date = new Date()): string {
  const p = localParts(now, tzForCountry(countryCode, language));
  const period = p.hour < 5 ? "madrugada" : p.hour < 12 ? "manhã" : p.hour < 18 ? "tarde" : "noite";
  return `${WEEKDAYS_PT[p.weekday]}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} (${period})`;
}

export const AGENT_ACTIONS = ["reply", "offer_discount", "handoff", "stop", "bought", "not_interested"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentDecision {
  reply: string;
  reply_pt: string;
  action: AgentAction;
  discount_percent: number | null;
  handoff_reason: string | null;
  summary_pt: string;
  language: string;
  // A cliente disse nesta mensagem que já pagou/comprou (o handler confere a verificação).
  says_paid: boolean;
  // Tipo do handoff: "fato_desconhecido" é LEVE (a equipe recebe a pergunta por
  // e-mail e a vendedora continua a conversa); os outros param o agente.
  handoff_tipo?: "fato_desconhecido" | "saude" | "suporte" | "pediu_pessoa" | "outro" | null;
}

// Decisão já passada pelos guardrails, pronta pra enviar (ou pra mostrar
// no botão "Sugerir resposta").
export interface AgentResult extends AgentDecision {
  discount_code: string | null;
  // Link com o cupom novo quando ofereceu desconto (já dentro de reply).
  link: string | null;
  // O que os guardrails fizeram (log e painel).
  notes: string[];
  model: string;
  // O modelo estava indisponível nesta decisão (alerta pro Ian).
  model_down?: boolean;
  // A mensagem dela não foi respondida de verdade (sem modelo): responder quando o modelo voltar.
  needs_retry?: boolean;
}

const ReplySchema = z.object({
  reply: z.string().describe(`Mensagem para o cliente, no idioma dele, até ${MAX_REPLY_CHARS} caracteres, sem markdown, sem travessão, no máximo uma pergunta. Escreva {{link}} onde o link do carrinho entra. Vazia só no handoff quando não há o que dizer`),
  reply_pt: z.string().describe("Tradução fiel e completa de reply para português do Brasil, só alfabeto latino"),
  action: z.enum(AGENT_ACTIONS).describe("reply, offer_discount (oferecendo cupom agora), handoff (passa pra humano), stop (cliente pediu pra parar), bought (cliente disse que já comprou), not_interested (cliente disse que não quer)"),
  discount_percent: z.number().nullable().describe("Só com offer_discount: um dos percentuais do bloco DESCONTOS DISPONÍVEIS. Senão null"),
  handoff_reason: z.string().nullable().describe("Só com handoff: motivo em PT-BR. Senão null"),
  summary_pt: z.string().describe("1 frase em PT-BR: onde a conversa está e o que o cliente quer"),
  language: z.string().describe("Código ISO de 2 letras do idioma usado em reply (he, en, fr, bg, hu, ro, tr...)"),
  script_step: z.enum(["etapa1", "etapa2", "etapa3", "confusa", "retomada", "livre"]).describe("Mensagem do ROTEIRO DO DONO que cabe agora (o sistema escreve o texto exato dela): etapa1, etapa2, etapa3, confusa, retomada; ou livre quando a cliente precisa de outra resposta (dúvida, objeção, pedido de parar, suporte). Com uma etapa, reply pode ficar vazio."),
  cliente_genero: z.enum(["f", "m", "?"]).describe("Gênero da cliente pelas pistas da conversa (nome, verbos no masculino/feminino): f, m ou ?"),
  cliente_diz_que_pagou: z.boolean().describe("true quando, na última mensagem, a cliente diz que já pagou, comprou ou finalizou o pedido; senão false"),
  handoff_tipo: z.enum(["fato_desconhecido", "saude", "suporte", "pediu_pessoa", "outro"]).nullable().describe("Só com handoff: fato_desconhecido (dúvida sobre produto/empresa que não está no CONHECIMENTO: você diz que vai confirmar e SEGUE a conversa), saude (remédio, gravidez, alergia, pele sensível, doença), suporte (pedido já feito, entrega, reembolso, cobrança), pediu_pessoa (quer falar com alguém), outro. Sem handoff: null"),
});
type ModelReply = z.infer<typeof ReplySchema>;

// ---------------------------------------------------------------------------
// Decisão pura: contexto → resposta validada. Sem banco, sem envio.
// ---------------------------------------------------------------------------

// Link de clique do agente: igual ao da régua, com `d` = cupom (a rota r
// redireciona com o cupom certo sem consultar tabela; sem `d` ela cai no
// comportamento antigo). O campo `d` é adicionado em links.ts pelo motor.
export function agentCartLink(recoveryId: string, waStep: number, code: string | null): string {
  const payload = { r: recoveryId, s: waStep || 1, c: "whatsapp", ...(code ? { d: code } : {}) } as RecoveryTokenPayload;
  return `${APP_URL}/api/public/r/${makeRecoveryToken(payload)}`;
}

async function callModel(ctx: AgentContext, corrections: string[]): Promise<ModelReply> {
  const r = await client.responses
    .parse({
      model: AGENT_MODEL,
      instructions: buildAgentInstructions(ctx, corrections),
      input: buildAgentInput(ctx),
      text: { format: zodTextFormat(ReplySchema, "agent_reply") },
    })
    .catch((err: unknown) => {
      throw openAiUnavailable(err) ? new ModelUnavailableError(err instanceof Error ? err.message : String(err)) : err;
    });
  recordUsage(AGENT_MODEL, r.usage);
  if (!r.output_parsed) throw new Error("OpenAI não retornou a decisão do agente.");
  return r.output_parsed;
}

// Sem travessão, sem markdown de ênfase, sem linhas em branco em excesso.
function cleanReply(text: string): string {
  return stripDashes(text ?? "")
    .replace(/\*\*?([^*\n]+)\*\*?/g, "$1")
    .replace(/^[ \t]*[-•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const pickLang = (fromModel: string | null | undefined, fallback: string): string => {
  const m = (fromModel ?? "").trim().toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(m) ? m : fallback;
};

// Tamanho medido com os links como marcação (o link real tem ~150 caracteres
// e não é texto que o cliente lê).
const measure = (reply: string) => reply.replace(/https?:\/\/\S+/g, "{{link}}").length;

function cutAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (const re of [/[.!?。]\s/g, /[.!?。]$/g, /\n/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(head))) cut = Math.max(cut, m.index + 1);
    if (cut > 40) break;
  }
  if (cut <= 40) cut = head.lastIndexOf(" ");
  return (cut > 0 ? head.slice(0, cut) : head).trim();
}

function languageIssues(rawReply: string, replyLang: string, ctx: AgentContext): string[] {
  if (!rawReply) return [];
  // O nome da cliente (muitas vezes em letras hebraicas) e as marcas não contam como alfabeto estranho.
  let reply = rawReply;
  for (const token of [ctx.customerName, ...(ctx.customerName ?? "").split(/\s+/)].filter((x): x is string => Boolean(x && x.length >= 2))) reply = reply.split(token).join(" ");
  // Teste do dono: português é permitido (ele testa no idioma dele).
  if (ctx.ownerTest) return portugueseLeak(reply, replyLang);
  const extra: string[] = [];
  if (replyLang === "he") {
    // Resumo do produto copiado em português no meio do hebraico.
    if (/\b(kit com|unidades?|de brinde|presente surpresa|desconto)\b/i.test(reply)) extra.push("português no meio do hebraico");
    // A vendedora fala de si no feminino.
    if (/אני (?:יכול|צריך|שמח|בודק|מבין|רוצה לעזור לך|יודע)(?![הת])/.test(reply)) extra.push("a vendedora falou de si no masculino");
  }
  // Cliente escreveu em outro alfabeto (inglês, russo, árabe) e a resposta saiu em hebraico.
  const letters = (re: RegExp) => (ctx.latestMessage.match(re) ?? []).length;
  const he = letters(/[\u0590-\u05FF]/g), lat = letters(/[A-Za-z]/g), cyr = letters(/[\u0400-\u04FF]/g), ar = letters(/[\u0600-\u06FF]/g);
  if (he === 0 && lat + cyr + ar >= 8 && hasHebrew(reply) && replyLang === "he") extra.push("a cliente escreveu em outro idioma e a resposta saiu em hebraico");
  const issues = [...portugueseLeak(reply, replyLang)];
  if (replyLang.startsWith("pt")) issues.push("idioma português");
  if (ctx.language.slice(0, 2) === "he" && hasHebrew(ctx.latestMessage) && !hasHebrew(reply)) issues.push("sem hebraico (o cliente escreveu em hebraico)");
  return [...issues, ...extra];
}

function handoffResult(ctx: AgentContext, reason: string, notes: string[], out?: ModelReply | null, lang?: string): AgentResult {
  const language = lang ?? ctx.language.slice(0, 2);
  const picked = pickWaitPhrase(ctx.ownerTest && language === "pt" ? "pt" : language, ctx.history);
  const reply = picked?.text ?? "";
  if (!reply) notes.push(`sem frase de espera para o idioma ${language}: nada será enviado`);
  return {
    reply,
    reply_pt: picked?.pt ?? "",
    action: "handoff",
    discount_percent: null,
    handoff_reason: reason,
    summary_pt: stripDashes(out?.summary_pt?.trim() || `Passado para a equipe: ${reason}.`),
    language,
    says_paid: false,
    handoff_tipo: null,
    discount_code: null,
    link: null,
    notes,
    model: AGENT_MODEL,
  };
}

// Texto fixo do roteiro do dono para a etapa, no idioma da conversa. Só sai
// se todas as marcações tiverem valor (senão o modelo escreve).
function renderScript(ctx: AgentContext, step: string, lang: string, gender: string): string | null {
  const tpl = ctx.scriptTemplates?.[step];
  if (!tpl) return null;
  const text = (lang === "he" && gender === "m" && tpl.he_m) || tpl[lang];
  if (!text) return null;
  const vars = ctx.scriptVars?.[lang] ?? {};
  const name = (vars.nome ?? "").trim();
  let missing = false;
  const out = text
    .replace(/ \{nome\}/g, name ? ` ${name}` : "")
    .replace(/(?<!\{)\{(\w+)\}(?!\})/g, (m, k: string) => {
      const v = vars[k];
      if (v == null || v === "") {
        missing = true;
        return m;
      }
      return v;
    });
  return missing ? null : out;
}
// Etapa do roteiro já enviada nesta conversa (em qualquer idioma ou gênero).
function stepSent(ctx: AgentContext, step: string): boolean {
  if (ctx.scriptStepsSent?.includes(step)) return true;
  for (const lang of ["pt", "he"]) for (const g of ["f", "m"]) {
    const t = renderScript(ctx, step, lang, g);
    if (t && scriptAlreadySent(ctx, t)) return true;
  }
  return false;
}
const scriptAlreadySent = (ctx: AgentContext, text: string) => {
  const head = text.replace(/\s+/g, " ").slice(0, 40);
  return ctx.history.some((m) => m.author === "agente" && m.body.replace(/\s+/g, " ").startsWith(head));
};

// Idioma provável da cliente pelo alfabeto da última mensagem (para a frase
// de espera e para a reescrita sair no idioma dela, não no do carrinho).
function customerScriptLang(text: string, fallback: string): string {
  const n = (re: RegExp) => (text.match(re) ?? []).length;
  const he = n(/[\u0590-\u05FF]/g), ar = n(/[\u0600-\u06FF]/g), cyr = n(/[\u0400-\u04FF]/g), lat = n(/[A-Za-z]/g);
  const best = Math.max(he, ar, cyr, lat);
  if (best < 4) return fallback;
  if (best === he) return "he";
  if (best === ar) return "ar";
  if (best === cyr) return "ru";
  return fallback === "he" ? "en" : fallback;
}
const normalize = (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
function repeatsEarlier(reply: string, ctx: AgentContext): boolean {
  const mine = ctx.history.filter((m) => m.author === "agente").map((m) => normalize(m.body));
  const r = normalize(reply);
  if (r.length < 30) return false;
  return mine.some((m) => m.slice(0, 70) === r.slice(0, 70) || (m.length > 40 && r.includes(m.slice(0, Math.min(120, m.length)))));
}

export async function decideAgentReply(ctx: AgentContext): Promise<AgentResult> {
  const notes: string[] = [];
  const cartLang = ctx.ownerTest ? (ctx.language || "pt").toLowerCase().slice(0, 2) : customerScriptLang(ctx.latestMessage, (ctx.language || "en").toLowerCase().slice(0, 2));

  const sentRecently = ctx.agentMessages24h ?? ctx.agentMessageCount;
  if (!ctx.ownerTest && sentRecently >= MAX_AGENT_MESSAGES) {
    notes.push(`agente já mandou ${sentRecently} mensagens nesta conversa nas últimas 24 h`);
    return handoffResult(ctx, "muitas mensagens do agente sem fechar", notes);
  }
  // Compra já feita (ou não verificada): o roteiro de venda e o link não valem.
  const purchaseLocked = ctx.purchase?.state === "pago" || ctx.purchase?.state === "desconhecido";

  // Onde a conversa está no roteiro (pelo histórico): vai para o modelo como
  // dica e decide a etapa forçada logo abaixo.
  const sent = { etapa1: stepSent(ctx, "etapa1"), confusa: stepSent(ctx, "confusa"), etapa2: stepSent(ctx, "etapa2"), etapa3: stepSent(ctx, "etapa3") };
  ctx = {
    ...ctx,
    stageHint: purchaseLocked
      ? null
      : !sent.etapa1 && !sent.confusa
        ? "nada do roteiro foi enviado ainda; a próxima mensagem é a etapa1 (o sistema envia o texto)."
        : !sent.etapa2
          ? "a condição especial (etapa2) AINDA NÃO foi apresentada. Se ela perguntou algo, responda curto e termine com UMA pergunta curta puxando para a condição que o gerente liberou, com palavras DIFERENTES das que você já usou (se já perguntou isso e ela ignorou, só responda, sem puxar de novo). Não mande link e não detalhe valores do desconto antes da etapa2. Depois da apresentação, chame o produto só de 'o Tri-Lift' ou 'o seu kit', sem repetir o nome completo."
          : !sent.etapa3
            ? "a condição (etapa2) já foi apresentada e o link (etapa3) ainda não. Se ela perguntou algo, responda curto e termine com UMA pergunta curta oferecendo o link, com palavras diferentes das que você já usou. Chame o produto só de 'o Tri-Lift' ou 'o seu kit'."
            : "o link (etapa3) já foi enviado. Responda o que ela perguntar e ajude a finalizar o pagamento; não repita textos do roteiro.",
  };

  const corrections: string[] = [];
  let leakRetried = false;
  let lengthRetried = false;
  let repeatRetried = false;
  let styleRetried = false;
  let purchaseRetried = false;
  let percentRetried = false;
  let markerRetried = false;
  let offerRetried = false;
  // Modelo indisponível: segue com uma decisão vazia. O roteiro em código
  // ainda manda a etapa fixa (sim → condição → link) e o texto fixo de
  // pagamento; o resto sai como "aguardando o modelo" (fim da função).
  let modelDown = false;
  let out: ModelReply;
  try {
    out = await callModel(ctx, corrections);
  } catch (err) {
    if (!(err instanceof ModelUnavailableError)) throw err;
    modelDown = true;
    notes.push(`modelo indisponível: ${err.message.slice(0, 120)}`);
    out = { reply: "", reply_pt: "", action: "reply", discount_percent: null, handoff_reason: null, summary_pt: "", language: cartLang, script_step: "livre", cliente_genero: "?", cliente_diz_que_pagou: false, handoff_tipo: null };
  }
  let reply = cleanReply(out.reply);
  let replyLang = pickLang(out.language, cartLang);

  // Roteiro do dono: etapa escolhida pelo modelo, texto exato do roteiro
  // (português no teste do dono, hebraico com a cliente). Etapa já enviada
  // nesta conversa não se repete: o modelo escreve uma resposta livre.
  let scripted = false;
  const scriptLang = ctx.ownerTest ? (ctx.language === "he" ? "he" : "pt") : cartLang;
  // ROTEIRO EM CÓDIGO (Ian, 10/10: "siga o roteiro"): a ordem etapa1 → etapa2
  // → etapa3 é do sistema. O modelo só decide quando a cliente PERGUNTA algo
  // (resposta livre, puxando para a etapa seguinte) ou quando quer parar.
  //  - nada apresentado ainda: confusa se ela não sabe do que se trata; senão
  //    etapa1 sempre (pergunta junto = etapa1 + resposta curta embaixo);
  //  - etapa1 (ou confusa) enviada e etapa2 não: "sim/ok/qual a condição/manda
  //    o link" → etapa2; pergunta → livre; o modelo nunca pula para a etapa3;
  //  - etapa2 enviada e etapa3 não: "sim/ok/manda" → etapa3; pergunta → livre;
  //  - etapa3 enviada: livre.
  const kind = classifyCustomerMessage(ctx.latestMessage);
  const flowStops = out.action === "stop" || out.action === "not_interested" || out.action === "bought" || out.action === "handoff";
  let appendAnswer = false;
  if (ctx.latestMessage.trim() && !purchaseLocked && !flowStops) {
    let forced: ModelReply["script_step"] | null = null;
    // Atalho do roteiro: ela respondeu à mensagem AUTOMÁTICA dos 15% ("quer que
    // eu te mande o link?") antes de qualquer etapa: "sim" = link (etapa3).
    const reguaOffered = ctx.offeredPercent > 0 && !sent.etapa1 && !sent.confusa && !sent.etapa2;
    if (reguaOffered) {
      if (kind === "afirmativa" || kind === "pede_link" || kind === "pede_condicao") forced = sent.etapa3 ? "livre" : "etapa3";
      else if (kind === "confusa") forced = "confusa";
      else if (out.script_step && out.script_step !== "livre") forced = "livre";
    } else if (!sent.etapa1 && !sent.confusa) {
      if (kind === "confusa") forced = "confusa";
      else {
        forced = "etapa1";
        appendAnswer = kind === "pergunta" || kind === "outra" || kind === "objecao_preco";
      }
    } else if (!sent.etapa1 && !sent.etapa2) {
      // Depois da "confusa": "ah, lembrei/sim" = apresentação (etapa1); pediu o link = condição (etapa2).
      if (kind === "afirmativa") forced = "etapa1";
      else if (kind === "pede_link" || kind === "pede_condicao" || kind === "objecao_preco") forced = "etapa2";
      else if (out.script_step && out.script_step !== "livre") forced = "livre";
    } else if (!sent.etapa2) {
      if (kind === "afirmativa" || kind === "pede_link" || kind === "pede_condicao" || kind === "objecao_preco") forced = "etapa2";
      else if (kind === "confusa" && !sent.confusa) forced = "confusa";
      else if (out.script_step === "etapa3" || out.script_step === "etapa1") forced = kind === "pergunta" || kind === "outra" ? "livre" : "etapa2";
    } else if (!sent.etapa3) {
      if (kind === "afirmativa" || kind === "pede_link" || kind === "pede_condicao") forced = "etapa3";
      else if (out.script_step === "etapa1" || out.script_step === "etapa2" || out.script_step === "confusa") forced = "livre";
    } else if (out.script_step && out.script_step !== "livre" && out.script_step !== "retomada") {
      forced = "livre";
    }
    if (forced && forced !== out.script_step) {
      notes.push(`roteiro em código: ${kind} → ${forced} (modelo queria ${out.script_step ?? "livre"})`);
      out = { ...out, script_step: forced };
      if (forced === "livre" && !cleanReply(out.reply) && !modelDown) {
        corrections.push("Responda à última mensagem da cliente em texto livre (script_step = livre), curto, e termine puxando para a próxima etapa do roteiro.");
        out = { ...out, ...(await callModel(ctx, corrections)), script_step: "livre" };
        reply = cleanReply(out.reply);
        replyLang = pickLang(out.language, cartLang);
      }
    }
  }
  if (out.script_step && out.script_step !== "livre" && !purchaseLocked) {
    const text = renderScript(ctx, out.script_step, scriptLang, out.cliente_genero ?? "?");
    if (text && !scriptAlreadySent(ctx, text)) {
      scripted = true;
      reply = text;
      replyLang = scriptLang;
      const pt = renderScript(ctx, out.script_step, "pt", out.cliente_genero ?? "?");
      const offering = (out.script_step === "etapa2" || out.script_step === "etapa3" || out.script_step === "retomada") && !(ctx.offeredPercent > 0);
      const smallest = offerableDiscounts(ctx)[0]?.percent ?? null;
      out = { ...out, reply: text, reply_pt: pt ?? out.reply_pt, language: scriptLang, action: offering && smallest ? "offer_discount" : out.action === "offer_discount" ? "reply" : out.action === "handoff" || out.action === "stop" ? out.action : "reply", discount_percent: offering && smallest ? smallest : null };
      notes.push(`roteiro: ${out.script_step}`);
      // Primeira mensagem dela já é uma pergunta: etapa1 e, embaixo, a resposta
      // curta (sem cumprimento, sem link, sem desconto). Resposta que falhar
      // nas travas é descartada: sai só a etapa1 e ela pergunta de novo.
      if (appendAnswer && out.script_step === "etapa1" && !modelDown) {
        const langName = languageName(scriptLang);
        const extra = await callModel(ctx, [...corrections, `A apresentação do roteiro (etapa1) já vai sair agora como primeira mensagem. Escreva SÓ a resposta à pergunta dela, em ${langName}, em 1 ou 2 frases, sem cumprimentar, sem se apresentar, sem link, sem porcentagem e sem desconto, terminando com uma pergunta curta que puxe para a condição especial (ex.: "posso te contar a condição que o gerente liberou?"). script_step = livre, action = reply.`]);
        const ans = cleanReply(extra.reply);
        const bad = ans ? languageIssues(ans, pickLang(extra.language, scriptLang), ctx) : ["vazia"];
        if (ans && bad.length === 0 && measure(ans) <= 360 && !/https?:\/\/|\{\{|%/.test(ans) && extra.action !== "handoff" && extra.action !== "stop") {
          reply = `${text}\n\n${ans}`;
          out = { ...out, reply, reply_pt: `${out.reply_pt ?? ""}\n\n${stripDashes(extra.reply_pt ?? "").trim()}`.trim(), summary_pt: extra.summary_pt || out.summary_pt };
          notes.push("roteiro: etapa1 + resposta à pergunta");
        } else {
          notes.push(`roteiro: etapa1 sem a resposta extra (${bad.join(", ") || "descartada"})`);
        }
      }
    } else if (!modelDown && !text && renderScript(ctx, out.script_step, "pt", out.cliente_genero ?? "?")) {
      // Cliente escreve em outro idioma (russo, árabe, inglês...): o texto fixo
      // só existe em hebraico e português, então o modelo escreve a MESMA etapa
      // traduzida para o idioma dela.
      const step = out.script_step;
      const ptText = renderScript(ctx, step, "pt", out.cliente_genero ?? "?") as string;
      notes.push(`roteiro: ${step} traduzida para ${scriptLang}`);
      corrections.push(`Escreva AGORA a etapa "${step}" do roteiro do dono em ${languageName(scriptLang)} (o idioma em que a cliente escreve), com o MESMO conteúdo, os mesmos números e na mesma ordem deste texto em português: «${ptText}». Se houver {{link}}, mantenha {{link}}. script_step = livre.`);
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      replyLang = pickLang(out.language, scriptLang);
      const offeringT = (step === "etapa2" || step === "etapa3" || step === "retomada") && !(ctx.offeredPercent > 0);
      const smallestT = offerableDiscounts(ctx)[0]?.percent ?? null;
      out = { ...out, script_step: "livre", action: offeringT && smallestT ? "offer_discount" : out.action === "offer_discount" ? "reply" : out.action, discount_percent: offeringT && smallestT ? smallestT : out.discount_percent };
    } else if (!reply && !modelDown) {
      notes.push(`roteiro: ${out.script_step} ${text ? "já enviada" : "sem texto"}; resposta livre`);
      corrections.push(`A mensagem "${out.script_step}" do roteiro ${text ? "já foi enviada nesta conversa" : "não se aplica agora"}. Escreva você uma resposta livre (script_step = livre) que avance a conversa.`);
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      replyLang = pickLang(out.language, cartLang);
    }
  }

  // Guardrails com uma reescrita cada: idioma (depois handoff) e tamanho
  // (depois corte na última frase completa).
  for (; !scripted && !modelDown; ) {
    replyLang = pickLang(out.language, cartLang);
    const issues = languageIssues(reply, replyLang, ctx);
    if (issues.length > 0 && !leakRetried) {
      leakRetried = true;
      notes.push(`reescrita por idioma: ${issues.join(", ")}`);
      corrections.push(`A resposta anterior saiu com ${issues.join(", ")}. Reescreva INTEIRA em ${languageName(cartLang)} (ou no idioma da última mensagem do cliente), sem nenhuma palavra em português e sem alfabeto estranho ao idioma.`);
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      continue;
    }
    if (issues.length > 0) {
      notes.push(`idioma persistiu após reescrita: ${issues.join(", ")}`);
      return handoffResult(ctx, "idioma", notes, out, cartLang);
    }
    // Roteiro: o desconto extra é dito em shekels (a % do cupom é sobre o
    // subtotal e não bate com o que a cliente vê); e a primeira mensagem da
    // vendedora sempre se apresenta.
    if (!styleRetried && reply) {
      const missingIntro = ctx.agentMessageCount === 0 && !ctx.ownerTest && out.action !== "stop" && out.action !== "handoff" && !reply.includes(ctx.agentName) && !/yael|יעל/i.test(reply);
      if (missingIntro) {
        styleRetried = true;
        notes.push("reescrita: sem apresentação");
        if (missingIntro) corrections.push(`Esta é a sua PRIMEIRA mensagem na conversa: comece se apresentando (você é ${ctx.agentName}, do time da ${ctx.brand}) e dizendo o produto que ficou no carrinho, e então responda o que ela perguntou.`);
        out = await callModel(ctx, corrections);
        reply = cleanReply(out.reply);
        continue;
      }
    }
    if (!repeatRetried && repeatsEarlier(reply, ctx)) {
      repeatRetried = true;
      notes.push("reescrita: repetia uma mensagem anterior");
      corrections.push("A resposta anterior repetia uma mensagem que você já mandou nesta conversa. Escreva uma resposta NOVA que avance a conversa (responda exatamente o que ela perguntou agora, com outro jeito de dizer), sem copiar frases suas anteriores.");
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      continue;
    }
    // Compra já feita ou não verificada: nada de link nem de oferta.
    if (!purchaseRetried && purchaseLocked && reply && (out.action === "offer_discount" || /\{\{\s*link\s*\}\}|https?:\/\//i.test(reply))) {
      purchaseRetried = true;
      notes.push(`reescrita: link ou oferta com a compra em estado ${ctx.purchase?.state}`);
      corrections.push(ctx.purchase?.state === "pago" ? "A cliente JÁ COMPROU (VERIFICAÇÃO DE COMPRA = PAGO): reescreva sem link e sem desconto; agradeça e responda só o que ela perguntou." : "A compra NÃO foi verificada agora: reescreva sem link e sem desconto, dizendo só que vai conferir e já retorna (action = handoff).");
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      continue;
    }
    // Porcentagem que não existe aqui: reescreve sem ela (antes, ia direto para humano).
    if (!percentRetried && reply && !scripted) {
      const factualSet = new Set([ctx.appliedPercent ?? 0, ...(ctx.factualPercents ?? [])].filter((p) => p > 0));
      const bad = [...new Set([...reply.matchAll(/(?<!\d)(\d{1,2})\s?%/g)].map((m) => Number(m[1])).filter((p) => !factualSet.has(p)))];
      const convertible = bad.length === 1 && offerableDiscounts(ctx).some((d) => matchDiscount(d, bad[0]));
      if (bad.length > 0 && out.action !== "offer_discount" && !convertible) {
        percentRetried = true;
        notes.push(`reescrita: porcentagem ${bad.join("/")}% inexistente no texto`);
        corrections.push(`Você citou ${bad.join("/")}%, que não existe nesta conversa. Porcentagens permitidas no texto: ${[...factualSet].join(", ") || "nenhuma"}%. Reescreva sem citar essa porcentagem (se ela pediu um desconto maior, diga com carinho que o desconto adicional é o máximo que o gerente liberou).`);
        out = await callModel(ctx, corrections);
        reply = cleanReply(out.reply);
        continue;
      }
    }
    // Marcação que não existe: só {{link}} e {{cupom}} valem.
    if (!markerRetried && /\{\{(?!\s*(?:link|cupom)\s*\}\})[^}]*\}\}/i.test(reply)) {
      markerRetried = true;
      notes.push("reescrita: marcação desconhecida");
      corrections.push("O texto tem uma marcação {{...}} que não existe. Use somente {{link}} e {{cupom}} (ou nenhuma).");
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      continue;
    }
    // Oferta com percentual que não está disponível: reescreve como resposta normal.
    if (!offerRetried && out.action === "offer_discount") {
      const avail = offerableDiscounts(ctx);
      const asked = ctx.discounts.find((d) => matchDiscount(d, out.discount_percent));
      const alreadyOffered = ctx.offeredPercent > 0 && ctx.offeredCode && (out.discount_percent == null || (asked?.percent ?? out.discount_percent) <= ctx.offeredPercent);
      if (!alreadyOffered && !avail.some((d) => matchDiscount(d, out.discount_percent))) {
        offerRetried = true;
        notes.push(`reescrita: desconto ${out.discount_percent ?? "null"} indisponível`);
        corrections.push(`discount_percent ${out.discount_percent ?? "null"} não está disponível (disponíveis: ${avail.map((d) => shownPercent(d)).join(", ") || "nenhum"}). Se não há desconto a oferecer, responda com action = reply, sem prometer desconto.`);
        out = await callModel(ctx, corrections);
        reply = cleanReply(out.reply);
        continue;
      }
    }
    const size = measure(reply);
    if (size > MAX_REPLY_CHARS && !lengthRetried) {
      lengthRetried = true;
      notes.push(`reescrita por tamanho (${size} caracteres)`);
      corrections.push(`A resposta anterior tem ${size} caracteres; o máximo é ${MAX_REPLY_CHARS}. Reescreva bem mais curta (1 a 3 frases), mantendo o essencial e, se for oferta de desconto, o código do cupom e {{link}}.`);
      out = await callModel(ctx, corrections);
      reply = cleanReply(out.reply);
      continue;
    }
    break;
  }
  if (!scripted && measure(reply) > MAX_REPLY_CHARS) {
    reply = cutAtSentence(reply, MAX_REPLY_CHARS);
    notes.push("cortada na última frase completa");
  }

  let action = out.action;
  let replyPt = stripDashes(out.reply_pt ?? "").trim();
  const summaryPt = stripDashes(out.summary_pt ?? "").trim();

  if (purchaseLocked && (action === "offer_discount" || /\{\{\s*link\s*\}\}|https?:\/\//i.test(reply))) {
    notes.push(`link ou desconto com a compra em estado ${ctx.purchase?.state}`);
    return handoffResult(ctx, ctx.purchase?.state === "pago" ? "cliente já comprou e o agente tentou mandar link ou desconto" : "não consegui verificar a compra agora", notes, out, replyLang);
  }

  // Assunto de suporte na mensagem do cliente: humano, mesmo que o modelo
  // tenha tentado responder (rede de segurança em código).
  // Quem acabou de pagar (Shopify confirmou) e pergunta prazo ou rastreio é respondida; reembolso, troca e cobrança continuam sendo humano.
  // Pergunta de garantia antes da compra não é suporte; palavra negada ("não fui cobrada") também não.
  const policyQuestion = ctx.purchase?.state !== "pago" && GUARANTEE_RE.test(ctx.latestMessage);
  const supportTopic = !policyQuestion && (ctx.purchase?.state === "pago" ? testUnnegated(SUPPORT_HARD_RE, ctx.latestMessage) : testUnnegated(SUPPORT_TOPIC_RE, ctx.latestMessage));
  if (action !== "handoff" && action !== "stop" && supportTopic) {
    notes.push("assunto de suporte detectado na mensagem do cliente");
    return handoffResult(ctx, "assunto de suporte (pedido feito, rastreio, reembolso ou cobrança)", notes, out, replyLang);
  }

  // Cliente diz que pagou/comprou: o texto depende da VERIFICAÇÃO, nunca do
  // modelo. Não encontrado = texto fixo pedindo o comprovante (uma vez; se ela
  // insistir, a equipe confere). Não verificado = frase de espera e equipe.
  // Vem DEPOIS da trava de suporte: "pedi há duas semanas e não chegou" é suporte, não comprovante.
  // Só vale a frase dela (palavras de pagamento na ÚLTIMA mensagem) ou a ação "bought": a marca cliente_diz_que_pagou sozinha "gruda" da mensagem anterior no modelo.
  const searchedHint = ctx.purchase?.state === "nao_encontrado" && Boolean(ctx.purchase?.hint);
  const claimsPaid = isPaidClaim(ctx.latestMessage) || action === "bought" || searchedHint;
  if (claimsPaid && ctx.purchase && ctx.purchase.state !== "pago" && action !== "stop" && action !== "not_interested") {
    const table = searchedHint ? PAYMENT_NOT_FOUND_AFTER_HINT : PAYMENT_NOT_FOUND;
    const fixed = ctx.purchase.state === "nao_encontrado" ? (table[replyLang] ?? table[cartLang] ?? null) : null;
    if (fixed && !scriptAlreadySent(ctx, fixed)) {
      notes.push("diz que pagou e a Shopify não mostra o pedido: texto fixo pedindo o comprovante");
      return { reply: fixed, reply_pt: table.pt, action: "reply", discount_percent: null, handoff_reason: null, summary_pt: summaryPt || "Diz que já pagou; o pedido não aparece na Shopify; pedi o comprovante.", language: replyLang, says_paid: true, discount_code: null, link: null, notes, model: AGENT_MODEL };
    }
    notes.push(`diz que pagou com a compra em estado ${ctx.purchase.state}${fixed ? " (já pedi o comprovante)" : ""}: equipe`);
    return { ...handoffResult(ctx, ctx.purchase.state === "desconhecido" ? "diz que pagou; não consegui verificar a compra agora" : "insiste que pagou, mas o pedido não aparece na Shopify (conferir o comprovante)", notes, out, replyLang), says_paid: true };
  }

  // Sem modelo e sem etapa fixa para esta mensagem: pergunta = frase de "vou
  // confirmar" (variação ainda não usada na conversa); o resto não recebe
  // nada agora. Nos dois casos a resposta de verdade sai quando o modelo voltar.
  if (modelDown && !scripted) {
    const picked = classifyCustomerMessage(ctx.latestMessage) === "pergunta" ? pickWaitPhrase(cartLang, ctx.history) : null;
    notes.push(picked ? "modelo indisponível: frase de espera, resposta quando o modelo voltar" : "modelo indisponível: sem resposta até o modelo voltar");
    return { reply: picked?.text ?? "", reply_pt: picked?.pt ?? "", action: "reply", discount_percent: null, handoff_reason: null, summary_pt: "", language: cartLang, says_paid: false, handoff_tipo: null, discount_code: null, link: null, notes, model: AGENT_MODEL, model_down: true, needs_retry: true };
  }

  // Desconto: só os cadastrados, acima do já oferecido, com link obrigatório.
  let discountCode: string | null = null;
  let discountPercent: number | null = null;
  let link: string | null = null;
  // Porcentagens no texto: a que o carrinho já tem (cupom do site) e a já
  // oferecida são fatos; uma porcentagem oferecível citada sem a ação vira a
  // oferta (o modelo às vezes apresenta a condição com action = reply).
  const mentioned = scripted ? [] : [...reply.matchAll(/(?<!\d)(\d{1,2})\s?%/g)].map((m) => Number(m[1]));
  const factual = new Set([ctx.appliedPercent ?? 0, ...(ctx.factualPercents ?? [])].filter((p) => p > 0));
  const newPercents = [...new Set(mentioned.filter((p) => !factual.has(p)))];
  if (action !== "offer_discount" && action !== "handoff" && newPercents.length === 1 && offerableDiscounts(ctx).some((d) => matchDiscount(d, newPercents[0]))) {
    notes.push(`oferta de ${newPercents[0]}% sem a ação: tratada como offer_discount`);
    action = "offer_discount";
    out = { ...out, discount_percent: newPercents[0] };
  }
  // Reforço do cupom já oferecido (ex.: "manda o link" depois dos 15%): não é
  // desconto novo. Antes isso caía em "desconto inválido" e virava handoff.
  if (action === "offer_discount" && ctx.offeredPercent > 0 && ctx.offeredCode && (out.discount_percent == null || (ctx.discounts.find((d) => matchDiscount(d, out.discount_percent))?.percent ?? out.discount_percent) <= ctx.offeredPercent)) {
    notes.push(`reforço do cupom já oferecido (${shownPercent({ percent: ctx.offeredPercent, code: ctx.offeredCode })}%)`);
    action = "reply";
  }
  if (action === "offer_discount") {
    const chosen = offerableDiscounts(ctx).find((d) => matchDiscount(d, out.discount_percent));
    if (!chosen) {
      notes.push(`desconto inválido: ${out.discount_percent ?? "null"} (disponíveis: ${offerableDiscounts(ctx).map((d) => shownPercent(d)).join(", ") || "nenhum"})`);
      return handoffResult(ctx, "pediu desconto fora do permitido", notes, out, replyLang);
    }
    discountCode = chosen.code;
    discountPercent = chosen.percent;
    link = agentCartLink(ctx.recoveryId, ctx.waStep, chosen.code);
  } else if (newPercents.length > 0) {
    // Porcentagem no texto sem action=offer_discount que não é fato do
    // carrinho nem o cupom já dado: promessa que não vamos cumprir.
    {
      notes.push(`porcentagem ${mentioned.join("/")}% no texto sem offer_discount`);
      return handoffResult(ctx, "citou desconto sem oferta válida", notes, out, replyLang);
    }
  }

  // Marcações: {{link}} e {{cupom}} viram os valores reais; na oferta o
  // link antigo (do bloco CARRINHO) vira o link com o cupom novo.
  const useLink = link ?? ctx.cartLink;
  reply = reply.replace(/\{\{\s*link\s*\}\}/gi, useLink).replace(/\{\{\s*cupom\s*\}\}/gi, discountCode ?? ctx.offeredCode ?? "");
  if (link) {
    reply = reply.split(ctx.cartLink).join(link);
    // Roteiro do Ian: a oferta pode vir sem link ("Faz sentido pra você?");
    // o cupom fica gravado no carrinho e o próximo {{link}} já o leva.
  }
  if (/\{\{[^}]*\}\}/.test(reply)) {
    notes.push("marcação desconhecida no texto");
    return handoffResult(ctx, "texto com marcação inválida", notes, out, replyLang);
  }
  if (replyPt) replyPt = replyPt.replace(/\{\{\s*link\s*\}\}/gi, "[link do carrinho]").replace(/\{\{\s*cupom\s*\}\}/gi, discountCode ?? ctx.offeredCode ?? "");

  let handoffReason: string | null = null;
  if (action === "handoff") {
    handoffReason = out.handoff_reason?.trim() || "o agente pediu ajuda da equipe";
    // Sem texto, ou repetindo uma frase que ela já mandou nesta conversa: uma
    // variação ainda não usada ("parecer uma pessoa real", Ian 10/10).
    const repeated = Boolean(reply) && ctx.history.some((m) => m.author === "agente" && normalize(m.body) === normalize(reply));
    if (!reply || repeated) {
      const picked = pickWaitPhrase(replyLang, ctx.history) ?? pickWaitPhrase(cartLang, ctx.history);
      reply = picked?.text ?? "";
      replyPt = picked?.pt ?? "";
      if (repeated) notes.push("frase de espera repetida: troquei por outra variação");
      if (!reply) notes.push("sem frase de espera para o idioma: nada será enviado");
    }
  }
  if (action === "stop" && !reply) {
    reply = stopConfirmation(replyLang) ?? stopConfirmation(cartLang) ?? "";
    replyPt = reply ? STOP_CONFIRMATION_PT : "";
  }

  return {
    reply,
    reply_pt: replyPt,
    action,
    discount_percent: discountPercent,
    handoff_reason: handoffReason,
    summary_pt: summaryPt,
    language: replyLang,
    says_paid: isPaidClaim(ctx.latestMessage) || action === "bought",
    handoff_tipo: action === "handoff" ? (out.handoff_tipo ?? "outro") : null,
    discount_code: discountCode,
    link,
    notes,
    model: AGENT_MODEL,
    model_down: modelDown || undefined,
  };
}

// ---------------------------------------------------------------------------
// Contexto a partir do banco.
// ---------------------------------------------------------------------------

export function defaultRecoverySettings(storeId: string): RecoverySettings {
  const now = new Date().toISOString();
  return {
    store_id: storeId,
    enabled: false,
    email_enabled: false,
    whatsapp_enabled: false,
    sms_enabled: false,
    agent_enabled: false,
    test_mode: true,
    test_email: "dono@suaempresa.com",
    test_phone: null,
    require_consent: false,
    from_name: null,
    from_email: null,
    reply_to: null,
    agent_name: null,
    agent_prompt: null,
    agent_max_discount: 15,
    daily_cap_email: 100,
    daily_cap_whatsapp: 30,
    max_days: 10,
    quiet_hours: { start: 9, end: 21, shabbat: false },
    welcome_enabled: false,
    welcome_since: null,
    welcome_skip_first_if_receipt: true,
    contact_url: null,
    email_provider: "resend",
    min_gap_hours: 2,
    production_since: null,
    warmup_since: null,
    measure_since: now,
    last_sync_at: null,
    last_tick_at: null,
    updated_at: now,
  };
}

export async function loadRecoverySettings(admin: SupabaseClient, storeId: string): Promise<RecoverySettings | null> {
  const { data, error } = await admin.from("recovery_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (error) {
    if (RECOVERY_MISSING_TABLE.test(error.message)) return null;
    throw new Error(error.message);
  }
  return (data as RecoverySettings | null) ?? null;
}

export async function loadRecovery(admin: SupabaseClient, recoveryId: string): Promise<RecoveryRow | null> {
  const { data, error } = await admin.from("cart_recoveries").select("*").eq("id", recoveryId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RecoveryRow | null) ?? null;
}

const CONVERSATION_STATUSES = ["ativo", "pausado", "recuperado", "parado_comprou"];
const pickConversation = (rows: RecoveryRow[]): RecoveryRow | null => rows.find((r) => r.status === "ativo") ?? rows[0] ?? null;

// Carrinho dessa pessoa pra conversa do WhatsApp: o mais recente dos
// últimos 30 dias, preferindo um ativo. Com storeId (loja do número que
// recebeu a mensagem), primeiro os carrinhos dessa loja: a mesma pessoa
// pode ter carrinho em duas marcas e a resposta tem que ser da marca cujo
// número ela chamou. Só cai em outra loja se não houver nada na loja do número.
export async function findRecoveryForPhone(admin: SupabaseClient, phone: string, storeId: string | null = null): Promise<RecoveryRow | null> {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data, error } = await admin
    .from("cart_recoveries")
    .select("*")
    .eq("phone", phone)
    .in("status", CONVERSATION_STATUSES)
    .gte("abandoned_at", since)
    .order("abandoned_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RecoveryRow[];
  if (storeId) {
    const inStore = pickConversation(rows.filter((r) => r.store_id === storeId));
    if (inStore) return inStore;
  }
  return pickConversation(rows);
}

// Chat "@lid" sem telefone conhecido: o carrinho é o da última mensagem que
// NÓS mandamos nesse mesmo chat (mesma sessão). Envio de teste não conta
// (vai pro telefone de teste, não pro cliente).
export async function findRecoveryForChat(admin: SupabaseClient, session: string, chatId: string): Promise<RecoveryRow | null> {
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("recovery_id, is_test, status")
    .eq("session", session)
    .eq("chat_id", chatId)
    .eq("direction", "outbound")
    .not("recovery_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Pick<WhatsappMessageRow, "recovery_id" | "is_test" | "status">>;
  const real = rows.find((m) => !m.is_test && m.status !== "test" && m.status !== "teste");
  if (!real?.recovery_id) return null;
  const rec = await loadRecovery(admin, real.recovery_id);
  if (!rec || !CONVERSATION_STATUSES.includes(rec.status)) return null;
  return rec;
}

async function loadStoreContexts(admin: SupabaseClient, storeId: string): Promise<Array<{ label: string; content: string; product_id: string | null }>> {
  const full = await admin.from("store_contexts").select("label, content, product_id").eq("store_id", storeId).order("created_at", { ascending: true });
  if (!full.error) return (full.data ?? []) as Array<{ label: string; content: string; product_id: string | null }>;
  // Sem a coluna product_id (migration 0011 não rodou): só label/content.
  const plain = await admin.from("store_contexts").select("label, content").eq("store_id", storeId).order("created_at", { ascending: true });
  return ((plain.data ?? []) as Array<{ label: string; content: string }>).map((c) => ({ ...c, product_id: null }));
}

// Unidades de um item pelo título ("3 יחידות של ...", "יחידה אחת", "צנצנת אחת", "2 units", "1x").
function unitsInTitle(title: string): number {
  const t = title ?? "";
  const n = /(?:^|\s)(\d{1,2})\s*(?:יחידות|יחידה|צנצנות|units?|unités?|pots?|potes?|unidades?|x\b|×)/i.exec(t);
  if (n) return Number(n[1]);
  return 1;
}
const GIFT_RE = /מתנ[הת]\s*הפתעה|surprise|presente|cadeau|regalo|geschenk/i;
const FREE_RE = /בחינם|gr[aá]tis|free|gratuit|offert|kostenlos/i;

// Unidades pagas, de brinde e presente surpresa do carrinho.
export function cartUnits(items: RecoveryRow["items"]): { paid: number; free: number; gift: boolean; name: string } {
  let paid = 0;
  let free = 0;
  let gift = false;
  let name = "";
  for (const i of Array.isArray(items) ? items : []) {
    const title = String(i.title ?? "");
    if (GIFT_RE.test(title)) {
      gift = true;
      continue;
    }
    const units = unitsInTitle(title) * (Number(i.quantity) || 1);
    const isFree = Number(i.lineTotal) === 0 || FREE_RE.test(title);
    if (isFree) free += units;
    else paid += units;
    if (!name && /tri[\s-]?lift/i.test(title)) name = "Olavita Tri-Lift";
  }
  return { paid, free, gift, name };
}

// Frases do roteiro do Ian (09/10), do jeito que ele escreveu: "o kit com 3
// unidades do complexo de peptídeos Olavita Tri-Lift, com 1 pote de brinde e
// um presente surpresa" e, para a cliente confusa, "do kit com 4 unidades do
// Olavita Tri Lift".
export function scriptProduct(items: RecoveryRow["items"], lang: "pt" | "he"): { produto: string; kitCurto: string } | null {
  const u = cartUnits(items);
  const n = u.paid + u.free;
  if (n === 0) return null;
  if (lang === "pt") {
    const base = u.paid > 1 ? `o kit com ${u.paid} unidades do complexo de peptídeos Olavita Tri-Lift` : "1 unidade do complexo de peptídeos Olavita Tri-Lift";
    const extras = u.free > 0 ? `, com ${u.free} pote${u.free > 1 ? "s" : ""} de brinde${u.gift ? " e um presente surpresa" : ""}` : u.gift ? ", com um presente surpresa" : "";
    return { produto: base + extras, kitCurto: n > 1 ? `do kit com ${n} unidades do Olavita Tri Lift` : "do Olavita Tri Lift (1 unidade)" };
  }
  const base = u.paid > 1 ? `את הערכה עם ${u.paid} יחידות של קומפלקס הפפטידים Olavita Tri-Lift` : "יחידה אחת של קומפלקס הפפטידים Olavita Tri-Lift";
  const extras = u.free > 0 ? `, עם ${u.free === 1 ? "צנצנת אחת" : `${u.free} צנצנות`} במתנה${u.gift ? " ומתנת הפתעה" : ""}` : u.gift ? ", עם מתנת הפתעה" : "";
  return { produto: base + extras, kitCurto: n > 1 ? `על הערכה עם ${n} יחידות של Olavita Tri-Lift` : "על יחידה אחת של Olavita Tri-Lift" };
}

const totalPhraseLang = (totalPct: number | null, lang: "pt" | "he"): string | null => {
  if (totalPct == null || !Number.isFinite(totalPct)) return null;
  const up = Math.ceil(totalPct / 5) * 5;
  const down = Math.floor(totalPct / 5) * 5;
  if (Math.abs(totalPct - Math.round(totalPct)) < 0.05 && Math.round(totalPct) % 5 === 0) return `${Math.round(totalPct)}%`;
  if (up - totalPct < 1) return lang === "pt" ? `quase ${up}%` : `כמעט ${up}%`;
  return lang === "pt" ? `mais de ${down}%` : `יותר מ-${down}%`;
};

// "kit com 4 unidades do Olavita Tri-Lift (3 + 1 de brinde) + presente surpresa"
// (Ian, 09/10: 3 pagos + 1 grátis é o kit com 4 unidades).
export function productSummaryPt(items: RecoveryRow["items"], fallbackName: string): string | null {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;
  const { paid, free, gift, name } = cartUnits(items);
  const product = name || fallbackName;
  const total = paid + free;
  if (total === 0) return gift ? `presente surpresa da ${product}` : null;
  const base = total === 1 ? `1 unidade do ${product}` : `kit com ${total} unidades do ${product}`;
  return `${base}${free > 0 && paid > 0 ? ` (${paid} + ${free} de brinde)` : ""}${gift ? " + presente surpresa" : ""}`;
}
// O mesmo resumo em hebraico (o agente não traduz: copiava o português).
export function productSummaryHe(items: RecoveryRow["items"]): string | null {
  const pt = productSummaryPt(items, "Olavita Tri-Lift");
  if (!pt) return null;
  const m = /(?:kit com (\d+) unidades|1 unidade) do (.+?)(?: \((\d+) \+ (\d+) de brinde\))?( \+ presente surpresa)?$/.exec(pt);
  if (!m) return null;
  const total = m[1] ? Number(m[1]) : 1;
  const base = total === 1 ? `יחידה אחת של ${m[2]}` : `ערכה עם ${total} יחידות של ${m[2]}`;
  return `${base}${m[3] ? ` (${m[3]} + ${m[4]} במתנה)` : ""}${m[5] ? " + מתנת הפתעה" : ""}`;
}

// Os cupons desta loja são calculados sobre o mesmo subtotal (visto no
// checkout em 09/10: ₪1.050 → 472,50 com o cupom do site → 315 com +15%),
// então as porcentagens somam. "quase 80%" quando falta menos de 1 ponto
// para o múltiplo de 5; senão "mais de 75%". Nunca arredonda para cima além disso.
export function totalDiscountPhrase(appliedExact: number | null, extra: number | null): { phrase: string; numbers: number[] } | null {
  if (!appliedExact || !extra) return null;
  const total = appliedExact + extra;
  const up = Math.ceil(total / 5) * 5;
  const down = Math.floor(total / 5) * 5;
  if (Math.abs(total - Math.round(total)) < 0.05 && Math.round(total) % 5 === 0) return { phrase: `${Math.round(total)}%`, numbers: [Math.round(total)] };
  if (up - total < 1) return { phrase: `quase ${up}%`, numbers: [up] };
  return { phrase: `mais de ${down}%`, numbers: [down] };
}

// Regras da loja que valem para a vendedora (antes da compra). As de suporte
// pós-compra (assinatura, chargeback, devolução, cancelamento) e as escritas
// para outra marca ("OsteoPure · ...") ficam de fora: confundiam o agente e
// empurravam a regra de venda do Ian para fora do limite de tamanho.
const POST_SALE_TEMAS = /assinatura|chargeback|regularizacao_financeira|devolucao|cancelamento|consta_entregue|cobranca/i;
function salesRelevantContext(c: { label: string; content: string }): boolean {
  if (/^osteopure\b/i.test(c.label.trim())) return false;
  const temas = /^temas:\s*(.*)$/im.exec(c.content)?.[1] ?? "";
  if (temas && POST_SALE_TEMAS.test(temas) && !/pagamento|preco_oferta/i.test(temas)) return false;
  return true;
}

export async function buildAgentContext(admin: SupabaseClient, rec: RecoveryRow, settings: RecoverySettings): Promise<AgentContext> {
  const lang = (rec.language || langFromCountry(rec.country_code) || "en").toLowerCase().slice(0, 2);
  const [storeRes, products, discountsRes, knowledgeRes, contexts, messagesRes, recentAgentRes, sentEventsRes, firstMsgRes] = await Promise.all([
    admin.from("stores").select("id, name").eq("id", rec.store_id).maybeSingle(),
    loadProducts(admin),
    admin.from("recovery_discounts").select("*").eq("store_id", rec.store_id).eq("active", true).order("percent", { ascending: true }),
    admin.from("recovery_knowledge").select("*").eq("store_id", rec.store_id).eq("active", true).order("created_at", { ascending: true }),
    loadStoreContexts(admin, rec.store_id),
    admin.from("whatsapp_messages").select("*").eq("recovery_id", rec.id).order("created_at", { ascending: false }).limit(30),
    admin.from("whatsapp_messages").select("id", { count: "exact", head: true }).eq("recovery_id", rec.id).eq("author", "agente").eq("direction", "outbound").gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()),
    admin.from("recovery_events").select("detail, created_at").eq("recovery_id", rec.id).eq("channel", "whatsapp").eq("type", "sent").order("created_at", { ascending: false }).limit(80),
    admin.from("whatsapp_messages").select("created_at").eq("recovery_id", rec.id).order("created_at", { ascending: true }).limit(1),
  ]);
  if (discountsRes.error) throw new Error(discountsRes.error.message);
  if (knowledgeRes.error) throw new Error(knowledgeRes.error.message);
  if (messagesRes.error) throw new Error(messagesRes.error.message);

  const storeName = (storeRes.data?.name as string | undefined) ?? "a loja";
  const items = Array.isArray(rec.items) ? rec.items : [];
  const titles = items.map((i) => i.title).filter(Boolean);

  // Marca: regra do dono, cliente israelense/hebraico é sempre Olavita (a
  // loja "Pure" vende Olavita em hebraico). Fora isso, o produto casado
  // pelos itens do carrinho; senão o nome da loja.
  const storeIsOlavita = /olavita/i.test(storeName);
  const isOlavita = !storeIsOlavita && (lang === "he" || rec.country_code === "IL" || titles.some((t) => hasHebrew(t)));
  const routed = routeProduct(products, { storeId: rec.store_id, recipients: [], texts: [], language: lang, orderTitles: titles });
  const product = isOlavita ? (products.items.find((p) => /olavita/i.test(p.name)) ?? routed) : routed;
  const brand = isOlavita ? "Olavita" : (product?.name ?? storeName);
  const persona = personaFor(product ?? null, brand, lang);
  const ownerTest = isOwnerSandbox(rec);
  // Teste do dono em português: nome em letras latinas (o configurado é hebraico).
  const configuredName = settings.agent_name?.trim() || persona.name;
  const agentName = ownerTest && lang === "pt" && /[\u0590-\u05FF]/.test(configuredName) ? "Yael" : configuredName;

  // Valores na moeda do cliente (Israel com carrinho em EUR vira shekel).
  const money = (value: string | number | null | undefined): string | null => {
    if (value == null || value === "") return null;
    const shown = customerAmount({ total: String(value), currency: rec.currency, country: rec.country_code });
    return shown ? formatMoney(shown.amount, shown.currency, lang) : null;
  };

  const maxDiscount = Number(settings.agent_max_discount ?? 0) || 0;
  const offeredPercent = Number(rec.offered_discount_percent ?? 0) || 0;
  const offeredCode = rec.offered_discount_code ?? null;
  const discounts = ((discountsRes.data ?? []) as RecoveryDiscount[])
    .map((d) => ({ percent: Number(d.percent), code: d.code }))
    .filter((d) => Number.isFinite(d.percent) && d.percent > 0 && d.percent <= maxDiscount && Boolean(d.code))
    .sort((a, b) => a.percent - b.percent);

  // Desconto que o carrinho já tem e o total com o adicional (o já oferecido ou o menor oferecível).
  const disc = Number(rec.total_discount ?? 0);
  const paidTotal = Number(rec.total ?? 0);
  const appliedExact = disc > 0 && paidTotal >= 0 ? (100 * disc) / (disc + paidTotal) : null;
  const extraPercent = offeredPercent > 0 ? offeredPercent : (offerableDiscounts({ discounts, maxDiscount, offeredPercent })[0]?.percent ?? null);
  const totalPhrase = totalDiscountPhrase(appliedExact, extraPercent);
  // Valor estimado com o adicional: o cupom da loja e o adicional são
  // calculados sobre o mesmo subtotal (visto no checkout em 09/10).
  const extra = extraSavings({ total: rec.total, total_discount: rec.total_discount }, extraPercent);
  const estimated = extra ? extra.final : null;
  // Roteiro do Ian: X = desconto que ela já tem (sobre o mesmo subtotal da
  // conta acima), E = porcentagem do nome do cupom (15/25/30), T = os dois
  // compostos ("15% em cima do valor com desconto").
  const extraCode = offeredCode ?? offerableDiscounts({ discounts, maxDiscount, offeredPercent })[0]?.code ?? null;
  const scriptX = extra && disc > 0 ? 100 * (1 - paidTotal / extra.subtotal) : appliedExact;
  const scriptE = nominalPercent(extraCode) ?? extra?.effectivePct ?? null;
  const scriptT = scriptX != null && scriptE != null ? 100 * (1 - (1 - scriptX / 100) * (1 - scriptE / 100)) : null;

  const knowledgeRows = (knowledgeRes.data ?? []) as RecoveryKnowledge[];
  // Roteiro do dono em texto fixo: o sistema escreve exatamente essas frases.
  const scriptTemplates: Record<string, Record<string, string>> = {};
  for (const k of knowledgeRows) {
    if (k.kind !== "script" || !k.title.startsWith("roteiro:")) continue;
    try {
      scriptTemplates[k.title.slice("roteiro:".length).trim()] = JSON.parse(k.content) as Record<string, string>;
    } catch {
      // conteúdo inválido: a etapa fica sem texto fixo (o modelo escreve)
    }
  }
  const knowledge = knowledgeRows.filter((k) => !(k.kind === "script" && k.title.startsWith("roteiro:"))).map((k) => `[${k.kind}] ${k.title}\n${k.content}`).join("\n\n").slice(0, 12_000);
  const storeContext = contexts
    .filter((c) => !c.product_id || !product || c.product_id === product.id)
    .filter(salesRelevantContext)
    .map((c) => `${c.label}: ${c.content}`)
    .join("\n\n")
    .slice(0, 8_000);

  const history: AgentHistoryEntry[] = ((messagesRes.data ?? []) as WhatsappMessageRow[])
    .reverse()
    .map((m) => ({ author: m.author, body: (m.body ?? "").trim() || (m.has_media ? "(mídia sem texto)" : ""), at: m.sent_at ?? m.created_at }))
    .filter((m) => m.body);
  // Última(s) mensagem(ns) do cliente no fim da conversa (várias seguidas
  // viram uma só; é o que o debounce quer).
  const trailing: string[] = [];
  for (let i = history.length - 1; i >= 0 && history[i].author === "cliente"; i--) trailing.unshift(history[i].body);

  return {
    recoveryId: rec.id,
    waStep: rec.wa_step || 1,
    storeName,
    brand,
    agentName,
    customerName: rec.first_name?.trim() || null,
    language: lang,
    countryCode: rec.country_code,
    items: items.map((i) => ({ title: i.title, variant: i.variantTitle, quantity: Number(i.quantity) || 1, unitPrice: money(i.unitPrice), lineTotal: money(i.lineTotal), free: Number(i.lineTotal) === 0 || /בחינם|gr[aá]tis|free|gratuit|cadeau/i.test(i.title ?? "") })),
    total: money(rec.total),
    appliedCodes: Array.isArray(rec.discount_codes) ? rec.discount_codes.filter(Boolean) : [],
    cartLink: agentCartLink(rec.id, rec.wa_step || 1, offeredCode),
    offeredPercent,
    offeredCode,
    maxDiscount,
    discounts,
    knowledge,
    storeContext,
    ownerPrompt: settings.agent_prompt ?? null,
    history,
    latestMessage: trailing.join("\n"),
    agentMessageCount: history.filter((m) => m.author === "agente").length,
    agentMessages24h: recentAgentRes.count ?? undefined,
    // Só envios desta conversa: depois da 1ª mensagem ainda ligada ao carrinho
    // (o "reset" da conversa-teste desliga as mensagens antigas).
    scriptStepsSent: (() => {
      const firstAt = ((firstMsgRes.data ?? [])[0] as { created_at?: string } | undefined)?.created_at;
      if (!firstAt) return [];
      const from = new Date(firstAt).getTime() - 1000;
      const evs = ((sentEventsRes.data ?? []) as Array<{ detail: { notes?: unknown } | null; created_at: string }>).filter((e) => new Date(e.created_at).getTime() >= from);
      return scriptStepsFromNotes(evs.flatMap((e) => (Array.isArray(e.detail?.notes) ? (e.detail?.notes as unknown[]).map(String) : [])));
    })(),
    localTime: localTimeLabel(rec.country_code, lang),
    ownerTest,
    appliedPercent: scriptX ? Math.round(scriptX) : null,
    scriptTemplates,
    scriptVars: (() => {
      const out: Record<string, Record<string, string>> = {};
      for (const lg of ["pt", "he"] as const) {
        const prod = scriptProduct(rec.items, lg);
        const v: Record<string, string> = { nome: displayFirstName(rec.first_name) };
        if (prod) Object.assign(v, { produto: prod.produto, kit_curto: prod.kitCurto });
        if (scriptX) v.X = `${Math.round(scriptX)}%`;
        if (scriptE) v.E = `${scriptE}%`;
        const t = totalPhraseLang(scriptT, lg);
        if (t) v.T = t;
        if (extra) {
          const fin = money(extra.final);
          if (fin) v.preco_final = fin;
        }
        const cur = money(rec.total);
        if (cur) v.preco_atual = cur;
        out[lg] = v;
      }
      return out;
    })(),
    productSummary: productSummaryPt(rec.items, brand),
    productSummaryHe: productSummaryHe(rec.items),
    totalDiscountPhrase: totalPhraseLang(scriptT, "pt") ?? totalPhrase?.phrase ?? null,
    estimatedWithExtra: estimated != null ? money(estimated) : null,
    extraSaving: extra ? money(extra.saving) : null,
    factualPercents: [...new Set([appliedExact ? Math.round(appliedExact) : 0, scriptX ? Math.round(scriptX) : 0, ...(nominalPercent(extraCode) == null ? [extraPercent ?? 0, extra?.effectivePct ?? 0] : []), scriptE ?? 0, ...(totalPhrase?.numbers ?? []), ...(scriptT != null ? [Math.round(scriptT), Math.ceil(scriptT / 5) * 5, Math.floor(scriptT / 5) * 5] : [])].filter((n) => n > 0))],
  };
}

// ---------------------------------------------------------------------------
// Envio e gravação.
// ---------------------------------------------------------------------------

const isDuplicate = (err: { code?: string; message?: string } | null | undefined) => Boolean(err && (err.code === "23505" || /duplicate key|unique/i.test(err.message ?? "")));

// Modo de teste: o cliente real NUNCA recebe; tudo vai pro test_phone.
function outboundTarget(settings: RecoverySettings, phone: string | null): { phone: string; isTest: boolean } | null {
  if (settings.test_mode) {
    const raw = settings.test_phone?.trim();
    if (!raw) return null;
    return { phone: normalizePhone(raw, null) ?? raw, isTest: true };
  }
  return phone ? { phone, isTest: false } : null;
}

// Sessão (número) que responde: a presa ao cliente, senão a que recebeu a
// mensagem, senão a rotação do motor. Uma sessão só serve se for da loja
// do carrinho (ou sem loja), estiver ativa, WORKING e sem restrição (ou se
// nem estiver cadastrada, caso da sessão que acabou de receber a mensagem).
// Número de outra marca nunca responde por esta: o cliente que chamou o
// número da DermaMagazin não pode ouvir "aqui é a Noa da Olavita".
async function resolveSession(admin: SupabaseClient, rec: RecoveryRow, preferred: string | null): Promise<string | null> {
  for (const name of [rec.waha_session, preferred]) {
    if (!name) continue;
    const { data } = await admin.from("whatsapp_sessions").select("name, store_id, active, status, restricted_until, detail").eq("name", name).maybeSingle();
    const row = data as Pick<WhatsappSessionRow, "name" | "store_id" | "active" | "status" | "restricted_until" | "detail"> | null;
    if (!row) return name;
    if (row.store_id && row.store_id !== rec.store_id) continue;
    let restricted = row.restricted_until ? new Date(row.restricted_until).getTime() > Date.now() : false;
    // Reachout Timelock só barra contato NOVO. Quem escreveu para nós nas
    // últimas 72 h é conversa aberta pelo cliente: a resposta segue.
    if (restricted && isTimelockDetail(row.detail) && rec.last_inbound_at && Date.now() - new Date(rec.last_inbound_at).getTime() < 72 * 3600_000) restricted = false;
    if (row.active && row.status === "WORKING" && !restricted) return name;
  }
  const picked = await pickSession(admin, rec.store_id, rec);
  return picked?.name ?? null;
}

interface DeliverInput {
  rec: RecoveryRow;
  settings: RecoverySettings;
  text: string;
  textPt: string | null;
  author: "agente" | "regua";
  language: string | null;
  preferredSession: string | null;
  discountCode?: string | null;
  // Evento 'queued' já gravado (trava): vira 'sent'. Sem ele, insere o 'sent'.
  claimEventId?: string | null;
}
type DeliverResult = { sent: true; messageId: string | null; to: string; isTest: boolean; session: string } | { sent: false; reason: string };

async function deliver(admin: SupabaseClient, input: DeliverInput): Promise<DeliverResult> {
  const { rec, settings } = input;
  const text = stripDashes(input.text).trim();
  if (!text) return { sent: false, reason: "texto_vazio" };
  const leak = portugueseLeak(text, input.language);
  if (leak.length > 0) return { sent: false, reason: `idioma: ${leak.join(", ")}` };
  // Carrinho com cupom antigo dos anúncios: o link abre no preço errado (links.ts). Nada com link sai; a equipe vê.
  if (HOLD_LEGACY_COUPON_CARTS && hasLegacyCoupon(rec.discount_codes) && /https?:\/\//i.test(text)) return { sent: false, reason: "cupom_antigo_em_espera" };
  if (!wahaConfigured()) return { sent: false, reason: "waha_nao_configurado" };
  const target = outboundTarget(settings, rec.phone);
  if (!target) return { sent: false, reason: settings.test_mode ? "teste_sem_telefone" : "sem_telefone" };
  // Gate da régua (regra 2.1): nada sai sem enabled E whatsapp_enabled, nem
  // a confirmação de parada. Relido aqui porque a configuração pode ter
  // mudado entre o webhook e o envio.
  if (!canSend(settings, "whatsapp")) return { sent: false, reason: "canal_desligado" };
  const session = await resolveSession(admin, rec, input.preferredSession);
  if (!session) return { sent: false, reason: "sem_sessao" };
  // Trava anti-rajada na conversa (ver CHAT_MIN_GAP_MS). Erro de banco = não envia.
  {
    const { data: recentOut, error: recentErr } = await admin.from("whatsapp_messages").select("created_at").eq("recovery_id", rec.id).eq("direction", "outbound").gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(20);
    if (recentErr) return { sent: false, reason: "erro_trava_conversa" };
    if ((recentOut ?? []).length >= (isOwnerSandbox(rec) ? CHAT_BURST_MAX_OWNER : CHAT_BURST_MAX)) return { sent: false, reason: "limite_rajada_conversa" };
    const lastAt = recentOut?.[0]?.created_at ? new Date(recentOut[0].created_at as string).getTime() : 0;
    const wait = lastAt + CHAT_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(Math.min(wait, CHAT_MIN_GAP_MS));
  }

  const chatId = chatIdFromPhone(target.phone);
  let messageId: string | null;
  let raw: unknown;
  // Link do painel vira link curto no domínio da loja (falha = não envia).
  const finalText = await shortenLinks(admin, text);
  try {
    ({ messageId, raw } = await sendText(session, chatId, finalText, { humanize: true }));
  } catch (err) {
    // 463/475: o número entrou em restrição temporária. Marca a sessão na
    // hora pra régua e o próximo cliente não baterem no mesmo número.
    if (err instanceof WahaError && err.isRestriction) await restrictSession(admin, session, 24, err.message);
    throw err;
  }
  const now = new Date().toISOString();

  await admin.from("whatsapp_messages").insert({
    session,
    chat_id: chatId,
    phone: target.phone,
    direction: "outbound",
    author: input.author,
    message_id: messageId,
    body: finalText,
    body_pt: input.textPt,
    has_media: false,
    step: null,
    ack: 0,
    status: target.isTest ? "teste" : null,
    is_test: target.isTest,
    recovery_id: rec.id,
    raw,
    sent_at: now,
  });

  // Evento de trava (queued → sent): a dedupe_key NUNCA muda (continua
  // "wa-agent:<mensagem recebida>"), senão a reentrega do webhook do WAHA
  // passa pela trava e o cliente recebe uma segunda resposta. O id de
  // saída fica em message_id (é o que o ack casa).
  const eventPatch = { type: "sent", provider: "waha", message_id: messageId, to_address: target.phone, language: input.language, discount_code: input.discountCode ?? null, is_test: target.isTest };
  if (input.claimEventId) {
    await admin.from("recovery_events").update(eventPatch).eq("id", input.claimEventId);
  } else {
    await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", detail: { author: input.author }, ...eventPatch, dedupe_key: messageId ? `wa-out:${messageId}` : null });
  }
  await admin
    .from("cart_recoveries")
    .update({ last_outbound_at: now, first_contact_at: rec.first_contact_at ?? now, waha_session: rec.waha_session ?? session, last_event_at: now, updated_at: now })
    .eq("id", rec.id);
  return { sent: true, messageId, to: target.phone, isTest: target.isTest, session };
}

export async function flagNeedsHuman(admin: SupabaseClient, recoveryId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin.from("cart_recoveries").update({ needs_human: true, needs_human_reason: reason.slice(0, 500), last_event_at: now, updated_at: now }).eq("id", recoveryId);
  if (error) console.error("agente: não consegui marcar needs_human:", error.message);
}

// Cliente mandou palavra de parada: o webhook já parou a régua e gravou a
// supressão; aqui só a confirmação curta no idioma, sem passar pelo modelo.
// Só sai com a régua e o canal ligados (canSend) e fora do modo de teste;
// senão fica só o registro (a supressão já vale de qualquer jeito).
export async function sendStopConfirmation(admin: SupabaseClient, input: { recovery: RecoveryRow; settings: RecoverySettings; sessionName: string | null; messageId?: string | null }): Promise<void> {
  const rec = input.recovery;
  const settings = input.settings;
  const lang = (rec.language || langFromCountry(rec.country_code) || "en").toLowerCase().slice(0, 2);
  const text = stopConfirmation(lang);
  if (!text) return;
  const dedupeKey = input.messageId ? `wa-stopconf:${input.messageId}` : null;
  const baseEvent = { recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", provider: "waha", language: lang, is_test: settings.test_mode, dedupe_key: dedupeKey };
  let claimId: string | null = null;
  try {
    const allowed = canSend(settings, "whatsapp") && !settings.test_mode;
    if (!allowed) {
      const reason = settings.test_mode ? "modo_teste" : "canal_desligado";
      const { error } = await admin.from("recovery_events").insert({ ...baseEvent, type: "skipped", detail: { reason, author: "agente", inbound: input.messageId ?? null, text: "confirmação de parada" } });
      if (error && !isDuplicate(error)) console.warn("agente: não registrei a confirmação de parada pulada:", error.message);
      return;
    }
    // Trava antes do envio: a reentrega do webhook não confirma duas vezes.
    if (dedupeKey) {
      const claim = await admin.from("recovery_events").insert({ ...baseEvent, type: "queued", detail: { author: "agente", inbound: input.messageId, text: "confirmação de parada" } }).select("id").single();
      if (claim.error) {
        if (isDuplicate(claim.error)) return;
        throw new Error(claim.error.message);
      }
      claimId = claim.data.id as string;
    }
    const r = await deliver(admin, { rec, settings, text, textPt: STOP_CONFIRMATION_PT, author: "agente", language: lang, preferredSession: input.sessionName, claimEventId: claimId });
    if (!r.sent) {
      console.warn(`agente: confirmação de parada não enviada (${r.reason})`);
      if (claimId) await admin.from("recovery_events").update({ type: "skipped", detail: { reason: r.reason, author: "agente", inbound: input.messageId ?? null } }).eq("id", claimId);
    }
  } catch (err) {
    // Restrição 463/475 já marcou a sessão dentro de deliver(). A trava
    // vira 'failed' (dedupe mantida: a reentrega não tenta de novo).
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente: confirmação de parada falhou:", msg);
    if (claimId) await admin.from("recovery_events").update({ type: "failed", detail: { error: msg.slice(0, 500), author: "agente", inbound: input.messageId ?? null } }).eq("id", claimId);
  }
}

// ---------------------------------------------------------------------------
// Entrada do webhook: cliente escreveu.
// ---------------------------------------------------------------------------

// Resultado de uma resposta do agente: sent = saiu; model_down = modelo
// indisponível (fica aguardando); busy = outra mensagem automática da loja
// acabou de sair (trava anti-rajada); skipped = nada a fazer ou erro.
export type InboundOutcome = "sent" | "model_down" | "busy" | "skipped";
// `retry`: resposta atrasada de uma mensagem que ficou "aguardando_modelo"
// (retryPendingReplies): sem espera, trava própria (wa-retry:<mensagem>),
// trava anti-rajada da loja e pedido de desculpas pela demora.
export async function handleInboundWhatsapp(admin: SupabaseClient, input: { recovery: RecoveryRow; settings: RecoverySettings; messageId: string; retry?: boolean }): Promise<InboundOutcome> {
  // Debounce: só a chamada da última mensagem responde (a retentativa não espera).
  if (!input.retry) await sleep(DEBOUNCE_MS);
  let rec: RecoveryRow = input.recovery;
  let settings: RecoverySettings = input.settings;
  let lastInbound: Pick<WhatsappMessageRow, "message_id" | "session"> | null = null;
  try {
    rec = (await loadRecovery(admin, input.recovery.id)) ?? input.recovery;
    settings = (await loadRecoverySettings(admin, rec.store_id)) ?? input.settings;
    // Conversa de teste do dono: canal e agente ligados só aqui, tudo como teste.
    if (isOwnerSandbox(rec)) settings = sandboxSettings(settings, rec);
    const { data } = await admin.from("whatsapp_messages").select("message_id, session").eq("recovery_id", rec.id).eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle();
    lastInbound = (data as Pick<WhatsappMessageRow, "message_id" | "session"> | null) ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (RECOVERY_MISSING_TABLE.test(msg)) {
      console.error("agente: migration 0018 não rodou:", msg);
      return "skipped";
    }
    await flagNeedsHuman(admin, input.recovery.id, `erro: ${msg}`.slice(0, 300));
    return "skipped";
  }
  if (lastInbound?.message_id && lastInbound.message_id !== input.messageId) return "skipped";

  // Número suprimido (pediu para parar em qualquer canal, ou supressão geral):
  // o agente NÃO responde. A mensagem do cliente já foi gravada pelo webhook,
  // aqui só não sai nada. Erro de consulta = não responde (falha fechado).
  if (rec.phone) {
    const { data: sup, error: supErr } = await admin.from("recovery_suppressions").select("id").in("channel", ["whatsapp", "all"]).eq("address", rec.phone).limit(1);
    if (supErr) {
      console.error("agente: consulta de supressão falhou:", supErr.message);
      await flagNeedsHuman(admin, rec.id, "erro_supressao");
      return "skipped";
    }
    if ((sup ?? []).length > 0) return "skipped";
  }

  // Gates: humano assumiu ou pausou = não mexer; já está com humano = nada;
  // agente/canal/régua desligados = marcar pra humano ver.
  if (rec.agent_mode !== "agente" || rec.needs_human) return "skipped";
  if (!(settings.enabled && settings.whatsapp_enabled && settings.agent_enabled)) {
    await flagNeedsHuman(admin, rec.id, "agente_desligado");
    return "skipped";
  }
  if (rec.status !== "ativo") {
    await flagNeedsHuman(admin, rec.id, `status_${rec.status}`);
    return "skipped";
  }
  // Carrinho sem item do Olavita (produto novo): a Yael só vende Olavita.
  // Não responde; a equipe vê a conversa (product-gate.ts).
  if (!isOwnerSandbox(rec) && !isFlowProduct(rec.items)) {
    await flagNeedsHuman(admin, rec.id, FLOW_PRODUCT_STOP);
    return "skipped";
  }
  if (!rec.phone) {
    await flagNeedsHuman(admin, rec.id, "sem_telefone");
    return "skipped";
  }
  let claimId: string | null = null;
  try {
    // Trava: uma resposta por mensagem recebida (o WAHA repete o webhook).
    const claim = await admin
      .from("recovery_events")
      .insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "queued", dedupe_key: input.retry ? `wa-retry:${input.messageId}` : `wa-agent:${input.messageId}`, provider: "waha", language: rec.language, is_test: settings.test_mode, detail: { author: "agente", inbound: input.messageId, ...(input.retry ? { retry: true } : {}) } })
      .select("id, created_at")
      .single();
    if (claim.error) {
      // Retentativa: duplicata = outra execução do cron (ticks se sobrepõem) está
      // respondendo essa mensagem agora; a conversa continua na fila.
      if (isDuplicate(claim.error)) return input.retry ? "busy" : "skipped";
      throw new Error(claim.error.message);
    }
    claimId = claim.data.id as string;
    // Retentativa é mensagem que sai sem ela ter acabado de escrever: segue a
    // trava anti-rajada da loja (outra mensagem automática travada antes = espera).
    if (input.retry && (await paceConflict(admin, { claimId, claimAt: (claim.data.created_at as string | null) ?? null, storeId: rec.store_id, channel: "whatsapp", isTest: settings.test_mode }))) {
      await releasePacedClaim(admin, claimId);
      return "busy";
    }

    // Doublecheck de compra (Ian, 10/10), em paralelo com a montagem do
    // contexto: checkout completado ou pedido pago por e-mail/telefone, na
    // Shopify ao vivo. Comprou = a régua para (status recuperado) e o agente
    // responde em modo "já comprou" (agradece, sem link nem desconto).
    // Consulta falhou = estado "desconhecido" (não afirma pagamento nem manda
    // link). A conversa-sandbox do dono tem checkout fictício: "não encontrado".
    const sandboxRec = isOwnerSandbox(rec);
    const [verified, ctx] = await Promise.all([
      sandboxRec ? Promise.resolve<VerifiedPurchase>({ purchase: { state: "nao_encontrado" }, stop: null }) : verifyPurchase(admin, rec),
      buildAgentContext(admin, rec, settings),
    ]);
    if (verified.stop) await applyStop(admin, rec, verified.stop);
    ctx.purchase = verified.purchase;
    if (input.retry && rec.last_inbound_at) {
      const mins = Math.max(1, Math.round((Date.now() - new Date(rec.last_inbound_at).getTime()) / 60_000));
      ctx.delayNote = `a última mensagem dela ficou ${mins >= 120 ? `cerca de ${Math.round(mins / 60)} horas` : `${mins} minutos`} sem resposta por um problema técnico do nosso lado`;
    }
    // Disse que pagou e nada apareceu pelo e-mail/telefone do carrinho: se ela
    // informou nome, e-mail ou número do pedido, busca o pedido pago por isso
    // (Ian, 10/10: "ir olhar o pedido na Shopify"). Achou = comprou.
    if (!sandboxRec && verified.purchase.state === "nao_encontrado" && ((rec.tags ?? []).includes("disse_que_pagou") || isPaidClaim(ctx.latestMessage))) {
      const lookup = await withTimeout(lookupPaidOrderFromMessage(admin, rec, ctx.latestMessage), 12_000, { found: null, hint: null });
      const hit = lookup.found;
      if (hit) {
        ctx.purchase = { state: "pago", order: hit.order.name };
        await applyStop(admin, rec, { ok: false, reason: "comprou_outro_pedido", detail: hit.order.name, terminal: true, patch: { recovered_order_id: hit.order.id, recovered_order_name: hit.order.name, recovered_at: hit.order.createdAt, attribution: hit.via } });
      } else if (lookup.hint) {
        ctx.purchase = { ...ctx.purchase, hint: lookup.hint };
      }
    }
    const decision = await decideAgentReply(ctx);
    const now = new Date().toISOString();
    const tags = new Set(rec.tags ?? []);
    const patch: Record<string, unknown> = { summary_pt: decision.summary_pt || rec.summary_pt, last_event_at: now, updated_at: now };
    // Modelo indisponível: alerta urgente pro Ian e a resposta de verdade sai
    // quando ele voltar (tag aguardando_modelo). Na retentativa, nada sai.
    if (decision.model_down) await alertModelDown(admin, settings, decision.notes.find((n) => n.startsWith("modelo indisponível")) ?? "modelo indisponível", null).catch((err) => console.error("agente: alerta da OpenAI falhou:", err instanceof Error ? err.message : err));
    else await resolveOpenAlerts(admin, "outro", MODEL_ALERT_KEY);
    if (decision.needs_retry && input.retry) {
      await releasePacedClaim(admin, claimId, "modelo_indisponivel");
      return "model_down";
    }
    if (decision.needs_retry) tags.add("aguardando_modelo");
    else tags.delete("aguardando_modelo");
    if (decision.needs_retry || (rec.tags ?? []).includes("aguardando_modelo")) patch.tags = [...tags];
    // Disse que pagou e a Shopify não mostra o pedido: a resposta (texto fixo)
    // pede o comprovante; a conversa fica marcada (sem retomada de venda) e a
    // equipe entra quando ela mandar o print ou insistir.
    if (decision.says_paid && verified.purchase.state !== "pago") {
      tags.add("disse_que_pagou");
      patch.tags = [...tags];
    }

    // Dúvida que o agente não sabe (fato do produto/empresa fora do CONHECIMENTO):
    // handoff LEVE. A cliente recebe "vou confirmar e já te aviso", a equipe
    // recebe a pergunta por e-mail e a vendedora CONTINUA a conversa (Ian,
    // 10/10: uma vendedora de verdade não some depois de "vou confirmar").
    const softHandoff = decision.action === "handoff" && decision.handoff_tipo === "fato_desconhecido";
    if (softHandoff) {
      tags.add("pergunta_pendente");
      patch.tags = [...tags];
      await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "handoff", dedupe_key: `wa-pergunta:${input.messageId}`, provider: "waha", language: decision.language, is_test: settings.test_mode, detail: { soft: true, reason: decision.handoff_reason, notes: decision.notes } });
      await notifyTeamQuestion(admin, rec, settings, decision.handoff_reason ?? ctx.latestMessage).catch((err) => console.error("agente: aviso da pergunta à equipe falhou:", err instanceof Error ? err.message : err));
    }
    // Estado que reflete o que o cliente disse (vale mesmo se nada sair).
    if (decision.action === "handoff" && !softHandoff) {
      Object.assign(patch, { needs_human: true, needs_human_reason: decision.handoff_reason ?? "agente pediu ajuda", agent_mode: "humano" });
      await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "handoff", dedupe_key: `wa-handoff:${input.messageId}`, provider: "waha", language: decision.language, is_test: settings.test_mode, detail: { reason: decision.handoff_reason, notes: decision.notes } });
    } else if (decision.action === "stop") {
      Object.assign(patch, { status: "parado_descadastrou", stop_reason: "pediu_para_parar", wa_next_at: null, email_next_at: null, next_send_at: null });
      if (!isOwnerSandbox(rec)) await admin.from("recovery_suppressions").upsert({ channel: "whatsapp", address: rec.phone, reason: "replied_stop", source: "agente" }, { onConflict: "channel,address", ignoreDuplicates: true });
      await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "unsubscribed", dedupe_key: `wa-stop:${input.messageId}`, provider: "waha", language: decision.language, is_test: settings.test_mode, detail: { via: "agente" } });
    } else if (decision.action === "bought") {
      tags.add("disse_que_comprou");
      patch.tags = [...tags];
    } else if (decision.action === "not_interested") {
      tags.add("nao_quer");
      Object.assign(patch, { tags: [...tags], wa_next_at: null });
    }
    await admin.from("cart_recoveries").update(patch).eq("id", rec.id);
    rec = { ...rec, ...(patch as Partial<RecoveryRow>) };

    if (!decision.reply) {
      await admin.from("recovery_events").update({ type: "skipped", detail: { reason: "sem_texto", action: decision.action, notes: decision.notes } }).eq("id", claimId);
      return "skipped";
    }
    const r = await deliver(admin, {
      rec,
      settings,
      text: decision.reply,
      textPt: decision.reply_pt || null,
      author: "agente",
      language: decision.language,
      preferredSession: lastInbound?.session ?? null,
      discountCode: decision.discount_code,
      claimEventId: claimId,
    });
    if (!r.sent) {
      // Número do WhatsApp fora do ar: a resposta NÃO se perde nem vira "precisa de humano" (3 clientes
      // foram marcadas assim em 11/10 com o número em FAILED). Fica na fila (aguardando_modelo) e a retentativa
      // responde quando o número voltar; a chave da trava é liberada para a retentativa poder travar de novo.
      if (r.reason === "sem_sessao") {
        await releasePacedClaim(admin, claimId, "sem_sessao");
        const waiting = new Set(rec.tags ?? []);
        waiting.add("aguardando_modelo");
        await admin.from("cart_recoveries").update({ tags: [...waiting], updated_at: new Date().toISOString() }).eq("id", rec.id);
        return "model_down";
      }
      await admin.from("recovery_events").update({ type: "skipped", detail: { reason: r.reason, action: decision.action, notes: decision.notes } }).eq("id", claimId);
      // Sem WAHA configurado ou outro motivo: alguém precisa olhar. Em teste sem telefone
      // de teste não é erro, é configuração.
      if (r.reason !== "teste_sem_telefone") await flagNeedsHuman(admin, rec.id, `nao_enviado: ${r.reason}`);
      return "skipped";
    }
    if (decision.action === "offer_discount" && decision.discount_code) {
      await admin.from("cart_recoveries").update({ offered_discount_code: decision.discount_code, offered_discount_percent: decision.discount_percent, updated_at: new Date().toISOString() }).eq("id", rec.id);
    }
    if (decision.notes.length > 0) await admin.from("recovery_events").update({ detail: { author: "agente", inbound: input.messageId, action: decision.action, notes: decision.notes } }).eq("id", claimId);
    return "sent";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente vendedor:", msg);
    // Modelo caiu no meio da decisão: igual ao modelo indisponível (a equipe
    // não é acionada; a resposta sai quando ele voltar).
    if (err instanceof ModelUnavailableError) {
      if (claimId) await admin.from("recovery_events").update({ type: "failed", ...(input.retry ? { dedupe_key: null } : {}), detail: { error: msg.slice(0, 500), inbound: input.messageId, model_down: true } }).eq("id", claimId);
      const pending = new Set(rec.tags ?? []);
      pending.add("aguardando_modelo");
      await admin.from("cart_recoveries").update({ tags: [...pending], updated_at: new Date().toISOString() }).eq("id", rec.id);
      await alertModelDown(admin, settings, msg, null).catch(() => undefined);
      return "model_down";
    }
    // 463/475: deliver() já marcou restricted_until na sessão; aqui só o
    // motivo claro pro painel. A trava fica como 'failed' (dedupe mantida:
    // a reentrega do webhook não gera nova tentativa pro cliente).
    const restricted = err instanceof WahaError && err.isRestriction;
    if (claimId) await admin.from("recovery_events").update({ type: "failed", detail: { error: msg.slice(0, 500), inbound: input.messageId, restriction: restricted } }).eq("id", claimId);
    await flagNeedsHuman(admin, rec.id, restricted ? `numero_restrito: ${msg}`.slice(0, 300) : `erro: ${msg}`.slice(0, 300));
    return "skipped";
  }
}

// Imagem ou áudio sem texto: o agente não vê nem ouve. Em vez de silêncio, uma
// resposta curta no idioma da cliente. Imagem (muitas vezes o comprovante) =
// "recebi, vou conferir com a equipe" e a conversa vai para a equipe; áudio =
// pede para escrever (sem acionar a equipe). Mesmas condições de envio e
// mesma trava (uma resposta por mensagem recebida) do agente.
const MEDIA_ACK: Record<"imagem" | "audio", Record<string, string>> = {
  imagem: {
    he: "קיבלתי, תודה! אבדוק עם הצוות ואחזור עם תשובה עוד רגע.",
    pt: "Recebi, obrigada! Vou conferir com a equipe e já te confirmo.",
    en: "Got it, thank you! I will check with the team and get back to you shortly.",
  },
  audio: {
    he: "קיבלתי את ההודעה הקולית, אבל כאן אני קוראת רק טקסט. אפשר לכתוב לי במילים?",
    pt: "Recebi o seu áudio, mas por aqui eu só consigo ler texto. Pode me escrever?",
    en: "I received your voice message, but here I can only read text. Could you write it to me?",
  },
};
export async function sendMediaAck(admin: SupabaseClient, input: { recovery: RecoveryRow; settings: RecoverySettings; sessionName: string | null; messageId: string; kind: "imagem" | "audio" }): Promise<void> {
  const rec = input.recovery;
  const sandbox = isOwnerSandbox(rec);
  const settings = sandbox ? sandboxSettings(input.settings, rec) : input.settings;
  const toHuman = async (reason: string) => {
    if (!sandbox) await flagNeedsHuman(admin, rec.id, reason);
  };
  const lang = sandbox ? "pt" : (rec.language || langFromCountry(rec.country_code) || "en").toLowerCase().slice(0, 2);
  const text = MEDIA_ACK[input.kind][lang] ?? waitPhrase(lang);
  const textPt = MEDIA_ACK[input.kind].pt;
  const needsTeam = input.kind === "imagem";
  const canAnswer = rec.agent_mode === "agente" && !rec.needs_human && rec.status === "ativo" && settings.enabled && settings.whatsapp_enabled && settings.agent_enabled && Boolean(rec.phone) && Boolean(text);
  if (!canAnswer) {
    await toHuman(needsTeam ? "imagem recebida (comprovante?)" : "áudio recebido");
    return;
  }
  const { data: sup, error: supErr } = await admin.from("recovery_suppressions").select("id").in("channel", ["whatsapp", "all"]).eq("address", rec.phone as string).limit(1);
  if (supErr || (sup ?? []).length > 0) return; // suprimido (ou consulta falhou): não responde
  const dedupeKey = `wa-media:${input.messageId}`;
  const claim = await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "queued", dedupe_key: dedupeKey, provider: "waha", language: lang, is_test: settings.test_mode, detail: { author: "agente", inbound: input.messageId, media: input.kind } }).select("id").single();
  if (claim.error) {
    if (!isDuplicate(claim.error)) console.error("agente: trava da resposta de mídia falhou:", claim.error.message);
    return;
  }
  const claimId = claim.data.id as string;
  try {
    const r = await deliver(admin, { rec, settings, text: text as string, textPt, author: "agente", language: lang, preferredSession: input.sessionName, claimEventId: claimId });
    if (!r.sent) {
      await admin.from("recovery_events").update({ type: "skipped", detail: { reason: r.reason, author: "agente", inbound: input.messageId, media: input.kind } }).eq("id", claimId);
      await toHuman(`mídia recebida; resposta não enviada: ${r.reason}`.slice(0, 300));
      return;
    }
    if (needsTeam) await toHuman("imagem recebida (comprovante?)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente: resposta de mídia falhou:", msg);
    await admin.from("recovery_events").update({ type: "failed", detail: { error: msg.slice(0, 500), author: "agente", inbound: input.messageId, media: input.kind } }).eq("id", claimId);
    await toHuman(`mídia recebida; erro: ${msg}`.slice(0, 300));
  }
}

// Retomada (pedido do Ian, 09/10): a cliente respondeu, a conversa andou e
// ela parou de responder. NUDGE_AFTER_MIN depois da última mensagem do
// agente, UMA mensagem de retomada no estilo do roteiro, dentro da janela de
// 24 h do WhatsApp (desde a última mensagem dela) e do horário permitido.
// Uma por silêncio: a trava é wa-nudge:<carrinho>:<última mensagem dela>.
// Chamado pelo cron do tick (app/api/cron/recovery-tick) com o tempo que sobrar.
export const NUDGE_AFTER_MIN = 60;
const WA_WINDOW_HOURS = 23;
export async function runAgentNudges(admin: SupabaseClient, opts: { deadline: number; max?: number }): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const out = { sent: 0, skipped: 0, errors: [] as string[] };
  const now = Date.now();
  const { data, error } = await admin
    .from("cart_recoveries")
    .select("*")
    .eq("status", "ativo")
    .eq("agent_mode", "agente")
    .eq("needs_human", false)
    .gte("last_inbound_at", new Date(now - WA_WINDOW_HOURS * 3600_000).toISOString())
    .lte("last_outbound_at", new Date(now - NUDGE_AFTER_MIN * 60_000).toISOString())
    .order("last_outbound_at", { ascending: true })
    .limit(50);
  if (error) {
    out.errors.push(`retomada: ${error.message}`);
    return out;
  }
  const settingsCache = new Map<string, RecoverySettings | null>();
  const pace = { admin, paceLast: new Map<string, number>() };
  for (const row of (data ?? []) as RecoveryRow[]) {
    if (Date.now() > opts.deadline || out.sent >= (opts.max ?? 3)) break;
    const rec = row;
    if (!rec.phone || !rec.last_inbound_at || !rec.last_outbound_at) continue;
    if (new Date(rec.last_outbound_at).getTime() <= new Date(rec.last_inbound_at).getTime()) continue; // ela falou por último: o webhook cuida
    const tags = rec.tags ?? [];
    if (tags.includes("nao_quer") || tags.includes("disse_que_comprou") || tags.includes("disse_que_pagou")) continue;
    if (!settingsCache.has(rec.store_id)) settingsCache.set(rec.store_id, await loadRecoverySettings(admin, rec.store_id));
    const base = settingsCache.get(rec.store_id);
    if (!base) continue;
    const sandbox = isOwnerSandbox(rec);
    if (!sandbox && !(base.enabled && base.whatsapp_enabled && base.agent_enabled)) continue;
    const settings = sandbox ? sandboxSettings(base, rec) : base;
    // A última mensagem do chat tem que ser do agente (não da equipe, não da régua).
    const { data: last } = await admin.from("whatsapp_messages").select("author, direction, session").eq("recovery_id", rec.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!last || last.direction !== "outbound" || last.author !== "agente") continue;
    if (!isAllowedNow(new Date(), rec.country_code, quietFor(settings, "whatsapp", rec, new Date()), rec.language)) continue;
    const { data: sup } = await admin.from("recovery_suppressions").select("id").in("channel", ["whatsapp", "all"]).eq("address", rec.phone).limit(1);
    if ((sup ?? []).length > 0) continue;
    // Doublecheck de compra antes da retomada: comprou = fecha sem mensagem;
    // inconclusivo = não manda agora (tenta no próximo tick).
    if (!sandbox) {
      const bought = await purchaseDoubleCheck(admin, rec);
      if (!bought.ok) {
        if (bought.terminal) await applyStop(admin, rec, bought);
        continue;
      }
    }

    // Trava anti-rajada da loja: retomada é mensagem automática, uma de cada vez.
    if ((await paceFreeAt(pace, rec.store_id, "whatsapp", settings.test_mode)) > Date.now()) continue;
    const claim = await admin
      .from("recovery_events")
      .insert({ recovery_id: rec.id, store_id: rec.store_id, step: null, channel: "whatsapp", type: "queued", dedupe_key: `wa-nudge:${rec.id}:${rec.last_inbound_at}`, provider: "waha", language: rec.language, is_test: settings.test_mode, detail: { author: "agente", nudge: true } })
      .select("id, created_at")
      .single();
    if (claim.error) {
      if (!isDuplicate(claim.error)) out.errors.push(`retomada ${rec.id}: ${claim.error.message}`);
      continue;
    }
    const claimId = claim.data.id as string;
    if (await paceConflict(admin, { claimId, claimAt: (claim.data.created_at as string | null) ?? null, storeId: rec.store_id, channel: "whatsapp", isTest: settings.test_mode })) {
      await releasePacedClaim(admin, claimId);
      continue;
    }
    try {
      const ctx = await buildAgentContext(admin, rec, settings);
      const decision = await decideAgentReply(ctx); // última mensagem é nossa: o input pede a retomada
      if (!decision.reply || (decision.action !== "reply" && decision.action !== "offer_discount")) {
        await admin.from("recovery_events").update({ type: "skipped", detail: { reason: "retomada_sem_texto", action: decision.action, notes: decision.notes, nudge: true } }).eq("id", claimId);
        out.skipped += 1;
        continue;
      }
      const r = await deliver(admin, { rec, settings, text: decision.reply, textPt: decision.reply_pt || null, author: "agente", language: decision.language, preferredSession: (last.session as string | null) ?? null, discountCode: decision.discount_code, claimEventId: claimId });
      markPace(pace, rec.store_id, "whatsapp", settings.test_mode);
      if (!r.sent) {
        await admin.from("recovery_events").update({ type: "skipped", detail: { reason: r.reason, nudge: true } }).eq("id", claimId);
        out.skipped += 1;
        continue;
      }
      if (decision.action === "offer_discount" && decision.discount_code) {
        await admin.from("cart_recoveries").update({ offered_discount_code: decision.discount_code, offered_discount_percent: decision.discount_percent, updated_at: new Date().toISOString() }).eq("id", rec.id);
      }
      await admin.from("recovery_events").update({ detail: { author: "agente", nudge: true, action: decision.action, notes: decision.notes } }).eq("id", claimId);
      out.sent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await admin.from("recovery_events").update({ type: "failed", detail: { error: msg.slice(0, 500), nudge: true } }).eq("id", claimId);
      out.errors.push(`retomada ${rec.id}: ${msg}`);
    }
  }
  return out;
}

// Sonda barata: o modelo aceita um pedido mínimo? Sem crédito (429) ou fora do
// ar, a fila de respostas atrasadas espera sem gastar consulta à Shopify nem
// gravar evento a cada minuto. Erro que não é de disponibilidade = deixa tentar.
export async function modelAvailable(): Promise<boolean> {
  try {
    await client.responses.create({ model: AGENT_MODEL, input: "ok", max_output_tokens: 16 });
    return true;
  } catch (err) {
    return !openAiUnavailable(err);
  }
}

// Conversas que ficaram sem resposta porque o modelo caiu (tag
// aguardando_modelo): quando ele volta, a resposta sai sozinha, uma por vez
// (trava anti-rajada do WhatsApp), pedindo desculpas pela demora. Mensagem
// dela com mais de 30 min só é respondida das 9h às 21h no fuso dela.
// Modelo ainda fora = para no primeiro e tenta no próximo tick.
export async function retryPendingReplies(admin: SupabaseClient, opts: { deadline: number; max?: number }): Promise<{ sent: number; waiting: number; cleared: number; errors: string[] }> {
  const out = { sent: 0, waiting: 0, cleared: 0, errors: [] as string[] };
  const { data, error } = await admin
    .from("cart_recoveries")
    .select("*")
    .contains("tags", ["aguardando_modelo"])
    .order("last_inbound_at", { ascending: true })
    .limit(20);
  if (error) {
    out.errors.push(`aguardando modelo: ${error.message}`);
    return out;
  }
  const pace = { admin, paceLast: new Map<string, number>() };
  const clear = async (rec: RecoveryRow) => {
    await admin.from("cart_recoveries").update({ tags: (rec.tags ?? []).filter((t) => t !== "aguardando_modelo"), updated_at: new Date().toISOString() }).eq("id", rec.id);
    out.cleared += 1;
  };
  let modelOk: boolean | null = null;
  for (const rec of (data ?? []) as RecoveryRow[]) {
    if (Date.now() > opts.deadline || out.sent >= (opts.max ?? 1)) break;
    // Com humano, pausada ou fechada: a equipe cuida; a marca sai.
    if (rec.agent_mode !== "agente" || rec.needs_human || rec.status !== "ativo") {
      await clear(rec);
      continue;
    }
    const base = await loadRecoverySettings(admin, rec.store_id);
    if (!base) continue;
    const sandbox = isOwnerSandbox(rec);
    if (!sandbox && !(base.enabled && base.whatsapp_enabled && base.agent_enabled)) continue;
    const settings = sandbox ? sandboxSettings(base, rec) : base;
    const { data: last } = await admin.from("whatsapp_messages").select("message_id, created_at").eq("recovery_id", rec.id).eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const inboundId = (last as { message_id?: string | null } | null)?.message_id ?? null;
    if (!inboundId) {
      await clear(rec);
      continue;
    }
    // Já respondida por esta fila (outra execução): a marca sai. A frase de "vou confirmar" que o
    // agente manda sem o modelo NÃO conta como resposta, a conversa continua na fila.
    const { data: done } = await admin.from("recovery_events").select("id").eq("recovery_id", rec.id).eq("type", "sent").eq("dedupe_key", `wa-retry:${inboundId}`).limit(1);
    if ((done ?? []).length > 0) {
      await clear(rec);
      continue;
    }
    const ageMin = (Date.now() - new Date((last as { created_at: string }).created_at).getTime()) / 60_000;
    if (ageMin > 30 && !isAllowedNow(new Date(), rec.country_code, quietFor(settings, "whatsapp", null, new Date()), rec.language)) continue;
    if ((await paceFreeAt(pace, rec.store_id, "whatsapp", settings.test_mode)) > Date.now()) {
      out.waiting += 1;
      continue;
    }
    // Nenhum número da loja no ar: a fila espera (sem tentar e sem chamar a equipe).
    if (!sandbox) {
      const { data: live } = await admin.from("whatsapp_sessions").select("name").eq("store_id", rec.store_id).eq("active", true).eq("status", "WORKING").limit(1);
      if ((live ?? []).length === 0) {
        out.waiting += 1;
        continue;
      }
    }
    // Modelo ainda fora: a fila inteira espera (uma sonda por execução).
    if (modelOk === null) modelOk = await modelAvailable();
    if (!modelOk) {
      out.waiting += 1;
      break;
    }
    try {
      const r = await handleInboundWhatsapp(admin, { recovery: rec, settings: base, messageId: inboundId, retry: true });
      if (r === "sent" || r === "busy") markPace(pace, rec.store_id, "whatsapp", settings.test_mode);
      if (r === "model_down") {
        out.waiting += 1;
        break;
      }
      if (r === "sent") out.sent += 1;
      else if (r === "skipped") {
        // Nada a responder (já respondida, com humano, fechada): a marca sai.
        const fresh = await loadRecovery(admin, rec.id);
        if (fresh && (fresh.tags ?? []).includes("aguardando_modelo")) await clear(fresh);
      } else out.waiting += 1;
    } catch (err) {
      out.errors.push(`aguardando modelo ${rec.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// Botão "Sugerir resposta" do painel: mesma decisão, sem enviar e sem gravar.
export async function generateAgentReplyPreview(admin: SupabaseClient, recoveryId: string): Promise<AgentResult> {
  const rec = await loadRecovery(admin, recoveryId);
  if (!rec) throw new Error("Carrinho não encontrado.");
  const settings = (await loadRecoverySettings(admin, rec.store_id)) ?? defaultRecoverySettings(rec.store_id);
  const ctx = await buildAgentContext(admin, rec, settings);
  return decideAgentReply(ctx);
}
