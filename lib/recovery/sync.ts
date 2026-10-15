import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAllShopifyCreds } from "@/lib/agent/analyze";
import { fetchAbandonedCheckouts, type AbandonedCheckoutSummary } from "@/lib/shopify/abandoned";
import { fetchRecentPaidOrders, type ShopifyCredentials, type ShopifyOrderSummary } from "@/lib/shopify/orders";
import { decrypt } from "@/lib/crypto";
import { normalizePhone } from "@/lib/recovery/phone";
import { FLOW_PRODUCT_STOP, isFlowProduct } from "@/lib/recovery/product-gate";
import { langFromCountry } from "@/lib/forms/money";
import { RECOVERY_MISSING_TABLE, type RecoverySettings } from "@/lib/recovery/types";

// FASE 1 (medir): importa os checkouts abandonados de todas as lojas pra
// cart_recoveries e marca quem já comprou. NÃO envia nada — é a linha de
// base pra comparar com o Klaviyo e pra validar a regra de parada com dados
// reais antes de ligar qualquer canal.
//
// Roda dentro do cron de 10 min (poll-inboxes) e à mão em
// POST /api/cron/cart-recovery?hours=720 (backfill de 30 dias).

export interface RecoverySyncStoreResult {
  storeId: string;
  storeName: string;
  fetched: number;
  upserted: number;
  error?: string;
}

export interface RecoverySyncResult {
  skipped?: "migration_missing";
  stores: RecoverySyncStoreResult[];
  recovered: number; // o mesmo checkout virou pedido
  bought: number; // outro pedido (mesmo e-mail/telefone), em qualquer loja
  superseded: number; // a pessoa abandonou um checkout mais novo
  offProduct: number; // carrinho sem item do Olavita (produto novo): fechado sem mensagem
  expired: number; // passou da janela sem comprar
  ms: number;
}

type Row = Record<string, unknown>;

const lower = (s: string | null | undefined) => (s ? s.trim().toLowerCase() : null);
const num = (s: string | number | null | undefined) => (s == null || s === "" ? null : Number(s));

function toRow(storeId: string, c: AbandonedCheckoutSummary, now: string): Row {
  const country = c.countryCode;
  const phone = normalizePhone(c.customer?.phone, country) ?? normalizePhone(c.shippingPhone, country) ?? normalizePhone(c.billingPhone, country);
  const locale = c.customer?.locale ?? (/[?&]locale=([a-zA-Z-]+)/.exec(c.recoveryUrl)?.[1] ?? null);
  const language = locale ? locale.slice(0, 2).toLowerCase() : langFromCountry(country);
  return {
    store_id: storeId,
    checkout_id: c.id,
    checkout_name: c.name,
    email: lower(c.customer?.email),
    phone,
    first_name: c.customer?.firstName ?? null,
    last_name: c.customer?.lastName ?? null,
    locale,
    language,
    country_code: country,
    city: c.city,
    currency: c.currency,
    total: num(c.total),
    subtotal: num(c.subtotal),
    total_discount: num(c.totalDiscount),
    items: c.lineItems,
    discount_codes: c.discountCodes,
    recovery_url: c.recoveryUrl,
    email_consent: c.customer?.emailConsent ?? null,
    sms_consent: c.customer?.smsConsent ?? null,
    customer_orders_count: c.customer?.ordersCount ?? null,
    shopify_customer_id: c.customer?.id ?? null,
    abandoned_at: c.createdAt,
    shopify_updated_at: c.updatedAt,
    completed_at: c.completedAt,
    updated_at: now,
  };
}

interface ActiveRow {
  id: string;
  store_id: string;
  email: string | null;
  phone: string | null;
  abandoned_at: string;
  completed_at: string | null;
  total: number | null;
  currency: string | null;
  status: string;
  items: Array<{ title?: string | null }> | null;
}

// loadAllShopifyCreds sempre resolve o token; o tipo é opcional por herança.
const asAuth = (c: ShopifyCredentials) => ({ shopDomain: c.shopDomain, accessToken: c.accessToken ?? decrypt(c.accessTokenEncrypted ?? "") });

const PAGE = 1000; // máximo de linhas por consulta do PostgREST
const BATCH = 200; // ids por .in() (a URL da consulta não pode crescer sem limite)

