import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderById, fetchRecentPaidOrders, isFirstPaidOrder, type ShopifyCredentials, type ShopifyOrderSummary } from "@/lib/shopify/orders";
import { normalizePhone } from "@/lib/recovery/phone";
import { customerAmount, orderLanguage } from "@/lib/forms/money";
import { isAllowedNow, nextAllowedTime, scheduleAfter } from "@/lib/recovery/schedule";
import { clickLink, unsubscribeLink } from "@/lib/recovery/links";
import { buildRecoveryEmailHtml, buildRecoveryEmailText, emailLabels, pickStepBody, pickStepSubject, renderTemplate } from "@/lib/recovery/templates";
import { normEmail } from "@/lib/email/log";
import { emailAddressProblem } from "@/lib/email/address-check";
import { verifyEmailAddress } from "@/lib/email/verify";
import { marketingConfigured } from "@/lib/email/marketing";
import { stripDashes } from "@/lib/text/dashes";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { loadProducts, type Products } from "@/lib/agent/products";
import { FLOW_PRODUCT_STOP, isFlowProduct } from "@/lib/recovery/product-gate";
import type { PostPurchaseRun, RecoveryItem, RecoverySettings, RecoveryStep } from "@/lib/recovery/types";
import {
  agentNameFor,
  buildVars,
  bumpDaily,
  claimEvent,
  countFailed,
  dailyCount,
  deliverEmail,
  EMAIL_QUOTA_BACKOFF_MIN,
  effectiveEmailCap,
  errMsg,
  isTooLate,
  languageAllowed,
  logEvent,
  markPace,
  markEventAmbiguous,
  markEventFailed,
  markEventQuota,
  markEventSent,
  minGapBlock,
  overDeadline,
  PACE_GAP_SEC,
  paceConflict,
  paceFreeAt,
  productsFor,
  providerOf,
  quotaBlockedStores,
  registerAmbiguousSend,
  releasePacedClaim,
  renderExtras,
  rescheduleLateStep,
  resolveBrand,
  senderDns,
  skippedToday,
  TEST_DAILY_CAP,
  TEST_MAX_PER_TICK,
  type EventTarget,
  type PreparedStep,
  type PrepareOutcome,
  type SendOutcome,
  type TickContext,
} from "@/lib/recovery/engine";

// PÓS-COMPRA ("welcome", spec v2 §1.1): régua de e-mails depois do PRIMEIRO
// pedido pago de cada cliente (nunca renovação de assinatura). Um run por
// pedido em post_purchase_runs; os eventos vão em recovery_events com run_id.
//
// Ciclo (dentro do runRecoveryTick, depois do carrinho):
//   createWelcomeRuns: pedidos pagos recentes de cada Shopify → run (sempre,
//     mesmo com o fluxo desligado, pra o painel medir);
//   processWelcomeRuns: runs vencidos (next_at <= agora) das lojas com o fluxo
//     LIGADO. Loja com o fluxo desligado não é tocada (nem escrita a cada
//     tick): quando ligar, os runs anteriores a welcome_since viram
//     "pausado" e só os pedidos novos seguem.
//
// Mesmas regras do carrinho: trava antes de enviar, teto diário (de
// aquecimento em produção), intervalo mínimo por endereço, DNS do remetente,
// idioma do cliente ou inglês (senão sem_idioma e avança), modo de teste pro
// test_email, recusa por cota do provedor (429) sem contar tentativa e com a
// loja segurada por 60 min. Específico daqui: send_if por passo (só depois do envio na
// Shopify / só antes), passo 1 pulado quando o comprovante automático já saiu,
// parada por cancelamento/reembolso/supressão, e as variáveis {{pedido}},
// {{rastreio}} e {{link_rastreio}}. Falhar fechado em qualquer dúvida.

const MIN = 60_000;
const HOUR = 60 * MIN;
const STOP_FINANCIAL = /^(REFUNDED|VOIDED|PARTIALLY_REFUNDED)$/i;
const RECEIPT_GRACE_MS = 20 * MIN; // espera pelo comprovante automático antes do passo 1
const FULFILLMENT_WAIT_DAYS = 20; // passo "só depois do envio" desiste depois disso

export const welcomeDedupeKey = (run: Pick<PostPurchaseRun, "order_id">, position: number, isTest: boolean, now = new Date()) =>
  `welcome:${run.order_id}:${position}${isTest ? `:test:${now.toISOString().slice(0, 16)}` : ""}`;

const welcomeStepsFor = (ctx: Pick<TickContext, "steps">, storeId: string) =>
  ctx.steps.filter((s) => s.store_id === storeId && s.channel === "email" && s.enabled && s.flow === "pos_compra").sort((a, b) => a.position - b.position);
// Próximo passo HABILITADO depois da posição dada (0 = o primeiro da régua).
// Passo do meio desligado não trunca a régua: o seguinte habilitado assume.
const welcomeNextStep = (ctx: Pick<TickContext, "steps">, storeId: string, afterPosition: number) => welcomeStepsFor(ctx, storeId).find((s) => s.position > afterPosition) ?? null;

// Gate do fluxo (além do canal de e-mail): ligado, com data de início e
// provedor configurado; em teste, com e-mail de teste.
export function canSendWelcome(settings: RecoverySettings | null | undefined): boolean {
  if (!settings?.enabled || !settings.email_enabled || !settings.welcome_enabled) return false;
  if (!settings.welcome_since) return false; // sem data de início nada qualifica (falha fechado)
  // Produção + SES exige SES_CONFIGURATION_SET (sem ele bounce e reclamação não chegam).
  if (!marketingConfigured(providerOf(settings), { production: !settings.test_mode })) return false;
  return settings.test_mode ? Boolean(settings.test_email?.trim()) : true;
}

// --- Dados do pedido → run -----------------------------------------------------------

