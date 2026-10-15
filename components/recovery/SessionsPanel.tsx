"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WhatsappSessionRow } from "@/lib/recovery/types";
import { api, ApiError, fmtDateTime, errorMessage, Notice, SectionTitle, SESSION_STATUS_CLASS, SESSION_STATUS_LABEL } from "./shared";

// Números de WhatsApp da loja (sessões do WAHA): status ao vivo, QR para
// conectar, tetos e ações. Polling de 10 s enquanto a aba está aberta.

const POLL_MS = 10000;
// Mesmo critério do servidor (sessions/route.ts): começa com letra ou número.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/i;

export default function SessionsPanel({ storeId, wahaConfigured }: { storeId: string; wahaConfigured: boolean }) {
  const [sessions, setSessions] = useState<WhatsappSessionRow[] | null>(null);
  const [configured, setConfigured] = useState(wahaConfigured);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [ts, setTs] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [cap, setCap] = useState(30);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const mySeq = ++seq.current;
    try {
      const d = await api<{ sessions?: WhatsappSessionRow[]; wahaConfigured?: boolean }>(`/api/recovery/sessions?store=${encodeURIComponent(storeId)}`);
      if (mySeq !== seq.current) return;
      setSessions(Array.isArray(d.sessions) ? d.sessions : []);
      if (typeof d.wahaConfigured === "boolean") setConfigured(d.wahaConfigured);
      setError("");
      setTs(Date.now());
    } catch (e) {
      if (mySeq !== seq.current) return;
      setError(e instanceof ApiError && e.migrationMissing ? "Tabela de sessões ausente (migration 0018)." : errorMessage(e));
      setSessions((prev) => prev ?? []);
    }
  }, [storeId]);

  useEffect(() => {
    setSessions(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function run(key: string, fn: () => Promise<void>, okText?: string) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  function connect() {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setNotice({ kind: "err", text: "Nome da sessão: começa com letra ou número e usa só letras, números, hífen e sublinhado (2 a 40 caracteres). Ex.: pure-il-1." });
      return;
    }
    run("connect", async () => {
      await api(`/api/recovery/sessions`, { method: "POST", json: { store: storeId, name: n, label: label.trim() || undefined, daily_cap: cap } });
      setName("");
      setLabel("");
    }, "Sessão criada. Se aparecer o QR abaixo, leia com o WhatsApp do número (Aparelhos conectados).");
  }

  const action = (s: WhatsappSessionRow, a: "start" | "stop" | "restart" | "logout") => {
    if (a === "logout" && !window.confirm(`Desconectar o número da sessão ${s.name}? Vai precisar ler o QR de novo.`)) return;
    run(`${a}:${s.name}`, async () => {
      await api(`/api/recovery/sessions/${encodeURIComponent(s.name)}/action`, { method: "POST", json: { action: a } });
    });
  };

  const patch = (s: WhatsappSessionRow, body: { active?: boolean; daily_cap?: number; label?: string }) =>
    run(`patch:${s.name}`, async () => {
      await api(`/api/recovery/sessions/${encodeURIComponent(s.name)}`, { method: "PATCH", json: body });
    });

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <SectionTitle right={configured ? <span className="badge badge-ok">WAHA configurado</span> : <span className="badge badge-danger">sem WAHA_URL / WAHA_API_KEY</span>}>Números de WhatsApp</SectionTitle>
      <p className="hint" style={{ marginBottom: "0.75rem" }}>
        Cada número é uma sessão no WAHA. A régua alterna entre os números ativos e conectados, respeitando o teto diário de cada um; o cliente fica preso ao número que falou com ele. Número restrito pelo WhatsApp fica 24 h fora da rotação.
      </p>
      {error && <div className="hint" style={{ color: "var(--danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {sessions === null && !error && <div className="hint">Carregando…</div>}
      {sessions?.length === 0 && <div className="hint" style={{ marginBottom: "0.75rem" }}>Nenhum número conectado nesta loja ainda.</div>}

      <div style={{ display: "grid", gap: "0.75rem" }}>
        {(sessions ?? []).map((s) => {
          const status = s.status ?? "?";
          const restricted = s.restricted_until && new Date(s.restricted_until).getTime() > Date.now();
          const sent = s.sent_today_date === new Date().toISOString().slice(0, 10) ? s.sent_today : 0;
          const waitingQr = status === "SCAN_QR_CODE";
          const b = (k: string) => busy === `${k}:${s.name}`;
          return (
            <div key={s.name} style={{ border: "1px solid var(--border)", borderRadius: "0.625rem", padding: "0.75rem 0.875rem", display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: "16rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{s.label || s.name}</strong>
                  {s.label && <span className="hint">{s.name}</span>}
                  <span className={SESSION_STATUS_CLASS[status] ?? "badge"}>{SESSION_STATUS_LABEL[status] ?? status}</span>
                  {!s.active && <span className="badge">fora da rotação</span>}
                  {restricted && <span className="badge badge-danger" title={`até ${fmtDateTime(s.restricted_until)}`}>restrito pelo WhatsApp</span>}
                </div>
                <div className="hint" style={{ marginTop: "0.25rem" }}>
                  {s.me_name || s.phone || s.me_id ? `${s.me_name ?? ""} ${s.phone ?? s.me_id ?? ""}`.trim() : "número ainda não identificado"}
                  {" · "}enviados hoje: {sent} / {s.daily_cap}
                  {s.last_used_at ? ` · último uso ${fmtDateTime(s.last_used_at)}` : ""}
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem", flexWrap: "wrap" }}>
                  <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
                    <input type="checkbox" checked={s.active} disabled={Boolean(busy)} onChange={(e) => patch(s, { active: e.target.checked })} style={{ width: "auto" }} />
                    ativo na rotação
                  </label>
                  <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
                    teto/dia
                    <input type="number" min={1} max={500} defaultValue={s.daily_cap} key={`${s.name}:${s.daily_cap}`} disabled={Boolean(busy)} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== s.daily_cap) patch(s, { daily_cap: v }); }} style={{ width: "4.5rem", padding: "0.2rem 0.4rem", fontSize: "0.75rem" }} />
                  </label>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => { const v = window.prompt("Apelido do número (só para o painel):", s.label ?? ""); if (v !== null) patch(s, { label: v.trim() }); }}>renomear</button>
                </div>
                <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                  {status !== "WORKING" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => action(s, "start")}>{b("start") ? "…" : "Iniciar"}</button>}
                  <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => action(s, "restart")}>{b("restart") ? "…" : "Reiniciar"}</button>
                  {status !== "STOPPED" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => action(s, "stop")}>{b("stop") ? "…" : "Parar"}</button>}
                  <button type="button" className="btn btn-sm btn-danger" disabled={Boolean(busy)} onClick={() => action(s, "logout")}>{b("logout") ? "…" : "Sair do número"}</button>
                </div>
              </div>
              {waitingQr && (
                <div style={{ textAlign: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/recovery/sessions/${encodeURIComponent(s.name)}/qr?ts=${ts}`} alt="QR para conectar o WhatsApp" width={200} height={200} style={{ width: 200, height: 200, borderRadius: 8, background: "#fff", border: "1px solid var(--border)" }} />
                  <div className="hint" style={{ marginTop: "0.25rem" }}>WhatsApp → Aparelhos conectados → Conectar. Atualiza a cada 10 s.</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
        <div className="section-title" style={{ marginBottom: "0.5rem" }}>Conectar número</div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="nome da sessão (ex.: pure-il-1)" style={{ width: "14rem" }} />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="apelido (opcional)" style={{ width: "12rem" }} />
          <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
            teto/dia
            <input type="number" min={1} max={500} value={cap} onChange={(e) => setCap(Number(e.target.value) || 30)} style={{ width: "4.5rem", padding: "0.3rem 0.4rem" }} />
          </label>
          <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy) || !configured || !name.trim()} onClick={connect}>{busy === "connect" ? "Criando…" : "Conectar número"}</button>
          <Notice notice={notice} />
        </div>
        <div className="hint" style={{ marginTop: "0.375rem" }}>Depois de criar, o QR aparece na lista acima. Comece com teto baixo (20 a 30 por dia) num número novo e suba aos poucos.</div>
      </div>
    </div>
  );
}
