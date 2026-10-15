// Telefone do checkout → E.164 ("+9725...") e id de chat do WhatsApp.
// A Shopify devolve o telefone como o cliente digitou: "050-123-4567",
// "+972 50 123 4567", "0033 6...", "0888123456" (BG). Sem normalizar, a
// mesma pessoa vira dois telefones e a regra "parou porque comprou" falha.

// Código do país → prefixo internacional.
const DIAL: Record<string, string> = {
  IL: "972", FR: "33", BE: "32", BG: "359", HU: "36", RO: "40", TR: "90", SE: "46", DE: "49", IT: "39", ES: "34", PT: "351",
  NL: "31", CH: "41", AT: "43", PL: "48", CZ: "420", SK: "421", GR: "30", GB: "44", IE: "353", DK: "45", NO: "47", FI: "358",
  LU: "352", HR: "385", SI: "386", LT: "370", LV: "371", EE: "372", CY: "357", MT: "356", US: "1", CA: "1", BR: "55", MX: "52",
  AU: "61", NZ: "64", ZA: "27", AE: "971", SA: "966", AR: "54", CL: "56", CO: "57",
};
// Países onde o "0" inicial é prefixo de tronco (cai fora no formato internacional).
const TRUNK_ZERO = new Set(["IL", "FR", "BE", "BG", "HU", "RO", "TR", "SE", "DE", "NL", "CH", "AT", "PL", "GB", "IE", "FI", "HR", "SI", "GR", "ZA", "AU", "NZ", "AR", "BR"]);

export function normalizePhone(raw: string | null | undefined, countryCode: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const cc = countryCode ? DIAL[countryCode.toUpperCase()] : undefined;
  let digits: string;
  if (s.startsWith("+")) {
    digits = s.slice(1);
  } else if (cc && s.startsWith("0")) {
    digits = cc + s.slice(1);
  } else if (cc && !s.startsWith(cc) && s.length <= 10) {
    // número local sem o zero ("501234567" em Israel)
    digits = cc + s;
  } else {
    digits = s;
  }
  digits = digits.replace(/\D/g, "");
  // "+972 050..." → tira o zero de tronco depois do código do país
  if (cc && countryCode && TRUNK_ZERO.has(countryCode.toUpperCase()) && digits.startsWith(`${cc}0`) && digits.length > cc.length + 8) {
    digits = cc + digits.slice(cc.length + 1);
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

// WAHA: "972501234567@c.us". Pra números brasileiros o WAHA pede pra usar
// o chatId devolvido por /api/contacts/check-exists (nono dígito).
export const chatIdFromPhone = (e164: string) => `${e164.replace(/\D/g, "")}@c.us`;
export const phoneFromChatId = (chatId: string) => {
  const digits = chatId.split("@")[0].replace(/\D/g, "");
  return digits ? `+${digits}` : null;
};
