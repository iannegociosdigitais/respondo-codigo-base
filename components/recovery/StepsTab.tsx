"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryFlow, RecoveryStep, RecoverySettings, StepSendIf } from "@/lib/recovery/types";
import { api, ApiError, MigrationWarning, ErrorBox, STEP_LANGS, LANG_NAME, FLOWS, SEND_IF_OPTIONS, humanMinutes, rtlByText, errorMessage, Notice, SectionTitle } from "./shared";

// Aba Régua: editor dos passos por fluxo (carrinho abandonado / pós-compra),
// canal (e-mail / WhatsApp) e idioma. O pós-compra só tem e-mail e ganha o
// campo "Enviar se" (depende do envio do pedido na Shopify).

type Channel = "email" | "whatsapp";
interface EditStep {
  key: string;
  id?: string;
  name: string;
  delay_minutes: number;
  // Não editável: o motor SEMPRE pula o WhatsApp depois que o cliente responde.
  // O valor só é preservado ao salvar.
  only_if_no_reply: boolean;
  discount_percent: number;
  enabled: boolean;
  send_if: StepSendIf;
  subject: Record<string, string>;
  preview: Record<string, string>;
  button: Record<string, string>;
  body: Record<string, string[]>; // sempre array no editor; e-mail usa só o [0]
}
interface TestResult { channel: Channel; flow: RecoveryFlow; position: number; to: string; preview: { subject?: string; text?: string; html?: string } }
interface LintResult { lang: string; score: number; warnings: string[] }

const CHANNELS: Array<{ key: Channel; label: string; hint: string }> = [
  { key: "email", label: "E-mail", hint: "Funil por e-mail. A resposta do cliente cai no Inbox de suporte." },
  { key: "whatsapp", label: "WhatsApp", hint: "Mensagens agendadas só enquanto o cliente não respondeu. Quando ele responde, o agente vendedor assume." },
];
const WELCOME_EMAIL_HINT = "Boas-vindas depois do primeiro pedido pago. O passo 1 é pulado quando o comprovante automático já saiu (opção em Configuração).";
const SHORTCUTS = [
  { label: "1 min", m: 1 },
  { label: "20 min", m: 20 },
  { label: "1 h", m: 60 },
  { label: "24 h", m: 1440 },
  { label: "3 dias", m: 4320 },
];
const VARS_CART = ["{{nome}}", "{{produto}}", "{{itens}}", "{{valor}}", "{{link}}", "{{cupom}}", "{{desconto}}", "{{marca}}", "{{agente}}"];
const VARS_WELCOME = ["{{nome}}", "{{produto}}", "{{itens}}", "{{valor}}", "{{pedido}}", "{{rastreio}}", "{{link_rastreio}}", "{{link}}", "{{marca}}", "{{agente}}"];

// Valores de exemplo para a checagem de entregabilidade (as variáveis são
// trocadas na hora do envio; aqui só para o texto ficar realista).
const SAMPLE_VARS: Record<string, string> = {
  nome: "Noa", produto: "Olavita Night Cream", itens: "2x Olavita Night Cream", valor: "199", link: "https://example.com/checkouts/abc123", cupom: "WELCOME15", desconto: "15%",
  marca: "Olavita", agente: "Yael", pedido: "#1234", rastreio: "RR123456789IL", link_rastreio: "https://t.17track.net/en#nums=RR123456789IL",
};
const fillSample = (text: string) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => SAMPLE_VARS[k] ?? "");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isFullHtml = (body: string) => /^\s*<(!doctype|html)/i.test(body);
const textToHtml = (body: string) => body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

let keySeq = 0;
const newKey = () => `k${Date.now().toString(36)}${(keySeq++).toString(36)}`;

const strMap = (input: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [lang, v] of Object.entries(input ?? {})) out[lang] = String(v ?? "");
  return out;
};
const cleanMap = (input: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [lang, t] of Object.entries(input)) if (t.trim()) out[lang] = t.trim();
  return out;
};

