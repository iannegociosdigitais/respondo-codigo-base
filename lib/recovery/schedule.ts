// Horário permitido pra mandar mensagem de recuperação, no fuso do PAÍS do
// cliente (não do servidor). Regra 2.2 da spec:
//  - quiet_hours {start: 9, end: 21}: nada antes das 9h nem depois das 21h locais
//  - shabbat: true e país IL: nada entre sexta 15:00 e sábado 20:00 (DESLIGADO por padrão; o Ian liberou sexta e sábado em 09/10)
// Fora da janela, a função devolve o PRÓXIMO instante permitido. Tudo com
// Intl.DateTimeFormat (nada de biblioteca nova).

export interface QuietHours {
  start?: number;
  end?: number;
  shabbat?: boolean;
  tz?: string; // sobrepõe o fuso do país (opcional)
}

const TZ_BY_COUNTRY: Record<string, string> = {
  IL: "Asia/Jerusalem",
  BR: "America/Sao_Paulo",
  FR: "Europe/Paris",
  BE: "Europe/Paris",
  LU: "Europe/Paris",
  BG: "Europe/Sofia",
  HU: "Europe/Budapest",
  RO: "Europe/Bucharest",
  TR: "Europe/Istanbul",
  PL: "Europe/Warsaw",
  SE: "Europe/Stockholm",
  DE: "Europe/Berlin",
  AT: "Europe/Berlin",
  CH: "Europe/Berlin",
};
export const DEFAULT_TZ = "Europe/Paris";

// Fuso pelo idioma, usado SÓ quando o carrinho veio sem país (country_code
// nulo): carrinho em hebraico sem país caía em Europe/Paris e o horário
// silencioso ficava 1 h fora em Israel.
const TZ_BY_LANGUAGE: Record<string, string> = {
  he: "Asia/Jerusalem",
};

// País presente manda (comportamento de sempre, mesmo que o país não esteja
// na tabela); sem país, o idioma decide; sem os dois, DEFAULT_TZ.
export function tzForCountry(countryCode: string | null | undefined, language?: string | null): string {
  const country = (countryCode ?? "").trim().toUpperCase();
  if (country) return TZ_BY_COUNTRY[country] ?? DEFAULT_TZ;
  return TZ_BY_LANGUAGE[(language ?? "").trim().toLowerCase().slice(0, 2)] ?? DEFAULT_TZ;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = domingo ... 6 = sábado
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}

// Hora local (parede) de um instante num fuso.
export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) if (p.type !== "literal") parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

// Diferença (ms) entre a hora de parede do fuso e o UTC, naquele instante.
function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, date.getUTCSeconds(), date.getUTCMilliseconds());
  return asUtc - date.getTime();
}

// Instante que corresponde a "dia de `ref` + dayOffset, às hour:minute" na
// hora local do fuso. Recalcula o offset uma vez pra atravessar horário de verão.
export function atLocalTime(ref: Date, tz: string, dayOffset: number, hour: number, minute = 0): Date {
  const p = localParts(ref, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day + dayOffset, hour, minute, 0, 0);
  const guess = new Date(wall - offsetMs(ref, tz));
  return new Date(wall - offsetMs(guess, tz));
}

const clampHour = (h: unknown, fallback: number) => {
  const n = Number(h);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.floor(n))) : fallback;
};

// Próximo instante permitido a partir de `date` (o próprio `date`, se já for
// permitido). Nunca devolve algo antes de `date`. `language` (opcional) só
// entra quando falta o país (ver tzForCountry).
export function nextAllowedTime(date: Date, countryCode: string | null | undefined, quiet: QuietHours | null | undefined, language?: string | null): Date {
  const tz = quiet?.tz || tzForCountry(countryCode, language);
  const start = clampHour(quiet?.start, 9);
  const end = clampHour(quiet?.end, 21);
  const shabbat = quiet?.shabbat === true && (countryCode ?? "").toUpperCase() === "IL"; // desligado por padrão (Ian, 09/10: pode mandar sexta e sábado)
  let t = new Date(date.getTime());
  // No máximo 14 ajustes: cada volta empurra pelo menos até o próximo marco.
  for (let i = 0; i < 14; i += 1) {
    const p = localParts(t, tz);
    if (shabbat) {
      // sexta a partir das 15:00 → sábado 20:00; sábado antes das 20:00 → sábado 20:00
      if (p.weekday === 5 && p.hour >= 15) {
        t = atLocalTime(t, tz, 1, 20);
        continue;
      }
      if (p.weekday === 6 && p.hour < 20) {
        t = atLocalTime(t, tz, 0, 20);
        continue;
      }
    }
    // start >= end = sem horário silencioso (só shabbat).
    if (start < end) {
      if (p.hour < start) {
        t = atLocalTime(t, tz, 0, start);
        continue;
      }
      if (p.hour >= end) {
        t = atLocalTime(t, tz, 1, start);
        continue;
      }
    }
    return t;
  }
  return t;
}

export function isAllowedNow(date: Date, countryCode: string | null | undefined, quiet: QuietHours | null | undefined, language?: string | null): boolean {
  return nextAllowedTime(date, countryCode, quiet, language).getTime() === date.getTime();
}

// Soma minutos e já cai no próximo horário permitido.
export function scheduleAfter(from: Date, minutes: number, countryCode: string | null | undefined, quiet: QuietHours | null | undefined, language?: string | null): Date {
  return nextAllowedTime(new Date(from.getTime() + Math.max(0, minutes) * 60_000), countryCode, quiet, language);
}
