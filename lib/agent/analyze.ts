import type { SupabaseClient } from "@supabase/supabase-js";
import { decideAndDraftReply, type AgentDecision } from "@/lib/ai/openai-agent";
import { getToneProfile } from "@/lib/ai/tone";
import {
  getConversationTranscript,
  getCustomerHistory,
  getProductContext,
  getRelevantPlaybookRules,
  getShippingZoneContext,
  getStoreContexts,
  resolveDeliveryDaysMax,
  summarizeCustomerHistory,
  summarizeOrderFacts,
  summarizePlaybookRules,
  summarizeProductAndZoneContext,
  summarizeTranscript,
} from "@/lib/ai/context";
import { findOrdersForEmail, type ShopifyCredentials, type ShopifyOrderSummary } from "@/lib/shopify/orders";
import { resolveShopify } from "@/lib/shopify/token";
import { sendReply } from "@/lib/email/send-reply";
import { isPortuguese, looksUntranslated, translateReplyForCustomer, translateToPortuguese } from "@/lib/ai/translate-reply";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { hasHebrew, isIsraeliEmail, normalizeLanguage } from "@/lib/ai/lang";
import { stripQuotedReply } from "@/lib/email/quote";
import { stripDashes } from "@/lib/text/dashes";
import { alertRecipient, createAlert, findOpenAlert, resolveOpenAlerts, sendAlertEmail } from "@/lib/recovery/alerts";
import { computePhase, preliminaryPhase, phaseInstruction, type Phase } from "@/lib/agent/phase";
import { NOISE_SENDER, NOISE_SUBJECT, isShopifyNotice } from "@/lib/agent/noise";
import { getTrackingStatus, trackingArrived, trackingFacts } from "@/lib/tracking/track17";
import { loadCustomerFile, fileTranscript } from "@/lib/agent/customer-file";
import { triageEmail } from "@/lib/ai/triage";
import { selectContexts } from "@/lib/ai/context-meta";
import { computeDeadline } from "@/lib/agent/deadlines";
import { addUsage, trackUsage, type UsageTotals } from "@/lib/ai/usage";
import { formLink } from "@/lib/forms/token";
import type { ChargebackState } from "@/lib/agent/chargeback-types";
import { brandConflict, loadProducts, personaFor, routeProduct, type Product } from "@/lib/agent/products";
import { stripQuoteLines } from "@/lib/agent/dedupe";

export interface StoreRow {
  id: string;
  name: string;
  agent_name: string | null;
  delivery_days_max: number | null;
  auto_send_categories: string[] | null;
  signature: string | null;
  auto_ack?: boolean;
  default_language?: string | null;
}

interface SmtpAccount {
  smtp_host: string;
  smtp_port: number;
  email_address: string;
  credential_encrypted: string;
}

interface MessageRow {
  id: string;
  direction: string;
  from_address: string | null;
  subject: string | null;
  body: string | null;
  message_id: string | null;
  references_ids: string[] | null;
  sent_at: string | null;
  created_at: string;
}

// Norma da loja reforçada em código: rascunho com código/link de rastreio
// nunca sai sozinho. Pega tanto o código/link vazado quanto a IA só
// MENCIONANDO/oferecendo rastreio em palavras (a regra proíbe as duas coisas).
const TRACKING_MENTION = /\b(rastreio|rastreamento|código de rastr|link de rastr|tracking (code|number|link)|num[ée]ro de suivi|lien de suivi|suivi de colis|sendungsverfolgung|volgnummer|c[oó]digo de seguimiento|enlace de seguimiento)\b/i;
export function enforceNoTracking(decision: AgentDecision, orders: ShopifyOrderSummary[]) {
  // Israel: rastreio liberado (regra do Ian, 08/10/2026), só o link do 17track.
  if (orders.length > 0 && orders.every((o) => o.countryCode === "IL")) {
    const other = decision.draft_reply.match(/https?:\/\/\S+/g)?.filter((u) => !/t\.17track\.net/.test(u)) ?? [];
    if (other.some((u) => /track|suivi|colis/i.test(u))) {
      decision.needs_human = true;
      decision.human_reason = [decision.human_reason, "Rascunho com link de rastreio que não é o 17track, revisar."].filter(Boolean).join(" ");
    }
    return;
  }
  const codes = orders.map((o) => o.trackingNumber).filter((c): c is string => Boolean(c && c.length >= 6));
  const urls = orders.map((o) => o.trackingUrl).filter((u): u is string => Boolean(u));
  const text = decision.draft_reply;
  const leaked = codes.some((c) => text.includes(c)) || urls.some((u) => text.includes(u)) || /https?:\/\/\S*(track|suivi|colis|laposte|bpost|postnl|17track)/i.test(text);
  const mentioned = TRACKING_MENTION.test(text);
  if (leaked || mentioned) {
    decision.needs_human = true;
    decision.human_reason = [decision.human_reason, leaked ? "Rascunho continha código/link de rastreio (norma da loja) — revisar antes de enviar." : "Rascunho menciona rastreio, mesmo sem código (norma da loja é nunca oferecer) — revisar antes de enviar."].filter(Boolean).join(" ");
  }
}

function urgencyFor(d: AgentDecision): "baixa" | "normal" | "alta" | "urgente" {
  if (d.anger_level >= 5 || d.mentions_threat) return "urgente";
  if (d.anger_level >= 4 || d.wants_refund) return "alta";
  if (d.anger_level >= 3) return "normal";
  return "baixa";
}

type ShopCreds = ShopifyCredentials & { storeId: string; storeName: string };

// TODAS as Shopify conectadas (a da loja da conversa primeiro). A caixa de
// e-mail não define onde o cliente comprou: o pedido é procurado em todas.
export async function loadAllShopifyCreds(admin: SupabaseClient, preferredStoreId: string | null): Promise<ShopCreds[]> {
  const { data } = await admin.from("store_shopify_credentials").select("store_id, stores(name)").not("connected_at", "is", null);
  const rows = [...(data ?? [])].sort((a, b) => Number(b.store_id === preferredStoreId) - Number(a.store_id === preferredStoreId));
  const out: ShopCreds[] = [];
  for (const row of rows) {
    try {
      const r = await resolveShopify(admin, row.store_id as string);
      if (r) out.push({ shopDomain: r.shopDomain, accessToken: r.accessToken, storeId: row.store_id as string, storeName: (row.stores as unknown as { name: string } | null)?.name ?? r.shopDomain });
    } catch (err) {
      console.error("Shopify token:", err);
    }
  }
  return out;
}

// Busca pedidos em todas as Shopify e guarda um snapshot no cliente (CRM).
// Erro de Shopify não derruba a análise: vira um fato ("Shopify indisponível").
export async function fetchOrdersForCustomer(
  admin: SupabaseClient,
  creds: ShopCreds[] | ShopifyCredentials | null,
  customerId: string | null,
  email: string,
  text: string
): Promise<{ orders: ShopifyOrderSummary[]; error: string | null; foreignNumbers: string[] }> {
  const list: Array<ShopifyCredentials & Partial<ShopCreds>> = !creds ? [] : Array.isArray(creds) ? creds : [creds];
  if (list.length === 0) return { orders: [], error: null, foreignNumbers: [] };
  const orders: ShopifyOrderSummary[] = [];
  const errors: string[] = [];
  const foreign = new Set<string>();
  for (const c of list) {
    try {
      const found = await findOrdersForEmail(c, email, text);
      for (const n of found.foreignNumbers ?? []) foreign.add(n);
      for (const o of found) orders.push({ ...o, sourceStoreId: c.storeId, sourceShopName: c.storeName });
    } catch (err) {
      errors.push((err as Error).message.slice(0, 200));
    }
  }
  orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (customerId && (orders.length > 0 || errors.length === 0)) {
    await admin.from("customers").update({ shopify_orders: orders, shopify_synced_at: new Date().toISOString() }).eq("id", customerId);
  }
  // Número citado que é pedido do próprio cliente em OUTRA loja não é "de terceiro".
  const ownNames = new Set(orders.map((o) => o.name.replace("#", "")));
  return { orders, error: orders.length === 0 && errors.length === list.length ? errors[0] : null, foreignNumbers: [...foreign].filter((n) => !ownNames.has(n)) };
}

export interface AnalyzeResult {
  decision: AgentDecision;
  orders: ShopifyOrderSummary[];
  phase: Phase;
  // Vai pro campo analysis da conversa: dossiê do cliente mostrado no Inbox.
  file: {
    customer_summary_pt: string;
    customer_wants_pt: string;
    emails_summary_pt: Array<{ date: string; who: string; summary_pt: string }>;
    unanswered_count: number;
    waiting_days: number;
    first_contact_at: string | null;
    last_store_reply_at: string | null;
    customer_name: string | null;
    model: string;
    read: { shopify_stores: string[]; order: string | null; name_source: string | null; product: string | null; persona: string; deadline: string | null; messages_read: number; tracking: string | null };
    chargeback_open: boolean;
    foreign_order_numbers: string[];
    topics: string[];
    contexts_used: string[];
    missing_context_pt: string | null;
    ticket: boolean;
    ticket_reason: string | null;
  };
}

// Monta TODO o contexto real (pedido, histórico, transcrição, tom, regras)
// e pede a decisão + rascunho. Não grava nada — quem chama decide.
export interface ConversationRef {
  id: string;
  customer_id: string | null;
  subject: string | null;
  product_id?: string | null;
  language?: string | null;
}

