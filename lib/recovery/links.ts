import { createHash, createHmac, timingSafeEqual } from "crypto";
import { APP_URL } from "@/lib/forms/token";
import type { RecoveryRow } from "@/lib/recovery/types";

// Links que vão dentro das mensagens de recuperação:
//  - clique:      /api/public/r/<token>  → registra o clique e manda pro checkout (com cupom)
//  - descadastro: /api/public/u/<token>  → página de confirmação + one-click (RFC 8058)
// O token é assinado (HMAC) com uma chave derivada da CREDENTIALS_ENCRYPTION_KEY:
// ninguém consegue forjar um clique/descadastro de outra pessoa, e nenhum
// e-mail ou telefone aparece na URL.

export type RecoveryLinkKind = "run";

export interface RecoveryTokenPayload {
  r: string; // recovery id (carrinho) ou run id (pós-compra, com k = 'run')
  s?: number; // degrau
  c?: string; // canal (email / whatsapp / sms)
  d?: string; // código do cupom usado no degrau (a rota /r redireciona com ele sem consultar tabela)
  // Envio de TESTE (modo de teste ou "Testar este passo"): as rotas /r e /u
  // não gravam evento, não suprimem e não mudam status. O carrinho usado no
  // teste é real; sem essa marca, um clique ou descadastro do Ian atingiria o
  // cliente verdadeiro.
  t?: 1;
  // k = 'run': o id é de post_purchase_runs (fluxo pós-compra). A rota /u
  // para o run e a /r registra o clique e manda pro "fale conosco".
  k?: RecoveryLinkKind;
}

function key(): Buffer {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("CREDENTIALS_ENCRYPTION_KEY não configurada no ambiente.");
  return createHash("sha256").update(`recovery-link:${secret}`).digest();
}

const sign = (body: string) => createHmac("sha256", key()).update(body).digest("base64url").slice(0, 22);

export function makeRecoveryToken(payload: RecoveryTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readRecoveryToken(token: string | null | undefined): RecoveryTokenPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const expected = sign(body);
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RecoveryTokenPayload;
    return typeof payload.r === "string" && /^[0-9a-f-]{36}$/i.test(payload.r) ? payload : null;
  } catch {
    return null;
  }
}

// `discountCode` opcional: vai dentro do token (campo d) pra rota /r aplicar
// exatamente o cupom que saiu na mensagem, mesmo que a régua mude depois.
// `isTest`: marca t:1 no token (clique/descadastro de teste não grava nada).
// `kind` = 'run': o id é de um run do pós-compra (post_purchase_runs).
export const clickLink = (recoveryId: string, step: number, channel: string, discountCode?: string | null, isTest?: boolean, kind?: RecoveryLinkKind) =>
  `${APP_URL}/api/public/r/${makeRecoveryToken({ r: recoveryId, s: step, c: channel, ...(discountCode ? { d: discountCode } : {}), ...(isTest ? { t: 1 as const } : {}), ...(kind ? { k: kind } : {}) })}`;
export const unsubscribeLink = (recoveryId: string, channel: string, isTest?: boolean, kind?: RecoveryLinkKind) =>
  `${APP_URL}/api/public/u/${makeRecoveryToken({ r: recoveryId, c: channel, ...(isTest ? { t: 1 as const } : {}), ...(kind ? { k: kind } : {}) })}`;

// URL de recuperação da Shopify já vem com "?key=...&locale=he-IL"; o cupom
// entra como &discount=CODIGO e a Shopify abre o checkout com ele aplicado.
// (Klaviyo faz exatamente isso. Testar em cada loja qual preço final aparece,
// porque o cupom do funil já está no carrinho.)
export function recoveryUrlWithDiscount(recoveryUrl: string, code: string | null | undefined): string {
  if (!code) return recoveryUrl;
  const sep = recoveryUrl.includes("?") ? "&" : "?";
  return `${recoveryUrl}${sep}discount=${encodeURIComponent(code)}`;
}

// Cupons antigos dos anúncios da loja em hebraico (Ian, 10/10: os valores na
// Shopify ficam como estão). Hoje valem 1/4 do que valiam quando o carrinho
// foi criado (um kit que a cliente viu por ₪315 abre por ₪716). A URL de
// recuperação da Shopify reaplica o cupom do checkout e &discount= não troca:
// SOMA. Pra esses carrinhos o link leva o cupom equivalente de hoje (mesmo
// kit, valor em shekel) junto com o cupom do passo. Enquanto o cupom antigo
// estiver ATIVO na Shopify os três somam (kit de 4 a ₪94); com o antigo
// desativado, o checkout o descarta e abre no preço que a cliente viu (₪315)
// menos o adicional. Por isso esses carrinhos ficam segurados até o Ian
// desativar os cupons antigos. (Permalink do carrinho não serve: abre no
// preço de HOJE da loja, maior que o do checkout da cliente.)
export const LEGACY_CODE_MAP: Record<string, string> = {
  "4OLAVITAIL-PV2": "4OLAVITA-ILS",
  "4OLAVITAIL": "4OLAVITA-ILS",
  "2OLAVITAIL-PV2": "2OLAVITA-ILS",
  "2OLAVITAIL": "2OLAVITA-ILS",
  "1OLAVITAIL-PV2": "1OLAVITA-ILS",
  "1OLAVITAIL": "1OLAVITA-ILS",
};
// ESPERA dos carrinhos com cupom antigo (decisão pendente do dono): enquanto
// estiver true, nenhum e-mail, passo do WhatsApp ou link do agente sai para
// esses carrinhos (o link abre no preço errado). Para liberar: false e deploy;
// os carrinhos voltam sozinhos no próximo ciclo (a espera só empurra a data).
export const HOLD_LEGACY_COUPON_CARTS = true;
export const hasLegacyCoupon = (codes: string[] | null | undefined): boolean => legacyCodeReplacement(codes) != null;
export function legacyCodeReplacement(codes: string[] | null | undefined): string | null {
  for (const c of codes ?? []) {
    const hit = LEGACY_CODE_MAP[String(c).trim().toUpperCase()];
    if (hit) return hit;
  }
  return null;
}
export function checkoutUrlFor(rec: Pick<RecoveryRow, "recovery_url" | "discount_codes" | "items">, code: string | null | undefined): string {
  const replacement = legacyCodeReplacement(rec.discount_codes);
  if (!replacement) return recoveryUrlWithDiscount(rec.recovery_url, code);
  const step = code?.trim() ?? "";
  const codes = [replacement, ...(step && step.toUpperCase() !== replacement ? [step] : [])];
  return recoveryUrlWithDiscount(rec.recovery_url, codes.join(","));
}
