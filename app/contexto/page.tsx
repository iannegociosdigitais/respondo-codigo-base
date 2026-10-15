"use client";

import { useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";
import StoreSelect, { useStores } from "@/components/StoreSelect";
import { CATEGORY_LABEL, fmtDateTime } from "@/lib/ui/labels";

interface Ctx {
  id: string;
  label: string;
  content: string;
}

interface Learned {
  id: string;
  category: string | null;
  situation_summary: string;
  guidance: string;
  source: string;
  created_at: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

export default function ContextoPage() {
  const stores = useStores();
  const [store, setStore] = useState("");
  const [contexts, setContexts] = useState<Ctx[]>([]);
  const [learned, setLearned] = useState<Learned[]>([]);
  const [turns, setTurns] = useState<Turn[]>([
    { role: "assistant", content: "Me conta como você quer que a loja responda: objeções, políticas, prazos, o que nunca dizer, tom. Eu transformo em blocos de contexto e a IA passa a usar em toda resposta." },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ kind: "context" | "learned"; id: string; a: string; b: string } | null>(null);
  const [mining, setMining] = useState(false);
  const [mineMsg, setMineMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [gaps, setGaps] = useState<Array<{ id: string; customers: { email: string } | null; analysis: { missing_context_pt?: string } | null }>>([]);
  const [products, setProducts] = useState<Array<{ id: string; name: string }>>([]);
  // "" = contexto da loja (vale pra todos os produtos); id = só daquele produto
  const [product, setProduct] = useState("");

  useEffect(() => {
    if (!store) return;
    fetch(`/api/products?store=${store}`)
      .then((r) => r.json())
      .then((d) => setProducts(d.products ?? []));
    setProduct("");
  }, [store]);

  // Importa arquivos .md/.txt (manual de atendimento) como blocos, texto
  // integral — um bloco por arquivo.
  async function importFiles(files: FileList | null) {
    if (!files || files.length === 0 || !store) return;
    setImporting(true);
    const documents = await Promise.all(
      Array.from(files).map(async (f) => ({ label: `[Manual] ${f.name.replace(/\.(md|txt)$/i, "").replace(/[_-]+/g, " ")}`, content: await f.text() }))
    );
    const r = await fetch("/api/contexto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId: store, productId: product || undefined, documents }) });
    const d = await r.json();
    setImporting(false);
    setMineMsg(
      r.ok
        ? d.created !== undefined
          ? `${d.created} bloco(s) novo(s), ${d.updated} atualizado(s).${d.unknownProducts?.length ? ` Produto não cadastrado (ficou como contexto da loja): ${d.unknownProducts.join(", ")}.` : ""}`
          : `${d.imported} documento(s) importado(s) como contexto.`
        : d.error
    );
    load();
  }

  async function mine() {
    if (!store) return;
    setMining(true);
    setMineMsg(null);
    const r = await fetch(`/api/stores/${store}/mine`, { method: "POST" });
    const d = await r.json();
    setMining(false);
    setMineMsg(r.ok ? `${d.created} bloco(s) novo(s) a partir de ${d.pairs} troca(s) reais.` : d.error);
    load();
  }
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!store && stores.length > 0) setStore(stores[0].id);
  }, [stores, store]);

  async function load() {
    if (!store) return;
    const r = await fetch(`/api/contexto?store=${store}&product=${product || "store"}`);
    const d = await r.json();
    setContexts(d.contexts ?? []);
    setLearned(d.learned ?? []);
    fetch(`/api/conversations?store=${store}&status=pendentes&gap=1&limit=50`)
      .then((g) => g.json())
      .then((g) => setGaps(g.conversations ?? []))
      .catch(() => {});
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, product]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending || !store) return;
    const next = [...turns, { role: "user" as const, content: input }];
    setTurns(next);
    setInput("");
    setSending(true);
    const r = await fetch("/api/contexto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId: store, productId: product || undefined, history: next }),
    });
    const d = await r.json();
    setSending(false);
    if (!r.ok) {
      setTurns([...next, { role: "assistant", content: `Erro: ${d.error}` }]);
      return;
    }
    const saved = (d.saved ?? []).length;
    setTurns([...next, { role: "assistant", content: d.reply + (saved > 0 ? `\n\n✓ ${saved} bloco(s) salvo(s).` : "") }]);
    if (saved > 0) load();
  }

  async function remove(kind: "context" | "learned", id: string) {
    await fetch(`/api/contexto?kind=${kind}&id=${id}`, { method: "DELETE" });
    load();
  }

  async function saveEdit() {
    if (!editing) return;
    const body =
      editing.kind === "context"
        ? { kind: "context", id: editing.id, label: editing.a, content: editing.b }
        : { kind: "learned", id: editing.id, situation_summary: editing.a, guidance: editing.b };
    await fetch("/api/contexto", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setEditing(null);
    load();
  }

  const storeName = stores.find((s) => s.id === store)?.name;

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 className="page-title">Contexto com Objeções</h1>
          <p className="page-sub">A base que a IA usa pra responder {storeName ? `na ${storeName}` : ""}. Cresce todo dia: pelo chat aqui, e sozinha a cada resposta que você corrige no Inbox.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <StoreSelect value={store} onChange={setStore} allLabel={null} />
          {products.length > 0 && (
            <select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Contexto da loja (vale pra todos os produtos)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  Produto: {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card" style={{ margin: 0, display: "flex", flexDirection: "column", height: "34rem" }}>
          <div className="section-title">Conversar pra ensinar</div>
          <div className="chat" style={{ flex: 1, overflowY: "auto", paddingRight: "0.25rem" }}>
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                {t.content}
              </div>
            ))}
            {sending && <div className="bubble assistant hint">Organizando...</div>}
            <div ref={chatEnd} />
          </div>
          <form onSubmit={send} style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ex: quando o pedido atrasa mais de 15 dias, oferecemos reenvio sem custo..." disabled={sending} />
            <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
              Enviar
            </button>
          </form>
        </div>

        <div>
          <div className="card" style={{ margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <div className="section-title" style={{ margin: 0 }}>Blocos de contexto ({contexts.length})</div>
              <div style={{ display: "flex", gap: "0.375rem" }}>
                <a className="btn btn-sm" href={`/api/contexto?store=${store}&export=1`} download title="Baixa todos os blocos desta loja num .md editável">
                  Exportar .md
                </a>
                <label className="btn btn-sm" style={{ cursor: "pointer" }} title="Aceita o .md exportado (um bloco por '## Título') ou um manual solto">
                  {importing ? "Importando..." : "Importar .md"}
                  <input type="file" accept=".md,.txt,text/markdown,text/plain" multiple style={{ display: "none" }} onChange={(e) => importFiles(e.target.files)} />
                </label>
                <button type="button" className="btn btn-sm" onClick={mine} disabled={mining}>
                  {mining ? "Lendo o histórico..." : "Extrair do histórico"}
                </button>
              </div>
            </div>
            {mineMsg && <p className="hint" style={{ marginBottom: "0.5rem" }}>{mineMsg}</p>}
            <details className="hint" style={{ marginBottom: "0.75rem" }}>
              <summary style={{ cursor: "pointer" }}>Como organizar o .md (formato que a IA entende)</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem", marginTop: "0.375rem" }}>{`## Objeção: pedido ainda não chegou
produto: Olavita
tipo: objecao
temas: atraso, prazo_entrega
fases: 1, 2
idiomas: he, tr
palavras: krem, קרם, where is my order
---
Texto direto do que responder, no imperativo.

tipo: base | idioma | loja | produto | prazo  → entra em TODA resposta do produto
tipo: objecao | politica | fase             → entra quando tema, fase ou palavras batem
temas: prazo_entrega, rastreio, atraso, consta_entregue, endereco, cancelamento, assinatura,
       cobranca, regularizacao_financeira, devolucao, chargeback_contestacao, produto_uso,
       produto_resultado, preco_oferta, pagamento, legitimidade_loja, agradecimento, outro
Mesmo título + mesmo produto = atualiza o bloco; título novo = cria.`}</pre>
            </details>
            {gaps.length > 0 && (
              <div className="card" style={{ marginBottom: "0.75rem", borderLeft: "3px solid var(--warn)", padding: "0.75rem 1rem" }}>
                <div className="section-title" style={{ marginBottom: "0.375rem" }}>A IA pediu contexto ({gaps.length})</div>
                <p className="hint" style={{ marginBottom: "0.5rem" }}>E-mails que ela não conseguiu resolver só com o que está aqui. Ensine no chat ao lado ou adicione um bloco, e depois reanalise a conversa.</p>
                {gaps.slice(0, 12).map((g) => (
                  <a key={g.id} href={`/inbox?status=conversas&c=${g.id}`} style={{ display: "block", padding: "0.25rem 0", fontSize: "0.8125rem", textDecoration: "none", color: "inherit", borderTop: "1px solid var(--border)" }}>
                    <strong>{g.customers?.email}</strong> — {g.analysis?.missing_context_pt}
                  </a>
                ))}
              </div>
            )}
            {contexts.length === 0 && <p className="hint">Nenhum bloco ainda. Comece pelo chat ao lado.</p>}
            {contexts.map((c) => (
              <div key={c.id} style={{ borderBottom: "1px solid var(--border)", padding: "0.625rem 0" }}>
                {editing?.kind === "context" && editing.id === c.id ? (
                  <>
                    <input value={editing.a} onChange={(e) => setEditing({ ...editing, a: e.target.value })} style={{ marginBottom: "0.375rem" }} />
                    <textarea rows={3} value={editing.b} onChange={(e) => setEditing({ ...editing, b: e.target.value })} />
                    <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.375rem" }}>
                      <button type="button" className="btn btn-sm btn-primary" onClick={saveEdit}>Salvar</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                      <strong style={{ fontSize: "0.8125rem" }}>{c.label}</strong>
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing({ kind: "context", id: c.id, a: c.label, b: c.content })}>editar</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => remove("context", c.id)}>remover</button>
                      </div>
                    </div>
                    <p className="hint" style={{ whiteSpace: "pre-wrap", marginTop: "0.25rem" }}>{c.content}</p>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="section-title">Aprendido com suas correções ({learned.length})</div>
            {learned.length === 0 && <p className="hint">Quando você editar um rascunho antes de enviar, a regra por trás da correção aparece aqui.</p>}
            {learned.map((l) => (
              <div key={l.id} style={{ borderBottom: "1px solid var(--border)", padding: "0.625rem 0" }}>
                {editing?.kind === "learned" && editing.id === l.id ? (
                  <>
                    <input value={editing.a} onChange={(e) => setEditing({ ...editing, a: e.target.value })} style={{ marginBottom: "0.375rem" }} />
                    <textarea rows={3} value={editing.b} onChange={(e) => setEditing({ ...editing, b: e.target.value })} />
                    <div style={{ display: "flex", gap: "0.375rem", marginTop: "0.375rem" }}>
                      <button type="button" className="btn btn-sm btn-primary" onClick={saveEdit}>Salvar</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                      <div>
                        <strong style={{ fontSize: "0.8125rem" }}>{l.situation_summary}</strong>
                        <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem" }}>
                          {l.category && <span className="badge badge-accent">{CATEGORY_LABEL[l.category] ?? l.category}</span>}
                          <span className="badge">{l.source === "edicao" ? "da sua edição" : l.source === "chat" ? "do chat" : "manual"}</span>
                          <span className="hint">{fmtDateTime(l.created_at)}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing({ kind: "learned", id: l.id, a: l.situation_summary, b: l.guidance })}>editar</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => remove("learned", l.id)}>remover</button>
                      </div>
                    </div>
                    <p className="hint" style={{ whiteSpace: "pre-wrap", marginTop: "0.375rem" }}>{l.guidance}</p>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
