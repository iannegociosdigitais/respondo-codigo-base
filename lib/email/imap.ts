import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decrypt } from "@/lib/crypto";
import { stripQuotedReply } from "@/lib/email/quote";

export interface MailMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  date: Date;
  text: string;
  textFull: string;
}

export interface ImapCredentials {
  imapHost: string;
  imapPort: number;
  emailAddress: string;
  credentialEncrypted: string;
}

const SENT_FOLDER_NAMES = [
  "[Gmail]/Sent Mail",
  "[Gmail]/E-mails enviados",
  "[Gmail]/Messages envoyés",
  "[Gmail]/Itens enviados",
  "Sent",
  "Sent Items",
  "Sent Messages",
  "INBOX.Sent",
  "Enviados",
  "Éléments envoyés",
];

function buildClient(account: ImapCredentials) {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.emailAddress, pass: decrypt(account.credentialEncrypted) },
    logger: false,
  });
  // Sem ouvinte de "error", um timeout de socket vira exceção não tratada e
  // derruba a função inteira (poll-inboxes caiu cerca de 3 vezes por hora com
  // "Socket timeout", exit 129, e os passos depois das caixas não rodavam).
  // A operação em andamento já rejeita sozinha e o erro cai no try/catch de quem chamou.
  client.on("error", (err: unknown) => console.warn(`imap ${account.imapHost}:`, err instanceof Error ? err.message : err));
  return client;
}

export async function detectSentFolder(account: ImapCredentials): Promise<string | null> {
  const client = buildClient(account);
  await client.connect();
  try {
    const boxes = await client.list();
    const special = boxes.find((b) => b.specialUse === "\\Sent");
    if (special) return special.path;
    const byName = boxes.find((b) => SENT_FOLDER_NAMES.includes(b.path));
    return byName?.path ?? null;
  } finally {
    await client.logout();
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Nunca toca nas flags da caixa (\Seen etc.): o que já foi importado é
// controlado pelo UID guardado no banco, não pelo estado "lido" do Gmail.
// Na primeira vez (lastUid = 0) importa os últimos `sinceDays` dias.
export async function fetchMessagesSince(
  account: ImapCredentials,
  mailbox: string,
  lastUid: number,
  opts: { sinceDays: number; max: number }
): Promise<{ messages: MailMessage[]; maxUid: number; remaining: number }> {
  const client = buildClient(account);
  const messages: MailMessage[] = [];
  let maxUid = lastUid;
  let remaining = 0;

  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
    const query = lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { since };
    const found = ((await client.search(query, { uid: true })) || []) as number[];
    const uids = found.filter((u) => u > lastUid).sort((a, b) => a - b);
    const batch = uids.slice(0, opts.max);
    remaining = uids.length - batch.length;

    if (batch.length > 0) {
      for await (const message of client.fetch(batch, { source: true, uid: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        const textFull = ((parsed.text ?? "").trim() || (parsed.html ? htmlToText(parsed.html) : "")).trim();
        const refs = Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [];
        const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
        messages.push({
          uid: message.uid,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references: refs,
          fromAddress: (parsed.from?.value?.[0]?.address ?? "").toLowerCase(),
          fromName: (parsed.from?.value?.[0]?.name ?? "").trim() || null,
          toAddresses: toList.flatMap((t) => t.value.map((v) => (v.address ?? "").toLowerCase())).filter(Boolean),
          subject: parsed.subject ?? "(sem assunto)",
          date: parsed.date ?? new Date(),
          text: stripQuotedReply(textFull) || textFull || "(e-mail sem conteúdo de texto)",
          textFull: textFull || "(e-mail sem conteúdo de texto)",
        });
        if (message.uid > maxUid) maxUid = message.uid;
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  messages.sort((a, b) => a.uid - b.uid);
  return { messages, maxUid, remaining };
}


// Histórico completo de endereços específicos, SEM limite de data: tudo que
// o cliente mandou (INBOX + Todos os e-mails, se existir) e tudo que a loja
// mandou pra ele (Enviados). Uma conexão só pra lista inteira.
export async function fetchHistoryForAddresses(
  account: ImapCredentials,
  sentFolder: string | null,
  addresses: string[],
  maxPerAddress = 60
): Promise<Map<string, { inbound: MailMessage[]; sent: MailMessage[] }>> {
  const out = new Map<string, { inbound: MailMessage[]; sent: MailMessage[] }>();
  const client = buildClient(account);
  await client.connect();
  try {
    const boxes = (await client.list()).map((b) => b.path);
    const allMail = boxes.find((b) => /all mail|tous les messages|todos os e-mails/i.test(b)) ?? null;
    const plan: Array<{ box: string; kind: "inbound" | "sent" }> = [{ box: allMail ?? "INBOX", kind: "inbound" }];
    // Sem "Todos os e-mails" (Hostinger etc.), o que já foi respondido e arquivado
    // da caixa principal mora em Archive: o histórico do cliente tem que olhar lá também.
    const archive = allMail ? null : boxes.find((b) => /^(INBOX\.)?Archive$/i.test(b)) ?? null;
    if (archive) plan.push({ box: archive, kind: "inbound" });
    if (sentFolder) plan.push({ box: sentFolder, kind: "sent" });

    for (const { box, kind } of plan) {
      const lock = await client.getMailboxLock(box);
      try {
        for (const address of addresses) {
          const found = ((await client.search(kind === "inbound" ? { from: address } : { to: address }, { uid: true })) || []) as number[];
          const uids = found.sort((a, b) => a - b).slice(-maxPerAddress);
          const bucket = out.get(address) ?? { inbound: [], sent: [] };
          out.set(address, bucket);
          if (uids.length === 0) continue;
          for await (const message of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            const textFull = ((parsed.text ?? "").trim() || (parsed.html ? htmlToText(parsed.html) : "")).trim();
            const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
            const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
            bucket[kind].push({
              uid: message.uid,
              messageId: parsed.messageId ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              references: refs,
              fromAddress: (parsed.from?.value?.[0]?.address ?? "").toLowerCase(),
              fromName: (parsed.from?.value?.[0]?.name ?? "").trim() || null,
              toAddresses: toList.flatMap((t) => t.value.map((v) => (v.address ?? "").toLowerCase())).filter(Boolean),
              subject: parsed.subject ?? "(sem assunto)",
              date: parsed.date ?? new Date(),
              text: stripQuotedReply(textFull) || textFull || "(e-mail sem conteúdo de texto)",
              textFull: textFull || "(e-mail sem conteúdo de texto)",
            });
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }
  return out;
}
