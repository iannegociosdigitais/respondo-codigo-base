import { NextResponse } from "next/server";
import { promises as dns } from "node:dns";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

// Painel de entregabilidade: junta TUDO que dá pra saber sem depender de
// terceiros — o que saiu (email_log), o que voltou (avisos de devolução que
// chegam na caixa), quem abriu (pixel), quem respondeu (mensagens recebidas),
// volume das respostas manuais e a autenticação dos domínios (DNS ao vivo).
// Reclamação de spam não aparece aqui: só o Google sabe (Postmaster Tools).

const BOUNCE_SENDER = /mailer-daemon|postmaster@|mail delivery (sub)?system/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function provider(email: string): string {
  const d = (email.split("@")[1] ?? "").toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return "Gmail";
  if (/^walla\.(com|co\.il)$/.test(d)) return "Walla";
  if (/^(hotmail|outlook|live|msn)\./.test(d)) return "Hotmail / Outlook";
  if (/^(yahoo|ymail)\./.test(d)) return "Yahoo";
  if (/^(icloud|me|mac)\.com$/.test(d)) return "iCloud";
  if (/(orange|wanadoo|free|sfr|laposte|neuf|bbox)\.(fr|net)$/.test(d)) return "Provedores franceses";
  if (d.endsWith(".il") || /bezeqint|netvision|013/.test(d)) return "Israel (outros)";
  return "Outros";
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}
async function cname(name: string): Promise<string[]> {
  try {
    return await dns.resolveCname(name);
  } catch {
    return [];
  }
}
const DKIM_SELECTORS = ["hostingermail-a", "hostingermail1", "google", "default", "selector1", "k1"];
async function domainAuth(domain: string) {
  const [spfAll, dmarcAll, dkim] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    Promise.all(DKIM_SELECTORS.map(async (sel) => ((await txt(`${sel}._domainkey.${domain}`)).some((t) => /p=/.test(t)) || (await cname(`${sel}._domainkey.${domain}`)).length > 0 ? sel : null))),
  ]);
  const spf = spfAll.find((t) => /^v=spf1/i.test(t)) ?? null;
  const dmarc = dmarcAll.find((t) => /^v=DMARC1/i.test(t)) ?? null;
  const policy = dmarc ? (/p=(\w+)/i.exec(dmarc)?.[1] ?? null) : null;
  return { domain, spf, dmarc, dmarcPolicy: policy, dmarcReports: dmarc ? /rua=/i.test(dmarc) : false, dkimSelectors: dkim.filter(Boolean) as string[] };
}

