import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractPromises, type Todo } from "@/lib/ai/promises";

export const maxDuration = 300;

// Lê as respostas JÁ enviadas desde ?since=AAAA-MM-DD e anota as promessas
// (cancelar assinatura, regularização…) que ainda não estavam anotadas.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const since = new URL(request.url).searchParams.get("since") ?? new Date(Date.now() - 86400000).toISOString();
  const admin = createAdminClient();
  const { data: msgs } = await admin.from("messages").select("conversation_id, body, body_pt, sent_at").eq("direction", "outbound_human").gte("sent_at", since).order("sent_at", { ascending: true }).limit(300);
  let added = 0;
  const seen: string[] = [];
  for (const m of msgs ?? []) {
    const { data: cur } = await admin.from("conversations").select("analysis").eq("id", m.conversation_id as string).single();
    const analysis = (cur?.analysis ?? {}) as Record<string, unknown>;
    const prev = (Array.isArray(analysis.todos) ? analysis.todos : []) as Todo[];
    const found = await extractPromises(((m.body_pt as string | null) ?? (m.body as string)) || "");
    const fresh = found.filter((f) => !prev.some((p) => p.type === f.type)).map((f) => ({ ...f, created_at: m.sent_at as string, done: false }));
    if (fresh.length > 0) {
      await admin.from("conversations").update({ analysis: { ...analysis, todos: [...prev, ...fresh] } }).eq("id", m.conversation_id as string);
      added += fresh.length;
      seen.push(...fresh.map((f) => f.text));
    }
  }
  return NextResponse.json({ replies: msgs?.length ?? 0, added, items: seen });
}
