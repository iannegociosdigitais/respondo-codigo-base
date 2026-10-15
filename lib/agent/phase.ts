import type { AgentDecision } from "@/lib/ai/openai-agent";

// Fase do cliente, calculada em código (nunca pelo modelo):
// 1 = ansiedade inicial (até 15 dias, primeiro contato)
// 2 = insatisfação logística (15–30 dias ou já cobrou antes)
// 3 = risco (mais de 30 dias, ameaça, contestação ou pedido de reembolso)
// 4 = susto da assinatura (cobrança de renovação)
export type Phase = 1 | 2 | 3 | 4;

// 'prélèvement' (débito) saiu: cliente que reclama de cobrança não está
// falando de assinatura, e a IA passava a explicar assinatura sem ele pedir.
const SUBSCRIPTION = /abonnement|renouvellement|subscription|renewal|recurring|cure continue|assinatura|מנוי|חיוב חוזר/i;

export function computePhase(input: {
  decision: AgentDecision;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  inboundCount: number;
  orderCreatedAt?: string | null;
  fulfilledAt?: string | null;
  bodies: string[];
}): Phase {
  const d = input.decision;
  if (d.mentions_threat || d.wants_refund || d.anger_level >= 5) return 3;
  const text = input.bodies.join("\n");
  if (SUBSCRIPTION.test(text) || d.category === "edicao_pedido" && /abonnement|subscription|מנוי/i.test(text)) return 4;

  const ref = input.fulfilledAt ?? input.orderCreatedAt ?? input.firstInboundAt;
  const days = ref ? Math.floor((Date.now() - new Date(ref).getTime()) / 86400000) : 0;
  if (days > 30) return 3;
  if (days > 15 || input.inboundCount >= 2) return 2;
  return 1;
}

export const PHASE_LABEL: Record<number, string> = {
  1: "Fase 1 · ansiedade inicial",
  2: "Fase 2 · atraso / cobrou de novo",
  3: "Fase 3 · risco (ameaça, reembolso, +30d)",
  4: "Fase 4 · assinatura",
};

// Sinais de risco no texto do cliente (antes da análise do modelo): ameaça,
// contestação, estorno, advogado, avaliação negativa.
const RISK = /chargeback|contestation|litige|avocat|lawyer|attorney|plainte|police|fraud|arnaque|scam|escroquerie|rembours|refund|remboursement|dispute|banque|bank|avis n[ée]gatif|trustpilot|signaler|signalement|החזר|ביטול עסקה|תלונה|עורך דין|betrug|anwalt|rückerstattung|csalás|ügyvéd|visszatérítés|dolandırıcı|iade/i;

// Fase calculada ANTES de chamar o modelo, só com datas, contagem e texto —
// vai no prompt pra IA responder do jeito certo pra fase.
export function preliminaryPhase(input: {
  firstInboundAt: string | null;
  inboundCount: number;
  orderCreatedAt?: string | null;
  fulfilledAt?: string | null;
  bodies: string[];
}): Phase {
  const text = input.bodies.join("\n");
  if (RISK.test(text)) return 3;
  if (SUBSCRIPTION.test(text)) return 4;
  const ref = input.fulfilledAt ?? input.orderCreatedAt ?? input.firstInboundAt;
  const days = ref ? Math.floor((Date.now() - new Date(ref).getTime()) / 86400000) : 0;
  if (days > 30) return 3;
  if (days > 15 || input.inboundCount >= 2) return 2;
  return 1;
}

// O que muda na resposta em cada fase (as regras detalhadas de cada fase
// vêm do contexto da loja; isto é o enquadramento obrigatório).
export const PHASE_GUIDE: Record<Phase, string> = {
  1: "Fase 1 (ansiedade inicial, até 15 dias, primeiro contato): tranquilizar com confiança. Agradecer pela compra, confirmar que o pedido foi despachado no prazo (1 a 3 dias úteis após a compra), dizer há quantos dias úteis ele foi enviado e quantos dias úteis ainda faltam para chegar (prazo total de 9 a 12 dias úteis após o envio), reforçar que a equipe acompanha de perto. Nada de justificativa longa: ainda está tudo dentro do normal.",
  2: "Fase 2 (15–30 dias ou cliente já cobrou antes): reconhecer a espera e agradecer a paciência, explicar a situação com os fatos reais do pedido e do que já foi dito antes (não repetir a mesma resposta da fase 1), dar uma nova estimativa concreta e mostrar acompanhamento ativo ('eu mesma estou acompanhando'). Usar as regras da fase 2 do contexto da loja.",
  3: "Fase 3 (mais de 30 dias, ameaça, contestação ou pedido de regularização): máxima empatia e seriedade, sem defensiva. Assumir a situação, recapitular tudo o que aconteceu, pedir desculpas pela experiência, apresentar a solução concreta da política da loja para esse caso (regularização financeira / crédito / reenvio conforme o contexto), e negociar com calma se houver contestação. Usar as regras da fase 3 do contexto da loja e o vocabulário permitido.",
  4: "Fase 4 (assinatura / cobrança de renovação): explicar com clareza e gentileza o que é a assinatura, como foi contratada, e resolver o que o cliente pede (pausar, cancelar, regularizar) conforme a política da loja, sem julgamento.",
};

export function phaseInstruction(phase: Phase): string {
  return `FASE ATUAL DO CLIENTE: ${PHASE_LABEL[phase]}. ${PHASE_GUIDE[phase]}`;
}
