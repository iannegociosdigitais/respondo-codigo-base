import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { listOpenAlerts, resolveAlert } from "@/lib/recovery/alerts";
import type { RecoveryAlert } from "@/lib/recovery/types";
import { authorize, dbError, errMessage, isMissingTable, isUuid, jsonError, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Alertas operacionais (número de WhatsApp caiu, WAHA fora do ar, muitas
// falhas de envio, cliente precisa de humano). GET: abertos primeiro, depois
// os últimos resolvidos. POST { id, resolve: true }: marca como resolvido.

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const admin = createAdminClient();
  let open: RecoveryAlert[] = [];
  try {
    open = await listOpenAlerts(admin);
  } catch (err) {
    const message = errMessage(err);
    if (isMissingTable({ message })) return dbError({ message });
    return jsonError(`não consegui listar os alertas: ${message}`, 500);
  }
  const resolved = await admin.from("recovery_alerts").select("*").not("resolved_at", "is", null).order("resolved_at", { ascending: false }).limit(30);
  if (resolved.error) return dbError(resolved.error);
  const openSorted = [...open].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return NextResponse.json({ alerts: [...openSorted, ...((resolved.data ?? []) as RecoveryAlert[])], open: openSorted.length });
}

const PostSchema = z.object({ id: z.string().min(1), resolve: z.literal(true) });

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response } = await parseBody(request, PostSchema);
  if (response) return response;
  if (!isUuid(data.id)) return jsonError("id inválido", 400);
  const admin = createAdminClient();
  try {
    const done = await resolveAlert(admin, data.id);
    if (!done) return jsonError("alerta não encontrado ou já resolvido", 404);
  } catch (err) {
    const message = errMessage(err);
    if (isMissingTable({ message })) return dbError({ message });
    return jsonError(`não consegui resolver o alerta: ${message}`, 500);
  }
  const { data: alert, error } = await admin.from("recovery_alerts").select("*").eq("id", data.id).maybeSingle();
  if (error) return dbError(error);
  if (!alert) return jsonError("alerta não encontrado", 404);
  return NextResponse.json({ ok: true, alert: alert as RecoveryAlert });
}
