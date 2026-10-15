// Resumo da simulação: nota por cenário, desfechos, regras quebradas
// (checagem automática), ações erradas e os problemas apontados pela juíza.
// Uso: npx tsx scripts/agent-sim/summarize.ts <pasta-saida> [--piores N]
import { readFileSync, writeFileSync } from "node:fs";

const OUT = process.argv[2];
const WORST = Number(process.argv[process.argv.indexOf("--piores") + 1] || 0) || 0;
if (!OUT) throw new Error("uso: summarize.ts <pasta-saida> [--piores N]");

interface Check { rule: string; detail?: string }
interface Turn { who: string; text: string; pt?: string; action?: string; notes?: string[]; handoff_reason?: string | null; checks?: Check[]; retomada?: boolean }
interface Problem { tipo: string; gravidade: string; turno: number; descricao: string }
interface Row {
  i: number; scenario: string; label: string; ended: string; turns: Turn[]; actions: string[];
  expectMiss: string | null; mustNotHit: string[]; cart: string; total: string | null;
  persona: { gender: string; lang: string; name: string };
  judge: { nota: number; seguiu_roteiro: boolean; tom_humano: number; resultado: string; problemas: Problem[]; resumo: string } | null;
  usage?: { cost_usd: number };
}
const rows: Row[] = readFileSync(`${OUT}/results.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const n = rows.length;
const pct = (x: number) => `${((100 * x) / Math.max(1, n)).toFixed(1)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const cost = rows.reduce((a, r) => a + (r.usage?.cost_usd ?? 0), 0);
const notas = rows.map((r) => r.judge?.nota ?? 0).filter(Boolean);
const lines: string[] = [];
lines.push(`# Simulação do agente: ${n} conversas · custo US$ ${cost.toFixed(2)}`);
lines.push(`Nota média: ${avg(notas).toFixed(2)} · nota 1-2: ${notas.filter((x) => x <= 2).length} · nota 5: ${notas.filter((x) => x === 5).length} · seguiu o roteiro: ${pct(rows.filter((r) => r.judge?.seguiu_roteiro).length)}`);

const outcome = new Map<string, number>();
for (const r of rows) outcome.set(r.judge?.resultado ?? "?", (outcome.get(r.judge?.resultado ?? "?") ?? 0) + 1);
lines.push(`Desfechos: ${[...outcome].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

// Checagem automática (por mensagem da Yael)
const rule = new Map<string, { count: number; ex: string[] }>();
for (const r of rows) for (const t of r.turns) for (const c of t.checks ?? []) {
  const e = rule.get(c.rule) ?? { count: 0, ex: [] };
  e.count += 1;
  if (e.ex.length < 3) e.ex.push(`#${r.i} ${r.scenario}: ${(c.detail ?? "").slice(0, 60)} | ${(t.pt ?? t.text).slice(0, 160).replace(/\n/g, " / ")}`);
  rule.set(c.rule, e);
}
lines.push(`\n## Regras quebradas (checagem automática)`);
if (rule.size === 0) lines.push("nenhuma");
for (const [k, v] of [...rule].sort((a, b) => b[1].count - a[1].count)) {
  lines.push(`- ${k}: ${v.count}`);
  for (const e of v.ex) lines.push(`    ${e}`);
}

// Ações esperadas / proibidas por cenário
lines.push(`\n## Ação errada para o cenário`);
const wrong = rows.filter((r) => r.expectMiss || r.mustNotHit.length);
if (!wrong.length) lines.push("nenhuma");
for (const r of wrong.slice(0, 60)) lines.push(`- #${r.i} ${r.label}: ${r.expectMiss ?? ""}${r.mustNotHit.length ? ` fez o proibido: ${r.mustNotHit.join(",")}` : ""}`);

// Problemas da juíza
const prob = new Map<string, { alta: number; media: number; baixa: number; ex: string[] }>();
for (const r of rows) for (const p of r.judge?.problemas ?? []) {
  const e = prob.get(p.tipo) ?? { alta: 0, media: 0, baixa: 0, ex: [] };
  if (p.gravidade === "alta") e.alta += 1;
  else if (p.gravidade === "media") e.media += 1;
  else e.baixa += 1;
  if (p.gravidade !== "baixa" && e.ex.length < 4) e.ex.push(`#${r.i} ${r.scenario} (${p.gravidade}): ${p.descricao}`);
  prob.set(p.tipo, e);
}
lines.push(`\n## Problemas apontados pela juíza (alta/média/baixa)`);
for (const [k, v] of [...prob].sort((a, b) => b[1].alta * 10 + b[1].media - (a[1].alta * 10 + a[1].media))) {
  lines.push(`- ${k}: ${v.alta}/${v.media}/${v.baixa}`);
  for (const e of v.ex) lines.push(`    ${e}`);
}

// Por cenário
lines.push(`\n## Por cenário (nota média · conversas · desfechos)`);
const byS = new Map<string, Row[]>();
for (const r of rows) byS.set(r.label, [...(byS.get(r.label) ?? []), r]);
for (const [label, rs] of [...byS].sort((a, b) => avg(a[1].map((r) => r.judge?.nota ?? 0)) - avg(b[1].map((r) => r.judge?.nota ?? 0)))) {
  const oc = new Map<string, number>();
  for (const r of rs) oc.set(r.judge?.resultado ?? "?", (oc.get(r.judge?.resultado ?? "?") ?? 0) + 1);
  lines.push(`- ${avg(rs.map((r) => r.judge?.nota ?? 0)).toFixed(1)} · ${rs.length} · ${label} · ${[...oc].map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

// Piores conversas por extenso
if (WORST > 0) {
  lines.push(`\n## Piores conversas`);
  for (const r of [...rows].sort((a, b) => (a.judge?.nota ?? 0) - (b.judge?.nota ?? 0)).slice(0, WORST)) {
    lines.push(`\n### #${r.i} ${r.label} · nota ${r.judge?.nota} · ${r.judge?.resumo}`);
    for (const t of r.turns) lines.push(`${t.who === "cliente" ? "CLIENTE" : t.who === "agente" ? `YAEL${t.action ? ` (${t.action})` : ""}${t.retomada ? " [retomada]" : ""}` : "RÉGUA"}: ${(t.pt ?? t.text).replace(/\n+/g, " / ")}`);
    for (const p of r.judge?.problemas ?? []) lines.push(`  - ${p.gravidade} ${p.tipo}: ${p.descricao}`);
  }
}
const md = lines.join("\n");
writeFileSync(`${OUT}/resumo.md`, md);
console.log(md);
