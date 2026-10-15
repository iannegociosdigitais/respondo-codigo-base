import { NextResponse } from "next/server";
import { z } from "zod";
import { lintEmailContent } from "@/lib/email/deliverability";
import { authorize, errMessage, jsonError, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 30;

// "Checar entregabilidade" de um passo da régua: pontua assunto e corpo
// (tamanho, maiúsculas, palavras de spam, links, encurtador, versão texto).
// Não grava nada e não envia nada.

const BodySchema = z.object({
  subject: z.string().max(1000).default(""),
  html: z.string().max(400000).default(""),
  text: z.string().max(200000).nullable().optional(),
  language: z.string().max(10).nullable().optional(),
});

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response } = await parseBody(request, BodySchema);
  if (response) return response;
  if (!data.subject.trim() && !data.html.trim() && !(data.text ?? "").trim()) return jsonError("nada para checar: informe assunto e corpo", 400);
  try {
    const result = lintEmailContent({ subject: data.subject, html: data.html, text: data.text ?? null, language: data.language ?? null });
    const score = Math.max(0, Math.min(100, Math.round(Number(result.score) || 0)));
    return NextResponse.json({ score, warnings: Array.isArray(result.warnings) ? result.warnings : [] });
  } catch (err) {
    return jsonError(`não consegui checar o conteúdo: ${errMessage(err)}`, 500);
  }
}