function itemsFromOrder(order: ShopifyOrderSummary): RecoveryItem[] {
  return (order.lineItems ?? []).map((li) => ({
    title: li.title,
    quantity: Number(li.quantity) || 1,
    variantTitle: null,
    sku: null,
    productId: li.productId ?? null,
    variantId: null,
    unitPrice: null,
    lineTotal: li.lineTotal ?? null,
    imageUrl: null,
  }));
}

// Campos que a releitura do pedido na Shopify atualiza a cada passo.
function shippingPatch(order: ShopifyOrderSummary): Pick<PostPurchaseRun, "fulfilled_at" | "tracking_number" | "tracking_url" | "tracking_company" | "financial_status" | "cancelled_at"> {
  return {
    fulfilled_at: order.fulfilledAt ?? null,
    tracking_number: order.trackingNumber?.trim() || null,
    tracking_url: order.trackingUrl?.trim() || null,
    tracking_company: order.trackingCompany?.trim() || null,
    financial_status: order.financialStatus ?? null,
    cancelled_at: order.cancelledAt ?? null,
  };
}

// O comprovante automático já saiu (ou está saindo) pra esse e-mail (email_log,
// real, status sent ou sending)? Erro de banco devolve null: quem chama não
// decide o passo 1 sem saber (adia e tenta de novo), pra não mandar em dobro.
async function receiptAlreadySent(admin: SupabaseClient, email: string): Promise<boolean | null> {
  const { count, error } = await admin.from("email_log").select("id", { count: "exact", head: true }).eq("kind", "receipt").eq("is_test", false).in("status", ["sent", "sending"]).eq("to_address", normEmail(email));
  if (error) {
    console.error("welcome receiptAlreadySent:", error.message);
    return null;
  }
  return (count ?? 0) > 0;
}

// A loja tem o comprovante automático ligado e este pedido é elegível a ele
// (feito depois de auto_receipt_since)? Erro de banco = true (adia, falha
// fechado: o comprovante sai primeiro).
async function autoReceiptExpected(admin: SupabaseClient, storeId: string, purchasedAt: string): Promise<boolean> {
  const { data, error } = await admin.from("stores").select("auto_receipt, auto_receipt_since").eq("id", storeId).maybeSingle();
  if (error) {
    console.error("welcome autoReceiptExpected:", error.message);
    return true;
  }
  if (!data?.auto_receipt || !data.auto_receipt_since) return false;
  return new Date(purchasedAt).getTime() >= new Date(data.auto_receipt_since as string).getTime();
}

async function patchRun(admin: SupabaseClient, run: PostPurchaseRun, patch: Partial<PostPurchaseRun>): Promise<void> {
  const full = { ...patch, updated_at: new Date().toISOString() };
  const { error } = await admin.from("post_purchase_runs").update(full).eq("id", run.id);
  if (error) throw new Error(error.message);
  Object.assign(run, full);
}

async function stopRun(ctx: TickContext, run: PostPurchaseRun, status: PostPurchaseRun["status"], reason: string, detail?: unknown): Promise<void> {
  await patchRun(ctx.admin, run, { status, stop_reason: reason, next_at: null, last_event_at: ctx.nowIso });
  await logEvent(ctx.admin, { store_id: run.store_id, run_id: run.id }, { channel: "email", step: welcomeNextStep(ctx, run.store_id, run.step)?.position ?? run.step + 1, type: "stopped", reason, detail });
  ctx.result.welcome.stopped += 1;
}

// Avança o passo: o contador vai pra posição do passo realmente enviado ou
// pulado; o próximo é o seguinte HABILITADO (scheduleAfter, no fuso do país)
// ou o run conclui quando a régua acabou.
async function advanceRun(ctx: TickContext, run: PostPurchaseRun, step: RecoveryStep, settings: RecoverySettings): Promise<void> {
  const next = welcomeNextStep(ctx, run.store_id, step.position);
  const patch: Partial<PostPurchaseRun> = { step: step.position, last_event_at: ctx.nowIso };
  if (next) patch.next_at = scheduleAfter(ctx.now, next.delay_minutes, run.country_code, settings.quiet_hours).toISOString();
  else {
    patch.next_at = null;
    patch.status = "concluido";
  }
  await patchRun(ctx.admin, run, patch);
}

// --- Criação (pedidos pagos recentes → runs) ------------------------------------------

