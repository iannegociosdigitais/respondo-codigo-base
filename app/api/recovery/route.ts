import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECOVERY_MISSING_TABLE, type RecoveryAlert, type RecoveryRow, type RecoverySettings } from "@/lib/recovery/types";
import { listOpenAlerts } from "@/lib/recovery/alerts";
import { resendConfigured } from "@/lib/email/resend";
import { marketingConfigured } from "@/lib/email/marketing";
import { wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, jsonError, parseDays } from "@/app/api/recovery/_lib/shared";
import { emptyWelcomeTotals, welcomeTotals } from "@/app/api/recovery/_lib/welcome-stats";

export const maxDuration = 60;

// Painel de recuperação de carrinho. Fase 1: linha de base (abandonos, valor,
// quem voltou a comprar sozinho). Fases seguintes: funil por canal/degrau,
// receita recuperada, custo. Spec v2: totais do pós-compra (welcome) e os
// alertas abertos (máx. 10) para o bloco vermelho no topo do painel.

const BOUGHT = new Set(["recuperado", "parado_comprou"]);
const money = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

interface StoreStats {
  storeId: string;
  storeName: string;
  abandoned: number;
  withEmail: number;
  withPhone: number;
  emailConsent: number;
  smsConsent: number;
  bought: number;
  boughtSameCheckout: number;
  boughtOtherOrder: number;
  rate: number | null;
  valueByCurrency: Record<string, number>;
  boughtValueByCurrency: Record<string, number>;
  byLanguage: Array<{ name: string; count: number }>;
  byStatus: Array<{ name: string; count: number }>;
  active: number;
  settings: RecoverySettings | null;
}

