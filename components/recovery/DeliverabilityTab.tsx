"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, fmtDateTime, MigrationWarning } from "./shared";

// Aba Entregabilidade: o e-mail de marketing está chegando? Taxas (entrega,
// abertura, clique, bounce, reclamação, descadastro), barras por dia, tabelas
// por provedor de envio e por domínio do destinatário, DNS de cada remetente
// (com os registros que faltam), rampa de aquecimento, saúde das últimas 24 h
// e, quando configurado, o status da conta no Amazon SES.
// Dados: GET /api/recovery/deliverability?days=&store=&dns=1.

interface SenderDns {
  domain: string; spf: string | null; dkim: boolean; dkimSelectors: string[]; dmarc: string | null; dmarcPolicy: string | null; ok: boolean; problems: string[];
  spfHost?: string | null; dmarcHost?: string | null; dkimSource?: "dns" | "ses" | null; hints?: string[];
  needed?: Array<{ type: string; name: string; value: string; note: string }>; checkedAt?: string; fromCache?: boolean;
}
interface Report {
  days: number; storeId: string | null; migrationMissing: boolean;
  totals: { sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number; failed: number };
  byDay: Array<{ day: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number }>;
  byProvider: Array<{ provider: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number }>;
  byDomain: Array<{ domain: string; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number }>;
  rates: { delivery: number | null; open: number | null; click: number | null; bounce: number | null; complaint: number | null; unsubscribe: number | null };
  senders: Array<{ storeId: string; store: string; fromEmail: string; provider: string; dns: SenderDns }>;
  warmup: Array<{ storeId: string; store: string; testMode: boolean; cap: number; ramp: number; dailyCap: number; stage: number; days: number; productionSince: string | null; frozen: boolean }>;
  health: Array<{ storeId: string; store: string; emailEnabled: boolean; sent24h: number; bounced24h: number; complained24h: number; bounceRate: number | null; complaintRate: number | null; action: "ok" | "pausar" | "alertar"; reason: string | null }>;
  providers: { resend: boolean; ses: boolean };
  ses: { sendingEnabled: boolean; enforcementStatus: string | null; dailyQuota: number | null; sentLast24h: number | null; maxSendRate: number | null; productionAccess: boolean; vdmEnabled: boolean } | null;
  generatedAt: string;
}