// Envios REAIS (sent, não-teste) por carrinho, do mais novo pro mais antigo.
type SentIndex = Map<string, Array<{ at: number; channel: string }>>;

async function loadSentIndex(admin: SupabaseClient, ids: string[]): Promise<SentIndex> {
  const index: SentIndex = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("recovery_events")
        .select("recovery_id, channel, created_at")
        .in("recovery_id", batch)
        .eq("type", "sent")
        .eq("is_test", false)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const e of data ?? []) {
        const id = e.recovery_id as string;
        const list = index.get(id) ?? [];
        list.push({ at: new Date(e.created_at as string).getTime(), channel: e.channel as string });
        index.set(id, list);
      }
      if ((data ?? []).length < PAGE) break;
    }
  }
  return index;
}

// Canal do último envio real ANTES da compra (created_at < recovered_at);
// sem envio antes da compra = 'organico' (comprou sozinho).
function channelBefore(index: SentIndex, id: string, recoveredAt: string): string {
  const cut = new Date(recoveredAt).getTime();
  if (!Number.isFinite(cut)) return "organico";
  const hit = (index.get(id) ?? []).filter((e) => e.at < cut).sort((x, y) => y.at - x.at)[0];
  return hit?.channel ?? "organico";
}

const isPaid = (o: ShopifyOrderSummary) => !o.cancelledAt && !/^(VOIDED|EXPIRED|PENDING|REFUNDED)$/i.test(o.financialStatus ?? "");

