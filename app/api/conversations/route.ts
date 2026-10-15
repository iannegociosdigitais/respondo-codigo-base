import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const PENDING = ["nova", "reaberta", "aguardando_humano"];
const ANSWERED = ["respondida_ia", "respondida_humano"];

// Lista de conversas do Inbox/Tickets com filtros: loja, status (grupo ou
// exato), categoria, urgência, cliente, busca livre.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const storeId = url.searchParams.get("store");
  const status = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  const urgency = url.searchParams.get("urgency");
  const customerId = url.searchParams.get("customer");
  const q = url.searchParams.get("q")?.trim();
  const lang = url.searchParams.get("lang");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const withOrder = url.searchParams.get("order") === "1";
  const phase = url.searchParams.get("phase");
  // Loja Shopify onde o cliente comprou (id da loja conectada), ou "none" =
  // cliente sem nenhum pedido achado nas Shopify.
  const shop = url.searchParams.get("shop");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 300);

  const admin = createAdminClient();
  let query = admin
    .from("conversations")
    .select(`id, subject, category, urgency, status, unread, anger_level, mentions_threat, wants_refund, language, last_message_at, created_at, draft_reply, draft_reply_pt, a_intent:analysis->>intent_pt, a_phase:analysis->phase, a_ticket:analysis->ticket, a_reason:analysis->>ticket_reason, a_gap:analysis->>missing_context_pt, a_unanswered:analysis->unanswered_count, a_wait:analysis->waiting_days, a_shopify:analysis->shopify_notice, stores(id, name), ${shop ? "customers!inner(id, email)" : "customers(id, email)"}`)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (storeId) query = query.eq("store_id", storeId);
  // Ticket = o que precisa do dono pessoalmente (ameaça, caso grave, faltou contexto).
  if (url.searchParams.get("ticket")) query = query.eq("analysis->>ticket", "true");
  if (url.searchParams.get("unread")) query = query.eq("unread", true);
  if (url.searchParams.get("gap")) query = query.not("analysis->>missing_context_pt", "is", null);
  if (customerId) query = query.eq("customer_id", customerId);
  if (category) query = query.eq("category", category);
  if (urgency) query = query.eq("urgency", urgency);
  if (lang) query = query.eq("language", lang);
  if (from) query = query.gte("last_message_at", `${from}T00:00:00Z`);
  if (to) query = query.lte("last_message_at", `${to}T23:59:59Z`);
  if (withOrder) query = query.or("shopify_order.not.is.null,subject.ilike.%#%");
  if (phase) query = query.eq("analysis->>phase", phase);
  if (shop === "none") query = query.or("shopify_orders.is.null,shopify_orders.eq.[]", { referencedTable: "customers" });
  // jsonb: o valor vai como texto JSON (contains() com array viraria array do Postgres)
  else if (shop) query = query.filter("customers.shopify_orders", "cs", JSON.stringify([{ sourceStoreId: shop }]));

  // BUSCA: procura em TODAS as conversas (pendentes, respondidas, encerradas),
  // direto no banco: e-mail ou nome do cliente, assunto, ou texto da mensagem.
  if (q) {
    const safe = q.replace(/[%,()]/g, " ").trim();
    const [{ data: custs }, { data: msgHits }] = await Promise.all([
      admin.from("customers").select("id").or(`email.ilike.%${safe}%,name.ilike.%${safe}%`).limit(200),
      admin.from("messages").select("conversation_id").ilike("body", `%${safe}%`).limit(200),
    ]);
    const custIds = (custs ?? []).map((c) => c.id as string);
    const convIds = [...new Set((msgHits ?? []).map((m) => m.conversation_id as string))];
    const parts = [`subject.ilike.%${safe}%`];
    if (custIds.length > 0) parts.push(`customer_id.in.(${custIds.join(",")})`);
    if (convIds.length > 0) parts.push(`id.in.(${convIds.join(",")})`);
    query = query.or(parts.join(","));
  }

  if (q) query = query.neq("status", "spam");
  else if (status === "pendentes") query = query.in("status", PENDING);
  else if (status === "respondidos") query = query.in("status", ANSWERED);
  else if (status === "conversas") query = query.neq("status", "spam");
  else if (status) query = query.eq("status", status);
  else query = query.neq("status", "spam");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(({ a_intent, a_phase, a_ticket, a_reason, a_gap, a_unanswered, a_wait, a_shopify, draft_reply, draft_reply_pt, ...r }) => ({
    ...r,
    // só se existe rascunho pronto pra enviar — o texto completo só vai na
    // tela da própria conversa, aqui pesaria demais numa lista de centenas.
    // O envio usa o rascunho em português (traduz na hora se o traduzido
    // estiver vazio), então qualquer um dos dois conta como rascunho pronto.
    has_draft: Boolean((draft_reply as string | null)?.trim() || (draft_reply_pt as string | null)?.trim()),
    analysis: { intent_pt: a_intent ?? undefined, phase: a_phase ?? undefined, ticket: a_ticket ?? undefined, ticket_reason: a_reason ?? null, missing_context_pt: a_gap ?? null, unanswered_count: a_unanswered ?? undefined, waiting_days: a_wait ?? undefined, shopify_notice: Boolean(a_shopify) },
  }));
  // Um por cliente: só o e-mail mais recente de cada cliente (uma resposta
  // cobre todos; ao enviar, as outras pendências dele são encerradas).
  if (url.searchParams.get("unique") && !q) {
    const rank: Record<string, number> = { urgente: 3, alta: 2, normal: 1, baixa: 0 };
    const byCustomer = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const r of [...rows].sort((a, b) => ((b.last_message_at as string) ?? "").localeCompare((a.last_message_at as string) ?? ""))) {
      const key = (r.customers?.id as string | undefined) ?? (r.id as string);
      const head = byCustomer.get(key);
      if (!head) {
        byCustomer.set(key, { ...r, same_customer: 0 });
        continue;
      }
      head.same_customer += 1;
      // A urgência e os alertas do grupo são os mais graves entre os e-mails dele.
      if ((rank[r.urgency as string] ?? 0) > (rank[head.urgency as string] ?? 0)) head.urgency = r.urgency;
      head.mentions_threat = head.mentions_threat || r.mentions_threat;
      head.wants_refund = head.wants_refund || r.wants_refund;
      head.unread = head.unread || r.unread;
      if (r.analysis?.ticket && !head.analysis?.ticket) head.analysis = { ...head.analysis, ticket: true, ticket_reason: r.analysis.ticket_reason };
    }
    rows = [...byCustomer.values()];
  }

  // Mais urgente primeiro (urgência > sinais de risco > mais recente).
  if (url.searchParams.get("sort") === "urgencia") {
    const rank: Record<string, number> = { urgente: 3, alta: 2, normal: 1, baixa: 0 };
    rows = [...rows].sort((a, b) => {
      const ra = (rank[a.urgency as string] ?? 0) * 10 + (a.mentions_threat ? 3 : 0) + (a.wants_refund ? 2 : 0) + ((a.anger_level as number | null) ?? 0) / 10;
      const rb = (rank[b.urgency as string] ?? 0) * 10 + (b.mentions_threat ? 3 : 0) + (b.wants_refund ? 2 : 0) + ((b.anger_level as number | null) ?? 0) / 10;
      if (rb !== ra) return rb - ra;
      return ((b.last_message_at as string) ?? "").localeCompare((a.last_message_at as string) ?? "");
    });
  }
  // Aviso da Shopify pendente sempre no topo, em qualquer ordenação (regra do
  // Ian, 13/10: tudo da Shopify é prioridade 1).
  const pending = new Set(["nova", "reaberta", "aguardando_humano"]);
  rows = [...rows].sort((a, b) => Number(Boolean(b.analysis?.shopify_notice) && pending.has(b.status)) - Number(Boolean(a.analysis?.shopify_notice) && pending.has(a.status)));
  return NextResponse.json({ conversations: rows });
}
