import { ackKey, claimSend, markFailed, markSent, normEmail } from "@/lib/email/log";
import { loadProducts, type Products } from "@/lib/agent/products";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectSentFolder, fetchHistoryForAddresses, fetchMessagesSince, type MailMessage } from "@/lib/email/imap";
import { normalizeSubject } from "@/lib/email/quote";
import { routeStore, type Brands } from "@/lib/agent/brands";
import { NOISE_SENDER, NOISE_SUBJECT, isShopifyNotice } from "@/lib/agent/noise";
import { classifyShopifyNotice } from "@/lib/agent/shopify-notice";
import { detectChargebackNotice, handleChargebackNotice } from "@/lib/agent/chargeback";
import { quickDetectLanguage, resolveAckBrand, sendAutoAck } from "@/lib/agent/auto-ack";

export interface EmailAccountRow {
  id: string;
  store_id: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  email_address: string;
  credential_encrypted: string;
  last_uid: number;
  sent_folder: string | null;
  sent_last_uid: number;
}

const SINCE_DAYS = 90;
const BATCH = 80;
const THREAD_WINDOW_DAYS = 60;

// Importa o que há de novo na caixa (INBOX + Enviados) pro banco, sem
// tocar nas flags do e-mail. Só ingestão e threading — nada de LLM aqui;
// a análise roda depois em analyzePendingConversations.
export async function syncEmailAccount(
  admin: SupabaseClient,
  account: EmailAccountRow,
  storeId: string,
  ignoreAddresses: string[] = [],
  brands: Brands = { enabled: false, stores: [] },
  autoAckConfig?: { enabled: boolean; defaultLanguage: string | null; fallbackBrand: string }
): Promise<{ inbound: number; sent: number; remaining: number }> {
  const creds = {
    imapHost: account.imap_host,
    imapPort: account.imap_port,
    emailAddress: account.email_address,
    credentialEncrypted: account.credential_encrypted,
  };
  const own = account.email_address.toLowerCase();
  let inbound = 0;
  let sent = 0;
  let remaining = 0;
  // O e-mail de revisão da loja (e o próprio endereço) nunca viram cliente.
  const ignore = new Set([own, ...ignoreAddresses.map((a) => a.toLowerCase()).filter(Boolean)]);
  const autoAck = autoAckConfig?.enabled
    ? {
        defaultLanguage: autoAckConfig.defaultLanguage,
        fallbackBrand: autoAckConfig.fallbackBrand,
        products: await loadProducts(admin),
        account: { smtpHost: account.smtp_host, smtpPort: account.smtp_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted },
      }
    : null;
  const ctx: IngestContext = { customers: new Map(), known: new Set(), received: 0, ignore, brands, defaultStoreId: storeId, autoAck };

  const inbox = await fetchMessagesSince(creds, "INBOX", account.last_uid ?? 0, { sinceDays: SINCE_DAYS, max: BATCH });
  await preloadKnownMessageIds(admin, ctx, inbox.messages);
  let cycleError = false;
  // E-mail que falhou na importação NÃO pode ficar pra trás: o ponteiro
  // (last_uid) só avança até o UID anterior ao primeiro que falhou, pra ele
  // ser tentado de novo no próximo ciclo (as mensagens vêm em UID crescente).
  let firstFailedUid: number | null = null;
  for (const msg of inbox.messages) {
    try {
      if (await ingestInbound(admin, storeId, own, msg, ctx)) inbound += 1;
    } catch (err) {
      cycleError = true;
      if (firstFailedUid === null || msg.uid < firstFailedUid) firstFailedUid = msg.uid;
      console.error(`Falha ao importar e-mail uid ${msg.uid} de ${msg.fromAddress}:`, err);
      await admin.from("store_email_accounts").update({ last_error: `uid ${msg.uid}: ${(err as Error).message}` }).eq("id", account.id);
    }
  }
  const inboxAdvanceTo = firstFailedUid === null ? inbox.maxUid : firstFailedUid - 1;
  // last_synced_at é batimento: atualiza a cada ciclo, com ou sem e-mail novo.
  await admin
    .from("store_email_accounts")
    .update({ last_synced_at: new Date().toISOString(), ...(cycleError ? {} : { last_error: null }), ...(inboxAdvanceTo > (account.last_uid ?? 0) ? { last_uid: inboxAdvanceTo } : {}) })
    .eq("id", account.id);
  remaining += inbox.remaining;

  let sentFolder = account.sent_folder;
  if (!sentFolder) {
    sentFolder = await detectSentFolder(creds);
    if (sentFolder) await admin.from("store_email_accounts").update({ sent_folder: sentFolder }).eq("id", account.id);
  }
  if (sentFolder) {
    const sentBox = await fetchMessagesSince(creds, sentFolder, account.sent_last_uid ?? 0, { sinceDays: SINCE_DAYS, max: BATCH });
    await preloadKnownMessageIds(admin, ctx, sentBox.messages);
    let firstFailedSentUid: number | null = null;
    for (const msg of sentBox.messages) {
      try {
        if (await ingestSent(admin, storeId, own, msg, ctx)) sent += 1;
      } catch (err) {
        if (firstFailedSentUid === null || msg.uid < firstFailedSentUid) firstFailedSentUid = msg.uid;
        console.error(`Falha ao importar enviado uid ${msg.uid}:`, err);
      }
    }
    // Mesma regra da INBOX: o ponteiro para antes do primeiro UID que falhou.
    const sentAdvanceTo = firstFailedSentUid === null ? sentBox.maxUid : firstFailedSentUid - 1;
    if (sentAdvanceTo > (account.sent_last_uid ?? 0)) {
      await admin.from("store_email_accounts").update({ sent_last_uid: sentAdvanceTo }).eq("id", account.id);
    }
    remaining += sentBox.remaining;
  }

  if (ctx.received > 0) {
    await admin.from("usage_logs").insert(Array.from({ length: ctx.received }, () => ({ store_id: storeId, event_type: "email_received" })));
  }

  return { inbound, sent, remaining };
}

