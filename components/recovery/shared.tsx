"use client";

import type { ReactNode } from "react";

// Pedaços comuns do painel de recuperação: chamada de API com tratamento de
// migration ausente, rótulos em PT-BR, formatadores e avisos padrão.

export class ApiError extends Error {
  status: number;
  migrationMissing: boolean;
  // Corpo da resposta de erro (ex.: { problems: [...] } no 409 do modo de teste).
  details: Record<string, unknown>;
  constructor(message: string, status: number, migrationMissing = false, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.migrationMissing = migrationMissing;
    this.details = details;
  }
}

// fetch + JSON. Erro HTTP vira ApiError com a mensagem do servidor; 503 com
// { migrationMissing: true } vira flag para o aviso de migration.
export async function api<T = Record<string, unknown>>(url: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: init.signal,
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(`Sem resposta do servidor (${(e as Error).message}).`, 0);
  }
  let d: Record<string, unknown> | null = null;
  try {
    d = (await r.json()) as Record<string, unknown>;
  } catch {
    d = null;
  }
  if (!r.ok) {
    const msg = typeof d?.error === "string" ? d.error : `Erro ${r.status} em ${url.split("?")[0]}`;
    throw new ApiError(msg, r.status, Boolean(d?.migrationMissing), d ?? {});
  }
  return (d ?? {}) as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- rótulos ---------------------------------------------------------------

export const LANG_NAME: Record<string, string> = {
  he: "Hebraico", en: "Inglês", fr: "Francês", bg: "Búlgaro", hu: "Húngaro", ro: "Romeno", tr: "Turco", pl: "Polonês", sv: "Sueco", de: "Alemão",
  nl: "Holandês", it: "Italiano", es: "Espanhol", pt: "Português", ar: "Árabe", da: "Dinamarquês", ru: "Russo", "?": "Sem idioma",
};
export const langName = (code: string | null | undefined) => LANG_NAME[code ?? "?"] ?? (code || "Sem idioma");

// Idiomas editáveis na régua (ordem de volume dos carrinhos).
export const STEP_LANGS = ["he", "en", "fr", "bg", "hu", "ro", "tr"] as const;

export const STATUS_INFO: Record<string, { label: string; cls: string }> = {
  ativo: { label: "Ativo", cls: "badge badge-accent" },
  pausado: { label: "Pausado", cls: "badge" },
  recuperado: { label: "Comprou (mesmo checkout)", cls: "badge badge-ok" },
  parado_comprou: { label: "Comprou (outro pedido)", cls: "badge badge-ok" },
  parado_respondeu: { label: "Respondeu por e-mail", cls: "badge badge-warn" },
  parado_descadastrou: { label: "Pediu para parar", cls: "badge badge-danger" },
  parado_suprimido: { label: "Suprimido", cls: "badge badge-danger" },
  substituido: { label: "Checkout mais novo", cls: "badge" },
  concluido_sem_compra: { label: "Sem compra", cls: "badge" },
};
export const statusInfo = (s: string | null | undefined) => STATUS_INFO[s ?? ""] ?? { label: s || "?", cls: "badge" };

export const AGENT_MODE_INFO: Record<string, { label: string; cls: string }> = {
  agente: { label: "agente", cls: "badge badge-accent" },
  humano: { label: "humano", cls: "badge badge-ok" },
  pausado: { label: "pausado", cls: "badge" },
};

export const AUTHOR_LABEL: Record<string, string> = { cliente: "Cliente", agente: "Agente", humano: "Você", regua: "Régua" };

export const CHANNEL_LABEL: Record<string, string> = { email: "E-mail", whatsapp: "WhatsApp", sms: "SMS", system: "Sistema" };

export const EVENT_LABEL: Record<string, string> = {
  queued: "na fila", sent: "enviado", delivered: "entregue", read: "lido", opened: "aberto", clicked: "clicou no link", replied: "respondeu",
  bounced: "rejeitado", complained: "marcou como spam", failed: "falhou", unsubscribed: "descadastrou", skipped: "pulado", stopped: "parado", handoff: "passou para humano",
};

export const KNOWLEDGE_KINDS: Array<{ key: string; label: string }> = [
  { key: "script", label: "Script de venda" },
  { key: "produto", label: "Produto" },
  { key: "objecao", label: "Objeção" },
  { key: "preco", label: "Preço" },
  { key: "garantia", label: "Garantia" },
  { key: "regra", label: "Regra" },
  { key: "outro", label: "Outro" },
];

// Fluxos da régua (spec v2): carrinho abandonado e pós-compra (boas-vindas).
export const FLOWS: Array<{ key: "carrinho" | "pos_compra"; label: string; hint: string }> = [
  { key: "carrinho", label: "Carrinho abandonado", hint: "Quem começou um pedido e não pagou. E-mail e WhatsApp." },
  { key: "pos_compra", label: "Pós-compra", hint: "Boas-vindas para quem fez o PRIMEIRO pedido pago: só e-mail, só pedidos feitos depois de ligar em Configuração." },
];
export const FLOW_LABEL: Record<string, string> = { carrinho: "Carrinho abandonado", pos_compra: "Pós-compra" };

