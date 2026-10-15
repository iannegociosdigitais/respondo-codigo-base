import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reviseDraft } from "@/lib/ai/revise";
import { addUsage, trackUsage } from "@/lib/ai/usage";
import { isPortuguese, looksUntranslated, translateToPortuguese } from "@/lib/ai/translate-reply";

export const maxDuration = 300;

// Aplica regras novas de redação nos rascunhos pendentes SEM regerar tudo.
// Marca cada conversa com analysis.revised_at pra não revisar duas vezes.
// ?tag=v2 muda a marca quando houver uma nova rodada de regras.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag") ?? "v1";
  const only = url.searchParams.get("id");
  // Corpo opcional: { match: "regex", rules: ["regra extra"] } — revisa só os
  // rascunhos que casam com o regex, aplicando também as regras extras.
  const body = (await request.json().catch(() => ({}))) as { match?: string; rules?: string[]; ids?: string[]; withCustomer?: boolean };
  const matcher = body.match ? new RegExp(body.match, "i") : null;
  const admin = createAdminClient();
  let q = admin
    .from("conversations")
    .select("id, language, draft_reply, draft_reply_pt, analysis")
    .in("status", ["nova", "reaberta", "aguardando_humano"])
    .not("draft_reply", "is", null)
    .neq("draft_reply", "")
    .limit(400);
  if (only) q = q.eq("id", only);
  if (Array.isArray(body.ids) && body.ids.length > 0) q = q.in("id", body.ids);
  const { data } = await q;
  const todo = (data ?? []).filter((c) => (c.analysis as { revised?: string } | null)?.revised !== tag && (!matcher || matcher.test(`${c.draft_reply as string}\n${(c.draft_reply_pt as string | null) ?? ""}`)));

  if (url.searchParams.get("dry") === "1") return NextResponse.json({ would: todo.length, ids: todo.map((c) => c.id) });

  const stop = Date.now() + 240_000;
  const queue = [...todo];
  let revised = 0, changed = 0, errors = 0, cost = 0;
  async function worker() {
    for (let c = queue.shift(); c && Date.now() < stop; c = queue.shift()) {
      try {
        const { result, usage } = await trackUsage(async () => {
          let customerMessages: string | undefined;
          if (body.withCustomer) {
            const { data: inb } = await admin.from("messages").select("body, sent_at").eq("conversation_id", c.id as string).eq("direction", "inbound").order("sent_at", { ascending: false }).limit(6);
            customerMessages = (inb ?? []).reverse().map((m) => `[${((m.sent_at as string) ?? "").slice(0, 10)}] ${((m.body as string) ?? "").slice(0, 1200)}`).join("\n---\n");
          }
          const r = await reviseDraft({ language: c.language as string | null, draft: c.draft_reply as string, extraRules: body.rules, customerMessages });
          // A tradução PT-BR tem que ser PT-BR de verdade (o modelo às vezes devolve no idioma original).
          if (r.changed && !isPortuguese(c.language as string | null) && looksUntranslated(r.draft_reply, r.draft_reply_pt)) {
            r.draft_reply_pt = await translateToPortuguese(r.draft_reply, c.language as string | null);
          }
          return r;
        });
        const analysis = (c.analysis ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { analysis: { ...analysis, revised: tag, usage_total: addUsage(analysis.usage_total as never, usage) } };
        if (result.changed && result.draft_reply.trim()) {
          patch.draft_reply = result.draft_reply;
          patch.draft_reply_pt = result.draft_reply_pt;
          changed += 1;
        }
        const { error } = await admin.from("conversations").update(patch).eq("id", c.id as string);
        if (error) throw new Error(error.message);
        revised += 1;
        cost += usage.cost_usd;
      } catch (err) {
        errors += 1;
        console.error("revise-drafts:", (err as Error).message);
        if (/no credits|insufficient_quota|billing/i.test((err as Error).message)) queue.length = 0;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return NextResponse.json({ candidates: todo.length, revised, changed, errors, remaining: queue.length, costUsd: Number(cost.toFixed(4)) });
}
