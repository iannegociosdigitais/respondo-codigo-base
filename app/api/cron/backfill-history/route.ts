import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadBrands } from "@/lib/agent/brands";
import { backfillCustomerHistory, type EmailAccountRow } from "@/lib/agent/sync-account";

export const maxDuration = 300;

// Importa o histórico COMPLETO (sem limite de data) dos clientes com
// pendência: o que eles mandaram e o que a loja já respondeu antes da janela
// de importação. Quem ganhou mensagens novas volta pra fila de análise.
// ?offset=N&limit=40 pra rodar em lotes; ?email=x pra um cliente só.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 80);
  const only = url.searchParams.get("email");
  const requeue = url.searchParams.get("requeue") !== "0";

  const admin = createAdminClient();
  const brands = await loadBrands(admin);
  const { data: accounts } = await admin.from("store_email_accounts").select("*").not("connected_at", "is", null);
  const results = [];

  for (const account of (accounts ?? []) as EmailAccountRow[]) {
    const { data: pend } = await admin
      .from("conversations")
      .select("customers(email), messages!inner(to_address)")
      .in("status", ["nova", "reaberta", "aguardando_humano"])
      .eq("messages.to_address", account.email_address.toLowerCase())
      .limit(1000);
    const emails = [...new Set((pend ?? []).map((c) => ((c.customers as unknown as { email: string } | null)?.email ?? "").toLowerCase()).filter(Boolean))].sort();
    const slice = only ? emails.filter((e) => e === only.toLowerCase()) : emails.slice(offset, offset + limit);
    if (slice.length === 0) {
      results.push({ account: account.email_address, total: emails.length, processed: 0 });
      continue;
    }
    try {
      const r = await backfillCustomerHistory(admin, account, (account as unknown as { store_id: string }).store_id, slice, brands);
      let requeued = 0;
      if (requeue && r.changed.length > 0) {
        for (const email of r.changed) {
          const { data: custs } = await admin.from("customers").select("id").ilike("email", email);
          const ids = (custs ?? []).map((c) => c.id as string);
          if (ids.length === 0) continue;
          const { data: upd } = await admin.from("conversations").update({ analyzed_at: null }).in("customer_id", ids).in("status", ["nova", "reaberta", "aguardando_humano"]).select("id");
          requeued += upd?.length ?? 0;
        }
      }
      results.push({ account: account.email_address, total: emails.length, processed: slice.length, inbound: r.inbound, sent: r.sent, changedCustomers: r.changed.length, requeued });
    } catch (err) {
      results.push({ account: account.email_address, error: (err as Error).message.slice(0, 200) });
    }
  }
  return NextResponse.json({ offset, limit, results });
}