// Produto/marca da conversa: o já gravado, senão roteia por alias, item do
// pedido, palavra-chave ou idioma (migration 0011; sem ela, null).
async function resolveProduct(
  admin: SupabaseClient,
  store: StoreRow,
  conversation: ConversationRef,
  texts: string[],
  language: string | null,
  shopifyProductIds: string[],
  orderTitles: string[],
  kind: "creme_cosmetico" | "capsulas_suplemento" | "outro" | "desconhecido" | null
): Promise<Product | null> {
  const products = await loadProducts(admin);
  if (!products.enabled) return null;
  const routed = routeProduct(products, { storeId: store.id, recipients: [], texts, language, shopifyProductIds, orderTitles, kind });
  // O produto gravado na conversa NÃO é confiável como evidência (pode ter
  // vindo de uma escolha antiga pela caixa/idioma). Vale só o que dá pra
  // provar agora: itens do pedido, tipo citado, palavras do cliente ou idioma
  // exclusivo de um produto. Sem isso, fica indefinido e a resposta sai neutra.
  const chosen = routed;
  if (!chosen && conversation.product_id) await admin.from("conversations").update({ product_id: null }).eq("id", conversation.id);
  if (chosen && chosen.id !== conversation.product_id) await admin.from("conversations").update({ product_id: chosen.id }).eq("id", conversation.id);
  return chosen;
}

