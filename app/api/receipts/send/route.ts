import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendManualReceipt } from "@/lib/receipts/auto";

export const maxDuration = 120;

// Envio manual (um por um ou vários de uma vez, mas sempre por clique seu
// aqui) do comprovante da compra inicial. Nunca chamado pelo cron.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const items: Array<{ storeId: string; orderId: string }> = Array.isArray(body.items)
    ? body.items.filter((x: unknown): x is { storeId: string; orderId: string } => Boolean(x && typeof (x as { storeId?: unknown }).storeId === "string" && typeof (x as { orderId?: unknown }).orderId === "string"))
    : [];
  if (items.length === 0) return NextResponse.json({ error: "nada selecionado" }, { status: 400 });
  if (items.length > 50) return NextResponse.json({ error: "no máximo 50 por vez" }, { status: 400 });

  const admin = createAdminClient();
  const sent: string[] = [];
  const failed: Array<{ orderId: string; error: string }> = [];
  for (const item of items) {
    const r = await sendManualReceipt(admin, item.storeId, item.orderId);
    if (r.ok) sent.push(item.orderId);
    else failed.push({ orderId: item.orderId, error: r.error });
  }
  return NextResponse.json({ ok: true, sent, failed });
}
