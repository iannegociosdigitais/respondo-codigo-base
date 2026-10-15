import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runStoreAccount } from "@/lib/agent/run-store";

export const maxDuration = 300;

// "Sincronizar agora": mesmo ciclo do cron, só pra essa loja.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();

  const { data: store } = await admin.from("stores").select("*").eq("id", id).single();
  if (!store) return NextResponse.json({ error: "loja não encontrada" }, { status: 404 });

  const { data: accounts } = await admin.from("store_email_accounts").select("*").eq("store_id", id).not("connected_at", "is", null);
  if (!accounts || accounts.length === 0) {
    return NextResponse.json({ error: "nenhuma caixa de e-mail conectada nessa loja" }, { status: 400 });
  }

  const results = [];
  for (const account of accounts) {
    results.push(await runStoreAccount(admin, store as any, account as any, { analyzeLimit: Number(body.analyzeLimit ?? 8), skipAnalysis: Boolean(body.skipAnalysis) }));
  }
  return NextResponse.json({ results });
}
