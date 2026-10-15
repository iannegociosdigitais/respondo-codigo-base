"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";

interface Store { id: string; name: string; agent_name: string | null }
interface Result { orderNumber: string; conversationId: string | null; error?: string }

// Pede confirmação do telefone de entrega pra uma lista de pedidos — mensagem
// curta e proativa, no idioma do cliente pelo país do pedido. Nada é enviado
// sozinho, fica como rascunho no Inbox pra você revisar e mandar.
export default function PedirTelefonePage() {
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
    const r = await fetch("/api/outreach/phone", {
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
      <h1 className="page-title">Pedir telefone de entrega</h1>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        Mensagem curta e proativa perguntando o telefone de entrega, no idioma do cliente. Cole os números dos pedidos que estão sem telefone. <strong>Nada é enviado sozinho</strong> — fica como rascunho pronto no Inbox.
      </p>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}>
        <label>
          Loja
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ display: "block", width: "100%" }}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.agent_name ? ` (${s.agent_name})` : ""}</option>)}
          </select>
        </label>
        <label>
          Nº dos pedidos — separados por vírgula ou espaço
          <textarea
            value={orderNumbers}
            onChange={(e) => setOrderNumbers(e.target.value)}
            placeholder="1061, 3464, 3457..."
            rows={4}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="button" className="btn btn-primary" disabled={busy || !storeId || !orderNumbers.trim()} onClick={submit}>
          {busy ? "Preparando…" : "Preparar rascunhos"}
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
                <>Pedido #{r.orderNumber}: {r.error ?? "não encontrado"}.</>
              )}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
