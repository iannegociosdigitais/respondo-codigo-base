import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendReply } from "@/lib/email/send-reply";
import { formLink, APP_URL } from "@/lib/forms/token";

export const maxDuration = 60;

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

const MISSING = /return_requests|does not exist|schema cache/i;

// Lista + contadores + links por produto. ?link=1&email=&product=&lang=&conversation=
// devolve o link PESSOAL (cifrado) de um cliente.
export async function GET(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const url = new URL(request.url);
  const admin = createAdminClient();

  if (url.searchParams.get("link")) {
    const email = (url.searchParams.get("email") ?? "").toLowerCase();
    if (!email) return NextResponse.json({ error: "email obrigatório" }, { status: 400 });
    return NextResponse.json({ link: formLink({ e: email, p: url.searchParams.get("product") ?? undefined, l: url.searchParams.get("lang") ?? undefined, c: url.searchParams.get("conversation") ?? undefined }) });
  }

  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q")?.trim();
  let query = admin
    .from("return_requests")
    .select("id, reference, status, product_name, customer_email, customer_name, phone, language, orders, received_at, not_received, address, description, resolution, fill_seconds, messages, decided_at, executed_at, created_at, conversation_id, signature_png, ip")
    .order("created_at", { ascending: false })
    .limit(300);
  if (status) query = query.eq("status", status);
  if (q) query = query.or(`customer_email.ilike.%${q.replace(/[%,()]/g, " ")}%,customer_name.ilike.%${q.replace(/[%,()]/g, " ")}%,reference.ilike.%${q.replace(/[%,()]/g, " ")}%`);
  const { data, error } = await query;
  const { data: products } = await admin.from("products").select("name").order("name");
  const names = [...new Set((products ?? []).map((p) => (p.name as string).split(/\s+/)[0]))];
  const links = names.map((name) => ({ product: name, link: `${APP_URL}/solicitacao?p=${encodeURIComponent(name)}` }));

  if (error) {
    return NextResponse.json({ missingTable: MISSING.test(error.message), error: error.message, requests: [], counters: { pendente: 0, aprovado: 0, rejeitado: 0, encerrado: 0 }, links });
  }
  const { data: all } = await admin.from("return_requests").select("status");
  const counters = { pendente: 0, aprovado: 0, rejeitado: 0, encerrado: 0 } as Record<string, number>;
  for (const r of all ?? []) counters[r.status as string] = (counters[r.status as string] ?? 0) + 1;
  return NextResponse.json({ requests: data ?? [], counters, links });
}

// Decidir (aprovar / rejeitar / encerrar / reabrir), marcar executado, ou
// responder por e-mail pela caixa da loja.
export async function PATCH(request: Request) {
  if (!(await auth())) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();
  const { data: req } = await admin.from("return_requests").select("*").eq("id", body.id).single();
  if (!req) return NextResponse.json({ error: "formulário não encontrado" }, { status: 404 });
  const now = new Date().toISOString();

  if (body.action === "reply") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ error: "mensagem vazia" }, { status: 400 });
    let accQuery = admin.from("store_email_accounts").select("*").not("connected_at", "is", null);
    if (req.store_id) accQuery = accQuery.eq("store_id", req.store_id);
    let { data: accounts } = await accQuery.limit(1);
    if (!accounts?.length) ({ data: accounts } = await admin.from("store_email_accounts").select("*").not("connected_at", "is", null).limit(1));
    const account = accounts?.[0];
    if (!account) return NextResponse.json({ error: "nenhuma caixa de e-mail conectada" }, { status: 400 });
    try {
      await sendReply({
        emailAccount: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
        to: req.customer_email as string,
        subject: `${req.product_name ? `${(req.product_name as string).split(/\s+/)[0]} · ` : ""}${req.reference}`,
        body: text,
        inReplyTo: null,
        references: [],
      });
    } catch (err) {
      return NextResponse.json({ error: `Falha ao enviar: ${(err as Error).message}` }, { status: 502 });
    }
    const messages = [...((req.messages as unknown[]) ?? []), { who: "loja", text, at: now }];
    await admin.from("return_requests").update({ messages }).eq("id", req.id);
    return NextResponse.json({ ok: true, messages });
  }

  const patch: Record<string, unknown> =
    body.action === "aprovar" ? { status: "aprovado", decided_at: now }
    : body.action === "rejeitar" ? { status: "rejeitado", decided_at: now }
    : body.action === "encerrar" ? { status: "encerrado", decided_at: now }
    : body.action === "reabrir" ? { status: "pendente", decided_at: null }
    : body.action === "executado" ? { executed_at: body.done === false ? null : now }
    : {};
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "ação inválida" }, { status: 400 });
  const { error } = await admin.from("return_requests").update(patch).eq("id", req.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
