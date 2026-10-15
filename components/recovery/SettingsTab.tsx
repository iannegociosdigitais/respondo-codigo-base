"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecoverySettings } from "@/lib/recovery/types";
import { api, ApiError, MigrationWarning, ErrorBox, errorMessage, Notice, Switch, Field, SectionTitle, num } from "./shared";
import SessionsPanel from "./SessionsPanel";
import DiscountsPanel from "./DiscountsPanel";
import KnowledgePanel from "./KnowledgePanel";

// Aba Configuração: chaves da régua, remetente, agente, tetos, horário,
// números de WhatsApp, cupons, conhecimento e "Rodar a régua agora".

interface SettingsData {
  settings: RecoverySettings;
  store: { id: string; name: string } | null;
  providers: { resend: boolean; ses: boolean; activecampaign?: boolean; waha: boolean };
}

type Form = Pick<RecoverySettings, "enabled" | "email_enabled" | "whatsapp_enabled" | "agent_enabled" | "test_mode" | "test_email" | "test_phone" | "require_consent" | "from_name" | "from_email" | "reply_to" | "agent_name" | "agent_prompt" | "agent_max_discount" | "daily_cap_email" | "daily_cap_whatsapp" | "max_days" | "quiet_hours" | "welcome_enabled" | "welcome_skip_first_if_receipt" | "contact_url" | "email_provider" | "min_gap_hours">;

const FORM_KEYS: Array<keyof Form> = ["enabled", "email_enabled", "whatsapp_enabled", "agent_enabled", "test_mode", "test_email", "test_phone", "require_consent", "from_name", "from_email", "reply_to", "agent_name", "agent_prompt", "agent_max_discount", "daily_cap_email", "daily_cap_whatsapp", "max_days", "quiet_hours", "welcome_enabled", "welcome_skip_first_if_receipt", "contact_url", "email_provider", "min_gap_hours"];

function toForm(s: Partial<RecoverySettings>): Form {
  return {
    enabled: Boolean(s.enabled),
    email_enabled: Boolean(s.email_enabled),
    whatsapp_enabled: Boolean(s.whatsapp_enabled),
    agent_enabled: Boolean(s.agent_enabled),
    test_mode: s.test_mode ?? true,
    test_email: s.test_email ?? "",
    test_phone: s.test_phone ?? "",
    require_consent: Boolean(s.require_consent),
    from_name: s.from_name ?? "",
    from_email: s.from_email ?? "",
    reply_to: s.reply_to ?? "",
    agent_name: s.agent_name ?? "",
    agent_prompt: s.agent_prompt ?? "",
    agent_max_discount: num(s.agent_max_discount, 15),
    daily_cap_email: num(s.daily_cap_email, 100),
    daily_cap_whatsapp: num(s.daily_cap_whatsapp, 30),
    max_days: num(s.max_days, 10),
    quiet_hours: { start: num(s.quiet_hours?.start, 9), end: num(s.quiet_hours?.end, 21), shabbat: s.quiet_hours?.shabbat ?? false, ...(s.quiet_hours?.tz ? { tz: s.quiet_hours.tz } : {}) },
    welcome_enabled: Boolean(s.welcome_enabled),
    welcome_skip_first_if_receipt: s.welcome_skip_first_if_receipt ?? true,
    contact_url: s.contact_url ?? "",
    email_provider: s.email_provider === "ses" ? "ses" : s.email_provider === "activecampaign" ? "activecampaign" : "resend",
    min_gap_hours: num(s.min_gap_hours, 2),
  };
}

