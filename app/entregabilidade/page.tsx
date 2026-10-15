"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Shell from "@/components/Shell";

interface Summary { attempts: number; sent: number; failed: number; bounced: number; delivered: number; opened: number; replied: number; uniqueRecipients: number; deliveryRate: number | null; bounceRate: number | null; openRate: number | null; replyRate: number | null; tests: number }
interface Row { id: string; kind: string; trigger: string; isTest: boolean; store: string | null; from: string | null; to: string; name: string | null; brand: string | null; language: string | null; subject: string | null; orderName: string | null; status: string; error: string | null; createdAt: string; openCount: number; firstOpenedAt: string | null; bounced: boolean; bounceReason: string | null; repliedAt: string | null; provider: string }
interface Group { name: string; sent: number; bounced: number; opened?: number }
interface Auth { domain: string; spf: string | null; dmarc: string | null; dmarcPolicy: string | null; dmarcReports: boolean; dkimSelectors: string[] }
interface Data {
  days: number; migrationMissing: boolean;
  summary: { all: Summary; receipt: Summary; auto_ack: Summary };
  byProvider: Group[]; byLanguage: Group[]; byBrand: Group[];
  byDay: Array<{ day: string; sent: number; opened: number; bounced: number; failed: number }>;
  manual: { sent: number; bounced: number; bounceRate: number | null; byProvider: Group[] };
  bounces: Array<{ email: string; at: string; reason: string }>;
  auth: Auth[];
  mailboxes: Array<{ email: string; store: string | null; lastSyncedAt: string | null; lastError: string | null }>;
  stores: Array<{ id: string; name: string; autoAck: boolean; autoReceipt: boolean; autoReceiptSince: string | null }>;
  rows: Row[];
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const KIND: Record<string, string> = { receipt: "Comprovante", auto_ack: "Aviso de recebimento" };
type Health = "ok" | "warn" | "danger" | "none";
const HEALTH_LABEL: Record<Health, string> = { ok: "Saudável", warn: "Pode melhorar", danger: "Precisa de atenção", none: "Sem dados" };
const HEALTH_CLASS: Record<Health, string> = { ok: "badge badge-ok", warn: "badge badge-warn", danger: "badge badge-danger", none: "badge" };

function Stat({ value, label, sub, health }: { value: string; label: string; sub?: string; health?: Health }) {
  return (
    <div className="card" style={{ margin: 0, padding: "1rem" }}>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontWeight: 600, marginTop: "0.35rem" }}>{label}</div>
      {sub && <div className="hint">{sub}</div>}
      {health && <span className={HEALTH_CLASS[health]} style={{ marginTop: "0.4rem" }}>{HEALTH_LABEL[health]}</span>}
    </div>
  );
}

