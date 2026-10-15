"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import ProductsPanel from "@/components/ProductsPanel";
import { CATEGORY_LABEL, fmtDateTime } from "@/lib/ui/labels";

interface Store {
  id: string;
  name: string;
  agent_name: string | null;
  delivery_days_max: number | null;
  auto_send_categories: string[] | null;
  signature: string | null;
  aliases?: string[] | null;
  auto_ack?: boolean;
}

interface Account {
  id: string;
  provider: string;
  email_address: string;
  connected_at: string | null;
  last_synced_at: string | null;
  last_uid: number;
  sent_folder: string | null;
  sent_last_uid: number;
  last_error: string | null;
}

interface AckLogRow {
  id: string;
  to_address: string;
  customer_name: string | null;
  brand: string;
  language: string;
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
}

interface Tone {
  style_summary: string;
  based_on_email_count: number;
  generated_at: string;
  example_snippets: { examples?: string[]; signature?: string | null } | null;
}

interface Order {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  lineItems: Array<{ title: string; quantity: number }>;
}

const PROVIDERS = [
  ["gmail", "Gmail / Google Workspace"],
  ["outlook", "Outlook / Microsoft 365"],
  ["zoho", "Zoho"],
  ["titan", "Titan"],
  ["hostinger", "Hostinger"],
  ["locaweb", "Locaweb"],
  ["hostgator", "HostGator"],
  ["godaddy", "GoDaddy"],
  ["kinghost", "KingHost"],
  ["migadu", "Migadu"],
  ["manual", "Outro (manual)"],
];

const AUTO_CATS = ["rastreio", "duvidas_gerais", "edicao_pedido", "outro", "reclamacao"];

