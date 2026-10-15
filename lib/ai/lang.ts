// O modelo devolve o idioma em texto livre ("frances", "français", "anglais",
// "english"...). Normalizamos pra código curto pra filtro e exibição.
const MAP: Array<[RegExp, string]> = [
  [/^(fr|franc|frança)/i, "fr"],
  [/^(en|ingl|angl)/i, "en"],
  [/^(he|hebr|ivrit|עברית)/i, "he"],
  [/^(pt|portug)/i, "pt"],
  [/^(es|espan|spanish|castel)/i, "es"],
  [/^(de|alem|german|deutsch)/i, "de"],
  [/^(it|ital)/i, "it"],
  [/^(tr|turc|turk)/i, "tr"],
  [/^(nl|holand|neerland|dutch)/i, "nl"],
  [/^(ar|arab)/i, "ar"],
  [/^(da|dan|dinamar)/i, "da"],
  [/^(sv|swed|suec|svensk)/i, "sv"],
  [/^(no|nb|norueg|norw|norsk)/i, "no"],
  [/^(hu|hung|hún|magyar)/i, "hu"],
  [/^(ru|russ)/i, "ru"],
  [/^(pl|pol)/i, "pl"],
];

export function normalizeLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  for (const [re, code] of MAP) if (re.test(v)) return code;
  return v.slice(0, 12);
}

export const LANG_LABEL: Record<string, string> = {
  fr: "francês",
  en: "inglês",
  he: "hebraico",
  pt: "português",
  es: "espanhol",
  de: "alemão",
  it: "italiano",
  tr: "turco",
  nl: "holandês",
  ar: "árabe",
  da: "dinamarquês",
  sv: "sueco",
  no: "norueguês",
  hu: "húngaro",
  ru: "russo",
  pl: "polonês",
};

export function hasHebrew(text: string | null | undefined): boolean {
  return /[֐-׿]/.test(text ?? "");
}

// Cliente israelense que escreveu sem hebraico (inglês, por exemplo): o texto
// sozinho não detecta, mas o domínio do e-mail é um sinal forte.
const ISRAELI_EMAIL_DOMAINS = ["walla.com", "walla.co.il", "bezeqint.net", "013.net", "013net.net", "netvision.net.il", "012.net.il"];
export function isIsraeliEmail(email: string | null | undefined): boolean {
  const domain = (email ?? "").toLowerCase().split("@")[1] ?? "";
  if (!domain) return false;
  return domain.endsWith(".il") || ISRAELI_EMAIL_DOMAINS.includes(domain);
}