export async function createWelcomeRuns(ctx: TickContext): Promise<void> {
  const { admin } = ctx;
  for (const cred of ctx.creds) {
    if (ctx.onlyStoreId && cred.storeId !== ctx.onlyStoreId) continue;
    if (overDeadline(ctx)) {
      ctx.result.partial = true;
      return;
    }
    const settings = ctx.settings.get(cred.storeId);
    // Sobreposição de 2h com o último tick pra não perder pedido nenhum.
    const base = settings?.last_tick_at ? new Date(settings.last_tick_at) : ctx.now;
    const since = new Date(Math.min(base.getTime(), ctx.now.getTime()) - 2 * HOUR);
    let orders: ShopifyOrderSummary[];
    try {
      orders = await fetchRecentPaidOrders(cred, since.toISOString(), 100);
    } catch (err) {
      ctx.result.errors.push(`pós-compra ${ctx.storeNames.get(cred.storeId) ?? cred.storeId}: pedidos: ${errMsg(err)}`);
      continue;
    }
    // isRenewal já vem de isSubscriptionRenewal (sourceName/etiquetas) no mapOrder.
    // Só pedido com item do Olavita (produto novo não recebe o boas-vindas do
    // Olavita, ver product-gate.ts); filtrado antes de gastar a consulta de 1ª compra.
    const candidates = orders.filter((o) => o.email?.trim() && !o.cancelledAt && !o.isRenewal && isFlowProduct(o.lineItems));
    if (candidates.length === 0) continue;
    // Pedidos já conhecidos nem voltam à Shopify (isFirstPaidOrder custa uma consulta).
    const { data: known, error: knownErr } = await admin.from("post_purchase_runs").select("order_id").eq("store_id", cred.storeId).in("order_id", candidates.map((o) => o.id));
    if (knownErr) {
      ctx.result.errors.push(`pós-compra ${cred.storeId}: ${knownErr.message}`);
      continue;
    }
    const knownIds = new Set((known ?? []).map((r) => String(r.order_id)));
    const first = welcomeNextStep(ctx, cred.storeId, 0); // primeiro habilitado (passo 1 desligado não trava)
    for (const order of candidates) {
      if (knownIds.has(order.id)) continue;
      if (overDeadline(ctx)) {
        ctx.result.partial = true;
        return;
      }
      const email = normEmail(order.email as string);
      let isFirst: boolean;
      try {
        isFirst = await isFirstPaidOrder(cred, email, order.createdAt);
      } catch (err) {
        ctx.result.errors.push(`pós-compra ${order.name}: 1ª compra: ${errMsg(err)}`);
        continue; // sem certeza, não cria (o próximo tick tenta de novo)
      }
      if (!isFirst) continue;
      const country = order.countryCode ?? null;
      const money = customerAmount({ total: order.totalPrice, currency: order.currency, presentmentTotal: order.presentmentTotal, presentmentCurrency: order.presentmentCurrency, country });
      const purchasedAt = new Date(order.createdAt);
      const delay = first ? Math.max(0, first.delay_minutes) : 0;
      const nextAt = delay === 0 ? purchasedAt : scheduleAfter(purchasedAt, delay, country, settings?.quiet_hours);
      const row = {
        store_id: cred.storeId,
        order_id: order.id,
        order_name: order.name,
        email,
        phone: normalizePhone(order.phone, country),
        first_name: order.customerFirstName,
        last_name: order.customerLastName,
        language: orderLanguage({ customerLocale: order.customerLocale, countryCode: country }, () => true),
        country_code: country,
        currency: money?.currency ?? order.presentmentCurrency ?? order.currency ?? null,
        total: money?.amount ?? null,
        items: itemsFromOrder(order),
        purchased_at: order.createdAt,
        ...shippingPatch(order),
        status: "ativo",
        step: 0,
        next_at: nextAt.toISOString(),
        receipt_sent: (await receiptAlreadySent(admin, email)) === true, // processRun relê antes do passo 1
        updated_at: ctx.nowIso,
      };
      // Duplicata (store_id, order_id) é ignorada: só conta o que entrou.
      const { data, error } = await admin.from("post_purchase_runs").upsert(row, { onConflict: "store_id,order_id", ignoreDuplicates: true }).select("id");
      if (error) {
        ctx.result.errors.push(`pós-compra ${order.name}: ${error.message}`);
        continue;
      }
      if ((data ?? []).length > 0) {
        ctx.result.welcome.created += 1;
        ctx.touchedStores.add(cred.storeId);
      }
    }
  }
}

// --- Link do botão "fale conosco" -------------------------------------------------------

// Destino do botão: contact_url da loja; senão mailto do reply_to; senão
// mailto da caixa conectada mais recente da loja; senão null (sem botão).
export async function resolveContactTarget(admin: SupabaseClient, settings: Pick<RecoverySettings, "store_id" | "contact_url" | "reply_to">, orderName: string | null): Promise<string | null> {
  const url = settings.contact_url?.trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  const subject = orderName ? `?subject=${encodeURIComponent(orderName)}` : "";
  const replyTo = settings.reply_to?.trim();
  if (replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(replyTo)) return `mailto:${replyTo}${subject}`;
  const { data } = await admin.from("store_email_accounts").select("email_address").eq("store_id", settings.store_id).not("connected_at", "is", null).order("connected_at", { ascending: false }).limit(1);
  const mailbox = (data?.[0]?.email_address as string | undefined)?.trim();
  return mailbox ? `mailto:${mailbox}${subject}` : null;
}

// --- Montagem do passo --------------------------------------------------------------------

// Página de rastreio: Israel vai pro 17track (o Ian liberou); fora de Israel,
// a URL da transportadora ou a página de status do pedido na Shopify. Sem
// nada, vazio (a linha com {{link_rastreio}} some no render).
export function trackingLinkFor(run: Pick<PostPurchaseRun, "country_code" | "tracking_number" | "tracking_url">, statusPageUrl?: string | null): string {
  const code = run.tracking_number?.trim();
  if (code && (run.country_code ?? "").toUpperCase() === "IL") return `https://t.17track.net/en#nums=${encodeURIComponent(code)}`;
  return run.tracking_url?.trim() || statusPageUrl?.trim() || "";
}

