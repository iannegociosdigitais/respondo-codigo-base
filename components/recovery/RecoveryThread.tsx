"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoveryRow, WhatsappMessageRow } from "@/lib/recovery/types";
import { api, ApiError, MigrationWarning, fmtTime, fmtDateTime, fmtWhen, statusInfo, AGENT_MODE_INFO, AUTHOR_LABEL, CHANNEL_LABEL, EVENT_LABEL, langName, RTL_RE, rtlByText, isTestRow, displayName, errorMessage, Notice, type NoticeState } from "./shared";
import RecoveryCard from "./RecoveryCard";
import type { ConvItem } from "./ConversationsTab";

// Centro (thread em bolhas + composer) e direita (ficha) da aba Conversas.

// isTest/is_test: evento de teste (a API pode mandar em qualquer uma das grafias, ou nenhuma).
export interface EventRow { id: string; step: number | null; channel: string; type: string; createdAt: string; detail: unknown; discountCode: string | null; isTest?: boolean | null; is_test?: boolean | null }
export interface Detail {
  recovery: RecoveryRow;
  store: { id: string; name: string } | null;
  messages: WhatsappMessageRow[];
  events: EventRow[];
  order: { name: string; createdAt: string; total: number | string | null; currency: string | null } | null;
  sessions: string[];
  // Telefone suprimido ou cliente pediu para parar: o envio humano é recusado (409).
  suppressed: boolean;
  // Chaves da loja (a API devolve; ausente em API antiga = sem avisos).
  settings: { enabled: boolean; whatsappEnabled: boolean; agentEnabled: boolean; testMode: boolean; testPhone: string | null } | null;
}
interface Suggestion { reply: string; reply_pt: string; action: string; discount_percent: number | null; summary_pt: string }

const ACTION_LABEL: Record<string, string> = {
  reply: "responder", offer_discount: "oferecer desconto", handoff: "passar para humano", stop: "parar (cliente pediu)", bought: "cliente disse que comprou", not_interested: "não quer (despedida)",
};

const POLL_MS = 5000;


// Eventos que viram marcador no meio do chat. WhatsApp enviado/entregue/lido
// já aparece nas bolhas (ack); aqui ficam só os que não têm bolha.
function showEvent(e: EventRow): boolean {
  if (e.channel === "whatsapp") return ["skipped", "failed", "stopped", "handoff", "unsubscribed"].includes(e.type);
  if (e.channel === "email") return e.type !== "queued";
  return true;
}

function eventText(e: EventRow): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const reason = typeof d.reason === "string" ? d.reason : typeof d.error === "string" ? d.error : typeof d.motivo === "string" ? d.motivo : "";
  const base = `${CHANNEL_LABEL[e.channel] ?? e.channel}${e.step ? ` ${e.step}` : ""} ${EVENT_LABEL[e.type] ?? e.type}`;
  return [base, e.discountCode ? `cupom ${e.discountCode}` : "", reason].filter(Boolean).join(" · ");
}

// Travas do envio humano (o servidor recusa nos mesmos casos).
function sendBlockReason(d: Detail | null): string | null {
  if (!d) return null;
  const cfg = d.settings;
  if (d.suppressed) return "Este cliente pediu para parar (ou o telefone está na lista de supressão). O envio está bloqueado.";
  if (cfg && !cfg.whatsappEnabled) return "O canal WhatsApp está desligado nesta loja (Configuração). O envio está desativado.";
  if (cfg && cfg.testMode && !cfg.testPhone) return "Modo de teste ligado e a loja não tem telefone de teste (Configuração). O envio está desativado.";
  return null;
}

