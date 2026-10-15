"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecoveryKnowledge } from "@/lib/recovery/types";
import { api, errorMessage, Notice, SectionTitle, KNOWLEDGE_KINDS } from "./shared";

// Conhecimento do vendedor: o que o agente pode usar na conversa
// (scripts, produto, objeções, preço, garantia, regras).

type Kind = RecoveryKnowledge["kind"];
interface Draft { id?: string; kind: Kind; title: string; content: string }

function pickList<T>(d: Record<string, unknown>, keys: string[]): T[] {
  for (const k of keys) if (Array.isArray(d[k])) return d[k] as T[];
  return [];
}

const kindLabel = (k: string) => KNOWLEDGE_KINDS.find((x) => x.key === k)?.label ?? k;

export default function KnowledgePanel({ storeId }: { storeId: string }) {
  const [items, setItems] = useState<RecoveryKnowledge[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Record<string, unknown>>(`/api/recovery/knowledge?store=${encodeURIComponent(storeId)}`);
      setItems(pickList<RecoveryKnowledge>(d, ["knowledge", "items", "data"]));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      setItems((prev) => prev ?? []);
    }
  }, [storeId]);

  useEffect(() => {
    setItems(null);
    setDraft(null);
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

  function saveDraft() {
    if (!draft) return;
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) return setNotice({ kind: "err", text: "Título e conteúdo são obrigatórios." });
    run("save", async () => {
      if (draft.id) await api(`/api/recovery/knowledge?store=${encodeURIComponent(storeId)}`, { method: "PATCH", json: { id: draft.id, kind: draft.kind, title, content } });
      else await api(`/api/recovery/knowledge?store=${encodeURIComponent(storeId)}`, { method: "POST", json: { kind: draft.kind, title, content } });
      setDraft(null);
    }, draft.id ? "Atualizado." : "Adicionado.");
  }

  const grouped = KNOWLEDGE_KINDS.map((k) => ({ ...k, items: (items ?? []).filter((i) => i.kind === k.key) })).filter((g) => g.items.length > 0);
  const totalChars = (items ?? []).filter((i) => i.active).reduce((n, i) => n + (i.content?.length ?? 0), 0);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <SectionTitle right={<button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy) || Boolean(draft)} onClick={() => setDraft({ kind: "produto", title: "", content: "" })}>+ Adicionar</button>}>Conhecimento do vendedor</SectionTitle>
      <p className="hint" style={{ marginBottom: "0.75rem" }}>
        Tudo que está ativo aqui vai para o agente em cada resposta (até 12 mil caracteres; hoje {totalChars.toLocaleString("pt-BR")}). Ele só afirma o que está escrito aqui ou no contexto da loja; o resto ele passa para humano. Escreva em português: o agente responde no idioma do cliente.
      </p>
      {error && <div className="hint" style={{ color: "var(--danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {items === null && !error && <div className="hint">Carregando…</div>}
      {items?.length === 0 && !draft && <div className="hint" style={{ marginBottom: "0.5rem" }}>Nada cadastrado. Comece com o produto (o que é, para que serve, tamanho, como usar) e as objeções mais comuns (preço, prazo, funciona mesmo?).</div>}

      {draft && (
        <div style={{ border: "1px solid var(--accent)", borderRadius: "0.625rem", padding: "0.75rem 0.875rem", marginBottom: "0.75rem", display: "grid", gap: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}>
              {KNOWLEDGE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Título (ex.: Prazo de entrega em Israel)" style={{ flex: 1, minWidth: "14rem" }} />
          </div>
          <textarea rows={6} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Conteúdo em português. Fatos, não promessas: o agente nunca promete data de entrega." />
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === "save"} onClick={saveDraft}>{busy === "save" ? "Salvando…" : draft.id ? "Salvar alterações" : "Adicionar"}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy === "save"} onClick={() => setDraft(null)}>Cancelar</button>
            <Notice notice={notice} />
          </div>
        </div>
      )}
      {!draft && notice && <div style={{ marginBottom: "0.5rem" }}><Notice notice={notice} /></div>}

      {grouped.map((g) => (
        <div key={g.key} style={{ marginBottom: "0.75rem" }}>
          <div className="section-title" style={{ marginBottom: "0.375rem" }}>{g.label} ({g.items.length})</div>
          <div style={{ display: "grid", gap: "0.375rem" }}>
            {g.items.map((k) => (
              <div key={k.id} style={{ border: "1px solid var(--border)", borderRadius: "0.5rem", padding: "0.5rem 0.75rem", opacity: k.active ? 1 : 0.6 }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ flex: 1, minWidth: "10rem" }}>{k.title}</strong>
                  <span className="hint">{k.content.length.toLocaleString("pt-BR")} caracteres</span>
                  <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }}>
                    <input type="checkbox" checked={k.active} disabled={Boolean(busy)} onChange={(e) => run(`toggle:${k.id}`, async () => { await api(`/api/recovery/knowledge?store=${encodeURIComponent(storeId)}`, { method: "PATCH", json: { id: k.id, active: e.target.checked } }); })} style={{ width: "auto" }} />
                    ativo
                  </label>
                  <button type="button" className="btn btn-sm" disabled={Boolean(busy) || Boolean(draft)} onClick={() => setDraft({ id: k.id, kind: k.kind, title: k.title, content: k.content })}>editar</button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Apagar "${k.title}"?`)) run(`del:${k.id}`, async () => { await api(`/api/recovery/knowledge?store=${encodeURIComponent(storeId)}&id=${encodeURIComponent(k.id)}`, { method: "DELETE" }); }, "Apagado."); }}>apagar</button>
                </div>
                <div className="hint" style={{ marginTop: "0.25rem", whiteSpace: "pre-wrap", maxHeight: "4.5rem", overflow: "hidden", textOverflow: "ellipsis" }}>{k.content.slice(0, 280)}{k.content.length > 280 ? "…" : ""}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {items && items.length > 0 && <div className="hint">Tipos: {KNOWLEDGE_KINDS.map((k) => k.label).join(" · ")}. {kindLabel("objecao")}: escreva a objeção e como responder.</div>}
    </div>
  );
}
