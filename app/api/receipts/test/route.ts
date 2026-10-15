import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pickRecentFirstOrder, sendTestReceipt } from "@/lib/receipts/auto";

export const maxDuration = 45;

// Manda o recibo de um pedido real pro e-mail PESSOAL do Ian (nunca pro
// cliente) — só pra ele ver como fica. Aceita login normal ou a chave do
// cron (usada só internamente, nunca por um cliente).
export async function POST(request: Request) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();
  let storeId = typeof body.storeId === "string" ? body.storeId : null;
  let orderId = typeof body.orderId === "string" ? body.orderId : null;

  // Sem escolher um pedido específico: pega a compra inicial mais recente.
  if (!storeId || !orderId) {
    const pick = await pickRecentFirstOrder(admin);
    if (!pick) return NextResponse.json({ error: "nenhuma compra inicial nos últimos 7 dias pra usar de exemplo" }, { status: 404 });
    storeId = pick.storeId;
    orderId = pick.orderId;
  }

  const result = await sendTestReceipt(admin, storeId, orderId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, storeId, orderId });
}
