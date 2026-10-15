import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchOrdersForCustomer, loadAllShopifyCreds } from "@/lib/agent/analyze";
import { loadProducts, routeProduct } from "@/lib/agent/products";
import { readFormToken } from "@/lib/forms/token";
import { customerAmount, customerMoney, langFromCountry } from "@/lib/forms/money";
import { pickFormLang } from "@/lib/forms/i18n";
import { localizeItemTitles } from "@/lib/forms/item-titles";

export const maxDuration = 60;

// Página pública do formulário de solicitação.
//  step "start":  { token?, email? }  → marca, idioma e os pedidos DAQUELE e-mail
//  step "submit": formulário completo → grava e devolve o número de referência
// Só devolve o mínimo do pedido (número, data, itens, total). Pedido só por
// e-mail do próprio cliente — nunca por número digitado.
const clean = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function ordersFor(email: string, wantedLang: string | null) {
  const admin = createAdminClient();
  const creds = await loadAllShopifyCreds(admin, null);
  const { orders } = await fetchOrdersForCustomer(admin, creds, null, email, "");
  const products = await loadProducts(admin);
  const titles = orders.flatMap((o) => o.lineItems.map((li) => li.title));
  const product = routeProduct(products, { storeId: "", recipients: [], texts: [], orderTitles: titles });
  // Idioma: o do link; sem ele, o que o cliente escolheu na página; sem ele, o do país do pedido.
  const language = pickFormLang(wantedLang || langFromCountry(orders[0]?.countryCode) || "en");
  const shownTitles = await localizeItemTitles(titles, language);
  return {
    admin,
    product,
    language,
    orders: orders.slice(0, 8).map((o) => ({
      name: o.name,
      date: o.createdAt,
      items: o.lineItems.map((li) => `${li.quantity}× ${shownTitles.get(li.title) ?? li.title}`),
      itemsOriginal: o.lineItems.map((li) => `${li.quantity}× ${li.title}`),
      total: o.totalPrice,
      currency: o.currency,
      // valor como o cliente pagou/entende (moeda do checkout; Israel em shekel)
      shown: customerAmount({ total: o.totalPrice, currency: o.currency, presentmentTotal: o.presentmentTotal, presentmentCurrency: o.presentmentCurrency, country: o.countryCode }),
      totalLabel: customerMoney({ total: o.totalPrice, currency: o.currency, presentmentTotal: o.presentmentTotal, presentmentCurrency: o.presentmentCurrency, country: o.countryCode }, language),
      country: o.countryCode,
      city: o.city,
    })),
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const rawToken = clean(body.token, 2000);
  const token = readFormToken(rawToken);
  // Link quebrado/adulterado: a página avisa e cai na busca por e-mail.
  if (rawToken && !token && !clean(body.email, 200)) return NextResponse.json({ error: "token" }, { status: 400 });
  const chosenLang = clean(body.language, 8) || null;
  const email = (token?.e ?? clean(body.email, 200)).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "email" }, { status: 400 });

  if (body.step === "start") {
    const { product, orders, language } = await ordersFor(email, token?.l ?? chosenLang);
    return NextResponse.json({ brand: product?.name?.split(/\s+/)[0] ?? token?.p ?? null, language: token?.l || !chosenLang ? language : null, emailLocked: Boolean(token?.e), email: token?.e ? email : undefined, orders });
  }

  if (body.step !== "submit") return NextResponse.json({ error: "step" }, { status: 400 });

  const selected: string[] = Array.isArray(body.orders) ? body.orders.map((x: unknown) => clean(x, 40)).filter(Boolean).slice(0, 8) : [];
  const description = clean(body.description, 4000);
  const signature = typeof body.signature === "string" && body.signature.startsWith("data:image/png;base64,") && body.signature.length < 400_000 ? body.signature : "";
  const resolution = body.resolution === "reenvio" ? "reenvio" : body.resolution === "regularizacao" ? "regularizacao" : "";
  if (selected.length === 0 || !clean(body.name) || description.length < 150 || !resolution || !signature || !(body.consents?.c1 && body.consents?.c2 && body.consents?.c3)) {
    return NextResponse.json({ error: "required" }, { status: 400 });
  }

  // Só entram pedidos que são mesmo desse e-mail.
  const { admin, product, orders } = await ordersFor(email, chosenLang ?? token?.l ?? null);
  const mine = orders.filter((o) => selected.includes(o.name));
  if (mine.length === 0) return NextResponse.json({ error: "orders" }, { status: 400 });

  // Mesmo pedido enviado de novo (duplo clique, voltar e reenviar): devolve a
  // mesma referência em vez de gravar outra. E um teto por dia por e-mail e por IP.
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 60) || null;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: recent } = await admin.from("return_requests").select("reference, orders, customer_email, ip, status").gte("created_at", since).or(`customer_email.eq.${email}${ip ? `,ip.eq.${ip}` : ""}`).limit(50);
  const names = mine.map((o) => o.name).sort().join(",");
  const same = (recent ?? []).find((r) => r.customer_email === email && r.status === "pendente" && ((r.orders as Array<{ name: string }> | null) ?? []).map((o) => o.name).sort().join(",") === names);
  if (same) return NextResponse.json({ ok: true, reference: same.reference, duplicate: true });
  if ((recent ?? []).filter((r) => r.customer_email === email).length >= 3 || (recent ?? []).length >= 8) return NextResponse.json({ error: "limit" }, { status: 429 });

  const { data: cust } = await admin.from("customers").select("id, store_id").ilike("email", email).limit(1).maybeSingle();
  const reference = randomBytes(4).toString("hex").toUpperCase();
  const { error } = await admin.from("return_requests").insert({
    reference,
    product_name: product?.name ?? token?.p ?? null,
    store_id: product?.store_id ?? (cust?.store_id as string | undefined) ?? null,
    conversation_id: token?.c ?? null,
    customer_email: email,
    customer_name: clean(body.name),
    phone: clean(body.phone, 40) || null,
    language: clean(body.language, 8) || token?.l || null,
    orders: mine,
    received_at: /^\d{4}-\d{2}-\d{2}$/.test(clean(body.receivedAt, 10)) && !body.notReceived && clean(body.receivedAt, 10) <= new Date(Date.now() + 86400000).toISOString().slice(0, 10) ? clean(body.receivedAt, 10) : null,
    not_received: Boolean(body.notReceived),
    address: {
      address1: clean(body.address?.address1),
      address2: clean(body.address?.address2),
      city: clean(body.address?.city, 120),
      state: clean(body.address?.state, 120),
      zip: clean(body.address?.zip, 40),
      country: clean(body.address?.country, 80),
    },
    description,
    resolution,
    consents: { c1: true, c2: true, c3: true, at: new Date().toISOString() },
    signature_png: signature,
    fill_seconds: Number.isFinite(Number(body.fillSeconds)) ? Math.min(Math.max(Math.round(Number(body.fillSeconds)), 0), 86400) : null,
    ip,
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300) || null,
  });
  if (error) {
    console.error("return_requests insert:", error.message);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, reference });
}
