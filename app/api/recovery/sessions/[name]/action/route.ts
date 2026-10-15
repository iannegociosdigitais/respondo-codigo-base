import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureSession, getSession, logoutSession, restartSession, stopSession, wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, errMessage, jsonError, nowIso, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Iniciar / parar / reiniciar / sair da sessão no WAHA e gravar o status.
const BodySchema = z.object({ action: z.enum(["start", "stop", "restart", "logout"]) });

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { name } = await params;
  const { data, response: bad } = await parseBody(request, BodySchema);
  if (bad) return bad;
  if (!wahaConfigured()) return jsonError("WAHA não configurado.", 503);
  try {
    if (data.action === "start") await ensureSession(name);
    else if (data.action === "stop") await stopSession(name);
    else if (data.action === "restart") await restartSession(name);
    else await logoutSession(name);
  } catch (err) {
    return jsonError(`WAHA recusou a ação ${data.action}: ${errMessage(err)}`, 502);
  }
  const live = await getSession(name).catch(() => null);
  const status = live?.status ?? (data.action === "stop" ? "STOPPED" : "UNKNOWN");
  const admin = createAdminClient();
  await admin.from("whatsapp_sessions").update({ status, me_id: live?.me?.id ?? null, me_name: live?.me?.pushName ?? null, last_event_at: nowIso(), updated_at: nowIso() }).eq("name", name);
  return NextResponse.json({ ok: true, status });
}
