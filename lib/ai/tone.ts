import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ToneSchema = z.object({
  style_summary_pt: z.string().describe("Descrição em PT-BR do estilo: saudação típica, despedida, tamanho médio, formalidade, uso de emoji, expressões recorrentes, como lida com atraso/reembolso"),
  signature: z.string().nullable().describe("A assinatura literal que aparece no fim das respostas (nome/equipe/loja), ou null"),
  example_indexes: z.array(z.number().int()).describe("Índices (0-based) de 8 a 12 exemplos mais representativos, variados em situação"),
});

export interface ToneProfile {
  styleSummary: string;
  signature: string | null;
  examples: string[];
  basedOn: number;
  generatedAt: string;
}

const MAX_AGE_DAYS = 7;

export async function getToneProfile(admin: SupabaseClient, storeId: string): Promise<ToneProfile | null> {
  const { data } = await admin.from("tone_profiles").select("*").eq("store_id", storeId).maybeSingle();
  if (!data) return null;
  const snippets = (data.example_snippets as { examples?: string[]; signature?: string | null } | null) ?? {};
  return {
    styleSummary: data.style_summary as string,
    signature: snippets.signature ?? null,
    examples: snippets.examples ?? [],
    basedOn: data.based_on_email_count as number,
    generatedAt: data.generated_at as string,
  };
}

// Lê as respostas que a própria loja já mandou (importadas da pasta
// Enviados) e extrai um perfil de estilo + exemplos reais pra few-shot.
// Refaz sozinho a cada 7 dias, ou quando forçado pelo painel.
export async function ensureToneProfile(
  admin: SupabaseClient,
  storeId: string,
  force = false
): Promise<{ status: "ok" | "skipped" | "insufficient"; basedOn: number }> {
  if (!force) {
    const existing = await getToneProfile(admin, storeId);
    if (existing && Date.now() - new Date(existing.generatedAt).getTime() < MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
      return { status: "skipped", basedOn: existing.basedOn };
    }
  }

  const { data: sent } = await admin
    .from("messages")
    .select("body, created_at, conversations!inner(store_id)")
    .eq("conversations.store_id", storeId)
    .eq("direction", "outbound_human")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(300);

  // Só FORMA entra no perfil de tom. Respostas sobre disputa de cartão,
  // ameaça ou litígio ficam de fora dos exemplos — não são estilo, são
  // conteúdo sensível que passa por humano.
  const EXCLUDE = /chargeback|contestation|litige|r[ée]tract|avocat|plainte|dgccrf|paypal dispute|disputa|retirer la|revisão humana|verificação manual|\[Revisão\]|\[URGENTE\]|Escalonamento/i;
  const seen = new Set<string>();
  const candidates = (sent ?? [])
    .map((m) => ((m.body as string) ?? "").trim())
    .filter((b) => b.length >= 200 && b.length <= 3500 && !EXCLUDE.test(b) && !/^[ \t]*[•*·▪][ \t]/m.test(b))
    .filter((b) => {
      const key = b.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 40);

  if (candidates.length < 5) return { status: "insufficient", basedOn: candidates.length };

  const response = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: [
      "Você vai analisar respostas reais que uma loja mandou pros clientes por e-mail e descrever APENAS O ESTILO DE ESCRITA pra outra pessoa conseguir escrever igual.",
      "Seja concreto sobre a forma: saudação e despedida literais, quem assina, tamanho típico, nível de formalidade, se usa emoji, expressões recorrentes, ritmo das frases, como demonstra empatia.",
      "NÃO descreva o que a loja afirma sobre pedidos, prazos, transportadoras, reembolsos ou disputas — isso é conteúdo, não estilo, e vem de outra fonte. Não inclua nenhuma tática de persuasão.",
      "Escolha de 8 a 12 exemplos representativos e variados de situações comuns (dúvida, posologia, cancelamento de assinatura, agradecimento, pedido em trânsito), preferindo respostas completas, calorosas e em texto corrido (como o Ian aprovou em 15/10: falam em primeira pessoa, cuidam do pedido pessoalmente, sem listas nem tópicos), evitando repetidos.",
    ].join("\n"),
    input: candidates.map((c, i) => `[${i}]\n${c}`).join("\n\n"),
    text: { format: zodTextFormat(ToneSchema, "tone_profile") },
  });

  const parsed = response.output_parsed;
  if (!parsed) throw new Error("OpenAI não retornou perfil de tom.");

  const examples = parsed.example_indexes
    .filter((i) => i >= 0 && i < candidates.length)
    .slice(0, 12)
    .map((i) => candidates[i]);

  await admin.from("tone_profiles").upsert({
    store_id: storeId,
    style_summary: parsed.style_summary_pt,
    example_snippets: { examples, signature: parsed.signature },
    based_on_email_count: candidates.length,
    generated_at: new Date().toISOString(),
  });

  return { status: "ok", basedOn: candidates.length };
}
