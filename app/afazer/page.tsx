"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { fmtDateTime } from "@/lib/ui/labels";

interface Item {
  conversationId: string;
  index: number;
  type: string;
  text: string;
  created_at: string;
  done: boolean;
  done_at?: string | null;
  subject: string | null;
  store: string | null;
  customer: { id: string; email: string; name: string | null } | null;
  formId?: string;
}

const SECTIONS = [
  { type: "cancelar_assinatura", title: "Cancelar a assinatura", hint: "Clientes a quem você escreveu que a assinatura seria (ou já foi) cancelada. Cancele na Shopify e marque." },
  { type: "regularizacao_financeira", title: "Reembolsar", hint: "Clientes a quem você escreveu que o reembolso seria (ou já foi) solicitado, e formulários de dinheiro de volta que você aprovou." },
  { type: "corrigir_endereco", title: "Corrigir endereço", hint: "Clientes que corrigiram o endereço de entrega — atualize na Shopify (se o pedido ainda não foi enviado) e marque." },
  { type: "reenvio_formulario", title: "Reenviar", hint: "Formulários de reenvio que você aprovou." },
] as const;

export default function AFazerPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/todos${showDone ? "?all=1" : ""}`)
      .then((r) => r.json())
      .then((d) => setItems(d.todos ?? []));
  }, [showDone]);
  useEffect(load, [load]);

  async function toggle(it: Item) {
    await fetch("/api/todos", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: it.conversationId, index: it.index, formId: it.formId, done: !it.done }) });
    window.dispatchEvent(new Event("respondo:counts"));
    load();
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <Shell>
      <h1 className="page-title">A fazer</h1>
      <p className="page-sub">Só duas coisas, anotadas sozinhas a cada e-mail que você envia: de quem cancelar a assinatura e a quem reembolsar. Marque quando fizer.</p>
      <label className="hint" style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center", fontWeight: 400, margin: "0.5rem 0 1rem" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
        mostrar também os já feitos
      </label>

      {items === null && <div className="empty">Carregando...</div>}
      {items &&
        SECTIONS.map((sec) => {
          const list = items.filter((it) => it.type === sec.type);
          const open = list.filter((it) => !it.done);
          return (
            <div key={sec.type} className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "1.25rem" }}>
              <div style={{ padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div className="section-title" style={{ margin: 0 }}>{sec.title} <span className="badge badge-danger" style={{ marginLeft: "0.375rem" }}>{open.length}</span></div>
                  <div className="hint" style={{ marginTop: "0.125rem" }}>{sec.hint}</div>
                </div>
                {open.length > 0 && (
                  <button type="button" className="btn btn-sm" onClick={() => copy(open.map((it) => it.customer?.email).filter(Boolean).join("\n"))}>
                    {copied && copied.includes("\n") ? "Copiado" : "Copiar todos os e-mails"}
                  </button>
                )}
              </div>
              {list.length === 0 && <div className="empty">Nada aqui.</div>}
              {list.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: "4rem" }}>Feito</th>
                      <th>E-mail do cliente</th>
                      <th>O que foi prometido</th>
                      <th>Quando</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((it) => (
                      <tr key={it.formId ?? `${it.conversationId}-${it.index}`} style={it.done ? { opacity: 0.5 } : undefined}>
                        <td>
                          <input type="checkbox" style={{ width: "auto" }} checked={it.done} onChange={() => toggle(it)} />
                        </td>
                        <td>
                          <button type="button" onClick={() => copy(it.customer?.email ?? "")} title="Copiar e-mail" style={{ all: "unset", cursor: "pointer", fontWeight: 600, fontSize: "0.9375rem" }}>
                            {it.customer?.email}
                          </button>
                          {copied === it.customer?.email && <span className="hint" style={{ marginLeft: "0.375rem" }}>copiado</span>}
                          <div className="hint">{[it.customer?.name, it.store].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td style={{ textDecoration: it.done ? "line-through" : "none" }}>{it.text}</td>
                        <td className="hint">{fmtDateTime(it.created_at)}</td>
                        <td>
                          {it.formId ? <Link className="btn btn-sm" href="/formularios">Ver formulário</Link> : <Link className="btn btn-sm" href={`/inbox?status=conversas&c=${it.conversationId}`}>Abrir conversa</Link>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
    </Shell>
  );
}
