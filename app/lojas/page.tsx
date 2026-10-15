"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";

interface Store {
  id: string;
  name: string;
  agent_name: string | null;
  status: string;
}

export default function LojasPage() {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [rerouteMsg, setRerouteMsg] = useState<string | null>(null);

  async function reroute() {
    setRerouting(true);
    setRerouteMsg(null);
    const r = await fetch("/api/cron/reroute", { method: "POST" });
    const d = await r.json();
    setRerouting(false);
    setRerouteMsg(r.ok ? `${d.moved} conversa(s) movida(s) de loja (roteamento por alias ${d.enabled ? "ativo" : "inativo — rode a migration 0010"}).` : d.error);
  }

  useEffect(() => {
    fetch("/api/stores")
      .then((r) => r.json())
      .then((d) => setStores(d.stores ?? []));
  }, []);

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="page-title">Minhas lojas</h1>
          <p className="page-sub">Cada loja com sua caixa de e-mail, Shopify, tom de voz e regras.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" className="btn" onClick={reroute} disabled={rerouting}>
            {rerouting ? "Reaplicando..." : "Reaplicar roteamento de marcas"}
          </button>
          <Link href="/onboarding" className="btn btn-primary">
            + Nova loja
          </Link>
        </div>
      </div>
      {rerouteMsg && <p className="hint" style={{ marginBottom: "1rem" }}>{rerouteMsg}</p>}

      {stores === null && <p className="hint">Carregando...</p>}
      {stores?.length === 0 && (
        <div className="card">
          <p className="hint" style={{ marginBottom: "1rem" }}>Nenhuma loja cadastrada ainda.</p>
          <Link href="/onboarding" className="btn btn-primary" style={{ display: "inline-flex" }}>
            Cadastrar primeira loja
          </Link>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))", gap: "1rem" }}>
        {stores?.map((s) => (
          <Link key={s.id} href={`/lojas/${s.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div className="card" style={{ cursor: "pointer", margin: 0 }}>
              <strong style={{ fontSize: "1rem" }}>{s.name}</strong>
              <p className="hint" style={{ marginTop: "0.25rem" }}>{s.agent_name ? `Assina: ${s.agent_name}` : "Abrir configurações"}</p>
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
