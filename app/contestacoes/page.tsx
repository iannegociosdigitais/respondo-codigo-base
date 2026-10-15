"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";

interface Store { id: string; name: string; agent_name: string | null }
interface Result { orderNumber: string; conversationId: string | null }

// Registro manual de contestação bancária (chargeback): quando você vê o
// aviso no painel da Shopify em vez de chegar por e-mail. Busca o pedido,
// registra o cliente e já deixa o rascunho pronto — nada é enviado sozinho.
export default function ContestacoesPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  const [orderNumbers, setOrderNumbers] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/stores").then((r) => r.json()).then((d) => {
      setStores(d.stores ?? []);
      if (d.stores?.[0]) setStoreId(d.stores[0].id);
    });
  }, []);

  async function submit() {
    setBusy(true); setError(""); setResults(null);
    const numbers = orderNumbers.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const r = await fetch("/api/chargebacks/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId, orderNumbers: numbers }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(d.error ?? "Falhou."); return; }
    setResults(d.results ?? []);
    setOrderNumbers("");
  }

  return (
    <Shell>
      <h1 className="page-title">Contestação bancária (chargeback)</h1>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        Use quando você vir o aviso direto no painel da Shopify (antes de chegar e-mail, ou se não chegar). Busca o(s) pedido(s) na Shopify da loja escolhida, junta tudo numa conversa por cliente e já deixa o rascunho pronto no Inbox, seguindo a regra de contestação. <strong>Nada é enviado sozinho.</strong>
      </p>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}>
        <label>
          Loja
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ display: "block", width: "100%" }}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.agent_name ? ` (${s.agent_name})` : ""}</option>)}
          </select>
        </label>
        <label>
          Nº do(s) pedido(s) — separados por vírgula ou espaço
          <input
            type="text"
            value={orderNumbers}
            onChange={(e) => setOrderNumbers(e.target.value)}
            placeholder="2681, 3236"
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="button" className="btn btn-primary" disabled={busy || !storeId || !orderNumbers.trim()} onClick={submit}>
          {busy ? "Buscando…" : "Registrar e preparar rascunho"}
        </button>
        {error && <div className="hint" style={{ color: "var(--danger)" }}>{error}</div>}
      </div>

      {results && (
        <div className="card" style={{ marginTop: "1rem", maxWidth: 480 }}>
          {results.map((r) => (
            <div key={r.orderNumber} style={{ padding: "0.375rem 0" }}>
              {r.conversationId ? (
                <>
                  Pedido #{r.orderNumber}: rascunho pronto —{" "}
                  <Link className="btn btn-sm" href={`/inbox?status=conversas&c=${r.conversationId}`}>Abrir conversa</Link>
                </>
              ) : (
                <>Pedido #{r.orderNumber}: não achei esse pedido nessa loja (ou sem e-mail do cliente).</>
              )}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
