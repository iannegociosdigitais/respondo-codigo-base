import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";
import { recordUsage } from "@/lib/ai/usage";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Só o que o Ian precisa executar à mão fora daqui: cancelar assinatura,
// reembolsar e corrigir endereço. O resto (acompanhar envio, mandar recibo…)
// não vira lembrete.
export const TODO_TYPES = ["cancelar_assinatura", "regularizacao_financeira", "corrigir_endereco"] as const;
export interface Todo {
  type: (typeof TODO_TYPES)[number];
  text: string;
  created_at: string;
  done: boolean;
  done_at?: string | null;
}

const Schema = z.object({
  promises: z
    .array(z.object({ type: z.enum(TODO_TYPES), text: z.string().describe("Em PT-BR, 1 frase, a AÇÃO que a equipe tem que executar fora do e-mail (ex.: 'Cancelar a assinatura Cure Continue de Marie (pedido #3227)', 'Solicitar ao financeiro a regularização de 48 €')") }))
    .describe("SÓ três tipos entram: (1) cancelar a assinatura do cliente; (2) reembolso / regularização financeira prometida ou dita como já solicitada; (3) corrigir/atualizar o endereço de entrega do pedido, quando o e-mail diz que a equipe vai anotar/atualizar um endereço diferente do que está registrado. Acompanhar envio, reenviar, mandar recibo, contatar correios NÃO entram. No máximo um item de cada tipo. Lista vazia se não houver"),
});

// Lê a resposta que ACABOU de ser enviada e tira dela o que foi prometido e
// precisa ser executado à mão (cancelar assinatura, pedir reembolso…).
export async function extractPromises(sentText: string): Promise<Array<{ type: Todo["type"]; text: string }>> {
  const r = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: "Você lê um e-mail de suporte enviado por uma loja e procura só TRÊS coisas que a loja prometeu ou disse já ter feito e que precisam ser executadas manualmente: cancelar a assinatura do cliente; reembolsar / fazer a regularização financeira (com o valor, se o e-mail disser — mas o e-mail não deveria conter valor); e corrigir o endereço de entrega (com o endereço novo, se o e-mail disser). Se o e-mail diz 'já cancelamos', 'já solicitamos ao financeiro' ou 'a equipe vai atualizar o endereço', isso É uma ação a executar.",
    input: sentText.slice(0, 8000),
    text: { format: zodTextFormat(Schema, "promises") },
  });
  recordUsage(OPENAI_MODEL, r.usage);
  return r.output_parsed?.promises ?? [];
}
