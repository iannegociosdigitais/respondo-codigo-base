import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listReceiptCandidates } from "@/lib/receipts/auto";

export const maxDuration = 120;

// Lista os pedidos que são a COMPRA INICIAL do cliente (não conta cobrança
// de assinatura seguinte), pra você conferir e escolher quais mandar o
// comprovante — nada aqui envia nada sozinho.
export async function GET(request: Request) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }

  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days") ?? 3), 1), 30);
  const admin = createAdminClient();
  const { candidates, migrationMissing } = await listReceiptCandidates(admin, days);
  return NextResponse.json({ candidates, migrationMissing });
}
