import { AsyncLocalStorage } from "node:async_hooks";

// Consumo da OpenAI por resposta gerada. Preços oficiais em USD por 1M de
// tokens (developers.openai.com/api/docs/pricing, conferidos em 18/09/2026).
// Trocar aqui se a OpenAI mudar a tabela.
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
};

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  by_model: Record<string, number>;
}

const empty = (): UsageTotals => ({ calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0, by_model: {} });
const storage = new AsyncLocalStorage<UsageTotals>();

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

// Chamado depois de CADA resposta da OpenAI (triagem, redação, tradução).
export function recordUsage(model: string, usage: RawUsage | null | undefined) {
  const t = storage.getStore();
  if (!t || !usage) return;
  const price = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ""] ?? PRICES["gpt-5.4-mini"];
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  const cost = (input * price.input + cached * price.cached + output * price.output) / 1_000_000;
  t.calls += 1;
  t.input_tokens += input;
  t.cached_tokens += cached;
  t.output_tokens += output;
  t.cost_usd += cost;
  t.by_model[model] = (t.by_model[model] ?? 0) + cost;
}

// Roda `fn` somando o consumo de todas as chamadas feitas dentro dele.
export async function trackUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: UsageTotals }> {
  const totals = empty();
  const result = await storage.run(totals, fn);
  return { result, usage: { ...totals, cost_usd: Number(totals.cost_usd.toFixed(6)) } };
}

export function addUsage(prev: Partial<UsageTotals> | null | undefined, now: UsageTotals): UsageTotals {
  const p = { ...empty(), ...(prev ?? {}) };
  const by_model = { ...p.by_model };
  for (const [m, c] of Object.entries(now.by_model)) by_model[m] = Number(((by_model[m] ?? 0) + c).toFixed(6));
  return {
    calls: p.calls + now.calls,
    input_tokens: p.input_tokens + now.input_tokens,
    cached_tokens: p.cached_tokens + now.cached_tokens,
    output_tokens: p.output_tokens + now.output_tokens,
    cost_usd: Number((p.cost_usd + now.cost_usd).toFixed(6)),
    by_model,
  };
}
