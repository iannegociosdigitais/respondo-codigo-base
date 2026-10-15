import type { NextResponse } from "next/server";
import type { RecoveryFlow } from "@/lib/recovery/types";
import { jsonError } from "@/app/api/recovery/_lib/shared";

// Fluxo da régua na query string (?flow=carrinho|pos_compra). Sem ele, o
// carrinho abandonado (compatível com as chamadas antigas do painel).
export function flowParam(request: Request): { flow: RecoveryFlow; response: null } | { flow: null; response: NextResponse } {
  const raw = new URL(request.url).searchParams.get("flow");
  if (!raw || raw === "carrinho") return { flow: "carrinho", response: null };
  if (raw === "pos_compra") return { flow: "pos_compra", response: null };
  return { flow: null, response: jsonError("flow deve ser carrinho ou pos_compra", 400) };
}

export const FLOW_LABEL: Record<RecoveryFlow, string> = { carrinho: "carrinho abandonado", pos_compra: "pós-compra" };