export async function buildDecision(
  admin: SupabaseClient,
  store: StoreRow,
  conversation: ConversationRef,
  customerEmail: string,
  extraInstruction?: string | null
): Promise<AnalyzeResult> {
  const { data: msgs } = await admin
    .from("messages")
    .select("id, direction, from_address, subject, body, message_id, references_ids, sent_at, created_at")
    .eq("conversation_id", conversation.id);
  const messages = ((msgs ?? []) as MessageRow[]).sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at));
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound") ?? null;

  // Chargeback registrado na conversa (aviso da Shopify ou marcado à mão): a
  // loja escreve PRIMEIRO. Até 3 e-mails por cliente (1º, +1 dia, +3 dias),
  // sempre um só e-mail cobrindo todos os pedidos contestados dele.
  const { data: cbRow } = await admin.from("conversations").select("cb:analysis->chargeback").eq("id", conversation.id).maybeSingle();
  const cbRaw = (cbRow as { cb?: ChargebackState | null } | null)?.cb ?? null;
  const cb = cbRaw && !cbRaw.resolved_at && Array.isArray(cbRaw.orders) && cbRaw.orders.length > 0 ? cbRaw : null;
  const lastMessage = messages[messages.length - 1] ?? null;
  const proactive = Boolean(cb) && (!lastInbound || lastMessage?.direction !== "inbound");
  if (!lastInbound && !proactive) throw new Error("conversa sem mensagem do cliente");

  // Histórico COMPLETO do cliente: todas as conversas dele, em ordem, com as
  // respostas que a loja já deu. Cliente com 12 e-mails em 3 conversas é lido
  // inteiro — não só a thread atual.
  const file = await loadCustomerFile(admin, conversation.customer_id, customerEmail);
  const transcript = fileTranscript(file, proactive ? null : (lastInbound?.id ?? null));

  // Passo 1: LER o e-mail (nome, idioma, produto citado, temas, há quantos
  // dias comprou). Decide produto, contextos e fatos do passo 2.
  const latestText = proactive
    ? "(Não há mensagem nova do cliente. Este é um CONTATO PROATIVO da loja sobre a contestação bancária aberta — escreva o e-mail por iniciativa da loja, não como resposta.)"
    : `Assunto: ${lastInbound?.subject ?? conversation.subject ?? ""}\n\n${lastInbound?.body ?? ""}`;
  const triagePromise = proactive
    ? Promise.resolve(null)
    : triageEmail({ latest: latestText, latestDate: (lastInbound?.sent_at ?? lastInbound?.created_at ?? new Date().toISOString()).slice(0, 10), history: transcript, customerEmail });
  const shopifyCreds = await loadAllShopifyCreds(admin, store.id);
  const { orders, error: shopifyError, foreignNumbers } = await fetchOrdersForCustomer(
    admin,
    shopifyCreds,
    conversation.customer_id,
    customerEmail,
    [(cb?.orders ?? []).map((o) => o.name).join(" "), `${lastInbound?.subject ?? ""}\n${lastInbound?.body ?? ""}`, ...file.messages.filter((m) => m.direction === "inbound").map((m) => `${m.subject ?? ""}\n${m.body ?? ""}`)].join("\n").slice(0, 20000)
  );
  const mainOrder = orders[0] ?? null;

  const triage = await triagePromise;
  const triageLang = normalizeLanguage(triage?.language ?? null);
  const productIds = (mainOrder?.lineItems ?? []).map((li) => li.productId).filter((id): id is string => Boolean(id));
  // Texto só do CLIENTE (sem respostas da loja nem nome da loja Shopify): a
  // marca da caixa de e-mail não pode decidir o produto.
  let product = await resolveProduct(
    admin,
    store,
    conversation,
    [conversation.subject ?? "", ...messages.filter((m) => m.direction === "inbound").map((m) => `${m.subject ?? ""}\n${m.body ?? ""}`), triage?.product_hint ?? ""],
    triageLang ?? conversation.language ?? null,
    productIds,
    orders.flatMap((o) => o.lineItems.map((li) => li.title)),
    triage?.product_kind ?? null
  );

  // A mesma caixa recebe várias marcas. Hebraico em qualquer ponto do thread
  // (ou do histórico inteiro do cliente, em qualquer conversa), ou domínio de
  // e-mail israelense (cliente que escreve sem hebraico) = cliente da Olavita
  // (Israel): outra marca, outra assinatura, outro idioma.
  const storeIsOlavita = /olavita/i.test(store.name);
  const isOlavita =
    !storeIsOlavita &&
    (hasHebrew(conversation.subject) || messages.some((m) => hasHebrew(m.subject) || hasHebrew(m.body)) || file.messages.some((m) => hasHebrew(m.subject) || hasHebrew(m.body)) || isIsraeliEmail(customerEmail));
  // Regra do dono: cliente israelense/hebraico é SEMPRE Olavita. Se a palavra-
  // chave casou com um produto da OsteoPure, ele cai fora — senão a persona da
  // OsteoPure e a instrução da Olavita entram juntas, contraditórias, e o
  // rascunho sai assinado como OsteoPure.
  if (isOlavita && product && !/olavita/i.test(product.name)) {
    product = null;
    if (conversation.product_id) await admin.from("conversations").update({ product_id: null }).eq("id", conversation.id);
  }
  const [products, zone, storeContexts, tone, history, playbook, customerRow, tracking] = await Promise.all([
    getProductContext(admin, store.id, productIds),
    getShippingZoneContext(admin, store.id, mainOrder?.countryCode ?? null),
    getStoreContexts(admin, store.id, product?.id ?? null, product?.name ?? null),
    getToneProfile(admin, store.id),
    getCustomerHistory(admin, store.id, conversation.customer_id, conversation.id),
    getRelevantPlaybookRules(admin, store.id, null),
    conversation.customer_id ? admin.from("customers").select("name").eq("id", conversation.customer_id).maybeSingle() : Promise.resolve({ data: null }),
    // Situação real do pacote (17TRACK), só do pedido principal já enviado.
    mainOrder?.trackingNumber && !mainOrder.cancelledAt ? getTrackingStatus(admin, mainOrder.trackingNumber).catch(() => null) : Promise.resolve(null),
  ]);
  // Pacote já com o cliente: pelo que ele disse OU pelo rastreio real.
  const arrived = Boolean(triage?.says_received) || trackingArrived(tracking);

  // Fatos do cliente calculados em código: nome, fase, quanto tempo está
  // esperando resposta e quantas vezes escreveu sem resposta.
  const inboundAll = file.messages.filter((m) => m.direction === "inbound");
  const unanswered = file.unanswered;
  const waitingDays = file.waitingDays;
  const storeReplies = file.messages.filter((m) => m.direction !== "inbound").length;
  // Resposta curtinha citando um e-mail "nosso" (support@osteopure.fr /
  // support@dermamagazin.com) que NÃO está no nosso histórico — geralmente
  // e-mail de marketing/automação (Klaviyo) que não passa pelo Respondo. Sem
  // saber o que foi perguntado/oferecido ali, a IA não pode adivinhar do que
  // se trata (ex.: cliente respondeu "Depois dos feriados" a algo que nunca vimos).
  const realNewText = !proactive ? stripQuoteLines(lastInbound?.body ?? "").trim() : "";
  const looksLikeReplyToUntrackedEmail =
    !proactive && storeReplies === 0 && realNewText.length > 0 && realNewText.length <= 40 && /support@(osteopure\.fr|dermamagazin\.com)/i.test(lastInbound?.body ?? "");
  // Pedido de reembolso é sempre em 3 etapas (REGRA DO IAN): 1) pergunta o
  // motivo, 2) oferece retenção (desconto especial, chance única), só depois
  // 3) confirma o reembolso. Aproximação por nº de respostas já dadas a este
  // cliente (mesmo padrão de "insistsOnCancel" já usado pro formulário) — o
  // texto de cada etapa também manda a IA conferir o histórico antes de avançar.
  const refundStep = storeReplies === 0 ? 1 : storeReplies === 1 ? 2 : 3;
  const shopifyFirst = orders.find((o) => o.customerFirstName)?.customerFirstName ?? null;
  const fromFirst = ((customerRow as { data: { name: string | null } | null }).data?.name ?? "").split(/\s+/)[0] || null;
  const customerName = shopifyFirst ?? fromFirst ?? (triage?.customer_name?.trim().split(/\s+/)[0] || null);
  const prePhase = preliminaryPhase({
    firstInboundAt: file.firstContactAt,
    inboundCount: inboundAll.length,
    orderCreatedAt: mainOrder?.createdAt ?? null,
    fulfilledAt: mainOrder?.fulfilledAt ?? null,
    bodies: [conversation.subject ?? "", ...file.messages.map((m) => m.body ?? "")],
  });
  // Caso grave: fase de risco/assinatura, muitos e-mails ignorados ou muita
  // espera. Pede modelo mais forte e resposta longa e completa.
  const grave = prePhase >= 3 || unanswered.length >= 3 || waitingDays >= 7 || Boolean(triage?.threat) || (triage?.anger ?? 0) >= 4;
  // O que já foi prometido a este cliente em e-mails enviados (cancelar
  // assinatura, reembolsar) entra no contexto dele: a IA não promete de novo
  // como se fosse novidade e sabe o que já está em andamento.
  let promisedLine = "";
  if (file.conversationIds.length > 0) {
    const { data: withTodos } = await admin.from("conversations").select("t:analysis->todos").in("id", file.conversationIds.slice(0, 100)).not("analysis->todos", "is", null);
    const all = ((withTodos ?? []) as unknown as Array<{ t: Array<{ type: string; text: string; created_at: string; done: boolean }> | null }>).flatMap((r) => r.t ?? []).filter((t) => ["cancelar_assinatura", "regularizacao_financeira", "corrigir_endereco"].includes(t.type));
    if (all.length > 0) {
      promisedLine = `JÁ PROMETIDO a este cliente em e-mails anteriores: ${all.map((t) => `${t.text} (em ${new Date(t.created_at).toLocaleDateString("pt-BR")}${t.done ? ", JÁ EXECUTADO" : ", ainda em andamento"})`).join("; ")}. Não prometa de novo como novidade; confirme o andamento.`;
    }
  }
  // Formulário de solicitação: o que o cliente já preencheu e, quando a regra
  // do contexto manda, o link PESSOAL dele pra colar no e-mail.
  let formLine = "";
  {
    const forms = await admin.from("return_requests").select("reference, resolution, status, created_at").ilike("customer_email", customerEmail).order("created_at", { ascending: false }).limit(3);
    const mine = forms.error ? [] : forms.data ?? [];
    const insistsOnCancel = Boolean(triage?.topics.includes("cancelamento")) && storeReplies > 0;
    if (mine.length > 0) {
      formLine = `O cliente JÁ preencheu o formulário de solicitação: ${mine.map((f) => `#${f.reference} em ${new Date(f.created_at as string).toLocaleDateString("pt-BR")} (quer ${f.resolution === "reenvio" ? "reenvio" : "dinheiro de volta"}, status ${f.status})`).join("; ")}. Não peça pra preencher de novo; diga que a solicitação está registrada e em análise pela equipe.`;
    } else if (((triage?.explicit_refund_request && refundStep >= 3) || insistsOnCancel) && mainOrder) {
      // Reembolso simples (etapas 1 e 2) não usa formulário — é só a
      // conversa em 3 etapas (motivo, retenção, confirmação por texto). O
      // formulário entra na etapa 3 (registro formal) ou quando o cliente
      // insiste em cancelar depois de já termos respondido.
      // Sem nenhum pedido real dele na Shopify, o formulário (que pede pra
      // escolher entre os próprios pedidos) não serve pra nada — segue o
      // fato de PEDIDO NÃO ENCONTRADO em vez de mandar pro formulário.
      const link = formLink({ e: customerEmail.toLowerCase(), p: product?.name.split(/\s+/)[0], l: triageLang ?? undefined, c: conversation.id });
      formLine = `FORMULÁRIO DE SOLICITAÇÃO — link pessoal deste cliente: ${link}\nUse-o quando a regra do contexto mandar (cliente pediu o dinheiro de volta com todas as letras, ou insiste em cancelar depois de já termos respondido): explique que, para registrar oficialmente o pedido dele e encaminhar ao time financeiro, precisamos que ele preencha esse formulário seguro (leva poucos minutos: confirmar pedido, endereço, o que aconteceu e assinar). Coloque o link sozinho numa linha, no corpo do e-mail, antes do fecho. Não altere o link.`;
    }
  }
  // Chargeback só é tratado como FATO com prova: registro na conversa (aviso
  // da Shopify) ou disputa aberta no pedido. O modelo de triagem às vezes lê
  // ameaça ("vou contestar") como contestação aberta, e aí a resposta dizia
  // "você fez chargeback" para quem não fez (08/10, Efrat e Anthony).
  const cbProven = Boolean(cb) || orders.some((o) => o.disputeOpen);
  const cbClaimed = !cbProven && Boolean(triage?.chargeback_open);
  const cbActive = cbProven;
  const cbStep = Math.min(cb?.step ?? 0, 2);
  const cbOrders = (cb?.orders ?? []).map((o) => {
    const days = o.opened_at ? Math.max(0, Math.floor((Date.now() - new Date(o.opened_at).getTime()) / 86400000)) : null;
    return `${o.name}${o.amount ? ` (${o.amount} ${o.currency ?? ""})` : ""}${o.opened_at ? ` — contestação aberta em ${new Date(o.opened_at).toLocaleDateString("pt-BR")}${days !== null && days >= 2 ? `, há ${days} dias` : ""}` : ""}`;
  });
  // Cliente que já escreveu antes e não teve resposta a tempo ganha uma
  // desculpa curta (nosso e-mail mudou); quem nunca escreveu (contato só por
  // causa do chargeback) vai direto ao ponto, sem se desculpar por nada.
  const cbHadPriorContact = storeReplies === 0 && inboundAll.length > 0 && !proactive;
  // Só a palavra assinatura na ÚLTIMA mensagem libera falar de assinatura:
  // reclamar de cobrança não é falar de assinatura (Ian, 08/10).
  const latestTalksSubscription = Boolean(triage?.topics_latest.includes("assinatura") || triage?.subscription_denied);
  const cbMentionsSubscription = latestTalksSubscription;
  const cbScript = [
    cbHadPriorContact
      ? "(a) cumprimente pelo primeiro nome com uma desculpa curta e direta: nosso e-mail de atendimento mudou e as mensagens dele estavam indo pra um endereço que a gente não conseguia mais receber;"
      : "(a) cumprimente pelo primeiro nome, direto ao ponto (sem pedir desculpa: ele não tinha escrito antes, este é um contato nosso);",
    "(b) diga sem rodeio: 'Você fez chargeback pra contestar direto com o seu banco' do(s) pedido(s) [número(s)] — e deixe claro que isso prejudica MUITO a nossa loja, não é um impacto pequeno;",
    "(c) afirme que temos as provas pra brigar junto ao banco: comprovante de entrega, o histórico de e-mail com ele, e que já entramos em disputa contra o chargeback;",
    cbMentionsSubscription ? "(d) já que ele fez a compra em formato de assinatura, diga isso com clareza: 'você fez uma assinatura, e a gente tem comprovante de todos os envios dela';" : "",
    "(e) apresente a solução como VANTAGEM PRA ELE, não como pedido: 'como o chargeback prejudica a nossa loja, a gente tem uma solução muito mais rápida e simples: se você cancelar esse chargeback direto com o seu banco e nos avisar, a gente faz o reembolso de todos os pedidos manualmente e consegue te reembolsar ainda hoje' — deixe claro que cancelar é o caminho MAIS RÁPIDO pra ele receber o dinheiro (mais rápido que esperar o banco decidir, que pode levar até 90 dias);",
    "(f) feche com confiança, sem se desculpar demais: somos uma equipe honesta e séria, e resolvemos isso rápido assim que ele cancelar e avisar. Peça que responda este e-mail assim que cancelar, ou contando o que aconteceu.",
  ].filter(Boolean).join(" ");
  const cbStepText = [
    `1º E-MAIL da sequência: siga o roteiro completo, direto e sem rodeio: ${cbScript}`,
    `2º E-MAIL (um dia depois do primeiro, o cliente ainda não respondeu): curto e direto. Diga que escreveu ontem sobre o chargeback e quer confirmar que ele viu; repita em 2–3 frases, sem suavizar, que o chargeback prejudica a loja, que temos as provas e a vantagem dele em cancelar (reembolso manual ainda no mesmo dia). NÃO repita o e-mail anterior inteiro.`,
    `3º E ÚLTIMO E-MAIL (três dias depois do primeiro, sem resposta): direto, sem ameaça mas sem meias palavras — esta é a última tentativa de resolver rápido; sem retorno, seguimos apresentando as provas ao banco (comprovante de entrega, e-mails, disputa já aberta), processo que pode levar até 90 dias. Reafirme a vantagem de cancelar agora (reembolso manual no mesmo dia). Deixe a porta aberta.`,
  ][cbStep];
  const chargebackFact = cb
    ? `CONTESTAÇÃO BANCÁRIA (CHARGEBACK) ABERTA — É O ASSUNTO PRINCIPAL e vem PRIMEIRO. Pedido(s) contestado(s): ${cbOrders.join("; ")}.${cbOrders.length > 1 ? ` São ${cbOrders.length} contestações do MESMO cliente: escreva UM único e-mail cobrindo todas, com mais peso emocional (o impacto de ${cbOrders.length} contestações numa equipe pequena).` : ""} ${proactive ? "O cliente NÃO escreveu: é um contato por iniciativa da loja. " : "O cliente escreveu: responda o que ele disse DEPOIS de tratar a contestação. "}${cbStepText} A proposta (cancelar a contestação no banco → regularização financeira em até 24 horas, normalmente ~1 hora após a confirmação) é OBRIGATÓRIA neste e-mail, com essas palavras claras, mesmo que o pedido ainda esteja a caminho. NÃO fale de devolver pacote, recusar entrega, formulário nem protocolo de devolução. Só fale de assinatura se o próprio cliente tiver falado dela.`
    : `CONTESTAÇÃO BANCÁRIA ABERTA${triage?.chargeback_date_iso ? ` em ${triage.chargeback_date_iso.split("-").reverse().join("/")}` : ""} (aparece na Shopify). É O ASSUNTO PRINCIPAL e vem PRIMEIRO, logo após a saudação: ${cbScript} SÓ DEPOIS, e só se a ÚLTIMA mensagem do cliente fala de assinatura com essa palavra: explique que ele selecionou o tratamento contínuo na compra (por isso o desconto), que temos o registro, como funciona, e que a assinatura já está cancelada. NÃO fale de devolver pacote, recusar entrega nem formulário.`;
  const customerFacts = [
    promisedLine,
    formLine,
    looksLikeReplyToUntrackedEmail
      ? `ATENÇÃO — SEM CONTEXTO NENHUM: este e-mail é uma resposta curta ("${realNewText}") a uma mensagem 'nossa' que NÃO está no nosso histórico de conversas — provavelmente um e-mail de marketing/automação enviado por outro sistema (não pelo Respondo). NÃO SABEMOS do que se tratava aquela mensagem: PROIBIDO mencionar feriados, prazos de entrega, pedidos, cobranças, promoções ou qualquer outro assunto específico — você estaria inventando. A resposta tem que ser SÓ isto, adaptado ao nome/idioma do cliente, SEM adicionar mais nada: agradecer o retorno, dizer que a equipe vai conferir o assunto exato dessa mensagem e volta a falar com ele em breve.`
      : "",
    customerName ? `Nome do cliente: ${customerName} — cumprimente pelo primeiro nome logo na saudação.` : "Nome do cliente desconhecido: use uma saudação calorosa sem inventar nome.",
    phaseInstruction(triage?.threat && prePhase < 3 ? 3 : prePhase),
    triage?.threat ? "O cliente fez uma ameaça (advogado, banco, denúncia). Não ignore nem rebata: acolha, mostre que o caso foi assumido pessoalmente agora, resolva o que ele cobra com fatos e prazos, e siga a regra de contestação do contexto se houver." : "",
    `Primeiro contato do cliente: ${file.firstContactAt ? new Date(file.firstContactAt).toLocaleDateString("pt-BR") : "desconhecido"}. E-mails do cliente ao todo: ${inboundAll.length}. Respostas que a loja já deu: ${storeReplies}${file.lastStoreReplyAt ? ` (última em ${new Date(file.lastStoreReplyAt).toLocaleDateString("pt-BR")})` : " — NENHUMA até hoje"}.`,
    foreignNumbers.length > 0
      ? `ATENÇÃO — PRIVACIDADE: o cliente citou o(s) número(s) ${foreignNumbers.map((n) => `#${n}`).join(", ")}, mas esse(s) pedido(s) NÃO é(são) dele (pertence(m) a outra pessoa; ele provavelmente errou o número). É PROIBIDO dar qualquer informação desse(s) pedido(s). ${orders.length > 0 ? `Responda sobre o pedido REAL dele (${orders.map((o) => o.name).join(", ")}, encontrado pelo e-mail) e diga com gentileza que o número correto do pedido dele é esse.` : "Não confirme nada sobre esse número; responda pelos prazos gerais e peça com gentileza que ele confira o número na confirmação de compra."}`
      : "",
    cbActive ? chargebackFact : "",
    cbClaimed
      ? "O cliente fala em contestação no banco, mas NÃO há contestação registrada na Shopify (pode ser só ameaça). PROIBIDO afirmar que ele fez chargeback, falar de provas, disputa ou que isso prejudica a loja. Acolha, resolva o que ele cobra, e diga com calma que resolvemos muito mais rápido direto com a gente do que pelo banco."
      : "",
    triage && !latestTalksSubscription
      ? "A ÚLTIMA mensagem do cliente NÃO fala de assinatura nem de cobrança recorrente (mesmo que ele tenha tocado nisso em mensagens antigas, já tratadas antes): PROIBIDO citar assinatura, tratamento contínuo, Cure Continue, renovação ou cancelamento de assinatura nesta resposta. Responda só o que ele perguntou agora."
      : "",
    triage?.subscription_denied
      ? "ASSUNTO CENTRAL — o cliente nega ter assinado, diz que não quer assinatura, OU diz que recebeu um e-mail/aviso de que vai virar assinatura/ser cobrado de novo (sem ter mandado prova). Essa é a PERGUNTA QUE A RESPOSTA TEM QUE RESOLVER — não desvie pra rastreio, status de envio, prazo de entrega ou qualquer outro assunto do pedido só porque tem essa informação disponível. NÃO confirme nem explique a assinatura como se fosse verdade só porque ele disse isso: peça com gentileza que ele confirme onde exatamente viu essa informação (encaminhar o e-mail, mandar um print, ou dizer o remetente e o assunto) antes de tratar como se existisse uma assinatura real. Se ele já mandou prova concreta (print, e-mail encaminhado), aí sim trate como real e siga a regra ASSINATURA do contexto."
      : "",
    triage?.question_pt ? `O que a resposta TEM que resolver: ${triage.question_pt}` : "",
    triage && !cbActive
      ? triage.explicit_refund_request
        ? !mainOrder
          ? "" // sem nenhum pedido encontrado: segue o fato de PEDIDO NÃO ENCONTRADO abaixo — não promete reembolso de uma cobrança que não achamos
          : refundStep === 1
            ? "REEMBOLSO — ETAPA 1 de 3 (motivo): é a primeira vez que este cliente pede o dinheiro de volta. PROIBIDO prometer reembolso ou oferecer retenção nesta resposta. Só pergunte, com gentileza e sem parecer que está negando, o motivo e o que aconteceu — pra entender a situação antes do próximo passo."
            : refundStep === 2
              ? "REEMBOLSO — ETAPA 2 de 3 (retenção): confira no histórico se você JÁ perguntou o motivo numa resposta anterior — se ainda não perguntou, volte pra ETAPA 1 (só pergunte o motivo). Se já perguntou: NÃO prometa reembolso nesta resposta. Em vez disso, ofereça retenção: pergunte se ele tem certeza que não quer continuar com o produto, e lembre que ele conseguiu um desconto especial que não vai conseguir de novo em outra oportunidade — é uma chance única."
              : "REEMBOLSO — ETAPA 3 de 3 (confirmar): confira no histórico se você JÁ ofereceu a retenção (desconto especial, chance única) numa resposta anterior e o cliente insistiu mesmo assim — se ainda não ofereceu, volte pra ETAPA 2. Se já ofereceu e ele insiste: agora sim confirme, com segurança: diga que a solicitação JÁ foi enviada ao setor financeiro e que o valor deve aparecer na fatura/extrato do cartão dele em até 10 dias úteis; peça que ele confirme quando aparecer. NÃO diga 'vamos avaliar' — trate como já decidido."
        : mainOrder && triage?.purchase_not_completed
          ? `O cliente diz que NÃO comprou / não reconhece esse pedido, ou pediu pra cancelar — mas EXISTE sim um pedido real em nome dele: ${mainOrder.name}${mainOrder.fulfilledAt ? ", JÁ ENVIADO" : ", ainda não enviado"}. NÃO ignore o que ele disse e NÃO só recite os dados do pedido como se ele tivesse perguntado o status. Primeiro pergunte com gentileza o que aconteceu (ele quer confirmar se foi mesmo ele quem comprou, ou já sabe e quer cancelar mesmo assim?). Depois explique o caminho certo: ${mainOrder.fulfilledAt ? "como o pedido já foi enviado, não dá mais pra interromper à distância — mas se ele recusar o pacote na entrega (não retirar/não aceitar), ele volta pra nós automaticamente e aí sim processamos o cancelamento" : "como ainda não foi enviado, dá pra tentar cancelar antes do envio — diga que vai encaminhar o pedido de cancelamento pra equipe agora"}. needs_human = true — só um humano decide e executa o cancelamento de verdade.`
          : mainOrder
            ? "O cliente NÃO pediu dinheiro de volta. PROIBIDO mencionar reembolso, regularização financeira, devolução, recusa de pacote ou cancelamento do pedido. Mantenha o pedido: tranquilize com certeza (está a caminho e vai chegar, dentro do prazo em dias úteis). NÃO levante a hipótese de o pacote não chegar: a frase 'se não chegar, enviamos outro' só é permitida se o próprio cliente escreveu que tem medo de não receber, que o pacote se perdeu ou que o prazo já passou."
            : ""
      : "",
    `Hoje é ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
    triage?.payment_failed
      ? "QUER COMPRAR E NÃO CONSEGUIU PAGAR: o cliente quer comprar, não desistiu. PROIBIDO responder como se ele tivesse desistido ou dizer que 'não houve compra, assunto encerrado'. Pergunte com carinho o que aconteceu (mensagem de erro? qual forma de pagamento tentou?), diga que falou com o gerente e conseguiu um desconto adicional, peça para tentar de novo e lembre que também dá para pagar com PayPal por link personalizado (siga a regra do contexto)."
      : !mainOrder && triage?.purchase_not_completed
      ? "SEM PEDIDO — o cliente disse que NÃO comprou / não fez pedido / não quer fazer pedido (negou, não só 'desisti no meio'): conferido agora na Shopify, não existe mesmo nenhum pedido nem cobrança em nome dele em nenhuma das nossas lojas. Ele está CERTO. Responda curto, caloroso e definitivo: diga que ele tem razão, que não houve nenhuma compra da parte dele, e que isso foi uma confusão da nossa parte (peça desculpas por isso) — encerre o assunto. PROIBIDO insistir, pedir prova, comprovante, últimos 4 dígitos do cartão, print do extrato, ou levantar 'se realmente houve cobrança'; PROIBIDO pedir pra ele explicar de novo o que aconteceu na tela de pagamento; PROIBIDO oferecer ajuda pra concluir uma compra que ele não quer. Só ofereça ajuda pra comprar se ele mesmo perguntar como fazer isso."
      : !mainOrder && !triage?.purchase_date_iso && triage?.stated_days_since_purchase != null
        ? `O cliente afirma que comprou/espera há ${triage.stated_days_since_purchase} dias (compra por volta de ${new Date(Date.now() - triage.stated_days_since_purchase * 86400000).toLocaleDateString("pt-BR")}). Use os prazos do contexto (preparação + entrega) pra dizer com segurança em que etapa o pedido está AGORA e a janela de datas em que ele chega — resposta que resolve, não que pede dados.`
        : !mainOrder
          ? "NENHUM PEDIDO ENCONTRADO — conferido agora na Shopify: não existe nenhum pedido pago com o e-mail deste cliente em nenhuma das nossas lojas conectadas. PROIBIDO inventar ou afirmar que existe um pedido: não diga que está confirmado, pago, em preparação, a caminho, e não cite nenhum número, valor, data ou item de pedido. Se ele citar uma cobrança/valor que viu SEM negar ter comprado, diga com clareza que não localizamos nenhum pedido pago com esse e-mail, peça gentilmente que confira se usou outro e-mail no checkout, e peça um print ou comprovante da cobrança pra investigarmos — sem prometer estorno nem confirmar que a cobrança é nossa até isso ser checado."
          : "",
    storeReplies > 0 ? "A loja JÁ respondeu a este cliente antes (veja 'Loja' no histórico). Leia o que foi dito e prometido, com as datas: nunca repita o mesmo prazo ou a mesma explicação já dada. Se um prazo prometido já passou, reconheça isso de forma positiva e avance pra explicação/solução da fase seguinte." : "",
    unanswered.length > 1 ? `O cliente escreveu ${unanswered.length} vezes sem receber resposta. Responda a TUDO numa única mensagem: cada cobrança, cada pergunta e cada pedido que ele fez nesses e-mails.` : "",
    waitingDays >= 2
      ? `O cliente está há ${waitingDays} dias esperando resposta. NÃO escreva 'tomei conhecimento da sua mensagem' como se fosse o primeiro dia. Abra pedindo imensas desculpas pela falta de retorno (use a justificativa definida no contexto da loja para demora, se houver), diga que a equipe acabou de analisar o caso completo dele, e só então explique a situação inteira.`
      : "",
    grave
      ? "CASO GRAVE. Resposta LONGA e humana, em parágrafos de texto corrido (regra TAMANHO do Ian, 15/10), cada informação uma vez só: 1) saudação pelo nome e tranquilizar JÁ no começo com a solução que o contexto da loja define pra esse caso (não deixe o cliente lendo três parágrafos sem saber se vai ser resolvido); 2) dizer que ele está falando com uma pessoa de verdade que cuida do caso pessoalmente; 3) explicar o que aconteceu com base no histórico e no contexto (ex.: como funciona a assinatura que ele escolheu na compra, cobranças, envios, o que os correios fizeram), sem tom defensivo; 4) o que já foi feito e o próximo passo concreto; 5) fecho humano: equipe que se importa, cuidando do pedido pessoalmente, quer que ele tenha uma experiência boa. NUNCA peça número de pedido ou e-mail de compra a um cliente que já escreveu várias vezes; se faltar o dado, diga que a equipe está localizando pelo nome e e-mail dele."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const deliveryDaysMax = resolveDeliveryDaysMax(store.delivery_days_max, zone);

  // Passo intermediário: quais contextos entram. Base/idioma/loja/prazo/produto
  // sempre; objeções e políticas pelo tema, fase, palavras e idioma do e-mail.
  const picked = selectContexts(storeContexts, {
    topics: triage?.topics ?? [],
    phase: prePhase,
    language: triageLang ?? conversation.language ?? null,
    text: `${latestText}\n${transcript}`,
  });
  const contextText = picked.selected.map((c) => `• [${c.tipo}] ${c.label}: ${c.body}`).join("\n");

  // Prazo em dias úteis calculado em código a partir do bloco tipo prazo do
  // produto (preparo_dias_uteis / entrega_dias_uteis) e da data da compra:
  // a da Shopify, ou a que o cliente informou.
  const prazoBlock = picked.selected.find((c) => c.meta.preparo_dias_uteis && c.meta.entrega_dias_uteis);
  const statedDays = triage?.stated_days_since_purchase ?? null;
  const statedDate = triage?.purchase_date_iso && /^\d{4}-\d{2}-\d{2}$/.test(triage.purchase_date_iso) && !Number.isNaN(Date.parse(triage.purchase_date_iso)) ? `${triage.purchase_date_iso}T12:00:00Z` : null;
  const purchasedAt = mainOrder?.createdAt ?? statedDate ?? (statedDays != null ? new Date(Date.now() - statedDays * 86400000).toISOString() : null);
  const deadline =
    prazoBlock && purchasedAt && !mainOrder?.cancelledAt
      ? computeDeadline({
          purchasedAt,
          purchaseIsEstimate: !mainOrder,
          shippedAt: mainOrder?.fulfilledAt ?? null,
          rule: { prepDays: prazoBlock.meta.preparo_dias_uteis!, minDays: prazoBlock.meta.entrega_dias_uteis![0], maxDays: prazoBlock.meta.entrega_dias_uteis![1] },
        })
      : null;

  // isOlavita é decidido logo depois do produto (acima): a marca Olavita ganha
  // de qualquer produto casado por palavra-chave.
  const brandInstruction = isOlavita
    ? "ATENÇÃO — ESTA CONVERSA É DA MARCA OLAVITA (cliente de Israel), não da OsteoPure. Responda no idioma da última mensagem do cliente (hebraico ou inglês), assine como 'צוות התמיכה של Olavita' (em inglês: 'Olavita Support Team'), NUNCA mencione OsteoPure nem Monique. Regras de produto/preço da OsteoPure não valem aqui; se faltar informação da Olavita, peça o número do pedido e marque needs_human = true."
    : "";

  // Persona pelo idioma do cliente: a Monique é francesa; em Israel, na
  // Alemanha ou na Hungria assina outra pessoa, com fecho natural do idioma.
  const COUNTRY_LANG: Record<string, string> = { FR: "fr", CA: "fr", CH: "fr", BE: "fr", LU: "fr", TR: "tr", IL: "he", DE: "de", AT: "de", DK: "da", HU: "hu", ES: "es", IT: "it", NL: "nl", GB: "en", US: "en" };
  const proactiveLang = proactive ? (normalizeLanguage(conversation.language ?? null) ?? COUNTRY_LANG[mainOrder?.countryCode ?? ""] ?? null) : null;
  const langGuess = proactiveLang ?? triageLang ?? conversation.language ?? (isOlavita || messages.some((m) => hasHebrew(m.body)) ? "he" : null);
  const brand = product?.name ?? (isOlavita ? "Olavita" : store.name);
  const persona = personaFor(product, brand, langGuess);
  // Sem NENHUMA evidência do que ele comprou: não chutar a marca pela caixa de
  // e-mail. Resposta neutra (sem nome de marca/produto) e conferência humana.
  const productUnknown = !product && (await loadProducts(admin)).items.length > 1;
  const unknownInstruction = productUnknown
    ? "PRODUTO NÃO IDENTIFICADO: não dá pra saber qual produto da operação este cliente comprou. NÃO cite nome de marca, de loja nem de produto (nem OsteoPure, nem Olavita, nem moringa, nem creme). Assine só com o primeiro nome da persona e 'Equipe de Suporte' no idioma do cliente. Responda com os prazos gerais e pergunte com gentileza qual produto ele comprou e o número do pedido."
    : "";
  const personaInstruction = product
    ? `Você responde pela marca/produto ${product.name}. Assine como ${persona.name}, ${persona.role}, com o fecho '${persona.closing}' — sempre no idioma do cliente; se ele escrever em outro idioma, use nome e fecho naturais desse idioma (nunca 'Monique' fora do francês). Concordância de gênero coerente com quem assina (${persona.name}) em todo o texto — em hebraico, por exemplo, verbos na forma da pessoa que assina.`
    : "";

  const decision = await decideAndDraftReply({
    storeName: brand,
    storeInstructions: [
      productUnknown ? "" : brandInstruction,
      personaInstruction,
      unknownInstruction,
      store.agent_name && !isOlavita && !product ? `Quem assina: ${store.agent_name}.` : "",
      contextText,
    ]
      .filter(Boolean)
      .join("\n"),
    toneSummary: tone?.styleSummary ?? null,
    toneExamples: tone?.examples ?? [],
    signature: productUnknown ? `${persona.closing},\n${persona.name}` : product ? `${persona.closing},\n${persona.name}\n${persona.role}` : isOlavita ? null : (store.signature ?? tone?.signature ?? null),
    conversationTranscript: transcript,
    customerHistorySummary: summarizeCustomerHistory(history),
    // Cliente que diz que o pacote já chegou: o prazo calculado ("a caminho",
    // "X dias úteis desde o envio") sai dos fatos, senão o modelo responde
    // "vai chegar" para quem já está com o produto na mão.
    orderFacts: [
      summarizeOrderFacts(orders, deliveryDaysMax, shopifyCreds.length > 0, shopifyError),
      tracking ? trackingFacts(tracking) : "",
      arrived
        ? `O PEDIDO JÁ CHEGOU${triage?.says_received ? " (o cliente disse que recebeu)" : " (o rastreio real mostra entregue ou no ponto de retirada)"}. NÃO fale de prazo de entrega, dias úteis, 'a caminho' nem 'vai chegar', e NÃO diga que vai cobrar os correios pela demora. Responda só o que ele perguntou ou reclamou.`
        : deadline
          ? `PRAZO CALCULADO EM DIAS ÚTEIS (fonte: bloco "${prazoBlock!.label}"):\n${deadline.text}`
          : "",
    ].filter(Boolean).join("\n\n"),
    productAndZoneNotes: summarizeProductAndZoneContext(products, zone),
    playbookNotes: summarizePlaybookRules(playbook),
    latestCustomerMessage: latestText,
    customerFacts,
    extraInstruction,
    // Modelo forte só onde a resposta decide uma contestação: ameaça, cliente
    // furioso ou 4+ e-mails ignorados. Espera longa sozinha vai no modelo
    // padrão com a estrutura de caso grave (8x mais barato).
    hard: Boolean(triage?.threat) || cbActive || (triage?.anger ?? 0) >= 4 || unanswered.length >= 4,
  });

  await ensurePortugueseTranslations(decision);

  const phase = computePhase({
    decision,
    firstInboundAt: file.firstContactAt,
    lastInboundAt: lastInbound?.sent_at ?? lastInbound?.created_at ?? null,
    inboundCount: inboundAll.length,
    orderCreatedAt: mainOrder?.createdAt ?? null,
    fulfilledAt: mainOrder?.fulfilledAt ?? null,
    bodies: [conversation.subject ?? "", ...file.messages.map((m) => m.body ?? "")],
  });

  // Nome achado pelo modelo (assinatura do cliente, e-mail) fica gravado.
  const foundName = customerName ?? (decision.customer_name?.trim() || null);
  if (!customerName && foundName && conversation.customer_id) {
    await admin.from("customers").update({ name: foundName }).eq("id", conversation.customer_id).is("name", null);
  }

  if (productUnknown) {
    decision.needs_human = true;
    decision.human_reason = ["PRODUTO NÃO IDENTIFICADO: confirme se é OsteoPure ou Olavita antes de enviar.", decision.human_reason].filter(Boolean).join(" ");
  }
  // Trava de marca: rascunho que cita a marca de outro produto nunca passa calado.
  const mix = product ? brandConflict(await loadProducts(admin), product.id, decision.draft_reply) : null;
  if (mix) {
    decision.needs_human = true;
    decision.human_reason = [`MISTURA DE MARCA — NÃO ENVIAR: ${mix}.`, decision.human_reason].filter(Boolean).join(" ");
  }

  // Ticket = o que o Ian precisa ver pessoalmente. Inbox é todo o correio.
  const ticketReasons = [
    cbActive ? `CHARGEBACK ABERTO${cb ? ` (${cb.orders.length} pedido(s), e-mail ${cbStep + 1} de 3)` : ""}` : decision.mentions_threat ? "ameaça / contestação" : "",
    decision.anger_level >= 5 ? "cliente no limite (raiva 5)" : "",
    mix ? "MISTURA DE MARCA no rascunho" : "",
    productUnknown ? "produto não identificado (conferir a marca)" : "",
    decision.missing_context_pt ? "a IA não tinha contexto pra responder" : "",
    looksLikeReplyToUntrackedEmail ? "resposta a e-mail nosso que não está no histórico (provável marketing) — confira do que se trata antes de responder" : "",
    !cbActive && triage?.explicit_refund_request && mainOrder && refundStep >= 3 ? "REEMBOLSO CONFIRMADO nesta resposta (etapa 3) — conferir execução real e o prazo de 10 dias" : "",
    !cbActive && triage?.topics.includes("assinatura") ? "assinatura mencionada — conferir/confirmar o cancelamento" : "",
    triage?.subscription_denied ? "cliente nega assinatura / diz que recebeu e-mail de assinatura — confirmar origem" : "",
  ].filter(Boolean);

  return {
    decision,
    orders,
    phase,
    file: {
      customer_summary_pt: decision.customer_summary_pt,
      customer_wants_pt: decision.customer_wants_pt,
      emails_summary_pt: decision.emails_summary_pt,
      unanswered_count: unanswered.length,
      waiting_days: waitingDays,
      first_contact_at: file.firstContactAt,
      last_store_reply_at: file.lastStoreReplyAt,
      customer_name: foundName,
      model: decision.model_used,
      read: {
        shopify_stores: shopifyCreds.map((c) => c.storeName),
        order: mainOrder ? `${mainOrder.name} · ${new Date(mainOrder.createdAt).toLocaleDateString("pt-BR")}${mainOrder.sourceShopName ? ` · ${mainOrder.sourceShopName}` : ""}` : null,
        name_source: shopifyFirst ? "Shopify" : fromFirst ? "remetente do e-mail" : foundName ? "lido no e-mail" : null,
        product: product?.name ?? null,
        persona: persona.name,
        deadline: deadline ? `${mainOrder?.fulfilledAt ? `enviado em ${new Date(mainOrder.fulfilledAt).toLocaleDateString("pt-BR")}` : `envio até ${deadline.shipBy}`}; chegada ${deadline.windowStart} → ${deadline.windowEnd} (${deadline.stage.replace(/_/g, " ")})` : null,
        messages_read: file.messages.length,
        tracking: tracking ? `${tracking.status}${tracking.latestEventText ? ` · ${tracking.latestEventText}` : ""}${tracking.latestEventAt ? ` · ${new Date(tracking.latestEventAt).toLocaleDateString("pt-BR")}` : ""}` : null,
      },
      chargeback_open: cbProven || cbClaimed,
      foreign_order_numbers: foreignNumbers,
      topics: triage?.topics ?? [],
      contexts_used: picked.selected.map((c) => c.label),
      missing_context_pt: decision.missing_context_pt,
      ticket: ticketReasons.length > 0,
      ticket_reason: ticketReasons.join(" · ") || null,
    },
  };
}

// O modelo às vezes devolve draft_reply_pt/customer_message_pt ainda no
// idioma original. Quem revisa lê em PT-BR — garantimos com uma chamada
// dedicada quando a "tradução" veio igual ao original.
async function ensurePortugueseTranslations(decision: AgentDecision) {
  if (isPortuguese(decision.language)) return;
  const fixes: Array<Promise<void>> = [];
  if (decision.draft_reply.trim() && looksUntranslated(decision.draft_reply, decision.draft_reply_pt)) {
    fixes.push(translateToPortuguese(decision.draft_reply, decision.language).then((t) => { decision.draft_reply_pt = t; }));
  }
  await Promise.all(fixes).catch((err) => console.error("tradução PT falhou:", err));
}

// Remetentes automáticos: spam sem gastar modelo.
export { NOISE_SENDER };

// Analisa as conversas que ainda não têm análise (novas, reabertas ou com
// mensagem nova depois da última análise), das mais recentes pras mais
// antigas. Envia sozinho SÓ se a categoria estiver liberada na loja e o
// agente não pedir humano.
// Sem crédito na OpenAI, a análise para em silêncio: em 13/10 ficaram 19
// conversas novas sem análise nem rascunho por 5 h e ninguém foi avisado (o
// aviso existente só dispara quando a Yael recebe uma mensagem). Mesmo alerta
// da Yael (chave openai_indisponivel): um só e-mail urgente por queda, que fecha
// sozinho quando uma análise volta a funcionar.
const OPENAI_ALERT_KEY = "openai_indisponivel";
async function alertOpenAiDown(admin: SupabaseClient, detail: string): Promise<void> {
  if (await findOpenAlert(admin, "outro", OPENAI_ALERT_KEY)) return;
  const { count } = await admin.from("conversations").select("id", { count: "exact", head: true }).in("status", ["nova", "reaberta", "aguardando_humano"]).is("analyzed_at", null);
  const waiting = count ?? 0;
  const message = `A OpenAI recusou o pedido (${detail.slice(0, 160)}). Sem crédito, nenhum e-mail novo recebe análise nem rascunho${waiting ? ` (${waiting} conversas esperando agora)` : ""}, e a Yael (WhatsApp) não responde perguntas livres. Recarregue em platform.openai.com → Settings → Billing e ative a recarga automática; tudo retoma sozinho em poucos minutos.`;
  const created = await createAlert(admin, { kind: "outro", key: OPENAI_ALERT_KEY, message });
  if (!created) return;
  const r = await sendAlertEmail(admin, { to: alertRecipient(), subject: "[Respondo] URGENTE: OpenAI sem crédito, e-mails sem resposta e Yael parada", text: `${message}\n\nAbra o Inbox para ver as conversas novas.` });
  if (!r.ok) console.error("analyze: alerta da OpenAI não saiu por e-mail:", r.error);
}

export async function analyzePendingConversations(
  admin: SupabaseClient,
  store: StoreRow,
  account: SmtpAccount,
  limit: number,
  deadline?: number
): Promise<{ analyzed: number; autoSent: number; errors: number }> {
  const { data: pending } = await admin
    .from("conversations")
    .select("id, customer_id, subject, status, store_id, language, customers(email), messages!inner(to_address)")
    .eq("messages.to_address", account.email_address.toLowerCase())
    .in("status", ["nova", "reaberta", "aguardando_humano"])
    .is("analyzed_at", null)
    .order("last_message_at", { ascending: false })
    .limit(limit);

  // Contato proativo (sequência de chargeback) não tem e-mail do cliente, então
  // o join acima (messages!inner) nunca o traz — nem depois de "Reanalisar"
  // zerar analyzed_at. Busca à parte: só as da loja desta caixa, sem mensagem
  // do cliente, e só as que o buildDecision sabe redigir sem e-mail dele
  // (chargeback aberto). Pedido de telefone fica de fora de propósito: já
  // nasce com rascunho pronto e a análise falharia ("sem mensagem do cliente"),
  // sobrescrevendo o analysis dele.
  const { data: proactiveRows } = await admin
    .from("conversations")
    .select("id, customer_id, subject, status, store_id, language, customers(email), messages!left(direction)")
    .eq("store_id", store.id)
    .in("status", ["nova", "reaberta", "aguardando_humano"])
    .is("analyzed_at", null)
    .not("analysis->chargeback", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  interface PendingRow { id: string; customer_id: string | null; subject: string | null; store_id: string; language?: string | null; customers: unknown }
  const seen = new Set((pending ?? []).map((c) => c.id as string));
  const proactive = ((proactiveRows ?? []) as unknown as Array<PendingRow & { messages: Array<{ direction: string }> | null }>).filter(
    (c) => !seen.has(c.id) && !(c.messages ?? []).some((m) => m.direction === "inbound")
  );

  // Cada conversa usa a loja dela (marca roteada), mesmo que a caixa seja
  // de outra loja. Cache por store_id.
  const storeCache = new Map<string, StoreRow>([[store.id, store]]);
  async function storeFor(id: string): Promise<StoreRow> {
    const cached = storeCache.get(id);
    if (cached) return cached;
    const { data } = await admin.from("stores").select("*").eq("id", id).maybeSingle();
    const row = (data as StoreRow | null) ?? store;
    storeCache.set(id, row);
    return row;
  }

  let analyzed = 0;
  let autoSent = 0;
  let errors = 0;
  const queue: PendingRow[] = [...((pending ?? []) as unknown as PendingRow[]), ...proactive];

  async function worker() {
    while (queue.length > 0) {
      if (deadline && Date.now() > deadline) return;
      const conv = queue.shift()!;
      try {
        // Trava contra análise em dobro: dois crons (vercel.json diário +
        // GitHub Actions a cada 10 min) podem se sobrepor e analisar a mesma
        // conversa duas vezes — e enviar duas vezes. Quem marcar analyzed_at
        // primeiro leva; o outro pula. A gravação da análise regrava
        // analyzed_at; em erro, o catch abaixo devolve pra fila.
        const { data: claimed } = await admin.from("conversations").update({ analyzed_at: new Date().toISOString() }).eq("id", conv.id).is("analyzed_at", null).select("id");
        if (!claimed || claimed.length === 0) continue;
        const customerEmail = (conv.customers as unknown as { email: string } | null)?.email;
        if (!customerEmail) {
          await admin.from("conversations").update({ analyzed_at: new Date().toISOString() }).eq("id", conv.id);
          continue;
        }
        const convStore = await storeFor(conv.store_id as string);
        const sent = await analyzeConversation(admin, convStore, account, { id: conv.id, customer_id: conv.customer_id, subject: conv.subject, language: (conv as { language?: string | null }).language ?? null }, customerEmail);
        analyzed += 1;
        if (analyzed === 1) await resolveOpenAlerts(admin, "outro", OPENAI_ALERT_KEY).catch(() => 0);
        if (sent) autoSent += 1;
      } catch (err) {
        errors += 1;
        const message = (err as Error).message;
        console.error(`Falha ao analisar conversa ${conv.id}:`, err);
        // Conta da OpenAI sem crédito/limite: não é problema da conversa. Para
        // o ciclo sem sobrescrever a análise e o rascunho que já existem.
        if (/no credits|insufficient_quota|exceeded your current quota|billing/i.test(message)) {
          queue.length = 0;
          // Solta a trava (claim acima) pra conversa voltar à fila quando houver crédito.
          await admin.from("conversations").update({ analyzed_at: null }).eq("id", conv.id);
          await admin.from("store_email_accounts").update({ last_error: "OpenAI sem créditos: adicione saldo em platform.openai.com → Billing. As análises retomam sozinhas." }).eq("id", (account as unknown as { id: string }).id);
          await alertOpenAiDown(admin, message).catch((e) => console.error("analyze: alerta da OpenAI falhou:", e instanceof Error ? e.message : e));
          return;
        }
        // Sem mensagem do cliente não há o que analisar: marca como feita pra
        // não ficar tentando a cada ciclo. Qualquer outro erro solta a trava
        // (analyzed_at volta a null) pra tentar de novo no próximo ciclo.
        const patch: Record<string, unknown> = { analysis: { error: message.slice(0, 300) }, analyzed_at: null };
        if (message.includes("sem mensagem do cliente")) patch.analyzed_at = new Date().toISOString();
        await admin.from("conversations").update(patch).eq("id", conv.id);
      }
    }
  }

  await Promise.all([worker(), worker(), worker()]);
  return { analyzed, autoSent, errors };
}

// Alguns provedores de e-mail respondem sozinhos ecoando de volta a NOSSA
// própria mensagem anterior (regra de auto-resposta do cliente, filtro
// corporativo, loop de encaminhamento) — isso chega como "inbound" do
// próprio cliente, mas o texto é literalmente o que nós mandamos (visto ao
// vivo, 30/09: cliente "Helena" nunca escreveu nada, o que virou
// "pendente" era o aviso de atraso que A LOJA tinha mandado, ecoado de
// volta). Sem resposta de verdade do cliente, não há o que analisar.
//
// CORRIGIDO em 01/10: a 1ª versão usava a similaridade "frouxa" do dedupe
// (45% de palavras em comum) e marcou como spam 7 respostas REAIS de cliente
// em uma noite — "meu telefone é…", "quero cancelar", "obrigada" — porque
// respostas curtas compartilham palavras com o que a gente escreveu, e
// algumas citavam nosso e-mail embaixo. Agora só conta como eco quando o
// texto do cliente (SEM a citação) é longo e praticamente IDÊNTICO a uma
// mensagem nossa: um cabe inteiro no outro e os tamanhos batem (≥ 85%).
const echoNorm = (t: string) => stripQuotedReply(t || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[\s\p{P}\p{Cf}]+/gu, " ").trim();
export function isEchoOf(inboundBody: string, outboundBody: string): boolean {
  const a = echoNorm(inboundBody);
  const b = echoNorm(outboundBody);
  if (a.length < 120 || b.length < 120) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length / longer.length >= 0.85 && longer.includes(shorter);
}
async function isMailLoopEcho(admin: SupabaseClient, customerId: string | null, inboundBody: string): Promise<boolean> {
  if (!customerId || !inboundBody) return false;
  const { data: convIds } = await admin.from("conversations").select("id").eq("customer_id", customerId);
  const ids = (convIds ?? []).map((c) => c.id as string);
  if (ids.length === 0) return false;
  const { data: sent } = await admin.from("messages").select("body").in("conversation_id", ids).neq("direction", "inbound").not("body", "is", null).order("sent_at", { ascending: false }).limit(20);
  return (sent ?? []).some((m) => isEchoOf(inboundBody, (m.body as string) ?? ""));
}

export async function analyzeConversation(
  admin: SupabaseClient,
  store: StoreRow,
  account: SmtpAccount,
  conversation: ConversationRef,
  customerEmail: string
): Promise<boolean> {
  // Aviso da Shopify (risco, pagamento, conformidade...): prioridade máxima
  // pro Ian ver, nunca uma resposta da IA. Fica pendente e urgente.
  if (isShopifyNotice(customerEmail, conversation.subject ?? "")) {
    await admin
      .from("conversations")
      .update({ status: "aguardando_humano", urgency: "urgente", category: "outro", analyzed_at: new Date().toISOString(), draft_reply: null, draft_reply_pt: null, analysis: { intent_pt: `Aviso da Shopify: ${conversation.subject ?? ""}`.trim(), shopify_notice: true } })
      .eq("id", conversation.id);
    return false;
  }
  if (NOISE_SENDER.test(customerEmail) || NOISE_SUBJECT.test(conversation.subject ?? "")) {
    await admin
      .from("conversations")
      .update({ status: "spam", category: "spam", unread: false, analyzed_at: new Date().toISOString(), analysis: { intent_pt: "Remetente automático (notificação/sistema)." } })
      .eq("id", conversation.id);
    return false;
  }
  {
    const { data: lastIn } = await admin
      .from("messages")
      .select("body")
      .eq("conversation_id", conversation.id)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (lastIn?.body && (await isMailLoopEcho(admin, conversation.customer_id, lastIn.body as string))) {
      await admin
        .from("conversations")
        .update({ status: "spam", category: "spam", unread: false, analyzed_at: new Date().toISOString(), analysis: { intent_pt: "Provável eco automático da nossa própria mensagem anterior (auto-resposta/filtro do provedor do cliente) — não é uma mensagem nova de verdade." } })
        .eq("id", conversation.id);
      return false;
    }
  }
  const { result: built, usage } = await trackUsage(() => buildDecision(admin, store, conversation, customerEmail));
  const { decision, orders, phase, file } = built;
  const usageTotal = await accumulateUsage(admin, conversation.id, usage);
  const now = new Date().toISOString();
  enforceNoTracking(decision, orders);
  decision.draft_reply = stripDashes(decision.draft_reply);
  if (portugueseLeak(decision.draft_reply, decision.language).length > 0 && decision.draft_reply_pt.trim()) decision.draft_reply = await translateReplyForCustomer(decision.draft_reply_pt, decision.language);
  decision.draft_reply_pt = stripDashes(decision.draft_reply_pt);

  const { data: lastInbound } = await admin
    .from("messages")
    .select("id, message_id, references_ids, subject, in_reply_to")
    .eq("conversation_id", conversation.id)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const { data: inboundBodies } = await admin.from("messages").select("body").eq("conversation_id", conversation.id).eq("direction", "inbound").limit(30);
  const hasInboundText = (inboundBodies ?? []).some((m) => String(m.body ?? "").replace(/\(e-mail sem conteúdo de texto\)/g, "").trim().length >= 12);

  const analysis = {
    phase,
    intent_pt: decision.intent_pt,
    tone_pt: decision.tone_pt,
    promises_made_pt: decision.promises_made_pt,
    order_situation_pt: decision.order_situation_pt,
    needs_human: decision.needs_human,
    human_reason: decision.human_reason,
    forced_escalation: decision.forced_escalation,
    ...file,
    usage,
    usage_total: usageTotal,
    ...(await carryOver(admin, conversation.id)),
  };

  await admin
    .from("conversations")
    .update({
      category: decision.category,
      urgency: urgencyFor(decision),
      anger_level: decision.anger_level,
      mentions_threat: decision.mentions_threat,
      wants_refund: decision.wants_refund,
      // E-mail SEM texto (só anexo/assinatura): a IA "chuta" português porque
      // é o idioma dos próprios campos dela — visto em 01/10 com duas clientes
      // israelenses rotuladas "pt". Aí vale o que já se sabia do cliente.
      language: hasInboundText
        ? normalizeLanguage(decision.language)
        : (normalizeLanguage(conversation.language ?? null) ?? (hasHebrew(customerEmail ?? "") || isIsraeliEmail(customerEmail ?? "") ? "he" : null) ?? normalizeLanguage(store.default_language ?? null) ?? normalizeLanguage(decision.language)),
      analysis,
      draft_reply: decision.draft_reply,
      draft_reply_pt: decision.draft_reply_pt,
      shopify_order: orders[0] ?? null,
      analyzed_at: now,
    })
    .eq("id", conversation.id)
    .then(({ error }) => {
      // Sem isto a falha passa calada, a conversa nunca fica "analisada" e é
      // refeita (e cobrada) a cada ciclo.
      if (error) throw new Error(`gravar análise: ${error.message}`);
    });

  if (lastInbound) {
    await admin.from("messages").update({ body_pt: decision.customer_message_pt }).eq("id", lastInbound.id);
  }
  await translateMissingMessages(admin, conversation.id, normalizeLanguage(decision.language));

  // Visto ao vivo (Ofra, 23/09): cliente real respondeu a um e-mail de
  // marketing nosso citando o e-mail inteiro, e a IA classificou como spam —
  // sumiu do Inbox sem ninguém ver. Quem tem pedido na Shopify, ou está
  // RESPONDENDO a um e-mail nosso, nunca é spam: vai pro humano decidir.
  // Só o cabeçalho In-Reply-To conta (um "Re:" no assunto qualquer newsletter põe).
  const replyingToUs = Boolean(lastInbound?.in_reply_to);
  const spamButLooksReal = decision.category === "spam" && (orders.length > 0 || replyingToUs);
  if (decision.category === "spam" && !spamButLooksReal) {
    await admin.from("conversations").update({ status: "spam", unread: false }).eq("id", conversation.id);
    return false;
  }
  if (spamButLooksReal) {
    await admin
      .from("conversations")
      .update({ status: "aguardando_humano", category: "duvidas_gerais", analysis: { ...analysis, needs_human: true, human_reason: `${analysis.human_reason ? `${analysis.human_reason} · ` : ""}A IA achou spam, mas ${orders.length > 0 ? "o cliente tem pedido na Shopify" : "é resposta a um e-mail nosso"} — confira.` } })
      .eq("id", conversation.id);
    return false;
  }

  const allowed = store.auto_send_categories ?? [];
  const canAutoSend = allowed.includes(decision.category) && !decision.needs_human && decision.draft_reply.trim().length > 0;

  if (!canAutoSend) {
    await admin.from("conversations").update({ status: "aguardando_humano" }).eq("id", conversation.id);
    await admin.from("usage_logs").insert({ store_id: store.id, event_type: "escalated" });
    return false;
  }

  const subject = lastInbound?.subject ?? conversation.subject ?? "";
  const { messageId } = await sendReply({
    emailAccount: {
      smtpHost: account.smtp_host,
      smtpPort: account.smtp_port,
      emailAddress: account.email_address,
      credentialEncrypted: account.credential_encrypted,
    },
    to: customerEmail,
    subject: /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`,
    body: decision.draft_reply,
    inReplyTo: lastInbound?.message_id ?? null,
    references: [...((lastInbound?.references_ids as string[] | null) ?? []), lastInbound?.message_id ?? ""].filter(Boolean),
  });

  await admin.from("messages").insert({
    conversation_id: conversation.id,
    direction: "outbound_ai",
    from_address: account.email_address,
    to_address: customerEmail,
    subject: `Re: ${subject}`,
    body: decision.draft_reply,
    body_pt: decision.draft_reply_pt,
    message_id: messageId,
    in_reply_to: lastInbound?.message_id ?? null,
    sent_at: now,
    ai_reasoning: decision.intent_pt,
  });
  await admin.from("conversations").update({ status: "respondida_ia", unread: false, last_message_at: now }).eq("id", conversation.id);
  await admin.from("usage_logs").insert({ store_id: store.id, event_type: "email_answered_ai" });
  return true;
}

