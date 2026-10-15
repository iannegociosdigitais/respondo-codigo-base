import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShopifyOrderSummary } from "@/lib/shopify/orders";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / MS_PER_DAY);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

// --- Fatos do pedido ---------------------------------------------------------
// Tudo aqui é calculado em código (datas, atraso, contagem) e entregue
// pronto pro modelo — ele nunca precisa "adivinhar" prazo ou status.

// Câmbio fixo da operação usado só pelo recibo em HTML (lib/forms/money.ts),
// que pega o valor certo direto da Shopify em código. O rascunho de resposta
// (texto livre da IA) NUNCA cita valor pago — ver REGRA DO IAN "VALOR" em
// house-rules.ts: o valor que a IA "lembra"/calcula sai errado (o cliente
// pode ter escolhido entre vários planos diferentes) e a moeda ILS de um
// pedido em EUR não é sempre 1:4 de verdade.
export const EUR_TO_ILS = 4;

// Alguns itens da Shopify têm o nome cadastrado no idioma do país da loja
// (alemão/francês), não traduzido. Isso é "Itens:" dentro de um bloco em
// PT-BR — a IA lia a palavra estrangeira como se fosse nome próprio e
// copiava sem traduzir pro idioma do cliente (visto ao vivo, 28/09: cliente
// em hebraico recebeu "Überraschungsgeschenk GRATIS" e "Cadeau surprise"
// dentro da resposta, sem tradução). Nome de marca/produto (Olavita,
// Tri-Lift, Peptide Complex) NÃO entra aqui — só palavra genérica comum.
const ITEM_TITLE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/Überraschungsgeschenk/gi, "presente surpresa"],
  [/\bTiegel\b/gi, "pote"],
  [/\bGRATIS\b/gi, "grátis"],
  [/Cadeau surprise/gi, "presente surpresa"],
  [/\bcadeau\b/gi, "presente"],
  [/\bgratuit(e)?\b/gi, "grátis"],
  [/\bgratuita\b/gi, "grátis"],
  [/\bofferte?\b/gi, "grátis"],
];
function translateItemTitle(title: string): string {
  return ITEM_TITLE_TRANSLATIONS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), title);
}