function Bars({ groups }: { groups: Group[] }) {
  const total = groups.reduce((n, g) => n + g.sent, 0);
  if (total === 0) return <span className="hint">Sem envios no período.</span>;
  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      {groups.map((g) => (
        <div key={g.name} style={{ display: "grid", gridTemplateColumns: "150px 1fr 150px", gap: "0.6rem", alignItems: "center", fontSize: "0.8125rem" }}>
          <span style={{ textAlign: "right" }}>{g.name}</span>
          <div style={{ display: "flex", height: 14, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${((g.sent - g.bounced) / total) * 100}%`, background: "var(--accent)" }} />
            <div style={{ width: `${(g.bounced / total) * 100}%`, background: "var(--danger)" }} />
          </div>
          <span className="hint">{g.sent} enviado(s){g.bounced ? ` · ${g.bounced} rejeitado(s)` : ""}{g.opened != null ? ` · ${g.opened} aberto(s)` : ""}</span>
        </div>
      ))}
    </div>
  );
}

const FILTERS = [
  ["todos", "Todos"], ["entregues", "Entregues"], ["abertos", "Abertos"], ["respondidos", "Responderam"], ["rejeitados", "Rejeitados"], ["falhas", "Falhas de envio"], ["testes", "Testes"],
] as const;

export default function EntregabilidadePage() {
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<"all" | "receipt" | "auto_ack">("all");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("todos");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/deliverability?days=${days}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Erro ao carregar."); setData(d); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(load, [load]);

  const s = data ? data.summary[kind] : null;
  const rows = useMemo(() => {
    const base = (data?.rows ?? []).filter((r) => kind === "all" || r.kind === kind);
    if (filter === "testes") return base.filter((r) => r.isTest);
    const real = base.filter((r) => !r.isTest);
    if (filter === "entregues") return real.filter((r) => r.status === "sent" && !r.bounced);
    if (filter === "abertos") return real.filter((r) => r.openCount > 0);
    if (filter === "respondidos") return real.filter((r) => r.repliedAt);
    if (filter === "rejeitados") return real.filter((r) => r.bounced);
    if (filter === "falhas") return real.filter((r) => r.status === "failed");
    return real;
  }, [data, kind, filter]);

  function exportCsv() {
    const head = ["quando", "tipo", "origem", "loja", "marca", "de", "para", "nome", "idioma", "pedido", "status", "aberturas", "rejeitado", "motivo", "respondeu_em", "provedor", "erro"];
    const lines = rows.map((r) => [r.createdAt, KIND[r.kind] ?? r.kind, r.trigger, r.store ?? "", r.brand ?? "", r.from ?? "", r.to, r.name ?? "", r.language ?? "", r.orderName ?? "", r.status, r.openCount, r.bounced ? "sim" : "não", r.bounceReason ?? "", r.repliedAt ?? "", r.provider, r.error ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `entregabilidade-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  const bounceHealth: Health = !s || s.bounceRate == null ? "none" : s.bounceRate > 0.05 ? "danger" : s.bounceRate > 0.02 ? "warn" : "ok";
  const openHealth: Health = !s || s.openRate == null ? "none" : s.openRate < 0.2 ? "danger" : s.openRate < 0.35 ? "warn" : "ok";
  const failHealth: Health = !s || s.attempts === 0 ? "none" : s.failed / s.attempts > 0.05 ? "danger" : s.failed > 0 ? "warn" : "ok";
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((d) => d.sent + d.failed));

  return (
    <Shell>
      <h1 className="page-title">Entregabilidade</h1>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        Tudo o que o sistema envia sozinho (comprovante de compra e aviso de recebimento): o que saiu, o que voltou, quem abriu e quem respondeu. Reclamação de spam não aparece aqui — só o Google mede, no Postmaster Tools.
      </p>

      {data?.migrationMissing && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
          Falta rodar a migration <code>0017_email_log.sql</code> no Supabase. Sem ela não existe registro de envio nem a trava contra envio em dobro — <strong>todo envio automático fica bloqueado</strong> até ela rodar. As seções de respostas manuais e autenticação abaixo já funcionam.
        </div>
      )}
      {error && <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>{error}</div>}

      <div className="card" style={{ marginBottom: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center" }}>
          Período
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: "auto" }}>
            {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? "Hoje (24h)" : `${d} dias`}</option>)}
          </select>
        </label>
        <div className="tabs">
          {([["all", "Todos"], ["receipt", "Comprovante"], ["auto_ack", "Aviso de recebimento"]] as const).map(([k, label]) => (
            <button key={k} type="button" className={`tab${kind === k ? " active" : ""}`} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
        {data && (
          <span className="hint" style={{ marginLeft: "auto" }}>
            {data.stores.filter((x) => x.autoReceipt || x.autoAck).length === 0
              ? "Nenhum envio automático ligado."
              : data.stores.filter((x) => x.autoReceipt || x.autoAck).map((x) => `${x.name}: ${[x.autoReceipt ? "comprovante" : "", x.autoAck ? "aviso" : ""].filter(Boolean).join(" + ")}`).join(" · ")}
          </span>
        )}
      </div>

      {s && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <Stat value={String(s.sent)} label="Enviados" sub={`${s.uniqueRecipients} destinatário(s) único(s)`} />
            <Stat value={pct(s.deliveryRate)} label="Taxa de entrega" sub={`${s.delivered} entregue(s)`} />
            <Stat value={pct(s.openRate)} label="Taxa de abertura" sub={`${s.opened} abriram`} health={openHealth} />
            <Stat value={pct(s.bounceRate)} label="Taxa de rejeição" sub={`${s.bounced} rejeitado(s)`} health={bounceHealth} />
            <Stat value={pct(s.replyRate)} label="Responderam" sub={`${s.replied} cliente(s)`} />
            <Stat value={String(s.failed)} label="Falhas de envio" sub="o servidor recusou na hora" health={failHealth} />
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <div className="section-title">Envios por dia</div>
            {data!.byDay.length === 0 ? <span className="hint">Sem envios no período.</span> : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 110, overflowX: "auto" }}>
                {data!.byDay.map((d) => (
                  <div key={d.day} title={`${d.day.slice(8)}/${d.day.slice(5, 7)}: ${d.sent} enviado(s), ${d.opened} aberto(s), ${d.bounced} rejeitado(s), ${d.failed} falha(s)`} style={{ flex: "1 0 14px", maxWidth: 40, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                    <div style={{ height: `${(d.failed / maxDay) * 100}%`, background: "var(--danger)" }} />
                    <div style={{ height: `${(d.sent / maxDay) * 100}%`, background: "var(--accent)", borderRadius: "2px 2px 0 0" }} />
                    <div className="hint" style={{ fontSize: "0.625rem", textAlign: "center" }}>{d.day.slice(8)}/{d.day.slice(5, 7)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <div className="card" style={{ margin: 0 }}><div className="section-title">Por provedor de e-mail</div><Bars groups={data!.byProvider} /></div>
            <div className="card" style={{ margin: 0 }}><div className="section-title">Por idioma</div><Bars groups={data!.byLanguage} /></div>
            <div className="card" style={{ margin: 0 }}><div className="section-title">Por marca</div><Bars groups={data!.byBrand} /></div>
            <div className="card" style={{ margin: 0 }}>
              <div className="section-title">Respostas manuais (Inbox) — {data!.manual.sent} enviadas, {data!.manual.bounced} devolvidas ({pct(data!.manual.bounceRate)})</div>
              <Bars groups={data!.manual.byProvider} />
            </div>
          </div>
        </>
      )}

      {data && (
        <>
          <div className="card" style={{ marginBottom: "1rem" }}>
            <div className="section-title">Autenticação dos domínios (lida do DNS agora)</div>
            <table className="table">
              <thead><tr><th>Domínio</th><th>SPF</th><th>DKIM</th><th>DMARC</th><th>Relatórios DMARC</th></tr></thead>
              <tbody>
                {data.auth.map((a) => (
                  <tr key={a.domain}>
                    <td>{a.domain}</td>
                    <td><span className={a.spf ? "badge badge-ok" : "badge badge-danger"}>{a.spf ? "ok" : "faltando"}</span></td>
                    <td><span className={a.dkimSelectors.length ? "badge badge-ok" : "badge badge-warn"}>{a.dkimSelectors.length ? `ok (${a.dkimSelectors.join(", ")})` : "não encontrado"}</span></td>
                    <td><span className={a.dmarc ? (a.dmarcPolicy === "none" ? "badge badge-warn" : "badge badge-ok") : "badge badge-danger"}>{a.dmarc ? `p=${a.dmarcPolicy}` : "faltando"}</span></td>
                    <td><span className={a.dmarcReports ? "badge badge-ok" : "badge badge-warn"}>{a.dmarcReports ? "recebendo" : "sem endereço (rua)"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="hint">DKIM "não encontrado" só significa que o seletor não é um dos conhecidos (Hostinger, Google). Taxa de spam real: <a href="https://postmaster.google.com" target="_blank" rel="noreferrer">Google Postmaster Tools</a>.</span>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <div className="section-title">Caixas de envio</div>
            <table className="table">
              <thead><tr><th>Caixa</th><th>Loja</th><th>Última sincronização</th><th>Situação</th></tr></thead>
              <tbody>
                {data.mailboxes.map((m) => (
                  <tr key={m.email}><td>{m.email}</td><td>{m.store ?? "—"}</td><td>{when(m.lastSyncedAt)}</td><td><span className={m.lastError ? "badge badge-danger" : "badge badge-ok"}>{m.lastError ? m.lastError.slice(0, 80) : "ok"}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <div className="section-title" style={{ margin: 0 }}>Destinatários ({rows.length})</div>
              <div className="tabs">
                {FILTERS.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>{label}</button>)}
              </div>
              <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={exportCsv} disabled={rows.length === 0}>Exportar CSV</button>
            </div>
            {rows.length === 0 ? <span className="hint">Nada nesse filtro.</span> : (
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead><tr><th>Quando</th><th>Tipo</th><th>Para</th><th>Marca</th><th>Idioma</th><th>Pedido</th><th>Status</th><th>Aberturas</th><th>Respondeu</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 300).map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{when(r.createdAt)}</td>
                        <td>{KIND[r.kind] ?? r.kind}{r.trigger === "auto" ? "" : r.trigger === "test" ? " (teste)" : " (manual)"}</td>
                        <td><div>{r.to}</div>{r.name && <div className="hint" dir="auto">{r.name}</div>}</td>
                        <td>{r.brand ?? "—"}</td>
                        <td>{r.language ?? "—"}</td>
                        <td>{r.orderName ?? "—"}</td>
                        <td>
                          {r.status === "failed" ? <span className="badge badge-danger" title={r.error ?? ""}>falhou</span>
                            : r.status === "sending" ? <span className="badge badge-warn">enviando</span>
                            : r.bounced ? <span className="badge badge-danger">rejeitado · {r.bounceReason}</span>
                            : <span className="badge badge-ok">entregue</span>}
                        </td>
                        <td>{r.openCount > 0 ? <span title={`1ª abertura: ${when(r.firstOpenedAt)}`}>{r.openCount}</span> : "0"}</td>
                        <td>{r.repliedAt ? when(r.repliedAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-title">Devoluções recebidas nas caixas ({data.bounces.length})</div>
            {data.bounces.length === 0 ? <span className="hint">Nenhum aviso de devolução no período.</span> : (
              <table className="table">
                <thead><tr><th>Quando</th><th>Endereço</th><th>Motivo</th></tr></thead>
                <tbody>{data.bounces.slice(0, 50).map((b) => <tr key={b.email}><td style={{ whiteSpace: "nowrap" }}>{when(b.at)}</td><td>{b.email}</td><td>{b.reason}</td></tr>)}</tbody>
              </table>
            )}
            <span className="hint">Inclui devoluções de respostas manuais. Endereço que não existe vale corrigir com o cliente por outro canal.</span>
          </div>
        </>
      )}
    </Shell>
  );
}
