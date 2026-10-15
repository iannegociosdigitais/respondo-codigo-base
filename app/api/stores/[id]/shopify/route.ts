import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { verifyShopifyConnection, getRecentOrdersByEmail } from "@/lib/shopify/orders";
import { exchangeClientCredentials, resolveShopify } from "@/lib/shopify/token";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();
  const { data } = await admin.from("store_shopify_credentials").select("shop_domain, connected_at, client_id").eq("store_id", id).maybeSingle();
  return NextResponse.json({ shopify: data ?? null });
}

// Conecta a Shopify via token de Admin API de um custom app. Valida
// chamando a loja antes de guardar — token errado não entra no banco.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const shopDomain = String(body.shopDomain ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  let accessToken = String(body.accessToken ?? "").trim();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = String(body.clientSecret ?? "").trim();
  if (!shopDomain.endsWith(".myshopify.com")) {
    return NextResponse.json({ error: "Use o domínio xxx.myshopify.com" }, { status: 400 });
  }
  if (!accessToken && !(clientId && clientSecret)) {
    return NextResponse.json({ error: "Informe um token shpat_ OU Client ID + Client secret" }, { status: 400 });
  }

  let check;
  try {
    if (!accessToken) accessToken = await exchangeClientCredentials(shopDomain, clientId, clientSecret);
    check = await verifyShopifyConnection(shopDomain, accessToken);
  } catch (err) {
    return NextResponse.json({ error: `Shopify recusou: ${(err as Error).message}` }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("store_shopify_credentials").upsert({
    store_id: id,
    shop_domain: shopDomain,
    client_id: clientId || null,
    client_secret_encrypted: clientSecret ? encrypt(clientSecret) : null,
    access_token_encrypted: encrypt(accessToken),
    scopes: ["read_orders", "read_all_orders", "read_customers", "read_fulfillments", "read_products"],
    connected_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, shopName: check.shopName, ordersVisible: check.ordersVisible });
}

// "Testar com um e-mail de cliente": prova que a integração puxa pedido
// real, sem passar pelo agente.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "informe um e-mail" }, { status: 400 });

  const admin = createAdminClient();
  const creds = await resolveShopify(admin, id).catch((e: Error) => ({ error: e.message }));
  if (!creds || "error" in creds) return NextResponse.json({ error: creds && "error" in creds ? creds.error : "Shopify não conectada" }, { status: 400 });

  try {
    const orders = await getRecentOrdersByEmail(creds, email, 5);
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();
  await admin.from("store_shopify_credentials").delete().eq("store_id", id);
  return NextResponse.json({ ok: true });
}
