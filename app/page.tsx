"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import Shell from "@/components/Shell";
import StoreSelect from "@/components/StoreSelect";
import { CATEGORY_LABEL, STATUS_CLASS, STATUS_LABEL, fmtWhen } from "@/lib/ui/labels";

interface Metrics {
  periodoDias: number;
  recebidas: number;
  atendidas: number;
  atendidasIA: number;
  atendidasHumano: number;
  automacao: number;
  sucesso: number;
  tickets: { pendentes: number; respondidos: number; reabertos: number; encerrados: number };
  spam: number;
  porDia: Array<{ dia: string; recebidas: number; respondidas: number }>;
  categorias: Record<string, number>;
  recuperacao?: Recuperacao;
}

interface Funil { enviados: number; pessoas: number; abertos: number; taxaAbertura: number; cliques: number; taxaClique: number; bounces: number; descadastros: number }
interface Recuperacao {
  abandonados: number;
  ativos: number;
  contatados: number;
  comprouComContato: number;
  valorComContato: Record<string, number>;
  comprouSozinho: number;
  valorSozinho: Record<string, number>;
  taxa: number;
  porCanal: { email: { compras: number; valor: Record<string, number> }; whatsapp: { compras: number; valor: Record<string, number> } };
  email: Funil;
  whatsapp: { contatos: number; mensagens: number; respostas: number; taxaResposta: number; cliques: number };
  posCompra: Funil & { compras: number };
}

