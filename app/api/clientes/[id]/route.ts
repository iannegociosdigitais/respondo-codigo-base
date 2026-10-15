import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchOrdersForCustomer, loadAllShopifyCreds } from "@/lib/agent/analyze";
import { resolveShopify } from "@/lib/shopify/token";

// Ficha do cliente: todas as conversas, pedidos da Shopify (cache de 1h)
// e o que já foi prometido.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const admin = createAdminClient();
  const { data: customer } = await admin.from("customers").select("*, stores(id, name)").eq("id", id).single();
  if (!customer) return NextResponse.json({ error: "cliente não encontrado" }, { status: 404 });

  const { data: conversations } = await admin
    .from("conversations")
    .select("id, subject, category, urgency, status, language, last_message_at, analysis, draft_reply_pt")
    .eq("customer_id", id)
    .order("last_message_at", { ascending: false });

  let orders = Array.isArray(customer.shopify_orders) ? customer.shopify_orders : [];
  const stale = !customer.shopify_synced_at || Date.now() - new Date(customer.shopify_synced_at as string).getTime() > 60 * 60 * 1000;
  if (stale) {
    const creds = await loadAllShopifyCreds(admin, customer.store_id as string);
    if (creds.length > 0) {
      const r = await fetchOrdersForCustomer(admin, creds, id, customer.email as string, "");
      if (!r.error) orders = r.orders;
    }
  }

  const promessas = (conversations ?? [])
    .map((c) => (c.analysis as { promises_made_pt?: string | null } | null)?.promises_made_pt)
    .filter((p): p is string => Boolean(p));

  return NextResponse.json({ customer, conversations: conversations ?? [], orders, promessas });
}