function Ack({ m }: { m: WhatsappMessageRow }) {
  if (m.error) return <span title={m.error} style={{ color: "var(--danger)" }}>falhou</span>;
  const a = m.ack ?? 0;
  if (a < 0) return <span style={{ color: "var(--danger)" }}>erro</span>;
  if (a === 0) return <span title="aguardando o servidor do WhatsApp">…</span>;
  if (a === 1) return <span title="enviado">✓</span>;
  if (a === 2) return <span title="entregue">✓✓</span>;
  return <span title="lido" style={{ color: "#53bdeb" }}>✓✓</span>;
}

function Bubble({ m, showPt }: { m: WhatsappMessageRow; showPt: boolean }) {
  const inbound = m.direction === "inbound";
  const body = m.body ?? (m.has_media ? "[mídia sem texto]" : "");
  // Direção pelo texto, não pelo idioma do carrinho: cliente israelense que
  // escreve em inglês (ou o marcador "[mídia sem texto]") fica LTR.
  const rtl = RTL_RE.test(body);
  const pt = showPt && m.body_pt && m.body_pt.trim() && m.body_pt.trim() !== (m.body ?? "").trim() ? m.body_pt : null;
  const author = AUTHOR_LABEL[m.author] ?? m.author;
  const at = m.sent_at ?? m.created_at;
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return (
    <div style={{ alignSelf: inbound ? "flex-start" : "flex-end", maxWidth: "78%", display: "flex", flexDirection: "column", alignItems: inbound ? "flex-start" : "flex-end" }}>
      <div className="hint" style={{ margin: "0 0.5rem 0.125rem", display: "flex", gap: "0.375rem", alignItems: "center" }}>
        <span className={`badge ${inbound ? "" : m.author === "humano" ? "badge-ok" : m.author === "agente" ? "badge-accent" : ""}`}>{author}{m.step ? ` · passo ${m.step}` : ""}</span>
      </div>
      <div className={`bubble ${inbound ? "assistant" : "user"}`} dir={rtl ? "rtl" : undefined} style={{ maxWidth: "100%", textAlign: rtl ? "right" : "left" }}>
        {m.is_test && <span className="badge badge-warn" style={{ marginRight: "0.375rem" }} title="Foi para o destino de teste, não para o cliente">teste</span>}
        {body}
        {m.has_media && m.media_url && (
          <div style={{ marginTop: "0.25rem" }}>
            <a href={m.media_url} target="_blank" rel="noreferrer" style={{ color: inbound ? "var(--accent)" : "#fff", textDecoration: "underline" }}>abrir mídia</a>
          </div>
        )}
        {pt && (
          <div dir="ltr" style={{ marginTop: "0.375rem", paddingTop: "0.375rem", borderTop: `1px solid ${inbound ? "var(--border)" : "rgba(255,255,255,0.35)"}`, fontSize: "0.8125rem", opacity: 0.9, textAlign: "left" }}>
            {pt}
          </div>
        )}
      </div>
      <div className="hint" style={{ margin: "0.125rem 0.5rem 0", display: "flex", gap: "0.375rem", alignItems: "center" }}>
        <span title={fmtDateTime(at)}>{sameDay ? fmtTime(at) : fmtDateTime(at)}</span>
        {!inbound && <Ack m={m} />}
      </div>
    </div>
  );
}

