import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleChargebackNotice } from "@/lib/agent/chargeback";

// Registro manual de contestação bancária (quando o aviso não chegou por
// e-mail, ex.: você viu no painel da Shopify). Busca o pedido na Shopify da
// loja indicada, registra o cliente e já deixa o rascunho pronto — nunca envia.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const storeId = typeof body.storeId === "string" ? body.storeId : null;
  const orderNumbers: string[] = Array.isArray(body.orderNumbers)
    ? body.orderNumbers.map((n: unknown) => String(n).replace("#", "").trim()).filter(Boolean)
    : [];
  if (!storeId || orderNumbers.length === 0) return NextResponse.json({ error: "loja e nº do pedido são obrigatórios" }, { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const results: Array<{ orderNumber: string; conversationId: string | null }> = [];
  for (const orderNumber of orderNumbers) {
    const conversationId = await handleChargebackNotice(admin, storeId, { orderNumber, kind: "opened" }, now);
    results.push({ orderNumber, conversationId });
  }
  return NextResponse.json({ results });
}
