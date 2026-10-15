import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftChargebackOutreach, upsertChargeback } from "@/lib/agent/chargeback";
import type { ChargebackOrder } from "@/lib/agent/chargeback-types";

export const maxDuration = 300;

// Carga de contestações já abertas (levantadas dos avisos nas caixas): um
// registro por cliente + rascunho do 1º e-mail. Nada é enviado.
// Corpo: { customers: [{ email, storeId, firstName?, language?, alreadySentAt?, orders: [...] }] }
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { customers?: Array<{ email: string; storeId: string; firstName?: string | null; language?: string | null; alreadySentAt?: string | null; orders: ChargebackOrder[] }> };
  const admin = createAdminClient();
  const stop = Date.now() + 270_000;
  const out = [];
  for (const c of body.customers ?? []) {
    if (Date.now() > stop) { out.push({ email: c.email, skipped: "tempo" }); continue; }
    try {
      const { conversationId, needsDraft } = await upsertChargeback(admin, { ...c, source: "levantamento dos avisos" });
      if (needsDraft) await draftChargebackOutreach(admin, conversationId);
      out.push({ email: c.email, conversationId, drafted: needsDraft });
    } catch (err) {
      out.push({ email: c.email, error: (err as Error).message.slice(0, 200) });
    }
  }
  return NextResponse.json({ results: out });
}
