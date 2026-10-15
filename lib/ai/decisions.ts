// Cliente mínimo da Decisions API da OpenAI (POST /v1/decisions, beta): responde
// perguntas tipadas sobre um texto (probabilidade de uma condição, escolha entre
// opções fixas, nota de uma régua) em ~0,3 s. Serve para classificar e
// encaminhar mensagens, não para escrever resposta (isso continua no modelo do
// vendedor).
//
// Falha ABERTO: qualquer erro (sem crédito, timeout, API fora, resposta fora
// do formato) devolve null e quem chamou segue com o caminho que já existia.
// DECISIONS_DISABLED=1 no ambiente desliga tudo. DECISIONS_MODEL troca o modelo.
const ENDPOINT = "https://api.openai.com/v1/decisions";
const MODEL = process.env.DECISIONS_MODEL?.trim() || "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 4_000;

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: Array<{ value: string; description: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description: string }> };

export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string; probabilities: Array<{ value: string; probability: number }>; confidence: number }
  | { type: "score"; name: string; score: number; confidence: number }
  | { type: "refusal"; name: string };

export const decisionsEnabled = (): boolean => process.env.DECISIONS_DISABLED !== "1" && Boolean(process.env.OPENAI_API_KEY);

let lastWarnAt = 0;
function warnOnce(msg: string): void {
  if (Date.now() - lastWarnAt < 60_000) return;
  lastWarnAt = Date.now();
  console.warn(`decisions: ${msg}`);
}

// As respostas vêm por nome (`name` de cada pergunta). Pergunta recusada fica fora do mapa.
export async function decide(input: string, questions: DecisionQuestion[], opts: { timeoutMs?: number } = {}): Promise<Record<string, DecisionAnswer> | null> {
  if (!decisionsEnabled() || !input.trim() || questions.length === 0) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      warnOnce(`HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { answers?: DecisionAnswer[] };
    if (!Array.isArray(data.answers)) {
      warnOnce("resposta sem answers");
      return null;
    }
    const out: Record<string, DecisionAnswer> = {};
    for (const a of data.answers) if (a && typeof a.name === "string" && a.type !== "refusal") out[a.name] = a;
    return out;
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export const probabilityOf = (answers: Record<string, DecisionAnswer> | null, name: string): number | null => {
  const a = answers?.[name];
  return a && a.type === "predicate" && Number.isFinite(a.probability) ? a.probability : null;
};
export const choiceOf = (answers: Record<string, DecisionAnswer> | null, name: string): { choice: string; confidence: number; probabilities: Array<{ value: string; probability: number }> } | null => {
  const a = answers?.[name];
  return a && a.type === "choice" ? { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities ?? [] } : null;
};
