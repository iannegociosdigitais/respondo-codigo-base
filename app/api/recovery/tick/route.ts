import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecoveryTick } from "@/lib/recovery/engine";
import { authorize, errMessage, isUuid, jsonError } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// "Rodar a régua agora" (botão do painel): um tick do motor à mão.
// ?store= limita a uma loja. O motor respeita os mesmos gates do cron
// (enabled, canal, modo de teste, regras de parada).
export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const storeId = new URL(request.url).searchParams.get("store");
  if (storeId && !isUuid(storeId)) return jsonError("store inválida", 400);
  try {
    const result = await runRecoveryTick(createAdminClient(), { deadline: Date.now() + 50_000, onlyStoreId: storeId ?? null });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(`tick falhou: ${errMessage(err)}`, 502);
  }
}