export function prepareWelcomeStep(input: { run: PostPurchaseRun; step: RecoveryStep; settings: RecoverySettings; products: Products | null; storeName: string | null; contactTarget: string | null; statusPageUrl?: string | null; isTest?: boolean }): PrepareOutcome {
  const { run, step, settings } = input;
  const isTest = Boolean(input.isTest);
  const body = pickStepBody(step, run.language, run.country_code, 0);
  if (!body) return { error: "sem_idioma", detail: `passo ${step.position} (pós-compra) sem texto em ${run.language ?? "?"} nem em en` };
  const lang = body.lang;
  const t = emailLabels(lang);
  const info = resolveBrand(input.products, run, input.storeName);
  const agent = agentNameFor(settings, info, lang);
  // O link rastreado só existe quando há pra onde mandar (sem destino, sem botão).
  const link = input.contactTarget ? clickLink(run.id, step.position, "email", null, isTest, "run") : "";
  const unsubscribeUrl = unsubscribeLink(run.id, "email", isTest, "run");
  const vars = buildVars(run, info, lang, {
    agent,
    link,
    code: null,
    percent: null,
    pedido: run.order_name ?? "",
    rastreio: run.tracking_number?.trim() ?? "",
    linkRastreio: trackingLinkFor(run, input.statusPageUrl),
  });

  const text = stripDashes(renderTemplate(body.text, vars));
  if (!text) return { error: "sem_texto", detail: "texto vazio depois de renderizar" };
  const leak = portugueseLeak(text, lang);
  if (leak.length > 0) return { error: "idioma", detail: leak.join(", ") };
  const orderTitle = `${t.order} ${run.order_name ?? ""}`.trim();
  const subject = stripDashes(renderTemplate(pickStepSubject(step, lang), vars)) || orderTitle;
  if (portugueseLeak(subject, lang).length > 0) return { error: "idioma", detail: `assunto: ${portugueseLeak(subject, lang).join(", ")}` };
  const extras = renderExtras(step, lang, vars);
  if ("error" in extras) return extras;
  const buttonLabel = extras.buttonLabel || t.contact;

  const out: PreparedStep = {
    lang,
    text,
    textPt: body.textPt ? renderTemplate(body.textPt, vars) : null,
    subject,
    preheader: extras.preheader || undefined,
    buttonLabel,
    code: null,
    percent: null,
    link,
    unsubscribeUrl,
  };
  out.html = buildRecoveryEmailHtml({
    brand: info.brand,
    language: lang,
    bodyHtmlOrText: text,
    items: run.items ?? [],
    total: run.total,
    currency: run.currency,
    link,
    buttonLabel,
    unsubscribeUrl,
    subject: orderTitle, // <title> do HTML com o número do pedido
    preheader: out.preheader,
    itemsLabel: orderTitle,
    unsubscribeLabel: t.unsubscribeOrder,
  });
  out.emailText = buildRecoveryEmailText({ bodyText: text, link, unsubscribeUrl, language: lang, buttonLabel, unsubscribeLabel: t.unsubscribeOrder });
  return out;
}

// --- Processamento -----------------------------------------------------------------------------

interface RunContext {
  settings: RecoverySettings;
  cred: ShopifyCredentials;
  contactTarget: string | null;
}

