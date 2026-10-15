import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedDefaultSteps } from "@/lib/recovery/defaults";
import type { RecoveryFlow, RecoveryStep } from "@/lib/recovery/types";
import { authorize, channelParam, dbError, errMessage, jsonError, loadStore, storeParam } from "@/app/api/recovery/_lib/shared";
import { flowParam } from "@/app/api/recovery/_lib/flow";

export const maxDuration = 60;

// "Restaurar padrão": insere os passos padrão do fluxo+canal, só se ele
// estiver vazio (nunca sobrescreve o que o Ian editou).
export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const { channel, response: badChannel } = channelParam(request, true);
  if (badChannel || !channel) return badChannel ?? jsonError("channel é obrigatório", 400);
  const { flow, response: badFlow } = flowParam(request);
  if (badFlow || !flow) return badFlow ?? jsonError("flow inválido", 400);
  if (flow === "pos_compra" && channel !== "email") return jsonError("o pós-compra só tem régua de e-mail", 400);
  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);

  const existing = await admin.from("recovery_steps").select("id").eq("store_id", storeId).eq("flow", flow).eq("channel", channel).limit(1);
  if (existing.error) return dbError(existing.error);
  if ((existing.data ?? []).length > 0) return jsonError("a régua deste canal já tem passos: apague-os antes de restaurar o padrão.", 409);

  try {
    // Assinatura da spec v2: (admin, storeId, channel?, flow?). O cast só
    // existe para a rota compilar enquanto lib/recovery/defaults.ts (módulo
    // "welcome") ainda não ganhou o parâmetro flow; com a assinatura nova ele
    // não muda nada.
    await (seedDefaultSteps as SeedDefaultSteps)(admin, storeId, channel, flow);
  } catch (err) {
    return jsonError(`não consegui inserir os passos padrão: ${errMessage(err)}`, 502);
  }
  const { data: steps, error } = await admin.from("recovery_steps").select("*").eq("store_id", storeId).eq("flow", flow).eq("channel", channel).order("position", { ascending: true });
  if (error) return dbError(error);
  if ((steps ?? []).length === 0) return jsonError(`o padrão do fluxo ${flow === "pos_compra" ? "pós-compra" : "carrinho"} ainda não está disponível neste canal.`, 502);
  return NextResponse.json({ flow, steps: (steps ?? []) as RecoveryStep[] });
}

type SeedDefaultSteps = (admin: SupabaseClient, storeId: string, channel?: "email" | "whatsapp", flow?: RecoveryFlow) => Promise<RecoveryStep[]>;