// Todos os e-mails do cliente ficam legíveis em PT-BR no Inbox, não só o
// último. Em lotes pequenos pra não estourar o ciclo do cron.
export async function translateMissingMessages(admin: SupabaseClient, conversationId: string, language: string | null, max = 12): Promise<number> {
  if (isPortuguese(language)) return 0;
  const { data: rows } = await admin
    .from("messages")
    .select("id, body")
    .eq("conversation_id", conversationId)
    .is("body_pt", null)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(max);
  let done = 0;
  const queue = [...(rows ?? [])].filter((r) => ((r.body as string | null) ?? "").trim().length > 0);
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const pt = await translateToPortuguese((r.body as string).slice(0, 6000), language);
        if (pt) {
          await admin.from("messages").update({ body_pt: pt }).eq("id", r.id as string);
          done += 1;
        }
      } catch (err) {
        console.error("tradução de mensagem falhou:", (err as Error).message);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return done;
}

// Consumo acumulado da conversa (cada regeneração soma): alimenta o custo
// por resposta no Painel.
export async function accumulateUsage(admin: SupabaseClient, conversationId: string, usage: UsageTotals): Promise<UsageTotals> {
  const { data } = await admin.from("conversations").select("analysis").eq("id", conversationId).maybeSingle();
  const prev = (data?.analysis as { usage_total?: Partial<UsageTotals> } | null)?.usage_total ?? null;
  return addUsage(prev, usage);
}

// O que sobrevive a uma nova análise da conversa: lembretes de promessas, o
// estado do chargeback (pedidos, passo da sequência) e o registro do envio.
export async function carryOver(admin: SupabaseClient, conversationId: string): Promise<Record<string, unknown>> {
  const { data } = await admin.from("conversations").select("todos:analysis->todos, chargeback:analysis->chargeback, sent:analysis->sent").eq("id", conversationId).maybeSingle();
  const row = (data ?? {}) as { todos?: unknown; chargeback?: unknown; sent?: unknown };
  return {
    todos: Array.isArray(row.todos) ? row.todos : [],
    ...(row.chargeback ? { chargeback: row.chargeback } : {}),
    ...(row.sent ? { sent: row.sent } : {}),
  };
}
