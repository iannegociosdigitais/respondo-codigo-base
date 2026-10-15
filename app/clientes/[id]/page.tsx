"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { CATEGORY_LABEL, STATUS_CLASS, STATUS_LABEL, fmtDateTime } from "@/lib/ui/labels";

interface Data {
  customer: { id: string; email: string; name: string | null; created_at: string; stores: { name: string } | null };
  conversations: Array<{ id: string; subject: string | null; category: string | null; status: string; urgency: string; last_message_at: string | null; analysis: { intent_pt?: string } | null }>;
  orders: Array<{
    name: string;
    createdAt: string;
    financialStatus: string;
    fulfillmentStatus: string;
    totalPrice: string | null;
    currency: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    statusPageUrl: string | null;
    lineItems: Array<{ title: string; quantity: number }>;
  }>;
  promessas: string[];
}

export default function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    fetch(`/api/clientes/${id}`)
      .then((r) => r.json())
      .then(setData);
  }, [id]);

  if (!data) {
    return (
      <Shell>
        <p className="hint">Carregando...</p>
      </Shell>
    );
  }

  const { customer, conversations, orders, promessas } = data;

  return (
    <Shell>
      <Link href="/clientes" className="hint" style={{ textDecoration: "none" }}>
        ← CRM de clientes
      </Link>
      <h1 className="page-title" style={{ marginTop: "0.5rem" }}>{customer.email}</h1>
      <p className="page-sub">
        {customer.stores?.name} · cliente desde {fmtDateTime(customer.created_at)}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card" style={{ margin: 0 }}>
          <div className="section-title">Pedidos na Shopify</div>
          {orders.length === 0 && <p className="hint">Nenhum pedido encontrado pra esse e-mail (ou Shopify não conectada).</p>}
          {orders.map((o) => (
            <div key={o.name} style={{ borderBottom: "1px solid var(--border)", padding: "0.625rem 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{o.name}</strong>
                <span className="hint">{new Date(o.createdAt).toLocaleDateString("pt-BR")}</span>
              </div>
              <div className="hint">
                {o.financialStatus} · {o.fulfillmentStatus}
                {o.totalPrice ? ` · ${o.totalPrice} ${o.currency ?? ""}` : ""}
              </div>
              <div className="hint">{o.lineItems.map((li) => `${li.quantity}x ${li.title}`).join(", ")}</div>
              {o.trackingNumber && (
                <div className="hint">
                  Rastreio:{" "}
                  {o.trackingUrl ? (
                    <a href={o.trackingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      {o.trackingNumber}
                    </a>
                  ) : (
                    o.trackingNumber
                  )}
                </div>
              )}
              {o.statusPageUrl && (
                <a href={o.statusPageUrl} target="_blank" rel="noreferrer" className="hint" style={{ color: "var(--accent)" }}>
                  página de acompanhamento
                </a>
              )}
            </div>
          ))}
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div className="section-title">O que já foi prometido</div>
          {promessas.length === 0 && <p className="hint">Nada registrado.</p>}
          {promessas.map((p, i) => (
            <p key={i} style={{ fontSize: "0.8125rem", margin: "0 0 0.5rem" }}>
              • {p}
            </p>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: "1rem" }}>
        <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <strong>Conversas ({conversations.length})</strong>
          <Link href={`/inbox?status=conversas&customer=${customer.id}`} className="btn btn-sm" style={{ marginLeft: "auto" }}>
            Abrir no Inbox
          </Link>
        </div>
        {conversations.length === 0 ? (
          <div className="empty">Nenhuma conversa.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Assunto</th>
                <th>Resumo</th>
                <th>Categoria</th>
                <th>Status</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => (window.location.href = `/inbox?status=conversas&c=${c.id}`)}>
                  <td>{c.subject || "(sem assunto)"}</td>
                  <td className="hint">{c.analysis?.intent_pt ?? "—"}</td>
                  <td>{c.category ? <span className="badge badge-accent">{CATEGORY_LABEL[c.category] ?? c.category}</span> : "—"}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[c.status] ?? ""}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
                  </td>
                  <td className="hint">{fmtDateTime(c.last_message_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