function toEdit(s: Partial<RecoveryStep>): EditStep {
  const body: Record<string, string[]> = {};
  for (const [lang, v] of Object.entries(s.body ?? {})) body[lang] = Array.isArray(v) ? v.map((x) => String(x ?? "")) : [String(v ?? "")];
  return {
    key: newKey(),
    id: s.id,
    name: s.name ?? "",
    delay_minutes: Number(s.delay_minutes ?? 0) || 0,
    only_if_no_reply: s.only_if_no_reply ?? true,
    discount_percent: Number(s.discount_percent ?? 0) || 0,
    enabled: s.enabled ?? true,
    send_if: s.send_if ?? "sempre",
    subject: strMap(s.subject),
    preview: strMap(s.preview),
    button: strMap(s.button),
    body,
  };
}

function toPayload(s: EditStep, position: number, channel: Channel, flow: RecoveryFlow) {
  const body: Record<string, string | string[]> = {};
  for (const [lang, arr] of Object.entries(s.body)) {
    const clean = arr.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) continue;
    body[lang] = channel === "whatsapp" ? clean : clean[0];
  }
  return {
    ...(s.id ? { id: s.id } : {}),
    ...(s.name.trim() ? { name: s.name.trim() } : {}),
    position,
    delay_minutes: Math.max(0, Math.round(s.delay_minutes)),
    // Sem controle na tela (o motor sempre pula depois da resposta): preserva o valor salvo.
    only_if_no_reply: channel === "whatsapp" ? s.only_if_no_reply : false,
    discount_percent: Math.min(90, Math.max(0, Math.round(s.discount_percent))),
    enabled: s.enabled,
    send_if: flow === "pos_compra" ? s.send_if : "sempre",
    subject: cleanMap(s.subject),
    preview: cleanMap(s.preview),
    button: cleanMap(s.button),
    body,
  };
}

const snapshot = (list: EditStep[] | null) => JSON.stringify((list ?? []).map(({ key: _k, ...rest }) => rest));

const scoreClass = (score: number) => (score >= 80 ? "badge badge-ok" : score >= 50 ? "badge badge-warn" : "badge badge-danger");