export function summarizeOrderFacts(
  orders: ShopifyOrderSummary[],
  deliveryDaysMax: number | null,
  shopifyConnected: boolean,
  shopifyError?: string | null
): string {
  const semPedido =
    "Pedido NÃO localizado automaticamente (o cliente pode ter comprado com outro e-mail). Isso é bastidor: NUNCA diga ao cliente que não encontrou o pedido, e NÃO abra a resposta pedindo número de pedido. Responda resolvendo com o que ele mesmo contou (há quantos dias comprou, o que comprou) + os prazos do contexto da loja/produto: confirme que o pedido está confirmado e em andamento, diga em que etapa ele está pelos prazos (preparação → envio → entrega) e diga o prazo de entrega em dias úteis (nunca datas de chegada). Só no fim, como gentileza opcional, ofereça conferir pessoalmente se ele quiser mandar o número do pedido. Não invente número, status de sistema ou rastreio.";
  if (!shopifyConnected) return semPedido;
  if (shopifyError) return `${semPedido}\n(Shopify respondeu com erro: ${shopifyError}.)`;
  if (orders.length === 0) return semPedido;

  const first = orders.find((o) => o.customerFirstName)?.customerFirstName;
  const header = first ? `Nome do cliente na Shopify: ${first} — cumprimente pelo primeiro nome.\n` : "";
  return header + orders
    .slice(0, 3)
    .map((o, i) => {
      const linhas = [
        `Pedido ${o.name}${o.sourceShopName ? ` (Shopify da loja ${o.sourceShopName})` : ""}${i === 0 ? " (mais relevante)" : ""}: comprado em ${fmtDate(o.createdAt)}, há ${daysSince(o.createdAt)} dias.`,
        `Pagamento: ${o.financialStatus}. Envio: ${o.fulfillmentStatus}.${o.cancelledAt ? ` CANCELADO em ${fmtDate(o.cancelledAt)}.` : ""}`,
        // Sem valor pago aqui de propósito (REGRA DO IAN "VALOR"): o cliente
        // pode ter escolhido entre vários planos/ofertas diferentes e o
        // total que a Shopify devolve nem sempre bate com o que ele
        // realmente pagou nem converte 1:1 pra outra moeda.
        `Itens: ${o.lineItems.map((li) => `${li.quantity}x ${translateItemTitle(li.title)}`).join(", ")}.`,
        // Endereço REAL registrado no pedido (o que está na Shopify agora) —
        // se o cliente citar/corrigir um endereço, COMPARE com este antes de
        // responder; nunca apenas repita o que o cliente disse como se fosse
        // fato, e nunca diga que "já atualizamos" (só um humano muda isso).
        (() => {
          const full = [o.shipping?.name, o.shipping?.address1, o.shipping?.address2, o.shipping?.zip, o.shipping?.city ?? o.city, o.shipping?.province, o.shipping?.country ?? o.countryCode].filter(Boolean).join(", ");
          return full ? `Endereço de entrega REGISTRADO no pedido: ${full}.` : null;
        })(),
      ];
      if (o.fulfilledAt) linhas.push(`Enviado em ${fmtDate(o.fulfilledAt)} (há ${daysSince(o.fulfilledAt)} dias).`);
      else linhas.push("Ainda NÃO foi enviado (sem fulfillment). NUNCA diga que o pedido já foi enviado ou que está a caminho.");
      // Israel: sem telefone a transportadora não aceita a remessa, o pedido
      // fica parado (visto em 05/10: dezenas de pedidos parados por isso, e a
      // IA respondendo "já foi enviado, chega em 1 a 4 dias").
      if (!o.fulfilledAt && !o.cancelledAt && o.countryCode === "IL" && o.phone === null)
        linhas.push("TELEFONE DE ENTREGA NÃO INFORMADO no pedido: é ISSO que está segurando o envio (a transportadora em Israel exige telefone para entregar). Explique isso com calma e peça o número de telefone nesta resposta, para o pedido sair.");
      // Israel (regra do Ian, 08/10): para quem pede o rastreio ou reclama da
      // demora, mandamos o link do 17track. Fora de Israel, nunca.
      linhas.push(
        !o.trackingNumber
          ? "Sem código de rastreio registrado."
          : o.countryCode === "IL"
            ? `Rastreio (Israel, PODE enviar se o cliente pediu o rastreio, reclama da demora ou o prazo médio já passou): código ${o.trackingNumber}, link https://t.17track.net/en#nums=${o.trackingNumber}`
            : `Existe código de rastreio${o.trackingCompany ? ` (${o.trackingCompany})` : ""}, NÃO incluir, prometer nem oferecer na resposta.`
      );
      if (deliveryDaysMax) {
        const atraso = daysSince(o.createdAt) - deliveryDaysMax;
        linhas.push(
          atraso > 0
            ? `PASSOU DA MÉDIA (não use a palavra "atrasado" com o cliente): prazo prometido de ${deliveryDaysMax} dias, já se passaram ${daysSince(o.createdAt)} — ${atraso} dias além do prometido.`
            : `Dentro do prazo prometido de ${deliveryDaysMax} dias (faltam ${-atraso} dias).`
        );
      }
      return linhas.filter(Boolean).join(" ");
    })
    .join("\n");
}

// --- Histórico do cliente ---------------------------------------------------

export interface CustomerHistorySummary {
  totalPreviousMessages: number;
  totalPreviousConversations: number;
  lastContactAt: string | null;
  previousCategories: string[];
}

export async function getCustomerHistory(
  supabase: SupabaseClient,
  storeId: string,
  customerId: string | null,
  excludeConversationId?: string
): Promise<CustomerHistorySummary> {
  if (!customerId) {
    return { totalPreviousMessages: 0, totalPreviousConversations: 0, lastContactAt: null, previousCategories: [] };
  }

  let query = supabase
    .from("conversations")
    .select("id, category, last_message_at")
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .order("last_message_at", { ascending: false });
  if (excludeConversationId) query = query.neq("id", excludeConversationId);
  const { data: conversations } = await query;

  const conversationIds = (conversations ?? []).map((c) => c.id as string);
  if (conversationIds.length === 0) {
    return { totalPreviousMessages: 0, totalPreviousConversations: 0, lastContactAt: null, previousCategories: [] };
  }

  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "inbound")
    .in("conversation_id", conversationIds);

  return {
    totalPreviousMessages: count ?? 0,
    totalPreviousConversations: conversationIds.length,
    lastContactAt: (conversations?.[0]?.last_message_at as string | undefined) ?? null,
    previousCategories: (conversations ?? []).map((c) => c.category).filter((c): c is string => Boolean(c)),
  };
}

