import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CATEGORIES } from "@/lib/ai/openai-agent";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();
  const [{ data: store, error }, { data: accounts }, { data: shopify }, { data: tone }] = await Promise.all([
    admin.from("stores").select("*").eq("id", id).single(),
    admin.from("store_email_accounts").select("id, provider, email_address, connected_at, last_synced_at, last_uid, sent_folder, sent_last_uid, last_error").eq("store_id", id),
    admin.from("store_shopify_credentials").select("shop_domain, connected_at").eq("store_id", id).maybeSingle(),
    admin.from("tone_profiles").select("style_summary, based_on_email_count, generated_at, example_snippets").eq("store_id", id).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ store, accounts: accounts ?? [], shopify: shopify ?? null, tone: tone ?? null });
}

// Ajustes da loja: envio automático por categoria, assinatura, prazo, nome.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  if (Array.isArray(body.auto_send_categories)) {
    patch.auto_send_categories = body.auto_send_categories.filter((c: string) => (CATEGORIES as readonly string[]).includes(c) && c !== "spam" && c !== "reembolso");
  }
  if (typeof body.signature === "string") patch.signature = body.signature.trim() || null;
  if (typeof body.agent_name === "string") patch.agent_name = body.agent_name.trim() || null;
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body.delivery_days_max === null || typeof body.delivery_days_max === "number") patch.delivery_days_max = body.delivery_days_max;
  if (Array.isArray(body.aliases)) patch.aliases = body.aliases.map((a: string) => String(a).trim().toLowerCase()).filter(Boolean);
  if (typeof body.auto_ack === "boolean") patch.auto_ack = body.auto_ack;

  const admin = createAdminClient();
  if (typeof body.auto_receipt === "boolean") {
    // Ligar exige a trava de duplicidade (email_log) no ar; e marca o
    // instante: só pedidos feitos a partir de agora recebem.
    if (body.auto_receipt) {
      const { error: lockError } = await admin.from("email_log").select("id").limit(1);
      if (lockError) return NextResponse.json({ error: "Rode a migration 0017_email_log.sql antes de ligar qualquer envio automático (é a trava contra envio em dobro)." }, { status: 400 });
      const { data: current } = await admin.from("stores").select("auto_receipt").eq("id", id).maybeSingle();
      if (!current?.auto_receipt) patch.auto_receipt_since = new Date().toISOString();
    }
    patch.auto_receipt = body.auto_receipt;
  }
  if (body.auto_ack === true) {
    const { error: lockError } = await admin.from("email_log").select("id").limit(1);
    if (lockError) return NextResponse.json({ error: "Rode a migration 0017_email_log.sql antes de ligar qualquer envio automático (é a trava contra envio em dobro)." }, { status: 400 });
  }


  const { data, error } = await admin.from("stores").update(patch).eq("id", id).select().single();
  if (error) {
    const msg = /aliases/.test(error.message)
      ? "Rode a migration 0010 (stores.aliases) antes de salvar aliases."
      : /auto_receipt/.test(error.message)
        ? "Rode a migration 0017_email_log.sql antes de ativar o comprovante automático."
      : /auto_ack/.test(error.message)
        ? "Rode a migration 0015 (stores.auto_ack) antes de ativar o aviso automático."
        : error.message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ store: data });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await params;
  const admin = createAdminClient();
  const { error } = await admin.from("stores").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
