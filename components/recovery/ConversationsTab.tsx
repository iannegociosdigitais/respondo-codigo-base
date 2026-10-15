"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, MigrationWarning, fmtWhen, statusInfo, AGENT_MODE_INFO, langName, avatarColor, displayName, errorMessage } from "./shared";
import RecoveryThread from "./RecoveryThread";

// Aba Conversas: chat ao vivo do WhatsApp (lista + thread + ficha), com
// polling de 10 s que só troca os dados (sem "Carregando" depois da 1ª vez).

export interface ConvItem {
  id: string;
  storeId: string;
  store: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  language: string | null;
  country: string | null;
  total: number | null;
  currency: string | null;
  items: string;
  status: string;
  agentMode: string;
  needsHuman: boolean;
  needsHumanReason: string | null;
  unreadCount: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessage: { body: string | null; bodyPt: string | null; author: string; at: string } | null;
  summaryPt: string | null;
  waStep: number;
  emailStep: number;
  offeredDiscountPercent: number | null;
  recoveredOrder: string | null;
  tags: string[];
  abandonedAt: string;
}

export type ConvFilter = "todos" | "humano" | "agente" | "comprou" | "ativos";
const FILTERS: Array<{ key: ConvFilter; label: string }> = [
  { key: "todos", label: "Todos" },
  { key: "humano", label: "Precisa de humano" },
  { key: "agente", label: "Agente" },
  { key: "comprou", label: "Compraram" },
  { key: "ativos", label: "Ativos" },
];

const POLL_MS = 10000;

