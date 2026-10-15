import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorize, dbError, errMessage, isUuid, jsonError } from "@/app/api/recovery/_lib/shared";
import { deliverabilityReport } from "@/lib/email/deliverability";

export const maxDuration = 60;

// GET /api/recovery/deliverability?days=30&store=<uuid>&dns=1
// Relatório da aba Entregabilidade: taxas por dia/provedor/domínio do
// destinatário, DNS dos remetentes, rampa de aquecimento, saúde (bounce e
// reclamação em 24 h) e status da conta no Amazon SES. `dns=1` ignora o cache
// de 10 min do DNS (botão "Checar DNS agora").
export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const sp = new URL(request.url).searchParams;
  const rawDays = Number(sp.get("days") ?? 30);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 180) : 30;
  const store = sp.get("store");
  if (store && !isUuid(store)) return jsonError("store inválido (uuid)", 400);
  const forceDns = sp.get("dns") === "1";
  const admin = createAdminClient();
  try {
    const report = await deliverabilityReport(admin, { days, storeId: store || null, forceDns });
    return NextResponse.json(report);
  } catch (e) {
    return dbError({ message: errMessage(e) });
  }
}