async function processRun(ctx: TickContext, run: PostPurchaseRun, rc: RunContext): Promise<void> {
  const { admin, now, nowIso } = ctx;
  const { settings } = rc;
  const target: EventTarget = { store_id: run.store_id, run_id: run.id };
  const inMin = (m: number) => new Date(now.getTime() + m * MIN).toISOString();
  const label = run.order_name ?? run.id;
  ctx.touchedStores.add(run.store_id);

  // Pedido anterior ao início do fluxo: nunca entra (fica visível como pausado).
  if (!settings.welcome_since || new Date(run.purchased_at).getTime() < new Date(settings.welcome_since).getTime()) {
    await patchRun(admin, run, { status: "pausado", stop_reason: "anterior_ao_inicio", next_at: null, last_event_at: nowIso });
    return;
  }
  // Corte de lançamento (igual ao do carrinho). PRODUÇÃO: só pedido feito
  // depois de max(welcome_since, production_since); sem production_since,
  // ninguém entra (falha fechado). TESTE: só runs ainda não iniciados com
  // pedido das últimas 24 h (o teste vai pro dono, mas não despeja o histórico).
  const purchasedMs = new Date(run.purchased_at).getTime();
  const launchCut = settings.test_mode
    ? run.step === 0
      ? now.getTime() - 24 * HOUR
      : Number.NEGATIVE_INFINITY
    : settings.production_since
      ? Math.max(new Date(settings.welcome_since).getTime(), new Date(settings.production_since).getTime())
      : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(purchasedMs) || purchasedMs < launchCut) {
    await patchRun(admin, run, { status: "pausado", stop_reason: "anterior_ao_lancamento", next_at: null, last_event_at: nowIso });
    return;
  }
  // Idioma não liberado na loja (send_languages): o run fica pausado.
  if (!languageAllowed(settings, run.language)) {
    await patchRun(admin, run, { status: "pausado", stop_reason: "idioma_nao_liberado", next_at: null, last_event_at: nowIso });
    return;
  }
  // Atraso máximo: passo vencido há mais de 12 h não sai (reabilitar o fluxo
  // não despeja backlog). Reagenda a partir de agora, mesmo passo.
  if (isTooLate(run.next_at, now)) {
    const lateStep = welcomeNextStep(ctx, run.store_id, run.step);
    if (lateStep) {
      const at = await rescheduleLateStep(admin, { target, channel: "email", position: lateStep.position, delayMinutes: lateStep.delay_minutes, countryCode: run.country_code, quiet: settings.quiet_hours, dueAt: run.next_at as string, now, isTest: settings.test_mode });
      await patchRun(admin, run, { next_at: at, last_event_at: nowIso });
      ctx.result.welcome.skipped += 1;
      return;
    }
  }
  // Horário silencioso no fuso do país do pedido.
  if (!isAllowedNow(now, run.country_code, settings.quiet_hours)) {
    await patchRun(admin, run, { next_at: nextAllowedTime(now, run.country_code, settings.quiet_hours).toISOString() });
    return;
  }

  // Releitura do pedido na Shopify: envio, rastreio, pagamento, cancelamento.
  let order: ShopifyOrderSummary | null;
  try {
    order = await fetchOrderById(rc.cred, run.order_id);
  } catch (err) {
    if (!(await skippedToday(admin, target, "erro_na_verificacao", now))) {
      await logEvent(admin, target, { channel: "email", step: welcomeNextStep(ctx, run.store_id, run.step)?.position ?? run.step + 1, type: "skipped", reason: "erro_na_verificacao", detail: errMsg(err) });
    }
    await patchRun(admin, run, { next_at: inMin(6 * 60), last_event_at: nowIso });
    ctx.result.welcome.skipped += 1;
    ctx.result.errors.push(`pós-compra ${label}: Shopify: ${errMsg(err)}`);
    return;
  }
  if (!order) {
    await stopRun(ctx, run, "parado_cancelado", "pedido_nao_encontrado");
    return;
  }
  await patchRun(admin, run, shippingPatch(order));
  // Pedido sem item do Olavita (produto novo): nada do boas-vindas sai.
  // Confere no pedido relido E no gravado no run (falha fechado).
  if (!isFlowProduct(order.lineItems) || !isFlowProduct(run.items)) {
    await patchRun(admin, run, { status: "pausado", stop_reason: FLOW_PRODUCT_STOP, next_at: null, last_event_at: nowIso });
    return;
  }
  if (order.cancelledAt) {
    await stopRun(ctx, run, "parado_cancelado", "cancelado", { cancelledAt: order.cancelledAt });
    return;
  }
  if (STOP_FINANCIAL.test(order.financialStatus ?? "")) {
    await stopRun(ctx, run, "parado_cancelado", "reembolsado", { financialStatus: order.financialStatus });
    return;
  }
  // Supressão (descadastro, bounce, reclamação, pedido pra parar).
  const email = run.email ? normEmail(run.email) : null;
  if (!email) {
    await stopRun(ctx, run, "concluido", "sem_email");
    return;
  }
  const { data: sup, error: supErr } = await admin.from("recovery_suppressions").select("reason").eq("address", email).in("channel", ["email", "all"]).limit(1);
  if (supErr) {
    // Sem saber se a pessoa pediu pra parar, nada sai (falha fechado).
    await patchRun(admin, run, { next_at: inMin(30) });
    ctx.result.errors.push(`pós-compra ${label}: supressão: ${supErr.message}`);
    return;
  }
  if ((sup ?? []).length > 0) {
    await stopRun(ctx, run, "parado_suprimido", "suprimido", { reason: sup?.[0]?.reason });
    return;
  }
  // Endereço com erro de digitação, domínio sem MX ou caixa inexistente
  // (10/10: 2 dos 20 primeiros e-mails de boas-vindas voltaram, 10% de bounce
  // na conta): verificado antes do PRIMEIRO e-mail do run, igual ao carrinho.
  // Inválido ou descartável = supressão e o run para; nada sai para ele.
  if (!settings.test_mode && run.step === 0) {
    const problem = await emailAddressProblem(email);
    const verdict = problem ? null : await verifyEmailAddress(email);
    if (problem || verdict?.block) {
      if (verdict?.block) {
        const supIns = await admin.from("recovery_suppressions").upsert({ store_id: null, channel: "email", address: email, reason: "bounced", source: "qev" }, { onConflict: "channel,address", ignoreDuplicates: true });
        if (supIns.error) console.error("supressão qev (pós-compra):", supIns.error.message);
      }
      await stopRun(ctx, run, "parado_suprimido", "email_invalido", problem ? { problem } : { verificador: "qev", result: verdict?.result, reason: verdict?.reason, did_you_mean: verdict?.didYouMean });
      return;
    }
  }

  // Passo da vez.
  const step = welcomeNextStep(ctx, run.store_id, run.step);
  if (!step) {
    await patchRun(admin, run, { status: "concluido", next_at: null, last_event_at: nowIso });
    return;
  }
  const position = step.position;
  const skipStep = async (reason: string, detail?: unknown) => {
    await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason, detail, isTest: settings.test_mode });
    await advanceRun(ctx, run, step, settings);
    ctx.result.welcome.skipped += 1;
  };

  // Condição do passo em relação ao envio na Shopify.
  if (step.send_if === "enviado" && !run.fulfilled_at) {
    const ageDays = (now.getTime() - new Date(run.purchased_at).getTime()) / (24 * HOUR);
    if (ageDays >= FULFILLMENT_WAIT_DAYS) {
      await skipStep("nunca_enviado", { days: Math.floor(ageDays) });
      return;
    }
    if (!(await skippedToday(admin, target, "aguardando_envio", now))) {
      await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason: "aguardando_envio" });
    }
    await patchRun(admin, run, { next_at: inMin(6 * 60), last_event_at: nowIso });
    ctx.result.welcome.skipped += 1;
    return;
  }
  if (step.send_if === "nao_enviado" && run.fulfilled_at) {
    await skipStep("ja_enviado", { fulfilledAt: run.fulfilled_at });
    return;
  }
  // Passo 1 e comprovante automático: relê o email_log agora (o run foi
  // criado minutos antes e o comprovante pode ter saído depois). Comprovante
  // já enviado: a pessoa não recebe dois e-mails no dia 0 (se a opção estiver
  // ligada). Comprovante esperado e ainda não enviado, pedido com menos de 20
  // min: adia o passo 1 pra depois dos 20 min SEM consumir o passo, pro
  // comprovante sair primeiro.
  if (position === 1) {
    if (!run.receipt_sent) {
      const sentNow = await receiptAlreadySent(admin, email);
      if (sentNow === null) {
        // Sem saber se o comprovante saiu, o passo 1 não é decidido agora.
        await patchRun(admin, run, { next_at: inMin(30) });
        return;
      }
      if (sentNow) await patchRun(admin, run, { receipt_sent: true });
    }
    if (run.receipt_sent && settings.welcome_skip_first_if_receipt) {
      await skipStep("comprovante_ja_enviado");
      return;
    }
    const holdUntil = purchasedMs + RECEIPT_GRACE_MS;
    if (!run.receipt_sent && now.getTime() < holdUntil && (await autoReceiptExpected(admin, run.store_id, run.purchased_at))) {
      await patchRun(admin, run, { next_at: new Date(holdUntil).toISOString() });
      return;
    }
  }

  // Teto diário (compartilhado com o carrinho) e contenção do modo de teste.
  const testKey = `${run.store_id}:email`;
  if (settings.test_mode) {
    if ((ctx.testThisTick.get(testKey) ?? 0) >= TEST_MAX_PER_TICK) {
      await patchRun(admin, run, { next_at: inMin(10) });
      return;
    }
    if ((await dailyCount(ctx, run.store_id, "email", true)) >= TEST_DAILY_CAP) {
      await patchRun(admin, run, { next_at: inMin(60) });
      return;
    }
  } else if ((await dailyCount(ctx, run.store_id, "email", false)) >= effectiveEmailCap(ctx, settings)) {
    await patchRun(admin, run, { next_at: inMin(60) });
    return;
  }
  // Trava anti-rajada (mesma do carrinho, mesmo canal): um e-mail automático
  // da loja de cada vez, PACE_GAP_SEC.email entre dois quaisquer. Os pedidos
  // da madrugada não saem todos às 9h.
  const freeAt = await paceFreeAt(ctx, run.store_id, "email", settings.test_mode);
  if (freeAt > Date.now()) {
    await patchRun(admin, run, { next_at: new Date(freeAt + Math.floor(Math.random() * 20_000)).toISOString() });
    return;
  }
  const fromEmail = settings.from_email?.trim();
  if (!fromEmail) {
    await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason: "sem_remetente" });
    await patchRun(admin, run, { next_at: inMin(6 * 60), last_event_at: nowIso });
    ctx.result.welcome.skipped += 1;
    return;
  }
  // DNS do remetente: em produção, sem verificação nada sai; em teste só avisa.
  const dns = await senderDns(ctx, fromEmail);
  if (!dns.ok) {
    if (!settings.test_mode) {
      await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason: "dns_nao_verificado", detail: { domain: dns.domain, problems: dns.problems } });
      await patchRun(admin, run, { next_at: inMin(6 * 60), last_event_at: nowIso });
      ctx.result.welcome.skipped += 1;
      return;
    }
    console.warn(`pós-compra: DNS do remetente ${fromEmail} sem verificação (${dns.problems.join("; ")}); em teste segue.`);
  }
  const to = settings.test_mode ? settings.test_email?.trim().toLowerCase() || null : email;
  if (!to) {
    await patchRun(admin, run, { next_at: inMin(30) });
    return;
  }
  // Intervalo mínimo entre e-mails de marketing pro mesmo endereço (qualquer
  // loja, qualquer fluxo): adia sem consumir o passo, 1 evento por dia.
  const gap = await minGapBlock(admin, to, settings, now, { target, delayMinutes: step.delay_minutes });
  if (gap.blocked) {
    if (!(await skippedToday(admin, target, "intervalo_minimo", now))) {
      await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason: "intervalo_minimo", detail: { lastAt: gap.lastAt, until: gap.until.toISOString() } });
    }
    await patchRun(admin, run, { next_at: nextAllowedTime(gap.until, run.country_code, settings.quiet_hours).toISOString(), last_event_at: nowIso });
    ctx.result.welcome.skipped += 1;
    return;
  }

  // Texto, link, HTML.
  const prepared = prepareWelcomeStep({ run, step, settings, products: await productsFor(ctx, run.store_id), storeName: ctx.storeNames.get(run.store_id) ?? null, contactTarget: rc.contactTarget, statusPageUrl: order.statusPageUrl, isTest: settings.test_mode });
  if ("error" in prepared) {
    if (prepared.error === "sem_idioma") {
      // Sem texto no idioma do cliente nem em inglês: avança (spec v2 §1.2).
      await skipStep("sem_idioma", prepared.detail);
      return;
    }
    await logEvent(admin, target, { channel: "email", step: position, type: "skipped", reason: prepared.error, detail: prepared.detail, isTest: settings.test_mode });
    await patchRun(admin, run, { next_at: inMin(6 * 60), last_event_at: nowIso });
    ctx.result.welcome.skipped += 1;
    return;
  }

  // TRAVA antes de enviar.
  const dedupeKey = welcomeDedupeKey(run, position, settings.test_mode, now);
  const claim = await claimEvent(admin, { target, channel: "email", position, dedupeKey, code: null, to, language: prepared.lang, isTest: settings.test_mode });
  if (!claim.ok) {
    if (claim.reason === "duplicate") {
      await advanceRun(ctx, run, step, settings); // já saiu antes: avança sem enviar
      return;
    }
    ctx.result.errors.push(`pós-compra ${label}: trava não gravada: ${claim.message}`);
    await patchRun(admin, run, { next_at: inMin(30) });
    return;
  }
  if (await paceConflict(admin, { claimId: claim.id, claimAt: claim.createdAt, storeId: run.store_id, channel: "email", isTest: settings.test_mode })) {
    await releasePacedClaim(admin, claim.id);
    markPace(ctx, run.store_id, "email", settings.test_mode);
    await patchRun(admin, run, { next_at: new Date(Date.now() + PACE_GAP_SEC.email * 1000 + Math.floor(Math.random() * 20_000)).toISOString() });
    return;
  }

  let outcome: SendOutcome;
  try {
    outcome = await deliverEmail({ settings, prepared, to, dedupeKey, isTest: settings.test_mode, tags: { run_id: run.id, step: String(position), channel: "email", store_id: run.store_id, flow: "pos_compra" } });
  } catch (err) {
    outcome = { ok: false, error: errMsg(err) };
  }
  markPace(ctx, run.store_id, "email", settings.test_mode);
  if (!outcome.ok && outcome.ambiguous) {
    // Falha ambígua: o e-mail pode ter saído. Mantém a trava, não retenta,
    // avança o passo e abre alerta (nunca duplicar pro mesmo cliente).
    await registerAmbiguousSend(admin, { claimId: claim.id, storeId: run.store_id, channel: "email", position, label, error: outcome.error });
    ctx.result.errors.push(`pós-compra ${label} passo ${position}: envio ambíguo (não retentado): ${outcome.error}`);
    await advanceRun(ctx, run, step, settings);
    return;
  }
  if (!outcome.ok && outcome.quota) {
    // Cota/limite do provedor (mesma regra do carrinho): libera a trava SEM
    // contar tentativa, não avança, adia 60 min e segura a loja no tick.
    await markEventQuota(admin, claim.id, outcome.error);
    (ctx.emailQuotaBlocked ??= new Set()).add(run.store_id);
    ctx.result.errors.push(`pós-compra ${label} passo ${position}: cota do provedor (adiado ${EMAIL_QUOTA_BACKOFF_MIN} min, sem contar tentativa): ${outcome.error}`);
    await patchRun(admin, run, { next_at: inMin(EMAIL_QUOTA_BACKOFF_MIN), last_event_at: nowIso });
    return;
  }
  if (!outcome.ok) {
    await markEventFailed(admin, claim.id, outcome.error);
    ctx.result.errors.push(`pós-compra ${label} passo ${position}: ${outcome.error}`);
    if ((await countFailed(admin, target, "email", position)) >= 3) {
      await skipStep("max_tentativas", outcome.error);
    } else {
      await patchRun(admin, run, { next_at: inMin(30), last_event_at: nowIso });
    }
    return;
  }

  await markEventSent(admin, claim.id, { messageId: outcome.messageId, provider: outcome.provider });
  await advanceRun(ctx, run, step, settings);
  ctx.result.welcome.sent += 1;
  bumpDaily(ctx, run.store_id, "email", settings.test_mode);
  if (settings.test_mode) ctx.testThisTick.set(testKey, (ctx.testThisTick.get(testKey) ?? 0) + 1);
}

