"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { fmtDateTime } from "@/lib/ui/labels";

interface Req {
  id: string; reference: string; status: string; product_name: string | null; customer_email: string; customer_name: string | null; phone: string | null; language: string | null;
  orders: Array<{ name: string; date: string; items: string[]; total: string | null; currency: string | null; totalLabel?: string }>;
  received_at: string | null; not_received: boolean; address: Record<string, string> | null; description: string | null; resolution: string | null;
  fill_seconds: number | null; messages: Array<{ who: string; text: string; at: string }>; decided_at: string | null; executed_at: string | null; created_at: string; conversation_id: string | null; signature_png: string | null; ip: string | null;
}

const STATUS: Record<string, { label: string; cls: string; hint: string }> = {
  pendente: { label: "Pendentes", cls: "badge-warn", hint: "Aguardando a sua decisão." },
  aprovado: { label: "Aprovados", cls: "badge-ok", hint: "Você aprovou; falta executar ou já executado." },
  rejeitado: { label: "Rejeitados", cls: "badge-danger", hint: "Recusados por você." },
  encerrado: { label: "Encerrados", cls: "", hint: "Fechados sem decisão." },
};

export default function FormulariosPage() {
  const [data, setData] = useState<{ requests: Req[]; counters: Record<string, number>; links: Array<{ product: string; link: string }>; missingTable?: boolean } | null>(null);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Req | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showLinks, setShowLinks] = useState(false);
  const [copied, setCopied] = useState("");

  const load = useCallback(() => {
    const sp = new URLSearchParams();
    if (status) sp.set("status", status);
    if (q) sp.set("q", q);
    fetch(`/api/formularios?${sp}`).then((r) => r.json()).then(setData);
  }, [status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!open) return;
    setBusy(true); setNote("");
    const r = await fetch("/api/formularios", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: open.id, action, ...extra }) });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) { setNote(d.error ?? "Falhou."); return; }
    if (action === "reply") { setReply(""); setNote("E-mail enviado."); setOpen({ ...open, messages: d.messages }); }
    else { setOpen(null); }
    load();
    window.dispatchEvent(new Event("respondo:counts"));
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(""), 1500); });
  }

  return (
    <Shell>
      <h1 className="page-title">Formulários</h1>
      <p className="page-sub">Solicitações preenchidas e assinadas pelos clientes (reenvio ou dinheiro de volta). É o registro único de quem pediu estorno.</p>

      <div className="card" style={{ marginBottom: "1rem", padding: "0.875rem 1rem" }}>
        <button type="button" onClick={() => setShowLinks((v) => !v)} style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", width: "100%" }}>
          <span><strong>Links dos formulários</strong><span className="hint" style={{ marginLeft: "0.5rem" }}>Link geral por produto (o cliente digita o e-mail). O link pessoal de cada cliente fica no botão "Link do formulário" dentro da conversa.</span></span>
          <span>{showLinks ? "▴" : "▾"}</span>
        </button>
        {showLinks && (data?.links ?? []).map((l) => (
          <div key={l.product} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
            <span className="badge badge-accent">{l.product}</span>
            <code style={{ fontSize: "0.75rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{l.link}</code>
            <button type="button" className="btn btn-sm" onClick={() => copy(l.link)}>{copied === l.link ? "Copiado" : "Copiar"}</button>
          </div>
        ))}
      </div>

      {data?.missingTable && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--warn)" }}>
          Falta criar a tabela no banco: cole o arquivo <code>supabase/migrations/0013_return_requests.sql</code> no SQL Editor do Supabase e clique em Run. Depois disso os formulários enviados aparecem aqui.
        </div>
      )}

      <div className="stat-grid">
        {Object.entries(STATUS).map(([k, s]) => (
          <button key={k} type="button" className="stat" style={{ textAlign: "left", cursor: "pointer", outline: status === k ? "2px solid var(--accent)" : "none" }} onClick={() => setStatus(status === k ? "" : k)}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{data?.counters?.[k] ?? "–"}</div>
            <div className="stat-hint">{s.hint}</div>
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <input type="search" placeholder="Buscar por cliente, e-mail ou referência" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!data && <div className="empty">Carregando...</div>}
        {data && data.requests.length === 0 && <div className="empty">Nenhum formulário {status ? "nesse status" : "ainda"}. Quando um cliente enviar, aparece aqui.</div>}
        {data && data.requests.length > 0 && (
          <table className="table">
            <thead><tr><th>Ref.</th><th>Produto</th><th>Cliente</th><th>Pedidos</th><th>Quer</th><th>Status</th><th>Data</th></tr></thead>
            <tbody>
              {data.requests.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => { setOpen(r); setNote(""); setReply(""); }}>
                  <td><code>{r.reference}</code></td>
                  <td>{r.product_name?.split(/\s+/)[0] ?? "—"}</td>
                  <td><div style={{ fontWeight: 600 }}>{r.customer_email}</div><div className="hint">{r.customer_name}</div></td>
                  <td className="hint">{r.orders.map((o) => o.name).join(", ")}</td>
                  <td>{r.resolution === "reenvio" ? <span className="badge badge-accent">reenvio</span> : <span className="badge badge-danger">dinheiro de volta</span>}</td>
                  <td><span className={`badge ${STATUS[r.status]?.cls ?? ""}`}>{r.status}</span>{r.status === "aprovado" && (r.executed_at ? <span className="hint" style={{ marginLeft: "0.25rem" }}>executado</span> : <span className="badge badge-warn" style={{ marginLeft: "0.25rem" }}>falta executar</span>)}</td>
                  <td className="hint">{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "grid", placeItems: "center", padding: "1rem" }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(46rem, 100%)", maxHeight: "92vh", overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <div><span className={`badge ${STATUS[open.status]?.cls ?? ""}`}>{open.status}</span> <code>#{open.reference}</code> <span className="hint">{fmtDateTime(open.created_at)}</span></div>
              <div style={{ display: "flex", gap: "0.375rem" }}>
                {open.conversation_id && <Link className="btn btn-sm" href={`/inbox?status=conversas&c=${open.conversation_id}`}>Abrir conversa</Link>}
                <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Fechar</button>
              </div>
            </div>

            <dl className="analysis" style={{ display: "grid", gridTemplateColumns: "9rem 1fr", gap: "0.375rem 0.75rem", fontSize: "0.875rem" }}>
              <dt>Cliente</dt><dd><strong>{open.customer_name}</strong> · <button type="button" onClick={() => copy(open.customer_email)} style={{ all: "unset", cursor: "pointer", textDecoration: "underline" }}>{open.customer_email}</button> · {open.phone}</dd>
              <dt>Produto</dt><dd>{open.product_name ?? "—"} · idioma {open.language ?? "—"}</dd>
              <dt>Pedidos</dt><dd>{open.orders.map((o) => `${o.name} (${o.totalLabel ? `${o.totalLabel} · loja: ` : ""}${o.currency} ${o.total}) — ${o.items.join(", ")}`).join(" | ")}</dd>
              <dt>Recebeu?</dt><dd>{open.not_received ? "Diz que NÃO recebeu" : `Recebeu em ${open.received_at ?? "—"}`}</dd>
              <dt>Endereço</dt><dd>{open.address ? [open.address.address1, open.address.address2, open.address.zip, open.address.city, open.address.state, open.address.country].filter(Boolean).join(", ") : "—"}</dd>
              <dt>Quer</dt><dd><strong>{open.resolution === "reenvio" ? "Reenvio do pedido" : "Dinheiro de volta"}</strong></dd>
              <dt>O que houve</dt><dd style={{ whiteSpace: "pre-wrap" }}>{open.description}</dd>
              <dt>Registro</dt><dd className="hint">preenchido em {open.fill_seconds ? `${Math.floor(open.fill_seconds / 60)}min ${open.fill_seconds % 60}s` : "—"} · IP {open.ip ?? "—"}</dd>
            </dl>

            <div className="section-title" style={{ marginTop: "1rem" }}>Assinatura digital</div>
            {open.signature_png ? <img src={open.signature_png} alt="assinatura" style={{ width: "100%", maxHeight: "11rem", objectFit: "contain", background: "#fff", borderRadius: "0.5rem", border: "1px solid var(--border)" }} /> : <p className="hint">Sem assinatura.</p>}

            {open.messages?.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: "1rem" }}>Mensagens ({open.messages.length})</div>
                {open.messages.map((m, i) => (<div key={i} className="msg out" style={{ maxWidth: "100%" }}><div className="hint">{fmtDateTime(m.at)} · você</div><div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div></div>))}
              </>
            )}

            <div className="section-title" style={{ marginTop: "1rem" }}>Responder por e-mail <span className="hint">para {open.customer_email} (no idioma do cliente)</span></div>
            <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Digite a resposta ao cliente sobre esta solicitação..." />
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={busy || !reply.trim()} onClick={() => act("reply", { text: reply })}>Enviar e-mail</button>
              <span style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                {open.status === "aprovado" && <button type="button" className="btn" disabled={busy} onClick={() => act("executado", { done: !open.executed_at })}>{open.executed_at ? "Desmarcar executado" : "Marcar como executado"}</button>}
                {open.status !== "pendente" && <button type="button" className="btn" disabled={busy} onClick={() => act("reabrir")}>Reabrir</button>}
                {open.status === "pendente" && <button type="button" className="btn" disabled={busy} onClick={() => act("encerrar")}>Encerrar</button>}
                {open.status === "pendente" && <button type="button" className="btn" style={{ color: "var(--danger)" }} disabled={busy} onClick={() => act("rejeitar")}>Rejeitar</button>}
                {open.status === "pendente" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("aprovar")}>Aprovar</button>}
              </span>
            </div>
            {note && <p className="hint" style={{ marginTop: "0.5rem" }}>{note}</p>}
          </div>
        </div>
      )}
    </Shell>
  );
}
