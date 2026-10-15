import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAllShopifyCreds } from "@/lib/agent/analyze";
import { fetchRecentPaidOrders, isFirstPaidOrder, type ShopifyOrderSummary } from "@/lib/shopify/orders";
import { loadProducts, routeProduct } from "@/lib/agent/products";
import { isFlowProduct } from "@/lib/recovery/product-gate";
import { orderLanguage } from "@/lib/forms/money";
import { RECEIPT_STRINGS } from "@/lib/receipts/strings";

const receiptLang = (order: { customerLocale?: string | null; countryCode: string | null }) => orderLanguage(order, (l) => l in RECEIPT_STRINGS);
import { localizeItemTitles } from "@/lib/forms/item-titles";
import { buildReceipt } from "@/lib/receipts/build";
import { sendReply } from "@/lib/email/send-reply";
import { fetchLogoBuffer } from "@/lib/agent/auto-ack";
import { brandLook } from "@/lib/receipts/build";
import { pickLetter } from "@/lib/receipts/letter";
import { claimSend, markFailed, markSent, normEmail, receiptKey, withPixel } from "@/lib/email/log";

// Recibo da COMPRA INICIAL (não depende da notificação de pedido da
// Shopify), sem contar cobrança seguinte de assinatura.
//
// 100% MANUAL (20/09/2026): um bug fez isso mandar o mesmo comprovante 15x
// pro mesmo pedido, porque a tabela auto_receipts nunca tinha sido criada
// (migration 0014 pendente) e a checagem de duplicidade falhava calada,
// deixando passar em vez de travar. Corrigido pra falhar fechado, mas o
// Ian pediu que NADA disso rode sozinho — cada envio é um clique dele na
// aba "E-mail de confirmação". Nada aqui é chamado pelo cron.
const MISSING_TABLE = /email_log|does not exist|schema cache/i;

export interface ReceiptCandidate {
  storeId: string;
  storeName: string;
  orderId: string;
  orderName: string;
  brand: string | null;
  email: string;
  customerName: string | null;
  language: string;
  subject: string;
  html: string;
  createdAt: string;
  alreadySent: { status: string; created_at: string } | null;
}

// Roda um lote de tarefas com no máximo `limit` em paralelo — sem isso, cada
// pedido (isFirstPaidOrder + tradução dos itens) roda em série e a lista
// estoura os 60s da função com poucas dezenas de pedidos.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Acha rápido UM pedido recente que é compra inicial, sem montar o recibo de
// todo mundo — usado pra escolher o exemplo do teste sem estourar tempo.
export async function pickRecentFirstOrder(admin: SupabaseClient): Promise<{ storeId: string; orderId: string } | null> {
  const creds = await loadAllShopifyCreds(admin, null);
  for (const cred of creds) {
    let orders: ShopifyOrderSummary[];
    try {
      orders = await fetchRecentPaidOrders(cred, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), 10);
    } catch {
      continue;
    }
    for (const order of orders) {
      if (order.cancelledAt || !order.email || order.isRenewal) continue;
      if (await isFirstPaidOrder(cred, order.email, order.createdAt)) return { storeId: cred.storeId, orderId: order.id };
    }
  }
  return null;
}

