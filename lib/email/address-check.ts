import { promises as dns } from "dns";
import { isIP } from "net";

// Checagem barata do endereço do cliente ANTES do primeiro e-mail de
// marketing: endereço digitado errado no checkout vira bounce permanente, e o
// histórico do Klaviyo mostrou 4,5% de bounce no 1º e-mail do carrinho (acima
// do limite de 4% do Resend). Três filtros:
//  1. sintaxe;
//  2. domínio de erro de digitação conhecido (gmil.com, gamil.com, hotmial.com):
//     vários têm MX "pega-tudo" de terceiros (armadilha de spam), então não
//     basta checar o MX;
//  3. domínio sem MX, ou com MX nulo (RFC 7505, "0 ."): ninguém recebe. Conta
//     como nulo também o MX que aponta pra localhost ou pra um IP literal
//     (gimail.com publica "0 localhost."): nenhum servidor de verdade recebe.
// Erro temporário de DNS (timeout, SERVFAIL) NÃO bloqueia: devolve null e o
// e-mail segue (o webhook de bounce continua protegendo).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const TYPO_DOMAINS = new Set([
  "gmil.com", "gmial.com", "gmai.com", "gamil.com", "gmaill.com", "gnail.com", "gmal.com", "gmaul.com", "gmeil.com", "gmali.com",
  "gmail.co", "gmail.con", "gmail.cm", "gmail.om", "gmail.comm", "gmail.cim", "gmail.vom", "gmail.xom", "gmail.co.il", "gmail.il",
  "hotmial.com", "hotmal.com", "hotmai.com", "hotmil.com", "homtail.com", "hotmail.co", "hotmail.con", "hotamil.com",
  "yaho.com", "yahooo.com", "yahoo.con", "yhoo.com", "yahho.com",
  "outlok.com", "outlook.con", "outllok.com", "iclod.com", "icloud.con", "icoud.com",
  "walla.con", "wala.com", "wala.co.il", "walla.co", "abv.gb", "abv.bh", "abv.com",
  "gimail.com", "gmaik.com", "gmsil.com", "gmail.coml",
]);

// MX que não entrega pra ninguém: vazio ou "." (RFC 7505), localhost (ou
// *.localhost) e IP literal (MX tem que ser nome de host; IP literal, ainda
// mais de loopback ou rede privada, é armadilha ou configuração quebrada).
export function isNullMxExchange(exchange: string | null | undefined): boolean {
  const host = String(exchange ?? "").trim().toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true; // "" ou "."
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0;
}

const CACHE_MS = 6 * 3600_000;
const cache = new Map<string, { at: number; problem: string | null }>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// null = pode mandar; string = motivo para NÃO mandar.
export async function emailAddressProblem(email: string | null | undefined): Promise<string | null> {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return "sintaxe_invalida";
  const domain = addr.split("@")[1];
  if (TYPO_DOMAINS.has(domain)) return `dominio_com_erro_de_digitacao:${domain}`;
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.problem;
  let problem: string | null = null;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 4000);
    const real = mx.filter((r) => !isNullMxExchange(r.exchange));
    if (real.length === 0) problem = `dominio_sem_mx:${domain}`;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Domínio não existe ou não tem registro MX: definitivo. O resto é temporário.
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") problem = `dominio_sem_mx:${domain}`;
    else return null;
  }
  cache.set(domain, { at: Date.now(), problem });
  return problem;
}
