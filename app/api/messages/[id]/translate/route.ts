import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { translateToPortuguese } from "@/lib/ai/translate-reply";

// "Traduzir" numa mensagem do thread: traduz uma vez, guarda em body_pt.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const admin = createAdminClient();
  const { data: msg } = await admin.from("messages").select("id, body, body_pt").eq("id", id).single();
  if (!msg) return NextResponse.json({ error: "mensagem não encontrada" }, { status: 404 });
  if (msg.body_pt) return NextResponse.json({ body_pt: msg.body_pt });

  try {
    const body_pt = await translateToPortuguese((msg.body as string) ?? "");
    await admin.from("messages").update({ body_pt }).eq("id", id);
    return NextResponse.json({ body_pt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
