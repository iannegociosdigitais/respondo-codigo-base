import { EUR_TO_ILS } from "@/lib/ai/context";
import { formatMoney } from "@/lib/forms/format";

// Valor do pedido do jeito que o CLIENTE entende:
//  1. a moeda em que ele pagou no checkout (presentment), quando a Shopify informa;
//  2. cliente de Israel com pedido em EUR → shekel, câmbio fixo da operação (1 EUR = 4 ILS);
//  3. senão, a moeda da loja.
// Formatado no padrão do idioma dele (₪198, 470,00 kr., 56,97 €…).
export function customerAmount(order: { total: string | null; currency: string | null; presentmentTotal?: string | null; presentmentCurrency?: string | null; country?: string | null }): { amount: number; currency: string } | null {
  let amount = Number(order.presentmentTotal ?? order.total);
  let currency = (order.presentmentCurrency ?? order.currency ?? "").toUpperCase();
  if (!Number.isFinite(amount) || !currency) return null;
  if (order.country === "IL" && currency === "EUR") {
    amount = Math.round(amount * EUR_TO_ILS * 10) / 10;
    currency = "ILS";
  }
  return { amount, currency };
}

export function customerMoney(order: Parameters<typeof customerAmount>[0], lang: string | null | undefined): string {
  const shown = customerAmount(order);
  return shown ? formatMoney(shown.amount, shown.currency, lang) : [order.currency, order.total].filter(Boolean).join(" ");
}

// Idioma provável pelo país do pedido — usado quando o link não traz idioma.
const COUNTRY_LANG: Record<string, string> = { IL: "he", DK: "da", TR: "tr", DE: "de", AT: "de", FR: "fr", BE: "fr", LU: "fr", HU: "hu", ES: "es", IT: "it", NL: "nl", PT: "pt", BR: "pt", RU: "ru", AE: "ar", SA: "ar", GB: "en", US: "en", IE: "en" };
export function langFromCountry(country: string | null | undefined): string | null {
  return COUNTRY_LANG[(country ?? "").toUpperCase()] ?? null;
}

// Idioma do COMPROVANTE. O sinal mais preciso é o idioma em que o cliente
// viu o checkout (customerLocale da Shopify: "he-IL", "fr-CH", "fr-CA"…).
// Só pelo país, Suíça e Canadá caíam em inglês mesmo comprando em francês
// (visto na auditoria de 01/10: 8 pedidos em 30 dias). País fica de reserva.
export function orderLanguage(order: { customerLocale?: string | null; countryCode: string | null }, supported: (lang: string) => boolean): string {
  const fromLocale = (order.customerLocale ?? "").toLowerCase().slice(0, 2);
  if (fromLocale && supported(fromLocale)) return fromLocale;
  return langFromCountry(order.countryCode) || "en";
}
