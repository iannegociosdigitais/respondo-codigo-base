import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";
import { HOUSE_RULES } from "@/lib/ai/house-rules";
import { recordUsage } from "@/lib/ai/usage";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const Schema = z.object({
  changed: z.boolean().describe("true se precisou alterar algo"),
  draft_reply: z.string().describe("Resposta final no idioma do cliente"),
  draft_reply_pt: z.string().describe("Tradução fiel e completa pra PT-BR"),
});

// Revisão BARATA de um rascunho já pronto: aplica regras novas de redação sem
// refazer a análise (uma chamada pequena no modelo mini, ~1 centavo).
export async function reviseDraft(input: { language: string | null; draft: string; extraRules?: string[]; customerMessages?: string }) {
  const rules = [...HOUSE_RULES, ...(input.extraRules ?? [])];
  const r = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: [
      "Você revisa um e-mail de suporte já escrito. Mude SÓ o necessário pra cumprir as regras abaixo; preserve todo o resto (fatos, números de pedido, valores, tom, tamanho, assinatura, idioma).",
      `Idioma do e-mail: ${input.language ?? "o mesmo do texto"}. Escreva como nativo.`,
      "Regras:",
      ...rules.map((x, i) => `${i + 1}. ${x}`),
      "Se o texto cita uma janela de datas de chegada, troque pelo prazo em dias úteis que o próprio texto ou a janela indicam (sem inventar número novo: se não houver número, diga apenas que está dentro do prazo normal de entrega).",
      "Se o e-mail já cumpre tudo, devolva-o igual com changed = false.",
    ].join("\n"),
    input: input.customerMessages ? `MENSAGENS DO CLIENTE (só pra consulta, não responder de novo):\n${input.customerMessages}\n\n=== E-MAIL A REVISAR ===\n${input.draft}` : input.draft,
    text: { format: zodTextFormat(Schema, "revision") },
  });
  recordUsage(OPENAI_MODEL, r.usage);
  if (!r.output_parsed) throw new Error("revisão sem resposta");
  return r.output_parsed;
}
