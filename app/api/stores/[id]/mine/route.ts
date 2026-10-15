import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mineContextsFromHistory } from "@/lib/ai/mine-context";

export const maxDuration = 300;

// "Extrair contexto do histórico": lê as trocas reais já importadas e
// preenche a base de objeções/políticas da loja sozinho.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const result = await mineContextsFromHistory(createAdminClient(), id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
