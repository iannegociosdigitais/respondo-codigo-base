// Formatação que roda igual no servidor e no navegador (sem dependências).
const LOCALE: Record<string, string> = { he: "he-IL", da: "da-DK", fr: "fr-FR", de: "de-DE", tr: "tr-TR", hu: "hu-HU", es: "es-ES", it: "it-IT", nl: "nl-NL", ar: "ar-u-nu-latn", ru: "ru-RU", pt: "pt-BR", en: "en-GB" };

export function formLocale(lang: string | null | undefined): string {
  return LOCALE[(lang ?? "").slice(0, 2)] ?? "en-GB";
}

// ₪198 · 470 kr. · 56,97 € — no padrão do idioma do cliente.
export function formatMoney(amount: number, currency: string, lang: string | null | undefined): string {
  try {
    return new Intl.NumberFormat(formLocale(lang), { style: "currency", currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatDate(iso: string, lang: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleDateString(formLocale(lang), { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}