export default function ConversationsTab({ store, selectedId, onSelect }: { store: string; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [filter, setFilter] = useState<ConvFilter>("todos");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ConvItem[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<ConvFilter, number>>>({});
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);
  // total de conversas que batem com o filtro (a lista traz no máximo `limit`).
  const [meta, setMeta] = useState<{ total: number; limit: number; queryCapped: boolean }>({ total: 0, limit: 200, queryCapped: false });
  const seq = useRef(0);
  // Cada consulta cancela a anterior: o polling não empilha pedidos lentos.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const mySeq = ++seq.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const sp = new URLSearchParams({ filter });
      if (store) sp.set("store", store);
      if (q.trim()) sp.set("q", q.trim());
      const d = await api<{ items?: ConvItem[]; counts?: Partial<Record<ConvFilter, number>>; total?: number; limit?: number; queryCapped?: boolean }>(`/api/recovery/conversations?${sp}`, { signal: ac.signal });
      if (mySeq !== seq.current) return; // resposta velha
      const list = Array.isArray(d.items) ? d.items : [];
      setItems(list);
      setMeta({ total: typeof d.total === "number" ? d.total : list.length, limit: typeof d.limit === "number" ? d.limit : 200, queryCapped: Boolean(d.queryCapped) });
      setCounts(d.counts ?? {});
      setError("");
      setMigrationMissing(false);
    } catch (e) {
      if (ac.signal.aborted || mySeq !== seq.current) return; // cancelada por uma consulta mais nova
      if (e instanceof ApiError && e.migrationMissing) setMigrationMissing(true);
      else setError(errorMessage(e));
      setItems((prev) => prev ?? []);
    }
  }, [filter, store, q]);

  // Busca com debounce; filtros e loja na hora.
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const patchItem = useCallback((id: string, patch: Partial<ConvItem>) => {
    setItems((prev) => (prev ?? []).map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  function select(id: string) {
    onSelect(id);
    patchItem(id, { unreadCount: 0 });
  }

  const humanCount = counts.humano ?? (items ?? []).filter((i) => i.needsHuman).length;

  return (
    <div className="inbox" style={{ height: "auto", flex: 1, minHeight: 0 }}>
      <div className="inbox-list">
        <div className="inbox-list-head">
          <input type="search" placeholder="Buscar nome, telefone, e-mail, produto…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: "0.5rem" }} />
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className={`chip${filter === f.key ? " on" : ""}`} onClick={() => setFilter(f.key)} style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center" }}>
                {f.label}
                {f.key === "humano" && humanCount > 0 && <span className="badge badge-danger">{humanCount}</span>}
                {f.key !== "humano" && counts[f.key] != null && <span className="hint">{counts[f.key]}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="inbox-list-scroll">
          {migrationMissing && <div style={{ padding: "1rem" }}><MigrationWarning /></div>}
          {error && !migrationMissing && <div className="hint" style={{ padding: "0.5rem 1rem", color: "var(--danger)", borderBottom: "1px solid var(--border)" }}>{error}</div>}
          {items === null && !error && !migrationMissing && <div className="empty">Carregando…</div>}
          {items?.length === 0 && !migrationMissing && (
            <div className="empty">
              {q.trim()
                ? "Nenhuma conversa encontrada para essa busca."
                : filter === "humano"
                  ? "Ninguém esperando por você agora."
                  : filter !== "todos"
                    ? "Nenhuma conversa neste filtro."
                    : "Nenhum carrinho com telefone ainda. Esta aba lista os carrinhos abandonados que têm telefone; as mensagens aparecem na conversa quando a régua de WhatsApp enviar ou o cliente responder."}
            </div>
          )}
          {items && meta.total > items.length && (
            <div className="hint" style={{ padding: "0.375rem 1rem", borderBottom: "1px solid var(--border)" }}>
              Mostrando {items.length} de {meta.total}. Refine pela busca ou pelos filtros para ver as outras.
            </div>
          )}
          {meta.queryCapped && items && (
            <div className="hint" style={{ padding: "0.375rem 1rem", borderBottom: "1px solid var(--border)" }}>
              A lista considera só os {1000} carrinhos com telefone mais recentes.
            </div>
          )}
          {items?.map((r) => {
            const name = displayName(r.name, r.phone, r.email);
            const preview = r.summaryPt || r.lastMessage?.bodyPt || r.lastMessage?.body || r.items || "";
            const lastAt = r.lastMessage?.at ?? r.lastInboundAt ?? r.lastOutboundAt ?? r.abandonedAt;
            const unread = r.unreadCount > 0;
            const mode = AGENT_MODE_INFO[r.agentMode] ?? { label: r.agentMode, cls: "badge" };
            const st = statusInfo(r.status);
            return (
              <div key={r.id} role="button" tabIndex={0} className={`inbox-item${r.id === selectedId ? " active" : ""}${unread ? " unread" : " read"}`} onClick={() => select(r.id)} onKeyDown={(e) => e.key === "Enter" && select(r.id)}>
                <div style={{ display: "flex", gap: "0.625rem" }}>
                  <span className="avatar" style={{ background: avatarColor(r.phone ?? r.id) }}>{name.slice(0, 1).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row">
                      <span className="who" dir="auto">
                        {unread && <span className="dot" />}
                        {name}
                        {r.phone && r.name ? <span className="hint" dir="ltr" style={{ fontWeight: 400 }}> · {r.phone}</span> : null}
                      </span>
                      <span className="when">
                        {unread && <span className="badge badge-accent" style={{ marginRight: 4 }}>{r.unreadCount}</span>}
                        {fmtWhen(lastAt)}
                      </span>
                    </div>
                    <div className="subject" style={{ display: "flex", gap: "0.375rem", alignItems: "baseline" }}>
                      {!store && <span className="hint" style={{ flexShrink: 0 }}>{r.store}</span>}
                      <span className="hint">{langName(r.language)}{r.country ? ` · ${r.country}` : ""}</span>
                    </div>
                    {preview && (
                      <div className="preview" title={preview}>
                        {r.lastMessage && !r.summaryPt ? <span className="hint">{r.lastMessage.author === "cliente" ? "Cliente: " : r.lastMessage.author === "humano" ? "Você: " : r.lastMessage.author === "agente" ? "Agente: " : "Régua: "}</span> : null}
                        <span dir="auto">{preview}</span>
                      </div>
                    )}
                    <div className="meta">
                      {r.needsHuman && <span className="badge badge-danger" title={r.needsHumanReason ?? ""}>precisa de humano</span>}
                      <span className={st.cls}>{st.label}</span>
                      <span className={mode.cls}>{mode.label}</span>
                      {r.waStep > 0 && <span className="badge" title="Passo da régua de WhatsApp">WA {r.waStep}</span>}
                      {r.emailStep > 0 && <span className="badge" title="Passo da régua de e-mail">E-mail {r.emailStep}</span>}
                      {r.offeredDiscountPercent != null && Number(r.offeredDiscountPercent) > 0 && <span className="badge badge-warn">{Number(r.offeredDiscountPercent)}% oferecido</span>}
                      {r.recoveredOrder && <span className="badge badge-ok">{r.recoveredOrder}</span>}
                      {(r.tags ?? []).slice(0, 2).map((t) => <span key={t} className="badge" dir="auto">{t}</span>)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedId ? (
        <RecoveryThread key={selectedId} id={selectedId} onPatch={patchItem} onRefreshList={load} />
      ) : (
        <div className="inbox-read">
          <div className="empty" style={{ paddingTop: "6rem" }}>Selecione uma conversa à esquerda para ler e responder.</div>
        </div>
      )}
    </div>
  );
}
