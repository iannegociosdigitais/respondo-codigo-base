import type { SupabaseClient } from "@supabase/supabase-js";
import { hasHebrew } from "@/lib/ai/lang";

// Produto/marca dentro de uma loja (migration 0011). A mesma loja e a mesma
// caixa podem vender OsteoPure e Olavita; o contexto, a persona e a
// assinatura são do produto. Sem a migration, `enabled` = false e tudo
// segue por loja.
export interface Persona {
  name: string;
  role: string;
  closing: string;
}

export interface Product {
  id: string;
  store_id: string;
  name: string;
  email_aliases: string[];
  keywords: string[];
  languages: string[];
  shopify_product_ids: string[];
  personas: Record<string, Persona>;
}

export interface Products {
  enabled: boolean;
  items: Product[];
}

export async function loadProducts(admin: SupabaseClient, storeId?: string): Promise<Products> {
  let q = admin.from("products").select("*");
  if (storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error) return { enabled: false, items: [] };
  return {
    enabled: true,
    items: (data ?? []).map((p) => ({
      id: p.id as string,
      store_id: p.store_id as string,
      name: p.name as string,
      email_aliases: ((p.email_aliases as string[] | null) ?? []).map((a) => a.toLowerCase()),
      keywords: ((p.keywords as string[] | null) ?? []).map((k) => k.toLowerCase()),
      languages: ((p.languages as string[] | null) ?? []).map((l) => l.toLowerCase()),
      shopify_product_ids: (p.shopify_product_ids as string[] | null) ?? [],
      personas: ((p.personas as Record<string, Persona> | null) ?? {}) as Record<string, Persona>,
    })),
  };
}

