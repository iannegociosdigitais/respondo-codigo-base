import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Ações em lote na tela de Tickets: encerrar, spam, reabrir, reanalisar.
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids vazio" }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    body.action === "lido"
      ? { unread: false }
      : body.action === "nao_lido"
      ? { unread: true }
      : body.action === "encerrar"
      ? { status: "encerrada", closed_at: now, unread: false }
      : body.action === "spam"
        ? { status: "spam", unread: false }
        : body.action === "reabrir"
          ? { status: "aguardando_humano", closed_at: null }
          : body.action === "reanalisar"
            ? { analyzed_at: null }
            : {};
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "ação inválida" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin.from("conversations").update(patch).in("id", ids.slice(0, 500));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, count: ids.length });
}
