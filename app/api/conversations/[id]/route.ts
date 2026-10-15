import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recomputeConversationState } from "@/lib/agent/sync-account";
import { loadCustomerFile } from "@/lib/agent/customer-file";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();

  const { data: conversation, error } = await admin
    .from("conversations")
    .select("*, stores(id, name, auto_send_categories), customers(id, email, shopify_orders, shopify_synced_at)")
    .eq("id", id)
    .single();
  if (error || !conversation) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });

  const customer = conversation.customers as unknown as { id: string; email: string } | null;
  // Mensagens, marcação de lido e dossiê do cliente em paralelo.
  const [{ data: messages }, , file] = await Promise.all([
    admin.from("messages").select("id, direction, from_address, to_address, subject, body, body_raw, body_pt, sent_at, created_at").eq("conversation_id", id),
    conversation.unread ? admin.from("conversations").update({ unread: false }).eq("id", id) : Promise.resolve(null),
    customer?.email ? loadCustomerFile(admin, customer.id, customer.email) : Promise.resolve(null),
  ]);

  const ordered = (messages ?? []).sort((a, b) =>
    ((a.sent_at as string | null) ?? (a.created_at as string)).localeCompare((b.sent_at as string | null) ?? (b.created_at as string))
  );

  // Chat único: mensagens das OUTRAS conversas do mesmo cliente (com as
  // respostas que a loja já deu), pra ler tudo em ordem num lugar só.
  const others = (file?.messages ?? [])
    .filter((m) => m.conversation_id !== id)
    .map((m) => ({ id: m.id, conversation_id: m.conversation_id, direction: m.direction, from_address: m.from_address, to_address: m.to_address, subject: m.subject, body: m.body, body_raw: null, body_pt: m.body_pt, sent_at: m.at, created_at: m.at, other: true }));

  return NextResponse.json({ conversation, messages: ordered, otherMessages: others });
}

// Mudança de estado manual: encerrar, reabrir, marcar spam, marcar não lido.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk && !(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();

  if (body.action === "recompute") {
    const { data: conv } = await admin.from("conversations").select("store_id").eq("id", id).single();
    if (!conv) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });
    await recomputeConversationState(admin, conv.store_id as string, id);
    await admin.from("conversations").update({ analyzed_at: null }).eq("id", id);
    return NextResponse.json({ ok: true });
  }

  const patch: Record<string, unknown> = {};
  if (body.action === "encerrar") Object.assign(patch, { status: "encerrada", closed_at: new Date().toISOString(), unread: false });
  else if (body.action === "reabrir") Object.assign(patch, { status: "aguardando_humano", closed_at: null });
  else if (body.action === "spam") Object.assign(patch, { status: "spam", unread: false });
  else if (body.action === "nao_spam") Object.assign(patch, { status: "aguardando_humano", analyzed_at: null });
  else if (body.action === "nao_lido") Object.assign(patch, { unread: true });
  else if (body.action === "reanalisar") Object.assign(patch, { analyzed_at: null });
  else return NextResponse.json({ error: "ação inválida" }, { status: 400 });

  const { error } = await admin.from("conversations").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
