import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computePhase } from "@/lib/agent/phase";
import type { AgentDecision } from "@/lib/ai/openai-agent";

export const maxDuration = 300;

// Preenche analysis.phase nas conversas já analisadas, sem chamar o modelo
// (usa as colunas já gravadas + datas das mensagens).
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: convs } = await admin
    .from("conversations")
    .select("id, subject, category, anger_level, mentions_threat, wants_refund, analysis, shopify_order")
    .not("analyzed_at", "is", null)
    .neq("status", "spam")
    .range(0, 4999);

  let updated = 0;
  for (const c of convs ?? []) {
    const analysis = (c.analysis as Record<string, unknown> | null) ?? {};
    if (analysis.phase) continue;
    const { data: msgs } = await admin.from("messages").select("direction, body, sent_at, created_at").eq("conversation_id", c.id);
    const inbound = (msgs ?? []).filter((m) => m.direction === "inbound").sort((a, b) => ((a.sent_at as string) ?? (a.created_at as string)).localeCompare((b.sent_at as string) ?? (b.created_at as string)));
    const order = c.shopify_order as { createdAt?: string; fulfilledAt?: string | null } | null;
    const phase = computePhase({
      decision: { anger_level: c.anger_level ?? 1, mentions_threat: Boolean(c.mentions_threat), wants_refund: Boolean(c.wants_refund), category: (c.category as AgentDecision["category"]) ?? "outro" } as AgentDecision,
      firstInboundAt: (inbound[0]?.sent_at as string) ?? (inbound[0]?.created_at as string) ?? null,
      lastInboundAt: null,
      inboundCount: inbound.length,
      orderCreatedAt: order?.createdAt ?? null,
      fulfilledAt: order?.fulfilledAt ?? null,
      bodies: [c.subject as string, ...(msgs ?? []).map((m) => (m.body as string) ?? "")],
    });
    await admin.from("conversations").update({ analysis: { ...analysis, phase } }).eq("id", c.id);
    updated += 1;
  }
  return NextResponse.json({ updated });
}
