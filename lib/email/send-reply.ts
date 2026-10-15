import nodemailer from "nodemailer";
import { decrypt } from "@/lib/crypto";
import { stripDashes } from "@/lib/text/dashes";

export interface SmtpCredentials {
  smtpHost: string;
  smtpPort: number;
  emailAddress: string;
  credentialEncrypted: string;
}

// Envia a resposta pro cliente, dentro da mesma thread do e-mail original
// (In-Reply-To/References), pra cair como resposta no cliente de e-mail
// dele e pra pasta Enviados casar com a conversa quando for reimportada.
export async function sendReply(params: {
  emailAccount: SmtpCredentials;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string[];
  // e-mail já montado em HTML (recibo); sem isso o HTML sai do texto
  html?: string;
  // nome que aparece como remetente (a marca do produto)
  fromName?: string;
  // imagens embutidas (logo) via Content-ID, em vez de link remoto — o
  // cliente de e-mail não depende de buscar nada de fora na hora de abrir.
  attachments?: Array<{ filename: string; content: Buffer; cid: string; contentType?: string }>;
}): Promise<{ messageId: string | null }> {
  const transporter = nodemailer.createTransport({
    host: params.emailAccount.smtpHost,
    port: params.emailAccount.smtpPort,
    secure: params.emailAccount.smtpPort === 465,
    auth: {
      user: params.emailAccount.emailAddress,
      pass: decrypt(params.emailAccount.credentialEncrypted),
    },
  });

  // Nunca travessão no corpo que vai pro cliente (regra do Ian, 05/10).
  const body = stripDashes(params.body);
  const info = await transporter.sendMail({
    from: params.fromName ? { name: params.fromName, address: params.emailAccount.emailAddress } : params.emailAccount.emailAddress,
    to: params.to,
    subject: params.subject,
    text: body,
    html: params.html ?? toHtml(body),
    inReplyTo: params.inReplyTo ?? undefined,
    references: params.references && params.references.length > 0 ? params.references : undefined,
    attachments: params.attachments,
  });

  return { messageId: info.messageId ?? null };
}

// Texto puro continua indo; a versão HTML garante a direção: hebraico e árabe
// alinhados à direita mesmo em linhas que começam com nome/numero em latim.
function toHtml(body: string): string {
  const rtl = /[\u0590-\u05FF\u0600-\u06FF]/.test(body);
  const esc = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  return `<div dir="${rtl ? "rtl" : "ltr"}" style="text-align:${rtl ? "right" : "left"};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">${esc}</div>`;
}