function StepEditor({ step, channel, flow, index, total, onChange, onRemove, onMove, onTest, testBusy, canTest }: {
  step: EditStep; channel: Channel; flow: RecoveryFlow; index: number; total: number;
  onChange: (patch: Partial<EditStep>) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void;
  onTest: () => void; testBusy: boolean; canTest: boolean;
}) {
  const [lang, setLang] = useState<string>("he");
  const [lint, setLint] = useState<LintResult | null>(null);
  const [lintBusy, setLintBusy] = useState(false);
  const [lintError, setLintError] = useState("");
  // Direção pelo CONTEÚDO do texto (hebraico/árabe = RTL); vazio cai no idioma da aba.
  const dirFor = (text: string | undefined) => (rtlByText(text, lang) ? "rtl" : "ltr");
  const variants = step.body[lang] ?? [""];
  // Texto pt do WhatsApp: só referência (o motor nunca escolhe pt para o cliente).
  const ptRef = channel === "whatsapp" ? (step.body.pt ?? []).filter((t) => t.trim()) : [];
  const setVariants = (arr: string[]) => onChange({ body: { ...step.body, [lang]: arr } });
  const filled = (l: string) => (step.body[l] ?? []).some((t) => t.trim());
  const anyText = Object.values(step.body).some((arr) => arr.some((t) => t.trim()));
  const vars = flow === "pos_compra" ? VARS_WELCOME : VARS_CART;
  const isWelcome = flow === "pos_compra";

  // "Checar entregabilidade": pontua assunto + corpo do idioma aberto. O
  // modelo acrescenta cabeçalho, botão, itens e descadastro na hora do envio.
  async function checkDeliverability() {
    const subject = fillSample(step.subject[lang] ?? "");
    const rawBody = variants[0] ?? "";
    const body = fillSample(rawBody);
    if (!subject.trim() && !body.trim()) {
      setLintError(`Sem assunto nem corpo em ${LANG_NAME[lang]} para checar.`);
      return;
    }
    setLintBusy(true);
    setLintError("");
    try {
      const d = await api<{ score?: number; warnings?: string[] }>(`/api/recovery/deliverability/lint`, { method: "POST", json: { subject, html: isFullHtml(rawBody) ? body : textToHtml(body), text: isFullHtml(rawBody) ? null : body, language: lang } });
      setLint({ lang, score: Number(d.score ?? 0), warnings: Array.isArray(d.warnings) ? d.warnings : [] });
    } catch (e) {
      setLintError(errorMessage(e));
    } finally {
      setLintBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: "0.875rem 1rem", opacity: step.enabled ? 1 : 0.65 }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.625rem" }}>
        <span className="badge badge-accent" title="Posição na régua">passo {index + 1}</span>
        <input value={step.name} dir="auto" onChange={(e) => onChange({ name: e.target.value })} placeholder="Nome do passo (só para você)" style={{ flex: 1, minWidth: "10rem", padding: "0.375rem 0.5rem" }} />
        <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
          <input type="checkbox" checked={step.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} style={{ width: "auto" }} />
          ligado
        </label>
        <button type="button" className="btn btn-sm btn-ghost" disabled={index === 0} onClick={() => onMove(-1)} title="subir">↑</button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={index === total - 1} onClick={() => onMove(1)} title="descer">↓</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => { if (window.confirm("Remover este passo da régua? Vale depois de salvar.")) onRemove(); }}>remover</button>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Esperar</span>
        <input type="number" min={0} value={step.delay_minutes} onChange={(e) => onChange({ delay_minutes: Number(e.target.value) || 0 })} style={{ width: "6rem", padding: "0.375rem 0.5rem" }} />
        <span className="hint">min = {humanMinutes(step.delay_minutes)} {index === 0 ? (isWelcome ? "depois da compra" : "depois do abandono") : "depois do passo anterior"}</span>
        <span style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {SHORTCUTS.map((s) => (
            <button key={s.m} type="button" className={`chip${step.delay_minutes === s.m ? " on" : ""}`} style={{ padding: "0.125rem 0.5rem", fontSize: "0.75rem" }} onClick={() => onChange({ delay_minutes: s.m })}>{s.label}</button>
          ))}
        </span>
      </div>

      {isWelcome ? (
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.625rem" }}>
          <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Enviar se</span>
          <select value={step.send_if} onChange={(e) => onChange({ send_if: e.target.value as StepSendIf })} style={{ width: "auto", padding: "0.375rem 0.5rem" }}>
            {SEND_IF_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <span className="hint">{SEND_IF_OPTIONS.find((o) => o.key === step.send_if)?.hint}</span>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.625rem" }}>
          <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Desconto</span>
          <input type="number" min={0} max={90} value={step.discount_percent} onChange={(e) => onChange({ discount_percent: Number(e.target.value) || 0 })} style={{ width: "5rem", padding: "0.375rem 0.5rem" }} />
          <span className="hint">% (0 = sem cupom; precisa existir um cupom ativo com esse percentual em Configuração, senão o passo sai sem desconto)</span>
          {channel === "whatsapp" && <span className="hint" style={{ marginLeft: "auto" }}>Depois que o cliente responde, a régua de WhatsApp para e o agente assume.</span>}
        </div>
      )}

      <div className="tabs" style={{ marginBottom: "0.5rem", flexWrap: "wrap" }}>
        {STEP_LANGS.map((l) => (
          <button key={l} type="button" className={`tab${lang === l ? " active" : ""}`} onClick={() => setLang(l)} title={LANG_NAME[l]} style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
            {l}
            {filled(l) && <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ok)", display: "inline-block" }} />}
          </button>
        ))}
      </div>

      {channel === "email" ? (
        <>
          <input value={step.subject[lang] ?? ""} onChange={(e) => onChange({ subject: { ...step.subject, [lang]: e.target.value } })} placeholder={`Assunto em ${LANG_NAME[lang]}`} dir={dirFor(step.subject[lang])} style={{ marginBottom: "0.375rem" }} />
          <input value={step.preview[lang] ?? ""} onChange={(e) => onChange({ preview: { ...step.preview, [lang]: e.target.value } })} placeholder={`Prévia em ${LANG_NAME[lang]} (texto que aparece ao lado do assunto na caixa de entrada; vazio = começo do corpo)`} dir={dirFor(step.preview[lang])} style={{ marginBottom: "0.375rem" }} title="Preheader" />
          <textarea rows={6} value={variants[0] ?? ""} onChange={(e) => setVariants([e.target.value])} placeholder={`Corpo em ${LANG_NAME[lang]} (texto simples ou HTML completo começando com <html>)`} dir={dirFor(variants[0])} />
          <input value={step.button[lang] ?? ""} onChange={(e) => onChange({ button: { ...step.button, [lang]: e.target.value } })} placeholder={`Botão em ${LANG_NAME[lang]} (rótulo do botão grande; vazio = padrão do idioma)`} dir={dirFor(step.button[lang])} style={{ marginTop: "0.375rem" }} />
        </>
      ) : (
        <>
          {variants.map((v, i) => (
            <div key={i} style={{ display: "flex", gap: "0.375rem", alignItems: "flex-start", marginBottom: "0.375rem" }}>
              <textarea rows={3} value={v} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Variante ${i + 1} em ${LANG_NAME[lang]} (uma é sorteada a cada envio)`} dir={dirFor(v)} />
              {variants.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVariants(variants.filter((_, j) => j !== i))} title="remover variante">×</button>}
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setVariants([...variants, ""])}>+ variante</button>
          {ptRef.length > 0 && (
            <div style={{ marginTop: "0.625rem", padding: "0.5rem 0.75rem", borderRadius: 8, background: "var(--background)", border: "1px dashed var(--border)" }}>
              <div className="hint" style={{ marginBottom: "0.25rem" }}><strong>Português (somente leitura):</strong> referência para você, nunca vai para o cliente. Não é editável aqui.</div>
              {ptRef.map((t, i) => <div key={i} dir="ltr" style={{ fontSize: "0.8125rem", whiteSpace: "pre-wrap", marginTop: i ? "0.25rem" : 0 }}>{t}</div>)}
            </div>
          )}
        </>
      )}

      <div className="hint" style={{ marginTop: "0.5rem", display: "flex", gap: "0.25rem", flexWrap: "wrap", alignItems: "center" }}>
        Variáveis:
        {vars.map((v) => <code key={v} style={{ background: "var(--background)", padding: "0 0.25rem", borderRadius: 4 }}>{v}</code>)}
        <span>· sem texto no idioma do cliente cai em inglês; sem inglês, o passo é pulado.{isWelcome ? " Linha só com variável vazia (ex.: rastreio sem código) some do e-mail." : ""}</span>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.625rem", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm" onClick={onTest} disabled={testBusy || !canTest || !step.id} title={!step.id ? "Salve a régua antes de testar" : !canTest ? "Salve as alterações antes de testar" : "Manda este passo só para o destino de teste"}>{testBusy ? "Enviando teste…" : "Testar este passo"}</button>
        {channel === "email" && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={checkDeliverability} disabled={lintBusy} title="Pontua assunto e corpo do idioma aberto (spam, tamanho, links). Não envia nada.">{lintBusy ? "Checando…" : "Checar entregabilidade"}</button>
        )}
        {!anyText && <span className="hint" style={{ color: "var(--warn)" }}>Sem texto em nenhum idioma: este passo não sai.</span>}
        {!step.id && <span className="hint">novo (ainda não salvo)</span>}
      </div>
      {lintError && <div className="hint" style={{ marginTop: "0.375rem", color: "var(--danger)" }}>{lintError}</div>}
      {lint && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8125rem", borderTop: "1px solid var(--border)", paddingTop: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className={scoreClass(lint.score)}>entregabilidade {lint.score}/100</span>
            <span className="hint">texto em {LANG_NAME[lint.lang] ?? lint.lang}{lint.warnings.length === 0 ? " · nenhum aviso" : ""}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLint(null)}>fechar</button>
          </div>
          {lint.warnings.length > 0 && <ul style={{ margin: "0.375rem 0 0 1rem", padding: 0 }}>{lint.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          <div className="hint" style={{ marginTop: "0.25rem" }}>A checagem olha só o seu texto: o modelo do e-mail acrescenta cabeçalho da marca, botão, itens e o link de descadastro na hora do envio.</div>
        </div>
      )}
    </div>
  );
}

// onDirtyChange: avisa a página das alterações não salvas (a página pede
// confirmação antes de trocar de loja ou de aba).
export default function StepsTab({ storeId, onDirtyChange }: { storeId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [flow, setFlow] = useState<RecoveryFlow>("carrinho");
  const [settings, setSettings] = useState<Partial<RecoverySettings> | null>(null);
  const [steps, setSteps] = useState<Record<Channel, EditStep[] | null>>({ email: null, whatsapp: null });
  const [saved, setSaved] = useState<Record<Channel, string>>({ email: "", whatsapp: "" });
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [busy, setBusy] = useState<Record<Channel, string>>({ email: "", whatsapp: "" });
  const [notice, setNotice] = useState<Record<Channel, { kind: "ok" | "err"; text: string } | null>>({ email: null, whatsapp: null });
  const [testTo, setTestTo] = useState<Record<Channel, string>>({ email: "", whatsapp: "" });
  const [test, setTest] = useState<TestResult | null>(null);
  // Contadores de sequência: resposta atrasada de outra loja/fluxo/carregamento
  // é ignorada (não sobrescreve o editor). ctxSeq muda a cada loja+fluxo;
  // chSeq é por canal (cada carregamento do canal invalida o anterior).
  const ctxSeq = useRef(0);
  const chSeq = useRef<Record<Channel, number>>({ email: 0, whatsapp: 0 });

  // Colunas do fluxo: carrinho tem e-mail e WhatsApp; pós-compra só e-mail.
  const channels = flow === "pos_compra" ? CHANNELS.filter((c) => c.key === "email") : CHANNELS;
  const qs = (ch: Channel) => `store=${encodeURIComponent(storeId)}&channel=${ch}&flow=${flow}`;

  const loadChannel = useCallback(async (channel: Channel) => {
    const myCtx = ctxSeq.current;
    const mySeq = ++chSeq.current[channel];
    const d = await api<{ steps?: RecoveryStep[] }>(`/api/recovery/steps?store=${encodeURIComponent(storeId)}&channel=${channel}&flow=${flow}`);
    if (myCtx !== ctxSeq.current || mySeq !== chSeq.current[channel]) return; // resposta velha
    const list = (Array.isArray(d.steps) ? d.steps : []).slice().sort((a, b) => a.position - b.position).map(toEdit);
    setSteps((prev) => ({ ...prev, [channel]: list }));
    setSaved((prev) => ({ ...prev, [channel]: snapshot(list) }));
  }, [storeId, flow]);

  const load = useCallback(async () => {
    const myCtx = ctxSeq.current;
    setError("");
    setMigrationMissing(false);
    const chs: Channel[] = flow === "pos_compra" ? ["email"] : ["email", "whatsapp"];
    try {
      await Promise.all(chs.map((ch) => loadChannel(ch)));
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      if (e instanceof ApiError && e.migrationMissing) setMigrationMissing(true);
      else setError(errorMessage(e));
      setSteps((prev) => ({ email: prev.email ?? [], whatsapp: prev.whatsapp ?? [] }));
    }
    try {
      const d = await api<{ settings?: Partial<RecoverySettings> }>(`/api/recovery/settings?store=${encodeURIComponent(storeId)}`);
      if (myCtx !== ctxSeq.current) return;
      setSettings(d.settings ?? null);
    } catch {
      if (myCtx !== ctxSeq.current) return;
      setSettings(null);
    }
  }, [storeId, flow, loadChannel]);

  useEffect(() => {
    ctxSeq.current += 1;
    chSeq.current = { email: chSeq.current.email + 1, whatsapp: chSeq.current.whatsapp + 1 };
    setSettings(null);
    setTest(null);
    setBusy({ email: "", whatsapp: "" });
    setSteps({ email: null, whatsapp: null });
    setSaved({ email: "", whatsapp: "" });
    setNotice({ email: null, whatsapp: null });
    load();
  }, [load]);

  // Ainda carregando (null) não é "alterado".
  const dirty = (ch: Channel) => steps[ch] !== null && snapshot(steps[ch]) !== saved[ch];
  const anyDirty = channels.some((c) => dirty(c.key));

  // Avisa a página das alterações não salvas (e zera ao sair da aba).
  useEffect(() => { onDirtyChange?.(anyDirty); }, [anyDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  function update(ch: Channel, fn: (list: EditStep[]) => EditStep[]) {
    setSteps((prev) => ({ ...prev, [ch]: fn(prev[ch] ?? []) }));
  }

  function changeFlow(next: RecoveryFlow) {
    if (next === flow) return;
    if (anyDirty && !window.confirm("Há alterações não salvas nesta régua. Trocar de fluxo descarta essas alterações. Continuar?")) return;
    setFlow(next);
  }

  async function save(ch: Channel) {
    const list = steps[ch] ?? [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.delay_minutes < 0) return setNotice((n) => ({ ...n, [ch]: { kind: "err", text: `Passo ${i + 1}: espera não pode ser negativa.` } }));
      if (s.discount_percent < 0 || s.discount_percent > 90) return setNotice((n) => ({ ...n, [ch]: { kind: "err", text: `Passo ${i + 1}: desconto entre 0 e 90.` } }));
    }
    const myCtx = ctxSeq.current;
    setBusy((b) => ({ ...b, [ch]: "save" }));
    setNotice((n) => ({ ...n, [ch]: null }));
    try {
      const payload = list.map((s, i) => toPayload(s, i + 1, ch, flow));
      const d = await api<{ steps?: RecoveryStep[] }>(`/api/recovery/steps?${qs(ch)}`, { method: "PUT", json: { steps: payload } });
      if (myCtx !== ctxSeq.current) return; // trocou de loja/fluxo durante o salvamento
      if (Array.isArray(d.steps)) {
        const fresh = d.steps.slice().sort((a, b) => a.position - b.position).map(toEdit);
        setSteps((prev) => ({ ...prev, [ch]: fresh }));
        setSaved((prev) => ({ ...prev, [ch]: snapshot(fresh) }));
      } else {
        await loadChannel(ch);
      }
      setNotice((n) => ({ ...n, [ch]: { kind: "ok", text: "Régua salva." } }));
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      setNotice((n) => ({ ...n, [ch]: { kind: "err", text: errorMessage(e) } }));
    } finally {
      if (myCtx === ctxSeq.current) setBusy((b) => ({ ...b, [ch]: "" }));
    }
  }

  async function seed(ch: Channel) {
    const myCtx = ctxSeq.current;
    setBusy((b) => ({ ...b, [ch]: "seed" }));
    setNotice((n) => ({ ...n, [ch]: null }));
    try {
      const d = await api<{ steps?: RecoveryStep[] }>(`/api/recovery/steps/seed?${qs(ch)}`, { method: "POST", json: {} });
      if (myCtx !== ctxSeq.current) return;
      if (Array.isArray(d.steps) && d.steps.length) {
        const fresh = d.steps.slice().sort((a, b) => a.position - b.position).map(toEdit);
        setSteps((prev) => ({ ...prev, [ch]: fresh }));
        setSaved((prev) => ({ ...prev, [ch]: snapshot(fresh) }));
      } else {
        await loadChannel(ch);
      }
      setNotice((n) => ({ ...n, [ch]: { kind: "ok", text: "Passos padrão restaurados. Revise os textos e salve se mudar algo." } }));
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      // 409 = o banco ainda tem passos neste fluxo+canal (a tela pode estar diferente do salvo).
      const text = e instanceof ApiError && e.status === 409
        ? "A régua salva deste canal ainda tem passos. Remova todos, clique em Salvar e depois em Restaurar padrão."
        : errorMessage(e);
      setNotice((n) => ({ ...n, [ch]: { kind: "err", text } }));
      if (e instanceof ApiError && e.status === 409) loadChannel(ch).catch(() => {});
    } finally {
      if (myCtx === ctxSeq.current) setBusy((b) => ({ ...b, [ch]: "" }));
    }
  }

  async function testStep(ch: Channel, position: number) {
    const myCtx = ctxSeq.current;
    setBusy((b) => ({ ...b, [ch]: `test:${position}` }));
    setNotice((n) => ({ ...n, [ch]: null }));
    try {
      const to = testTo[ch].trim();
      const d = await api<{ ok?: boolean; to?: string; preview?: { subject?: string; text?: string; html?: string } }>(`/api/recovery/test?${qs(ch)}&position=${position}`, { method: "POST", json: to ? { to } : {} });
      if (myCtx !== ctxSeq.current) return;
      const dest = d.to || to || (ch === "email" ? settings?.test_email : settings?.test_phone) || "destino de teste";
      setTest({ channel: ch, flow, position, to: String(dest), preview: d.preview ?? {} });
      setNotice((n) => ({ ...n, [ch]: { kind: "ok", text: `Teste do passo ${position} enviado para ${dest}.` } }));
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      setNotice((n) => ({ ...n, [ch]: { kind: "err", text: errorMessage(e) } }));
    } finally {
      if (myCtx === ctxSeq.current) setBusy((b) => ({ ...b, [ch]: "" }));
    }
  }

  // Canais desligados em Configuração (para o aviso do modo de teste).
  const offChannels = settings ? channels.filter((c) => settings[`${c.key}_enabled` as "email_enabled" | "whatsapp_enabled"] === false).map((c) => c.label) : [];
  const flowInfo = FLOWS.find((f) => f.key === flow);

  return (
    <>
      {migrationMissing && <MigrationWarning />}
      <ErrorBox text={error} onClose={() => setError("")} />

      <div className="card" style={{ marginBottom: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>Fluxo</span>
        <div className="tabs" style={{ margin: 0 }}>
          {FLOWS.map((f) => (
            <button key={f.key} type="button" className={`tab${flow === f.key ? " active" : ""}`} onClick={() => changeFlow(f.key)}>{f.label}</button>
          ))}
        </div>
        <span className="hint">{flowInfo?.hint}</span>
        {flow === "pos_compra" && settings && (
          settings.welcome_enabled
            ? <span className="badge badge-ok">pós-compra ligado{settings.welcome_since ? ` desde ${new Date(settings.welcome_since).toLocaleDateString("pt-BR")}` : ""}</span>
            : <span className="badge">pós-compra desligado em Configuração</span>
        )}
      </div>

      {settings?.test_mode && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--warn)", background: "var(--warn-soft)" }}>
          <strong>Modo de teste ligado:</strong> tudo vai para {settings.test_email || "(sem e-mail de teste)"} / {settings.test_phone || "(sem telefone de teste: WhatsApp não sai)"}. O cliente real nunca recebe. Desligue em Configuração quando a régua estiver pronta.
          {offChannels.length > 0 && <> Canal {offChannels.join(" e ")} desligado em Configuração: a régua não manda por ele nem em teste.</>}
        </div>
      )}
      {settings && !settings.enabled && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
          A régua desta loja está <strong>desligada</strong> em Configuração: nada sai pela régua, nem em modo de teste, nem com "Rodar a régua agora". Só "Testar este passo" funciona (é explícito e vai só para o destino de teste).
        </div>
      )}
      <p className="hint" style={{ marginBottom: "1rem" }}>
        O cliente nunca recebe o mesmo passo duas vezes. Sem texto em nenhum idioma, o passo não sai. Textos em português nunca vão para o cliente. Sem travessão. Nunca dois e-mails de marketing para o mesmo endereço em menos do intervalo mínimo (Configuração).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(28rem, 1fr))", gap: "1rem", alignItems: "start" }}>
        {channels.map((c) => {
          const list = steps[c.key];
          const isDirty = dirty(c.key);
          const b = busy[c.key];
          // "Restaurar padrão" só quando a régua SALVA está vazia: a API recusa
          // (409) se o banco ainda tiver passos, mesmo que a tela esteja limpa.
          const savedEmpty = saved[c.key] === snapshot([]);
          const canSeed = Boolean(list) && list?.length === 0 && savedEmpty;
          const hint = flow === "pos_compra" ? WELCOME_EMAIL_HINT : c.hint;
          return (
            <div key={`${flow}:${c.key}`}>
              <div className="card" style={{ marginBottom: "0.75rem" }}>
                <SectionTitle right={<span className="hint">{settings ? (settings[`${c.key}_enabled` as "email_enabled" | "whatsapp_enabled"] ? <span className="badge badge-ok">canal ligado</span> : <span className="badge">canal desligado</span>) : null}</span>}>
                  Régua de {c.label}{flow === "pos_compra" ? " · pós-compra" : ""}
                </SectionTitle>
                <div className="hint" style={{ marginBottom: "0.625rem" }}>{hint}</div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-sm btn-primary" disabled={!isDirty || Boolean(b) || !list} onClick={() => save(c.key)}>{b === "save" ? "Salvando…" : isDirty ? "Salvar" : "Salvo"}</button>
                  <button type="button" className="btn btn-sm" disabled={Boolean(b) || !list} onClick={() => update(c.key, (l) => [...l, toEdit({ delay_minutes: l.length ? 1440 : flow === "pos_compra" ? 0 : c.key === "email" ? 60 : 1, only_if_no_reply: true, enabled: true, send_if: "sempre" })])}>+ Adicionar passo</button>
                  {canSeed && (
                    <button type="button" className="btn btn-sm" disabled={Boolean(b)} onClick={() => seed(c.key)} title="Insere os passos padrão deste fluxo (só quando a régua salva está vazia)">{b === "seed" ? "Restaurando…" : "Restaurar padrão"}</button>
                  )}
                  {isDirty && <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(b)} onClick={() => loadChannel(c.key).catch(() => {})}>Descartar</button>}
                  <Notice notice={notice[c.key]} />
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.625rem", flexWrap: "wrap" }}>
                  <span className="hint" style={{ flexShrink: 0 }}>Destino do teste (opcional):</span>
                  <input value={testTo[c.key]} onChange={(e) => setTestTo((t) => ({ ...t, [c.key]: e.target.value }))} placeholder={c.key === "email" ? settings?.test_email || "e-mail de teste" : settings?.test_phone || "+9725..."} style={{ width: "14rem", padding: "0.3rem 0.5rem", fontSize: "0.8125rem" }} />
                </div>
              </div>

              {!list && !migrationMissing && <div className="empty">Carregando…</div>}
              {list && list.length === 0 && (
                <div className="empty">
                  {savedEmpty
                    ? 'Nenhum passo nesta régua. Clique em "Restaurar padrão" para começar com os textos padrão, ou adicione um passo.'
                    : 'Todos os passos foram removidos, mas ainda não salvos: a régua salva continua com os passos antigos. Clique em Salvar para apagar de verdade (depois "Restaurar padrão" fica disponível) ou em Descartar para voltar.'}
                </div>
              )}
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {(list ?? []).map((s, i) => (
                  <StepEditor
                    key={s.key}
                    step={s}
                    channel={c.key}
                    flow={flow}
                    index={i}
                    total={list?.length ?? 0}
                    onChange={(patch) => update(c.key, (l) => l.map((x) => (x.key === s.key ? { ...x, ...patch } : x)))}
                    onRemove={() => update(c.key, (l) => l.filter((x) => x.key !== s.key))}
                    onMove={(dir) => update(c.key, (l) => {
                      const idx = l.findIndex((x) => x.key === s.key);
                      const j = idx + dir;
                      if (idx < 0 || j < 0 || j >= l.length) return l;
                      const copy = l.slice();
                      [copy[idx], copy[j]] = [copy[j], copy[idx]];
                      return copy;
                    })}
                    onTest={() => testStep(c.key, i + 1)}
                    testBusy={b === `test:${i + 1}`}
                    canTest={!isDirty}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {test && (
        <div role="dialog" aria-modal="true" onClick={() => setTest(null)} onKeyDown={(e) => e.key === "Escape" && setTest(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,18,30,0.55)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 100%)", maxHeight: "92vh", display: "flex", flexDirection: "column", gap: "0.75rem", overflow: "auto" }}>
            <div>
              <div className="section-title" style={{ margin: 0 }}>Teste do passo {test.position} · {test.channel === "email" ? "E-mail" : "WhatsApp"}{test.flow === "pos_compra" ? " · pós-compra" : ""}</div>
              <div className="hint">Foi para <strong>{test.to}</strong> (só o destino de teste; o cliente real não recebe).</div>
            </div>
            {test.preview.subject && <div dir="auto"><strong>Assunto:</strong> {test.preview.subject}</div>}
            {test.preview.html ? (
              <iframe title="Prévia" srcDoc={test.preview.html} sandbox="" style={{ width: "100%", height: "52vh", border: "1px solid var(--border)", borderRadius: 8, background: "#f4f5f8" }} />
            ) : (
              <div className={`bubble ${test.channel === "whatsapp" ? "user" : "assistant"}`} dir="auto" style={{ alignSelf: "flex-start", maxWidth: "100%" }}>{test.preview.text || "(sem prévia de texto)"}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setTest(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
