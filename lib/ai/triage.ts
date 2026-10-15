import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { OPENAI_MODEL } from "@/lib/ai/openai-agent";
import { TOPICS } from "@/lib/ai/context-meta";
import { recordUsage } from "@/lib/ai/usage";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Passo 1 da resposta: LER o e-mail. Barato e rápido; o resultado decide
// qual produto, quais contextos e quais fatos entram no passo 2 (redação).
const TriageSchema = z.object({
  language: z.string().describe("Código ISO de 2 letras do idioma da ÚLTIMA mensagem do cliente: fr, en, he, tr, de, hu, pt, es, it, nl, ar, ru..."),
  customer_name: z.string().nullable().describe("Primeiro nome do cliente: da assinatura/texto, ou do próprio endereço quando é evidente (sukranefe1977@ → Şükran; francegirard@ → France). null só se realmente não der"),
  product_hint: z.string().nullable().describe("Produto ou marca de que o cliente fala, como ele escreveu (ex.: 'creme', 'Olavita', 'gélules moringa'). null se não citar"),
  product_kind: z.enum(["creme_cosmetico", "capsulas_suplemento", "outro", "desconhecido"]).describe("Tipo de produto citado"),
  topics: z.array(z.enum(TOPICS)).describe("Todos os temas tratados nos e-mails do cliente, incluindo mensagens antigas do histórico"),
  topics_latest: z.array(z.enum(TOPICS)).describe("SÓ os temas da ÚLTIMA mensagem do cliente (a mais recente) — não conta tema que só apareceu em mensagens antigas do histórico"),
  stated_days_since_purchase: z.number().nullable().describe("Se o cliente disse há quanto tempo comprou/espera (ex.: 'faz 5 dias'), o número de dias. null se não disse"),
  purchase_date_iso: z.string().nullable().describe("Data da compra (AAAA-MM-DD) que o cliente informou em QUALQUER mensagem, direta ou indiretamente, calculada pela data da mensagem em que ele disse: mensagem de 18/09/2026 dizendo 'faz 5 dias que comprei' → 2026-09-13; 'comprei dia 3 de setembro' → 2026-09-03. null se nunca informou"),
  order_numbers: z.array(z.string()).describe("Números de pedido citados"),
  chargeback_open: z.boolean().describe("true se o cliente diz que ABRIU (ou já fez) contestação/oposição no banco, chargeback, litige bancaire, ou se o histórico mostra aviso de contestação. Só ameaçar não conta"),
  chargeback_date_iso: z.string().nullable().describe("Data (AAAA-MM-DD) em que a contestação foi aberta, se der pra saber pelas mensagens; senão null"),
  purchase_not_completed: z.boolean().describe("true SÓ se o cliente desistiu da compra ou nega ter feito qualquer pedido/compra (ex.: 'desisti disso', 'eu não fiz pedido nenhum', 'eu nem quero comprar', 'não reconheço essa cobrança, nunca comprei'). NÃO marque quando ele tentou pagar e não conseguiu: isso é payment_failed"),
  payment_failed: z.boolean().describe("true se o cliente QUER comprar mas não conseguiu pagar: pagamento recusado, 'o sistema não aceita meu pagamento', 'não consegui pagar', 'não consigo fechar o pedido', pergunta outra forma de pagar porque a dele não funcionou. Ele ainda quer comprar"),
  explicit_refund_request: z.boolean().describe("true SÓ se o cliente escreveu claramente que quer o dinheiro de volta (remboursement, refund, 'quero meu dinheiro', estorno). Reclamar, cancelar assinatura, ameaçar ou dizer que não quer mais receber NÃO conta"),
  subscription_denied: z.boolean().describe("true se o cliente nega ter assinado / pedido uma assinatura ('eu não assinei', 'eu não quero assinatura'), OU diz que recebeu um e-mail/aviso informando que vai virar assinatura ou ser cobrado de novo, sem ter mandado prova concreta disso (print, e-mail encaminhado). false se ele já é assinante reconhecido pedindo pra cancelar algo que ele sabe que tem"),
  says_received: z.boolean().describe("true se a ÚLTIMA mensagem (ou uma recente) diz que o pacote/pedido JÁ CHEGOU ou já está com o cliente: 'recebi hoje', 'chegou', 'abri a caixa', 'retirei no ponto', 'recebi 4 cremes', 'o creme que veio é de pescoço', foto do produto recebido. false se ainda está esperando ou se não fala disso"),
  threat: z.boolean().describe("Ameaça de advogado, processo, contestação no banco/cartão, denúncia, polícia, avaliação pública — em qualquer idioma"),
  anger: z.number().int().min(1).max(5).describe("1 tranquilo … 5 furioso"),
  question_pt: z.string().describe("Em 1 frase PT-BR: a pergunta/cobrança principal que a resposta TEM que resolver"),
});
export type Triage = z.infer<typeof TriageSchema>;

export async function triageEmail(input: { latest: string; latestDate?: string; history: string; customerEmail?: string }): Promise<Triage | null> {
  try {
    const r = await client.responses.parse({
      model: OPENAI_MODEL,
      instructions: "Você lê e-mails de clientes de lojas online e extrai os dados pedidos, sem inventar. Considere a última mensagem e o histórico resumido.",
      input: `E-MAIL DO CLIENTE: ${input.customerEmail ?? "?"}\nHOJE: ${new Date().toISOString().slice(0, 10)}\n\nÚLTIMA MENSAGEM (enviada em ${input.latestDate ?? "?"}):\n${input.latest.slice(0, 5000)}\n\nHISTÓRICO (mais antigo → mais novo):\n${input.history.slice(-7000)}`,
      text: { format: zodTextFormat(TriageSchema, "triage") },
    });
    recordUsage(OPENAI_MODEL, r.usage);
    return r.output_parsed ?? null;
  } catch (err) {
    console.error("triage falhou:", (err as Error).message);
    return null;
  }
}
