"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CATEGORY_LABEL, LANG_LABEL, PHASE_CLASS, PHASE_LABEL, STATUS_CLASS, STATUS_LABEL, URGENCY_CLASS, fmtDateTime, fmtWhen } from "@/lib/ui/labels";

interface Message {
  id: string;
  direction: string;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string | null;
  body_raw: string | null;
  body_pt: string | null;
  sent_at: string | null;
  created_at: string;
  other?: boolean;
}

interface Analysis {
  phase?: number;
  intent_pt?: string;
  tone_pt?: string;
  promises_made_pt?: string | null;
  order_situation_pt?: string;
  needs_human?: boolean;
  human_reason?: string | null;
  forced_escalation?: boolean;
  error?: string;
  customer_summary_pt?: string;
  customer_wants_pt?: string;
  emails_summary_pt?: Array<{ date: string; who: string; summary_pt: string }>;
  unanswered_count?: number;
  waiting_days?: number;
  first_contact_at?: string | null;
  last_store_reply_at?: string | null;
  customer_name?: string | null;
  model?: string;
  read?: { shopify_stores: string[]; order: string | null; name_source: string | null; product: string | null; persona: string; deadline: string | null; messages_read: number };
  contexts_used?: string[];
  missing_context_pt?: string | null;
  duplicate_of?: string | null;
}

interface Order {
  name: string;
  createdAt: string;
  fulfillmentStatus: string;
  financialStatus: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  statusPageUrl: string | null;
  totalPrice: string | null;
  currency: string | null;
  lineItems: Array<{ title: string; quantity: number }>;
}

interface Conversation {
  id: string;
  subject: string | null;
  category: string | null;
  urgency: string;
  status: string;
  language: string | null;
  anger_level: number | null;
  mentions_threat: boolean;
  wants_refund: boolean;
  analysis: Analysis | null;
  draft_reply: string | null;
  draft_reply_pt: string | null;
  shopify_order: Order | null;
  stores: { id: string; name: string } | null;
  customers: { id: string; email: string } | null;
  store_id?: string;
  product_id?: string | null;
}

function who(direction: string) {
  if (direction === "inbound") return { label: "Cliente", cls: "" };
  if (direction === "outbound_ai") return { label: "Loja · IA", cls: "badge-accent" };
  return { label: "Loja · você", cls: "badge-ok" };
}

