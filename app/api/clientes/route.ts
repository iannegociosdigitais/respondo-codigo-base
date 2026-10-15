import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NOISE_SENDER as NOISE } from "@/lib/agent/noise";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().toLowerCase();
  const storeId = url.searchParams.get("store");

  const admin = createAdminClient();
  let query = admin.from("customers").select("id, email, name, created_at, shopify_orders, stores(id, name)").order("created_at", { ascending: false }).limit(500);
  if (storeId) query = query.eq("store_id", storeId);
  if (q) query = query.ilike("email", `%${q}%`);
  const { data: customers, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (customers ?? []).map((c) => c.id as string);
  const { data: convs } = await admin
    .from("conversations")
    .select("customer_id, status, category, last_message_at, urgency, analysis")
    .in("customer_id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);

  const agg: Record<string, { total: number; pendentes: number; last: string | null; categorias: string[]; fase: number | null; urgencia: string | null }> = {};
  const urgRank: Record<string, number> = { baixa: 0, normal: 1, alta: 2, urgente: 3 };
  for (const c of convs ?? []) {
    const k = c.customer_id as string;
    agg[k] ??= { total: 0, pendentes: 0, last: null, categorias: [], fase: null, urgencia: null };
    agg[k].total += 1;
    const pending = ["nova", "reaberta", "aguardando_humano"].includes(c.status as string);
    if (pending) {
      agg[k].pendentes += 1;
      const phase = (c.analysis as { phase?: number } | null)?.phase ?? null;
      if (phase && (!agg[k].fase || phase > agg[k].fase!)) agg[k].fase = phase;
      const u = c.urgency as string;
      if (!agg[k].urgencia || (urgRank[u] ?? 0) > (urgRank[agg[k].urgencia!] ?? 0)) agg[k].urgencia = u;
    }
    if (c.category) agg[k].categorias.push(c.category as string);
    const at = c.last_message_at as string | null;
    if (at && (!agg[k].last || at > agg[k].last!)) agg[k].last = at;
  }

  // Só clientes de verdade: remetentes automáticos (Shopify, Stripe, billing,
  // no-reply...) e quem só tem conversas de spam ficam fora do CRM.
  const spamOnly = new Set<string>();
  const byCustomer: Record<string, { total: number; spam: number }> = {};
  for (const c of convs ?? []) {
    const k = c.customer_id as string;
    byCustomer[k] ??= { total: 0, spam: 0 };
    byCustomer[k].total += 1;
    if (c.status === "spam") byCustomer[k].spam += 1;
  }
  for (const [k, v] of Object.entries(byCustomer)) if (v.total > 0 && v.spam === v.total) spamOnly.add(k);

  const result = (customers ?? [])
    .filter((c) => !NOISE.test(c.email as string) && !spamOnly.has(c.id as string))
    .map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      store: (c.stores as unknown as { name: string } | null)?.name ?? null,
      pedidos: Array.isArray(c.shopify_orders) ? (c.shopify_orders as unknown[]).length : 0,
      totalConversas: agg[c.id as string]?.total ?? 0,
      pendentes: agg[c.id as string]?.pendentes ?? 0,
      fase: agg[c.id as string]?.fase ?? null,
      urgencia: agg[c.id as string]?.urgencia ?? null,
      ultimoContato: agg[c.id as string]?.last ?? null,
      categorias: [...new Set(agg[c.id as string]?.categorias ?? [])],
    }))
    // Mais urgente primeiro: urgência da pendência, depois quantidade de
    // pendências, depois contato mais recente.
    .sort((a, b) => {
      const ua = urgRank[a.urgencia ?? ""] ?? -1;
      const ub = urgRank[b.urgencia ?? ""] ?? -1;
      if (ub !== ua) return ub - ua;
      if (b.pendentes !== a.pendentes) return b.pendentes - a.pendentes;
      return (b.ultimoContato ?? "").localeCompare(a.ultimoContato ?? "");
    });

  return NextResponse.json({ customers: result });
}