export async function processWelcomeRuns(ctx: TickContext): Promise<void> {
  const { admin } = ctx;
  // Lojas com recusa por cota do provedor nos últimos 60 min (carrinho ou
  // pós-compra, mesmo provedor): o pós-compra delas espera.
  const quotaBlocked = await quotaBlockedStores(ctx);
  for (const settings of ctx.settings.values()) {
    if (ctx.onlyStoreId && settings.store_id !== ctx.onlyStoreId) continue;
    // Fluxo desligado (ou sem provedor/data/e-mail de teste): a loja não é
    // tocada neste tick. Quando ligar, os runs vencidos saem na ordem.
    if (!canSendWelcome(settings)) continue;
    if (quotaBlocked.has(settings.store_id)) continue;
    const cred = ctx.creds.find((c) => c.storeId === settings.store_id);
    if (!cred) continue; // sem Shopify não dá pra reler o pedido: nada sai
    if (overDeadline(ctx)) {
      ctx.result.partial = true;
      return;
    }
    const { data, error } = await admin.from("post_purchase_runs").select("*").eq("store_id", settings.store_id).eq("status", "ativo").lte("next_at", ctx.nowIso).order("next_at", { ascending: true }).limit(50);
    if (error) {
      ctx.result.errors.push(`pós-compra ${ctx.storeNames.get(settings.store_id) ?? settings.store_id}: ${error.message}`);
      continue;
    }
    const runs = (data ?? []) as PostPurchaseRun[];
    if (runs.length === 0) continue;
    // Destino do botão "fale conosco" (sem número do pedido: a rota /r monta
    // o mailto com o pedido certo na hora do clique).
    let contactTarget: string | null = null;
    try {
      contactTarget = await resolveContactTarget(admin, settings, null);
    } catch (err) {
      console.error("pós-compra contactTarget:", err);
    }
    for (const run of runs) {
      if (overDeadline(ctx)) {
        ctx.result.partial = true;
        return;
      }
      // Cota estourou neste tick (aqui ou no carrinho): o resto da loja espera.
      if (ctx.emailQuotaBlocked?.has(settings.store_id)) break;
      try {
        await processRun(ctx, run, { settings, cred, contactTarget });
      } catch (err) {
        ctx.result.errors.push(`pós-compra ${run.order_name ?? run.id}: ${errMsg(err)}`);
        console.error("welcome tick:", run.id, err);
      }
    }
  }
}

