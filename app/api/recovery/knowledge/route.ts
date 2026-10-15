import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryKnowledge } from "@/lib/recovery/types";
import { authorize, dbError, isUuid, jsonError, loadStore, nowIso, parseBody, storeParam } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Conhecimento do agente vendedor (script, produto, objeções, preço,
// garantia, regras). Separado do contexto de suporte.

const KINDS = ["script", "produto", "objecao", "preco", "garantia", "regra", "outro"] as const;

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const admin = createAdminClient();
  const { data, error } = await admin.from("recovery_knowledge").select("*").eq("store_id", storeId).order("kind", { ascending: true }).order("created_at", { ascending: true });
  if (error) return dbError(error);
  return NextResponse.json({ knowledge: (data ?? []) as RecoveryKnowledge[] });
}

const PostSchema = z.object({
  store: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20000),
  active: z.boolean().optional(),
});

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response: bad } = await parseBody(request, PostSchema);
  if (bad) return bad;
  const storeId = new URL(request.url).searchParams.get("store") ?? data.store ?? null;
  if (!storeId || !isUuid(storeId)) return jsonError("store (uuid) é obrigatório", 400);
  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);
  const { data: item, error } = await admin
    .from("recovery_knowledge")
    .insert({ store_id: storeId, kind: data.kind ?? "outro", title: data.title, content: data.content, active: data.active ?? true })
    .select("*")
    .maybeSingle();
  if (error) return dbError(error);
  return NextResponse.json({ item: item as RecoveryKnowledge });
}

const PatchSchema = z.object({
  id: z.string(),
  kind: z.enum(KINDS).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20000).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response: bad } = await parseBody(request, PatchSchema);
  if (bad) return bad;
  if (!isUuid(data.id)) return jsonError("id inválido", 400);
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  if (data.kind !== undefined) patch.kind = data.kind;
  if (data.title !== undefined) patch.title = data.title;
  if (data.content !== undefined) patch.content = data.content;
  if (data.active !== undefined) patch.active = data.active;
  if (Object.keys(patch).length === 1) return jsonError("nada para atualizar", 400);
  const admin = createAdminClient();
  const { data: item, error } = await admin.from("recovery_knowledge").update(patch).eq("id", data.id).select("*").maybeSingle();
  if (error) return dbError(error);
  if (!item) return jsonError("registro não encontrado", 404);
  return NextResponse.json({ ok: true, item: item as RecoveryKnowledge });
}

export async function DELETE(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !isUuid(id)) return jsonError("id (uuid) é obrigatório", 400);
  const admin = createAdminClient();
  const { error } = await admin.from("recovery_knowledge").delete().eq("id", id);
  if (error) return dbError(error);
  return NextResponse.json({ ok: true });
}