export async function listReceiptCandidates(admin: SupabaseClient, days = 3): Promise<{ candidates: ReceiptCandidate[]; migrationMissing: boolean }> {
  const creds = await loadAllShopifyCreds(admin, null);
  const products = await loadProducts(admin);
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  let migrationMissing = false;

  const perStore = await Promise.all(
    creds.map(async (cred) => {
      let orders: ShopifyOrderSummary[];
      try {
        orders = await fetchRecentPaidOrders(cred, sinceIso, 100);
      } catch (err) {
        console.error("receipts/pending fetch:", cred.storeName, err instanceof Error ? err.message : err);
        return [] as ReceiptCandidate[];
      }
      const usable = orders.filter((o) => !o.cancelledAt && o.email && !o.isRenewal);
      const rows = await mapWithConcurrency(usable, 6, async (order): Promise<ReceiptCandidate | null> => {
        const isFirst = await isFirstPaidOrder(cred, order.email as string, order.createdAt);
        if (!isFirst) return null;

        // "Já enviado" é por E-MAIL do cliente (um comprovante por e-mail, pra
        // sempre) — não por pedido.
        const { data: alreadyRows, error: checkError } = await admin.from("email_log").select("status, created_at").eq("kind", "receipt").eq("is_test", false).eq("to_address", normEmail(order.email as string)).in("status", ["sent", "sending"]).order("created_at", { ascending: false }).limit(1);
        if (checkError && MISSING_TABLE.test(checkError.message)) migrationMissing = true;
        const already = alreadyRows?.[0] ?? null;

        const product = routeProduct(products, { storeId: cred.storeId, recipients: [], texts: [], orderTitles: order.lineItems.map((li) => li.title) });
        const brand = product?.name?.split(/\s+/)[0] ?? null;
        const language = receiptLang(order);
        const itemTitles = await localizeItemTitles(order.lineItems.map((li) => li.title), language);
        const receipt = buildReceipt({ order, brand: brand ?? cred.storeName, language, customerName: order.customerFirstName, itemTitles });

        return {
          storeId: cred.storeId,
          storeName: cred.storeName,
          orderId: order.id,
          orderName: order.name,
          brand,
          email: order.email as string,
          customerName: order.customerFirstName,
          language,
          subject: receipt.subject,
          html: receipt.html,
          createdAt: order.createdAt,
          alreadySent: already ? { status: already.status === "sent" ? "enviado" : "enviando", created_at: already.created_at as string } : null,
        };
      });
      return rows.filter((r): r is ReceiptCandidate => r !== null);
    })
  );
  const candidates = perStore.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { candidates, migrationMissing };
}

interface ResolvedReceipt {
  order: ShopifyOrderSummary & { email: string };
  account: { smtp_host: string; smtp_port: number; email_address: string; credential_encrypted: string };
  brand: string;
  receipt: ReturnType<typeof buildReceipt>;
}

async function resolveReceiptForOrder(admin: SupabaseClient, storeId: string, orderId: string, languageOverride?: string): Promise<ResolvedReceipt | { error: string }> {
  const creds = await loadAllShopifyCreds(admin, storeId);
  const cred = creds.find((c) => c.storeId === storeId);
  if (!cred) return { error: "Loja não conectada à Shopify." };

  let order: ShopifyOrderSummary | undefined;
  try {
    const recent = await fetchRecentPaidOrders(cred, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), 200);
    order = recent.find((o) => o.id === orderId);
  } catch (err) {
    return { error: `Falha ao buscar o pedido na Shopify: ${(err as Error).message}` };
  }
  if (!order || !order.email) return { error: "Pedido não encontrado (pode já ter saído da janela de 30 dias)." };

  const products = await loadProducts(admin);
  const product = routeProduct(products, { storeId, recipients: [], texts: [], orderTitles: order.lineItems.map((li) => li.title) });
  const brand = product?.name?.split(/\s+/)[0] ?? cred.storeName;

  // Caixa que envia: a da MARCA do pedido quando a loja tem mais de uma
  // (OsteoPure sai de support@osteopure.fr; Olavita sai de
  // help@skininsiderdaily.com) — nunca comprovante de uma marca saindo do
  // endereço da outra. Sem caixa da marca, vale a conectada mais recente.
  const { data: accounts } = await admin.from("store_email_accounts").select("*").eq("store_id", storeId).not("connected_at", "is", null).order("connected_at", { ascending: false });
  const brandKey = brand.toLowerCase().replace(/[^a-z]/g, "");
  const domainHints: Record<string, string[]> = { olavita: ["skininsiderdaily", "olavita"], osteopure: ["osteopure"] };
  const hints = Object.entries(domainHints).find(([k]) => brandKey.startsWith(k))?.[1] ?? [brandKey];
  const account = (accounts ?? []).find((a) => hints.some((h) => h && String(a.email_address).toLowerCase().includes(h))) ?? (accounts ?? [])[0];
  if (!account) return { error: "Nenhuma caixa de e-mail conectada nessa loja." };

  const language = languageOverride || receiptLang(order);
  const itemTitles = await localizeItemTitles(order.lineItems.map((li) => li.title), language);
  const receipt = buildReceipt({ order, brand, language, customerName: order.customerFirstName, itemTitles, replyTo: account.email_address });
  return { order: order as ShopifyOrderSummary & { email: string }, account, brand, receipt };
}