export async function syncAbandonedCheckouts(admin: SupabaseClient, opts: { hours?: number; deadline?: number; onlyStoreId?: string | null } = {}): Promise<RecoverySyncResult> {
  const started = Date.now();
  const result: RecoverySyncResult = { stores: [], recovered: 0, bought: 0, superseded: 0, offProduct: 0, expired: 0, ms: 0 };

  const { data: settingsRows, error: settingsError } = await admin.from("recovery_settings").select("*");
  if (settingsError) {
    if (RECOVERY_MISSING_TABLE.test(settingsError.message)) return { ...result, skipped: "migration_missing" };
    throw new Error(settingsError.message);
  }
  const settings = (settingsRows ?? []) as RecoverySettings[];
  const creds = await loadAllShopifyCreds(admin, null);
  const nowIso = new Date().toISOString();

  // 1) Importar / atualizar --------------------------------------------------
  for (const cred of creds) {
    if (opts.onlyStoreId && cred.storeId !== opts.onlyStoreId) continue;
    if (opts.deadline && Date.now() > opts.deadline) break;
    const r: RecoverySyncStoreResult = { storeId: cred.storeId, storeName: cred.storeName, fetched: 0, upserted: 0 };
    result.stores.push(r);
    const s = settings.find((x) => x.store_id === cred.storeId) ?? null;
    // Sobreposição de 2h com o último sync pra não perder atualização nenhuma.
    const since = opts.hours ? new Date(Date.now() - opts.hours * 3600e3) : s?.last_sync_at ? new Date(new Date(s.last_sync_at).getTime() - 2 * 3600e3) : new Date(Date.now() - 30 * 86400e3);
    try {
      const checkouts = await fetchAbandonedCheckouts(asAuth(cred), { updatedSince: since.toISOString(), max: 3000 });
      r.fetched = checkouts.length;
      // Sem e-mail nem telefone não há como recuperar: nem entra.
      const rows = checkouts.map((c) => toRow(cred.storeId, c, nowIso)).filter((row) => row.email || row.phone);
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        // Só colunas de sincronização: status/degrau/próximo envio ficam como estão.
        const { error } = await admin.from("cart_recoveries").upsert(chunk, { onConflict: "store_id,checkout_id" });
        if (error) throw new Error(error.message);
        r.upserted += chunk.length;
      }
      await admin.from("recovery_settings").upsert({ store_id: cred.storeId, last_sync_at: nowIso, updated_at: nowIso }, { onConflict: "store_id" });
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
      console.error("cart-recovery sync:", cred.storeName, r.error);
    }
  }

  // 2) Paradas ------------------------------------------------------------------
  // Ativos paginados de 1000 em 1000 (o PostgREST corta em 1000 por consulta).
  const active: ActiveRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: activeError } = await admin
      .from("cart_recoveries")
      .select("id, store_id, email, phone, abandoned_at, completed_at, total, currency, status, items")
      .in("status", ["ativo", "pausado"])
      .order("id")
      .range(from, from + PAGE - 1);
    if (activeError) throw new Error(activeError.message);
    active.push(...((page ?? []) as ActiveRow[]));
    if ((page ?? []).length < PAGE) break;
  }
  if (active.length === 0) return { ...result, ms: Date.now() - started };

  // 2-) Carrinho sem item do Olavita (produto novo, ver product-gate.ts): os
  // fluxos são do Olavita. Fecha já, sem mensagem, e fica fora das regras
  // abaixo (não vira "recuperado" e não substitui um carrinho do Olavita).
  const offProduct = active.filter((a) => !isFlowProduct(a.items));
  if (offProduct.length > 0) {
    const ids = offProduct.map((a) => a.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      const { error } = await admin.from("cart_recoveries").update({ status: "concluido_sem_compra", stop_reason: FLOW_PRODUCT_STOP, next_send_at: null, updated_at: nowIso }).in("id", ids.slice(i, i + BATCH)).in("status", ["ativo", "pausado"]);
      if (!error) result.offProduct += ids.slice(i, i + BATCH).length;
      else console.error("cart-recovery produto fora do fluxo:", error.message);
    }
    const off = new Set(ids);
    active.splice(0, active.length, ...active.filter((a) => !off.has(a.id)));
    if (active.length === 0) return { ...result, ms: Date.now() - started };
  }

  // 2a) O mesmo checkout virou pedido (completedAt da Shopify).
  // Atribuição: 'recuperado com contato' (houve envio REAL antes da compra:
  // recovered_channel = canal do último) x 'comprou sozinho' (recovered_channel
  // 'organico'). Só os carrinhos que acabaram de virar compra precisam do
  // histórico de envios (carregado em lotes de 200).
  const completed = active.filter((a) => a.completed_at);
  let completedSent: SentIndex | null = null;
  if (completed.length > 0) {
    try {
      completedSent = await loadSentIndex(admin, completed.map((a) => a.id));
    } catch (err) {
      // Sem o histórico não dá pra atribuir: não grava 'organico' errado; tenta no próximo sync.
      console.error("cart-recovery atribuição:", err instanceof Error ? err.message : err);
    }
  }
  for (const a of completedSent ? completed : []) {
    if (!a.completed_at) continue;
    const { error } = await admin
      .from("cart_recoveries")
      .update({ status: "recuperado", recovered_at: a.completed_at, recovered_amount: a.total, recovered_currency: a.currency, recovered_channel: channelBefore(completedSent as SentIndex, a.id, a.completed_at), attribution: "checkout", stop_reason: "comprou_checkout", next_send_at: null, updated_at: nowIso })
      .eq("id", a.id)
      .in("status", ["ativo", "pausado"]);
    if (!error) result.recovered += 1;
  }
  const still = active.filter((a) => !a.completed_at);

  // 2b) Outro pedido pago, em QUALQUER loja, com o mesmo e-mail ou telefone,
  // depois do abandono. Uma busca de pedidos por loja (não uma por carrinho).
  if (still.length > 0 && !(opts.deadline && Date.now() > opts.deadline)) {
    const oldest = Math.max(Math.min(...still.map((a) => new Date(a.abandoned_at).getTime())), Date.now() - 14 * 86400e3);
    const orders: ShopifyOrderSummary[] = [];
    for (const cred of creds) {
      try {
        orders.push(...(await fetchRecentPaidOrders(cred, new Date(oldest).toISOString(), 250)));
      } catch (err) {
        console.error("cart-recovery orders:", cred.storeName, err instanceof Error ? err.message : err);
      }
    }
    const { data: codesData } = await admin.from("recovery_discounts").select("code");
    const ourCodes = new Set((codesData ?? []).map((c) => String(c.code).toUpperCase()));
    const byEmail = new Map<string, ShopifyOrderSummary[]>();
    const byPhone = new Map<string, ShopifyOrderSummary[]>();
    for (const o of orders) {
      if (!isPaid(o)) continue;
      const e = lower(o.email);
      if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), o]);
      const p = normalizePhone(o.phone, o.countryCode);
      if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), o]);
    }
    // Primeiro acha quem comprou em outro pedido; depois carrega o histórico de
    // envios só desses (lotes de 200) pra atribuir o canal.
    const matches: Array<{ a: ActiveRow; order: ShopifyOrderSummary; viaEmail: boolean }> = [];
    for (const a of still) {
      const after = new Date(a.abandoned_at).getTime();
      const viaEmail = (a.email ? byEmail.get(a.email) ?? [] : []).find((o) => new Date(o.createdAt).getTime() > after);
      const viaPhone = viaEmail ? null : (a.phone ? byPhone.get(a.phone) ?? [] : []).find((o) => new Date(o.createdAt).getTime() > after);
      const order = viaEmail ?? viaPhone;
      if (order) matches.push({ a, order, viaEmail: Boolean(viaEmail) });
    }
    let boughtSent: SentIndex | null = null;
    if (matches.length > 0) {
      try {
        boughtSent = await loadSentIndex(admin, matches.map((m) => m.a.id));
      } catch (err) {
        console.error("cart-recovery atribuição:", err instanceof Error ? err.message : err);
      }
    }
    for (const { a, order, viaEmail } of boughtSent ? matches : []) {
      const usedCode = (order.discountCodes ?? []).find((c) => ourCodes.has(c.toUpperCase())) ?? null;
      const { error } = await admin
        .from("cart_recoveries")
        .update({
          status: "parado_comprou",
          recovered_order_id: order.id,
          recovered_order_name: order.name,
          recovered_at: order.createdAt,
          recovered_amount: num(order.presentmentTotal ?? order.totalPrice),
          recovered_currency: order.presentmentCurrency ?? order.currency,
          recovered_channel: channelBefore(boughtSent as SentIndex, a.id, order.createdAt),
          recovered_discount_code: usedCode,
          attribution: usedCode ? "cupom" : viaEmail ? "pedido_email" : "pedido_telefone",
          stop_reason: "comprou_outro_pedido",
          next_send_at: null,
          updated_at: nowIso,
        })
        .eq("id", a.id)
        .in("status", ["ativo", "pausado"]);
      if (!error) {
        result.bought += 1;
        a.status = "parado_comprou";
      }
    }
  }

  // 2c) A mesma pessoa abandonou um checkout mais novo: só o novo roda.
  const remaining = still.filter((a) => a.status === "ativo" || a.status === "pausado");
  const newestByKey = new Map<string, ActiveRow>();
  for (const a of remaining) {
    for (const k of [a.email ? `e:${a.email}` : null, a.phone ? `p:${a.phone}` : null]) {
      if (!k) continue;
      const cur = newestByKey.get(k);
      if (!cur || new Date(a.abandoned_at) > new Date(cur.abandoned_at)) newestByKey.set(k, a);
    }
  }
  const superseded = new Set<string>();
  for (const a of remaining) {
    for (const k of [a.email ? `e:${a.email}` : null, a.phone ? `p:${a.phone}` : null]) {
      if (k && newestByKey.get(k)?.id !== a.id) superseded.add(a.id);
    }
  }
  if (superseded.size > 0) {
    const ids = [...superseded];
    const { error } = await admin.from("cart_recoveries").update({ status: "substituido", stop_reason: "checkout_mais_novo", next_send_at: null, updated_at: nowIso }).in("id", ids).in("status", ["ativo", "pausado"]);
    if (!error) result.superseded = ids.length;
  }

  // 2d) Janela máxima (max_days da loja, padrão 10): nada mais sai.
  const expired = remaining.filter((a) => {
    if (superseded.has(a.id)) return false;
    const maxDays = settings.find((s) => s.store_id === a.store_id)?.max_days ?? 10;
    return Date.now() - new Date(a.abandoned_at).getTime() > maxDays * 86400e3;
  });
  if (expired.length > 0) {
    const ids = expired.map((a) => a.id);
    const { error } = await admin.from("cart_recoveries").update({ status: "concluido_sem_compra", stop_reason: "janela_expirada", next_send_at: null, updated_at: nowIso }).in("id", ids).in("status", ["ativo", "pausado"]);
    if (!error) result.expired = ids.length;
  }

  return { ...result, ms: Date.now() - started };
}
