import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { accumulateUsage, buildDecision, carryOver, enforceNoTracking } from "@/lib/agent/analyze";
import { trackUsage } from "@/lib/ai/usage";
import { looksUntranslated, translateReplyForCustomer, translateToPortuguese } from "@/lib/ai/translate-reply";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { normalizeLanguage, LANG_LABEL } from "@/lib/ai/lang";

export const maxDuration = 120;

// "Gerar resposta": novo rascunho com uma instrução sua ("mais curto",
// "oferece reenvio", "explica que o correio francês está em greve").
// Atualiza o rascunho da conversa, não muda status nem envia.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const contextIds: string[] = Array.isArray(body.contextIds) ? body.contextIds.filter((x: unknown) => typeof x === "string") : [];
  const currentDraft = typeof body.currentDraft === "string" ? body.currentDraft.trim() : "";
  const improve = Boolean(body.improve) && currentDraft.length > 0;

  const admin = createAdminClient();
  const { data: conv } = await admin.from("conversations").select("*, customers(email)").eq("id", id).single();
  if (!conv) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });
  const customerEmail = (conv.customers as unknown as { email: string } | null)?.email;
  if (!customerEmail) return NextResponse.json({ error: "cliente sem e-mail" }, { status: 400 });

  const { data: store } = await admin.from("stores").select("*").eq("id", conv.store_id).single();
  if (!store) return NextResponse.json({ error: "loja não encontrada" }, { status: 404 });

  // Contexto base escolhido no Inbox: entra como regra prioritária desta
  // resposta ("melhora tal resposta a partir de tal contexto").
  let baseContexts = "";
  if (contextIds.length > 0) {
    const { data: ctxRows } = await admin.from("store_contexts").select("label, content").in("id", contextIds);
    baseContexts = (ctxRows ?? []).map((c) => `• ${c.label}: ${c.content}`).join("\n");
  }
  const lang = normalizeLanguage(conv.language);
  const langLabel = lang ? (LANG_LABEL[lang] ?? lang) : null;
  const composed = [
    instruction ? `Instrução: ${instruction}` : "",
    baseContexts ? `Use como BASE OBRIGATÓRIA desta resposta estes contextos (têm prioridade sobre os demais):\n${baseContexts}` : "",
    improve ? `Parta deste texto e melhore-o conforme a instrução e o contexto base (mantenha o que está certo, corrija o resto):\n---\n${currentDraft}\n---` : "",
    langLabel ? `draft_reply OBRIGATORIAMENTE em ${langLabel} (idioma do cliente), com nome e assinatura nesse idioma; draft_reply_pt em português do Brasil.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { result: built, usage } = await trackUsage(() =>
      buildDecision(
      admin,
        store as any,
        { id: conv.id, customer_id: conv.customer_id, subject: conv.subject, product_id: (conv as { product_id?: string | null }).product_id ?? null, language: conv.language ?? null },
        customerEmail,
        composed || null
      )
    );
    const { decision, orders, phase, file } = built;
    const usageTotal = await accumulateUsage(admin, id, usage);
    enforceNoTracking(decision, orders);
    if (portugueseLeak(decision.draft_reply, decision.language).length > 0 && decision.draft_reply_pt.trim()) decision.draft_reply = await translateReplyForCustomer(decision.draft_reply_pt, decision.language);
    // draft_reply_pt tem que ser SEMPRE português puro — às vezes o modelo
    // mistura o idioma do cliente (ou um terceiro idioma) nesse campo.
    if (decision.draft_reply.trim() && looksUntranslated(decision.draft_reply, decision.draft_reply_pt)) {
      decision.draft_reply_pt = await translateToPortuguese(decision.draft_reply, decision.language);
    }
    await admin
      .from("conversations")
      .update({
        draft_reply: decision.draft_reply,
        draft_reply_pt: decision.draft_reply_pt,
        shopify_order: orders[0] ?? null,
        analysis: {
          phase,
          intent_pt: decision.intent_pt,
          tone_pt: decision.tone_pt,
          promises_made_pt: decision.promises_made_pt,
          order_situation_pt: decision.order_situation_pt,
          needs_human: decision.needs_human,
          human_reason: decision.human_reason,
          forced_escalation: decision.forced_escalation,
          ...file,
          usage,
          usage_total: usageTotal,
          ...(await carryOver(admin, id)),
        },
        category: decision.category,
        language: normalizeLanguage(decision.language),
        analyzed_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json({ draft_reply: decision.draft_reply, draft_reply_pt: decision.draft_reply_pt, analysis: { ...decision, phase, ...file, usage, usage_total: usageTotal } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
