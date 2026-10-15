import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDecision, enforceNoTracking, accumulateUsage, carryOver, loadAllShopifyCreds, type StoreRow } from "@/lib/agent/analyze";
import { trackUsage } from "@/lib/ai/usage";
import { normalizeLanguage } from "@/lib/ai/lang";
import { FOLLOWUP_AFTER_DAYS, type ChargebackOrder, type ChargebackState } from "@/lib/agent/chargeback-types";

const SHOPIFY_API_VERSION = "2026-07";
const PENDING = ["nova", "reaberta", "aguardando_humano"];

// Aviso da Shopify / Disputifier sobre contestação de um pedido.
// Bug visto ao vivo (28/09, pedido #2608): o aviso da Disputifier não bota o
// número do pedido no assunto ("New chargeback received"), só no corpo
// ("Order number: 2608") — o aviso caía sem ser detectado e ia pra spam sem
// nenhuma ação. Agora cai pro corpo quando o assunto não tem o número.
export function detectChargebackNotice(fromAddress: string, subject: string, body?: string | null): { orderNumber: string; kind: "opened" | "resolved" } | null {
  if (!/shopify|disputifier/i.test(fromAddress)) return null;
  if (!/chargeback|dispute|inquiry for order/i.test(subject)) return null;
  const order = subject.match(/#\s?(\d{3,6})/)?.[1] ?? body?.match(/order\s*(?:number|#)?\s*[:#]?\s*(\d{3,6})/i)?.[1];
  if (!order) return null;
  return { orderNumber: order, kind: /resolved|won|decided|in your favor|lost|closed/i.test(subject) ? "resolved" : "opened" };
}

export interface ShopOrder { name: string; email: string | null; firstName: string | null; createdAt: string; amount: string | null; currency: string | null; country: string | null }

// Pedido pelo número na Shopify DA LOJA que recebeu o aviso (o mesmo número
// existe em lojas diferentes — nunca procurar em todas).
export async function orderInStore(admin: SupabaseClient, storeId: string, orderNumber: string): Promise<ShopOrder | null> {
  const creds = (await loadAllShopifyCreds(admin, storeId)).find((c) => c.storeId === storeId);
  if (!creds?.accessToken) return null;
  const query = `{ orders(first: 3, query: "name:#${orderNumber}") { nodes { name email createdAt totalPriceSet { shopMoney { amount currencyCode } } customer { firstName } shippingAddress { countryCodeV2 } } } }`;
  const res = await fetch(`https://${creds.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": creds.accessToken }, body: JSON.stringify({ query }) });
  const json = await res.json().catch(() => null);
  const o = (json?.data?.orders?.nodes ?? []).find((n: { name: string }) => n.name.replace("#", "") === orderNumber);
  if (!o) return null;
  return { name: o.name, email: o.email ?? null, firstName: o.customer?.firstName ?? null, createdAt: o.createdAt, amount: o.totalPriceSet?.shopMoney?.amount ?? null, currency: o.totalPriceSet?.shopMoney?.currencyCode ?? null, country: o.shippingAddress?.countryCodeV2 ?? null };
}

const COUNTRY_LANG: Record<string, string> = { FR: "fr", CA: "fr", CH: "fr", BE: "fr", LU: "fr", TR: "tr", IL: "he", DE: "de", AT: "de", DK: "da", HU: "hu" };
const OUTREACH_SUBJECT: Record<string, (orders: string) => string> = {
  fr: (o) => `Votre commande ${o} — un message important de notre équipe`,
  en: (o) => `Your order ${o} — an important message from our team`,
  tr: (o) => `${o} numaralı siparişiniz — ekibimizden önemli bir mesaj`,
  de: (o) => `Ihre Bestellung ${o} — eine wichtige Nachricht von unserem Team`,
  he: (o) => `ההזמנה שלך ${o} — הודעה חשובה מהצוות שלנו`,
  da: (o) => `Din ordre ${o} — en vigtig besked fra vores team`,
};

// Registra (ou soma) contestações no cliente: UMA conversa por cliente, com
// todos os pedidos contestados. Devolve a conversa e se há e-mail a redigir.
export async function upsertChargeback(
  admin: SupabaseClient,
  input: { email: string; storeId: string; firstName?: string | null; language?: string | null; orders: ChargebackOrder[]; source?: string; alreadySentAt?: string | null }
): Promise<{ conversationId: string; needsDraft: boolean }> {
  const email = input.email.trim().toLowerCase();
  const { data: custs } = await admin.from("customers").select("id, store_id, name").ilike("email", email);
  let customer = (custs ?? []).find((c) => c.store_id === input.storeId) ?? (custs ?? [])[0] ?? null;
  if (!customer) {
    const { data: created, error } = await admin.from("customers").insert({ store_id: input.storeId, email, name: input.firstName ?? null }).select("id, store_id, name").single();
    if (error) throw error;
    customer = created;
  } else if (!customer.name && input.firstName) {
    await admin.from("customers").update({ name: input.firstName }).eq("id", customer.id as string);
  }
  const customerIds = [...new Set([...(custs ?? []).map((c) => c.id as string), customer!.id as string])];

  const { data: convs } = await admin.from("conversations").select("id, status, analysis, language").in("customer_id", customerIds).neq("status", "spam").order("last_message_at", { ascending: false }).limit(1);
  let conv = (convs ?? [])[0] ?? null;
  const lang = normalizeLanguage(input.language ?? null) ?? (conv?.language as string | null) ?? null;
  const now = new Date().toISOString();
  if (!conv) {
    const names = input.orders.map((o) => o.name).join(", ");
    const subject = (OUTREACH_SUBJECT[lang ?? "en"] ?? OUTREACH_SUBJECT.en)(names);
    // input.storeId (não customer!.store_id): o cliente pode já existir em
    // outra loja de uma interação antiga (ex.: Olavita, que não tem caixa de
    // e-mail própria — gerava rascunho impossível de enviar). O pedido
    // contestado foi encontrado NESSA loja.
    const { data: created, error } = await admin
      .from("conversations")
      .insert({ store_id: input.storeId, customer_id: customer!.id, subject, status: "aguardando_humano", unread: true, urgency: "urgente", language: lang, last_message_at: now })
      .select("id, status, analysis, language")
      .single();
    if (error) throw error;
    conv = created;
  }

  const analysis = ((conv!.analysis ?? {}) as Record<string, unknown>) || {};
  const prev = (analysis.chargeback ?? null) as ChargebackState | null;
  const known = new Set((prev?.orders ?? []).map((o) => o.name));
  const fresh = input.orders.filter((o) => !known.has(o.name));
  if (prev && !prev.resolved_at && fresh.length === 0) return { conversationId: conv!.id as string, needsDraft: false };

  const state: ChargebackState = {
    orders: [...(prev?.orders ?? []), ...fresh],
    // pedido novo contestado reinicia a sequência: o cliente precisa saber que vimos mais um
    step: prev && !prev.resolved_at && fresh.length === 0 ? prev.step : input.alreadySentAt ? 1 : 0,
    first_sent_at: input.alreadySentAt ?? null,
    last_sent_at: input.alreadySentAt ?? null,
    source: input.source ?? prev?.source ?? "aviso",
  };
  const needsDraft = !input.alreadySentAt;
  await admin
    .from("conversations")
    .update({
      analysis: { ...analysis, chargeback: state, chargeback_open: true, ticket: true, ticket_reason: `CHARGEBACK ABERTO (${state.orders.length} pedido(s), e-mail ${Math.min(state.step + 1, 3)} de 3)` },
      urgency: "urgente",
      ...(lang && !conv!.language ? { language: lang } : {}),
      ...(needsDraft ? { status: "aguardando_humano", unread: true, closed_at: null } : {}),
    })
    .eq("id", conv!.id as string);
  return { conversationId: conv!.id as string, needsDraft };
}

// Aviso novo chegou na caixa: acha o pedido na Shopify da loja dessa caixa,
// registra a contestação no cliente e já deixa o rascunho pronto.
export async function handleChargebackNotice(admin: SupabaseClient, storeId: string, notice: { orderNumber: string; kind: "opened" | "resolved" }, receivedAt: string): Promise<string | null> {
  const order = await orderInStore(admin, storeId, notice.orderNumber);
  if (!order?.email) return null;
  if (notice.kind === "resolved") {
    const { data: custs } = await admin.from("customers").select("id").ilike("email", order.email);
    const ids = (custs ?? []).map((c) => c.id as string);
    if (ids.length === 0) return null;
    const { data: convs } = await admin.from("conversations").select("id, analysis").in("customer_id", ids).not("analysis->chargeback", "is", null);
    for (const c of convs ?? []) {
      const analysis = (c.analysis ?? {}) as Record<string, unknown>;
      const state = analysis.chargeback as ChargebackState;
      const left = state.orders.filter((o) => o.name.replace("#", "") !== notice.orderNumber);
      await admin.from("conversations").update({ analysis: { ...analysis, chargeback: left.length > 0 ? { ...state, orders: left } : { ...state, resolved_at: receivedAt }, chargeback_open: left.length > 0 } }).eq("id", c.id as string);
    }
    return null;
  }
  const { conversationId, needsDraft } = await upsertChargeback(admin, {
    email: order.email,
    storeId,
    firstName: order.firstName,
    language: COUNTRY_LANG[order.country ?? ""] ?? null,
    orders: [{ name: order.name, opened_at: receivedAt, amount: order.amount, currency: order.currency, created_at: order.createdAt }],
    source: "aviso da Shopify",
  });
  if (needsDraft) await draftChargebackOutreach(admin, conversationId).catch((err) => console.error("rascunho de chargeback:", (err as Error).message));
  return conversationId;
}

// Redige (ou refaz) o e-mail da sequência pra essa conversa. Nada é enviado.
export async function draftChargebackOutreach(admin: SupabaseClient, conversationId: string): Promise<void> {
  const { data: conv } = await admin.from("conversations").select("id, store_id, customer_id, subject, language, product_id, customers(email)").eq("id", conversationId).single();
  const email = (conv?.customers as unknown as { email: string } | null)?.email;
  if (!conv || !email) throw new Error("conversa de chargeback sem cliente");
  const { data: store } = await admin.from("stores").select("*").eq("id", conv.store_id as string).single();
  if (!store) throw new Error("loja não encontrada");

  const { result, usage } = await trackUsage(() =>
    buildDecision(admin, store as unknown as StoreRow, { id: conv.id as string, customer_id: conv.customer_id as string | null, subject: conv.subject as string | null, product_id: (conv.product_id as string | null) ?? null, language: (conv.language as string | null) ?? null }, email, null)
  );
  const { decision, orders, phase, file } = result;
  enforceNoTracking(decision, orders);
  const usageTotal = await accumulateUsage(admin, conversationId, usage);
  const keep = await carryOver(admin, conversationId);
  const { error } = await admin
    .from("conversations")
    .update({
      draft_reply: decision.draft_reply,
      draft_reply_pt: decision.draft_reply_pt,
      shopify_order: orders[0] ?? null,
      category: "reclamacao",
      urgency: "urgente",
      language: normalizeLanguage(decision.language) ?? conv.language,
      status: "aguardando_humano",
      unread: true,
      analyzed_at: new Date().toISOString(),
      analysis: { phase, intent_pt: decision.intent_pt, tone_pt: decision.tone_pt, promises_made_pt: decision.promises_made_pt, order_situation_pt: decision.order_situation_pt, needs_human: true, human_reason: decision.human_reason, forced_escalation: true, ...file, usage, usage_total: usageTotal, ...keep },
    })
    .eq("id", conversationId);
  if (error) throw new Error(`gravar rascunho de chargeback: ${error.message}`);
}

// Sequência: sem resposta do cliente, o 2º e-mail fica pronto 1 dia depois do
// primeiro envio e o 3º, 3 dias depois. Só redige; quem envia é o dono.
export async function chargebackFollowUps(admin: SupabaseClient, max = 6): Promise<number> {
  const { data } = await admin.from("conversations").select("id, status, analysis").not("analysis->chargeback", "is", null).in("status", ["respondida_humano", "respondida_ia"]).limit(200);
  let drafted = 0;
  for (const c of data ?? []) {
    if (drafted >= max) break;
    const state = (c.analysis as { chargeback?: ChargebackState } | null)?.chargeback;
    if (!state || state.resolved_at || !state.first_sent_at || state.step < 1 || state.step > 2) continue;
    const dueAt = new Date(state.first_sent_at).getTime() + FOLLOWUP_AFTER_DAYS[state.step] * 86400000;
    if (Date.now() < dueAt) continue;
    try {
      await draftChargebackOutreach(admin, c.id as string);
      drafted += 1;
    } catch (err) {
      console.error("follow-up de chargeback:", (err as Error).message);
    }
  }
  return drafted;
}

export { PENDING as CHARGEBACK_PENDING };
