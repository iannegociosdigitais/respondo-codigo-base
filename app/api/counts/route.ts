import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TODO_TYPES } from "@/lib/ai/promises";

// Contadores do menu: Inbox = conversas aguardando você enviar (usa "pending",
// por status — não "unread", que zera assim que você só abre a conversa,
// mesmo sem mandar nada); Tickets = casos abertos que precisam do dono
// pessoalmente; lacunas = pedidos de contexto da IA.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const admin = createAdminClient();
  const PENDING = ["nova", "reaberta", "aguardando_humano"];
  // Contagem por CLIENTE (não por e-mail): é o que o Inbox "um por cliente" mostra.
  const { data } = await admin
    .from("conversations")
    .select("customer_id, unread, t:analysis->ticket, g:analysis->>missing_context_pt")
    .in("status", PENDING)
    .limit(2000);
  const rows = (data ?? []) as unknown as Array<{ customer_id: string | null; unread: boolean; t: boolean | null; g: string | null }>;
  const distinct = (f: (r: (typeof rows)[number]) => boolean) => new Set(rows.filter(f).map((r) => r.customer_id ?? Math.random().toString())).size;
  const unread = { count: distinct((r) => r.unread) };
  const tickets = { count: distinct((r) => r.t === true) };
  const gaps = { count: distinct((r) => Boolean(r.g)) };
  const pending = { count: distinct(() => true) };
  // Promessas em aberto (em qualquer conversa, inclusive já respondidas).
  const { data: todoRows } = await admin.from("conversations").select("t:analysis->todos").not("analysis->todos", "is", null).limit(1000);
  // Mesmos tipos que a tela "A fazer" (app/api/todos) mostra — fonte única em lib/ai/promises.
  const todos = ((todoRows ?? []) as unknown as Array<{ t: Array<{ done?: boolean }> | null }>).reduce((n, r) => n + (r.t ?? []).filter((x) => !x.done && (TODO_TYPES as readonly string[]).includes((x as { type?: string }).type ?? "")).length, 0);
  // Formulários pendentes de decisão + aprovados que faltam executar (a tabela pode ainda não existir).
  const formsRes = await admin.from("return_requests").select("status, executed_at, resolution").in("status", ["pendente", "aprovado"]);
  const formRows = formsRes.error ? [] : (formsRes.data ?? []);
  const forms = formRows.filter((f) => f.status === "pendente").length;
  const formsToExecute = formRows.filter((f) => f.status === "aprovado" && !f.executed_at).length;
  return NextResponse.json({ unread: unread.count ?? 0, tickets: tickets.count ?? 0, gaps: gaps.count ?? 0, todos: todos + formsToExecute, forms, pending: pending.count ?? 0 });
}
