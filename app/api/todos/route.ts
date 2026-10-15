import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TODO_TYPES } from "@/lib/ai/promises";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Fonte única dos tipos (a mesma do contador do menu em app/api/counts).
const KEEP: readonly string[] = TODO_TYPES;

interface Todo { type: string; text: string; created_at: string; done: boolean; done_at?: string | null }

// "A fazer": o que foi prometido ao cliente nos e-mails enviados e ainda não
// foi marcado como feito (cancelar assinatura, regularização, reenvio…).
export async function GET(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const all = new URL(request.url).searchParams.get("all");
  const admin = createAdminClient();
  const { data } = await admin
    .from("conversations")
    .select("id, subject, last_message_at, todos:analysis->todos, stores(name), customers(id, email, name)")
    .not("analysis->todos", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(500);
  const items: Array<Todo & { conversationId: string; index: number; formId?: string; subject: string | null; store: string | null; customer: { id: string; email: string; name: string | null } | null }> = [];
  for (const c of (data ?? []) as unknown as Array<{ id: string; subject: string | null; todos: Todo[] | null; stores: { name: string } | null; customers: { id: string; email: string; name: string | null } | null }>) {
    (c.todos ?? []).forEach((t, index) => {
      if (!KEEP.includes(t.type)) return;
      if (all || !t.done) items.push({ conversationId: c.id, index, ...t, subject: c.subject, store: c.stores?.name ?? null, customer: c.customers });
    });
  }
  // Formulários aprovados: executar o reenvio ou o dinheiro de volta.
  const forms = await admin.from("return_requests").select("id, reference, resolution, customer_email, customer_name, product_name, orders, decided_at, executed_at, conversation_id").eq("status", "aprovado").limit(300);
  for (const f of forms.error ? [] : forms.data ?? []) {
    const done = Boolean(f.executed_at);
    if (!all && done) continue;
    const orderNames = ((f.orders as Array<{ name: string; total: string | null; currency: string | null; totalLabel?: string }> | null) ?? []).map((o) => `${o.name} (${o.totalLabel ?? `${o.currency ?? ""} ${o.total ?? ""}`})`).join(", ");
    items.push({
      conversationId: (f.conversation_id as string | null) ?? "",
      index: -1,
      formId: f.id as string,
      type: f.resolution === "reenvio" ? "reenvio_formulario" : "regularizacao_financeira",
      text: `Formulário #${f.reference} aprovado: ${f.resolution === "reenvio" ? "reenviar" : "reembolsar"} ${orderNames}`,
      created_at: (f.decided_at as string | null) ?? new Date().toISOString(),
      done,
      done_at: (f.executed_at as string | null) ?? null,
      subject: null,
      store: (f.product_name as string | null) ?? null,
      customer: { id: "", email: f.customer_email as string, name: (f.customer_name as string | null) ?? null },
    });
  }
  items.sort((a, b) => Number(a.done) - Number(b.done) || a.created_at.localeCompare(b.created_at));
  return NextResponse.json({ todos: items, open: items.filter((t) => !t.done).length });
}

// Marca como feito / desfaz.
export async function PATCH(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();
  if (body.formId) {
    const { error: formErr } = await admin.from("return_requests").update({ executed_at: body.done === false ? null : new Date().toISOString() }).eq("id", body.formId);
    if (formErr) return NextResponse.json({ error: formErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  const { data: conv } = await admin.from("conversations").select("analysis").eq("id", body.conversationId).single();
  if (!conv) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });
  const analysis = (conv.analysis ?? {}) as Record<string, unknown>;
  const todos = (Array.isArray(analysis.todos) ? analysis.todos : []) as Todo[];
  const t = todos[Number(body.index)];
  if (!t) return NextResponse.json({ error: "item não encontrado" }, { status: 404 });
  t.done = body.done !== false;
  t.done_at = t.done ? new Date().toISOString() : null;
  const { error } = await admin.from("conversations").update({ analysis: { ...analysis, todos } }).eq("id", body.conversationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