export async function GET(request: Request) {
  const cronOk = request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  }
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days") ?? 30), 1), 180);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const admin = createAdminClient();

  const [logRes, accountsRes, storesRes, bounceRes, outboundRes] = await Promise.all([
    admin.from("email_log").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(3000),
    admin.from("store_email_accounts").select("email_address, store_id, connected_at, last_synced_at, last_error").not("connected_at", "is", null),
    admin.from("stores").select("*"),
    admin.from("messages").select("from_address, subject, body, body_raw, sent_at").eq("direction", "inbound").or("from_address.ilike.%mailer-daemon%,from_address.ilike.%postmaster%").gte("sent_at", since).order("sent_at", { ascending: false }).limit(1000),
    admin.from("messages").select("to_address, sent_at, direction").neq("direction", "inbound").gte("sent_at", since).order("sent_at", { ascending: false }).limit(5000),
  ]);

  const migrationMissing = Boolean(logRes.error && /email_log|does not exist|schema cache/i.test(logRes.error.message));
  const log = (logRes.data ?? []) as Array<Record<string, unknown>>;
  const own = new Set((accountsRes.data ?? []).map((a) => String(a.email_address).toLowerCase()));

  const ownDomains = new Set([...own].map((e) => e.split("@")[1]));
  // Devoluções: cada aviso do servidor de e-mail cita o endereço que falhou.
  const bounced = new Map<string, { at: string; reason: string }>();
  for (const m of bounceRes.data ?? []) {
    if (!BOUNCE_SENDER.test(String(m.from_address ?? ""))) continue;
    const text = `${m.subject ?? ""}\n${m.body_raw ?? m.body ?? ""}`;
    const reason = /inbox full|quota|mailbox full|over quota/i.test(text) ? "Caixa cheia" : /address not found|user unknown|no such user|does not exist|550 5\.1\.1|unknown recipient/i.test(text) ? "Endereço não existe" : /blocked|spam|policy|reputation|550 5\.7/i.test(text) ? "Bloqueado pelo provedor" : /delay|temporar|retry/i.test(text) ? "Atraso temporário" : "Devolvido";
    for (const raw of text.match(EMAIL_RE) ?? []) {
      const e = raw.toLowerCase();
      // ids de mensagem (uuid@nossodominio) parecem e-mail mas não são destinatário
      if (own.has(e) || ownDomains.has(e.split("@")[1]) || BOUNCE_SENDER.test(e) || /@(.*\.)?(google|googlemail|hostinger|mailchannels)\./.test(e)) continue;
      if (!bounced.has(e)) bounced.set(e, { at: String(m.sent_at), reason });
    }
  }

  // Respostas: cliente escreveu depois de receber o e-mail automático.
  const recipients = [...new Set(log.filter((r) => r.status === "sent" && !r.is_test).map((r) => String(r.to_address)))];
  const replies = new Map<string, string[]>();
  for (let i = 0; i < recipients.length; i += 150) {
    const { data } = await admin.from("messages").select("from_address, sent_at").eq("direction", "inbound").in("from_address", recipients.slice(i, i + 150)).gte("sent_at", since).limit(5000);
    for (const m of data ?? []) {
      const k = String(m.from_address).toLowerCase();
      (replies.get(k) ?? replies.set(k, []).get(k))!.push(String(m.sent_at));
    }
  }

  const rows = log.map((r) => {
    const to = String(r.to_address);
    const sentAt = (r.sent_at ?? r.created_at) as string;
    const b = bounced.get(to);
    const isBounced = Boolean(r.status === "sent" && b && b.at >= sentAt);
    const repliedAt = r.status === "sent" ? (replies.get(to) ?? []).filter((t) => t > sentAt).sort()[0] ?? null : null;
    return {
      id: r.id, kind: r.kind, trigger: r.trigger, isTest: r.is_test, storeId: r.store_id, from: r.from_address, to, name: r.customer_name, brand: r.brand, language: r.language, subject: r.subject,
      orderName: r.order_name, status: r.status, error: r.error, createdAt: r.created_at, sentAt: r.sent_at, openCount: Number(r.open_count ?? 0), firstOpenedAt: r.first_opened_at, lastOpenedAt: r.last_opened_at,
      bounced: isBounced, bounceReason: isBounced ? b!.reason : null, repliedAt, provider: provider(to),
    };
  });

  const summarize = (list: typeof rows) => {
    const real = list.filter((r) => !r.isTest);
    const sent = real.filter((r) => r.status === "sent");
    const bouncedN = sent.filter((r) => r.bounced).length;
    const delivered = sent.length - bouncedN;
    const opened = sent.filter((r) => r.openCount > 0 && !r.bounced).length;
    return {
      attempts: real.length, sent: sent.length, failed: real.filter((r) => r.status === "failed").length, bounced: bouncedN, delivered, opened,
      replied: sent.filter((r) => r.repliedAt).length, uniqueRecipients: new Set(sent.map((r) => r.to)).size,
      deliveryRate: sent.length ? delivered / sent.length : null, bounceRate: sent.length ? bouncedN / sent.length : null,
      openRate: delivered ? opened / delivered : null, replyRate: delivered ? sent.filter((r) => r.repliedAt).length / delivered : null,
      tests: list.filter((r) => r.isTest).length,
    };
  };
  const group = (list: typeof rows, key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, typeof rows>();
    for (const r of list.filter((x) => !x.isTest && x.status === "sent")) (m.get(key(r)) ?? m.set(key(r), []).get(key(r)))!.push(r);
    return [...m.entries()].map(([name, items]) => ({ name, sent: items.length, bounced: items.filter((r) => r.bounced).length, opened: items.filter((r) => r.openCount > 0).length })).sort((a, b) => b.sent - a.sent);
  };
  const byDay = new Map<string, { day: string; sent: number; opened: number; bounced: number; failed: number }>();
  for (const r of rows.filter((x) => !x.isTest)) {
    const day = String(r.createdAt).slice(0, 10);
    const d = byDay.get(day) ?? byDay.set(day, { day, sent: 0, opened: 0, bounced: 0, failed: 0 }).get(day)!;
    if (r.status === "sent") d.sent += 1;
    if (r.status === "failed") d.failed += 1;
    if (r.openCount > 0) d.opened += 1;
    if (r.bounced) d.bounced += 1;
  }

  // Respostas manuais (o que você envia pelo Inbox): volume e devoluções.
  const outbound = (outboundRes.data ?? []).filter((m) => m.to_address && !own.has(String(m.to_address).toLowerCase()));
  const manualBounced = outbound.filter((m) => { const b = bounced.get(String(m.to_address).toLowerCase()); return b && b.at >= String(m.sent_at); });
  const manualProviders = new Map<string, { name: string; sent: number; bounced: number }>();
  for (const m of outbound) {
    const p = provider(String(m.to_address));
    const e = manualProviders.get(p) ?? manualProviders.set(p, { name: p, sent: 0, bounced: 0 }).get(p)!;
    e.sent += 1;
    const b = bounced.get(String(m.to_address).toLowerCase());
    if (b && b.at >= String(m.sent_at)) e.bounced += 1;
  }

  const domains = [...new Set([...own].map((e) => e.split("@")[1]).filter(Boolean))];
  const auth = await Promise.all(domains.map(domainAuth));
  const storeName = new Map((storesRes.data ?? []).map((s) => [s.id as string, s.name as string]));

  return NextResponse.json({
    days, migrationMissing,
    summary: { all: summarize(rows), receipt: summarize(rows.filter((r) => r.kind === "receipt")), auto_ack: summarize(rows.filter((r) => r.kind === "auto_ack")) },
    byProvider: group(rows, (r) => r.provider), byLanguage: group(rows, (r) => String(r.language ?? "?")), byBrand: group(rows, (r) => String(r.brand ?? "?")),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    manual: { sent: outbound.length, bounced: manualBounced.length, bounceRate: outbound.length ? manualBounced.length / outbound.length : null, byProvider: [...manualProviders.values()].sort((a, b) => b.sent - a.sent) },
    bounces: [...bounced.entries()].map(([email, b]) => ({ email, ...b })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    auth,
    mailboxes: (accountsRes.data ?? []).map((a) => ({ email: a.email_address, store: storeName.get(a.store_id as string) ?? null, lastSyncedAt: a.last_synced_at, lastError: a.last_error })),
    stores: (storesRes.data ?? []).map((s) => ({ id: s.id, name: s.name, autoAck: Boolean((s as Record<string, unknown>).auto_ack), autoReceipt: Boolean((s as Record<string, unknown>).auto_receipt), autoReceiptSince: (s as Record<string, unknown>).auto_receipt_since ?? null })),
    rows: rows.slice(0, 1000).map((r) => ({ ...r, store: storeName.get(String(r.storeId)) ?? null })),
  });
}
