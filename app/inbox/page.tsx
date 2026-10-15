"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import StoreSelect from "@/components/StoreSelect";
import ConversationThread from "@/components/ConversationThread";
import { CATEGORY_LABEL, LANG_LABEL, PHASE_CLASS, PHASE_SHORT, STATUS_CLASS, STATUS_LABEL, URGENCY_CLASS, fmtWhen } from "@/lib/ui/labels";

interface Row {
  id: string;
  subject: string | null;
  category: string | null;
  urgency: string;
  status: string;
  unread: boolean;
  mentions_threat: boolean;
  wants_refund: boolean;
  language: string | null;
  last_message_at: string | null;
  analysis: { intent_pt?: string; phase?: number; ticket?: boolean; ticket_reason?: string | null; shopify_notice?: boolean } | null;
  has_draft?: boolean;
  same_customer?: number;
  stores: { id: string; name: string } | null;
  customers: { id: string; email: string } | null;
}

const STATUS_TABS = [
  { key: "pendentes", label: "Pendentes" },
  { key: "conversas", label: "Todas" },
  { key: "respondidos", label: "Respondidas" },
  { key: "reaberta", label: "Reabertas" },
  { key: "encerrada", label: "Encerradas" },
  { key: "spam", label: "Spam" },
];

const AVATAR_COLORS = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#2563eb"];
function avatarColor(email: string) {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function InboxInner() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get("c");

  const [store, setStore] = useState(params.get("store") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "pendentes");
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [urgency, setUrgency] = useState(params.get("urgency") ?? "");
  const [sort, setSort] = useState(params.get("sort") ?? "urgencia");
  const [q, setQ] = useState("");
  const [lang, setLang] = useState(params.get("lang") ?? "");
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [withOrder, setWithOrder] = useState(false);
  const [phase, setPhase] = useState(params.get("phase") ?? "");
  const [shop, setShop] = useState(params.get("shop") ?? "");
  const [shops, setShops] = useState<Array<{ id: string; domain: string; name: string; respondo: string }>>([]);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [unique, setUnique] = useState(true);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const customer = params.get("customer");

  const load = useCallback(() => {
    const sp = new URLSearchParams();
    if (store) sp.set("store", store);
    if (customer) sp.set("customer", customer);
    if (status) sp.set("status", status);
    if (category) sp.set("category", category);
    if (urgency) sp.set("urgency", urgency);
    if (sort) sp.set("sort", sort);
    if (q) sp.set("q", q);
    if (lang) sp.set("lang", lang);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    if (withOrder) sp.set("order", "1");
    if (phase) sp.set("phase", phase);
    if (shop) sp.set("shop", shop);
    if (onlyUnread) sp.set("unread", "1");
    if (unique && !customer) sp.set("unique", "1");
    sp.set("limit", "300");
    fetch(`/api/conversations?${sp}`)
      .then((r) => r.json())
      .then((d) => setRows(d.conversations ?? []));
  }, [store, status, category, urgency, sort, q, customer, lang, from, to, withOrder, phase, shop, onlyUnread, unique]);

  useEffect(() => {
    fetch("/api/shopify-stores")
      .then((r) => r.json())
      .then((d) => setShops(d.shops ?? []))
      .catch(() => setShops([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(load, q ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  function select(id: string) {
    const sp = new URLSearchParams(params.toString());
    sp.set("c", id);
    router.replace(`/inbox?${sp}`);
  }

  // Limpeza da caixa: marcar lido/não lido, encerrar (não precisa responder)
  // ou spam — em lote ou direto na linha.
  async function bulk(action: "lido" | "nao_lido" | "encerrar" | "spam", ids?: string[]) {
    const target = ids ?? [...checked];
    if (target.length === 0) return;
    setBulkBusy(true);
    await fetch("/api/conversations/bulk", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: target, action }) });
    setBulkBusy(false);
    if (!ids) setChecked(new Set());
    load();
    window.dispatchEvent(new Event("respondo:counts"));
  }

  // Envio em massa: manda o rascunho pronto de cada selecionada, como está
  // (pra editar antes, abra a conversa e mande por lá).
  async function bulkSend() {
    const target = [...checked].filter((id) => rows?.find((r) => r.id === id)?.has_draft);
    if (target.length === 0) return;
    if (!window.confirm(`Enviar ${target.length} resposta(s) já prontas, cada uma exatamente como está no rascunho?`)) return;
    setBulkBusy(true);
    const r = await fetch("/api/conversations/bulk-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: target }) });
    const d = await r.json().catch(() => ({}));
    setBulkBusy(false);
    setChecked(new Set());
    load();
    window.dispatchEvent(new Event("respondo:counts"));
    const failedMsg = (d.failed ?? []).length > 0 ? ` · ${d.failed.length} não foram: ${d.failed.map((f: { error: string }) => f.error).slice(0, 3).join("; ")}` : "";
    window.alert(`${d.sentCount ?? 0} enviada(s)${failedMsg}`);
  }
  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const onChanged = useCallback((id: string, patch: Record<string, unknown>) => {
    const PENDING = ["nova", "reaberta", "aguardando_humano"];
    setRows((prev) =>
      (prev ?? [])
        .map((r) => (r.id === id ? { ...r, ...patch } : r))
        // Respondida/encerrada sai da lista de pendentes na hora.
        .filter((r) => !(status === "pendentes" && r.id === id && typeof patch.status === "string" && !PENDING.includes(patch.status)))
    );
    window.dispatchEvent(new Event("respondo:counts"));
    if (typeof patch.status === "string" && !PENDING.includes(patch.status)) setTimeout(() => load(), 400);
  }, [status, load]);

  // j / k navegam na lista; Esc volta pra lista (sem seleção).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!rows || rows.length === 0) return;
      const idx = rows.findIndex((r) => r.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        select(rows[Math.min(rows.length - 1, idx + 1)].id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        select(rows[Math.max(0, idx - 1)].id);
      } else if (e.key === "Escape") {
        const sp = new URLSearchParams(params.toString());
        sp.delete("c");
        router.replace(`/inbox?${sp}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected]);

  return (
    <div className="shell">
      <Sidebar />
      <div className="inbox" style={{ flex: 1 }}>
        <div className="inbox-list">
          <div className="inbox-list-head">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.625rem" }}>
              <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0 }}>Inbox</h1>
              <StoreSelect value={store} onChange={setStore} />
            </div>
            <input type="search" placeholder="Buscar cliente, assunto, texto..." value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: "0.5rem" }} />
            <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
              {STATUS_TABS.map((t) => (
                <button key={t.key} type="button" className={`chip${status === t.key ? " on" : ""}`} onClick={() => setStatus(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="filters" style={{ marginTop: "0.5rem" }}>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Categoria</option>
                {Object.entries(CATEGORY_LABEL)
                  .filter(([k]) => k !== "sem_categoria")
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
              </select>
              <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
                <option value="">Urgência</option>
                <option value="urgente">Urgente</option>
                <option value="alta">Alta</option>
                <option value="normal">Normal</option>
                <option value="baixa">Baixa</option>
              </select>
              <select value={sort} onChange={(e) => setSort(e.target.value)} title="Ordenação">
                <option value="urgencia">Mais urgentes primeiro</option>
                <option value="recente">Mais recentes primeiro</option>
              </select>
              <select value={phase} onChange={(e) => setPhase(e.target.value)}>
                <option value="">Fase</option>
                <option value="1">Fase 1 · inicial</option>
                <option value="2">Fase 2 · atraso</option>
                <option value="3">Fase 3 · risco</option>
                <option value="4">Fase 4 · assinatura</option>
              </select>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="">Idioma</option>
                {Object.entries(LANG_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="filters" style={{ marginTop: "0.5rem" }}>
              <select value={shop} onChange={(e) => setShop(e.target.value)} title="Loja Shopify onde o cliente comprou">
                <option value="">Loja Shopify</option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.domain})
                  </option>
                ))}
                <option value="none">Sem pedido na Shopify</option>
              </select>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} title="De" />
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} title="Até" />
              <label style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={withOrder} onChange={(e) => setWithOrder(e.target.checked)} style={{ width: "auto" }} />
                com pedido
              </label>
              {(lang || from || to || withOrder || category || urgency || phase || shop || customer) && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setLang(""); setFrom(""); setTo(""); setWithOrder(false); setCategory(""); setUrgency(""); setPhase(""); setShop(""); if (customer) router.replace("/inbox"); }}>
                  limpar
                </button>
              )}
            </div>
          </div>

          <div className="inbox-list-scroll">
            {rows === null && <div className="empty">Carregando...</div>}
            {q.trim() && <div className="hint" style={{ padding: "0.375rem 1rem", borderBottom: "1px solid var(--border)", background: "var(--accent-soft)" }}>Busca em todas as conversas (pendentes, respondidas e encerradas), ignorando os filtros de status.</div>}
            {customer && <div className="hint" style={{ padding: "0.375rem 1rem", borderBottom: "1px solid var(--border)", background: "var(--accent-soft)" }}>Mostrando só este cliente</div>}
            {rows && rows.length > 0 && (
              <div className="hint inbox-bulk">
                <label style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center", fontWeight: 400 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={checked.size > 0 && checked.size === rows.length} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  {checked.size > 0 ? `${checked.size} selecionada(s)` : `${rows.length} ${unique && !customer ? "cliente(s)" : "conversa(s)"} · ${rows.filter((r) => r.unread).length} não lida(s)`}
                </label>
                {checked.size > 0 ? (
                  <span style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
                    {[...checked].some((id) => rows?.find((r) => r.id === id)?.has_draft) && (
                      <button type="button" className="btn btn-sm btn-primary" disabled={bulkBusy} onClick={bulkSend} title="Manda o rascunho pronto de cada selecionada com rascunho, exatamente como está">
                        Enviar {[...checked].filter((id) => rows?.find((r) => r.id === id)?.has_draft).length} com rascunho
                      </button>
                    )}
                    <button type="button" className="btn btn-sm" disabled={bulkBusy} onClick={() => bulk("lido")}>Lido</button>
                    <button type="button" className="btn btn-sm" disabled={bulkBusy} onClick={() => bulk("nao_lido")}>Não lido</button>
                    <button type="button" className="btn btn-sm" disabled={bulkBusy} onClick={() => bulk("encerrar")} title="Não precisa responder: sai dos pendentes">Limpar (encerrar)</button>
                    <button type="button" className="btn btn-sm" disabled={bulkBusy} onClick={() => bulk("spam")}>Spam</button>
                  </span>
                ) : (
                  <label style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
                    <input type="checkbox" style={{ width: "auto" }} checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
                    só não lidos
                  </label>
                )}
                {checked.size === 0 && (
                  <label style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }} title="Mostra só o e-mail mais recente de cada cliente. Ao responder, os outros e-mails dele são encerrados juntos.">
                    <input type="checkbox" style={{ width: "auto" }} checked={unique} onChange={(e) => setUnique(e.target.checked)} />
                    um por cliente
                  </label>
                )}
                {checked.size === 0 && rows.some((r) => r.has_draft) && (
                  <button type="button" className="btn btn-sm" onClick={() => setChecked(new Set(rows.filter((r) => r.has_draft).map((r) => r.id)))} title="Marca todas as que já têm rascunho pronto, pra enviar de uma vez">
                    Selecionar {rows.filter((r) => r.has_draft).length} com rascunho
                  </button>
                )}
              </div>
            )}
            {rows?.length === 0 && <div className="empty">Nada por aqui.</div>}
            {rows?.map((r) => (
              <div key={r.id} role="button" tabIndex={0} className={`inbox-item${r.id === selected ? " active" : ""}${r.unread ? " unread" : " read"}`} onClick={() => select(r.id)} onKeyDown={(e) => e.key === "Enter" && select(r.id)}>
                <div className="inbox-item-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn btn-sm" title={r.unread ? "Marcar como lido" : "Marcar como não lido"} onClick={() => bulk(r.unread ? "lido" : "nao_lido", [r.id])}>{r.unread ? "Lido" : "Não lido"}</button>
                  <button type="button" className="btn btn-sm" title="Não precisa responder: encerra e sai dos pendentes" onClick={() => bulk("encerrar", [r.id])}>Limpar</button>
                </div>
                <div style={{ display: "flex", gap: "0.625rem" }}>
                  <input type="checkbox" style={{ width: "auto", marginTop: "0.5rem" }} checked={checked.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
                  <span className="avatar" style={{ background: avatarColor(r.customers?.email ?? "?") }}>
                    {(r.customers?.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row">
                  <span className="who">{r.unread && <span className="dot" />}{r.customers?.email ?? "?"}</span>
                  <span className="when">{r.same_customer ? <span className="badge" title="Outros e-mails pendentes do mesmo cliente: uma resposta cobre todos">+{r.same_customer}</span> : null} {fmtWhen(r.last_message_at)}</span>
                </div>
                <div className="subject">{r.subject || "(sem assunto)"}</div>
                {r.analysis?.intent_pt && <div className="preview">{r.analysis.intent_pt}</div>}
                <div className="meta">
                  <span className={`badge ${STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.has_draft && <span className="badge badge-accent" title="Já tem rascunho pronto pra enviar">📝 rascunho</span>}
                  {r.analysis?.phase && <span className={`badge ${PHASE_CLASS[r.analysis.phase] ?? ""}`}>{PHASE_SHORT[r.analysis.phase]}</span>}
                  {r.category && <span className="badge badge-accent">{CATEGORY_LABEL[r.category] ?? r.category}</span>}
                  {r.urgency && r.urgency !== "baixa" && r.urgency !== "normal" && <span className={`badge ${URGENCY_CLASS[r.urgency]}`}>{r.urgency}</span>}
                  {r.analysis?.shopify_notice && <span className="badge badge-danger" title="E-mail da própria Shopify (risco, pagamento, conformidade): prioridade 1, não é cliente">🛍️ Shopify</span>}
                  {r.analysis?.ticket && <span className="badge badge-danger" title={r.analysis.ticket_reason ?? ""}>ticket</span>}
                  {r.mentions_threat && <span className="badge badge-danger">ameaça</span>}
                  {r.wants_refund && <span className="badge badge-danger">reembolso</span>}
                  {!store && r.stores && <span className="hint">{r.stores.name}</span>}
                </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="inbox-read">
          {selected ? <ConversationThread conversationId={selected} onChanged={onChanged} /> : <div className="empty" style={{ paddingTop: "6rem" }}>Selecione uma conversa à esquerda pra ler e responder.</div>}
        </div>
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxInner />
    </Suspense>
  );
}
