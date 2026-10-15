import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadBrands, routeStore } from "@/lib/agent/brands";

export const maxDuration = 300;

// Reaplica o roteamento de marca nas conversas existentes (depois de
// criar lojas e aliases): destinatários reais quando existem, senão
// hebraico no assunto/mensagens. Só muda store_id; nada mais.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }
  const admin = createAdminClient();
  const brands = await loadBrands(admin);

  const { data: accounts } = await admin.from("store_email_accounts").select("store_id, email_address");
  const defaultByAddress = new Map((accounts ?? []).map((a) => [(a.email_address as string).toLowerCase(), a.store_id as string]));

  const { data: convs } = await admin.from("conversations").select("id, store_id, subject, customers(email)").range(0, 4999);
  let moved = 0;
  for (const c of convs ?? []) {
    const columns = "direction, to_address, subject, body" + (brands.enabled ? ", to_addresses" : "");
    const res = (await admin.from("messages").select(columns).eq("conversation_id", c.id).limit(20)) as unknown as { data: Array<Record<string, unknown>> | null };
    const msgs = res.data ?? [];
    const inbound = msgs.filter((m) => m.direction === "inbound");
    const receiving = ((inbound[0]?.to_address as string | null) ?? "").toLowerCase();
    const defaultStore = defaultByAddress.get(receiving) ?? (c.store_id as string);
    const recipients = inbound.flatMap((m) => (m.to_addresses as string[] | null) ?? []);
    const texts = [c.subject as string | null, ...msgs.flatMap((m) => [m.subject as string | null, m.body as string | null])];
    const customerEmail = (c.customers as unknown as { email: string } | null)?.email ?? null;
    const target = routeStore(brands, defaultStore, recipients, texts, customerEmail);
    if (target !== c.store_id) {
      await admin.from("conversations").update({ store_id: target }).eq("id", c.id);
      moved += 1;
    }
  }
  return NextResponse.json({ enabled: brands.enabled, conversations: convs?.length ?? 0, moved });
}
