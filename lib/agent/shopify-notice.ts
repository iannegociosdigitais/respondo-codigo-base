import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { recordUsage } from "@/lib/ai/usage";

// E-mail da própria Shopify: só o que EXIGE AÇÃO do dono é prioridade 1 no
// Inbox. Pagamento de payout, resumo semanal, parabéns, configuração mudou,
// app aprovado, marketing... são informativos e viram spam interno.
// Regra do Ian (13/10/2026): ler o conteúdo e decidir; ação necessária sempre
// aparece primeiro.
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const NANO = process.env.OPENAI_MODEL_NANO || "gpt-5.4-nano";

export interface NoticeVerdict {
  action: boolean;
  summary_pt: string;
  deadline_pt: string | null;
  by: "regra" | "ia" | "falha";
}

// Informativo conhecido (nunca exige ação).
const INFO = /^(payout for|in the bag|congratulations|parab[ée]ns|your store is now|sua loja agora|as configura[cç][õo]es foram alteradas|settings (were )?changed|recurring charge approved|shopify enabled|sua identidade foi verificada|your identity (was|has been) verified|welcome|bem-vindo|tudo pronto|n[ãa]o se esque[cç]a|o pr[óo]ximo passo|confira os pre[cç]os|veja como|voc[êe] est[áa] mais perto|alcance milh|milh[õo]es de|new order|nova encomenda|order #?\d+ (placed|confirmed)|shopify plus support chat logged|[a-z]{3} \d{1,2}, \d{4} bill for)/i;

// Exige ação ou é grave (sempre aparece em primeiro).
const ACTION = /(action required|a[cç][ãa]o necess[áa]ria|payment (failed|declined)|bill payment failed|overdue|past due|suspend|restrict|deactivat|closure|violation|dispute|chargeback|inquiry for order|n[ãa]o foi poss[íi]vel verificar|unable to verify|verification (failed|required)|verify your|confirm your|account (review|hold)|risk|compliance|terms of service|expir(e|ing)|final notice|last chance|reply required|requires? (your )?(action|approval|attention)|needs your approval)/i;

const Schema = z.object({
  action_required: z.boolean().describe("true SÓ se o dono da loja precisa fazer algo (pagar, verificar, responder, aprovar, corrigir, aceitar prazo) ou se há risco para a conta/pagamentos/conformidade. false para pagamento de payout recebido, resumo, parabéns, novidade de produto, marketing, configuração alterada, app instalado/aprovado, confirmação de algo que já deu certo"),
  summary_pt: z.string().describe("1 frase em PT-BR: o que a Shopify está dizendo e o que o dono precisa fazer"),
  deadline_pt: z.string().nullable().describe("Prazo para agir, em PT-BR, se o e-mail disser (ex.: 'até 15/10'); senão null"),
});

export async function classifyShopifyNotice(fromAddress: string, subject: string, body: string | null): Promise<NoticeVerdict> {
  const subj = (subject ?? "").trim();
  const from = fromAddress.trim().toLowerCase();
  // Remetentes de risco/cobrança: padrão é MOSTRAR, menos o que é claramente informativo.
  const sensitive = /^(risk-operations|billing|compliance|payments?|legal|support|plusspecialists)@/.test(from);
  if (INFO.test(subj) && !ACTION.test(subj)) return { action: false, summary_pt: "Aviso informativo da Shopify.", deadline_pt: null, by: "regra" };
  if (/^(payout for|in the bag)/i.test(subj)) return { action: false, summary_pt: "Aviso informativo da Shopify.", deadline_pt: null, by: "regra" };

  try {
    const r = await client.responses.parse({
      model: NANO,
      instructions: "Você lê e-mails que a Shopify mandou ao dono de uma loja online e decide se exigem AÇÃO dele. Na dúvida sobre risco, pagamento ou conta, marque action_required = true. Não invente prazo.",
      input: `Remetente: ${fromAddress}\nAssunto: ${subj}\n\n${(body ?? "").slice(0, 2500)}`,
      text: { format: zodTextFormat(Schema, "notice") },
    });
    recordUsage(NANO, r.usage);
    const p = r.output_parsed;
    // Remetente de risco/cobrança/suporte: na dúvida o aviso FICA (payout em
    // hold, conta em revisão... é importante mesmo "sem ação" imediata).
    if (p) return { action: p.action_required || sensitive || ACTION.test(subj), summary_pt: p.summary_pt, deadline_pt: p.deadline_pt, by: "ia" };
  } catch (err) {
    console.error("shopify-notice:", (err as Error).message);
  }
  // Falha da IA: fica visível (melhor um aviso a mais que perder um importante).
  return { action: true, summary_pt: `Aviso da Shopify: ${subj}`, deadline_pt: null, by: "falha" };
}