// --- Prévia e teste de um passo (painel) --------------------------------------------------------

async function loadPrepareDeps(admin: SupabaseClient, settings: RecoverySettings, run: PostPurchaseRun): Promise<{ products: Products; storeName: string | null; contactTarget: string | null }> {
  const [{ data: store }, products, contactTarget] = await Promise.all([
    admin.from("stores").select("name").eq("id", run.store_id).maybeSingle(),
    loadProducts(admin, run.store_id),
    resolveContactTarget(admin, settings, run.order_name).catch(() => null),
  ]);
  return { products, storeName: (store?.name as string | undefined) ?? null, contactTarget };
}

// Só a prévia (sem enviar nada).
export async function previewWelcomeStep(admin: SupabaseClient, input: { run: PostPurchaseRun; step: RecoveryStep; settings: RecoverySettings }): Promise<PrepareOutcome> {
  const deps = await loadPrepareDeps(admin, input.settings, input.run);
  return prepareWelcomeStep({ run: input.run, step: input.step, settings: input.settings, ...deps, isTest: input.settings.test_mode });
}

// "Testar este passo" do pós-compra: renderiza pra um run (real ou fictício)
// e envia SÓ pro destino informado. Mesma forma de sendStepTo: sem gate de
// enabled, com provedor e remetente obrigatórios, trava com sufixo de teste,
// links com t:1 e tag test=1. Não avança o run.
export async function sendWelcomeStepTo(admin: SupabaseClient, input: { run: PostPurchaseRun; step: RecoveryStep; settings: RecoverySettings; to: string; isTest: boolean }): Promise<{ ok: boolean; preview: { subject?: string; text: string; html?: string }; error?: string }> {
  const { run, step, settings } = input;
  const to = input.to.trim().toLowerCase();
  const empty = { text: "" };
  if (!to) return { ok: false, preview: empty, error: "Informe o e-mail de teste." };
  const provider = providerOf(settings);
  if (!marketingConfigured(provider)) return { ok: false, preview: empty, error: provider === "ses" ? "Amazon SES não configurado (AWS_SES_REGION / credenciais)." : "RESEND_API_KEY não configurada." };
  if (!settings.from_email?.trim()) return { ok: false, preview: empty, error: "Configure o remetente (from_email) da loja antes de testar." };

  const deps = await loadPrepareDeps(admin, settings, run);
  const prepared = prepareWelcomeStep({ run, step, settings, ...deps, isTest: input.isTest });
  if ("error" in prepared) return { ok: false, preview: empty, error: `${prepared.error}${prepared.detail ? `: ${prepared.detail}` : ""}` };
  const preview = { subject: prepared.subject, text: prepared.emailText ?? prepared.text, html: prepared.html };
  if (!input.isTest) {
    const dns = await senderDns({ dns: new Map() }, settings.from_email as string);
    if (!dns.ok) return { ok: false, preview, error: `DNS do remetente ${settings.from_email} sem verificação (${dns.problems.join("; ")}). Nada foi enviado.` };
  }

  const now = new Date();
  const target: EventTarget = { store_id: run.store_id, run_id: run.id };
  const dedupeKey = welcomeDedupeKey(run, step.position, input.isTest, now);
  const claim = await claimEvent(admin, { target, channel: "email", position: step.position, dedupeKey, code: null, to, language: prepared.lang, isTest: input.isTest });
  let claimId: string | null = null;
  if (claim.ok) claimId = claim.id;
  else if (claim.reason === "duplicate") return { ok: false, preview, error: input.isTest ? "Esse passo já foi testado neste minuto. Aguarde 1 minuto e tente de novo." : "Esse passo já foi enviado para esse pedido." };
  else if (claim.reason === "missing_recovery" && input.isTest) console.warn("sendWelcomeStepTo: pedido fictício, teste sem trava:", claim.message);
  else return { ok: false, preview, error: `Não consegui registrar o envio (nada foi mandado): ${claim.message}` };

  let outcome: SendOutcome;
  try {
    outcome = await deliverEmail({ settings, prepared, to, dedupeKey, isTest: input.isTest, tags: { run_id: run.id, step: String(step.position), channel: "email", store_id: run.store_id, flow: "pos_compra" } });
  } catch (err) {
    outcome = { ok: false, error: errMsg(err) };
  }
  if (!outcome.ok) {
    // Ambíguo: mantém a trava do minuto (não reenvia por engano); definitivo libera.
    if (claimId) await (outcome.ambiguous ? markEventAmbiguous(admin, claimId, outcome.error) : outcome.quota ? markEventQuota(admin, claimId, outcome.error) : markEventFailed(admin, claimId, outcome.error));
    return { ok: false, preview, error: outcome.ambiguous ? `${outcome.error} (resposta ambígua: o e-mail pode ter saído, confira antes de testar de novo)` : outcome.error };
  }
  if (claimId) await markEventSent(admin, claimId, { messageId: outcome.messageId, provider: outcome.provider });
  return { ok: true, preview };
}

