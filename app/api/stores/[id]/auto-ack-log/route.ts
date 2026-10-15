import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Logs do aviso automático de recebimento: pra o dono acompanhar antes de
// ligar de vez (stores.auto_ack). Só leitura.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_log")
    .select("id, to_address, customer_name, brand, language, status, error, created_at")
    .eq("kind", "auto_ack")
    .eq("store_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    const msg = /email_log/.test(error.message) ? "Rode a migration 0017_email_log.sql antes de ver os logs." : error.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const rows = data ?? [];
  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  return NextResponse.json({ rows, sent, failed });
}
