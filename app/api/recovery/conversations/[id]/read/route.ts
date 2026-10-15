import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorize, dbError, isUuid, jsonError, nowIso } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Abriu a conversa no painel: zera a bolinha de não lidas.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const admin = createAdminClient();
  const { data, error } = await admin.from("cart_recoveries").update({ unread_count: 0, updated_at: nowIso() }).eq("id", id).select("id").maybeSingle();
  if (error) return dbError(error);
  if (!data) return jsonError("conversa não encontrada", 404);
  return NextResponse.json({ ok: true });
}