export const SEND_IF_OPTIONS: Array<{ key: "sempre" | "enviado" | "nao_enviado"; label: string; hint: string }> = [
  { key: "sempre", label: "Sempre", hint: "Sai na hora marcada, independentemente do envio do pedido." },
  { key: "enviado", label: "Só com o pedido já enviado", hint: "Espera a Shopify marcar o envio (até 20 dias; depois o passo é pulado). Use com {{rastreio}} e {{link_rastreio}}." },
  { key: "nao_enviado", label: "Só com o pedido ainda não enviado", hint: "Se o pedido já saiu, o passo é pulado." },
];

export const RUN_STATUS_INFO: Record<string, { label: string; cls: string }> = {
  ativo: { label: "Ativo", cls: "badge badge-accent" },
  pausado: { label: "Pausado", cls: "badge" },
  concluido: { label: "Concluído", cls: "badge badge-ok" },
  parado_cancelado: { label: "Cancelado / reembolsado", cls: "badge badge-warn" },
  parado_descadastrou: { label: "Pediu para parar", cls: "badge badge-danger" },
  parado_suprimido: { label: "Suprimido", cls: "badge badge-danger" },
};
export const runStatusInfo = (s: string | null | undefined) => RUN_STATUS_INFO[s ?? ""] ?? { label: s || "?", cls: "badge" };

export const ALERT_KIND_LABEL: Record<string, string> = { sessao: "Número de WhatsApp", waha: "Servidor WAHA", envio: "Envios", humano: "Precisa de humano", outro: "Outro" };

export const SESSION_STATUS_CLASS: Record<string, string> = {
  WORKING: "badge badge-ok", SCAN_QR_CODE: "badge badge-warn", STARTING: "badge badge-warn", STOPPED: "badge", FAILED: "badge badge-danger",
};
export const SESSION_STATUS_LABEL: Record<string, string> = {
  WORKING: "conectado", SCAN_QR_CODE: "aguardando QR", STARTING: "iniciando", STOPPED: "parado", FAILED: "falhou",
};

// --- formatadores ----------------------------------------------------------

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function fmtMoney(v: number | string | null | undefined, cur: string | null | undefined): string {
  const n = v == null || v === "" ? 0 : Number(v);
  const c = cur ?? "";
  const sym = c === "ILS" ? "₪" : c === "EUR" ? "€" : c === "USD" ? "$" : c === "GBP" ? "£" : c ? `${c} ` : "";
  return `${sym}${(Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString("pt-BR")}`;
}

export function num(v: number | string | null | undefined, fallback = 0): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// "1 min", "20 min", "1 h", "1 h 30 min", "1 dia", "3 dias 2 h".
export function humanMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return "na hora";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d} dia${d > 1 ? "s" : ""}${rh ? ` ${rh} h` : ""}`;
}

export const RTL_RE = /[֐-׿؀-ۿ]/;
export function isRtl(text: string | null | undefined, lang?: string | null): boolean {
  if (lang === "he" || lang === "ar") return true;
  return RTL_RE.test(text ?? "");
}

// Direção pelo CONTEÚDO: hebraico/árabe no texto = RTL; texto latino = LTR
// mesmo que o idioma do carrinho seja hebraico. O idioma só decide quando o
// texto está vazio (caixa de escrever ainda em branco).
export function rtlByText(text: string | null | undefined, lang?: string | null): boolean {
  const t = (text ?? "").trim();
  if (t) return RTL_RE.test(t);
  return lang === "he" || lang === "ar";
}

// Mensagem/evento de teste (foi para o destino de teste, não para o cliente).
// A API pode devolver is_test ou isTest; sem o campo, conta como real.
export const isTestRow = (r: { is_test?: boolean | null; isTest?: boolean | null } | null | undefined): boolean => Boolean(r?.is_test ?? r?.isTest);

export const phoneDigits = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "");

const AVATAR_COLORS = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#2563eb"];
export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function displayName(name: string | null | undefined, phone: string | null | undefined, email?: string | null): string {
  return (name ?? "").trim() || phone || email || "Sem nome";
}

// --- componentes de aviso -------------------------------------------------

export function MigrationWarning() {
  return (
    <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)" }}>
      Falta rodar a migration <code>0018_cart_recovery.sql</code> no Supabase. Sem ela não existem as tabelas da recuperação: nada é gravado e nenhum envio é possível.
    </div>
  );
}

export function ErrorBox({ text, onClose }: { text: string; onClose?: () => void }) {
  if (!text) return null;
  return (
    <div className="card" style={{ marginBottom: "1rem", borderLeft: "3px solid var(--danger)", display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
      <span>{text}</span>
      {onClose && <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>fechar</button>}
    </div>
  );
}

export type NoticeState = { kind: "ok" | "err" | "warn"; text: string };

export function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  return <span className="hint" style={{ color: notice.kind === "ok" ? "var(--ok)" : notice.kind === "warn" ? "var(--warn)" : "var(--danger)" }}>{notice.text}</span>;
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: "auto", marginTop: "0.2rem" }} />
      <span>
        <span>{label}</span>
        {hint && <span className="hint" style={{ display: "block", fontWeight: 400 }}>{hint}</span>}
      </span>
    </label>
  );
}

export function Field({ label, hint, children, style }: { label: ReactNode; hint?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="field" style={style}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      <span>{children}</span>
      {right}
    </div>
  );
}