// O PRODUTO É O QUE O CLIENTE COMPROU — não a caixa que recebeu o e-mail nem
// a loja Shopify em que o pedido está (a mesma Shopify vende vários produtos).
// Evidência, da mais forte pra mais fraca:
//   1. itens do pedido do cliente (título do item casa com palavra-chave do produto)
//   2. id de produto Shopify cadastrado
//   3. tipo de produto que o cliente cita (creme × cápsulas), vindo da triagem
//   4. palavras-chave no texto do cliente
//   5. alias do destinatário / idioma (só desempate)
// `strong` = veio de 1–3: vale mais que um produto já gravado na conversa.
export function routeProduct(
  products: Products,
  input: { storeId: string; recipients: string[]; texts: Array<string | null | undefined>; language?: string | null; shopifyProductIds?: string[]; orderTitles?: string[]; kind?: "creme_cosmetico" | "capsulas_suplemento" | "outro" | "desconhecido" | null }
): (Product & { strong?: boolean }) | null {
  if (!products.enabled) return null;
  const all = [...products.items].sort((a, b) => Number(b.store_id === input.storeId) - Number(a.store_id === input.storeId));
  if (all.length === 0) return null;
  const byName = (list: Product[]) => new Set(list.map((p) => p.name.toLowerCase()));
  const pick = (list: Product[], strong: boolean) => (list.length > 0 && byName(list).size === 1 ? { ...list[0], strong } : null);

  // 1. itens do pedido
  const titles = (input.orderTitles ?? []).join("\n").toLowerCase();
  if (titles.trim()) {
    const hit = pick(all.filter((p) => p.keywords.some((k) => k && titles.includes(k))), true);
    if (hit) return hit;
  }
  // 2. id Shopify
  if (input.shopifyProductIds?.length) {
    const hit = pick(all.filter((p) => p.shopify_product_ids.some((id) => input.shopifyProductIds!.includes(id))), true);
    if (hit) return hit;
  }
  // 3. tipo de produto citado
  const KIND_WORDS: Record<string, string[]> = { creme_cosmetico: ["creme", "cream", "crème", "krem", "קרם"], capsulas_suplemento: ["gélules", "gelules", "capsules", "cápsulas", "moringa"] };
  const kindWords = KIND_WORDS[input.kind ?? ""] ?? [];
  if (kindWords.length > 0) {
    const hit = pick(all.filter((p) => p.keywords.some((k) => kindWords.includes(k))), true);
    if (hit) return hit;
  }
  // 4. palavras-chave no texto do cliente (quem tiver mais ocorrências distintas)
  const text = input.texts.filter(Boolean).join("\n").toLowerCase();
  const hits = all.map((p) => ({ p, n: p.keywords.filter((k) => k && text.includes(k)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (hits.length > 0 && (hits.length === 1 || hits[0].n > hits[1].n || hits[0].p.name === hits[1].p.name)) return { ...hits[0].p, strong: false };
  // 5. desempates fracos
  const rec = input.recipients.map((r) => r.toLowerCase());
  for (const p of all) if (p.email_aliases.some((a) => rec.includes(a))) return { ...p, strong: false };
  const lang = input.language ?? (hasHebrew(text) ? "he" : null);
  if (lang) {
    const own = all.filter((p) => p.store_id === input.storeId);
    const hit = pick((own.length > 0 ? own : all).filter((p) => p.languages.includes(lang)), false);
    if (hit) return hit;
  }
  return null;
}

const DEFAULT_NAMES: Record<string, string> = { pl: "Agnieszka", ro: "Ioana", el: "Ελένη", sv: "Emma", da: "Freja", no: "Ingrid", fi: "Aino", cs: "Tereza", sk: "Zuzana", bg: "Мария", uk: "Олена", hr: "Ana", sr: "Jelena", tr: "Elif", ar: "ليلى", ru: "Анна", fr: "Monique", en: "Emma", he: "מיה", de: "Hanna", hu: "Eszter", es: "Carmen", it: "Chiara", nl: "Sanne", pt: "Sofia" };
const DEFAULT_CLOSING: Record<string, string> = { pl: "Serdecznie pozdrawiam", ro: "Cu drag", el: "Με εκτίμηση", sv: "Varma hälsningar", da: "De bedste hilsner", no: "Vennlig hilsen", fi: "Lämpimin terveisin", cs: "S pozdravem", sk: "S pozdravom", bg: "С уважение", uk: "З теплом", hr: "Srdačan pozdrav", sr: "Срдачан поздрав", tr: "Sevgilerimle", ar: "مع أطيب التحيات", ru: "С теплом", fr: "Chaleureusement", en: "Warmly", he: "בברכה חמה", de: "Herzliche Grüße", hu: "Szeretettel", es: "Un abrazo", it: "Un caro saluto", nl: "Hartelijke groet", pt: "Com carinho" };
const DEFAULT_ROLE: Record<string, (brand: string) => string> = {
  tr: (b) => `${b} Destek Sorumlusu`,
  ar: (b) => `مسؤولة دعم ${b}`,
  ru: (b) => `Руководитель поддержки ${b}`,
  fr: (b) => `La Responsable du Support ${b}`,
  en: (b) => `${b} Support Manager`,
  he: (b) => `אחראית התמיכה של ${b}`,
  de: (b) => `Kundenservice-Leiterin ${b}`,
  hu: (b) => `${b} ügyfélszolgálat vezetője`,
  es: (b) => `Responsable de Atención ${b}`,
  it: (b) => `Responsabile Assistenza ${b}`,
  nl: (b) => `Hoofd Klantenservice ${b}`,
  pt: (b) => `Responsável pelo Suporte ${b}`,
};

// Persona por idioma do cliente: a configurada no produto, senão um padrão
// natural pro idioma (a Monique é francesa; em Israel não faz sentido).
export function personaFor(product: Product | null, brand: string, language: string | null): Persona {
  const lang = (language ?? "fr").toLowerCase().slice(0, 2);
  const configured = product?.personas?.[lang];
  if (configured?.name) return { name: configured.name, role: configured.role || DEFAULT_ROLE[lang]?.(brand) || `${brand} Support`, closing: configured.closing || DEFAULT_CLOSING[lang] || "" };
  // Sem persona configurada pro idioma: nome feminino LOCAL do idioma do
  // cliente (turco → Elif, alemão → Anna…), nunca a Monique fora do francês.
  return { name: DEFAULT_NAMES[lang] ?? DEFAULT_NAMES.en, role: (DEFAULT_ROLE[lang] ?? DEFAULT_ROLE.en)(brand), closing: DEFAULT_CLOSING[lang] ?? DEFAULT_CLOSING.en };
}

// Trava de marca: a resposta de um produto não pode ser ASSINADA com a marca de
// outro (creme Olavita assinado como OsteoPure, por exemplo). Compara a primeira
// palavra do nome de cada produto, sem acento. No ENVIO (texto aprovado pelo
// Ian) só a assinatura conta: no corpo a outra marca pode aparecer, porque o Ian
// explica que "SP OSTEOPURE" na fatura/SMS é o processador de pagamento
// (15/10/2026). Na análise (rascunho da IA) o texto todo é conferido e só marca.
const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const SIGNATURE_CHARS = 160;
export function brandConflict(products: Products, productId: string | null, text: string, opts: { signatureOnly?: boolean } = {}): string | null {
  if (!products.enabled || !productId) return null;
  const mine = products.items.find((p) => p.id === productId);
  if (!mine) return null;
  const myBrand = norm(mine.name.split(/\s+/)[0]);
  const body = norm(opts.signatureOnly ? text.trimEnd().slice(-SIGNATURE_CHARS) : text);
  for (const other of products.items) {
    const brand = norm(other.name.split(/\s+/)[0]);
    if (brand === myBrand || brand.length < 4) continue;
    if (body.includes(brand)) return `a resposta é do produto ${mine.name} mas cita "${other.name.split(/\s+/)[0]}"`;
  }
  return null;
}
