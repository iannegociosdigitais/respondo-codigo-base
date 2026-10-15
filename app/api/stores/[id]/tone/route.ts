import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureToneProfile, getToneProfile } from "@/lib/ai/tone";

export const maxDuration = 120;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const tone = await getToneProfile(createAdminClient(), id);
  return NextResponse.json({ tone });
}

// "Reaprender tom agora": força a regeneração a partir dos Enviados.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }
  const { id } = await params;
  const admin = createAdminClient();
  try {
    const result = await ensureToneProfile(admin, id, true);
    const tone = await getToneProfile(admin, id);
    return NextResponse.json({ result, tone });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
