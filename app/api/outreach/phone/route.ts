import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftPhoneRequest } from "@/lib/agent/phone-request";

// Pede telefone de entrega pra uma lista de pedidos (loja + números). Só
// prepara o rascunho no Inbox — nunca envia sozinho.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const storeId = typeof body.storeId === "string" ? body.storeId : null;
  const orderNumbers: string[] = Array.isArray(body.orderNumbers)
    ? body.orderNumbers.map((n: unknown) => String(n).replace("#", "").trim()).filter(Boolean)
    : [];
  if (!storeId || orderNumbers.length === 0) return NextResponse.json({ error: "loja e nº do(s) pedido(s) são obrigatórios" }, { status: 400 });

  const admin = createAdminClient();
  const results = [];
  for (const orderNumber of orderNumbers) {
    const r = await draftPhoneRequest(admin, storeId, orderNumber);
    results.push({ orderNumber, ...r });
  }
  return NextResponse.json({ results });
}
