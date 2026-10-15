"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import StoreSelect from "@/components/StoreSelect";
import { CATEGORY_LABEL, PHASE_CLASS, PHASE_LABEL, PHASE_SHORT, URGENCY_CLASS, fmtDateTime } from "@/lib/ui/labels";

interface Customer {
  id: string;
  email: string;
  name: string | null;
  store: string | null;
  pedidos: number;
  totalConversas: number;
  pendentes: number;
  fase: number | null;
  urgencia: string | null;
  ultimoContato: string | null;
  categorias: string[];
}

export default function ClientesPage() {
  const router = useRouter();
  const [store, setStore] = useState("");
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const [urg, setUrg] = useState("");
  const [onlyPending, setOnlyPending] = useState(true);
  const shown = (customers ?? []).filter((c) => (phase === null ? true : c.fase === phase) && (!urg || c.urgencia === urg) && (!onlyPending || c.pendentes > 0));
  const counts = [1, 2, 3, 4].map((p) => ({ p, n: (customers ?? []).filter((c) => c.fase === p).length }));

  useEffect(() => {
    const sp = new URLSearchParams();
    if (store) sp.set("store", store);
    if (q) sp.set("q", q);
    const t = setTimeout(() => {
      fetch(`/api/clientes?${sp}`)
        .then((r) => r.json())
        .then((d) => setCustomers(d.customers ?? []));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [store, q]);

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 className="page-title">CRM de clientes</h1>
          <p className="page-sub">Todo mundo que já escreveu, com histórico, pedidos e pendências — montado sozinho.</p>
        </div>
        <StoreSelect value={store} onChange={setStore} />
      </div>

      <div className="stat-grid">
        {counts.map(({ p, n }) => (
          <button key={p} type="button" className="stat" style={{ textAlign: "left", cursor: "pointer", outline: phase === p ? "2px solid var(--accent)" : "none" }} onClick={() => setPhase(phase === p ? null : p)}>
            <div className="stat-label">{PHASE_SHORT[p]}</div>
            <div className="stat-value">{n}</div>
            <div className="stat-hint">{PHASE_LABEL[p].split("·")[1]?.trim()}</div>
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <input type="search" placeholder="Buscar por e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={urg} onChange={(e) => setUrg(e.target.value)}>
            <option value="">Urgência</option>
            <option value="urgente">Urgente</option>
            <option value="alta">Alta</option>
            <option value="normal">Normal</option>
            <option value="baixa">Baixa</option>
          </select>
          <label style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, fontSize: "0.75rem", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} style={{ width: "auto" }} />
            só com pendência
          </label>
          {phase !== null && <button type="button" className="btn btn-sm" onClick={() => setPhase(null)}>Todas as fases</button>}
          <span className="hint" style={{ marginLeft: "auto" }}>{customers ? `${shown.length} cliente(s)` : ""}</span>
        </div>
        {customers === null && <div className="empty">Carregando...</div>}
        {customers && shown.length === 0 && <div className="empty">Nenhum cliente nesse filtro.</div>}
        {customers && shown.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Loja</th>
                <th>Pedidos</th>
                <th>Conversas</th>
                <th>Pendentes</th>
                <th>Fase</th>
                <th>Assuntos</th>
                <th>Último contato</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => router.push(`/clientes/${c.id}`)}>
                  <td style={{ fontWeight: 500 }}>{c.email}</td>
                  <td className="hint">{c.store}</td>
                  <td>{c.pedidos || <span className="hint">—</span>}</td>
                  <td>{c.totalConversas}</td>
                  <td>{c.pendentes > 0 ? <span className="badge badge-warn">{c.pendentes}</span> : <span className="hint">0</span>}</td>
                  <td>
                    {c.fase ? <span className={`badge ${PHASE_CLASS[c.fase] ?? ""}`}>{PHASE_SHORT[c.fase]}</span> : <span className="hint">—</span>}
                    {c.urgencia && (c.urgencia === "alta" || c.urgencia === "urgente") && <span className={`badge ${URGENCY_CLASS[c.urgencia]}`} style={{ marginLeft: "0.25rem" }}>{c.urgencia}</span>}
                  </td>
                  <td className="hint">{c.categorias.map((k) => CATEGORY_LABEL[k] ?? k).join(", ") || "—"}</td>
                  <td className="hint">{fmtDateTime(c.ultimoContato)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
