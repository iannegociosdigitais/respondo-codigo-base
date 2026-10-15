import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";
import { recordUsage } from "@/lib/ai/usage";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TranslationSchema = z.object({
  translated: z.string().describe("Texto traduzido, mantendo tom, quebras de linha e assinatura"),
});

export function isPortuguese(language: string | null): boolean {
  if (!language) return true;
  const v = language.trim().toLowerCase();
  return v.startsWith("pt") || v.includes("portug");
}

// Você lê e escreve em português no Inbox; antes de enviar, traduzimos de
// volta pro idioma do cliente. Ele nunca recebe PT-BR se escreveu em outro.
export async function translateReplyForCustomer(replyPt: string, customerLanguage: string | null): Promise<string> {
  if (isPortuguese(customerLanguage)) return replyPt;

  const response = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: [
      `Traduza de português do Brasil para o idioma: ${customerLanguage}, como um nativo escrevendo um e-mail de suporte.`,
      "Mantenha tom, quebras de linha e assinatura. Não adicione comentários.",
      "Idiomas com outro alfabeto (hebraico, árabe, russo, grego…): escreva o primeiro nome do cliente e o nome de quem assina nesse alfabeto (Netta → נטע, Mia → מיה); número de pedido, marca e e-mails ficam como estão.",
      "Fecho: use a despedida profissional e calorosa natural do idioma (hebraico 'בברכה חמה', francês 'Chaleureusement', inglês 'Warm regards'). Nunca traduza 'Com carinho' ao pé da letra como 'com amor'.",
    ].join("\n"),
    input: replyPt,
    text: { format: zodTextFormat(TranslationSchema, "translation") },
  });
  recordUsage(OPENAI_MODEL, response.usage);
  const parsed = response.output_parsed;
  if (!parsed) throw new Error("OpenAI não retornou a tradução da resposta.");
  return parsed.translated;
}

export async function translateToPortuguese(text: string, sourceLanguage?: string | null): Promise<string> {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  const attempts = [
    "Traduza o e-mail a seguir INTEIRO para português do Brasil, fielmente, mantendo quebras de linha: inclusive a saudação, a primeira frase, a despedida e a assinatura (nomes próprios e nome da loja ficam iguais). Nenhuma frase pode ficar no idioma original.",
    `O e-mail abaixo está em ${sourceLanguage || "outro idioma (não português)"}. Sua única tarefa é devolver a tradução COMPLETA em português do Brasil — nunca devolva o texto original. Mantenha quebras de linha, nomes próprios e o nome da loja.`,
  ];
  let last = text;
  for (const instructions of attempts) {
    const response = await client.responses.parse({
      model: OPENAI_MODEL,
      instructions,
      input: text,
      text: { format: zodTextFormat(TranslationSchema, "translation") },
    });
    recordUsage(OPENAI_MODEL, response.usage);
    const parsed = response.output_parsed;
    if (!parsed) throw new Error("OpenAI não retornou a tradução.");
    last = parsed.translated;
    if (norm(last) !== norm(text)) return last;
  }
  return last;
}

// "Tradução" que ainda está no idioma original: alfabeto não latino,
// texto igual ao original, ou sem marcadores de português.
export function looksUntranslated(original: string, pt: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(original);
  const b = norm(pt);
  if (!b) return true;
  if (/[\u0590-\u06FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(b)) return true;
  if (a === b || a.slice(0, 120) === b.slice(0, 120)) return true;
  const markers = [" você", " voce", " seu ", " sua ", " não ", " nao ", " para ", " com ", "obrigad", "olá", "ola,", " que ", " está", " esta ", " pedido", " já ", " então"];
  const hits = markers.filter((m) => b.includes(m)).length;
  if (hits < 2) return true;
  // Tradução pela metade: saudação/abertura ficou no idioma original.
  const foreign = ["bonjour", " je ", " vous", " votre", "chaleureusement", "cordialement", "hello ", " you ", " your ", "warmly", "sincerely", "guten tag", " ihre "];
  const foreignHits = foreign.filter((m) => b.includes(m)).length;
  return foreignHits >= 2;
}
