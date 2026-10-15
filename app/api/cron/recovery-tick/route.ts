import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecoveryTick } from "@/lib/recovery/engine";
import { retryPendingReplies, runAgentNudges } from "@/lib/recovery/agent";

// 120 s: a resposta atrasada (conversa que esperou o modelo voltar) chama a
// Shopify e o modelo depois do tick; com 60 s a função podia morrer no meio.
export const maxDuration = 120;

// Tick da régua de recuperação de carrinho. Chamado a cada 1 minuto pelo
// pg_cron do Supabase (o Ian instala) com "Authorization: Bearer CRON_SECRET".
// Também dá pra rodar à mão:
//   POST /api/cron/recovery-tick
//   POST /api/cron/recovery-tick?store=<id>
// Tudo que sai (ou não sai) está em recovery_events; a resposta é um resumo.
export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const onlyStoreId = url.searchParams.get("store");
  try {
    const started = Date.now();
    const admin = createAdminClient();
    const result = await runRecoveryTick(admin, { deadline: started + 50_000, onlyStoreId });
    // Retomada do agente no WhatsApp com o tempo que sobrar (cada uma chama o modelo).
    let nudges: Awaited<ReturnType<typeof runAgentNudges>> | null = null;
    if (!onlyStoreId && Date.now() - started < 35_000) {
      try {
        nudges = await runAgentNudges(admin, { deadline: started + 50_000, max: 2 });
      } catch (err) {
        nudges = { sent: 0, skipped: 0, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    // Conversas que ficaram sem resposta com o modelo fora (uma por tick).
    let pending: Awaited<ReturnType<typeof retryPendingReplies>> | null = null;
    if (!onlyStoreId && Date.now() - started < 30_000) {
      try {
        pending = await retryPendingReplies(admin, { deadline: started + 55_000, max: 1 });
      } catch (err) {
        pending = { sent: 0, waiting: 0, cleared: 0, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    return NextResponse.json({ ...result, nudges, pending }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