const SYMBOL: Record<string, string> = { ILS: "₪", EUR: "€", USD: "US$", HUF: "Ft", TRY: "₺", DKK: "kr" };
function fmtMoney(v: Record<string, number>): string {
  const parts = Object.entries(v).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${SYMBOL[c] ?? c} ${Math.round(n).toLocaleString("pt-BR")}`);
  return parts.length ? parts.join(" + ") : "₪ 0";
}

interface Recent {
  id: string;
  subject: string | null;
  category: string | null;
  status: string;
  last_message_at: string | null;
  stores: { name: string } | null;
  customers: { email: string } | null;
}

const PERIODS = [
  { days: 1, label: "Hoje" },
  { days: 7, label: "7 dias" },
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
];

export default function Home() {
  const [store, setStore] = useState("");
  const [days, setDays] = useState(30);
  const [m, setM] = useState<Metrics | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [revisao, setRevisao] = useState<{ prontos: number; semRascunho: number } | null>(null);
  const [alertas, setAlertas] = useState<string[]>([]);
  const [ia, setIa] = useState<{ respostas: number; custoUsd: number; custoMedioUsd: number; chamadas: number; tokensEntrada: number; tokensSaida: number; porModelo: Record<string, number> } | null>(null);
  const [tab, setTab] = useState<"conversas" | "spam">("conversas");

  useEffect(() => {
    const sp = new URLSearchParams({ days: String(days) });
    if (store) sp.set("store", store);
    fetch(`/api/dashboard?${sp}`)
      .then((r) => r.json())
      .then((d) => {
        setM(d);
        setRevisao(d.revisao ?? null);
        setAlertas(d.alertas ?? []);
        setIa(d.ia ?? null);
      });
  }, [store, days]);

  useEffect(() => {
    const sp = new URLSearchParams({ status: tab, limit: "12" });
    if (store) sp.set("store", store);
    fetch(`/api/conversations?${sp}`)
      .then((r) => r.json())
      .then((d) => setRecent(d.conversations ?? []));
  }, [store, tab]);

  const chart = (m?.porDia ?? []).map((d) => ({ ...d, label: d.dia.slice(8, 10) + "/" + d.dia.slice(5, 7) }));
  const totalCat = Object.values(m?.categorias ?? {}).reduce((a, b) => a + b, 0);

  return (
    <Shell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="page-title">Painel de controle</h1>
          <p className="page-sub">Acompanhe o atendimento por e-mail das suas lojas.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <StoreSelect value={store} onChange={setStore} />
          <div className="tabs">
            {PERIODS.map((p) => (
              <button key={p.days} type="button" className={`tab${days === p.days ? " active" : ""}`} onClick={() => setDays(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {alertas.map((t) => (
        <div key={t} className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)", color: "var(--danger)", fontSize: "0.875rem" }}>
          {t}
        </div>
      ))}

      {revisao && (
        <a href="/inbox?status=pendentes" className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "1rem", textDecoration: "none", color: "inherit", borderLeft: "3px solid var(--accent)" }}>
          <div>
            <div className="section-title" style={{ margin: 0 }}>Modo revisão · a IA redige, você lê e envia</div>
            <div className="hint" style={{ marginTop: "0.25rem" }}>
              Nada sai sozinho até você ligar o envio automático por categoria em Minhas lojas.
              {revisao.semRascunho > 0 ? ` ${revisao.semRascunho} ainda sem rascunho (entram no próximo ciclo).` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div className="stat-value" style={{ color: "var(--accent)" }}>{revisao.prontos}</div>
            <div className="hint">respostas prontas esperando seu envio</div>
          </div>
        </a>
      )}

      {ia && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.625rem" }}>
            <div className="section-title" style={{ margin: 0 }}>Consumo da IA (OpenAI) no período</div>
            <a className="btn btn-sm" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">Adicionar crédito</a>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "0.75rem" }}>
            <div><div className="stat-label">Custo total</div><div className="stat-value">US$ {ia.custoUsd.toFixed(2)}</div></div>
            <div><div className="stat-label">Custo médio por resposta</div><div className="stat-value">US$ {ia.custoMedioUsd.toFixed(3)}</div></div>
            <div><div className="stat-label">Respostas geradas</div><div className="stat-value">{ia.respostas}</div><div className="stat-hint">{ia.chamadas} chamadas à API</div></div>
            <div><div className="stat-label">Tokens</div><div className="stat-value" style={{ fontSize: "1.125rem" }}>{(ia.tokensEntrada / 1000).toFixed(0)}k entrada · {(ia.tokensSaida / 1000).toFixed(0)}k saída</div></div>
          </div>
          <div className="hint" style={{ marginTop: "0.5rem" }}>
            {Object.entries(ia.porModelo).map(([m, c]) => `${m}: US$ ${c.toFixed(2)}`).join(" · ") || "Ainda sem medições: começa a contar nas respostas geradas a partir de agora."} Inclui triagem, redação e tradução do rascunho; regenerações somam. Preços oficiais por token, conferidos em 18/09/2026.
          </div>
        </div>
      )}

      {m?.recuperacao && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--ok)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.625rem" }}>
            <div className="section-title" style={{ margin: 0 }}>Recuperação de carrinho no período</div>
            <Link href="/recuperacao" className="btn btn-sm">Abrir recuperação</Link>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "0.75rem" }}>
            <div>
              <div className="stat-label">Recuperado com contato</div>
              <div className="stat-value" style={{ color: "var(--ok)" }}>{fmtMoney(m.recuperacao.valorComContato)}</div>
              <div className="stat-hint">{m.recuperacao.comprouComContato} venda(s) depois de e-mail ou WhatsApp nosso</div>
            </div>
            <div>
              <div className="stat-label">Por canal</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>e-mail {fmtMoney(m.recuperacao.porCanal.email.valor)}</div>
              <div className="stat-hint">{m.recuperacao.porCanal.email.compras} venda(s) · WhatsApp {fmtMoney(m.recuperacao.porCanal.whatsapp.valor)} ({m.recuperacao.porCanal.whatsapp.compras})</div>
            </div>
            <div>
              <div className="stat-label">Conversão dos contatados</div>
              <div className="stat-value" style={{ color: "var(--accent)" }}>{m.recuperacao.taxa}%</div>
              <div className="stat-hint">{m.recuperacao.comprouComContato} de {m.recuperacao.contatados} carrinhos contatados</div>
            </div>
            <div>
              <div className="stat-label">Comprou sozinho</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtMoney(m.recuperacao.valorSozinho)}</div>
              <div className="stat-hint">{m.recuperacao.comprouSozinho} carrinho(s) virou pedido sem contato nosso</div>
            </div>
            <div>
              <div className="stat-label">Carrinhos</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{m.recuperacao.abandonados} novos</div>
              <div className="stat-hint">{m.recuperacao.ativos} ainda na régua</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))", gap: "0.75rem", marginTop: "0.875rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
            <div>
              <div className="stat-label">E-mails de carrinho</div>
              <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
                <strong>{m.recuperacao.email.enviados}</strong> enviados a {m.recuperacao.email.pessoas} pessoa(s) · <strong>{m.recuperacao.email.taxaAbertura}%</strong> abertos · <strong>{m.recuperacao.email.taxaClique}%</strong> clicaram
              </div>
              <div className="stat-hint">{m.recuperacao.email.bounces} voltaram · {m.recuperacao.email.descadastros} descadastro(s)</div>
            </div>
            <div>
              <div className="stat-label">WhatsApp</div>
              <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
                <strong>{m.recuperacao.whatsapp.contatos}</strong> contatos · <strong>{m.recuperacao.whatsapp.taxaResposta}%</strong> responderam · {m.recuperacao.whatsapp.cliques} clicaram
              </div>
              <div className="stat-hint">{m.recuperacao.whatsapp.mensagens} mensagens nossas</div>
            </div>
            <div>
              <div className="stat-label">Pós-compra (boas-vindas)</div>
              <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
                <strong>{m.recuperacao.posCompra.enviados}</strong> e-mails a {m.recuperacao.posCompra.pessoas} comprador(es) · <strong>{m.recuperacao.posCompra.taxaAbertura}%</strong> abertos · <strong>{m.recuperacao.posCompra.taxaClique}%</strong> clicaram
              </div>
              <div className="stat-hint">{m.recuperacao.posCompra.compras} compras entraram no fluxo · {m.recuperacao.posCompra.bounces} voltaram</div>
            </div>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Recebidas</div>
          <div className="stat-value">{m?.recebidas ?? "–"}</div>
          <div className="stat-hint">no período</div>
        </div>
        <div className="stat">
          <div className="stat-label">Atendidas</div>
          <div className="stat-value">{m?.atendidas ?? "–"}</div>
          <div className="stat-hint">{m ? `${m.atendidasIA} pela IA · ${m.atendidasHumano} por você` : ""}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Automação</div>
          <div className="stat-value" style={{ color: "var(--accent)" }}>{m ? `${m.automacao}%` : "–"}</div>
          <div className="stat-hint">respostas enviadas pela IA</div>
        </div>
        <div className="stat">
          <div className="stat-label">Sucesso</div>
          <div className="stat-value" style={{ color: m && m.sucesso > 0 ? "var(--ok)" : "var(--danger)" }}>{m ? `${m.sucesso}%` : "–"}</div>
          <div className="stat-hint">resolvidas sem humano</div>
        </div>
        <Link href="/tickets" className="stat" style={{ textDecoration: "none" }}>
          <div className="stat-label">Tickets</div>
          <div className="stat-value" style={{ color: "var(--warn)" }}>{m?.tickets.pendentes ?? "–"}</div>
          <div className="stat-hint">aguardando você{m && m.tickets.reabertos > 0 ? ` · ${m.tickets.reabertos} reabertos` : ""}</div>
        </Link>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <strong>Volume de e-mails</strong>
            <span className="badge badge-accent" style={{ marginLeft: "0.5rem" }}>{PERIODS.find((p) => p.days === days)?.label}</span>
          </div>
          <span className="hint">recebidos × respondidos por dia</span>
        </div>
        <div style={{ height: 220, marginTop: "1rem" }}>
          {m && m.recebidas + m.atendidas === 0 ? (
            <div className="empty">Nenhum e-mail no período.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} barGap={2}>
                <CartesianGrid vertical={false} stroke="#eef0f4" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={days > 30 ? 6 : 0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                <Tooltip cursor={{ fill: "#f3f4f6" }} />
                <Bar dataKey="recebidas" name="Recebidos" fill="#c7d2fe" radius={[4, 4, 0, 0]} />
                <Bar dataKey="respondidas" name="Respondidos" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem", padding: 0, overflow: "hidden" }}>
        <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <strong>Por dia</strong>
          <span className="hint">recebidos · respondidos (IA + você)</span>
        </div>
        <div style={{ maxHeight: "16rem", overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Dia</th>
                <th>Recebidos</th>
                <th>Respondidos</th>
                <th>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {[...(m?.porDia ?? [])].reverse().filter((d) => d.recebidas + d.respondidas > 0).map((d) => (
                <tr key={d.dia}>
                  <td>{d.dia.slice(8, 10)}/{d.dia.slice(5, 7)}</td>
                  <td>{d.recebidas}</td>
                  <td>{d.respondidas}</td>
                  <td style={{ color: d.respondidas >= d.recebidas ? "var(--ok)" : "var(--warn)" }}>{d.respondidas - d.recebidas}</td>
                </tr>
              ))}
              {(m?.porDia ?? []).every((d) => d.recebidas + d.respondidas === 0) && (
                <tr><td colSpan={4} className="hint">Nenhum e-mail no período.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden", margin: 0 }}>
          <div className="toolbar" style={{ padding: "0.875rem 1rem", margin: 0, borderBottom: "1px solid var(--border)" }}>
            <strong>Inbox</strong>
            <div className="tabs">
              <button type="button" className={`tab${tab === "conversas" ? " active" : ""}`} onClick={() => setTab("conversas")}>
                Conversas
              </button>
              <button type="button" className={`tab${tab === "spam" ? " active" : ""}`} onClick={() => setTab("spam")}>
                Spam ({m?.spam ?? 0})
              </button>
            </div>
            <Link href="/inbox" className="btn btn-sm" style={{ marginLeft: "auto" }}>
              Abrir Inbox
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="empty">Nada por aqui.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Loja</th>
                  <th>Cliente</th>
                  <th>Assunto</th>
                  <th>Categoria</th>
                  <th>Status</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => (window.location.href = `/inbox?status=${tab}&c=${r.id}`)}>
                    <td>{r.stores?.name}</td>
                    <td>{r.customers?.email}</td>
                    <td>{r.subject || "(sem assunto)"}</td>
                    <td>{r.category ? <span className="badge badge-accent">{CATEGORY_LABEL[r.category] ?? r.category}</span> : "—"}</td>
                    <td>
                      <span className={`badge ${STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    </td>
                    <td className="hint">{fmtWhen(r.last_message_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div className="section-title">Conversas por categoria</div>
          {totalCat === 0 && <p className="hint">Nenhuma conversa no período.</p>}
          {Object.entries(m?.categorias ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([cat, n]) => (
              <div key={cat} style={{ marginBottom: "0.625rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8125rem" }}>
                  <span>{CATEGORY_LABEL[cat] ?? cat}</span>
                  <span style={{ fontWeight: 600 }}>
                    {n} <span className="hint">({Math.round((n / totalCat) * 100)}%)</span>
                  </span>
                </div>
                <div style={{ height: 6, background: "#eef0f4", borderRadius: 999, marginTop: 4 }}>
                  <div style={{ width: `${(n / totalCat) * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 999 }} />
                </div>
              </div>
            ))}
        </div>
      </div>
    </Shell>
  );
}
