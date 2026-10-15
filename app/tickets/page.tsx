"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import StoreSelect from "@/components/StoreSelect";
import { CATEGORY_LABEL, LANG_LABEL, PHASE_CLASS, PHASE_SHORT, STATUS_CLASS, STATUS_LABEL, URGENCY_CLASS, fmtDateTime } from "@/lib/ui/labels";

interface Row {
  id: string;
  subject: string | null;
  category: string | null;
  urgency: string;
  status: string;
  unread: boolean;
  mentions_threat: boolean;
  wants_refund: boolean;
  last_message_at: string | null;
  analysis: { phase?: number; ticket?: boolean; ticket_reason?: string | null; missing_context_pt?: string | null; unanswered_count?: number; waiting_days?: number; customer_wants_pt?: string } | null;
  stores: { id: string; name: string } | null;
  customers: { id: string; email: string } | null;
}

interface Counters {
  pendentes: number;
  respondidos: number;
  reabertos: number;
  encerrados: number;
}

const FILTERS = [
  { key: "pendentes", label: "Pendentes" },
  { key: "respondidos", label: "Respondidos" },
  { key: "reaberta", label: "Reabertos" },
  { key: "encerrada", label: "Encerrados" },
  { key: "conversas", label: "Todos" },
];

export default function TicketsPage() {
  const router = useRouter();
  const [store, setStore] = useState("");
  const [filter, setFilter] = useState("pendentes");
  // Tickets = só o que precisa do dono pessoalmente. "Todas" mostra o correio inteiro.
  const [onlyTickets, setOnlyTickets] = useState(true);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [urgency, setUrgency] = useState("");
  const [lang, setLang] = useState("");
  const [phase, setPhase] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(action: string) {
    if (selected.size === 0) return;
    if (action === "encerrar" && !confirm(`Encerrar ${selected.size} conversa(s)?`)) return;
    setBulkBusy(true);
    await fetch("/api/conversations/bulk", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected], action }) });
    setBulkBusy(false);
    setSelected(new Set());
    setRows((prev) => (prev ?? []).filter((r) => !selected.has(r.id)));
    const sp = new URLSearchParams({ days: "365" });
    if (store) sp.set("store", store);
    fetch(`/api/dashboard?${sp}`).then((r) => r.json()).then((d) => setCounters(d.tickets));
  }

  useEffect(() => {
    const sp = new URLSearchParams({ days: "365" });
    if (store) sp.set("store", store);
    fetch(`/api/dashboard?${sp}`)
      .then((r) => r.json())
      .then((d) => setCounters(d.tickets));
  }, [store]);

  useEffect(() => {
    const sp = new URLSearchParams({ status: filter, limit: "300", sort: "urgencia" });
    if (onlyTickets) { sp.set("ticket", "1"); sp.set("unique", "1"); }
    if (store) sp.set("store", store);
    if (q) sp.set("q", q);
    if (category) sp.set("category", category);
    if (urgency) sp.set("urgency", urgency);
    if (lang) sp.set("lang", lang);
    if (phase) sp.set("phase", phase);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    const t = setTimeout(() => {
      fetch(`/api/conversations?${sp}`)
        .then((r) => r.json())
        .then((d) => setRows(d.conversations ?? []));
    }, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [store, filter, q, category, urgency, lang, from, to, phase, onlyTickets]);

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 className="page-title">Tickets</h1>
          <p className="page-sub">Só o que precisa de você pessoalmente: ameaça ou contestação, cliente no limite, muitos e-mails sem resposta, ou e-mail que a IA não conseguiu responder com o contexto atual. O correio inteiro fica no Inbox.</p>
          <label className="hint" style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center", fontWeight: 400, marginTop: "0.25rem" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!onlyTickets} onChange={(e) => setOnlyTickets(!e.target.checked)} />
            mostrar todas as conversas (não só tickets)
          </label>
        </div>
        <StoreSelect value={store} onChange={setStore} />
      </div>

      <div className="stat-grid" style={onlyTickets ? { display: "none" } : undefined}>
        <button type="button" className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("pendentes")}>
          <div className="stat-label">Pendentes</div>
          <div className="stat-value" style={{ color: "var(--warn)" }}>{counters?.pendentes ?? "–"}</div>
          <div className="stat-hint">Cliente esperando resposta</div>
        </button>
        <button type="button" className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("respondidos")}>
          <div className="stat-label">Respondidos</div>
          <div className="stat-value" style={{ color: "var(--ok)" }}>{counters?.respondidos ?? "–"}</div>
          <div className="stat-hint">Última palavra foi da loja</div>
        </button>
        <button type="button" className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("reaberta")}>
          <div className="stat-label">Reabertos</div>
          <div className="stat-value" style={{ color: "var(--danger)" }}>{counters?.reabertos ?? "–"}</div>
          <div className="stat-hint">Cliente voltou depois de respondido</div>
        </button>
        <button type="button" className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setFilter("encerrada")}>
          <div className="stat-label">Encerrados</div>
          <div className="stat-value">{counters?.encerrados ?? "–"}</div>
          <div className="stat-hint">Fechados por você</div>
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <input type="search" placeholder="Buscar por cliente, e-mail, pedido ou assunto" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="tabs">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className={`tab${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Categoria</option>
            {Object.entries(CATEGORY_LABEL).filter(([k]) => k !== "sem_categoria").map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="">Urgência</option>
            <option value="urgente">Urgente</option>
            <option value="alta">Alta</option>
            <option value="normal">Normal</option>
            <option value="baixa">Baixa</option>
          </select>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="">Idioma</option>
            {Object.entries(LANG_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select value={phase} onChange={(e) => setPhase(e.target.value)}>
            <option value="">Fase</option>
            <option value="1">Fase 1</option>
            <option value="2">Fase 2</option>
            <option value="3">Fase 3</option>
            <option value="4">Fase 4</option>
          </select>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} title="De" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} title="Até" />
          {selected.size > 0 ? (
            <div style={{ marginLeft: "auto", display: "flex", gap: "0.375rem", alignItems: "center" }}>
              <span className="hint">{selected.size} selecionada(s)</span>
              <button type="button" className="btn btn-sm" onClick={() => bulk("encerrar")} disabled={bulkBusy}>Encerrar</button>
              <button type="button" className="btn btn-sm" onClick={() => bulk("spam")} disabled={bulkBusy}>Spam</button>
              <button type="button" className="btn btn-sm" onClick={() => bulk("reabrir")} disabled={bulkBusy}>Reabrir</button>
              <button type="button" className="btn btn-sm" onClick={() => bulk("reanalisar")} disabled={bulkBusy}>Reanalisar</button>
            </div>
          ) : (
            <span className="hint" style={{ marginLeft: "auto" }}>{rows ? `${rows.length} ticket(s)` : ""}</span>
          )}
        </div>

        {rows === null && <div className="empty">Carregando...</div>}
        {rows?.length === 0 && <div className="empty">Nenhum ticket nesse filtro.</div>}
        {rows && rows.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "2rem" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={rows.length > 0 && selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                </th>
                <th>Loja</th>
                <th>Cliente</th>
                <th>Assunto</th>
                <th>Categoria</th>
                <th>Status</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => router.push(`/inbox?status=${filter}&c=${r.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" style={{ width: "auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td>{r.stores?.name}</td>
                  <td style={{ fontWeight: r.unread ? 700 : 500 }}>{r.customers?.email}</td>
                  <td>
                    {r.subject || "(sem assunto)"}
                    <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem" }}>
                      {r.analysis?.phase && <span className={`badge ${PHASE_CLASS[r.analysis.phase] ?? ""}`}>{PHASE_SHORT[r.analysis.phase]}</span>}
                      {r.urgency && (r.urgency === "alta" || r.urgency === "urgente") && <span className={`badge ${URGENCY_CLASS[r.urgency]}`}>{r.urgency}</span>}
                      {r.mentions_threat && <span className="badge badge-danger">ameaça</span>}
                      {r.wants_refund && <span className="badge badge-danger">reembolso</span>}
                    </div>
                    {r.analysis?.ticket_reason && <div className="hint" style={{ marginTop: "0.25rem", color: "var(--danger)" }}>Por que é ticket: {r.analysis.ticket_reason}</div>}
                    {r.analysis?.missing_context_pt && <div className="hint" style={{ marginTop: "0.125rem" }}>IA pede contexto: {r.analysis.missing_context_pt}</div>}
                  </td>
                  <td>{r.category ? <span className="badge badge-accent">{CATEGORY_LABEL[r.category] ?? r.category}</span> : <span className="hint">—</span>}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  </td>
                  <td className="hint">{fmtDateTime(r.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
