// Prazos calculados em CÓDIGO (dias úteis), nunca pelo modelo.
// Regra do contexto da loja (bloco de prazos do Ian): o dia da compra NÃO
// conta. Compra na sexta, sábado ou domingo → seg (1), ter (2), qua (3).
const DAY = 86400000;
const isBusiness = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

// n-ésimo dia útil contando a partir de `start` (inclusive se for dia útil).
export function nthBusinessDay(start: Date, n: number): Date {
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let count = isBusiness(d) ? 1 : 0;
  while (count < n) {
    d = new Date(d.getTime() + DAY);
    if (isBusiness(d)) count += 1;
  }
  return d;
}

// n dias úteis DEPOIS de `start` (o dia do envio não conta).
export function addBusinessDays(start: Date, n: number): Date {
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let count = 0;
  while (count < n) {
    d = new Date(d.getTime() + DAY);
    if (isBusiness(d)) count += 1;
  }
  return d;
}

export function businessDaysBetween(a: Date, b: Date): number {
  let d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const end = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  let count = 0;
  while (d.getTime() < end) {
    d = new Date(d.getTime() + DAY);
    if (isBusiness(d)) count += 1;
  }
  return count;
}

const WEEK = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const fmt = (d: Date) => `${WEEK[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

export interface DeadlineRule {
  prepDays: number; // dias úteis de preparação
  minDays: number; // dias úteis de entrega após o envio
  maxDays: number;
}

export interface DeadlineFacts {
  text: string;
  stage: "preparacao" | "sem_envio" | "a_caminho" | "janela_de_chegada" | "apos_janela";
  shipBy: string;
  windowStart: string;
  windowEnd: string;
}

export function computeDeadline(input: { purchasedAt: string; purchaseIsEstimate: boolean; shippedAt?: string | null; rule: DeadlineRule; now?: Date }): DeadlineFacts {
  const now = input.now ?? new Date();
  const purchase = new Date(input.purchasedAt);
  const shipBy = addBusinessDays(purchase, input.rule.prepDays);
  const shipped = input.shippedAt ? new Date(input.shippedAt) : null;
  const shipRef = shipped ?? shipBy;
  const start = addBusinessDays(shipRef, input.rule.minDays);
  const end = addBusinessDays(shipRef, input.rule.maxDays);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Sem envio registrado e já passou da preparação: NÃO fingir que saiu.
  // (Antes contava o prazo a partir de um envio imaginário e a IA escrevia
  // "foi enviado há 8 dias úteis" para pedido parado por falta de telefone.)
  const stage: DeadlineFacts["stage"] = !shipped ? (today < shipBy ? "preparacao" : "sem_envio") : today < start ? "a_caminho" : today <= end ? "janela_de_chegada" : "apos_janela";
  const sinceShip = shipped || today >= shipBy ? businessDaysBetween(shipRef, today) : 0;
  const sincePurchase = businessDaysBetween(purchase, today);
  const prepLeft = Math.max(0, businessDaysBetween(today, shipBy));
  // Quanto FALTA, em dias úteis, contado de hoje (regra do Ian, 05/10: não
  // repetir "9 a 12 dias úteis" como se o pedido tivesse saído hoje. Se
  // saiu há 6 dias úteis, faltam de 3 a 6).
  const leftMin = Math.max(0, input.rule.minDays - sinceShip);
  const leftMax = Math.max(0, input.rule.maxDays - sinceShip);
  const plural = (n: number) => (n === 1 ? "1 dia útil" : `${n} dias úteis`);
  const sayText = {
    preparacao: `o pedido foi feito ${sincePurchase === 0 ? "hoje" : `há ${plural(sincePurchase)}`} e está na preparação, que leva até ${input.rule.prepDays} dias úteis${prepLeft > 0 ? ` (falta(m) até ${plural(prepLeft)})` : ""}; depois do envio, a entrega leva de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis.`,
    // 9 a 12 é a MÉDIA, não um limite (regra do Ian, 08/10): nunca "chega
    // amanhã" / "em 1 dia útil" / "a qualquer momento", quase nunca acontece.
    a_caminho: leftMin <= 1
      ? `o pedido foi enviado há ${plural(sinceShip)}; a entrega leva em média de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis, então está dentro do prazo e deve chegar nos próximos dias. NÃO diga "amanhã", "em 1 dia útil" nem "a qualquer momento".`
      : `o pedido foi enviado há ${plural(sinceShip)}; como a entrega leva em média de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis, ele deve chegar nos próximos ${leftMin} a ${plural(leftMax)}.`,
    janela_de_chegada: `o pedido foi enviado há ${plural(sinceShip)} e já está na reta final; o prazo médio é de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis, então deve chegar nos próximos dias. O prazo é uma média, não um limite: NUNCA diga "amanhã", "em 1 dia útil", "a qualquer momento" nem um número de dias que falta.`,
    sem_envio: `o pedido está confirmado e ainda não saiu para envio. NÃO diga que foi enviado nem conte prazo de chegada a partir de um envio. Se faltar telefone ou endereço no pedido, é isso que segura o envio: explique e peça o dado. Depois que sair, a entrega leva de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis.`,
    apos_janela: `o pedido foi enviado há ${plural(sinceShip)}, mais que a média de ${input.rule.minDays} a ${input.rule.maxDays} dias úteis. Diga que é muito estranho ainda não ter chegado e peça desculpas pela demora dos correios; explique que, para todo pedido que passa de ${input.rule.maxDays} dias úteis, a nossa equipe entra em contato com os correios manualmente para cobrar uma análise, e que você já está fazendo isso pelo pedido dele e volta com retorno. Não dê nova previsão nem data.`,
  }[stage];
  const stageText = {
    preparacao: `EM PREPARAÇÃO (dentro do prazo de até ${input.rule.prepDays} dias úteis). (Uso interno, NÃO escrever ao cliente: envio até ${fmt(shipBy)}.)`,
    sem_envio: `AINDA NÃO ENVIADO: passou do prazo de preparação (${input.rule.prepDays} dias úteis) e não há envio registrado. Não diga que foi enviado.`,
    a_caminho: `ENVIADO E A CAMINHO (dentro do prazo): ${sinceShip} dia(s) útil(eis) desde o envio.`,
    janela_de_chegada: `NA RETA FINAL (dentro do prazo): ${sinceShip} dia(s) útil(eis) desde o envio, de um prazo de ${input.rule.minDays} a ${input.rule.maxDays} (média, não limite); nunca prometer 'amanhã'.`,
    apos_janela: `PASSOU DO PRAZO (${sinceShip} dias úteis desde o envio, prazo de ${input.rule.minDays} a ${input.rule.maxDays}): não dê nova previsão nem data. Diga que a situação realmente está estranha, que você vai analisar o caso, entrar em contato com todas as agências e a transportadora e resolver o problema dele, e que volta com retorno.`,
  }[stage];
  const text = [
    `Compra: ${fmt(purchase)}${input.purchaseIsEstimate ? " (data estimada pelo que o cliente disse)" : ""}.`,
    `Preparação: até ${input.rule.prepDays} dia(s) útil(eis) a partir do dia útil seguinte à compra${shipped ? ` → envio FEITO em ${fmt(shipped)} (pode dizer ao cliente)` : " → ainda não consta envio (NÃO dizer data de envio futura)"}.`,
    `Entrega: ${input.rule.minDays} a ${input.rule.maxDays} dias úteis após o envio. (Uso interno, NÃO escrever ao cliente: janela ${fmt(start)} → ${fmt(end)}.)`,
    `Hoje é ${fmt(today)}. Etapa atual: ${stageText}`,
    sayText
      ? `O QUE DIZER AO CLIENTE (já calculado, use estes números): ${sayText}${shipped ? ` NÃO repita só "${input.rule.minDays} a ${input.rule.maxDays} dias úteis" como se o pedido tivesse saído hoje: diga há quanto tempo foi enviado e quantos dias úteis ainda faltam, pra tranquilizar.` : ""}`
      : "",
    "Ao cliente: só prazos em DIAS ÚTEIS e datas do passado; nunca uma data futura. Fins de semana não contam.",
  ].filter(Boolean).join("\n");
  return { text, stage, shipBy: fmt(shipBy), windowStart: fmt(start), windowEnd: fmt(end) };
}
