import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Reprocessar histórico: apaga conversas/mensagens/análises da loja
// (o que a IA gerou, não os e-mails — esses continuam na caixa) e zera os
// ponteiros de importação. O próximo ciclo reimporta INBOX + Enviados dos
// últimos 90 dias com o pipeline novo. Clientes e contexto ficam.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== "REPROCESSAR") {
    return NextResponse.json({ error: "confirmação ausente" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: convs } = await admin.from("conversations").select("id").eq("store_id", id);
  const ids = (convs ?? []).map((c) => c.id as string);

  if (ids.length > 0) {
    await admin.from("learned_responses").update({ source_conversation_id: null }).in("source_conversation_id", ids);
    const { error } = await admin.from("conversations").delete().in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  await admin.from("usage_logs").delete().eq("store_id", id);
  await admin.from("store_email_accounts").update({ last_uid: 0, sent_last_uid: 0, last_error: null }).eq("store_id", id);

  return NextResponse.json({ ok: true, removed: ids.length });
}
