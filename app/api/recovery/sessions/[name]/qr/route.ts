import { NextResponse } from "next/server";
import { getQrPng, getSession, wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, errMessage, jsonError } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// PNG do QR para ler no celular da marca. Só faz sentido enquanto a sessão
// está em SCAN_QR_CODE; fora disso, 409 com o status atual.
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { name } = await params;
  if (!wahaConfigured()) return jsonError("WAHA não configurado.", 503);
  try {
    const live = await getSession(name);
    if (!live) return jsonError("sessão não existe no WAHA", 404);
    if (live.status !== "SCAN_QR_CODE") return NextResponse.json({ error: `sessão em ${live.status}: sem QR para ler`, status: live.status }, { status: 409 });
    const png = await getQrPng(name);
    return new Response(new Uint8Array(png), { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "no-store, max-age=0" } });
  } catch (err) {
    return jsonError(`não consegui obter o QR: ${errMessage(err)}`, 502);
  }
}