const pct = (v: number | null | undefined, digits = 1) => (v == null ? "·" : `${(v * 100).toFixed(digits).replace(".", ",")}%`);
const n = (v: number | null | undefined) => (v == null ? "·" : v.toLocaleString("pt-BR"));
const PROVIDER_LABEL: Record<string, string> = { resend: "Resend", ses: "Amazon SES", desconhecido: "Sem provedor registrado" };
const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;
const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function Stat({ value, label, sub, tone }: { value: string; label: string; sub?: string; tone?: "ok" | "warn" | "danger" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : tone === "danger" ? "var(--danger)" : undefined;
  return (
    <div className="card" style={{ margin: 0, padding: "1rem" }}>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.1, color }}>{value}</div>
      <div style={{ fontWeight: 600, marginTop: "0.35rem" }}>{label}</div>
      {sub && <div className="hint">{sub}</div>}
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <span className={`badge ${ok ? "badge-ok" : "badge-danger"}`} title={detail ?? undefined} style={{ marginRight: "0.35rem" }}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

const HEALTH_BADGE: Record<string, { label: string; cls: string }> = {
  ok: { label: "ok", cls: "badge badge-ok" },
  alertar: { label: "atenção", cls: "badge badge-warn" },
  pausar: { label: "pausar", cls: "badge badge-danger" },
};

export default function DeliverabilityTab({ storeId }: { storeId?: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingDns, setCheckingDns] = useState(false);

  const load = useCallback(async (forceDns = false) => {
    if (forceDns) setCheckingDns(true);
    else setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (storeId) qs.set("store", storeId);
      if (forceDns) qs.set("dns", "1");
      setData(await api<Report>(`/api/recovery/deliverability?${qs.toString()}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setCheckingDns(false);
    }
  }, [days, storeId]);
  useEffect(() => { void load(false); }, [load]);

  const t = data?.totals;
  const r = data?.rates;
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((d) => d.sent));
  const bounceTone = r?.bounce == null ? undefined : r.bounce >= 0.04 ? "danger" : r.bounce >= 0.02 ? "warn" : "ok";
  const complaintTone = r?.complaint == null ? undefined : r.complaint >= 0.0008 ? "danger" : r.complaint > 0 ? "warn" : "ok";

  return (
    <>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        Só e-mails de marketing reais (recuperação de carrinho e pós-compra, sem os de teste). Entrega = enviados menos rejeitados; "entregues" na tabela é o que o provedor confirmou pelo webhook. Comprovantes e respostas do suporte ficam em <a href="/entregabilidade">Entregabilidade do suporte</a>.
      </p>

      {data?.migrationMissing && <MigrationWarning />}

      <div className="toolbar" style={{ marginBottom: "1rem", gap: "0.5rem", display: "flex", flexWrap: "wrap", alignItems: "center" }}>
        {[7, 14, 30, 60, 90].map((d) => (
          <button key={d} type="button" className={`btn btn-sm ${days === d ? "btn-primary" : "btn-ghost"}`} onClick={() => setDays(d)}>{d} dias</button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load(false)} disabled={loading || checkingDns}>{loading ? "Atualizando…" : "Atualizar"}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load(true)} disabled={loading || checkingDns}>{checkingDns ? "Consultando DNS…" : "Checar DNS agora"}</button>
        {data && (
          <span className="hint">
            Provedores: <span className={`badge ${data.providers.resend ? "badge-ok" : ""}`}>Resend {data.providers.resend ? "configurado" : "sem chave"}</span>{" "}
            <span className={`badge ${data.providers.ses ? "badge-ok" : ""}`}>Amazon SES {data.providers.ses ? "configurado" : "sem credencial"}</span>
          </span>
        )}
      </div>
      {error && <div className="card" style={{ borderLeft: "3px solid var(--danger)", marginBottom: "1rem" }}>{error}</div>}
      {!data && !error && <div className="empty">Carregando…</div>}

      {t && r && (
        <div className="stat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <Stat value={pct(r.delivery)} label="Entrega" sub={`${n(t.sent)} enviados · ${n(t.delivered)} confirmados`} tone={r.delivery == null ? undefined : r.delivery >= 0.97 ? "ok" : r.delivery >= 0.95 ? "warn" : "danger"} />
          <Stat value={pct(r.open)} label="Abertura" sub={`${n(t.opened)} abriram`} />
          <Stat value={pct(r.click)} label="Clique" sub={`${n(t.clicked)} clicaram`} />
          <Stat value={pct(r.bounce)} label="Bounce" sub={`${n(t.bounced)} rejeitados · limite 4%`} tone={bounceTone} />
          <Stat value={pct(r.complaint, 2)} label="Reclamação" sub={`${n(t.complained)} marcaram spam · limite 0,08%`} tone={complaintTone} />
          <Stat value={pct(r.unsubscribe)} label="Descadastro" sub={`${n(t.unsubscribed)} pediram para parar${t.failed ? ` · ${n(t.failed)} falhas de envio` : ""}`} />
        </div>
      )}

      {data && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Enviados (cinza), abertos (verde) e rejeitados (vermelho) por dia</div>
          {data.byDay.every((d) => d.sent === 0) ? (
            <div className="empty">Nenhum e-mail de marketing real nos últimos {data.days} dias.</div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 110 }}>
              {data.byDay.map((d) => (
                <div key={d.day} title={`${dayLabel(d.day)}: ${d.sent} enviados, ${d.delivered} entregues, ${d.opened} abertos, ${d.clicked} clicados, ${d.bounced} rejeitados, ${d.complained} reclamações, ${d.unsubscribed} descadastros`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                  <div style={{ height: `${(d.sent / maxDay) * 100}%`, background: "var(--border)", borderRadius: "3px 3px 0 0", position: "relative" }}>
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: d.sent ? `${(d.opened / d.sent) * 100}%` : 0, background: "var(--ok, #2e9e5b)", borderRadius: "3px 3px 0 0" }} />
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: d.sent ? `${(d.bounced / d.sent) * 100}%` : 0, background: "var(--danger, #dc2626)", borderRadius: "3px 3px 0 0" }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1rem", marginBottom: "1rem" }}>
          <div className="card" style={{ margin: 0, overflowX: "auto" }}>
            <div className="section-title">Por provedor de envio</div>
            {data.byProvider.length === 0 ? <div className="empty">Sem envios.</div> : (
              <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                <thead><tr><th>Provedor</th><th>Enviados</th><th>Entregues</th><th>Abertos</th><th>Rejeitados</th><th>Reclamações</th></tr></thead>
                <tbody>
                  {data.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td>{providerLabel(p.provider)}</td>
                      <td>{n(p.sent)}</td>
                      <td>{n(p.delivered)}</td>
                      <td>{n(p.opened)} <span className="hint">({pct(p.sent ? p.opened / p.sent : null)})</span></td>
                      <td>{n(p.bounced)} <span className="hint">({pct(p.sent ? p.bounced / p.sent : null)})</span></td>
                      <td>{n(p.complained)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card" style={{ margin: 0, overflowX: "auto" }}>
            <div className="section-title">Por domínio do destinatário</div>
            {data.byDomain.length === 0 ? <div className="empty">Sem envios.</div> : (
              <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                <thead><tr><th>Domínio</th><th>Enviados</th><th>Entregues</th><th>Abertos</th><th>Rejeitados</th></tr></thead>
                <tbody>
                  {data.byDomain.map((d) => (
                    <tr key={d.domain}>
                      <td>{d.domain}</td>
                      <td>{n(d.sent)}</td>
                      <td>{n(d.delivered)}</td>
                      <td>{n(d.opened)} <span className="hint">({pct(d.sent ? d.opened / d.sent : null)})</span></td>
                      <td style={{ color: d.sent && d.bounced / d.sent >= 0.04 ? "var(--danger)" : undefined }}>{n(d.bounced)} <span className="hint">({pct(d.sent ? d.bounced / d.sent : null)})</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {data && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Remetentes (DNS ao vivo)</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Com SPF, DKIM e DMARC faltando o motor não envia em produção (evento "dns_nao_verificado") e o modo de teste não pode ser desligado. Resultado guardado por 10 minutos; "Checar DNS agora" consulta de novo.
          </p>
          {data.senders.length === 0 ? (
            <div className="empty">Nenhuma loja com e-mail de remetente configurado (Configuração → Remetente).</div>
          ) : (
            data.senders.map((s) => {
              const hints = s.dns.hints ?? [];
              const needed = s.dns.needed ?? [];
              return (
              <div key={s.storeId} style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 0" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.35rem" }}>
                  <span className={`badge ${s.dns.ok ? "badge-ok" : "badge-danger"}`}>{s.dns.ok ? "pronto" : "falta DNS"}</span>
                  <strong>{s.store}</strong>
                  <span className="hint">{s.fromEmail} · {providerLabel(s.provider)} · domínio {s.dns.domain}</span>
                  <span className="hint" style={{ marginLeft: "auto" }}>checado {fmtDateTime(s.dns.checkedAt)}{s.dns.fromCache ? " (cache)" : ""}</span>
                </div>
                <div style={{ marginBottom: "0.35rem" }}>
                  <Check ok={Boolean(s.dns.spf)} label={`SPF${s.dns.spfHost ? ` em ${s.dns.spfHost}` : ""}`} detail={s.dns.spf} />
                  <Check ok={s.dns.dkim} label={`DKIM${s.dns.dkimSelectors.length ? ` (${s.dns.dkimSelectors.join(", ")})` : ""}${s.dns.dkimSource === "ses" ? " via SES" : ""}`} />
                  <Check ok={Boolean(s.dns.dmarc)} label={`DMARC${s.dns.dmarcPolicy ? ` p=${s.dns.dmarcPolicy}` : ""}${s.dns.dmarcHost ? ` em ${s.dns.dmarcHost}` : ""}`} detail={s.dns.dmarc} />
                </div>
                {s.dns.problems.length > 0 && (
                  <ul style={{ margin: "0.25rem 0 0.25rem 1.1rem", padding: 0, color: "var(--danger)", fontSize: "0.8125rem" }}>
                    {s.dns.problems.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                )}
                {needed.length > 0 && (
                  <div style={{ fontSize: "0.8125rem", marginTop: "0.25rem" }}>
                    <div className="hint">Registros que precisam existir:</div>
                    {needed.map((rec) => (
                      <div key={`${rec.type}:${rec.name}`} style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", padding: "0.15rem 0" }}>
                        {rec.type} {rec.name} → {rec.value} <span className="hint" style={{ fontFamily: "inherit" }}>({rec.note})</span>
                      </div>
                    ))}
                  </div>
                )}
                {hints.length > 0 && (
                  <ul style={{ margin: "0.25rem 0 0 1.1rem", padding: 0, fontSize: "0.8125rem" }} className="hint">
                    {hints.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                )}
              </div>
              );
            })
          )}
        </div>
      )}

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1rem", marginBottom: "1rem" }}>
          <div className="card" style={{ margin: 0, overflowX: "auto" }}>
            <div className="section-title">Aquecimento</div>
            <p className="hint" style={{ marginTop: 0 }}>Teto de hoje = o menor entre o teto configurado e a rampa: 30 por dia quando o modo de teste é desligado, ×1,5 a cada 3 dias. Com bounce acima de 2% ou qualquer reclamação em 24 h a rampa não sobe.</p>
            {data.warmup.length === 0 ? <div className="empty">Nenhuma loja configurada.</div> : (
              <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                <thead><tr><th>Loja</th><th>Teto hoje</th><th>Estágio</th><th>Em produção desde</th></tr></thead>
                <tbody>
                  {data.warmup.map((w) => (
                    <tr key={w.storeId}>
                      <td>{w.store}{w.testMode && <span className="badge" style={{ marginLeft: "0.35rem" }}>teste</span>}</td>
                      <td><strong>{n(w.cap)}</strong> <span className="hint">(rampa {n(w.ramp)} · configurado {n(w.dailyCap)})</span></td>
                      <td>{w.stage}{w.frozen && <span className="badge badge-warn" style={{ marginLeft: "0.35rem" }}>congelado</span>}</td>
                      <td>{w.productionSince ? `${fmtDateTime(w.productionSince)} (${w.days} d)` : <span className="hint">ainda em teste</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card" style={{ margin: 0, overflowX: "auto" }}>
            <div className="section-title">Saúde (últimas 24 h)</div>
            <p className="hint" style={{ marginTop: 0 }}>Com 20 ou mais enviados: bounce de 4% ou reclamação de 0,08% desliga o e-mail da loja sozinho e gera alerta; bounce de 2% só avisa.</p>
            {data.health.length === 0 ? <div className="empty">Nenhuma loja configurada.</div> : (
              <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                <thead><tr><th>Loja</th><th>Enviados</th><th>Bounce</th><th>Reclamação</th><th>Ação</th></tr></thead>
                <tbody>
                  {data.health.map((h) => {
                    const b = HEALTH_BADGE[h.action] ?? HEALTH_BADGE.ok;
                    return (
                      <tr key={h.storeId}>
                        <td>{h.store}{!h.emailEnabled && <span className="badge" style={{ marginLeft: "0.35rem" }}>e-mail desligado</span>}</td>
                        <td>{n(h.sent24h)}</td>
                        <td>{n(h.bounced24h)} <span className="hint">({pct(h.bounceRate)})</span></td>
                        <td>{n(h.complained24h)} <span className="hint">({pct(h.complaintRate, 2)})</span></td>
                        <td><span className={b.cls} title={h.reason ?? undefined}>{b.label}</span>{h.reason && <div className="hint">{h.reason}</div>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {data && data.providers.ses && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="section-title">Amazon SES</div>
          {!data.ses ? (
            <div className="empty">Credencial presente, mas a conta não respondeu (permissão ses:GetAccount ausente ou região errada).</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem" }}>
              <Stat value={data.ses.sendingEnabled ? "ligado" : "desligado"} label="Envio" tone={data.ses.sendingEnabled ? "ok" : "danger"} />
              <Stat value={data.ses.productionAccess ? "produção" : "sandbox"} label="Acesso" sub={data.ses.productionAccess ? "pode enviar para qualquer endereço" : "só para endereços verificados"} tone={data.ses.productionAccess ? "ok" : "warn"} />
              <Stat value={data.ses.enforcementStatus ?? "·"} label="Reputação" sub="enforcement status da conta" tone={!data.ses.enforcementStatus || data.ses.enforcementStatus.toUpperCase() === "HEALTHY" ? "ok" : "danger"} />
              <Stat value={data.ses.dailyQuota == null ? "·" : n(data.ses.dailyQuota)} label="Cota diária" sub={`${data.ses.sentLast24h == null ? "·" : n(data.ses.sentLast24h)} enviados nas últimas 24 h`} />
              <Stat value={data.ses.maxSendRate == null ? "·" : `${n(data.ses.maxSendRate)}/s`} label="Velocidade máxima" />
              <Stat value={data.ses.vdmEnabled ? "ligado" : "desligado"} label="Virtual Deliverability Manager" sub="métricas detalhadas por domínio" />
            </div>
          )}
        </div>
      )}

      {data && <p className="hint">Gerado em {fmtDateTime(data.generatedAt)}.</p>}
    </>
  );
}
