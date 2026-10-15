"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecoveryAlert } from "@/lib/recovery/types";
import { useStores } from "@/components/StoreSelect";
import { api, errorMessage, MigrationWarning, STATUS_INFO, LANG_NAME, ALERT_KIND_LABEL, runStatusInfo, fmtDateTime } from "./shared";

// Aba Painel: métricas de linha de base (conteúdo original de /recuperacao),
// alertas abertos no topo (spec v2), card e tabela do pós-compra.

interface WelcomeTotals { runs: number; active: number; done: number; stopped: number; sent: number; opened: number; clicked: number }
interface WelcomeRun { id: string; storeId: string; store: string; orderName: string | null; name: string | null; email: string | null; language: string | null; country: string | null; total: number; currency: string | null; purchasedAt: string; fulfilledAt: string | null; tracking: string | null; status: string; stopReason: string | null; step: number; nextAt: string | null; receiptSent: boolean }

interface StoreStats { storeId: string; storeName: string; abandoned: number; withEmail: number; withPhone: number; emailConsent: number; smsConsent: number; bought: number; boughtSameCheckout: number; boughtOtherOrder: number; rate: number | null; valueByCurrency: Record<string, number>; boughtValueByCurrency: Record<string, number>; byLanguage: Array<{ name: string; count: number }>; byStatus: Array<{ name: string; count: number }>; active: number; settings: { enabled: boolean; email_enabled: boolean; whatsapp_enabled: boolean; sms_enabled: boolean; require_consent: boolean; last_sync_at: string | null } | null }
interface Funnel { channel: string; step: number; sent: number; delivered: number; opened: number; clicked: number; replied: number; bounced: number; complained: number; unsubscribed: number; failed: number }
interface Recent { id: string; store: string; name: string | null; email: string | null; phone: string | null; language: string | null; country: string | null; total: number; currency: string | null; items: string; discountCodes: string[]; abandonedAt: string; status: string; step: number; recoveredOrder: string | null; recoveredAt: string | null; attribution: string | null; emailConsent: string | null; smsConsent: string | null }
interface Data {
  days: number; migrationMissing: boolean; phase: string;
  totals: { abandoned: number; bought: number; withPhone: number; emailConsent: number; smsConsent: number; active: number; rate: number | null };
  stores: StoreStats[];
  byDay: Array<{ day: string; abandoned: number; bought: number }>;
  funnel: Funnel[];
  suppressions: { total: number; byReason: Array<{ name: string; count: number }> };
  providers: { resend: boolean; ses?: boolean; waha: boolean; wahaWebhookSecret: boolean; resendWebhookSecret: boolean };
  whatsappSessions: Array<{ name: string; status: string | null; me_name: string | null; me_id: string | null; last_event_at: string | null }>;
  lastSync: Array<{ store: string; at: string | null }>;
  recent: Recent[];
  welcome?: WelcomeTotals;
  alerts?: RecoveryAlert[];
}

const pct = (v: number | null) => (v == null ? "·" : `${(v * 100).toFixed(1).replace(".", ",")}%`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "·");
const fmtMoney = (v: number, cur: string) => `${cur === "ILS" ? "₪" : cur === "EUR" ? "€" : cur === "USD" ? "$" : `${cur} `}${Math.round(v).toLocaleString("pt-BR")}`;
const moneyList = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([c, v]) => fmtMoney(v, c)).join(" + ") || "·";

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="card" style={{ margin: 0, padding: "1rem" }}>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontWeight: 600, marginTop: "0.35rem" }}>{label}</div>
      {sub && <div className="hint">{sub}</div>}
    </div>
  );
}

