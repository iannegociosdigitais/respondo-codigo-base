import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MinedSchema = z.object({
  contexts: z.array(
    z.object({
      label: z.string().describe("Rótulo curto e específico. Ex: 'Objeção: pedido atrasado', 'Política: devolução', 'Prazo: França', 'Produto: posologia'"),
      content: z.string().describe("Regra/resposta padrão da loja, em PT-BR, concreta, do jeito que a loja realmente respondeu. Inclua prazos, valores e condições quando aparecerem."),
    })
  ),
});

interface Pair {
  customer: string;
  reply: string;
}

// Lê pares reais (cliente → resposta da loja) do histórico importado e
// extrai as objeções, políticas e fatos que a loja já usa — pra base de
// contexto nascer preenchida com o que a loja faz de verdade.
export async function mineContextsFromHistory(
  admin: SupabaseClient,
  storeId: string,
  opts: { maxPairs?: number } = {}
): Promise<{ created: number; pairs: number }> {
  const maxPairs = opts.maxPairs ?? 80;

  const { data: msgs } = await admin
    .from("messages")
    .select("conversation_id, direction, body, sent_at, created_at, conversations!inner(store_id)")
    .eq("conversations.store_id", storeId)
    .in("direction", ["inbound", "outbound_human"])
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(2000);

  const byConv = new Map<string, Array<{ direction: string; body: string; at: string }>>();
  for (const m of msgs ?? []) {
    const arr = byConv.get(m.conversation_id as string) ?? [];
    arr.push({ direction: m.direction as string, body: ((m.body as string) ?? "").trim(), at: ((m.sent_at as string | null) ?? (m.created_at as string)) as string });
    byConv.set(m.conversation_id as string, arr);
  }

  const pairs: Pair[] = [];
  for (const arr of byConv.values()) {
    arr.sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].direction === "inbound" && arr[i + 1].direction === "outbound_human") {
        const c = arr[i].body;
        const r = arr[i + 1].body;
        if (c.length >= 30 && r.length >= 40 && r.length <= 2500) pairs.push({ customer: c.slice(0, 1500), reply: r });
      }
    }
    if (pairs.length >= maxPairs) break;
  }
  if (pairs.length < 3) return { created: 0, pairs: pairs.length };

  const { data: existing } = await admin.from("store_contexts").select("label").eq("store_id", storeId);
  const existingLabels = (existing ?? []).map((e) => e.label as string);

  const chunks: Pair[][] = [];
  for (let i = 0; i < pairs.length; i += 20) chunks.push(pairs.slice(i, i + 20));

  let created = 0;
  const labelsSoFar = [...existingLabels];
  for (const chunk of chunks) {
    const response = await client.responses.parse({
      model: OPENAI_MODEL,
      instructions: [
        "Você está lendo trocas reais de e-mail entre clientes e a equipe de suporte de uma loja. Extraia a BASE DE CONHECIMENTO que a loja usa de fato: como responde cada tipo de situação (objeção), políticas (troca, devolução, garantia, reembolso), prazos de entrega por país, transportadora, informações de produto (uso, dosagem, composição), tom e assinatura.",
        "Cada item vira um bloco {label, content} em PT-BR. Seja concreto e fiel ao que a loja respondeu — não invente política que não apareceu. Junte situações repetidas num só bloco.",
        "Ignore conteúdo de spam/newsletter. Não crie bloco pra caso único e irrelevante.",
        `Blocos que já existem (não repita; só crie se for informação nova): ${labelsSoFar.join("; ") || "nenhum"}.`,
        "Retorne no máximo 12 blocos por leva.",
      ].join("\n"),
      input: chunk.map((p, i) => `### Troca ${i + 1}\nCLIENTE:\n${p.customer}\n\nLOJA:\n${p.reply}`).join("\n\n"),
      text: { format: zodTextFormat(MinedSchema, "mined_contexts") },
    });
    const parsed = response.output_parsed;
    if (!parsed || parsed.contexts.length === 0) continue;
    const fresh = parsed.contexts.filter((c) => !labelsSoFar.some((l) => l.toLowerCase() === c.label.toLowerCase()));
    if (fresh.length === 0) continue;
    const { error } = await admin.from("store_contexts").insert(fresh.map((c) => ({ store_id: storeId, label: c.label, content: c.content })));
    if (!error) {
      created += fresh.length;
      labelsSoFar.push(...fresh.map((c) => c.label));
    }
  }

  return { created, pairs: pairs.length };
}
