import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendConversationDraft } from "@/lib/agent/send-draft";

export const maxDuration = 280;

// Envio em massa: manda o rascunho JÁ PRONTO de várias conversas de uma vez
// (sem abrir uma por uma). Cada rascunho vai exatamente como está — pra editar
// antes de enviar, abra a conversa e use o botão normal. Pula sozinho (sem
// travar as outras) qualquer conversa sem rascunho, já respondida ou com
// mistura de marca — o motivo de cada uma que não foi vem na resposta.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? [...new Set<string>(body.ids.filter((x: unknown): x is string => typeof x === "string"))] : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids vazio" }, { status: 400 });
  if (ids.length > 200) return NextResponse.json({ error: "no máximo 200 por vez" }, { status: 400 });

  const admin = createAdminClient();
  const { data: convs } = await admin.from("conversations").select("id, draft_reply_pt, customer_id, last_message_at").in("id", ids);
  const draftById = new Map((convs ?? []).map((c) => [c.id as string, (c.draft_reply_pt as string | null) ?? ""]));

  const sent: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  // Um e-mail por cliente: se duas conversas do MESMO cliente estão na
  // seleção, só a mais recente sai (ela cobre tudo e encerra as outras ao
  // enviar). Sem isso, as duas saíam em paralelo e o cliente recebia a mesma
  // resposta duas vezes (visto em 13/10).
  const newestByCustomer = new Map<string, { id: string; at: string }>();
  for (const c of convs ?? []) {
    const cust = c.customer_id as string | null;
    if (!cust) continue;
    const at = (c.last_message_at as string | null) ?? "";
    const cur = newestByCustomer.get(cust);
    if (!cur || at > cur.at) newestByCustomer.set(cust, { id: c.id as string, at });
  }
  const dupes = new Set((convs ?? []).filter((c) => c.customer_id && newestByCustomer.get(c.customer_id as string)?.id !== c.id).map((c) => c.id as string));
  for (const id of dupes) failed.push({ id, error: "mesmo cliente: respondido pela conversa mais recente dele" });
  const CONCURRENCY = 4;
  const queue = ids.filter((id) => !dupes.has(id));
  async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const replyPt = draftById.get(id) ?? "";
      if (!replyPt.trim()) { failed.push({ id, error: "sem rascunho pronto" }); continue; }
      // closeOthers: igual ao envio único do Inbox "um por cliente" — uma
      // resposta cobre tudo, as outras pendências do mesmo cliente encerram.
      const result = await sendConversationDraft(admin, id, { replyPt, skipLearning: true, closeOthers: true });
      if (result.ok) sent.push(id);
      else failed.push({ id, error: result.error });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));

  return NextResponse.json({ ok: true, sentCount: sent.length, sent, failed });
}
