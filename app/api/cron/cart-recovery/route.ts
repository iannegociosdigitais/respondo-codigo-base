import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAbandonedCheckouts } from "@/lib/recovery/sync";

export const maxDuration = 300;

// Sincroniza os checkouts abandonados (fase 1: só medir, nada é enviado).
// Também roda dentro do poll-inboxes a cada 10 min; esta rota serve pro
// backfill e pra rodar à mão:
//   POST /api/cron/cart-recovery?hours=720   (últimos 30 dias)
//   POST /api/cron/cart-recovery?store=<id>
export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  // Sem CRON_SECRET configurado, nada passa (senão "Bearer undefined" autenticaria).
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const hours = url.searchParams.get("hours") ? Math.min(Number(url.searchParams.get("hours")), 24 * 90) : undefined;
  const onlyStoreId = url.searchParams.get("store");
  try {
    const result = await syncAbandonedCheckouts(createAdminClient(), { hours, onlyStoreId, deadline: Date.now() + 240_000 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
