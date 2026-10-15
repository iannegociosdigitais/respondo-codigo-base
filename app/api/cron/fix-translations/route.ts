import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPortuguese, looksUntranslated, translateToPortuguese } from "@/lib/ai/translate-reply";
import { translateMissingMessages } from "@/lib/agent/analyze";

export const maxDuration = 300;

// Rascunhos cuja "tradução PT-BR" veio no idioma original: traduz de novo,
// em lote, sem refazer a análise inteira.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const only = url.searchParams.get("id");
  const admin = createAdminClient();

  // ?messages=1: todos os e-mails das conversas pendentes ficam em PT-BR.
  if (url.searchParams.get("messages")) {
    const stop = Date.now() + 250_000;
    const { data: pend } = await admin
      .from("conversations")
      .select("id, language, messages!inner(id)")
      .in("status", ["aguardando_humano", "nova", "reaberta"])
      .is("messages.body_pt", null)
      .limit(400);
    const convs = [...(pend ?? [])];
    let translated = 0;
    const run = async () => {
      for (let c = convs.shift(); c && Date.now() < stop; c = convs.shift()) {
        translated += await translateMissingMessages(admin, c.id as string, c.language as string | null, 20);
      }
    };
    await Promise.all([run(), run()]);
    return NextResponse.json({ conversations: pend?.length ?? 0, translated, remaining: convs.length });
  }

  const { data } = await admin
    .from("conversations")
    .select("id, language, draft_reply, draft_reply_pt")
    .in("status", ["aguardando_humano", "nova", "reaberta"])
    .not("draft_reply", "is", null)
    .limit(500);

  const todo = (data ?? []).filter((c) => (!only || c.id === only) && !isPortuguese(c.language as string) && (c.draft_reply as string).trim() && looksUntranslated(c.draft_reply as string, (c.draft_reply_pt as string) ?? ""));
  let fixed = 0;
  const deadline = Date.now() + 250_000;
  const queue = [...todo];
  async function worker() {
    while (queue.length > 0 && Date.now() < deadline) {
      const c = queue.shift()!;
      try {
        const pt = await translateToPortuguese(c.draft_reply as string, c.language as string);
        const { error } = await admin.from("conversations").update({ draft_reply_pt: pt }).eq("id", c.id);
        console.log(`[fix-translations] ${c.id} lang=${c.language} in="${(c.draft_reply as string).slice(0, 40).replace(/\n/g, " ")}" out="${pt.slice(0, 40).replace(/\n/g, " ")}" err=${error?.message ?? "-"}`);
        fixed += 1;
      } catch (err) {
        console.error("fix-translations:", err);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return NextResponse.json({ candidates: todo.length, fixed, remaining: queue.length });
}
