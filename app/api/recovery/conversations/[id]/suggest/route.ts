import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAgentReplyPreview } from "@/lib/recovery/agent";
import { authorize, dbError, errMessage, isUuid, jsonError } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Botão "Sugerir resposta": o agente vendedor escreve a resposta que daria,
// sem enviar. O painel preenche o composer com reply_pt.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const admin = createAdminClient();
  const { data: rec, error } = await admin.from("cart_recoveries").select("id").eq("id", id).maybeSingle();
  if (error) return dbError(error);
  if (!rec) return jsonError("conversa não encontrada", 404);
  try {
    const d = await generateAgentReplyPreview(admin, id);
    return NextResponse.json({ reply: d.reply, reply_pt: d.reply_pt, action: d.action, discount_percent: d.discount_percent ?? null, handoff_reason: d.handoff_reason ?? null, summary_pt: d.summary_pt, language: d.language });
  } catch (err) {
    return jsonError(`não consegui gerar a sugestão: ${errMessage(err)}`, 502);
  }
}
