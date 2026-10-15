import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchOrdersForCustomer, loadAllShopifyCreds } from "@/lib/agent/analyze";
import { loadProducts, routeProduct } from "@/lib/agent/products";
import { langFromCountry } from "@/lib/forms/money";
import { localizeItemTitles } from "@/lib/forms/item-titles";
import { buildReceipt } from "@/lib/receipts/build";
import { sendReply } from "@/lib/email/send-reply";

export const maxDuration = 60;

// Recibo da compra em HTML, montado por código (sem IA no texto):
//  GET  ?order=#1234 → pedidos do cliente + prévia do recibo
//  POST { order }     → envia o recibo pro cliente, na mesma conversa
// Padrão: a COMPRA INICIAL (o pedido pago mais antigo). Marca pelo produto do
// pedido, idioma e moeda do cliente, sem menção a assinatura.
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED"]);

async function load(id: string, wanted: string | null) {
  const admin = createAdminClient();
  const { data: conv } = await admin.from("conversations").select("id, store_id, subject, language, analysis, customers(email, name)").eq("id", id).single();
  if (!conv) return { error: "conversa não encontrada", status: 404 as const };
  const customer = conv.customers as unknown as { email: string; name: string | null } | null;
  if (!customer?.email) return { error: "cliente sem e-mail", status: 400 as const };

  const creds = await loadAllShopifyCreds(admin, null);
  const { orders } = await fetchOrdersForCustomer(admin, creds, null, customer.email, "");
  const paid = orders.filter((o) => PAID.has((o.financialStatus ?? "").toUpperCase()) && !o.cancelledAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (paid.length === 0) return { error: "nenhum pedido pago desse e-mail na Shopify", status: 404 as const };
  const order = (wanted && paid.find((o) => o.name === wanted)) || paid[0];
  // Comprovante só da 1ª compra: renovação de assinatura nunca (regra do Ian, 05/10).
  if (order?.isRenewal) return { error: `${order.name} é renovação de assinatura: comprovante só vai na 1ª compra do cliente.`, status: 409 as const };

  const product = routeProduct(await loadProducts(admin), { storeId: "", recipients: [], texts: [], orderTitles: order.lineItems.map((li) => li.title) });
  const brand = product?.name?.split(/\s+/)[0];
  if (!brand) return { error: "não consegui identificar a marca pelo produto do pedido", status: 422 as const };
  const language = (conv.language as string | null) || langFromCountry(order.countryCode) || "en";
  const receipt = buildReceipt({ order, brand, language, customerName: customer.name, itemTitles: await localizeItemTitles(order.lineItems.map((li) => li.title), language.slice(0, 2)) });
  return { admin, conv, customer, order, paid, brand, receipt };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // a prévia (só leitura) também aceita a chave do cron, pra teste automático
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }
  const { id } = await params;
  const r = await load(id, new URL(request.url).searchParams.get("order"));
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const sent = ((r.conv.analysis as { receipts_sent?: Array<{ order: string; at: string }> } | null)?.receipts_sent ?? []);
  return NextResponse.json({
    orders: r.paid.map((o, i) => ({ name: o.name, date: o.createdAt, initial: i === 0 })),
    selected: r.order.name, brand: r.brand, to: r.customer.email, subject: r.receipt.subject, html: r.receipt.html, sent,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const r = await load(id, typeof body.order === "string" ? body.order : null);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const { admin, conv, customer, order, brand, receipt } = r;

  const analysis = (conv.analysis ?? {}) as Record<string, unknown>;
  const sentBefore = (analysis.receipts_sent as Array<{ order: string; at: string }> | undefined) ?? [];
  // Já foi enviado alguma vez (em qualquer data) = não manda de novo sem
  // "force". Duas fontes: o histórico desta conversa e a tabela auto_receipts,
  // que é a mesma trava da aba "E-mail de confirmação" (lib/receipts/auto.ts):
  // chave (loja onde o pedido está na Shopify, id do pedido na Shopify).
  const receiptStoreId = order.sourceStoreId ?? (conv.store_id as string);
  if (!body.force && sentBefore.some((s) => s.order === order.name)) {
    return NextResponse.json({ error: `O recibo do pedido ${order.name} já foi enviado nesta conversa.` }, { status: 409 });
  }
  if (!body.force) {
    // Mesma trava da aba "E-mail de confirmação" e do automático: um
    // comprovante por e-mail de cliente (tabela email_log). Só "force" passa.
    const { data: already, error: checkError } = await admin.from("email_log").select("id, created_at").eq("kind", "receipt").eq("is_test", false).eq("to_address", String(customer.email).trim().toLowerCase()).in("status", ["sent", "sending"]).limit(1);
    if (checkError) return NextResponse.json({ error: "Não consegui checar se esse cliente já recebeu comprovante (rode a migration 0017_email_log.sql). Nada foi enviado." }, { status: 500 });
    if (already?.[0]) return NextResponse.json({ error: `Esse cliente já recebeu um comprovante (${new Date(already[0].created_at as string).toLocaleDateString("pt-BR")}).` }, { status: 409 });
  }

  const { data: lastInbound } = await admin.from("messages").select("message_id, references_ids, to_address").eq("conversation_id", id).eq("direction", "inbound").order("sent_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const receiving = ((lastInbound?.to_address as string | null) ?? "").toLowerCase();
  const { data: byAddress } = receiving ? await admin.from("store_email_accounts").select("*").eq("email_address", receiving).not("connected_at", "is", null).limit(1) : { data: null };
  const { data: accounts } = await admin.from("store_email_accounts").select("*").eq("store_id", conv.store_id).not("connected_at", "is", null);
  const account = byAddress?.[0] ?? (accounts ?? [])[0];
  if (!account) return NextResponse.json({ error: "nenhuma caixa de e-mail conectada nessa loja" }, { status: 400 });

  let messageId: string | null = null;
  try {
    const sent = await sendReply({
      emailAccount: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
      to: customer.email, subject: receipt.subject, body: receipt.text, html: receipt.html, fromName: brand,
      inReplyTo: (lastInbound?.message_id as string | null) ?? null,
      references: [...((lastInbound?.references_ids as string[] | null) ?? []), (lastInbound?.message_id as string | null) ?? ""].filter(Boolean),
    });
    messageId = sent.messageId;
  } catch (err) {
    return NextResponse.json({ error: `Falha ao enviar: ${(err as Error).message}` }, { status: 502 });
  }

  const now = new Date().toISOString();
  await admin.from("messages").insert({ conversation_id: id, direction: "outbound_human", from_address: account.email_address, to_address: customer.email, subject: receipt.subject, body: receipt.text, body_pt: `[Recibo em HTML do pedido ${order.name} enviado ao cliente — marca ${brand}]`, message_id: messageId, in_reply_to: (lastInbound?.message_id as string | null) ?? null, sent_at: now });
  const { data: cur } = await admin.from("conversations").select("analysis").eq("id", id).single();
  await admin.from("conversations").update({ analysis: { ...((cur?.analysis ?? {}) as Record<string, unknown>), receipts_sent: [...sentBefore, { order: order.name, at: now }] } }).eq("id", id);
  // Registra no email_log (painel de entregabilidade + trava). Reenvio
  // forçado de quem já tinha recebido entra sem chave (a chave já existe).
  const logRow = { kind: "receipt", store_id: receiptStoreId, conversation_id: id, from_address: account.email_address, to_address: String(customer.email).trim().toLowerCase(), brand, language: receipt.language, subject: receipt.subject, order_id: order.id, order_name: order.name, message_id: messageId, status: "sent", trigger: "manual", sent_at: now };
  const { error: logError } = await admin.from("email_log").insert({ ...logRow, dedupe_key: `receipt:${logRow.to_address}` });
  if (logError?.code === "23505") await admin.from("email_log").insert({ ...logRow, dedupe_key: null });
  else if (logError) console.error("receipt: e-mail enviado mas não consegui gravar em email_log:", logError.message);
  return NextResponse.json({ ok: true, order: order.name });
}
