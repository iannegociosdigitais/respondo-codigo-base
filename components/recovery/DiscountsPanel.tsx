"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecoveryDiscount } from "@/lib/recovery/types";
import { api, errorMessage, num, Notice, SectionTitle } from "./shared";

// Cupons da loja usados pela régua e pelo agente (criados na Shopify, colados aqui).

function pickList<T>(d: Record<string, unknown>, keys: string[]): T[] {
  for (const k of keys) if (Array.isArray(d[k])) return d[k] as T[];
  return [];
}

export default function DiscountsPanel({ storeId }: { storeId: string }) {
  const [items, setItems] = useState<RecoveryDiscount[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [percent, setPercent] = useState(15);
  const [combinable, setCombinable] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<Record<string, unknown>>(`/api/recovery/discounts?store=${encodeURIComponent(storeId)}`);
      setItems(pickList<RecoveryDiscount>(d, ["discounts", "items", "data"]));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      setItems((prev) => prev ?? []);
    }
  }, [storeId]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>, okText?: string) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  function add() {
    const c = code.trim().toUpperCase();
    if (!c) return setNotice({ kind: "err", text: "Informe o código do cupom (igual ao da Shopify)." });
    if (percent < 1 || percent > 90) return setNotice({ kind: "err", text: "Percentual entre 1 e 90." });
    run("add", async () => {
      await api(`/api/recovery/discounts?store=${encodeURIComponent(storeId)}`, { method: "POST", json: { code: c, percent, combinable, note: note.trim() || undefined } });
      setCode("");
      setNote("");
    }, "Cupom cadastrado.");
  }

  const sorted = [...(items ?? [])].sort((a, b) => num(a.percent) - num(b.percent));

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <SectionTitle>Cupons</SectionTitle>
      <p className="hint" style={{ marginBottom: "0.75rem" }}>
        O cupom é criado na Shopify (Descontos → código de desconto, percentual) e colado aqui com o mesmo percentual. A régua usa o cupom ativo com o percentual do passo; o agente vendedor só oferece percentuais que existem aqui, até o teto dele. Sem cupom para o percentual, o passo sai sem desconto (nunca inventamos código).
      </p>
      {error && <div className="hint" style={{ color: "var(--danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {items === null && !error && <div className="hint">Carregando…</div>}
      {items?.length === 0 && <div className="hint" style={{ marginBottom: "0.5rem" }}>Nenhum cupom cadastrado: todos os passos saem sem desconto e o agente não oferece nada.</div>}
      {sorted.length > 0 && (
        <table className="table" style={{ marginBottom: "0.75rem" }}>
          <thead><tr><th>Código</th><th>%</th><th>Combinável</th><th>Nota</th><th>Ativo</th><th></th></tr></thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.id} style={{ opacity: d.active ? 1 : 0.6 }}>
                <td><code>{d.code}</code></td>
                <td>{num(d.percent)}%</td>
                <td>{d.combinable ? "sim" : "não"}</td>
                <td className="hint">{d.note ?? ""}</td>
                <td>
                  <input type="checkbox" checked={d.active} disabled={Boolean(busy)} onChange={(e) => run(`toggle:${d.id}`, async () => { await api(`/api/recovery/discounts?store=${encodeURIComponent(storeId)}`, { method: "PATCH", json: { id: d.id, active: e.target.checked } }); })} style={{ width: "auto" }} />
                </td>
                <td style={{ textAlign: "right" }}>
                  <button type="button" className="btn btn-sm btn-danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Apagar o cupom ${d.code} daqui? (Na Shopify ele continua existindo.)`)) run(`del:${d.id}`, async () => { await api(`/api/recovery/discounts?store=${encodeURIComponent(storeId)}&id=${encodeURIComponent(d.id)}`, { method: "DELETE" }); }, "Cupom removido."); }}>apagar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CÓDIGO (igual à Shopify)" style={{ width: "13rem" }} />
        <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
          <input type="number" min={1} max={90} value={percent} onChange={(e) => setPercent(Number(e.target.value) || 0)} style={{ width: "4.5rem", padding: "0.3rem 0.4rem" }} />%
        </label>
        <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
          <input type="checkbox" checked={combinable} onChange={(e) => setCombinable(e.target.checked)} style={{ width: "auto" }} />
          combinável
        </label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="nota (opcional)" style={{ width: "12rem" }} />
        <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy) || !code.trim()} onClick={add}>{busy === "add" ? "Salvando…" : "Adicionar cupom"}</button>
        <Notice notice={notice} />
      </div>
    </div>
  );
}
