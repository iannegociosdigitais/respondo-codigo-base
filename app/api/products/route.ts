import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

function clean(list: unknown): string[] {
  return Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

function missing(err: { message: string }) {
  return /relation .*products|products.*does not exist|schema cache/i.test(err.message) ? "Rode a migration 0011 (produtos) antes." : err.message;
}

export async function GET(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const storeId = new URL(request.url).searchParams.get("store");
  const admin = createAdminClient();
  let q = admin.from("products").select("*").order("created_at", { ascending: true });
  if (storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ products: [], enabled: false, error: missing(error) });
  return NextResponse.json({ products: data ?? [], enabled: true });
}

export async function POST(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.storeId || !body.name) return NextResponse.json({ error: "storeId e name são obrigatórios" }, { status: 400 });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("products")
    .insert({
      store_id: body.storeId,
      name: String(body.name).trim(),
      email_aliases: clean(body.email_aliases),
      keywords: clean(body.keywords),
      languages: clean(body.languages),
      shopify_product_ids: clean(body.shopify_product_ids),
      personas: body.personas && typeof body.personas === "object" ? body.personas : {},
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: missing(error) }, { status: 500 });
  return NextResponse.json({ product: data });
}

export async function PATCH(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  for (const k of ["email_aliases", "keywords", "languages", "shopify_product_ids"]) if (Array.isArray(body[k])) patch[k] = clean(body[k]);
  if (body.personas && typeof body.personas === "object") patch.personas = body.personas;
  const admin = createAdminClient();
  const { data, error } = await admin.from("products").update(patch).eq("id", body.id).select().single();
  if (error) return NextResponse.json({ error: missing(error) }, { status: 500 });
  return NextResponse.json({ product: data });
}

export async function DELETE(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });
  const admin = createAdminClient();
  const { error } = await admin.from("products").delete().eq("id", id);
  if (error) return NextResponse.json({ error: missing(error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}