// Histórico completo de clientes específicos (sem limite de data): o que ele
// mandou e o que a loja respondeu, mesmo antes da janela de importação. As
// conversas antigas que nascem daqui entram ENCERRADAS — são histórico pra
// IA e pro chat, não pendência nova.
export async function backfillCustomerHistory(
  admin: SupabaseClient,
  account: EmailAccountRow,
  storeId: string,
  customerEmails: string[],
  brands: Brands = { enabled: false, stores: [] }
): Promise<{ customers: number; inbound: number; sent: number; changed: string[] }> {
  const creds = { imapHost: account.imap_host, imapPort: account.imap_port, emailAddress: account.email_address, credentialEncrypted: account.credential_encrypted };
  const own = account.email_address.toLowerCase();
  const ctx: IngestContext = { customers: new Map(), known: new Set(), received: 0, ignore: new Set([own]), brands, defaultStoreId: storeId, autoAck: null };
  const history = await fetchHistoryForAddresses(creds, account.sent_folder, customerEmails);
  const cutoff = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
  let inbound = 0;
  let sent = 0;
  const changed: string[] = [];

  for (const [email, bucket] of history) {
    const startCount = inbound + sent;
    const { data: custs } = await admin.from("customers").select("id").ilike("email", email);
    const custIds = (custs ?? []).map((c) => c.id as string);
    const before = new Set<string>();
    if (custIds.length > 0) {
      const { data: convs } = await admin.from("conversations").select("id").in("customer_id", custIds);
      for (const c of convs ?? []) before.add(c.id as string);
    }
    const all = [...bucket.inbound.map((m) => ({ m, kind: "in" as const })), ...bucket.sent.map((m) => ({ m, kind: "out" as const }))].sort((a, b) => a.m.date.getTime() - b.m.date.getTime());
    await preloadKnownMessageIds(admin, ctx, all.map((x) => x.m));
    for (const { m, kind } of all) {
      try {
        if (kind === "in" ? await ingestInbound(admin, storeId, own, m, ctx) : await ingestSent(admin, storeId, own, m, ctx)) {
          if (kind === "in") inbound += 1;
          else sent += 1;
        }
      } catch (err) {
        console.error(`backfill ${email}:`, (err as Error).message);
      }
    }
    if (inbound + sent > startCount) changed.push(email);
    // Conversas novas nascidas do histórico antigo: encerradas e já "analisadas".
    const { data: custsAfter } = await admin.from("customers").select("id").ilike("email", email);
    const idsAfter = (custsAfter ?? []).map((c) => c.id as string);
    if (idsAfter.length > 0) {
      const { data: convsAfter } = await admin.from("conversations").select("id, last_message_at, status").in("customer_id", idsAfter);
      const old = (convsAfter ?? []).filter((c) => !before.has(c.id as string) && ((c.last_message_at as string | null) ?? "") < cutoff && c.status !== "spam");
      if (old.length > 0) {
        await admin
          .from("conversations")
          .update({ status: "encerrada", unread: false, closed_at: new Date().toISOString(), analyzed_at: new Date().toISOString() })
          .in("id", old.map((c) => c.id as string));
      }
    }
  }
  return { customers: history.size, inbound, sent, changed };
}