export default function RecoveryThread({ id, onPatch, onRefreshList }: { id: string; onPatch: (id: string, patch: Partial<ConvItem>) => void; onRefreshList: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [text, setText] = useState("");
  const [translate, setTranslate] = useState(true);
  const [showPt, setShowPt] = useState(true);
  // Mensagens/eventos de teste ficam escondidos por padrão (toggle "mostrar testes").
  const [showTests, setShowTests] = useState(false);
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState("");
  const seq = useRef(0);
  const readInFlight = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);
  // "Sugerir resposta" desliga a tradução sozinho (a caixa já vem no idioma do
  // cliente); depois de enviar, a chave volta ao padrão (ligada).
  const translateAutoOff = useRef(false);

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const mySeq = ++seq.current;
    try {
      const d = await api<Partial<Detail>>(`/api/recovery/conversations/${id}`);
      if (mySeq !== seq.current) return;
      if (!d.recovery) throw new ApiError("Conversa sem dados.", 500);
      setDetail({ recovery: d.recovery, store: d.store ?? null, messages: Array.isArray(d.messages) ? d.messages : [], events: Array.isArray(d.events) ? d.events : [], order: d.order ?? null, sessions: Array.isArray(d.sessions) ? d.sessions : [], suppressed: Boolean(d.suppressed), settings: d.settings ?? null });
      setError("");
      setMigrationMissing(false);
      // Conversa aberta e aba visível: mensagem que chegou agora já está lida.
      if ((d.recovery.unread_count ?? 0) > 0 && !document.hidden && !readInFlight.current) {
        readInFlight.current = true;
        api(`/api/recovery/conversations/${id}/read`, { method: "POST", json: {} })
          .then(() => {
            if (mySeq !== seq.current) return;
            setDetail((prev) => (prev ? { ...prev, recovery: { ...prev.recovery, unread_count: 0 } } : prev));
            onPatch(id, { unreadCount: 0 });
          })
          .catch(() => {})
          .finally(() => { readInFlight.current = false; });
      }
    } catch (e) {
      if (mySeq !== seq.current) return;
      if (e instanceof ApiError && e.migrationMissing) setMigrationMissing(true);
      else setError(errorMessage(e));
    }
  }, [id, onPatch]);

  // Abrir = marcar lido + carregar; depois polling de 5 s.
  useEffect(() => {
    stick.current = true;
    lastCount.current = 0;
    // Sugestão é de UMA conversa: não pode ir junto para a próxima.
    setSuggestion(null);
    if (translateAutoOff.current) {
      translateAutoOff.current = false;
      setTranslate(true);
    }
    api(`/api/recovery/conversations/${id}/read`, { method: "POST", json: {} }).catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [id, load]);

  // Fica grudado no fim do chat quando o usuário já estava lá.
  const count = (detail?.messages.length ?? 0) + (detail?.events.length ?? 0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current && count !== lastCount.current) el.scrollTop = el.scrollHeight;
    lastCount.current = count;
  }, [count]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function send() {
    const body = text.trim();
    if (!body || sending || sendBlockReason(detail)) return;
    setSending(true);
    setNotice(null);
    try {
      const d = await api<{ ok?: boolean; message?: WhatsappMessageRow; isTest?: boolean; to?: string }>(`/api/recovery/conversations/${id}/send`, { method: "POST", json: { text: body, translate } });
      setText("");
      setSuggestion(null);
      if (translateAutoOff.current) {
        translateAutoOff.current = false;
        setTranslate(true);
      }
      if (d.isTest) {
        // Foi para o telefone de teste: o cliente NÃO recebeu e a conversa não muda de dono.
        // A mensagem entra marcada como teste (escondida por padrão em "mostrar testes").
        if (d.message) setDetail((prev) => (prev ? { ...prev, messages: [...prev.messages, { ...(d.message as WhatsappMessageRow), is_test: true }] } : prev));
        setNotice({ kind: "warn", text: `Enviado para o telefone de teste${d.to ? ` ${d.to}` : ""} (não foi ao cliente). A conversa não mudou de dono.` });
      } else {
        stick.current = true;
        if (d.message) setDetail((prev) => (prev ? { ...prev, messages: [...prev.messages, d.message as WhatsappMessageRow], recovery: { ...prev.recovery, agent_mode: "humano", needs_human: false, unread_count: 0 } } : prev));
        setNotice({ kind: "ok", text: "Enviado. A conversa é sua até você devolver ao agente. Os próximos passos de WhatsApp da régua foram desagendados; o e-mail segue." });
        onPatch(id, { agentMode: "humano", needsHuman: false, unreadCount: 0 });
      }
      load();
      onRefreshList();
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setSending(false);
    }
  }

  async function suggest() {
    if (suggesting) return;
    setSuggesting(true);
    setNotice(null);
    try {
      const d = await api<Partial<Suggestion>>(`/api/recovery/conversations/${id}/suggest`, { method: "POST", json: {} });
      const s: Suggestion = { reply: d.reply ?? "", reply_pt: d.reply_pt ?? "", action: d.action ?? "reply", discount_percent: d.discount_percent ?? null, summary_pt: d.summary_pt ?? "" };
      setSuggestion(s);
      if (s.reply) {
        // A caixa recebe o texto que o cliente vai ler (com link/cupom já
        // montados) e a tradução é desligada: enviar manda exatamente isso,
        // sem traduzir reply_pt de novo. reply_pt aparece como legenda.
        setText(s.reply);
        if (translate) translateAutoOff.current = true;
        setTranslate(false);
      } else {
        setText(s.reply_pt);
        translateAutoOff.current = false;
        setTranslate(true);
      }
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setSuggesting(false);
    }
  }

  // Chave de tradução mexida à mão: se a caixa ainda tem a sugestão intacta,
  // troca o texto para o idioma certo (ligou = PT; desligou = idioma do cliente).
  function toggleTranslate(on: boolean) {
    translateAutoOff.current = false;
    setTranslate(on);
    if (!suggestion) return;
    if (on && suggestion.reply_pt && text === suggestion.reply) setText(suggestion.reply_pt);
    else if (!on && suggestion.reply && text === suggestion.reply_pt) setText(suggestion.reply);
  }

  async function setMode(mode: "agente" | "humano" | "pausado", resolve = false) {
    setBusy(mode + (resolve ? ":resolve" : ""));
    setNotice(null);
    try {
      const d = await api<{ recovery?: RecoveryRow; warnings?: string[] }>(`/api/recovery/conversations/${id}/mode`, { method: "POST", json: { mode, resolve } });
      const w = Array.isArray(d.warnings) ? d.warnings.filter(Boolean) : [];
      if (w.length) setNotice({ kind: "warn", text: w.join(" ") });
      else if (mode === "pausado") setNotice({ kind: "ok", text: "Conversa pausada: nem o agente nem a régua mandam nada." });
      if (d.recovery) setDetail((prev) => (prev ? { ...prev, recovery: d.recovery as RecoveryRow } : prev));
      else setDetail((prev) => (prev ? { ...prev, recovery: { ...prev.recovery, agent_mode: mode, needs_human: resolve || mode === "agente" ? false : prev.recovery.needs_human } } : prev));
      onPatch(id, { agentMode: mode, ...(resolve || mode === "agente" ? { needsHuman: false } : {}) });
      onRefreshList();
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  // Devolve os avisos do servidor (ex.: "o cliente já respondeu: a régua de WhatsApp não volta").
  async function patchRecovery(patch: { notes?: string; tags?: string[]; status?: "pausado" | "ativo" | "concluido_sem_compra" }): Promise<string[]> {
    const d = await api<{ recovery?: RecoveryRow; warnings?: string[] }>(`/api/recovery/conversations/${id}`, { method: "PATCH", json: patch });
    setDetail((prev) => (prev ? { ...prev, recovery: d.recovery ?? { ...prev.recovery, ...patch } } : prev));
    if (patch.tags) onPatch(id, { tags: patch.tags });
    if (patch.status) onPatch(id, { status: patch.status });
    return Array.isArray(d.warnings) ? d.warnings.filter(Boolean) : [];
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  if (migrationMissing) return <div className="inbox-read"><div style={{ padding: "1.5rem" }}><MigrationWarning /></div></div>;
  if (!detail) return <div className="inbox-read"><div className="empty">{error || "Carregando…"}</div></div>;

  const rec = detail.recovery;
  const name = displayName([rec.first_name, rec.last_name].filter(Boolean).join(" "), rec.phone, rec.email);
  const st = statusInfo(rec.status);
  const mode = AGENT_MODE_INFO[rec.agent_mode] ?? { label: rec.agent_mode, cls: "badge" };
  // Testes (foram para o destino de teste) ficam fora do chat por padrão.
  const visibleEvents = detail.events.filter(showEvent);
  const testCount = detail.messages.filter((m) => isTestRow(m)).length + visibleEvents.filter((e) => isTestRow(e)).length;
  const timeline: Array<{ at: string; key: string; node: React.ReactNode }> = [
    ...detail.messages.filter((m) => showTests || !isTestRow(m)).map((m) => ({ at: m.sent_at ?? m.created_at, key: `m:${m.id}`, node: <Bubble key={`m:${m.id}`} m={m} showPt={showPt} /> })),
    ...visibleEvents.filter((e) => showTests || !isTestRow(e)).map((e) => ({
      at: e.createdAt,
      key: `e:${e.id}`,
      node: (
        <div key={`e:${e.id}`} style={{ alignSelf: "center", display: "flex", gap: "0.375rem", alignItems: "center" }}>
          <span className={`badge ${e.type === "stopped" || e.type === "failed" || e.type === "bounced" || e.type === "complained" ? "badge-danger" : e.type === "handoff" ? "badge-warn" : e.type === "clicked" || e.type === "opened" || e.type === "read" ? "badge-ok" : ""}`} title={fmtDateTime(e.createdAt)}>
            {isTestRow(e) ? "teste · " : ""}{eventText(e)} · {fmtWhen(e.createdAt)}
          </span>
        </div>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const cfg = detail.settings;
  const sendBlocked = sendBlockReason(detail);
  const testBanner = cfg && cfg.testMode && cfg.testPhone && !sendBlocked
    ? `Modo de teste ligado: o que você enviar vai para o telefone de teste ${cfg.testPhone}, não para o cliente.`
    : null;

  const composerHint =
    rec.agent_mode === "humano"
      ? "Você está com esta conversa: o agente não responde até você devolver."
      : rec.agent_mode === "pausado"
        ? "Conversa pausada: nem o agente nem a régua mandam nada. Ao enviar, você assume a conversa."
        : "Ao enviar, você assume a conversa: o agente para de responder até você devolver a ele.";

  return (
    <>
      <div className="inbox-read" style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        <div style={{ padding: "0.875rem 1.25rem", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "1rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <span dir="auto">{name}</span>
              <span className={st.cls}>{st.label}</span>
              <span className={mode.cls} title="Quem responde agora">{mode.label}</span>
              {rec.needs_human && <span className="badge badge-danger" title={rec.needs_human_reason ?? ""}>precisa de humano{rec.needs_human_reason ? <>: <span dir="auto">{rec.needs_human_reason}</span></> : ""}</span>}
            </div>
            <div className="hint">
              {rec.phone ?? "sem telefone"} · {langName(rec.language)}{rec.country_code ? ` · ${rec.country_code}` : ""} · {detail.store?.name ?? rec.store_id}
              {rec.waha_session ? ` · número ${rec.waha_session}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
            {rec.needs_human && <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => setMode(rec.agent_mode, true)} title="Tira da fila de 'precisa de humano' sem mudar quem responde">Resolvido</button>}
            {rec.agent_mode !== "humano" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => setMode("humano")} title="Você passa a responder; o agente para e os próximos passos de WhatsApp saem da agenda. O e-mail da régua continua.">Assumir conversa</button>}
            {rec.agent_mode !== "agente" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => setMode("agente")} title="O agente vendedor volta a responder e o próximo e-mail da régua é reagendado (se houver passo seguinte e o cliente não respondeu por e-mail). O WhatsApp da régua não volta.">Devolver ao agente</button>}
            {rec.agent_mode !== "pausado" && <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => setMode("pausado")} title="Ninguém responde e a régua não manda nada">Pausar</button>}
          </div>
        </div>

        <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem" }}>
          {error && <div className="hint" style={{ color: "var(--danger)", marginBottom: "0.5rem" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            {(testCount > 0 || showTests) && (
              <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }} title="Mensagens e eventos de teste foram para o destino de teste, não para o cliente">
                <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} style={{ width: "auto" }} />
                mostrar testes{testCount > 0 ? ` (${testCount})` : ""}
              </label>
            )}
            <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
              <input type="checkbox" checked={showPt} onChange={(e) => setShowPt(e.target.checked)} style={{ width: "auto" }} />
              mostrar tradução em português
            </label>
          </div>
          {timeline.length === 0 && (
            <div className="empty">
              {testCount > 0 && !showTests ? `Só há ${testCount === 1 ? "1 item de teste" : `${testCount} itens de teste`} nesta conversa (escondidos). Marque "mostrar testes" para ver.` : "Nenhuma mensagem ainda. A régua manda a primeira quando chegar a hora, ou você pode escrever abaixo."}
            </div>
          )}
          <div className="chat">{timeline.map((t) => t.node)}</div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)", padding: "0.75rem 1.25rem" }}>
          {sendBlocked && <div className="hint" role="alert" style={{ marginBottom: "0.5rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", borderLeft: "3px solid var(--danger)", background: "var(--background)", color: "var(--danger)" }}>{sendBlocked}</div>}
          {testBanner && <div className="hint" style={{ marginBottom: "0.5rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", borderLeft: "3px solid var(--warn)", background: "var(--warn-soft)" }}>{testBanner}</div>}
          {suggestion && (
            <div className="hint" style={{ marginBottom: "0.5rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", background: "var(--accent-soft)" }}>
              <strong>Sugestão do agente:</strong> ação <em>{ACTION_LABEL[suggestion.action] ?? suggestion.action}</em>
              {suggestion.discount_percent != null ? ` (${suggestion.discount_percent}%)` : ""}
              {suggestion.summary_pt ? ` · ${suggestion.summary_pt}` : ""}
              {!translate && suggestion.reply && suggestion.reply_pt && (
                <div style={{ marginTop: "0.25rem" }}>
                  <span className="hint">Em português: </span>{suggestion.reply_pt}
                  <div className="hint" style={{ marginTop: "0.125rem" }}>A caixa está no idioma do cliente e a tradução foi desligada: Enviar manda exatamente o texto da caixa.</div>
                </div>
              )}
              {translate && suggestion.reply && (
                <div style={{ marginTop: "0.25rem" }} dir="auto">
                  <span className="hint">No idioma do cliente: </span>{suggestion.reply}
                </div>
              )}
            </div>
          )}
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={translate ? "Escreva em português; traduzimos para o idioma do cliente ao enviar." : `Escreva no idioma do cliente (${langName(rec.language)}).`}
            dir={!translate && rtlByText(text, rec.language) ? "rtl" : "auto"}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
              <input type="checkbox" checked={translate} onChange={(e) => toggleTranslate(e.target.checked)} style={{ width: "auto" }} />
              escrever em português e traduzir
            </label>
            <span className="hint">Enter envia · Shift+Enter quebra linha</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={suggest} disabled={suggesting || sending} title="Pede ao agente vendedor uma resposta (não envia)">{suggesting ? "Pensando…" : "Sugerir resposta"}</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={send} disabled={sending || !text.trim() || Boolean(sendBlocked)} title={sendBlocked ?? undefined}>{sending ? "Enviando…" : "Enviar"}</button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", marginTop: "0.375rem", flexWrap: "wrap" }}>
            <span className="hint" style={{ color: rec.agent_mode === "agente" ? "var(--warn)" : undefined }}>{composerHint}</span>
            <Notice notice={notice} />
          </div>
        </div>
      </div>

      <RecoveryCard detail={detail} onPatch={patchRecovery} />
    </>
  );
}
