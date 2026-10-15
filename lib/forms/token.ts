import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { decrypt } from "@/lib/crypto";

// Link PESSOAL do formulário: o e-mail do cliente, o produto e o idioma vão
// cifrados no próprio link (nada de e-mail em texto na URL). Quem abre o link
// já cai nos pedidos daquele cliente; o link genérico do produto pede o e-mail.
export interface FormLinkPayload {
  e?: string; // e-mail do cliente
  p?: string; // produto (nome)
  l?: string; // idioma
  c?: string; // conversa de origem
}

// Link que vai no e-mail do cliente: nunca localhost (rascunho gerado numa
// máquina local saía com http://localhost:3000/solicitacao).
const RAW_APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
export const APP_URL = !RAW_APP_URL || /localhost|127\.0\.0\.1|\[::1\]/.test(RAW_APP_URL) ? "https://SEU-APP" : RAW_APP_URL;

// Formato curto: AES-256-GCM em bytes crus (iv 12 + tag 16 + dados) → base64url.
// Fica com menos da metade do tamanho do formato antigo (hex dentro de base64).
function key(): Buffer {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("CREDENTIALS_ENCRYPTION_KEY não configurada no ambiente.");
  return createHash("sha256").update(`form-link:${secret}`).digest();
}

export function makeFormToken(payload: FormLinkPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const packed = [payload.e ?? "", payload.p ?? "", payload.l ?? "", payload.c ?? ""].join("\n");
  const data = Buffer.concat([cipher.update(packed, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

function readShort(token: string): FormLinkPayload | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const [e, p, l, c] = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8").split("\n");
    return { e: e || undefined, p: p || undefined, l: l || undefined, c: c || undefined };
  } catch {
    return null;
  }
}

export function readFormToken(token: string | null | undefined): FormLinkPayload | null {
  if (!token) return null;
  const short = readShort(token);
  if (short) return short;
  // Links já enviados no formato antigo continuam abrindo.
  try {
    return JSON.parse(decrypt(Buffer.from(token, "base64url").toString("utf8"))) as FormLinkPayload;
  } catch {
    return null;
  }
}

export function formLink(payload: FormLinkPayload): string {
  return `${APP_URL}/solicitacao?t=${makeFormToken(payload)}`;
}
