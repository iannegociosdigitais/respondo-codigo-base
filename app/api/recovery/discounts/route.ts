import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryDiscount } from "@/lib/recovery/types";
import { authorize, dbError, isUuid, jsonError, loadStore, parseBody, storeParam } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Cupons por loja. O app não cria cupom na Shopify (sem escopo
// write_discounts): o cupom é criado lá e o código colado aqui com o %.

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const admin = createAdminClient();
  const { data, error } = await admin.from("recovery_discounts").select("*").eq("store_id", storeId).order("percent", { ascending: true }).order("code", { ascending: true });
  if (error) return dbError(error);
  return NextResponse.json({ discounts: (data ?? []) as RecoveryDiscount[] });
}

const PostSchema = z.object({
  store: z.string().optional(),
  code: z.string().trim().min(1).max(80),
  percent: z.number().min(0).max(90),
  combinable: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
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
  const code = data.code.toUpperCase().replace(/\s+/g, "");
  const { data: discount, error } = await admin
    .from("recovery_discounts")
    .insert({ store_id: storeId, code, percent: data.percent, combinable: data.combinable ?? false, note: data.note ?? null, active: data.active ?? true })
    .select("*")
    .maybeSingle();
  if (error) {
    if (/duplicate key/i.test(error.message)) return jsonError(`o cupom ${code} já está cadastrado nesta loja`, 409);
    return dbError(error);
  }
  return NextResponse.json({ discount: discount as RecoveryDiscount });
}

const PatchSchema = z.object({
  id: z.string(),
  active: z.boolean().optional(),
  code: z.string().trim().min(1).max(80).optional(),
  percent: z.number().min(0).max(90).optional(),
  combinable: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function PATCH(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response: bad } = await parseBody(request, PatchSchema);
  if (bad) return bad;
  if (!isUuid(data.id)) return jsonError("id inválido", 400);
  const patch: Record<string, unknown> = {};
  if (data.active !== undefined) patch.active = data.active;
  if (data.code !== undefined) patch.code = data.code.toUpperCase().replace(/\s+/g, "");
  if (data.percent !== undefined) patch.percent = data.percent;
  if (data.combinable !== undefined) patch.combinable = data.combinable;
  if (data.note !== undefined) patch.note = data.note;
  if (Object.keys(patch).length === 0) return jsonError("nada para atualizar", 400);
  const admin = createAdminClient();
  const { data: discount, error } = await admin.from("recovery_discounts").update(patch).eq("id", data.id).select("*").maybeSingle();
  if (error) {
    if (/duplicate key/i.test(error.message)) return jsonError("já existe um cupom com esse código nesta loja", 409);
    return dbError(error);
  }
  if (!discount) return jsonError("cupom não encontrado", 404);
  return NextResponse.json({ ok: true, discount: discount as RecoveryDiscount });
}

export async function DELETE(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !isUuid(id)) return jsonError("id (uuid) é obrigatório", 400);
  const admin = createAdminClient();
  const { error } = await admin.from("recovery_discounts").delete().eq("id", id);
  if (error) return dbError(error);
  return NextResponse.json({ ok: true });
}
