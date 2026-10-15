import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendConversationDraft } from "@/lib/agent/send-draft";

export const maxDuration = 120;

// Envia a resposta escrita/aprovada no Inbox. Você escreve em PT-BR; aqui
// traduz pro idioma do cliente, envia na mesma thread, fecha o ticket e,
// se você mudou o rascunho da IA, extrai a regra por trás da edição.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();
  const result = await sendConversationDraft(admin, id, {
    replyPt: typeof body.replyPt === "string" ? body.replyPt : "",
    replyOriginal: typeof body.replyOriginal === "string" ? body.replyOriginal : "",
    force: Boolean(body.force),
    forceBrand: Boolean(body.forceBrand),
    closeOthers: Boolean(body.closeOthers),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json({ ok: true, ...rest });
}
