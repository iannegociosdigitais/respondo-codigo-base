"use client";

import { useEffect, useState } from "react";
import { fmtDateTime, fmtMoney, num, statusInfo, CHANNEL_LABEL, EVENT_LABEL, phoneDigits, isTestRow, errorMessage, Notice, type NoticeState } from "./shared";
import type { Detail } from "./RecoveryThread";

// Ficha do carrinho (mini CRM) na coluna da direita da aba Conversas.

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", padding: "0.2rem 0", fontSize: "0.8125rem" }}>
      <span className="hint" style={{ flexShrink: 0 }}>{k}</span>
      <span style={{ textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

export default function RecoveryCard({ detail, onPatch }: { detail: Detail; onPatch: (patch: { notes?: string; tags?: string[]; status?: "pausado" | "ativo" | "concluido_sem_compra" }) => Promise<string[] | void> }) {
  const rec = detail.recovery;
  const [notes, setNotes] = useState(rec.notes ?? "");
  const [notesDirty, setNotesDirty] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // Eventos de teste ficam fora da linha do tempo por padrão.
  const [showTests, setShowTests] = useState(false);

  // Notas vindas do servidor só substituem o texto se você não estiver editando.
  useEffect(() => {
    if (!notesDirty) setNotes(rec.notes ?? "");
  }, [rec.notes, notesDirty]);

  // fn pode devolver os avisos do servidor (warnings); com avisos, eles
  // aparecem no lugar do texto fixo de sucesso.
  async function run(label: string, fn: () => Promise<string[] | void>, okText?: string) {
    setBusy(label);
    setNotice(null);
    try {
      const warnings = await fn();
      if (Array.isArray(warnings) && warnings.length > 0) setNotice({ kind: "warn", text: warnings.join(" ") });
      else if (okText) setNotice({ kind: "ok", text: okText });
    } catch (e) {
      setNotice({ kind: "err", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase().replace(/\s+/g, "_");
    if (!t) return;
    const tags = Array.from(new Set([...(rec.tags ?? []), t]));
    setTagInput("");
    run("tags", () => onPatch({ tags }));
  }
  function removeTag(t: string) {
    run("tags", () => onPatch({ tags: (rec.tags ?? []).filter((x) => x !== t) }));
  }

  const items = Array.isArray(rec.items) ? rec.items : [];
  const bought = rec.status === "recuperado" || rec.status === "parado_comprou";
  const st = statusInfo(rec.status);
  const offered = num(rec.offered_discount_percent, 0);
  const allEvents = [...(detail.events ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const testEvents = allEvents.filter((e) => isTestRow(e)).length;
  const events = showTests ? allEvents : allEvents.filter((e) => !isTestRow(e));
  const digits = phoneDigits(rec.phone);

  return (
    <aside style={{ width: "clamp(18rem, 24vw, 24rem)", flexShrink: 0, borderLeft: "1px solid var(--border)", background: "var(--surface)", overflowY: "auto", padding: "1rem", fontSize: "0.8125rem" }}>
      <div className="section-title">Carrinho</div>
      {items.length === 0 && <div className="hint">Sem itens registrados.</div>}
      {items.map((it, i) => (
        <div key={`${it.variantId ?? it.sku ?? it.title}-${i}`} style={{ display: "flex", gap: "0.625rem", alignItems: "center", padding: "0.375rem 0", borderBottom: "1px solid var(--border)" }}>
          {it.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={it.imageUrl} alt="" width={44} height={44} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, background: "var(--background)", flexShrink: 0 }} />
          ) : (
            <div style={{ width: 44, height: 44, borderRadius: 8, background: "var(--background)", flexShrink: 0 }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div dir="auto" style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }} title={it.title}>{it.quantity}× {it.title}</div>
            <div className="hint" dir="auto">{[it.variantTitle, it.lineTotal != null ? fmtMoney(it.lineTotal, rec.currency) : it.unitPrice != null ? `${fmtMoney(it.unitPrice, rec.currency)} cada` : ""].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: "0.5rem" }}>
        <Row k="Total" v={<strong>{fmtMoney(rec.total, rec.currency)}</strong>} />
        {num(rec.total_discount, 0) > 0 && <Row k="Desconto no carrinho" v={fmtMoney(rec.total_discount, rec.currency)} />}
        <Row k="Cupom do funil" v={(rec.discount_codes ?? []).join(", ") || "nenhum"} />
        <Row k="Abandonado em" v={fmtDateTime(rec.abandoned_at)} />
        <Row k="Primeiro contato" v={rec.first_contact_at ? fmtDateTime(rec.first_contact_at) : "ainda não"} />
        <Row k="Última resposta do cliente" v={rec.last_inbound_at ? fmtDateTime(rec.last_inbound_at) : "nenhuma"} />
        {rec.email_next_at && rec.status === "ativo" && <Row k="Próximo e-mail" v={`passo ${rec.email_step + 1} · ${fmtDateTime(rec.email_next_at)}`} />}
        {rec.wa_next_at && rec.status === "ativo" && <Row k="Próximo WhatsApp" v={`passo ${rec.wa_step + 1} · ${fmtDateTime(rec.wa_next_at)}`} />}
        <Row k="E-mail" v={rec.email ?? "sem e-mail"} />
        <Row k="Consentimento" v={`${rec.email_consent === "SUBSCRIBED" ? "e-mail" : ""}${rec.sms_consent === "SUBSCRIBED" ? " sms" : ""}`.trim() || "nenhum marcado"} />
      </div>

      <div className="section-title" style={{ marginTop: "1rem" }}>Compra</div>
      <div style={{ padding: "0.5rem 0.75rem", borderRadius: "0.5rem", background: bought ? "var(--ok-soft)" : "var(--background)" }}>
        <div style={{ display: "flex", gap: "0.375rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className={st.cls}>{st.label}</span>
          {rec.stop_reason && <span className="hint" dir="auto">{rec.stop_reason}</span>}
        </div>
        {bought && (
          <div style={{ marginTop: "0.25rem" }}>
            <strong>{detail.order?.name ?? rec.recovered_order_name ?? "pedido"}</strong>
            {" · "}{fmtMoney(detail.order?.total ?? rec.recovered_amount, detail.order?.currency ?? rec.recovered_currency ?? rec.currency)}
            {" · "}{fmtDateTime(detail.order?.createdAt ?? rec.recovered_at)}
            {rec.recovered_discount_code ? <div className="hint">cupom usado: {rec.recovered_discount_code}</div> : null}
            {rec.attribution ? <div className="hint">atribuição: {rec.attribution}</div> : null}
          </div>
        )}
        {!bought && <div className="hint" style={{ marginTop: "0.25rem" }}>Ainda não comprou.</div>}
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <Row k="Desconto oferecido" v={offered > 0 ? `${offered}%${rec.offered_discount_code ? ` (${rec.offered_discount_code})` : ""}` : "nenhum"} />
        {rec.summary_pt && <div className="hint" dir="auto" style={{ marginTop: "0.25rem" }}><strong>Resumo:</strong> {rec.summary_pt}</div>}
      </div>

      <div className="section-title" style={{ marginTop: "1rem" }}>Status da régua</div>
      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
        {rec.status !== "ativo" && (rec.status === "pausado" || rec.status === "concluido_sem_compra") && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => run("status", () => onPatch({ status: "ativo" }), "Régua reativada.")}>Reativar régua</button>}
        {rec.status === "ativo" && <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => run("status", () => onPatch({ status: "pausado" }), "Régua pausada.")}>Pausar régua</button>}
        {(rec.status === "ativo" || rec.status === "pausado") && <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Encerrar este carrinho sem compra? Nada mais será enviado.")) run("status", () => onPatch({ status: "concluido_sem_compra" }), "Encerrado."); }}>Encerrar sem compra</button>}
      </div>

      <div className="section-title" style={{ marginTop: "1rem" }}>Tags</div>
      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", alignItems: "center" }}>
        {(rec.tags ?? []).map((t) => (
          <span key={t} className="badge" style={{ gap: "0.25rem" }}>
            <span dir="auto">{t}</span>
            <button type="button" onClick={() => removeTag(t)} disabled={Boolean(busy)} title="remover" style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }}>×</button>
          </span>
        ))}
        <input dir="auto" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} placeholder="nova tag + Enter" style={{ width: "9rem", padding: "0.25rem 0.5rem", fontSize: "0.75rem" }} />
      </div>

      <div className="section-title" style={{ marginTop: "1rem" }}>Notas</div>
      <textarea rows={3} dir="auto" value={notes} onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }} placeholder="Anotações internas sobre este cliente." />
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.375rem", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm" disabled={!notesDirty || Boolean(busy)} onClick={() => run("notes", async () => { await onPatch({ notes }); setNotesDirty(false); }, "Notas salvas.")}>{busy === "notes" ? "Salvando…" : "Salvar notas"}</button>
        <Notice notice={notice} />
      </div>

      <div className="section-title" style={{ marginTop: "1rem" }}>Links</div>
      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
        {rec.recovery_url && <a className="btn btn-sm" href={rec.recovery_url} target="_blank" rel="noreferrer">Abrir checkout</a>}
        {digits && <a className="btn btn-sm" href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer">WhatsApp</a>}
        {rec.checkout_name && <span className="hint" style={{ alignSelf: "center" }}>{rec.checkout_name}</span>}
      </div>

      <div className="section-title" style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span>Linha do tempo</span>
        {(testEvents > 0 || showTests) && (
          <label className="hint" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", fontWeight: 400, cursor: "pointer" }} title="Eventos de teste foram para o destino de teste, não para o cliente">
            <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} style={{ width: "auto" }} />
            mostrar testes{testEvents > 0 ? ` (${testEvents})` : ""}
          </label>
        )}
      </div>
      {events.length === 0 && <div className="hint">{testEvents > 0 && !showTests ? `Só eventos de teste (${testEvents}), escondidos.` : "Nenhum evento ainda."}</div>}
      <div style={{ display: "grid", gap: "0.25rem" }}>
        {events.slice(0, 40).map((e) => {
          const d = (e.detail ?? {}) as Record<string, unknown>;
          const reason = typeof d.reason === "string" ? d.reason : typeof d.error === "string" ? d.error : "";
          return (
            <div key={e.id} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
              <span className="hint" style={{ flexShrink: 0, width: "6.5rem" }}>{fmtDateTime(e.createdAt)}</span>
              <span style={{ minWidth: 0 }}>
                {isTestRow(e) && <span className="badge badge-warn" style={{ marginRight: 4 }}>teste</span>}
                <span className="badge" style={{ marginRight: 4 }}>{CHANNEL_LABEL[e.channel] ?? e.channel}{e.step ? ` ${e.step}` : ""}</span>
                {EVENT_LABEL[e.type] ?? e.type}
                {e.discountCode ? ` · ${e.discountCode}` : ""}
                {reason ? <span className="hint" dir="auto"> · {reason}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