// O Gmail busca imagem remota por um proxy que cacheia falha e mostra o
// ícone quebrado (visto ao vivo, 01/10: recibo chegou sem logo). Mesma saída
// do aviso automático: a logo vai DENTRO do e-mail (anexo inline, cid:) em
// vez de linkada por URL. Se não conseguir baixar, mantém a URL remota.
async function inlineLogo(html: string, brand: string): Promise<{ html: string; attachments?: Array<{ filename: string; content: Buffer; cid: string; contentType: string }> }> {
  const look = brandLook(brand);
  if (!look.logo) return { html };
  const buffer = await fetchLogoBuffer(look.logo);
  if (!buffer) return { html };
  return { html: html.split(`src="${look.logo}"`).join(`src="cid:brand-logo"`), attachments: [{ filename: "logo.png", content: buffer, cid: "brand-logo", contentType: "image/png" }] };
}

// Envio de UM comprovante. Usado pelo clique na aba "E-mail de confirmação"
// (trigger manual) e pelo automático (trigger auto). TRAVA: no máximo UM
// comprovante por e-mail de cliente, pra sempre — garantido pelo banco
// (chave única em email_log), gravada ANTES do envio. Se não conseguir
// gravar (já enviado, tabela ausente, banco fora), não envia.
export async function sendReceipt(admin: SupabaseClient, storeId: string, orderId: string, trigger: "manual" | "auto" = "manual"): Promise<{ ok: true } | { ok: false; error: string; duplicate?: boolean; noTemplate?: boolean }> {
  const resolved = await resolveReceiptForOrder(admin, storeId, orderId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { order, account, brand, receipt } = resolved;

  // AUTOMÁTICO só manda o modelo que o Ian aprovou (formato carta). Marca ou
  // idioma que ainda não tem a carta escrita (ex.: OsteoPure em francês) fica
  // de fora do automático — continua disponível por clique na aba.
  // NUNCA comprovante de renovação de assinatura, nem por clique.
  if (order.isRenewal) return { ok: false, error: `${order.name} é renovação de assinatura: comprovante só vai na 1ª compra.`, noTemplate: true };
  if (trigger === "auto" && !pickLetter(brand, receipt.language)) return { ok: false, error: `Sem modelo aprovado pra ${brand}/${receipt.language}.`, noTemplate: true };

  const claim = await claimSend(admin, {
    kind: "receipt",
    storeId,
    from: account.email_address,
    to: order.email,
    customerName: order.customerFirstName,
    brand,
    language: receipt.language,
    subject: receipt.subject,
    orderId,
    orderName: order.name,
    trigger,
    dedupeKey: receiptKey(order.email),
  });
  if (!claim.ok) return { ok: false, error: claim.reason === "duplicate" ? "Esse e-mail já recebeu um comprovante (limite de um por cliente)." : claim.message, duplicate: claim.reason === "duplicate" };

  try {
    const inlined = await inlineLogo(receipt.html, brand);
    const { messageId } = await sendReply({
      emailAccount: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
      to: order.email,
      subject: receipt.subject,
      body: receipt.text,
      html: withPixel(inlined.html, claim.id),
      attachments: inlined.attachments,
      fromName: brand,
    });
    await markSent(admin, claim.id, { messageId });
  } catch (err) {
    await markFailed(admin, claim.id, (err as Error).message);
    return { ok: false, error: `Falha ao enviar: ${(err as Error).message}` };
  }
  return { ok: true };
}
export const sendManualReceipt = (admin: SupabaseClient, storeId: string, orderId: string) => sendReceipt(admin, storeId, orderId, "manual");

// COMPROVANTE AUTOMÁTICO (só roda em loja com stores.auto_receipt ligado).
// Travas, todas ao mesmo tempo:
//  1. um comprovante por e-mail, pra sempre (chave única no banco);
//  2. só pedido feito DEPOIS de ligar (auto_receipt_since) e nas últimas 48h
//     — ligar não dispara pra pedidos antigos;
//  3. só compra inicial, pedido pago e não cancelado;
//  4. no máximo MAX_PER_RUN por rodada do cron (freio de emergência);
//  5. pedido que falhou 3x não é tentado de novo.
const MAX_PER_RUN = 15;
export async function runAutoReceipts(admin: SupabaseClient, deadline: number): Promise<{ sent: number; skipped: number; failed: number; error?: string }> {
  const out = { sent: 0, skipped: 0, failed: 0 } as { sent: number; skipped: number; failed: number; error?: string };
  const { data: stores, error } = await admin.from("stores").select("id, auto_receipt, auto_receipt_since").eq("auto_receipt", true);
  if (error) return /auto_receipt/.test(error.message) ? out : { ...out, error: error.message };
  if (!stores || stores.length === 0) return out;
  // sem a tabela da trava, nem começa
  const { error: tableError } = await admin.from("email_log").select("id").limit(1);
  if (tableError) return { ...out, error: "email_log indisponível — comprovante automático não roda sem a trava de duplicidade." };

  const creds = await loadAllShopifyCreds(admin, null);
  for (const store of stores) {
    const cred = creds.find((c) => c.storeId === store.id);
    if (!cred || !store.auto_receipt_since) continue;
    const since = new Date(Math.max(new Date(store.auto_receipt_since as string).getTime(), Date.now() - 48 * 3600 * 1000)).toISOString();
    let orders: ShopifyOrderSummary[];
    try {
      orders = await fetchRecentPaidOrders(cred, since, 60);
    } catch (err) {
      out.error = `Shopify ${cred.storeName}: ${(err as Error).message}`;
      continue;
    }
    for (const order of orders) {
      if (out.sent >= MAX_PER_RUN || Date.now() > deadline) return out;
      if (order.cancelledAt || !order.email || order.createdAt < since) continue;
      if (order.isRenewal) { out.skipped += 1; continue; }
      // Comprovante automático é do Olavita: pedido sem item do Olavita
      // (produto novo) não recebe (ver lib/recovery/product-gate.ts).
      if (!isFlowProduct(order.lineItems)) { out.skipped += 1; continue; }
      const email = normEmail(order.email);
      const { data: prior, error: priorError } = await admin.from("email_log").select("status, order_id").eq("kind", "receipt").eq("is_test", false).eq("to_address", email).limit(20);
      if (priorError) return { ...out, error: priorError.message };
      if ((prior ?? []).some((r) => r.status === "sent" || r.status === "sending")) { out.skipped += 1; continue; }
      if ((prior ?? []).filter((r) => r.status === "failed" && r.order_id === order.id).length >= 3) { out.skipped += 1; continue; }
      if (!(await isFirstPaidOrder(cred, order.email, order.createdAt))) { out.skipped += 1; continue; }
      const r = await sendReceipt(admin, store.id as string, order.id, "auto");
      if (r.ok) out.sent += 1;
      else if (r.duplicate || r.noTemplate) out.skipped += 1;
      else out.failed += 1;
    }
  }
  return out;
}

// E-mail que só o Ian pode ver, pra sempre — nunca exposto em nenhuma tela
// de cliente, nunca em CC, nunca em log que um cliente possa ler.
const OWNER_TEST_EMAIL = "dono@suaempresa.com";

// Manda o recibo de um pedido REAL pro e-mail pessoal do Ian em vez do
// cliente — pra ele ver exatamente como fica (marca, idioma, moeda), sem
// nunca chegar no cliente de verdade. Assunto com "[TESTE]" na frente pra
// nunca confundir com um envio real. Não usa a trava nem conta como "já
// enviado" pro cliente de verdade.
export async function sendTestReceipt(admin: SupabaseClient, storeId: string, orderId: string, languageOverride?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolveReceiptForOrder(admin, storeId, orderId, languageOverride);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { order, account, brand, receipt } = resolved;

  try {
    const inlined = await inlineLogo(receipt.html, brand);
    await sendReply({
      emailAccount: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
      to: OWNER_TEST_EMAIL,
      attachments: inlined.attachments,
      subject: `[TESTE] ${receipt.subject}`,
      body: `(Este é um teste — o pedido real é de ${order.email}, mandado só pra você conferir.)\n\n${receipt.text}`,
      html: inlined.html.replace("<body", `<body data-test="1"`),
      fromName: brand,
    });
  } catch (err) {
    return { ok: false, error: `Falha ao enviar o teste: ${(err as Error).message}` };
  }
  return { ok: true };
}