interface TickResult {
  skipped?: string; synced?: number; scheduled?: number; sent?: { email?: number; whatsapp?: number }; skippedCount?: number; stopped?: number; errors?: string[];
  welcome?: { created?: number; sent?: number; skipped?: number; stopped?: number };
  // Spec v2: ciclo cortado pelo prazo, saúde do e-mail por loja e lojas com e-mail desligado.
  partial?: boolean;
  health?: Array<{ storeId: string; action: "ok" | "pausar" | "alertar"; reason: string | null; sent24h: number }>;
  pausedEmail?: string[];
  watchdog?: { ping?: string; sessions?: Array<{ name: string; status: string | null; changed: boolean }>; alertsCreated?: number; alertsResolved?: number };
}

const PROVIDERS: Array<{ key: "resend" | "ses" | "activecampaign"; label: string; env: string }> = [
  { key: "activecampaign", label: "ActiveCampaign", env: "ACTIVECAMPAIGN_API_URL + ACTIVECAMPAIGN_API_KEY" },
  { key: "resend", label: "Resend", env: "RESEND_API_KEY" },
  { key: "ses", label: "Amazon SES", env: "AWS_SES_REGION + credenciais AWS" },
];

// Mesmo critério do servidor (EMAIL_RE em _lib/shared.ts).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// onDirtyChange: avisa a página quando há alterações não salvas (a página
// pede confirmação antes de trocar de loja ou de aba).
export default function SettingsTab({ storeId, onDirtyChange }: { storeId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  // 409 ao desligar o modo de teste: o que falta no remetente (DNS etc.).
  const [problems, setProblems] = useState<string[]>([]);
  const [neededDns, setNeededDns] = useState<Array<{ type: string; name: string; value: string; note: string }>>([]);
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tick, setTick] = useState<{ running: boolean; result: TickResult | null; raw: string; error: string; showRaw: boolean }>({ running: false, result: null, raw: "", error: "", showRaw: false });
  // Erros por campo (validação antes de enviar).
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"test_email" | "from_email" | "reply_to", string>>>({});
  // Contadores de sequência: resposta atrasada de outra loja/carregamento é ignorada.
  const loadSeq = useRef(0);
  const ctxSeq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++loadSeq.current;
    setError("");
    setMigrationMissing(false);
    try {
      const d = await api<Partial<SettingsData>>(`/api/recovery/settings?store=${encodeURIComponent(storeId)}`);
      if (mySeq !== loadSeq.current) return; // resposta velha (trocou de loja)
      if (!d.settings) throw new ApiError("Configuração sem dados.", 500);
      setData({ settings: d.settings, store: d.store ?? null, providers: { resend: Boolean(d.providers?.resend), ses: Boolean(d.providers?.ses), activecampaign: Boolean(d.providers?.activecampaign), waha: Boolean(d.providers?.waha) } });
      const f = toForm(d.settings);
      setForm(f);
      setSaved(JSON.stringify(f));
    } catch (e) {
      if (mySeq !== loadSeq.current) return;
      if (e instanceof ApiError && e.migrationMissing) setMigrationMissing(true);
      else setError(errorMessage(e));
    }
  }, [storeId]);

  useEffect(() => {
    ctxSeq.current += 1; // salvar/rodar em andamento da loja anterior não mexe mais na tela
    setData(null);
    setForm(null);
    setWarnings([]);
    setProblems([]);
    setNeededDns([]);
    setFieldErrors({});
    setTick({ running: false, result: null, raw: "", error: "", showRaw: false });
    setNotice(null);
    load();
  }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = form ? JSON.stringify(form) !== saved : false;

  // Avisa a página das alterações não salvas (e zera ao sair da aba).
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  async function save() {
    if (!form) return;
    // Validação no navegador (o servidor recusa com 400 e-mail vazio/inválido).
    const errs: typeof fieldErrors = {};
    const testEmail = form.test_email.trim();
    if (testEmail && !EMAIL_RE.test(testEmail)) errs.test_email = "E-mail de teste inválido.";
    const fromEmail = (form.from_email ?? "").trim();
    if (fromEmail && !EMAIL_RE.test(fromEmail)) errs.from_email = "E-mail do remetente inválido.";
    const replyTo = (form.reply_to ?? "").trim();
    if (replyTo && !EMAIL_RE.test(replyTo)) errs.reply_to = "Reply-to inválido.";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setNotice({ kind: "err", text: "Corrija os campos marcados em vermelho. Nada foi salvo." });
      return;
    }
    // Saída do modo de teste: confirmação explícita (só o banner não basta).
    if (!form.test_mode && data?.settings.test_mode !== false) {
      const ok = window.confirm(
        `Desligar o modo de teste${form.enabled ? " com a régua LIGADA" : ""}?\n\nDepois de salvar, clientes reais passam a receber e-mail/WhatsApp desta loja (só carrinhos abandonados a partir de agora). Continuar?`
      );
      if (!ok) return;
    }
    const myCtx = ctxSeq.current;
    setSaving(true);
    setNotice(null);
    setWarnings([]);
    setProblems([]);
    setNeededDns([]);
    try {
      const payload: Record<string, unknown> = {};
      for (const k of FORM_KEYS) payload[k] = form[k];
      // O servidor recusa test_email vazio (400): vazio = não mexe no que está salvo.
      if (testEmail) payload.test_email = testEmail;
      else delete payload.test_email;
      payload.test_phone = form.test_phone?.trim() || null;
      payload.from_name = form.from_name?.trim() || null;
      payload.from_email = form.from_email?.trim() || null;
      payload.reply_to = form.reply_to?.trim() || null;
      payload.agent_name = form.agent_name?.trim() || null;
      payload.agent_prompt = form.agent_prompt?.trim() || null;
      payload.contact_url = form.contact_url?.trim() || null;
      payload.daily_cap_email = Math.max(0, Math.round(form.daily_cap_email));
      payload.daily_cap_whatsapp = Math.max(0, Math.round(form.daily_cap_whatsapp));
      payload.max_days = Math.min(60, Math.max(1, Math.round(form.max_days)));
      payload.min_gap_hours = Math.min(168, Math.max(1, Math.round(form.min_gap_hours)));
      const d = await api<{ settings?: RecoverySettings; warnings?: string[]; providers?: SettingsData["providers"] }>(`/api/recovery/settings?store=${encodeURIComponent(storeId)}`, { method: "PUT", json: payload });
      if (myCtx !== ctxSeq.current) return; // trocou de loja durante o salvamento
      if (d.settings) {
        const f = toForm(d.settings);
        setForm(f);
        setSaved(JSON.stringify(f));
        setData((prev) => (prev ? { ...prev, settings: d.settings as RecoverySettings, providers: d.providers ? { resend: Boolean(d.providers.resend), ses: Boolean(d.providers.ses), activecampaign: Boolean(d.providers.activecampaign), waha: Boolean(d.providers.waha) } : prev.providers } : prev));
      } else {
        setSaved(JSON.stringify(form));
      }
      setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
      setNotice({ kind: "ok", text: "Configuração salva." });
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      setNotice({ kind: "err", text: errorMessage(e) });
      if (e instanceof ApiError && e.status === 400) {
        // Mostra o erro no campo que o servidor citou (test_email/from_email/reply_to).
        const field = (["test_email", "from_email", "reply_to"] as const).find((f) => e.message.includes(f));
        if (field) setFieldErrors({ [field]: e.message });
      }
      // 409: o servidor recusou desligar o modo de teste e NADA foi salvo.
      if (e instanceof ApiError && e.status === 409) {
        const list = Array.isArray(e.details.problems) ? (e.details.problems as unknown[]).map(String) : [];
        setProblems(list.length ? list : [e.message]);
        const needed = Array.isArray(e.details.needed) ? (e.details.needed as Array<{ type?: string; name?: string; value?: string; note?: string }>) : [];
        setNeededDns(needed.filter((n) => n && n.name).map((n) => ({ type: String(n.type ?? ""), name: String(n.name ?? ""), value: String(n.value ?? ""), note: String(n.note ?? "") })));
      }
    } finally {
      if (myCtx === ctxSeq.current) setSaving(false);
    }
  }

  // Roda UM ciclo só desta loja (?store=). Em produção (régua ligada e modo de
  // teste desligado) o ciclo envia de verdade: pede confirmação.
  async function runTick() {
    const live = Boolean(data?.settings.enabled) && data?.settings.test_mode === false;
    const storeName = data?.store?.name ?? "esta loja";
    const msg = live
      ? `${storeName} está EM PRODUÇÃO (régua ligada e modo de teste desligado).\n\n"Rodar a régua agora" vai ENVIAR DE VERDADE e-mails/WhatsApp para clientes reais que estiverem na hora.${dirty ? "\n\nAs alterações não salvas desta tela não valem para este ciclo." : ""}\n\nRodar mesmo assim?`
      : `Rodar um ciclo da régua só para ${storeName}? Em modo de teste, tudo vai para os destinos de teste.${dirty ? "\n\nAs alterações não salvas desta tela não valem para este ciclo." : ""}`;
    if (!window.confirm(msg)) return;
    const myCtx = ctxSeq.current;
    setTick((t) => ({ ...t, running: true, error: "", result: null, raw: "" }));
    try {
      const d = await api<TickResult>(`/api/recovery/tick?store=${encodeURIComponent(storeId)}`, { method: "POST", json: {} });
      if (myCtx !== ctxSeq.current) return;
      setTick((t) => ({ ...t, running: false, result: d, raw: JSON.stringify(d, null, 2) }));
    } catch (e) {
      if (myCtx !== ctxSeq.current) return;
      setTick((t) => ({ ...t, running: false, error: errorMessage(e) }));
    }
  }

  if (migrationMissing) return <MigrationWarning />;
  if (error && !form) return <ErrorBox text={error} />;
  if (!form || !data) return <div className="empty">Carregando…</div>;

  const liveWarning = !form.test_mode && form.enabled;

  return (
    <>
      <ErrorBox text={error} onClose={() => setError("")} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", alignItems: "center" }}>
          <span className="hint">Provedores:</span>
          {data.providers.resend ? <span className="badge badge-ok">RESEND configurado</span> : <span className={`badge ${form.email_provider === "resend" ? "badge-danger" : ""}`}>sem RESEND_API_KEY</span>}
          {data.providers.ses ? <span className="badge badge-ok">SES configurado</span> : <span className={`badge ${form.email_provider === "ses" ? "badge-danger" : ""}`}>sem Amazon SES</span>}
          {data.providers.activecampaign ? <span className="badge badge-ok">ActiveCampaign configurado</span> : <span className={`badge ${form.email_provider === "activecampaign" ? "badge-danger" : ""}`}>sem ActiveCampaign</span>}
          {data.providers.waha ? <span className="badge badge-ok">WAHA configurado</span> : <span className="badge badge-danger">sem WAHA_URL</span>}
          {data.settings.last_tick_at && <span className="hint">· último tick {new Date(data.settings.last_tick_at).toLocaleString("pt-BR")}</span>}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Notice notice={notice} />
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? "Salvando…" : dirty ? "Salvar configuração" : "Salvo"}</button>
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--warn)", background: "var(--warn-soft)" }}>
          <strong>Avisos:</strong>
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {problems.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
          <strong>Modo de teste continua ligado. Nada foi salvo.</strong> Para sair do teste, o remetente precisa existir e ter SPF, DKIM e DMARC no DNS:
          <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {neededDns.length > 0 && (
            <div style={{ marginTop: "0.5rem", overflowX: "auto" }}>
              <div className="hint" style={{ marginBottom: "0.25rem" }}>Registros que precisam existir no DNS:</div>
              <table className="table" style={{ width: "100%", fontSize: "0.8125rem" }}>
                <thead><tr><th>Tipo</th><th>Nome</th><th>Valor</th><th>Obs.</th></tr></thead>
                <tbody>{neededDns.map((n, i) => <tr key={i}><td>{n.type}</td><td><code>{n.name}</code></td><td style={{ wordBreak: "break-all" }}><code>{n.value}</code></td><td className="hint">{n.note}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="hint" style={{ marginTop: "0.375rem" }}>Veja o detalhe na aba Entregabilidade (bloco Remetentes). Corrija o DNS, espere propagar e tente de novo; ou volte a ligar o modo de teste para salvar o resto.</div>
        </div>
      )}
      {liveWarning && (
        <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
          <strong>Modo de teste desligado e régua ligada:</strong> clientes reais {dirty ? "vão passar a receber" : "recebem"} e-mail/WhatsApp desta loja.
          {data.settings.production_since && <span className="hint"> Em produção desde {new Date(data.settings.production_since).toLocaleDateString("pt-BR")} (base da rampa de aquecimento do e-mail).</span>}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))", gap: "1rem", alignItems: "start", marginBottom: "1rem" }}>
        <div className="card" style={{ margin: 0 }}>
          <SectionTitle>Chaves</SectionTitle>
          <div style={{ display: "grid", gap: "0.625rem" }}>
            <Switch checked={form.enabled} onChange={(v) => set("enabled", v)} label="Régua ligada" hint="Chave geral. Desligada, nada sai (nem em teste)." />
            <Switch checked={form.email_enabled} onChange={(v) => set("email_enabled", v)} label="E-mail" hint="Passos por e-mail (Resend)." />
            <Switch checked={form.whatsapp_enabled} onChange={(v) => set("whatsapp_enabled", v)} label="WhatsApp" hint="Passos por WhatsApp e conversa do agente." />
            <Switch checked={form.agent_enabled} onChange={(v) => set("agent_enabled", v)} label="Agente vendedor" hint="A IA responde quando o cliente escreve no WhatsApp. Desligado, toda resposta cai em 'precisa de humano'." />
            <Switch checked={form.test_mode} onChange={(v) => set("test_mode", v)} label="Modo de teste" hint="Tudo vai para os destinos de teste abaixo; o cliente real nunca recebe." />
            <Switch checked={form.require_consent} onChange={(v) => set("require_consent", v)} label="Exigir consentimento" hint="Só manda para quem marcou opt-in de e-mail/SMS na Shopify." />
          </div>
          <div style={{ marginTop: "0.875rem", display: "grid", gap: "0.5rem" }}>
            <Field label="E-mail de teste" hint={fieldErrors.test_email ? <span style={{ color: "var(--danger)" }}>{fieldErrors.test_email}</span> : form.test_mode && !form.test_email.trim() ? "Sem e-mail de teste, o e-mail não sai em modo de teste (e esta tela não consegue apagar o que já está salvo)." : undefined}><input type="email" value={form.test_email} onChange={(e) => { set("test_email", e.target.value); setFieldErrors((f) => ({ ...f, test_email: undefined })); }} placeholder="voce@exemplo.com" /></Field>
            <Field label="Telefone de teste" hint="E.164, ex.: +5511999999999. Sem ele, o WhatsApp não sai em teste."><input value={form.test_phone ?? ""} onChange={(e) => set("test_phone", e.target.value)} placeholder="+5511999999999" /></Field>
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <SectionTitle>Remetente do e-mail</SectionTitle>
          <Field label="Nome"><input value={form.from_name ?? ""} onChange={(e) => set("from_name", e.target.value)} placeholder={data.store?.name ?? "Nome da marca"} /></Field>
          <Field label="E-mail (domínio verificado no provedor)" hint={fieldErrors.from_email ? <span style={{ color: "var(--danger)" }}>{fieldErrors.from_email}</span> : "Sem remetente, o passo de e-mail é pulado."}><input type="email" value={form.from_email ?? ""} onChange={(e) => { set("from_email", e.target.value); setFieldErrors((f) => ({ ...f, from_email: undefined })); }} placeholder="ola@marca.com" /></Field>
          <Field label="Reply-to" hint={fieldErrors.reply_to ? <span style={{ color: "var(--danger)" }}>{fieldErrors.reply_to}</span> : "A resposta do cliente cai no Inbox de suporte por este endereço."}><input type="email" value={form.reply_to ?? ""} onChange={(e) => { set("reply_to", e.target.value); setFieldErrors((f) => ({ ...f, reply_to: undefined })); }} placeholder="suporte@marca.com" /></Field>

          <SectionTitle>Provedor de e-mail</SectionTitle>
          <div style={{ display: "grid", gap: "0.375rem" }}>
            {PROVIDERS.map((p) => {
              const configured = data.providers[p.key];
              return (
                <label key={p.key} style={{ display: "flex", gap: "0.5rem", alignItems: "center", cursor: "pointer", fontWeight: 500 }}>
                  <input type="radio" name="email_provider" checked={form.email_provider === p.key} onChange={() => set("email_provider", p.key)} style={{ width: "auto" }} />
                  <span>{p.label}</span>
                  {configured ? <span className="badge badge-ok">configurado</span> : <span className="badge" title={p.env}>não configurado</span>}
                </label>
              );
            })}
          </div>
          <div className="hint" style={{ marginTop: "0.375rem" }}>Por onde saem os e-mails de marketing desta loja (carrinho e pós-compra). O domínio do remetente precisa estar verificado no provedor escolhido. Sem o provedor configurado, nenhum e-mail sai.</div>

          <SectionTitle>Agente vendedor</SectionTitle>
          <Field label="Nome do agente" hint="Vazio = persona da marca por idioma (ex.: Olavita em hebraico)."><input dir="auto" value={form.agent_name ?? ""} onChange={(e) => set("agent_name", e.target.value)} placeholder="automático" /></Field>
          <Field label="Desconto máximo que o agente pode oferecer (%)" hint="Só percentuais com cupom ativo cadastrado abaixo; ele começa pelo menor."><input type="number" min={0} max={90} value={form.agent_max_discount} onChange={(e) => set("agent_max_discount", Number(e.target.value) || 0)} style={{ width: "6rem" }} /></Field>
          <Field label="Instruções extras" hint="Em português. Regras da loja que o agente deve seguir além das fixas (nunca promete data, nunca fala de assinatura, nunca inventa)."><textarea rows={5} dir="auto" value={form.agent_prompt ?? ""} onChange={(e) => set("agent_prompt", e.target.value)} placeholder="Ex.: Nunca ofereça desconto na primeira mensagem. Se perguntar sobre frete, diga que é grátis." /></Field>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <SectionTitle>Tetos e janela</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
            <Field label="Teto diário de e-mails"><input type="number" min={0} value={form.daily_cap_email} onChange={(e) => set("daily_cap_email", Number(e.target.value) || 0)} /></Field>
            <Field label="Teto diário de WhatsApp" hint="Por loja. Cada número tem o seu próprio."><input type="number" min={0} value={form.daily_cap_whatsapp} onChange={(e) => set("daily_cap_whatsapp", Number(e.target.value) || 0)} /></Field>
          </div>
          <Field label="Janela (dias após o abandono)" hint="Depois disso nada mais sai para aquele carrinho."><input type="number" min={1} max={60} value={form.max_days} onChange={(e) => set("max_days", Number(e.target.value) || 1)} style={{ width: "6rem" }} /></Field>
          <Field label="Intervalo mínimo entre e-mails (h)" hint="Nunca dois e-mails de marketing para o mesmo endereço em menos de N horas, em qualquer loja ou fluxo (carrinho e pós-compra). Entre 1 e 168."><input type="number" min={1} max={168} value={form.min_gap_hours} onChange={(e) => set("min_gap_hours", Math.min(168, Math.max(1, Number(e.target.value) || 1)))} style={{ width: "6rem" }} /></Field>

          <SectionTitle>Horário de envio</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
            <Field label="Começa às (hora local do cliente)"><input type="number" min={0} max={23} value={form.quiet_hours?.start ?? 9} onChange={(e) => set("quiet_hours", { ...(form.quiet_hours ?? {}), start: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
            <Field label="Termina às"><input type="number" min={0} max={23} value={form.quiet_hours?.end ?? 21} onChange={(e) => set("quiet_hours", { ...(form.quiet_hours ?? {}), end: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
          </div>
          <Switch checked={form.quiet_hours?.shabbat ?? false} onChange={(v) => set("quiet_hours", { ...(form.quiet_hours ?? {}), shabbat: v })} label="Respeitar o Shabat (Israel)" hint="Desligado por padrão: sexta e sábado podem receber. Ligue para não mandar entre sexta 15:00 e sábado 20:00." />
          <div className="hint" style={{ marginTop: "0.5rem" }}>Fuso pelo país do cliente (Israel, França, Bulgária, Hungria, Romênia, Turquia, Polônia, Suécia, Alemanha). Fora do horário, o envio é adiado para o próximo início permitido.</div>

          <SectionTitle>Rodar agora</SectionTitle>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm" disabled={tick.running} onClick={runTick} title="Executa um ciclo da régua só desta loja, sem esperar o cron. Em produção, envia de verdade.">{tick.running ? "Rodando…" : "Rodar a régua agora"}</button>
            {tick.error && <span className="hint" style={{ color: "var(--danger)" }}>{tick.error}</span>}
          </div>
          {tick.result && (
            <div style={{ marginTop: "0.5rem", fontSize: "0.8125rem" }}>
              {tick.result.skipped ? (
                <div className="hint" style={{ color: "var(--warn)" }}>Pulado: {tick.result.skipped}</div>
              ) : (
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
                  <span className="badge">sincronizados {tick.result.synced ?? 0}</span>
                  <span className="badge">agendados {tick.result.scheduled ?? 0}</span>
                  <span className="badge badge-ok">e-mails {tick.result.sent?.email ?? 0}</span>
                  <span className="badge badge-ok">WhatsApp {tick.result.sent?.whatsapp ?? 0}</span>
                  <span className="badge">pulados {tick.result.skippedCount ?? 0}</span>
                  <span className="badge">parados {tick.result.stopped ?? 0}</span>
                  {(tick.result.errors?.length ?? 0) > 0 && <span className="badge badge-danger">erros {tick.result.errors?.length}</span>}
                </div>
              )}
              {tick.result.partial && <div className="hint" style={{ color: "var(--warn)", marginTop: "0.375rem" }}>Ciclo cortado pelo prazo (parcial): o que faltou sai no próximo ciclo ou rode de novo.</div>}
              {(tick.result.pausedEmail?.length ?? 0) > 0 && <div className="hint" style={{ color: "var(--danger)", marginTop: "0.375rem" }}>E-mail DESLIGADO automaticamente por bounce/reclamação alta. Veja a aba Entregabilidade e religue o canal em Chaves depois de corrigir.</div>}
              {(tick.result.health?.length ?? 0) > 0 && (
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "0.375rem", alignItems: "center" }}>
                  <span className="hint">Saúde do e-mail (24 h):</span>
                  {tick.result.health?.map((h) => (
                    <span key={h.storeId} className={`badge ${h.action === "pausar" ? "badge-danger" : h.action === "alertar" ? "badge-warn" : "badge-ok"}`} title={h.reason ?? ""}>
                      {h.action === "pausar" ? "pausado" : h.action === "alertar" ? "atenção" : "ok"} · {h.sent24h} enviados{h.reason ? ` · ${h.reason}` : ""}
                    </span>
                  ))}
                </div>
              )}
              {(tick.result.errors?.length ?? 0) > 0 && <ul className="hint" style={{ margin: "0.375rem 0 0 1rem", padding: 0, color: "var(--danger)" }}>{tick.result.errors?.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {tick.result.welcome && (
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "0.375rem", alignItems: "center" }}>
                  <span className="hint">Pós-compra:</span>
                  <span className="badge">pedidos novos {tick.result.welcome.created ?? 0}</span>
                  <span className="badge badge-ok">e-mails {tick.result.welcome.sent ?? 0}</span>
                  <span className="badge">pulados {tick.result.welcome.skipped ?? 0}</span>
                  <span className="badge">parados {tick.result.welcome.stopped ?? 0}</span>
                </div>
              )}
              {tick.result.watchdog && (
                <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "0.375rem", alignItems: "center" }}>
                  <span className="hint">Vigilância:</span>
                  <span className={`badge ${tick.result.watchdog.ping === "ok" ? "badge-ok" : tick.result.watchdog.ping === "falhou" ? "badge-danger" : ""}`}>WAHA {tick.result.watchdog.ping === "ok" ? "no ar" : tick.result.watchdog.ping === "falhou" ? "fora do ar" : "não configurado"}</span>
                  {(tick.result.watchdog.alertsCreated ?? 0) > 0 && <span className="badge badge-danger">alertas novos {tick.result.watchdog.alertsCreated}</span>}
                  {(tick.result.watchdog.alertsResolved ?? 0) > 0 && <span className="badge badge-ok">alertas resolvidos {tick.result.watchdog.alertsResolved}</span>}
                </div>
              )}
              <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: "0.375rem" }} onClick={() => setTick((t) => ({ ...t, showRaw: !t.showRaw }))}>{tick.showRaw ? "esconder JSON" : "ver JSON"}</button>
              {tick.showRaw && <pre className="hint" style={{ whiteSpace: "pre-wrap", background: "var(--background)", padding: "0.5rem", borderRadius: 6, maxHeight: "16rem", overflow: "auto" }}>{tick.raw}</pre>}
            </div>
          )}
        </div>

        <div className="card" style={{ margin: 0 }}>
          <SectionTitle>Pós-compra (boas-vindas)</SectionTitle>
          <div style={{ display: "grid", gap: "0.625rem" }}>
            <Switch checked={form.welcome_enabled} onChange={(v) => set("welcome_enabled", v)} label="Pós-compra ligado" hint={data.settings.welcome_since ? `Só pedidos feitos depois de ${new Date(data.settings.welcome_since).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} entram (quando foi ligado pela primeira vez).` : "Ao ligar, só pedidos feitos a partir desse momento entram: quem comprou antes não recebe nada. Precisa da régua e do canal e-mail ligados."} />
            <Switch checked={form.welcome_skip_first_if_receipt} onChange={(v) => set("welcome_skip_first_if_receipt", v)} label="Pular o 1º e-mail quando o comprovante já foi" hint="Se o comprovante automático de compra já saiu para esse e-mail, o passo 1 da régua de pós-compra é pulado (evita dois e-mails seguidos)." />
          </div>
          <div style={{ marginTop: "0.875rem" }}>
            <Field label='Link do botão "fale conosco"' hint="Página de contato ou WhatsApp (https://...). Vazio = mailto do reply-to (ou da caixa conectada da loja)."><input type="url" value={form.contact_url ?? ""} onChange={(e) => set("contact_url", e.target.value)} placeholder="https://marca.com/contato" /></Field>
          </div>
          <div className="hint">A régua de pós-compra fica na aba Régua, fluxo "Pós-compra". Primeiro pedido pago de cada cliente; pedidos cancelados, reembolsados ou de assinatura param na hora.</div>
        </div>
      </div>

      <SessionsPanel storeId={storeId} wahaConfigured={data.providers.waha} />
      <DiscountsPanel storeId={storeId} />
      <KnowledgePanel storeId={storeId} />
    </>
  );
}
