import { decide, probabilityOf, type DecisionQuestion } from "@/lib/ai/decisions";

// Pedido de PARADA em qualquer idioma, lido pela Decisions API (~0,3 s).
// As palavras de parada do webhook (isStopMessage) só valem no começo da
// mensagem e pegaram 8 de 27 frases reais nos testes ("בבקשה תפסיקו לשלוח לי",
// "please stop messaging me", "не пишите мне больше" passavam direto); com a
// API a rede pega 25 a 26 de 27, sem falso positivo em 60 frases parecidas
// (scripts/agent-sim/eval-signals.ts). Só ENTRA para parar com certeza alta;
// falhou ou ficou em dúvida, vale o que já existia (palavra + o agente).
//
// A API também foi testada para "já paguei" e para a intenção da mensagem
// (roteiro) e NÃO foi ligada: na simulação (72 conversas) a intenção forçou o
// texto fixo do roteiro em cima de perguntas específicas de preço ("כמה יוצא
// בסוף?") e o "já paguei" tratou pedido de reembolso ("fiz um pedido e quero
// meu dinheiro de volta") como pagamento a conferir.
export const STOP_THRESHOLD = 0.9;

const STOP_QUESTION: DecisionQuestion = {
  type: "predicate",
  name: "wants_stop",
  instructions:
    "Does the customer explicitly ask the assistant to stop messaging her, to remove her from the list, to unsubscribe, or never to contact her again? A polite 'not interested', 'not now', 'no thanks', 'I am busy' or 'I will think about it' is NOT a stop request.",
};

const CONTEXT = "A sales assistant from an online skincare store is chatting on WhatsApp with a customer who left a cart without paying. The customer may write in any language (mostly Hebrew).";

// 0 a 1; null = a API não respondeu (sem crédito, timeout, fora do ar).
export async function stopProbability(customerMessage: string, lastAgentMessage?: string | null, opts: { timeoutMs?: number } = {}): Promise<number | null> {
  const message = customerMessage.trim();
  if (!message) return null;
  const agent = (lastAgentMessage ?? "").replace(/https?:\/\/\S+/g, "[link]").trim().slice(0, 600);
  const input = [CONTEXT, agent ? `Assistant's last message: """${agent}"""` : null, `Customer's reply: """${message.slice(0, 800)}"""`].filter(Boolean).join("\n");
  return probabilityOf(await decide(input, [STOP_QUESTION], opts), "wants_stop");
}
