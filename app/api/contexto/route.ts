import { NextResponse } from "next/server";
import { exportMd, importMd, isStructuredMd } from "@/lib/ai/context-md";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractContextsFromChat, type ChatTurn } from "@/lib/ai/learn";

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Contexto com Objeções: blocos fixos da loja + regras aprendidas.
export async function GET(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const url = new URL(request.url);
  const storeId = url.searchParams.get("store");
  const productId = url.searchParams.get("product");
  if (!storeId) return NextResponse.json({ error: "store é obrigatório" }, { status: 400 });
  const admin = createAdminClient();
  if (url.searchParams.get("export")) {
    const [{ data: store }, { data: all }, { data: prods }] = await Promise.all([
      admin.from("stores").select("name").eq("id", storeId).single(),
      admin.from("store_contexts").select("label, content, product_id").eq("store_id", storeId).order("created_at", { ascending: true }),
      admin.from("products").select("id, name").eq("store_id", storeId),
    ]);
    const names = new Map((prods ?? []).map((p) => [p.id as string, p.name as string]));
    const md = exportMd((store?.name as string) ?? "loja", (all ?? []).map((c) => ({ label: c.label as string, content: c.content as string, productName: c.product_id ? names.get(c.product_id as string) ?? null : null })));
    return new NextResponse(md, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="contexto-${((store?.name as string) ?? "loja").toLowerCase().replace(/\s+/g, "-")}.md"` } });
  }
  let ctxQuery = admin.from("store_contexts").select("*").eq("store_id", storeId).order("created_at", { ascending: true });
  // Produto selecionado: o contexto da loja (vale pra todos) + o do produto.
  if (productId === "store") ctxQuery = ctxQuery.is("product_id", null);
  else if (productId) ctxQuery = ctxQuery.or(`product_id.is.null,product_id.eq.${productId}`);
  const [{ data: contexts }, { data: learned }] = await Promise.all([
    ctxQuery,
    admin.from("learned_responses").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(200),
  ]);
  return NextResponse.json({ contexts: contexts ?? [], learned: learned ?? [] });
}

// Chat que extrai contexto e salva os blocos novos; ou importação direta de
// documentos (manual de atendimento) como blocos, texto integral.
export async function POST(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const storeId = body.storeId as string | undefined;

  if (Array.isArray(body.documents) && storeId) {
    const docs = (body.documents as Array<{ label: string; content: string }>).filter((d) => d.label && d.content?.trim());
    if (docs.length === 0) return NextResponse.json({ error: "nenhum documento" }, { status: 400 });
    const admin = createAdminClient();

    // .md estruturado (## Título + cabeçalho): um bloco por título, com
    // produto pelo nome; bloco com o mesmo título é atualizado, não duplicado.
    const structured = docs.filter((d) => isStructuredMd(d.content));
    if (structured.length > 0) {
      const [{ data: prods }, { data: existing }] = await Promise.all([
        admin.from("products").select("id, name").eq("store_id", storeId),
        admin.from("store_contexts").select("id, label, product_id").eq("store_id", storeId),
      ]);
      const byName = new Map((prods ?? []).map((p) => [(p.name as string).toLowerCase(), p.id as string]));
      let created = 0, updated = 0;
      const unknownProducts = new Set<string>();
      for (const doc of structured) {
        for (const b of importMd(doc.content)) {
          const pid = b.produto ? byName.get(b.produto.toLowerCase()) ?? null : (body.productId as string | undefined) ?? null;
          if (b.produto && !pid) unknownProducts.add(b.produto);
          const hit = (existing ?? []).find((e) => (e.label as string).toLowerCase() === b.label.toLowerCase() && ((e.product_id as string | null) ?? null) === pid);
          if (hit) {
            await admin.from("store_contexts").update({ content: b.content.slice(0, 20000) }).eq("id", hit.id as string);
            updated += 1;
          } else {
            await admin.from("store_contexts").insert({ store_id: storeId, label: b.label, content: b.content.slice(0, 20000), ...(pid ? { product_id: pid } : {}) });
            created += 1;
          }
        }
      }
      return NextResponse.json({ ok: true, imported: created + updated, created, updated, unknownProducts: [...unknownProducts] });
    }

    const { error } = await admin.from("store_contexts").insert(docs.map((d) => ({ store_id: storeId, label: d.label.slice(0, 120), content: d.content.slice(0, 20000), ...(body.productId ? { product_id: body.productId } : {}) })));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, imported: docs.length });
  }

  const history = (body.history ?? []) as ChatTurn[];
  if (!storeId || history.length === 0) return NextResponse.json({ error: "storeId e history são obrigatórios" }, { status: 400 });

  const admin = createAdminClient();
  const { data: existing } = await admin.from("store_contexts").select("label").eq("store_id", storeId);
  try {
    const result = await extractContextsFromChat(history.slice(-12), (existing ?? []).map((e) => e.label as string));
    if (result.contexts.length > 0) {
      await admin.from("store_contexts").insert(result.contexts.map((c) => ({ store_id: storeId, label: c.label, content: c.content, ...(body.productId ? { product_id: body.productId } : {}) })));
    }
    return NextResponse.json({ reply: result.reply_to_user, saved: result.contexts });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

// Editar/apagar um bloco ou regra aprendida.
export async function PATCH(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();
  if (body.kind === "context") {
    const { error } = await admin.from("store_contexts").update({ label: body.label, content: body.content }).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (body.kind === "learned") {
    const { error } = await admin.from("learned_responses").update({ situation_summary: body.situation_summary, guidance: body.guidance }).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });
  const admin = createAdminClient();
  const table = kind === "learned" ? "learned_responses" : "store_contexts";
  const { error } = await admin.from(table).delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
