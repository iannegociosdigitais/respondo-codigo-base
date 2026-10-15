"use client";

import { useEffect, useState } from "react";
import { LANG_LABEL } from "@/lib/ai/lang";

interface Persona {
  name: string;
  role: string;
  closing: string;
}

interface Product {
  id: string;
  name: string;
  email_aliases: string[];
  keywords: string[];
  languages: string[];
  shopify_product_ids: string[];
  personas: Record<string, Persona>;
}

const LANGS = ["fr", "en", "he", "de", "hu", "es", "it", "nl", "pt"];

function Form({ initial, storeId, onSaved, onCancel }: { initial: Product | null; storeId: string; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [aliases, setAliases] = useState((initial?.email_aliases ?? []).join(", "));
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [langs, setLangs] = useState<string[]>(initial?.languages ?? []);
  const [shopifyIds, setShopifyIds] = useState((initial?.shopify_product_ids ?? []).join(", "));
  const [personas, setPersonas] = useState<Record<string, Persona>>(initial?.personas ?? {});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setPersona(lang: string, key: keyof Persona, value: string) {
    setPersonas((p) => {
      const prev = p[lang];
      const current: Persona = { name: prev?.name ?? "", role: prev?.role ?? "", closing: prev?.closing ?? "" };
      current[key] = value;
      return { ...p, [lang]: current };
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const body = { id: initial?.id, storeId, name, email_aliases: split(aliases), keywords: split(keywords), languages: langs, shopify_product_ids: split(shopifyIds), personas };
    const r = await fetch("/api/products", { method: initial ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) {
      setErr(d.error ?? "Erro ao salvar.");
      return;
    }
    onSaved();
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "0.625rem", padding: "0.875rem", marginTop: "0.75rem" }}>
      <div className="field">
        <label>Nome do produto / marca</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: OsteoPure Moringa, Olavita" />
      </div>
      <div className="field">
        <label>Endereços de e-mail deste produto (aliases, vírgula)</label>
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="support@olavita.co.il" />
      </div>
      <div className="field">
        <label>Palavras-chave no assunto/corpo (vírgula)</label>
        <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="olavita, crème, קרם" />
      </div>
      <div className="field">
        <label>IDs de produto na Shopify (vírgula, opcional)</label>
        <input value={shopifyIds} onChange={(e) => setShopifyIds(e.target.value)} placeholder="8234567890123" />
      </div>
      <div className="field">
        <label>Idiomas deste produto</label>
        <div className="chip-group">
          {LANGS.map((l) => (
            <button key={l} type="button" className={`chip${langs.includes(l) ? " on" : ""}`} onClick={() => setLangs((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))}>
              {LANG_LABEL[l] ?? l}
            </button>
          ))}
        </div>
        <span className="hint">Se um idioma for só deste produto (ex.: hebraico = Olavita), e-mails nesse idioma vêm pra cá.</span>
      </div>
      <div className="field">
        <label>Persona por idioma (quem assina, cargo, fecho) — vazio usa um padrão natural do idioma</label>
        {(langs.length > 0 ? langs : ["fr"]).map((l) => (
          <div key={l} style={{ display: "grid", gridTemplateColumns: "5rem 1fr 1.6fr 1fr", gap: "0.375rem", alignItems: "center", marginBottom: "0.375rem" }}>
            <span className="hint">{LANG_LABEL[l] ?? l}</span>
            <input placeholder="Nome (ex: Monique)" value={personas[l]?.name ?? ""} onChange={(e) => setPersona(l, "name", e.target.value)} />
            <input placeholder="Cargo (ex: La Responsable du Support OsteoPure)" value={personas[l]?.role ?? ""} onChange={(e) => setPersona(l, "role", e.target.value)} />
            <input placeholder="Fecho (ex: Chaleureusement)" value={personas[l]?.closing ?? ""} onChange={(e) => setPersona(l, "closing", e.target.value)} />
          </div>
        ))}
      </div>
      {err && <p className="hint" style={{ color: "var(--danger)" }}>{err}</p>}
      <div style={{ display: "flex", gap: "0.375rem" }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving || !name.trim()}>{saving ? "Salvando..." : "Salvar produto"}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

// Produtos/marcas da loja: a mesma caixa e a mesma Shopify vendem vários;
// contexto, persona e assinatura são por produto.
export default function ProductsPanel({ storeId }: { storeId: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | null | "new">(null);

  async function load() {
    const r = await fetch(`/api/products?store=${storeId}`);
    const d = await r.json();
    setProducts(d.products ?? []);
    setEnabled(d.enabled !== false);
    setError(d.error ?? null);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function remove(id: string) {
    if (!confirm("Remover este produto? Os blocos de contexto dele também somem.")) return;
    await fetch(`/api/products?id=${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="section-title" style={{ margin: 0 }}>Produtos / marcas desta loja ({products.length})</div>
        <button type="button" className="btn btn-sm" onClick={() => setEditing("new")} disabled={!enabled}>+ Produto</button>
      </div>
      <p className="hint" style={{ marginTop: "0.5rem" }}>
        A IA identifica o produto pelo endereço de destino, item do pedido, palavra-chave ou idioma, e usa o contexto, a persona e a assinatura dele. Sem produto cadastrado, vale o contexto da loja.
      </p>
      {!enabled && <p className="hint" style={{ color: "var(--danger)" }}>{error ?? "Rode a migration 0011 (produtos)."}</p>}
      {products.map((p) => (
        <div key={p.id} style={{ borderTop: "1px solid var(--border)", padding: "0.625rem 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
            <div>
              <strong>{p.name}</strong>
              <div className="hint">
                {p.languages.map((l) => LANG_LABEL[l] ?? l).join(", ") || "qualquer idioma"}
                {p.email_aliases.length > 0 ? ` · ${p.email_aliases.join(", ")}` : ""}
                {p.keywords.length > 0 ? ` · palavras: ${p.keywords.join(", ")}` : ""}
              </div>
              <div className="hint">
                {Object.entries(p.personas).filter(([, v]) => v?.name).map(([l, v]) => `${LANG_LABEL[l] ?? l}: ${v.name}`).join(" · ") || "persona padrão por idioma"}
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>editar</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(p.id)}>remover</button>
            </div>
          </div>
          {editing && editing !== "new" && editing.id === p.id && <Form initial={p} storeId={storeId} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}
        </div>
      ))}
      {editing === "new" && <Form initial={null} storeId={storeId} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}
    </div>
  );
}