function MessageCard({ m }: { m: Message }) {
  const [showPt, setShowPt] = useState(Boolean(m.body_pt));
  const [pt, setPt] = useState(m.body_pt);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const w = who(m.direction);

  async function translate() {
    if (pt) {
      setShowPt((v) => !v);
      return;
    }
    setBusy(true);
    const r = await fetch(`/api/messages/${m.id}/translate`, { method: "POST" });
    const d = await r.json();
    setBusy(false);
    if (d.body_pt) {
      setPt(d.body_pt);
      setShowPt(true);
    }
  }

  const text = full ? (m.body_raw ?? m.body ?? "") : showPt && pt ? pt : (m.body ?? "");

  return (
    <div className={`msg${m.direction === "inbound" ? "" : " out"}`}>
      <div className="msg-head">
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span className={`badge ${w.cls}`}>{w.label}</span>
          {m.other && <span className="badge" title={m.subject ?? ""}>outro e-mail{m.subject ? ` · ${m.subject.slice(0, 40)}` : ""}</span>}
          <span className="hint">{m.direction === "inbound" ? m.from_address : `para ${m.to_address}`}</span>
        </div>
        <span className="hint">{fmtDateTime(m.sent_at ?? m.created_at)}</span>
      </div>
      <div className="msg-body">{text}</div>
      <div className="msg-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={translate} disabled={busy}>
          {busy ? "Traduzindo..." : showPt && pt ? "Ver original" : "Traduzir"}
        </button>
        {m.body_raw && m.body_raw !== m.body && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFull((v) => !v)}>
            {full ? "Ver só o novo" : "Ver e-mail completo"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConversationThread({
  conversationId,
  onChanged,
}: {
  conversationId: string;
  onChanged?: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [otherMessages, setOtherMessages] = useState<Message[]>([]);
  const [fullChat, setFullChat] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [replyAgain, setReplyAgain] = useState(false);
  const [draftPt, setDraftPt] = useState("");
  const [draftOriginal, setDraftOriginal] = useState("");
  const [editOriginal, setEditOriginal] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [contexts, setContexts] = useState<Array<{ id: string; label: string; product_id: string | null }>>([]);
  const [ctxIds, setCtxIds] = useState<string[]>([]);
  const [improve, setImprove] = useState(true);
  const [showCtx, setShowCtx] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; subject: string | null; status: string; last_message_at: string | null; category: string | null }>>([]);
  const [closeOthers, setCloseOthers] = useState(true);
  const [receipt, setReceipt] = useState<{ orders: Array<{ name: string; date: string; initial: boolean }>; selected: string; brand: string; to: string; subject: string; html: string; sent: Array<{ order: string; at: string }> } | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const pendingOthers = history.filter((h) => ["nova", "reaberta", "aguardando_humano"].includes(h.status)).length;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (keepNotice = false) => {
    const r = await fetch(`/api/conversations/${conversationId}`);
    const d = await r.json();
    if (!r.ok) return;
    setConv(d.conversation);
    setMessages(d.messages);
    setOtherMessages(d.otherMessages ?? []);
    setDraftPt(d.conversation.draft_reply_pt ?? "");
    setDraftOriginal(d.conversation.draft_reply ?? "");
    if (!keepNotice) setNotice(null);
    setReplyAgain(false);
    setInstruction("");
    onChanged?.(conversationId, { unread: false });
    const cid = d.conversation.customers?.id;
    if (cid) {
      fetch(`/api/conversations?customer=${cid}&status=conversas&limit=20`)
        .then((r) => r.json())
        .then((h) => setHistory((h.conversations ?? []).filter((c: { id: string }) => c.id !== conversationId)));
    } else {
      setHistory([]);
    }
  }, [conversationId, onChanged]);

  useEffect(() => {
    load();
  }, [load]);

  // Blocos de contexto da loja (e do produto da conversa) pra usar como base
  // de uma resposta melhorada.
  useEffect(() => {
    const storeId = conv?.store_id ?? conv?.stores?.id;
    if (!storeId) return;
    fetch(`/api/contexto?store=${storeId}`)
      .then((r) => r.json())
      .then((d) => {
        const all = (d.contexts ?? []) as Array<{ id: string; label: string; product_id: string | null }>;
        setContexts(all.filter((c) => !c.product_id || c.product_id === (conv?.product_id ?? null)));
      })
      .catch(() => {});
  }, [conv?.store_id, conv?.stores?.id, conv?.product_id]);

  async function generate() {
    setGenerating(true);
    setNotice(null);
    const current = editOriginal ? draftOriginal : draftPt;
    const r = await fetch(`/api/conversations/${conversationId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, contextIds: ctxIds, improve: improve && Boolean(current.trim()), currentDraft: current }),
    });
    const d = await r.json();
    setGenerating(false);
    if (!r.ok) {
      setNotice({ kind: "err", text: d.error ?? "Não consegui gerar." });
      return;
    }
    setDraftPt(d.draft_reply_pt);
    setDraftOriginal(d.draft_reply);
    setConv((c) => (c ? { ...c, draft_reply: d.draft_reply, draft_reply_pt: d.draft_reply_pt, analysis: d.analysis } : c));
    setInstruction("");
  }

  async function send() {
    // Edição feita no modo "idioma do cliente" vale mesmo que você tenha
    // voltado pro modo PT depois — senão iria o draft_reply antigo da IA.
    const originalEdited = draftOriginal.trim() !== (conv?.draft_reply ?? "").trim();
    const payload = { force: replyAgain, replyPt: draftPt, ...(editOriginal || originalEdited ? { replyOriginal: draftOriginal } : {}), closeOthers: closeOthers && pendingOthers > 0 };
    if (!(editOriginal ? draftOriginal.trim() : draftPt.trim())) return;
    setSending(true);
    setNotice(null);
    const r = await fetch(`/api/conversations/${conversationId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    setSending(false);
    if (!r.ok) {
      setNotice({ kind: "err", text: d.error ?? "Falha ao enviar." });
      return;
    }
    setNotice({
      kind: "ok",
      text: [d.learned ? `Enviado. Aprendi: "${d.learned.guidance}"` : "Enviado ao cliente.", d.todos?.length ? `Anotei em "A fazer": ${d.todos.map((t: { text: string }) => t.text).join(" · ")}` : "", d.closedOthers ? `${d.closedOthers} outra(s) pendência(s) deste cliente encerrada(s).` : ""].filter(Boolean).join(" "),
    });
    onChanged?.(conversationId, { status: "respondida_humano", unread: false });
    window.dispatchEvent(new Event("respondo:counts"));
    setDraftPt("");
    setDraftOriginal("");
    load(true);
  }

  // Link PESSOAL do formulário deste cliente (e-mail cifrado no link).
  async function copyFormLink() {
    if (!conv?.customers?.email) return;
    const sp = new URLSearchParams({ link: "1", email: conv.customers.email, conversation: conversationId });
    if (conv.language) sp.set("lang", conv.language);
    const r = await fetch(`/api/formularios?${sp}`);
    const d = await r.json();
    if (d.link) {
      await navigator.clipboard?.writeText(d.link).catch(() => {});
      setNotice({ kind: "ok", text: `Link do formulário copiado: ${d.link}` });
    }
  }

  // Recibo em HTML da compra (padrão: a compra inicial), com a marca do produto.
  async function openReceipt(order?: string) {
    setReceiptBusy(true);
    const r = await fetch(`/api/conversations/${conversationId}/receipt${order ? `?order=${encodeURIComponent(order)}` : ""}`);
    const d = await r.json().catch(() => ({}));
    setReceiptBusy(false);
    if (!r.ok) { setNotice({ kind: "err", text: d.error ?? "Não consegui montar o recibo." }); return; }
    setReceipt(d);
  }
  async function sendReceipt(force = false) {
    if (!receipt) return;
    setReceiptBusy(true);
    const r = await fetch(`/api/conversations/${conversationId}/receipt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: receipt.selected, force }) });
    const d = await r.json().catch(() => ({}));
    setReceiptBusy(false);
    if (r.status === 409 && !force) { if (window.confirm(`${d.error} Enviar de novo mesmo assim?`)) return sendReceipt(true); return; }
    if (!r.ok) { setNotice({ kind: "err", text: d.error ?? "Falha ao enviar o recibo." }); return; }
    setReceipt(null);
    setNotice({ kind: "ok", text: `Recibo do pedido ${d.order} enviado.` });
    load(true);
  }

  async function action(name: string) {
    await fetch(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: name }),
    });
    const patch: Record<string, unknown> =
      name === "encerrar" ? { status: "encerrada" } : name === "spam" ? { status: "spam" } : name === "nao_lido" ? { unread: true } : name === "reabrir" || name === "nao_spam" ? { status: "aguardando_humano" } : {};
    onChanged?.(conversationId, patch);
    load();
  }

  function onKey(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  if (!conv) return <div className="empty">Carregando...</div>;

  const a = conv.analysis;
  const order = conv.shopify_order;
  const isPt = !conv.language || /^pt|portug/i.test(conv.language);
  const canReply = conv.status !== "spam";
  // Última palavra foi da loja (ou conversa encerrada): nada a responder.
  const answered = ["respondida_humano", "respondida_ia", "encerrada"].includes(conv.status);
  const lastOut = [...messages].reverse().find((m) => m.direction !== "inbound") ?? null;

  return (
    <>
      <div className="thread">
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "0.75rem" }}>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">{conv.stores?.name}</div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0.125rem 0 0.25rem" }}>{conv.subject || "(sem assunto)"}</h2>
            <div className="hint">
              {conv.customers ? (
                <Link href={`/clientes/${conv.customers.id}`} style={{ color: "var(--accent)" }}>
                  {conv.customers.email}
                </Link>
              ) : null}
              {conv.language ? ` · ${LANG_LABEL[conv.language] ?? conv.language}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span className={`badge ${STATUS_CLASS[conv.status] ?? ""}`}>{STATUS_LABEL[conv.status] ?? conv.status}</span>
            {a?.phase && <span className={`badge ${PHASE_CLASS[a.phase] ?? ""}`} title={PHASE_LABEL[a.phase]}>{PHASE_LABEL[a.phase]}</span>}
            {conv.category && <span className="badge badge-accent">{CATEGORY_LABEL[conv.category] ?? conv.category}</span>}
            {conv.urgency && conv.urgency !== "baixa" && <span className={`badge ${URGENCY_CLASS[conv.urgency] ?? ""}`}>{conv.urgency}</span>}
            {conv.mentions_threat && <span className="badge badge-danger">ameaça</span>}
            {conv.wants_refund && <span className="badge badge-danger">reembolso</span>}
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          {conv.status !== "encerrada" && conv.status !== "spam" && (
            <button type="button" className="btn btn-sm" onClick={() => action("encerrar")} title="Encerrar sem responder">
              Ignorar / encerrar
            </button>
          )}
          {conv.customers && (
            <Link href={`/inbox?status=conversas&customer=${conv.customers.id}`} className="btn btn-sm">
              Só este cliente
            </Link>
          )}
          {conv.status === "encerrada" && (
            <button type="button" className="btn btn-sm" onClick={() => action("reabrir")}>
              Reabrir
            </button>
          )}
          {conv.status !== "spam" ? (
            <button type="button" className="btn btn-sm" onClick={() => action("spam")}>
              Marcar spam
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => action("nao_spam")}>
              Não é spam
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => action("nao_lido")}>
            Marcar não lido
          </button>
          <button type="button" className="btn btn-sm" onClick={() => action("reanalisar")}>
            Reanalisar no próximo ciclo
          </button>
          <button type="button" className="btn btn-sm" onClick={copyFormLink} title="Copia o link pessoal do formulário de solicitação pra você colar na resposta">
            Link do formulário
          </button>
          <button type="button" className="btn btn-sm" disabled={receiptBusy} onClick={() => openReceipt()} title="Monta o recibo da compra em HTML (marca do produto, idioma e moeda do cliente, sem assinatura) pra você conferir e enviar">
            {receiptBusy && !receipt ? "Montando recibo…" : "Recibo"}
          </button>
        </div>

        {a?.customer_summary_pt && (
          <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--accent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.5rem" }}>
              <div className="section-title" style={{ margin: 0 }}>Resumo do cliente{a.customer_name ? ` · ${a.customer_name}` : ""}</div>
              <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                {(a.unanswered_count ?? 0) > 0 && <span className="badge badge-danger">{a.unanswered_count} e-mail(s) sem resposta</span>}
                {(a.waiting_days ?? 0) > 0 && <span className="badge badge-warn">{a.waiting_days} dia(s) esperando</span>}
                {a.first_contact_at && <span className="badge">1º contato {fmtDateTime(a.first_contact_at).slice(0, 10)}</span>}
                <span className="badge">{a.last_store_reply_at ? `última resposta nossa ${fmtDateTime(a.last_store_reply_at).slice(0, 10)}` : "nunca respondemos"}</span>
              </div>
            </div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: "0.875rem", lineHeight: 1.55 }}>{a.customer_summary_pt}</div>
            {a.customer_wants_pt && (
              <>
                <div className="section-title" style={{ margin: "0.75rem 0 0.25rem" }}>O que ele quer, exatamente</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: "0.875rem", lineHeight: 1.55 }}>{a.customer_wants_pt}</div>
              </>
            )}
            {(a.emails_summary_pt?.length ?? 0) > 0 && (
              <>
                <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: "0.5rem" }} onClick={() => setShowTimeline((v) => !v)}>
                  {showTimeline ? "Esconder linha do tempo" : `Linha do tempo: ${a.emails_summary_pt!.length} mensagens, 1 linha cada`}
                </button>
                {showTimeline && (
                  <div style={{ marginTop: "0.375rem", fontSize: "0.8125rem", lineHeight: 1.5 }}>
                    {a.emails_summary_pt!.map((e, i) => (
                      <div key={i} style={{ display: "flex", gap: "0.5rem", padding: "0.125rem 0" }}>
                        <span className="hint" style={{ flexShrink: 0, width: "5.5rem" }}>{e.date}</span>
                        <span className={`badge ${e.who === "loja" ? "badge-ok" : ""}`} style={{ flexShrink: 0 }}>{e.who}</span>
                        <span>{e.summary_pt}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {a.missing_context_pt && (
              <div style={{ marginTop: "0.625rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", background: "var(--warn-soft)", fontSize: "0.8125rem" }}>
                <strong>A IA pediu contexto:</strong> {a.missing_context_pt}
              </div>
            )}
            {a.read && (
              <div className="hint" style={{ marginTop: "0.625rem", lineHeight: 1.6 }}>
                <strong>O que a IA leu antes de escrever:</strong> {a.read.messages_read} mensagem(ns) do cliente e da loja · Shopify consultadas: {a.read.shopify_stores.join(", ") || "nenhuma conectada"} · pedido: {a.read.order ?? "não localizado (respondeu pela data que o cliente informou)"} · nome: {a.customer_name ? `${a.customer_name} (${a.read.name_source ?? "—"})` : "não identificado"} · produto: {a.read.product ?? "—"} · assina: {a.read.persona}
                {a.read.deadline ? ` · prazo calculado: ${a.read.deadline}` : ""}
                {a.contexts_used?.length ? ` · ${a.contexts_used.length} bloco(s) de contexto: ${a.contexts_used.join("; ")}` : " · nenhum bloco de contexto"}
              </div>
            )}
            {a.model && <div className="hint" style={{ marginTop: "0.25rem" }}>Gerado pela OpenAI · {a.model}</div>}
          </div>
        )}

        {(a || order) && (
          <div className="card analysis" style={{ marginBottom: "1rem" }}>
            <div className="section-title">Pré-análise</div>
            {a?.error ? (
              <p className="hint" style={{ color: "var(--danger)" }}>Falha na análise: {a.error}</p>
            ) : (
              <dl>
                {a?.intent_pt && (
                  <>
                    <dt>O que quer</dt>
                    <dd>{a.intent_pt}</dd>
                  </>
                )}
                {a?.tone_pt && (
                  <>
                    <dt>Tom</dt>
                    <dd>{a.tone_pt}</dd>
                  </>
                )}
                {a?.promises_made_pt && (
                  <>
                    <dt>Já prometido</dt>
                    <dd>{a.promises_made_pt}</dd>
                  </>
                )}
                {a?.order_situation_pt && (
                  <>
                    <dt>Pedido</dt>
                    <dd>{a.order_situation_pt}</dd>
                  </>
                )}
                {a?.human_reason && (
                  <>
                    <dt>Por que caiu aqui</dt>
                    <dd>{a.human_reason}</dd>
                  </>
                )}
                {order && (
                  <>
                    <dt>Shopify</dt>
                    <dd>
                      <strong>{order.name}</strong> · {new Date(order.createdAt).toLocaleDateString("pt-BR")} · {order.financialStatus} / {order.fulfillmentStatus}
                      {order.totalPrice ? ` · ${order.totalPrice} ${order.currency ?? ""}` : ""}
                      <br />
                      {(order.lineItems ?? []).map((li) => `${li.quantity}x ${li.title}`).join(", ")}
                      {order.trackingNumber && (
                        <>
                          <br />
                          Rastreio: {order.trackingUrl ? <a href={order.trackingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{order.trackingNumber}</a> : order.trackingNumber}
                          {order.trackingCompany ? ` (${order.trackingCompany})` : ""}
                        </>
                      )}
                      {order.statusPageUrl && (
                        <>
                          {" "}·{" "}
                          <a href={order.statusPageUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                            página do pedido
                          </a>
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div className="card" style={{ marginBottom: "1rem", padding: "0.875rem 1rem" }}>
            <div className="section-title" style={{ marginBottom: "0.5rem" }}>Histórico deste cliente ({history.length} outra{history.length > 1 ? "s" : ""})</div>
            {history.map((h) => (
              <Link key={h.id} href={`/inbox?status=conversas&c=${h.id}`} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", padding: "0.25rem 0", textDecoration: "none", fontSize: "0.8125rem" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.subject || "(sem assunto)"}</span>
                <span style={{ display: "flex", gap: "0.375rem", flexShrink: 0, alignItems: "center" }}>
                  {h.category && <span className="badge badge-accent">{CATEGORY_LABEL[h.category] ?? h.category}</span>}
                  <span className={`badge ${STATUS_CLASS[h.status] ?? ""}`}>{STATUS_LABEL[h.status] ?? h.status}</span>
                  <span className="hint">{fmtWhen(h.last_message_at)}</span>
                </span>
              </Link>
            ))}
          </div>
        )}

        {!a && conv.status !== "spam" && (
          <p className="hint" style={{ marginBottom: "1rem" }}>Ainda sem pré-análise — entra no próximo ciclo (até 10 min) ou clique em Gerar resposta.</p>
        )}

        {otherMessages.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 0.5rem" }}>
            <span className="section-title" style={{ margin: 0 }}>
              {fullChat ? `Chat completo do cliente (${messages.length + otherMessages.length} mensagens, todas as conversas)` : `Só esta conversa (${messages.length})`}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFullChat((v) => !v)}>
              {fullChat ? "Ver só esta conversa" : `Ver chat completo (+${otherMessages.length})`}
            </button>
          </div>
        )}
        {(fullChat ? [...messages, ...otherMessages].sort((x, y) => (x.sent_at ?? x.created_at).localeCompare(y.sent_at ?? y.created_at)) : messages).map((m) => (
          <MessageCard key={m.id} m={m} />
        ))}
      </div>

      {canReply && answered && !replyAgain && (
        <div className="compose" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <span className="badge badge-ok">Respondida</span>{" "}
            <span className="hint">
              {lastOut ? `Última resposta enviada em ${fmtDateTime(lastOut.sent_at ?? lastOut.created_at)} para ${lastOut.to_address}. ` : ""}A caixa de resposta fica fechada pra não sair resposta em dobro.
            </span>
            {notice && <div className="hint" style={{ marginTop: "0.25rem", color: notice.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>{notice.text}</div>}
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setReplyAgain(true)}>Escrever outra resposta</button>
        </div>
      )}

      {canReply && (!answered || replyAgain) && (
        <div className="compose">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <div className="section-title" style={{ margin: 0 }}>
              Sua resposta {isPt ? "" : editOriginal ? `(no idioma do cliente: ${LANG_LABEL[conv.language ?? ""] ?? conv.language})` : "(em português — traduzimos ao enviar)"}
            </div>
            {!isPt && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditOriginal((v) => !v)}>
                {editOriginal ? "Editar em português" : "Editar no idioma do cliente"}
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            rows={5}
            value={editOriginal ? draftOriginal : draftPt}
            onChange={(e) => (editOriginal ? setDraftOriginal(e.target.value) : setDraftPt(e.target.value))}
            onKeyDown={onKey}
            placeholder="Escreva a resposta, ou clique em Gerar resposta."
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.625rem", alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea
              rows={2}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Instruções pra melhorar (opcional): pede desculpa pela demora, explica que já saiu, oferece crédito, mais longo e caloroso..."
              style={{ flex: 1, minWidth: "14rem" }}
            />
            <button type="button" className="btn" onClick={generate} disabled={generating}>
              {generating ? "Gerando..." : ctxIds.length > 0 || (improve && (editOriginal ? draftOriginal : draftPt).trim()) ? "Melhorar resposta" : "Gerar resposta"}
            </button>
            <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !(editOriginal ? draftOriginal.trim() : draftPt.trim())}>
              {sending ? "Enviando..." : "Enviar"}
            </button>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
              <input type="checkbox" checked={improve} onChange={(e) => setImprove(e.target.checked)} style={{ width: "auto" }} />
              partir do texto atual
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setShowCtx((v) => !v)}>
              {ctxIds.length > 0 ? `Contexto base: ${ctxIds.length}` : "Contexto base"}
            </button>
            {ctxIds.length > 0 && (
              <span className="hint">
                {contexts.filter((c) => ctxIds.includes(c.id)).map((c) => c.label).join(" · ")}
              </span>
            )}
            <span className="hint" style={{ marginLeft: "auto" }}>gera no idioma do cliente ({conv?.language ?? "detectado"}) + PT-BR</span>
          </div>
          {showCtx && (
            <div className="card" style={{ marginTop: "0.5rem", padding: "0.625rem 0.75rem", maxHeight: "14rem", overflow: "auto" }}>
              {contexts.length === 0 && <span className="hint">Nenhum bloco de contexto nessa loja ainda.</span>}
              {contexts.map((c) => (
                <label key={c.id} style={{ display: "flex", gap: "0.375rem", alignItems: "center", padding: "0.125rem 0", fontWeight: 400, fontSize: "0.8125rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={ctxIds.includes(c.id)}
                    onChange={(e) => setCtxIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))}
                    style={{ width: "auto" }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.5rem", gap: "1rem", flexWrap: "wrap" }}>
            <span className="hint" style={{ display: "inline-flex", gap: "0.75rem", alignItems: "center" }}>
              Ctrl+Enter envia
              {pendingOthers > 0 && (
                <label style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400 }}>
                  <input type="checkbox" checked={closeOthers} onChange={(e) => setCloseOthers(e.target.checked)} style={{ width: "auto" }} />
                  ao enviar, encerrar as outras {pendingOthers} pendência(s) deste cliente (uma resposta cobre tudo)
                </label>
              )}
            </span>
            {notice && (
              <span className="hint" style={{ color: notice.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>
                {notice.text}
              </span>
            )}
          </div>
        </div>
      )}
      {receipt && (
        <div role="dialog" aria-modal="true" onClick={() => setReceipt(null)} onKeyDown={(e) => e.key === "Escape" && setReceipt(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,18,30,0.55)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(680px, 100%)", maxHeight: "92vh", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              <div>
                <div className="section-title" style={{ margin: 0 }}>Recibo · {receipt.brand}</div>
                <div className="hint">Para {receipt.to} · assunto: {receipt.subject}</div>
              </div>
              {receipt.orders.length > 1 && (
                <select value={receipt.selected} onChange={(e) => openReceipt(e.target.value)} disabled={receiptBusy}>
                  {receipt.orders.map((o) => <option key={o.name} value={o.name}>{o.name} · {new Date(o.date).toLocaleDateString("pt-BR")}{o.initial ? " · compra inicial" : ""}</option>)}
                </select>
              )}
            </div>
            <iframe title="Prévia do recibo" srcDoc={receipt.html} sandbox="" style={{ width: "100%", height: "58vh", border: "1px solid var(--border)", borderRadius: 8, background: "#f4f5f8" }} />
            {receipt.sent.some((x) => x.order === receipt.selected) && <div className="hint" style={{ color: "var(--danger)" }}>Esse recibo já foi enviado em {receipt.sent.filter((x) => x.order === receipt.selected).map((x) => new Date(x.at).toLocaleString("pt-BR")).join(", ")}.</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="btn" onClick={() => setReceipt(null)}>Fechar</button>
              <button type="button" className="btn btn-primary" disabled={receiptBusy} onClick={() => sendReceipt()}>{receiptBusy ? "Enviando…" : "Enviar recibo"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}