interface IngestContext {
  customers: Map<string, string>;
  known: Set<string>;
  received: number;
  ignore: Set<string>;
  brands: Brands;
  defaultStoreId: string;
  autoAck: { defaultLanguage: string | null; fallbackBrand: string; products: Products; account: { smtpHost: string; smtpPort: number; emailAddress: string; credentialEncrypted: string } } | null;
}

// Uma consulta pro lote inteiro em vez de uma por mensagem.
async function preloadKnownMessageIds(admin: SupabaseClient, ctx: IngestContext, messages: MailMessage[]) {
  const ids = messages.map((m) => m.messageId).filter((id): id is string => Boolean(id));
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from("messages").select("message_id").in("message_id", ids.slice(i, i + 100));
    for (const row of data ?? []) ctx.known.add(row.message_id as string);
    // E-mails automáticos (aviso de recebimento, comprovante) que o provedor
    // copiou pra pasta Enviados: já estão no email_log. Sem isso, a cópia
    // entraria como "resposta humana" e a conversa sairia da fila de
    // pendentes sem ninguém ter respondido de verdade.
    const { data: auto } = await admin.from("email_log").select("message_id").in("message_id", ids.slice(i, i + 100));
    for (const row of auto ?? []) if (row.message_id) ctx.known.add(row.message_id as string);
  }
}

function messageExists(ctx: IngestContext, messageId: string | null): boolean {
  return Boolean(messageId && ctx.known.has(messageId));
}

