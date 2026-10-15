import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WhatsappSessionRow } from "@/lib/recovery/types";
import { authorize, dbError, jsonError, nowIso, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Edita a linha da sessão (ativo na rotação, teto diário, rótulo).
const PatchSchema = z.object({
  active: z.boolean().optional(),
  daily_cap: z.number().int().min(0).max(5000).optional(),
  label: z.string().trim().max(120).nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { name } = await params;
  const { data, response: bad } = await parseBody(request, PatchSchema);
  if (bad) return bad;
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  if (data.active !== undefined) patch.active = data.active;
  if (data.daily_cap !== undefined) patch.daily_cap = data.daily_cap;
  if (data.label !== undefined) patch.label = data.label;
  if (Object.keys(patch).length === 1) return jsonError("nada para atualizar", 400);
  const admin = createAdminClient();
  const { data: session, error } = await admin.from("whatsapp_sessions").update(patch).eq("name", name).select("*").maybeSingle();
  if (error) return dbError(error);
  if (!session) return jsonError("sessão não encontrada", 404);
  return NextResponse.json({ ok: true, session: session as WhatsappSessionRow });
}
