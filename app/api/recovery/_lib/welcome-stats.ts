import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostPurchaseRun } from "@/lib/recovery/types";

// Totais do pós-compra (boas-vindas) num período: runs por status e quantos
// receberam / abriram / clicaram (eventos por run_id, sem os de teste).
// Usado pelo GET /api/recovery/welcome e pelo card do painel.

export interface WelcomeTotals { runs: number; active: number; done: number; stopped: number; sent: number; opened: number; clicked: number }

export const emptyWelcomeTotals = (): WelcomeTotals => ({ runs: 0, active: 0, done: 0, stopped: 0, sent: 0, opened: 0, clicked: 0 });

export async function welcomeTotals(admin: SupabaseClient, input: { since: string; storeId?: string | null }): Promise<{ totals: WelcomeTotals; runs: PostPurchaseRun[]; error: { message: string } | null }> {
  let runsQuery = admin.from("post_purchase_runs").select("*").gte("purchased_at", input.since).order("purchased_at", { ascending: false }).limit(2000);
  if (input.storeId) runsQuery = runsQuery.eq("store_id", input.storeId);
  const runsRes = await runsQuery;
  if (runsRes.error) return { totals: emptyWelcomeTotals(), runs: [], error: runsRes.error };
  const runs = (runsRes.data ?? []) as PostPurchaseRun[];

  let evQuery = admin.from("recovery_events").select("run_id, type, is_test").not("run_id", "is", null).gte("created_at", input.since).limit(20000);
  if (input.storeId) evQuery = evQuery.eq("store_id", input.storeId);
  const evRes = await evQuery;
  if (evRes.error) return { totals: emptyWelcomeTotals(), runs: [], error: evRes.error };

  const sent = new Set<string>();
  const opened = new Set<string>();
  const clicked = new Set<string>();
  for (const e of (evRes.data ?? []) as Array<{ run_id: string | null; type: string; is_test: boolean }>) {
    if (!e.run_id || e.is_test) continue;
    if (e.type === "sent") sent.add(e.run_id);
    else if (e.type === "opened" || e.type === "read") opened.add(e.run_id);
    else if (e.type === "clicked") clicked.add(e.run_id);
  }
  const totals: WelcomeTotals = {
    runs: runs.length,
    active: runs.filter((r) => r.status === "ativo" || r.status === "pausado").length,
    done: runs.filter((r) => r.status === "concluido").length,
    stopped: runs.filter((r) => r.status.startsWith("parado_")).length,
    sent: sent.size,
    opened: opened.size,
    clicked: clicked.size,
  };
  return { totals, runs, error: null };
}