export async function GET(request: Request) {
  // Mesmo helper das outras rotas: sem CRON_SECRET configurado, só o login
  // vale (nunca aceitar "Bearer undefined").
  const denied = await authorize(request);
  if (denied) return denied;
  const days = parseDays(new URL(request.url).searchParams.get("days"));
  if (days === null) return jsonError("days inválido: use um número de 1 a 180", 400);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const admin = createAdminClient();

  // Alertas e pós-compra são tolerantes: tabela ausente ou erro = vazio
  // (o painel principal continua funcionando).
  const safeAlerts = listOpenAlerts(admin).then((list) => list.slice(0, 10)).catch(() => [] as RecoveryAlert[]);
  const safeWelcome = welcomeTotals(admin, { since }).then((w) => (w.error ? emptyWelcomeTotals() : w.totals)).catch(() => emptyWelcomeTotals());

  const [recRes, evRes, setRes, storesRes, supRes, waRes, discRes, alerts, welcome] = await Promise.all([
    admin.from("cart_recoveries").select("*").gte("abandoned_at", since).order("abandoned_at", { ascending: false }).limit(5000),
    admin.from("recovery_events").select("recovery_id, run_id, store_id, step, channel, type, created_at, is_test").gte("created_at", since).limit(20000),
    admin.from("recovery_settings").select("*"),
    admin.from("stores").select("id, name"),
    admin.from("recovery_suppressions").select("channel, reason"),
    admin.from("whatsapp_sessions").select("*"),
    admin.from("recovery_discounts").select("*"),
    safeAlerts,
    safeWelcome,
  ]);
  const migrationMissing = Boolean(recRes.error && RECOVERY_MISSING_TABLE.test(recRes.error.message));
  if (recRes.error && !migrationMissing) return NextResponse.json({ error: recRes.error.message }, { status: 500 });

  const stores = (storesRes.data ?? []) as Array<{ id: string; name: string }>;
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  const rows = (recRes.data ?? []) as RecoveryRow[];
  const events = (evRes.data ?? []) as Array<{ recovery_id: string | null; run_id: string | null; store_id: string | null; step: number | null; channel: string; type: string; created_at: string; is_test: boolean }>;
  const settings = (setRes.data ?? []) as RecoverySettings[];

  const perStore = new Map<string, StoreStats>();
  const statsFor = (id: string): StoreStats => {
    let s = perStore.get(id);
    if (!s) {
      s = { storeId: id, storeName: storeName(id), abandoned: 0, withEmail: 0, withPhone: 0, emailConsent: 0, smsConsent: 0, bought: 0, boughtSameCheckout: 0, boughtOtherOrder: 0, rate: null, valueByCurrency: {}, boughtValueByCurrency: {}, byLanguage: [], byStatus: [], active: 0, settings: settings.find((x) => x.store_id === id) ?? null };
      perStore.set(id, s);
    }
    return s;
  };
  const langCount = new Map<string, Map<string, number>>();
  const statusCount = new Map<string, Map<string, number>>();
  const byDay = new Map<string, { day: string; abandoned: number; bought: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    byDay.set(d, { day: d, abandoned: 0, bought: 0 });
  }

  for (const r of rows) {
    const s = statsFor(r.store_id);
    s.abandoned += 1;
    if (r.email) s.withEmail += 1;
    if (r.phone) s.withPhone += 1;
    if (r.email_consent === "SUBSCRIBED") s.emailConsent += 1;
    if (r.sms_consent === "SUBSCRIBED") s.smsConsent += 1;
    if (r.status === "ativo" || r.status === "pausado") s.active += 1;
    const cur = r.currency ?? "?";
    s.valueByCurrency[cur] = (s.valueByCurrency[cur] ?? 0) + money(r.total);
    if (BOUGHT.has(r.status)) {
      s.bought += 1;
      if (r.status === "recuperado") s.boughtSameCheckout += 1;
      else s.boughtOtherOrder += 1;
      const bc = r.recovered_currency ?? cur;
      s.boughtValueByCurrency[bc] = (s.boughtValueByCurrency[bc] ?? 0) + money(r.recovered_amount ?? r.total);
    }
    const lm = langCount.get(r.store_id) ?? new Map();
    lm.set(r.language ?? "?", (lm.get(r.language ?? "?") ?? 0) + 1);
    langCount.set(r.store_id, lm);
    const sm = statusCount.get(r.store_id) ?? new Map();
    sm.set(r.status, (sm.get(r.status) ?? 0) + 1);
    statusCount.set(r.store_id, sm);
    const day = r.abandoned_at.slice(0, 10);
    const d = byDay.get(day);
    if (d) {
      d.abandoned += 1;
      if (BOUGHT.has(r.status)) d.bought += 1;
    }
  }
  for (const s of perStore.values()) {
    s.rate = s.abandoned ? s.bought / s.abandoned : null;
    s.byLanguage = [...(langCount.get(s.storeId) ?? new Map<string, number>()).entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    s.byStatus = [...(statusCount.get(s.storeId) ?? new Map<string, number>()).entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  // Funil por canal e degrau (fase 2+): quantos recoveries tiveram cada evento.
  const funnel = new Map<string, { channel: string; step: number; sent: Set<string>; delivered: Set<string>; opened: Set<string>; clicked: Set<string>; replied: Set<string>; bounced: Set<string>; complained: Set<string>; unsubscribed: Set<string>; failed: Set<string> }>();
  for (const e of events) {
    // Eventos do pós-compra (run_id) ficam fora do funil do carrinho.
    if (e.is_test || e.channel === "system" || !e.recovery_id) continue;
    const k = `${e.channel}:${e.step ?? 0}`;
    let f = funnel.get(k);
    if (!f) {
      f = { channel: e.channel, step: e.step ?? 0, sent: new Set(), delivered: new Set(), opened: new Set(), clicked: new Set(), replied: new Set(), bounced: new Set(), complained: new Set(), unsubscribed: new Set(), failed: new Set() };
      funnel.set(k, f);
    }
    const bucket = (e.type === "read" ? "opened" : e.type) as keyof typeof f;
    const set = f[bucket];
    if (set instanceof Set) set.add(e.recovery_id);
  }
  const funnelRows = [...funnel.values()].sort((a, b) => a.step - b.step || a.channel.localeCompare(b.channel)).map((f) => ({ channel: f.channel, step: f.step, sent: f.sent.size, delivered: f.delivered.size, opened: f.opened.size, clicked: f.clicked.size, replied: f.replied.size, bounced: f.bounced.size, complained: f.complained.size, unsubscribed: f.unsubscribed.size, failed: f.failed.size }));

  const totals = [...perStore.values()].reduce(
    (acc, s) => ({ abandoned: acc.abandoned + s.abandoned, bought: acc.bought + s.bought, withPhone: acc.withPhone + s.withPhone, emailConsent: acc.emailConsent + s.emailConsent, smsConsent: acc.smsConsent + s.smsConsent, active: acc.active + s.active }),
    { abandoned: 0, bought: 0, withPhone: 0, emailConsent: 0, smsConsent: 0, active: 0 }
  );

  const suppressions = (supRes.data ?? []) as Array<{ channel: string; reason: string }>;
  const recent = rows.slice(0, 80).map((r) => ({
    id: r.id,
    store: storeName(r.store_id),
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
    email: r.email,
    phone: r.phone ? r.phone.replace(/(\+\d{3})\d+(\d{3})$/, "$1…$2") : null,
    language: r.language,
    country: r.country_code,
    total: money(r.total),
    currency: r.currency,
    items: (r.items ?? []).map((i) => `${i.quantity}× ${i.title}`).join("; "),
    discountCodes: r.discount_codes ?? [],
    abandonedAt: r.abandoned_at,
    status: r.status,
    step: r.step,
    recoveredOrder: r.recovered_order_name,
    recoveredAt: r.recovered_at,
    attribution: r.attribution,
    emailConsent: r.email_consent,
    smsConsent: r.sms_consent,
  }));

  return NextResponse.json({
    days,
    migrationMissing,
    phase: "medir",
    totals: { ...totals, rate: totals.abandoned ? totals.bought / totals.abandoned : null },
    stores: [...perStore.values()].sort((a, b) => b.abandoned - a.abandoned),
    byDay: [...byDay.values()],
    funnel: funnelRows,
    suppressions: { total: suppressions.length, byReason: Object.entries(suppressions.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {})).map(([name, count]) => ({ name, count })) },
    providers: { resend: resendConfigured(), ses: marketingConfigured("ses"), waha: wahaConfigured(), wahaWebhookSecret: Boolean(process.env.WAHA_WEBHOOK_SECRET), resendWebhookSecret: Boolean(process.env.RESEND_WEBHOOK_SECRET) },
    whatsappSessions: waRes.data ?? [],
    discounts: discRes.data ?? [],
    lastSync: settings.map((s) => ({ store: storeName(s.store_id), at: s.last_sync_at })),
    recent,
    welcome,
    alerts,
  });
}
