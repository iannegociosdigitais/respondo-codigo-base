"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

interface Candidate {
  storeId: string; storeName: string; orderId: string; orderName: string; brand: string | null; email: string; customerName: string | null;
  language: string; subject: string; html: string; createdAt: string; alreadySent: { status: string; created_at: string } | null;
}

// 100% manual: nada aqui é enviado sozinho. Você escolhe, confere a prévia
// e clica em enviar — um de cada vez ou vários juntos.
export default function ConfirmacoesPage() {
  const [days, setDays] = useState(3);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/receipts/pending?days=${days}`)
      .then((r) => r.json())
      .then((d) => { setCandidates(d.candidates ?? []); setMigrationMissing(Boolean(d.migrationMissing)); })
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(load, [load]);

  const key = (c: Candidate) => `${c.storeId}:${c.orderId}`;
  const pending = (candidates ?? []).filter((c) => !c.alreadySent);
  function toggle(k: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  async function sendTest(c: Candidate) {
    setBusy(true); setNote("");
    const r = await fetch("/api/receipts/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId: c.storeId, orderId: c.orderId }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setNote(r.ok ? "Teste enviado pro seu e-mail pessoal." : (d.error ?? "Falhou."));
  }

  async function sendSelected(items: Candidate[]) {
    if (items.length === 0) return;
    if (!window.confirm(`Enviar o comprovante de ${items.length} pedido(s) agora? Essa ação manda e-mail de verdade pro cliente.`)) return;
    setBusy(true); setNote("");
    const r = await fetch("/api/receipts/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.map((c) => ({ storeId: c.storeId, orderId: c.orderId })) }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setChecked(new Set());
    setPreview(null);
    load();
    if (!r.ok) { setNote(d.error ?? "Falhou."); return; }
    const failMsg = (d.failed ?? []).length > 0 ? ` · ${d.failed.length} não foram: ${d.failed.map((f: { error: string }) => f.error).slice(0, 3).join("; ")}` : "";
    setNote(`${(d.sent ?? []).length} enviado(s)${failMsg}`);
  }

  return (
    <Shell>
      <h1 className="page-title">E-mail de confirmação</h1>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        Comprovante da COMPRA INICIAL de cada cliente (marca certa, idioma e moeda dele, sem menção a assinatura) — não conta cobrança seguinte de assinatura. Limite de <strong>um comprovante por e-mail de cliente</strong>, garantido pelo banco. Aqui você envia por clique; o envio automático se liga por loja em Minhas lojas.
      </p>

      {migrationMissing && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
          Falta rodar a migration <code>0017_email_log.sql</code> no Supabase. Sem ela não dá pra garantir que um cliente não receba o comprovante duas vezes — os envios ficam bloqueados até isso ser feito.
        </div>
      )}

      <div className="card" style={{ marginBottom: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center" }}>
          Pedidos dos últimos
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} dia(s)</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>{loading ? "Carregando…" : "Atualizar"}</button>
        {pending.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => setChecked(new Set(pending.map(key)))} disabled={migrationMissing}>
            Selecionar {pending.length} pendente(s)
          </button>
        )}
        {checked.size > 0 && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || migrationMissing} onClick={() => sendSelected((candidates ?? []).filter((c) => checked.has(key(c))))}>
            {busy ? "Enviando…" : `Enviar ${checked.size} selecionado(s)`}
          </button>
        )}
        {note && <span className="hint">{note}</span>}
      </div>

      {candidates?.length === 0 && !loading && <div className="empty">Nenhuma compra inicial nesse período.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {(candidates ?? []).map((c) => (
          <div key={key(c)} className="card" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <input type="checkbox" style={{ width: "auto" }} disabled={Boolean(c.alreadySent) || migrationMissing} checked={checked.has(key(c))} onChange={() => toggle(key(c))} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                <strong>{c.orderName}</strong>
                <span className="badge badge-accent">{c.brand ?? c.storeName}</span>
                <span className="hint">{c.storeName} · {c.language}</span>
                {c.alreadySent && <span className={`badge ${c.alreadySent.status === "erro" ? "badge-danger" : "badge-ok"}`}>{c.alreadySent.status} em {new Date(c.alreadySent.created_at).toLocaleString("pt-BR")}</span>}
              </div>
              <div className="hint">{c.customerName ?? c.email} · {c.email} · {new Date(c.createdAt).toLocaleString("pt-BR")}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setPreview(c)}>Ver prévia</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => sendTest(c)} title="Manda esse recibo pro seu e-mail pessoal, nunca pro cliente">Mandar teste pra mim</button>
            {!c.alreadySent && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || migrationMissing} onClick={() => sendSelected([c])}>Enviar</button>
            )}
          </div>
        ))}
      </div>

      {preview && (
        <div role="dialog" aria-modal="true" onClick={() => setPreview(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,18,30,0.55)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(680px, 100%)", maxHeight: "92vh", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
              <div className="section-title" style={{ margin: 0 }}>{preview.orderName} · {preview.brand ?? preview.storeName}</div>
              <div className="hint">Para {preview.email} · assunto: {preview.subject}</div>
            </div>
            <iframe title="Prévia" srcDoc={preview.html} sandbox="" style={{ width: "100%", height: "58vh", border: "1px solid var(--border)", borderRadius: 8, background: "#f4f5f8" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="btn" onClick={() => setPreview(null)}>Fechar</button>
              <button type="button" className="btn" disabled={busy} onClick={() => sendTest(preview)}>Mandar teste pra mim</button>
              {!preview.alreadySent && <button type="button" className="btn btn-primary" disabled={busy || migrationMissing} onClick={() => sendSelected([preview])}>{busy ? "Enviando…" : "Enviar este"}</button>}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