export default function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [store, setStore] = useState<Store | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [shopify, setShopify] = useState<{ shop_domain: string; connected_at: string | null } | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const [signature, setSignature] = useState("");
  const [agentName, setAgentName] = useState("");
  const [deliveryDays, setDeliveryDays] = useState("");
  const [autoCats, setAutoCats] = useState<string[]>([]);
  const [aliases, setAliases] = useState("");
  const [autoAck, setAutoAck] = useState(false);
  const [autoReceipt, setAutoReceipt] = useState(false);
  const [ackLog, setAckLog] = useState<{ rows: AckLogRow[]; sent: number; failed: number } | null>(null);
  const [ackLogError, setAckLogError] = useState("");

  const [shopDomain, setShopDomain] = useState("");
  const [shopToken, setShopToken] = useState("");
  const [shopMode, setShopMode] = useState<"client" | "token">("client");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testOrders, setTestOrders] = useState<Order[] | null>(null);

  const [provider, setProvider] = useState("gmail");

  async function load() {
    const r = await fetch(`/api/stores/${id}`);
    const d = await r.json();
    setStore(d.store);
    setAccounts(d.accounts ?? []);
    setShopify(d.shopify);
    setTone(d.tone);
    setSignature(d.store?.signature ?? "");
    setAgentName(d.store?.agent_name ?? "");
    setDeliveryDays(d.store?.delivery_days_max ? String(d.store.delivery_days_max) : "");
    setAutoCats(d.store?.auto_send_categories ?? []);
    setAliases((d.store?.aliases ?? []).join(", "));
    setAutoAck(Boolean(d.store?.auto_ack));
    setAutoReceipt(Boolean(d.store?.auto_receipt));
    if (d.shopify?.shop_domain) setShopDomain(d.shopify.shop_domain);
  }

  async function loadAckLog() {
    const r = await fetch(`/api/stores/${id}/auto-ack-log`);
    const d = await r.json();
    if (!r.ok) {
      setAckLogError(d.error ?? "Erro ao carregar logs.");
      return;
    }
    setAckLogError("");
    setAckLog(d);
  }

  useEffect(() => {
    load();
    loadAckLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function setB(k: string, v: boolean) {
    setBusy((b) => ({ ...b, [k]: v }));
  }
  function setM(k: string, v: string) {
    setMsg((m) => ({ ...m, [k]: v }));
  }

  async function saveSettings() {
    setB("settings", true);
    const r = await fetch(`/api/stores/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, agent_name: agentName, delivery_days_max: deliveryDays ? Number(deliveryDays) : null, auto_send_categories: autoCats, aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean), auto_ack: autoAck, auto_receipt: autoReceipt }),
    });
    const d = await r.json().catch(() => ({}));
    setB("settings", false);
    setM("settings", r.ok ? "Salvo." : d.error ?? "Erro ao salvar.");
  }

  async function connectShopify(e: React.FormEvent) {
    e.preventDefault();
    setB("shopify", true);
    setM("shopify", "");
    const r = await fetch(`/api/stores/${id}/shopify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shopMode === "token" ? { shopDomain, accessToken: shopToken } : { shopDomain, clientId, clientSecret }),
    });
    const d = await r.json();
    setB("shopify", false);
    if (!r.ok) {
      setM("shopify", d.error);
      return;
    }
    setShopToken("");
    setClientSecret("");
    setM("shopify", `Conectado à loja "${d.shopName}" — ${d.ordersVisible} pedido(s) recentes visíveis.`);
    load();
  }

  async function testShopify() {
    setB("test", true);
    setTestOrders(null);
    const r = await fetch(`/api/stores/${id}/shopify`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: testEmail }) });
    const d = await r.json();
    setB("test", false);
    if (!r.ok) {
      setM("test", d.error);
      return;
    }
    setM("test", d.orders.length === 0 ? "Nenhum pedido pra esse e-mail." : "");
    setTestOrders(d.orders);
  }

  async function connectEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setB("email", true);
    setM("email", "");
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    const r = await fetch(`/api/stores/${id}/email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    setB("email", false);
    if (!r.ok) {
      setM("email", d.error ?? "Erro.");
      return;
    }
    form.reset();
    setM("email", "Caixa conectada. Clique em Sincronizar agora.");
    load();
  }

  async function syncNow(skipAnalysis = false) {
    setB("sync", true);
    setM("sync", "Sincronizando (pode levar até alguns minutos)...");
    const r = await fetch(`/api/stores/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analyzeLimit: 8, skipAnalysis }) });
    const d = await r.json();
    setB("sync", false);
    if (!r.ok) {
      setM("sync", d.error ?? "Erro.");
      return;
    }
    const res = d.results ?? [];
    setM(
      "sync",
      res
        .map((x: any) =>
          x.error
            ? `${x.account}: ERRO ${x.error}`
            : `${x.account}: +${x.inbound} recebidos, +${x.sent} enviados importados${x.remaining ? `, ${x.remaining} ainda na fila` : ""} · ${x.analyzed} analisadas${x.autoSent ? `, ${x.autoSent} enviadas automaticamente` : ""}${x.errors ? `, ${x.errors} erro(s)` : ""} · tom: ${x.tone ?? "-"}`
        )
        .join("\n")
    );
    load();
  }

  async function relearnTone() {
    setB("tone", true);
    setM("tone", "");
    const r = await fetch(`/api/stores/${id}/tone`, { method: "POST" });
    const d = await r.json();
    setB("tone", false);
    if (!r.ok) {
      setM("tone", d.error);
      return;
    }
    setM("tone", d.result.status === "insufficient" ? `Ainda poucas respostas suas importadas (${d.result.basedOn}). Sincronize a caixa primeiro.` : `Tom reaprendido com ${d.result.basedOn} respostas.`);
    setTone(d.tone ? { style_summary: d.tone.styleSummary, based_on_email_count: d.tone.basedOn, generated_at: d.tone.generatedAt, example_snippets: { examples: d.tone.examples, signature: d.tone.signature } } : null);
  }

  async function reprocess() {
    if (!confirm("Isso apaga todas as conversas e análises dessa loja no painel (os e-mails continuam na caixa) e reimporta os últimos 90 dias com o pipeline novo. Nada é enviado ao cliente. Continuar?")) return;
    setB("reprocess", true);
    const r = await fetch(`/api/stores/${id}/reprocess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "REPROCESSAR" }) });
    const d = await r.json();
    setB("reprocess", false);
    setM("reprocess", r.ok ? `${d.removed} conversa(s) apagadas. Agora clique em Sincronizar agora (repita até "0 na fila").` : d.error);
    load();
  }

  if (!store) {
    return (
      <Shell>
        <p className="hint">Carregando...</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <Link href="/lojas" className="hint" style={{ textDecoration: "none" }}>
        ← Minhas lojas
      </Link>
      <h1 className="page-title" style={{ marginTop: "0.5rem" }}>{store.name}</h1>
      <p className="page-sub">Conexões, tom de voz e regras de envio dessa loja.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
        <div>
          <div className="card" style={{ margin: 0 }}>
            <div className="section-title">1. Caixa de e-mail</div>
            {accounts.map((a) => (
              <div key={a.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: "0.75rem", marginBottom: "0.75rem" }}>
                <strong>{a.email_address}</strong> <span className="badge badge-ok">{a.provider}</span>
                <div className="hint" style={{ marginTop: "0.25rem" }}>
                  Última sincronização: {a.last_synced_at ? fmtDateTime(a.last_synced_at) : "nunca"} · Enviados: {a.sent_folder ?? "detectar no próximo ciclo"}
                </div>
                {a.last_error && <div className="hint" style={{ color: "var(--danger)" }}>Último erro: {a.last_error}</div>}
              </div>
            ))}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" onClick={() => syncNow(false)} disabled={busy.sync || accounts.length === 0}>
                {busy.sync ? "Sincronizando..." : "Sincronizar agora"}
              </button>
              <button type="button" className="btn" onClick={() => syncNow(true)} disabled={busy.sync || accounts.length === 0}>
                Só importar (sem IA)
              </button>
            </div>
            {msg.sync && <pre className="hint" style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem", fontFamily: "inherit" }}>{msg.sync}</pre>}

            <details style={{ marginTop: "1rem" }}>
              <summary className="hint" style={{ cursor: "pointer" }}>Conectar outra caixa</summary>
              <form onSubmit={connectEmail} style={{ marginTop: "0.75rem" }}>
                <div className="field">
                  <label>Provedor</label>
                  <select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                    {PROVIDERS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>E-mail</label>
                  <input name="emailAddress" type="email" required />
                </div>
                <div className="field">
                  <label>Senha de app (Gmail/Outlook) ou senha da caixa (Hostinger etc.)</label>
                  <input name="emailPassword" type="password" required />
                </div>
                {provider === "manual" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    <div className="field"><label>Host IMAP</label><input name="imapHost" required /></div>
                    <div className="field"><label>Porta IMAP</label><input name="imapPort" type="number" defaultValue={993} /></div>
                    <div className="field"><label>Host SMTP</label><input name="smtpHost" required /></div>
                    <div className="field"><label>Porta SMTP</label><input name="smtpPort" type="number" defaultValue={465} /></div>
                  </div>
                )}
                <button type="submit" className="btn btn-primary" disabled={busy.email}>{busy.email ? "Conectando..." : "Conectar"}</button>
                {msg.email && <p className="hint" style={{ marginTop: "0.5rem" }}>{msg.email}</p>}
              </form>
            </details>
          </div>

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="section-title">2. Shopify {shopify?.connected_at ? <span className="badge badge-ok">conectada · {shopify.shop_domain}</span> : <span className="badge badge-danger">não conectada</span>}</div>
            <p className="hint" style={{ marginBottom: "0.75rem" }}>
              Sem isso a IA não enxerga pedido, pagamento nem envio. App no Dev Dashboard (dev.shopify.com): scopes read_orders, read_all_orders, read_customers, read_fulfillments, read_products → Release → Distribution → instalar na loja → App settings → Client ID e Client secret. Ou um custom app do admin com token shpat_.
            </p>
            <div className="tabs" style={{ marginBottom: "0.75rem" }}>
              <button type="button" className={`tab${shopMode === "client" ? " active" : ""}`} onClick={() => setShopMode("client")}>Client ID + secret</button>
              <button type="button" className={`tab${shopMode === "token" ? " active" : ""}`} onClick={() => setShopMode("token")}>Token shpat_</button>
            </div>
            <form onSubmit={connectShopify}>
              <div className="field">
                <label>Domínio da loja</label>
                <input value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="minha-loja.myshopify.com" required />
              </div>
              {shopMode === "client" ? (
                <>
                  <div className="field">
                    <label>Client ID</label>
                    <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID do app" required />
                  </div>
                  <div className="field">
                    <label>Client secret</label>
                    <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" placeholder="Client secret do app" required />
                    <span className="hint">O token de acesso é gerado e renovado automaticamente a cada 24h.</span>
                  </div>
                </>
              ) : (
                <div className="field">
                  <label>Token de acesso da Admin API</label>
                  <input value={shopToken} onChange={(e) => setShopToken(e.target.value)} type="password" placeholder="shpat_..." required />
                </div>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy.shopify}>{busy.shopify ? "Validando..." : shopify ? "Reconectar" : "Conectar Shopify"}</button>
              {msg.shopify && <p className="hint" style={{ marginTop: "0.5rem", color: msg.shopify.startsWith("Conectado") ? "var(--ok)" : "var(--danger)" }}>{msg.shopify}</p>}
            </form>
            {shopify?.connected_at && (
              <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
                <div className="hint" style={{ marginBottom: "0.375rem" }}>Provar com um cliente real:</div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="e-mail de um cliente" />
                  <button type="button" className="btn" onClick={testShopify} disabled={busy.test || !testEmail}>{busy.test ? "Buscando..." : "Buscar pedidos"}</button>
                </div>
                {msg.test && <p className="hint" style={{ marginTop: "0.5rem" }}>{msg.test}</p>}
                {testOrders?.map((o) => (
                  <div key={o.name} className="hint" style={{ marginTop: "0.5rem" }}>
                    <strong>{o.name}</strong> · {new Date(o.createdAt).toLocaleDateString("pt-BR")} · {o.financialStatus} / {o.fulfillmentStatus} · {o.lineItems.map((li) => `${li.quantity}x ${li.title}`).join(", ")}
                    {o.trackingNumber ? ` · rastreio ${o.trackingNumber}` : " · sem rastreio"}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="card" style={{ margin: 0 }}>
            <div className="section-title">3. Tom de voz (aprendido dos seus Enviados)</div>
            {tone ? (
              <>
                <p style={{ fontSize: "0.8125rem", whiteSpace: "pre-wrap" }}>{tone.style_summary}</p>
                <p className="hint">Baseado em {tone.based_on_email_count} respostas · {fmtDateTime(tone.generated_at)}{tone.example_snippets?.signature ? ` · assinatura detectada: "${tone.example_snippets.signature}"` : ""}</p>
                <details>
                  <summary className="hint" style={{ cursor: "pointer" }}>Ver exemplos usados ({tone.example_snippets?.examples?.length ?? 0})</summary>
                  {(tone.example_snippets?.examples ?? []).map((ex, i) => (
                    <pre key={i} className="hint" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", borderLeft: "2px solid var(--border)", paddingLeft: "0.5rem", marginTop: "0.5rem" }}>{ex}</pre>
                  ))}
                </details>
              </>
            ) : (
              <p className="hint">Ainda não aprendido. Sincronize a caixa (importa os Enviados) e clique abaixo.</p>
            )}
            <button type="button" className="btn" onClick={relearnTone} disabled={busy.tone} style={{ marginTop: "0.75rem" }}>{busy.tone ? "Lendo suas respostas..." : "Reaprender tom agora"}</button>
            {msg.tone && <p className="hint" style={{ marginTop: "0.5rem" }}>{msg.tone}</p>}
          </div>

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="section-title">4. Regras de envio</div>
            <div className="field">
              <label>Envio automático (sem passar por você) — por categoria</label>
              <div className="chip-group">
                {AUTO_CATS.map((c) => (
                  <button key={c} type="button" className={`chip${autoCats.includes(c) ? " on" : ""}`} onClick={() => setAutoCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}>
                    {CATEGORY_LABEL[c]}
                  </button>
                ))}
              </div>
              <span className="hint">Reembolso, ameaça e raiva 5 nunca saem sozinhos. Nada marcado = tudo passa por você (modo revisão).</span>
            </div>
            <div className="field">
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input type="checkbox" checked={autoReceipt} onChange={(e) => setAutoReceipt(e.target.checked)} />
                Comprovante de compra automático (e-mail de agradecimento da 1ª compra)
              </label>
              <span className="hint">Sai sozinho pra cada compra inicial feita DEPOIS de ligar aqui (pedidos antigos não recebem). Limite de um comprovante por e-mail de cliente, travado no banco. Acompanhe em Entregabilidade.</span>
            </div>
            <div className="field">
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input type="checkbox" checked={autoAck} onChange={(e) => setAutoAck(e.target.checked)} />
                Aviso automático de recebimento (genérico, "já chegou e vamos responder")
              </label>
              <span className="hint">Manda na hora, só na 1ª mensagem de um cliente novo — texto fixo, não é o rascunho da IA. Continua desligado até você testar e ativar aqui.</span>
              {ackLogError ? (
                <span className="hint" style={{ color: "#b91c1c" }}>{ackLogError}</span>
              ) : ackLog ? (
                <div style={{ marginTop: "0.75rem" }}>
                  <span className="hint">Logs do aviso automático: {ackLog.sent} enviado(s), {ackLog.failed} falhou(aram) (últimos 50).</span>
                  {ackLog.rows.length > 0 && (
                    <table style={{ width: "100%", fontSize: "0.82rem", marginTop: "0.4rem", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "#6b7280" }}>
                          <th style={{ padding: "3px 6px" }}>Quando</th>
                          <th style={{ padding: "3px 6px" }}>Pra quem</th>
                          <th style={{ padding: "3px 6px" }}>Marca</th>
                          <th style={{ padding: "3px 6px" }}>Idioma</th>
                          <th style={{ padding: "3px 6px" }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ackLog.rows.map((r) => (
                          <tr key={r.id} style={{ borderTop: "1px solid #eceef2" }}>
                            <td style={{ padding: "3px 6px" }}>{fmtDateTime(r.created_at)}</td>
                            <td style={{ padding: "3px 6px" }}>{r.customer_name ? `${r.customer_name} · ` : ""}{r.to_address}</td>
                            <td style={{ padding: "3px 6px" }}>{r.brand}</td>
                            <td style={{ padding: "3px 6px" }}>{r.language}</td>
                            <td style={{ padding: "3px 6px", color: r.status === "sent" ? "#0f7a5c" : "#b91c1c" }} title={r.error ?? ""}>{r.status === "sent" ? "enviado" : "falhou"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </div>
            <div className="field">
              <label>Assinatura (deixe vazio pra usar a detectada nos Enviados)</label>
              <textarea rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Ex: Marie\nÉquipe OstéoPure"} />
            </div>
            <div className="field">
              <label>Endereços desta marca (aliases, separados por vírgula)</label>
              <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="support@olavita.co.il, contact@olavita.com" />
              <span className="hint">Numa caixa compartilhada, e-mails enviados pra esses endereços viram conversas desta loja (contexto, tom e assinatura próprios). Precisa da migration 0010.</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <div className="field">
                <label>Quem assina</label>
                <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="opcional" />
              </div>
              <div className="field">
                <label>Prazo máximo de entrega (dias)</label>
                <input type="number" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} placeholder="ex: 12" />
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={busy.settings}>{busy.settings ? "Salvando..." : "Salvar"}</button>
            {msg.settings && <span className="hint" style={{ marginLeft: "0.5rem" }}>{msg.settings}</span>}
          </div>

          <ProductsPanel storeId={id} />

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="section-title">5. Reprocessar histórico</div>
            <p className="hint" style={{ marginBottom: "0.75rem" }}>Apaga o que a IA gerou pra essa loja no painel e reimporta os últimos 90 dias (INBOX + Enviados) com Shopify e tom já conectados. Nada é enviado ao cliente.</p>
            <button type="button" className="btn btn-danger" style={{ border: "1px solid var(--border)" }} onClick={reprocess} disabled={busy.reprocess}>{busy.reprocess ? "Apagando..." : "Reprocessar histórico"}</button>
            {msg.reprocess && <p className="hint" style={{ marginTop: "0.5rem" }}>{msg.reprocess}</p>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