export function summarizeCustomerHistory(history: CustomerHistorySummary): string {
  if (history.totalPreviousConversations === 0) return "Primeiro contato desse cliente — sem histórico anterior.";
  return (
    `Esse cliente já mandou ${history.totalPreviousMessages} e-mail(is) em ` +
    `${history.totalPreviousConversations} outra(s) conversa(s), último contato em ${history.lastContactAt ? fmtDate(history.lastContactAt) : "?"}. ` +
    `Assuntos anteriores: ${history.previousCategories.join(", ") || "não classificados"}.`
  );
}

// --- Transcrição -----------------------------------------------------------
// Texto real das mensagens, em ordem, pra o modelo ver exatamente o que já
// foi prometido antes de responder de novo.

export interface TranscriptMessage {
  direction: string;
  body: string;
  createdAt: string;
}

export async function getConversationTranscript(
  supabase: SupabaseClient,
  conversationIds: string[],
  limit = 30
): Promise<TranscriptMessage[]> {
  if (conversationIds.length === 0) return [];
  const { data } = await supabase
    .from("messages")
    .select("direction, body, sent_at, created_at")
    .in("conversation_id", conversationIds)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  return (data ?? [])
    .map((m) => ({
      direction: m.direction as string,
      body: ((m.body as string) ?? "").slice(0, 2500),
      createdAt: ((m.sent_at as string | null) ?? (m.created_at as string)) as string,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function summarizeTranscript(messages: TranscriptMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const quem = m.direction === "inbound" ? "Cliente" : m.direction === "outbound_human" ? "Loja (humano)" : "Loja (IA)";
      return `[${fmtDate(m.createdAt)}] ${quem}: ${m.body}`;
    })
    .join("\n");
}

// --- Casos parecidos já ensinados -------------------------------------------

export async function getRelevantPlaybookRules(
  supabase: SupabaseClient,
  storeId: string,
  category: string | null
): Promise<Array<{ situation_summary: string; guidance: string }>> {
  let query = supabase
    .from("learned_responses")
    .select("situation_summary, guidance")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(12);
  if (category) query = query.eq("category", category);
  const { data } = await query;
  return data ?? [];
}

export function summarizePlaybookRules(rules: Array<{ situation_summary: string; guidance: string }>): string {
  if (rules.length === 0) return "";
  return rules.map((r, i) => `${i + 1}. Situação: ${r.situation_summary}\n   Como responder: ${r.guidance}`).join("\n");
}

// --- Produto e país -----------------------------------------------------------

export interface ProductContext {
  name: string;
  description: string | null;
  warrantyInfo: string | null;
  notes: string | null;
}

export async function getProductContext(supabase: SupabaseClient, storeId: string, shopifyProductIds: string[]): Promise<ProductContext[]> {
  if (shopifyProductIds.length === 0) return [];
  const { data } = await supabase
    .from("store_products")
    .select("name, description, warranty_info, notes")
    .eq("store_id", storeId)
    .in("shopify_product_id", shopifyProductIds);
  return (data ?? []).map((p) => ({
    name: p.name as string,
    description: p.description as string | null,
    warrantyInfo: p.warranty_info as string | null,
    notes: p.notes as string | null,
  }));
}

export interface ShippingZoneContext {
  countryCode: string;
  deliveryDaysMax: number | null;
  defaultLanguage: string | null;
  notes: string | null;
}

export async function getShippingZoneContext(supabase: SupabaseClient, storeId: string, countryCode: string | null): Promise<ShippingZoneContext | null> {
  if (!countryCode) return null;
  const { data } = await supabase
    .from("store_shipping_zones")
    .select("country_code, delivery_days_max, default_language, notes")
    .eq("store_id", storeId)
    .eq("country_code", countryCode)
    .maybeSingle();
  if (!data) return null;
  return {
    countryCode: data.country_code as string,
    deliveryDaysMax: data.delivery_days_max as number | null,
    defaultLanguage: data.default_language as string | null,
    notes: data.notes as string | null,
  };
}

export function resolveDeliveryDaysMax(storeDefaultDays: number | null, zone: ShippingZoneContext | null): number | null {
  return zone?.deliveryDaysMax ?? storeDefaultDays;
}

export function summarizeProductAndZoneContext(products: ProductContext[], zone: ShippingZoneContext | null): string {
  const linhas: string[] = [];
  if (products.length > 0) {
    linhas.push("Produto(s) desse pedido (prevalecem sobre o padrão da loja quando conflitarem):");
    for (const p of products) {
      const detalhes = [
        p.description ? `descrição: ${p.description}` : null,
        p.warrantyInfo ? `garantia específica: ${p.warrantyInfo}` : null,
        p.notes ? `observação: ${p.notes}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      linhas.push(`- ${p.name}${detalhes ? ` (${detalhes})` : ""}`);
    }
  }
  if (zone?.notes) linhas.push(`País do pedido: ${zone.countryCode}. Observação específica: ${zone.notes}.`);
  return linhas.join("\n");
}

// --- Contexto livre por loja ------------------------------------------------

export interface StoreContextEntry {
  label: string;
  content: string;
}

// Blocos da loja (product_id null) + blocos do produto da conversa. Sem a
// migration 0011 (coluna product_id) cai no modo só-loja.
// Lojas são só caixas de e-mail + Shopify: o contexto geral (blocos sem
// produto) vale em QUALQUER loja; o contexto de produto vale pro produto, em
// qualquer loja em que ele apareça (casado pelo nome).
export async function getStoreContexts(supabase: SupabaseClient, storeId: string, productId: string | null = null, productName: string | null = null): Promise<StoreContextEntry[]> {
  const { data, error } = await supabase.from("store_contexts").select("label, content, product_id, store_id").order("created_at", { ascending: true });
  if (error) {
    const { data: plain } = await supabase.from("store_contexts").select("label, content").eq("store_id", storeId).order("created_at", { ascending: true });
    return plain ?? [];
  }
  let productIds = productId ? [productId] : [];
  let brandStoreIds: string[] = [];
  if (productName) {
    const [{ data: sameName }, { data: brandStores }] = await Promise.all([
      supabase.from("products").select("id").ilike("name", productName),
      supabase.from("stores").select("id").ilike("name", productName),
    ]);
    productIds = [...new Set([...productIds, ...(sameName ?? []).map((p) => p.id as string)])];
    brandStoreIds = (brandStores ?? []).map((b) => b.id as string);
  }
  // Loja com o nome de uma marca (ex.: loja "Olavita"): os blocos gerais dela
  // são contexto DA MARCA, só entram quando o produto é essa marca.
  const { data: allProducts } = await supabase.from("products").select("name");
  const brandNames = new Set((allProducts ?? []).map((p) => (p.name as string).toLowerCase()));
  const { data: stores } = await supabase.from("stores").select("id, name");
  const brandOnlyStores = new Set((stores ?? []).filter((st) => brandNames.has((st.name as string).toLowerCase())).map((st) => st.id as string));

  const rows = (data ?? []).filter((c) => {
    if (c.product_id) return productIds.includes(c.product_id as string);
    // Produto não identificado: entram os blocos das marcas (hoje só a Olavita
    // vende; OsteoPure foi encerrada em 15/10 e os blocos dela estão arquivados
    // no produto). Antes, sem produto, entravam só as regras antigas da OsteoPure.
    if (brandOnlyStores.has(c.store_id as string)) return brandStoreIds.length === 0 || brandStoreIds.includes(c.store_id as string);
    return true;
  });
  // A loja da conversa primeiro; rótulo repetido não entra duas vezes.
  rows.sort((a, b) => Number(b.store_id === storeId) - Number(a.store_id === storeId));
  const seen = new Set<string>();
  return rows.filter((c) => !seen.has(c.label as string) && seen.add(c.label as string)).map((c) => ({ label: c.label as string, content: c.content as string }));
}

export function summarizeStoreContexts(entries: StoreContextEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => `• ${e.label}: ${e.content}`).join("\n");
}