// Run fictício pra prévia/teste quando a loja ainda não tem pedido (só em
// memória; a trava não grava porque o id não existe, e o destino é o de
// teste). `language` decide nome, país e moeda de exemplo.
export function fakeWelcomeRun(storeId: string, language: string, to: string, opts: { fulfilled?: boolean } = {}): PostPurchaseRun {
  const sample: Record<string, { first: string; product: string; country: string; currency: string }> = {
    he: { first: "נועה", product: "Olavita", country: "IL", currency: "ILS" },
    fr: { first: "Camille", product: "OstéoPure", country: "FR", currency: "EUR" },
    bg: { first: "Мария", product: "Olavita", country: "BG", currency: "EUR" },
    hu: { first: "Eszter", product: "Olavita", country: "HU", currency: "EUR" },
    ro: { first: "Ana", product: "Olavita", country: "RO", currency: "EUR" },
    tr: { first: "Elif", product: "Olavita", country: "TR", currency: "EUR" },
    en: { first: "Emma", product: "Olavita", country: "US", currency: "EUR" },
  };
  const s = sample[language] ?? sample.en;
  const now = new Date();
  const nowIso = now.toISOString();
  const fulfilled = opts.fulfilled !== false;
  return {
    id: "00000000-0000-4000-8000-000000000000",
    store_id: storeId,
    order_id: "gid://shopify/Order/0",
    order_name: "#TESTE",
    email: to,
    phone: null,
    first_name: s.first,
    last_name: null,
    language,
    country_code: s.country,
    currency: s.currency,
    total: 199,
    items: [{ title: s.product, quantity: 1, variantTitle: null, sku: null, productId: null, variantId: null, unitPrice: null, lineTotal: "199.00", imageUrl: null }],
    purchased_at: new Date(now.getTime() - 5 * 24 * HOUR).toISOString(),
    fulfilled_at: fulfilled ? new Date(now.getTime() - 2 * 24 * HOUR).toISOString() : null,
    tracking_number: fulfilled ? "RR123456789IL" : null,
    tracking_url: null,
    tracking_company: fulfilled ? "Israel Post" : null,
    financial_status: "PAID",
    cancelled_at: null,
    status: "ativo",
    step: 0,
    next_at: null,
    receipt_sent: false,
    stop_reason: null,
    last_event_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
