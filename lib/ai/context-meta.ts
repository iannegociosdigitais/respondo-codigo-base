// Formato dos blocos de contexto (o mesmo do arquivo .md de exportar/importar).
// O cabeçalho fica nas primeiras linhas do conteúdo, até uma linha '---':
//
//   ## Objeção: pedido atrasado
//   tipo: objecao
//   produto: Olavita
//   temas: atraso, prazo_entrega
//   fases: 1, 2
//   idiomas: he, tr
//   palavras: krem, קרם, where is my order
//   ---
//   texto que a IA deve seguir...
//
// Sem cabeçalho o bloco continua valendo (tipo "geral").

export const CONTEXT_TYPES = ["base", "idioma", "loja", "produto", "prazo", "objecao", "politica", "fase", "geral"] as const;
export type ContextType = (typeof CONTEXT_TYPES)[number];

// Temas: a IA classifica cada e-mail nesses temas e os blocos com o mesmo
// tema entram primeiro no prompt.
export const TOPICS = [
  "prazo_entrega",
  "rastreio",
  "atraso",
  "consta_entregue",
  "endereco",
  "cancelamento",
  "assinatura",
  "cobranca",
  "regularizacao_financeira",
  "devolucao",
  "chargeback_contestacao",
  "produto_uso",
  "produto_resultado",
  "preco_oferta",
  "pagamento",
  "legitimidade_loja",
  "agradecimento",
  "outro",
] as const;
export type Topic = (typeof TOPICS)[number];

export interface ContextMeta {
  tipo: ContextType;
  produto: string | null;
  temas: string[];
  fases: number[];
  idiomas: string[];
  palavras: string[];
  // Só em blocos tipo prazo: números que o código usa pra calcular datas.
  preparo_dias_uteis: number | null;
  entrega_dias_uteis: [number, number] | null;
}

const KEYS = ["tipo", "produto", "temas", "fases", "idiomas", "palavras", "preparo_dias_uteis", "entrega_dias_uteis"];
const list = (v: string) => v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export function parseContext(content: string): { meta: ContextMeta; body: string } {
  const meta: ContextMeta = { tipo: "geral", produto: null, temas: [], fases: [], idiomas: [], palavras: [], preparo_dias_uteis: null, entrega_dias_uteis: null };
  const lines = content.split("\n");
  let i = 0;
  let sawKey = false;
  for (; i < lines.length && i < 10; i++) {
    const line = lines[i].trim();
    if (line === "---") {
      i += 1;
      break;
    }
    const m = line.match(/^([a-zçã_]+)\s*:\s*(.*)$/i);
    if (!m || !KEYS.includes(m[1].toLowerCase())) {
      if (!sawKey) i = 0;
      break;
    }
    sawKey = true;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "tipo") meta.tipo = (CONTEXT_TYPES as readonly string[]).includes(val.toLowerCase()) ? (val.toLowerCase() as ContextType) : "geral";
    else if (key === "produto") meta.produto = val || null;
    else if (key === "temas") meta.temas = list(val);
    else if (key === "fases") meta.fases = list(val).map(Number).filter((n) => n >= 1 && n <= 4);
    else if (key === "idiomas") meta.idiomas = list(val).map((l) => l.slice(0, 2));
    else if (key === "palavras") meta.palavras = list(val);
    else if (key === "preparo_dias_uteis") meta.preparo_dias_uteis = Number(val) > 0 ? Number(val) : null;
    else if (key === "entrega_dias_uteis") {
      const n = val.split(/[-–a]/).map((x) => Number(x.trim())).filter((x) => x > 0);
      meta.entrega_dias_uteis = n.length >= 2 ? [n[0], n[1]] : n.length === 1 ? [n[0], n[0]] : null;
    }
  }
  if (!sawKey) return { meta, body: content.trim() };
  return { meta, body: lines.slice(i).join("\n").trim() };
}

export function serializeContext(meta: Partial<ContextMeta>, body: string): string {
  const head = [
    meta.tipo && meta.tipo !== "geral" ? `tipo: ${meta.tipo}` : "",
    meta.temas?.length ? `temas: ${meta.temas.join(", ")}` : "",
    meta.fases?.length ? `fases: ${meta.fases.join(", ")}` : "",
    meta.idiomas?.length ? `idiomas: ${meta.idiomas.join(", ")}` : "",
    meta.palavras?.length ? `palavras: ${meta.palavras.join(", ")}` : "",
    meta.preparo_dias_uteis ? `preparo_dias_uteis: ${meta.preparo_dias_uteis}` : "",
    meta.entrega_dias_uteis ? `entrega_dias_uteis: ${meta.entrega_dias_uteis[0]}-${meta.entrega_dias_uteis[1]}` : "",
  ].filter(Boolean);
  return head.length ? `${head.join("\n")}\n---\n${body.trim()}` : body.trim();
}

export interface SelectableContext {
  label: string;
  content: string;
}

// Escolhe os blocos que entram no prompt: base/idioma/loja/prazo sempre;
// depois os que batem com tema, fase, palavra do cliente e idioma; o resto
// entra enquanto couber no orçamento de caracteres.
export function selectContexts(
  entries: SelectableContext[],
  input: { topics: string[]; phase: number; language: string | null; text: string; budget?: number }
): { selected: Array<{ label: string; body: string; tipo: ContextType; score: number; meta: ContextMeta }>; skipped: number } {
  const budget = input.budget ?? 36000;
  const text = input.text.toLowerCase();
  const lang = (input.language ?? "").slice(0, 2).toLowerCase();
  const scored = entries
    .map((e) => {
      const { meta, body } = parseContext(e.content);
      if (meta.idiomas.length > 0 && lang && !meta.idiomas.includes(lang)) return null;
      let score = 1;
      if (["base", "idioma", "loja", "prazo", "produto"].includes(meta.tipo)) score += 100;
      if (meta.temas.some((t) => input.topics.includes(t))) score += 30;
      if (meta.fases.includes(input.phase)) score += 20;
      if (meta.palavras.some((w) => w && text.includes(w))) score += 30;
      if (meta.idiomas.includes(lang)) score += 10;
      // Regra ditada pelo dono: quando casa com o e-mail, entra antes de tudo.
      if (/^REGRA DO IAN/i.test(e.label) && score > 1) score += 200;
      // Bloco antigo sem cabeçalho: casa pelo título (ex.: "Objeção: atraso").
      if (meta.tipo === "geral" && input.topics.some((t) => e.label.toLowerCase().includes(t.split("_")[0]))) score += 15;
      return { label: e.label, body, tipo: meta.tipo, score, meta };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.score - a.score);

  let used = 0;
  const selected: typeof scored = [];
  for (const c of scored) {
    if (used + c.body.length > budget && c.score < 100) continue;
    selected.push(c);
    used += c.body.length;
  }
  return { selected, skipped: scored.length - selected.length };
}