// Nome que veio no From (ex.: "Marie Dupont <marie@...>") vira o nome do
// cliente — a IA cumprimenta pelo primeiro nome mesmo sem Shopify.
function cleanDisplayName(name: string | null | undefined, email: string): string | null {
  const n = (name ?? "").replace(/["']/g, "").trim();
  if (!n || n.includes("@") || n.toLowerCase() === email.toLowerCase()) return null;
  return n.slice(0, 80);
}

async function findOrCreateCustomer(admin: SupabaseClient, storeId: string, email: string, ctx: IngestContext, displayName?: string | null): Promise<string> {
  const name = cleanDisplayName(displayName, email);
  const cached = ctx.customers.get(email);
  if (cached) return cached;
  const { data } = await admin.from("customers").select("id, name").eq("store_id", storeId).eq("email", email).maybeSingle();
  if (data) {
    if (!data.name && name) await admin.from("customers").update({ name }).eq("id", data.id as string);
    ctx.customers.set(email, data.id as string);
    return data.id as string;
  }
  const { data: created, error } = await admin.from("customers").insert({ store_id: storeId, email, name }).select("id").single();
  if (error) {
    // Corrida ou variação de maiúsculas: já existe — busca de novo sem case.
    const { data: again } = await admin.from("customers").select("id").eq("store_id", storeId).ilike("email", email).limit(1).maybeSingle();
    if (again) {
      ctx.customers.set(email, again.id as string);
      return again.id as string;
    }
    throw error;
  }
  ctx.customers.set(email, created.id as string);
  return created.id as string;
}

async function findConversationByRefs(admin: SupabaseClient, refs: string[]): Promise<string | null> {
  const clean = refs.filter(Boolean);
  if (clean.length === 0) return null;
  const { data } = await admin.from("messages").select("conversation_id").in("message_id", clean).limit(1);
  return (data?.[0]?.conversation_id as string | undefined) ?? null;
}

async function findConversationByThreadKey(admin: SupabaseClient, storeId: string, threadKey: string, around: Date): Promise<string | null> {
  const from = new Date(around.getTime() - THREAD_WINDOW_DAYS * 86400000).toISOString();
  const to = new Date(around.getTime() + THREAD_WINDOW_DAYS * 86400000).toISOString();
  const { data } = await admin
    .from("conversations")
    .select("id")
    .eq("store_id", storeId)
    .eq("thread_key", threadKey)
    .gte("last_message_at", from)
    .lte("last_message_at", to)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function threadKeyFor(subject: string, customerEmail: string): string {
  return `${normalizeSubject(subject) || "(sem assunto)"}|${customerEmail}`;
}

async function resolveConversation(
  admin: SupabaseClient,
  customerEmail: string,
  msg: MailMessage,
  initialStatus: "nova" | "respondida_humano",
  ctx: IngestContext
): Promise<{ id: string; isNewRealConversation: boolean; storeId: string }> {
  const byRefs = await findConversationByRefs(admin, [msg.inReplyTo ?? "", ...msg.references]);
  if (byRefs) return { id: byRefs, isNewRealConversation: false, storeId: ctx.defaultStoreId };

  const storeId = routeStore(ctx.brands, ctx.defaultStoreId, msg.toAddresses, [msg.subject, msg.text], customerEmail);

  const threadKey = threadKeyFor(msg.subject, customerEmail);
  const byKey = await findConversationByThreadKey(admin, storeId, threadKey, msg.date);
  if (byKey) return { id: byKey, isNewRealConversation: false, storeId };

  const customerId = await findOrCreateCustomer(admin, storeId, customerEmail, ctx, msg.fromAddress === customerEmail ? msg.fromName : null);
  // Notificação automática (Shopify, Stripe, no-reply...) nasce como spam:
  // nunca aparece no Inbox/Tickets nem gasta análise.
  const noise = initialStatus === "nova" && (NOISE_SENDER.test(customerEmail) || NOISE_SUBJECT.test(msg.subject ?? ""));
  const { data, error } = await admin
    .from("conversations")
    .insert({
      store_id: storeId,
      customer_id: customerId,
      subject: msg.subject,
      thread_key: threadKey,
      status: noise ? "spam" : initialStatus,
      category: noise ? "spam" : null,
      unread: initialStatus === "nova" && !noise,
      last_message_at: msg.date.toISOString(),
      ...(noise ? { analyzed_at: new Date().toISOString(), analysis: { intent_pt: "Remetente automático (notificação/sistema)." } } : {}),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id as string, isNewRealConversation: initialStatus === "nova" && !noise, storeId };
}

// Resposta automática de ausência/fora do escritório: nunca recebe aviso
// (dois robôs respondendo um ao outro).
const AUTO_REPLY_SUBJECT = /^(automatic reply|auto(-|\s)?reply|autoreply|out of office|réponse automatique|resposta autom[áa]tica|abwesenheit|מענה אוטומטי|תשובה אוטומטית)/i;

async function ingestInbound(admin: SupabaseClient, _storeId: string, own: string, msg: MailMessage, ctx: IngestContext): Promise<boolean> {
  if (!msg.fromAddress || ctx.ignore.has(msg.fromAddress)) return false;
  if (messageExists(ctx, msg.messageId)) return false;

  const { id: conversationId, isNewRealConversation, storeId } = await resolveConversation(admin, msg.fromAddress, msg, "nova", ctx);

  const { error } = await admin.from("messages").insert({
    conversation_id: conversationId,
    direction: "inbound",
    from_address: msg.fromAddress,
    to_address: own,
    ...(ctx.brands.enabled ? { to_addresses: msg.toAddresses } : {}),
    subject: msg.subject,
    body: msg.text,
    body_raw: msg.textFull,
    message_id: msg.messageId,
    in_reply_to: msg.inReplyTo,
    references_ids: msg.references,
    sent_at: msg.date.toISOString(),
    imap_uid: msg.uid,
  });
  if (error) {
    if (error.code === "23505") return false;
    throw error;
  }

  if (msg.messageId) ctx.known.add(msg.messageId);
  await recomputeConversationState(admin, null, conversationId);
  ctx.received += 1;

  // Aviso de chargeback da Shopify/Disputifier (só os recentes, pra uma
  // reimportação antiga não disparar dezenas de rascunhos): registra no
  // cliente e já deixa o e-mail proativo redigido. O aviso em si segue spam.
  // Aviso da Shopify: lê o conteúdo e decide. Exige ação do dono (risco,
  // pagamento, verificação...) = topo do Inbox como urgente, sem rascunho.
  // Informativo (payout, resumo, parabéns, marketing) = spam interno.
  if (isShopifyNotice(msg.fromAddress, msg.subject ?? "")) {
    const verdict = await classifyShopifyNotice(msg.fromAddress, msg.subject ?? "", msg.textFull ?? msg.text);
    const now = new Date().toISOString();
    await admin
      .from("conversations")
      .update(
        verdict.action
          ? { status: "aguardando_humano", urgency: "urgente", category: "outro", unread: true, analyzed_at: now, draft_reply: null, draft_reply_pt: null, analysis: { intent_pt: `AÇÃO: ${verdict.summary_pt}${verdict.deadline_pt ? ` (prazo: ${verdict.deadline_pt})` : ""}`, shopify_notice: true } }
          : { status: "spam", category: "spam", unread: false, analyzed_at: now, analysis: { intent_pt: verdict.summary_pt } }
      )
      .eq("id", conversationId);
  }

  const notice = detectChargebackNotice(msg.fromAddress, msg.subject, msg.textFull);
  if (notice && Date.now() - msg.date.getTime() < 10 * 86400000) {
    await handleChargebackNotice(admin, _storeId, notice, msg.date.toISOString()).catch((err) => console.error("aviso de chargeback:", (err as Error).message));
  }

  // Aviso automático "recebemos sua mensagem" — só na 1ª mensagem de uma
  // conversa nova de cliente real, e só se ela chegou de verdade agora (não
  // numa reimportação/backfill de histórico antigo, que traria centenas de
  // avisos fora de hora pra caixa inteira).
  if (ctx.autoAck && isNewRealConversation && Date.now() - msg.date.getTime() < 2 * 3600000 && !AUTO_REPLY_SUBJECT.test(msg.subject ?? "")) {
    const language = quickDetectLanguage(msg.textFull ?? msg.text, msg.fromAddress, ctx.autoAck.defaultLanguage);
    const brand = resolveAckBrand(ctx.autoAck.products, { storeId, mailbox: own, subject: msg.subject, text: msg.text, textFull: msg.textFull, language });
    // TRAVA: grava ANTES de enviar, com chave única "um aviso por e-mail por
    // dia". Chave repetida, tabela ausente ou banco fora = não envia.
    const recent = await admin.from("email_log").select("id").eq("kind", "auto_ack").eq("to_address", normEmail(msg.fromAddress)).in("status", ["sent", "sending"]).gte("created_at", new Date(Date.now() - 24 * 3600000).toISOString()).limit(1);
    const claim = recent.error || (recent.data ?? []).length > 0
      ? null
      : await claimSend(admin, { kind: "auto_ack", storeId, conversationId, from: ctx.autoAck.account.emailAddress, to: msg.fromAddress, customerName: msg.fromName ?? null, brand, subject: msg.subject, trigger: "auto", dedupeKey: ackKey(msg.fromAddress) });
    if (claim?.ok) {
      try {
        const sent = await sendAutoAck(ctx.autoAck.account, {
          to: msg.fromAddress,
          customerName: msg.fromName ?? null,
          subject: msg.subject,
          text: msg.text,
          storeDefaultLanguage: ctx.autoAck.defaultLanguage,
          brand,
          forceLanguage: language,
          logId: claim.id,
          inReplyTo: msg.messageId,
          references: [...(msg.references ?? []), ...(msg.messageId ? [msg.messageId] : [])],
        });
        await markSent(admin, claim.id, { messageId: sent.messageId, language: sent.language, subject: sent.subject });
      } catch (err) {
        console.error("aviso automático de recebimento:", (err as Error).message);
        await markFailed(admin, claim.id, (err as Error).message);
      }
    } else if (claim && claim.reason !== "duplicate") {
      console.error("aviso automático NÃO enviado (sem trava):", claim.message);
    }
  }
  return true;
}

async function ingestSent(admin: SupabaseClient, _storeId: string, own: string, msg: MailMessage, ctx: IngestContext): Promise<boolean> {
  if (msg.fromAddress && msg.fromAddress !== own) return false;
  const to = msg.toAddresses.find((a) => a && !ctx.ignore.has(a));
  if (!to || msg.toAddresses.some((a) => ctx.ignore.has(a) && a !== own)) return false;
  if (messageExists(ctx, msg.messageId)) return false;

  const { id: conversationId } = await resolveConversation(admin, to, msg, "respondida_humano", ctx);

  const { error } = await admin.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound_human",
    from_address: own,
    to_address: to,
    subject: msg.subject,
    body: msg.text,
    body_raw: msg.textFull,
    message_id: msg.messageId,
    in_reply_to: msg.inReplyTo,
    references_ids: msg.references,
    sent_at: msg.date.toISOString(),
    imap_uid: msg.uid,
  });
  if (error) {
    if (error.code === "23505") return false;
    throw error;
  }

  if (msg.messageId) ctx.known.add(msg.messageId);
  await recomputeConversationState(admin, null, conversationId);
  return true;
}

// Estado da conversa derivado das mensagens, independente da ordem em que
// foram importadas: quem falou por último decide (cliente → pendente ou
// reaberta; loja → respondida).
export async function recomputeConversationState(admin: SupabaseClient, _storeId: string | null, conversationId: string): Promise<void> {
  const { data: conv } = await admin
    .from("conversations")
    .select("status, analyzed_at, closed_at, store_id")
    .eq("id", conversationId)
    .single();
  if (!conv) return;
  const storeId = conv.store_id as string;

  const { data: messages } = await admin
    .from("messages")
    .select("direction, sent_at, created_at")
    .eq("conversation_id", conversationId);

  const ordered = (messages ?? [])
    .map((m) => ({ direction: m.direction as string, at: ((m.sent_at as string | null) ?? (m.created_at as string)) as string }))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (ordered.length === 0) return;

  const lastIn = [...ordered].reverse().find((m) => m.direction === "inbound") ?? null;
  const lastOut = [...ordered].reverse().find((m) => m.direction === "outbound_ai" || m.direction === "outbound_human") ?? null;
  const lastAt = ordered[ordered.length - 1].at;

  const current = conv.status as string;
  let status = current;
  let unread: boolean | undefined;
  let analyzedAt: string | null | undefined;

  const customerSpokeLast = Boolean(lastIn) && (!lastOut || lastIn!.at > lastOut!.at);

  if (current === "spam") {
    // fica como está
  } else if (!customerSpokeLast && lastOut) {
    status = current === "encerrada" ? "encerrada" : lastOut.direction === "outbound_ai" ? "respondida_ia" : "respondida_humano";
    unread = false;
  } else if (customerSpokeLast) {
    const closedAt = conv.closed_at as string | null;
    if (current === "encerrada") {
      if (!closedAt || lastIn!.at > closedAt) status = "reaberta";
    } else if (current === "respondida_ia" || current === "respondida_humano") {
      status = "reaberta";
    }
    unread = true;
    const analyzedAtPrev = conv.analyzed_at as string | null;
    if (!analyzedAtPrev || analyzedAtPrev < lastIn!.at) analyzedAt = null;
  }

  if (status === "reaberta" && current !== "reaberta") {
    await admin.from("usage_logs").insert({ store_id: storeId, event_type: "reopened" });
  }

  const patch: Record<string, unknown> = { status, last_message_at: lastAt };
  if (unread !== undefined) patch.unread = unread;
  if (analyzedAt === null) patch.analyzed_at = null;
  await admin.from("conversations").update(patch).eq("id", conversationId);
}
