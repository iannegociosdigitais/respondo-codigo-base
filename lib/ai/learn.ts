import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LearnSchema = z.object({
  worth_learning: z.boolean().describe("false se a edição foi só cosmética (vírgula, sinônimo, encurtar sem mudar o sentido)"),
  situation_summary: z.string().describe("Em PT-BR, 1 frase: a situação do cliente"),
  guidance: z.string().describe("Em PT-BR, a regra que a loja aplicou ao corrigir: o que dizer/não dizer nesse tipo de caso, concreto"),
});

export type LearnedRule = z.infer<typeof LearnSchema>;

// Compara o rascunho da IA com o que a pessoa realmente enviou e extrai a
// regra por trás da correção — vira contexto pra casos parecidos, sem
// ninguém precisar preencher formulário.
export async function learnFromEdit(params: {
  customerMessagePt: string;
  draftPt: string;
  finalPt: string;
  category: string | null;
}): Promise<LearnedRule | null> {
  const a = params.draftPt.replace(/\s+/g, " ").trim();
  const b = params.finalPt.replace(/\s+/g, " ").trim();
  if (a === b) return null;

  const response = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: [
      "Uma pessoa da loja corrigiu o rascunho que a IA escreveu antes de enviar ao cliente. Descubra O QUE mudou de substância e formule a regra que a loja quer seguir daqui pra frente.",
      "Ignore mudanças puramente cosméticas. Foque em: informação nova, promessa removida/adicionada, tom, o que a loja NÃO quer dizer.",
    ].join("\n"),
    input: [
      `Categoria: ${params.category ?? "?"}`,
      `Mensagem do cliente (PT-BR):\n${params.customerMessagePt}`,
      `Rascunho da IA (PT-BR):\n${params.draftPt}`,
      `O que foi enviado de verdade (PT-BR):\n${params.finalPt}`,
    ].join("\n\n"),
    text: { format: zodTextFormat(LearnSchema, "learned_rule") },
  });

  const parsed = response.output_parsed;
  if (!parsed || !parsed.worth_learning) return null;
  return parsed;
}

const ContextChatSchema = z.object({
  reply_to_user: z.string().describe("Resposta conversacional em PT-BR: confirme o que entendeu e pergunte só o que faltar"),
  contexts: z.array(
    z.object({
      label: z.string().describe("Rótulo curto. Ex: 'Objeção: pedido atrasado', 'Política: troca', 'Produto: dosagem'"),
      content: z.string().describe("O que a IA deve saber/fazer, com todo o detalhe que a pessoa deu, em PT-BR"),
    })
  ).describe("Blocos NOVOS extraídos desta mensagem do usuário. Vazio se nada novo."),
});

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Página "Contexto com Objeções": a pessoa conversa e o GPT vai
// transformando em blocos de contexto salvos — sem formulário.
export async function extractContextsFromChat(history: ChatTurn[], existingLabels: string[]) {
  const response = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: [
      "Você ajuda a montar a base de conhecimento de atendimento de uma loja. A pessoa vai contando regras, objeções, políticas, prazos, produtos, tom de voz — em linguagem natural.",
      "Extraia cada regra/objeção/informação em um bloco (label + content). Não resuma a ponto de perder detalhe. Não invente nada.",
      `Blocos que já existem (não duplique, só complemente se houver informação nova): ${existingLabels.join("; ") || "nenhum"}.`,
      "Se a mensagem for só uma pergunta ou conversa, contexts fica vazio e você responde normalmente.",
    ].join("\n"),
    input: history.map((h) => ({ role: h.role, content: h.content })),
    text: { format: zodTextFormat(ContextChatSchema, "context_chat") },
  });
  const parsed = response.output_parsed;
  if (!parsed) throw new Error("OpenAI não retornou extração de contexto.");
  return parsed;
}