// Bloco vermelho no topo: alertas abertos (número caiu, WAHA fora do ar,
// falhas de envio, cliente precisa de humano). "Resolvido" fecha o alerta.
function AlertsBlock({ alerts, onResolved }: { alerts: RecoveryAlert[]; onResolved: () => void }) {
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  if (alerts.length === 0) return null;
  async function resolve(id: string) {
    setBusy(id);
    setError("");
    try {
      await api(`/api/recovery/alerts`, { method: "POST", json: { id, resolve: true } });
      onResolved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
      <div className="section-title" style={{ color: "var(--danger)" }}>Alertas ({alerts.length})</div>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {alerts.map((a) => (
          <div key={a.id} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
            <span className="badge badge-danger" style={{ flexShrink: 0 }}>{ALERT_KIND_LABEL[a.kind] ?? a.kind}</span>
            <span style={{ flex: 1, minWidth: "12rem" }}>{a.message}<div className="hint">{fmtDateTime(a.created_at)}</div></span>
            <button type="button" className="btn btn-sm" disabled={busy === a.id} onClick={() => resolve(a.id)}>{busy === a.id ? "Resolvendo…" : "Resolvido"}</button>
          </div>
        ))}
      </div>
      {error && <div className="hint" style={{ color: "var(--danger)", marginTop: "0.375rem" }}>{error}</div>}
    </div>
  );
}

// Tabela dos últimos pedidos no pós-compra, com filtro de loja.
function WelcomeRuns({ days }: { days: number }) {
  const stores = useStores();
  const [store, setStore] = useState("");
  const [rows, setRows] = useState<WelcomeRun[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    api<{ runs?: WelcomeRun[] }>(`/api/recovery/welcome?days=${days}${store ? `&store=${encodeURIComponent(store)}` : ""}`)
      .then((d) => { if (!cancelled) setRows(Array.isArray(d.runs) ? d.runs : []); })
      .catch((e) => { if (!cancelled) { setError(errorMessage(e)); setRows([]); } });
    return () => { cancelled = true; };
  }, [days, store]);
  return (
    <div className="card" style={{ marginBottom: "1rem", overflowX: "auto" }}>
      <div className="section-title" style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        Últimos pedidos no pós-compra
        <select value={store} onChange={(e) => setStore(e.target.value)} style={{ width: "auto", padding: "0.25rem 0.5rem", fontSize: "0.8125rem", fontWeight: 400 }}>
          <option value="">Todas as lojas</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {error && <div className="hint" style={{ color: "var(--danger)" }}>{error}</div>}
      {!rows && !error && <span className="hint">Carregando…</span>}
      {rows && rows.length === 0 && !error && <span className="hint">Nenhum primeiro pedido no período. Os pedidos entram aqui a cada ciclo da régua, mesmo com o pós-compra desligado (para medir).</span>}
      {rows && rows.length > 0 && (
        <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
          <thead><tr><th>Comprou</th><th>Loja</th><th>Pedido</th><th>Cliente</th><th>Valor</th><th>Envio</th><th>Passo</th><th>Próximo</th><th>Status</th></tr></thead>
          <tbody>
            {rows.slice(0, 80).map((r) => {
              const st = runStatusInfo(r.status);
              return (
                <tr key={r.id}>
                  <td>{when(r.purchasedAt)}</td>
                  <td>{r.store}</td>
                  <td>{r.orderName ?? "·"}{r.receiptSent ? <div className="hint">comprovante já foi</div> : null}</td>
                  <td>{r.name ?? "·"}<div className="hint">{r.email ?? ""} · {LANG_NAME[r.language ?? "?"] ?? r.language} {r.country ?? ""}</div></td>
                  <td>{fmtMoney(r.total, r.currency ?? "")}</td>
                  <td>{r.fulfilledAt ? <>enviado {when(r.fulfilledAt)}{r.tracking ? <div className="hint">{r.tracking}</div> : null}</> : <span className="hint">ainda não</span>}</td>
                  <td>{r.step}</td>
                  <td>{r.status === "ativo" ? when(r.nextAt) : "·"}</td>
                  <td><span className={st.cls}>{st.label}</span>{r.stopReason ? <div className="hint">{r.stopReason}</div> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function DashboardTab({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"todos" | "comprou" | "ativos">("todos");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/recovery?days=${days}`, { cache: "no-store" })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Erro ao carregar."); setData(d); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(load, [load]);

  const t = data?.totals;
  const w = data?.welcome;
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((d) => d.abandoned));
  const rows = (data?.recent ?? []).filter((r) => (filter === "comprou" ? r.status === "recuperado" || r.status === "parado_comprou" : filter === "ativos" ? r.status === "ativo" : true));
  const anyChannelOn = (data?.stores ?? []).some((s) => s.settings?.enabled);

  return (
    <>
      {data && <AlertsBlock alerts={data.alerts ?? []} onResolved={load} />}

      <p className="hint" style={{ marginBottom: "1rem" }}>
        Checkouts abandonados puxados da Shopify de todas as lojas, de 10 em 10 minutos. Fase atual: <strong>{anyChannelOn ? "enviando" : "só medindo"}</strong>. Nenhum e-mail, WhatsApp ou SMS sai daqui enquanto a régua estiver desligada; o que aparece como "comprou" voltou sozinho (ou pelo Klaviyo).
      </p>

      {data?.migrationMissing && <MigrationWarning />}

      <div className="toolbar" style={{ marginBottom: "1rem", gap: "0.5rem", display: "flex", flexWrap: "wrap", alignItems: "center" }}>
        {[7, 14, 30, 60, 90].map((d) => (
          <button key={d} className={`btn btn-sm ${days === d ? "btn-primary" : "btn-ghost"}`} onClick={() => setDays(d)}>{d} dias</button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
        {data?.lastSync?.length ? <span className="hint">Último sync: {data.lastSync.map((s) => `${s.store} ${when(s.at)}`).join(" · ")}</span> : null}
      </div>
      {error && <div className="card" style={{ borderLeft: "3px solid var(--danger)", marginBottom: "1rem" }}>{error}</div>}
      {!data && !error && <div className="empty">Carregando…</div>}

      {t && (
        <div className="stat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <Stat value={String(t.abandoned)} label="Abandonados" sub={`${data?.days} dias · ${t.active} ainda ativos`} />
          <Stat value={String(t.bought)} label="Voltaram a comprar" sub="mesmo checkout ou outro pedido" />
          <Stat value={pct(t.rate)} label="Taxa de volta" sub="linha de base (sem a régua nova)" />
          <Stat value={t.abandoned ? pct(t.withPhone / t.abandoned) : "·"} label="Com telefone" sub="alcançáveis por WhatsApp" />
          <Stat value={`${t.emailConsent} / ${t.smsConsent}`} label="Opt-in e-mail / SMS" sub="marcaram consentimento na Shopify" />
        </div>
      )}

      {data && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Abandonos (cinza) e compras (verde) por dia</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 110 }}>
            {data.byDay.map((d) => (
              <div key={d.day} title={`${d.day}: ${d.abandoned} abandonados, ${d.bought} compraram`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                <div style={{ height: `${(d.abandoned / maxDay) * 100}%`, background: "var(--border)", borderRadius: "3px 3px 0 0", position: "relative" }}>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: d.abandoned ? `${(d.bought / d.abandoned) * 100}%` : 0, background: "var(--ok, #2e9e5b)", borderRadius: "3px 3px 0 0" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && w && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Pós-compra (boas-vindas) · {data.days} dias</div>
          <div className="stat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}>
            <Stat value={String(w.runs)} label="Primeiros pedidos" sub={`${w.active} ativos · ${w.done} concluídos · ${w.stopped} parados`} />
            <Stat value={String(w.sent)} label="Receberam e-mail" sub="pelo menos um passo (sem testes)" />
            <Stat value={w.sent ? pct(w.opened / w.sent) : "·"} label="Abriram" sub={`${w.opened} de ${w.sent}`} />
            <Stat value={w.sent ? pct(w.clicked / w.sent) : "·"} label="Clicaram" sub={`${w.clicked} de ${w.sent}`} />
          </div>
        </div>
      )}

      {data && !data.migrationMissing && <WelcomeRuns days={days} />}

      {data && data.stores.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem", overflowX: "auto" }}>
          <div className="section-title">Por loja</div>
          <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
            <thead><tr><th>Loja</th><th>Abandonados</th><th>Valor abandonado</th><th>Compraram</th><th>Valor recuperado</th><th>Taxa</th><th>Telefone</th><th>Opt-in e-mail / SMS</th><th>Idiomas</th><th>Régua</th></tr></thead>
            <tbody>
              {data.stores.map((s) => (
                <tr key={s.storeId}>
                  <td>{s.storeName}</td>
                  <td>{s.abandoned}</td>
                  <td>{moneyList(s.valueByCurrency)}</td>
                  <td>{s.bought} <span className="hint">({s.boughtSameCheckout} mesmo checkout, {s.boughtOtherOrder} outro pedido)</span></td>
                  <td>{moneyList(s.boughtValueByCurrency)}</td>
                  <td>{pct(s.rate)}</td>
                  <td>{s.abandoned ? pct(s.withPhone / s.abandoned) : "·"}</td>
                  <td>{s.emailConsent} / {s.smsConsent}</td>
                  <td>{s.byLanguage.slice(0, 4).map((l) => `${LANG_NAME[l.name] ?? l.name} ${l.count}`).join(", ")}</td>
                  <td>{s.settings?.enabled ? <span className="badge badge-ok">ligada</span> : <span className="badge">desligada</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Canais e provedores</div>
          <div style={{ display: "grid", gap: "0.3rem", fontSize: "0.8125rem" }}>
            <div>E-mail (Resend): {data.providers.resend ? <span className="badge badge-ok">chave configurada</span> : <span className="badge">sem RESEND_API_KEY</span>} {data.providers.resendWebhookSecret ? <span className="badge badge-ok">webhook ok</span> : <span className="badge">sem RESEND_WEBHOOK_SECRET</span>}</div>
            <div>E-mail (Amazon SES): {data.providers.ses ? <span className="badge badge-ok">credenciais configuradas</span> : <span className="badge">não configurado</span>} <span className="hint">(o provedor de cada loja é escolhido em Configuração)</span></div>
            <div>WhatsApp (WAHA): {data.providers.waha ? <span className="badge badge-ok">servidor configurado</span> : <span className="badge">sem WAHA_URL / WAHA_API_KEY</span>} {data.providers.wahaWebhookSecret ? <span className="badge badge-ok">webhook ok</span> : <span className="badge">sem WAHA_WEBHOOK_SECRET</span>}</div>
            {data.whatsappSessions.length > 0 && (
              <div>Sessões: {data.whatsappSessions.map((s) => <span key={s.name} className={`badge ${s.status === "WORKING" ? "badge-ok" : s.status === "SCAN_QR_CODE" ? "badge-warn" : ""}`} style={{ marginRight: 6 }}>{s.name} · {s.status ?? "?"}{s.me_name ? ` · ${s.me_name}` : ""}</span>)}</div>
            )}
            <div>SMS: <span className="badge">não configurado (reserva)</span></div>
            <div className="hint">Supressão: {data.suppressions.total} contato(s){data.suppressions.byReason.length ? ` (${data.suppressions.byReason.map((r) => `${r.name} ${r.count}`).join(", ")})` : ""}.</div>
          </div>
        </div>
      )}

      {data && data.funnel.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem", overflowX: "auto" }}>
          <div className="section-title">Funil por canal e degrau</div>
          <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
            <thead><tr><th>Degrau</th><th>Canal</th><th>Enviados</th><th>Entregues</th><th>Abertos/lidos</th><th>Cliques</th><th>Responderam</th><th>Rejeitados</th><th>Reclamações</th><th>Descadastros</th><th>Falhas</th></tr></thead>
            <tbody>
              {data.funnel.map((f) => (
                <tr key={`${f.channel}${f.step}`}><td>{f.step}</td><td>{f.channel}</td><td>{f.sent}</td><td>{f.delivered}</td><td>{f.opened}</td><td>{f.clicked}</td><td>{f.replied}</td><td>{f.bounced}</td><td>{f.complained}</td><td>{f.unsubscribed}</td><td>{f.failed}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="section-title" style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            Últimos carrinhos
            {(["todos", "comprou", "ativos"] as const).map((f) => (
              <button key={f} className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f === "todos" ? "Todos" : f === "comprou" ? "Compraram" : "Ativos"}</button>
            ))}
          </div>
          {rows.length === 0 ? (
            <span className="hint">{data.migrationMissing ? "Sem tabela ainda." : "Nada no período. O primeiro sync roda no próximo ciclo do cron (ou POST /api/cron/cart-recovery?hours=720)."}</span>
          ) : (
            <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
              <thead><tr><th>Quando</th><th>Loja</th><th>Cliente</th><th>Carrinho</th><th>Valor</th><th>Cupom do funil</th><th>Opt-in</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={onOpenConversation && r.phone ? "clickable" : undefined} onClick={() => onOpenConversation && r.phone && onOpenConversation(r.id)} title={onOpenConversation && r.phone ? "Abrir na aba Conversas" : undefined}>
                    <td>{when(r.abandonedAt)}</td>
                    <td>{r.store}</td>
                    <td>{r.name ?? "·"}<div className="hint">{r.email ?? ""}{r.phone ? ` · ${r.phone}` : ""} · {LANG_NAME[r.language ?? "?"] ?? r.language} {r.country ?? ""}</div></td>
                    <td style={{ maxWidth: 320 }}>{r.items || "·"}</td>
                    <td>{fmtMoney(r.total, r.currency ?? "")}</td>
                    <td>{r.discountCodes.join(", ") || "·"}</td>
                    <td>{r.emailConsent === "SUBSCRIBED" ? "e-mail" : ""}{r.smsConsent === "SUBSCRIBED" ? " sms" : ""}{r.emailConsent !== "SUBSCRIBED" && r.smsConsent !== "SUBSCRIBED" ? "·" : ""}</td>
                    <td><span className={STATUS_INFO[r.status]?.cls ?? "badge"}>{STATUS_INFO[r.status]?.label ?? r.status}</span>{r.recoveredOrder ? <div className="hint">{r.recoveredOrder} · {when(r.recoveredAt)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
