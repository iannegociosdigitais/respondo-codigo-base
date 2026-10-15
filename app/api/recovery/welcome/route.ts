import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorize, dbError, isUuid, jsonError, loadStoreNames, parseDays } from "@/app/api/recovery/_lib/shared";
import { welcomeTotals } from "@/app/api/recovery/_lib/welcome-stats";

export const maxDuration = 60;

// Pós-compra (boas-vindas): últimos pedidos que entraram na régua e os
// totais do período. ?store= filtra a loja (opcional); ?days= janela (30).

const money = (v: number | string | null | undefined) => (v == null || v === "" ? 0 : Number(v));

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const storeId = url.searchParams.get("store") || null;
  if (storeId && !isUuid(storeId)) return jsonError("store inválida", 400);
  const days = parseDays(url.searchParams.get("days"));
  if (days === null) return jsonError("days inválido: use um número de 1 a 180", 400);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const admin = createAdminClient();

  const [{ totals, runs, error }, storeNames] = await Promise.all([welcomeTotals(admin, { since, storeId }), loadStoreNames(admin)]);
  if (error) return dbError(error);

  const list = runs.slice(0, 200).map((r) => ({
    id: r.id,
    storeId: r.store_id,
    store: storeNames.get(r.store_id) ?? r.store_id,
    orderName: r.order_name,
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
    email: r.email,
    language: r.language,
    country: r.country_code,
    total: money(r.total),
    currency: r.currency,
    purchasedAt: r.purchased_at,
    fulfilledAt: r.fulfilled_at,
    tracking: r.tracking_number,
    status: r.status,
    stopReason: r.stop_reason,
    step: r.step,
    nextAt: r.next_at,
    receiptSent: r.receipt_sent,
  }));

  return NextResponse.json({ days, runs: list, totals });
}
