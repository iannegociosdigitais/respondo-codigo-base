// Trava contra e-mail que sai com outro idioma misturado (08/10: um rascunho
// em hebraico foi enviado com o segundo parágrafo inteiro em PT-BR; um turco
// saiu com a despedida em alfabeto cirílico).
const PT_WORDS = /\b(você|voce|não|obrigad[ao]|pedido|está|estou|então|já|equipe|anotei|tranquila|tranquilo|entrega|enviado|prazo|úteis|carinho|preparação|acompanhando|precisar|ajudar|seu|sua)\b/gi;
const SCRIPT: Record<string, RegExp> = { cyrillic: /[Ѐ-ӿ]/, hebrew: /[֐-׿]/, arabic: /[؀-ۿ]/ };
const NATIVE: Record<string, string> = { ru: "cyrillic", uk: "cyrillic", bg: "cyrillic", sr: "cyrillic", he: "hebrew", ar: "arabic" };

export function portugueseLeak(text: string, language: string | null | undefined): string[] {
  const lang = (language ?? "").toLowerCase();
  if (!lang || lang.startsWith("pt")) return [];
  const body = text ?? "";
  // Alfabeto estranho ao idioma (cirílico num e-mail turco, hebraico num francês).
  const own = NATIVE[lang.slice(0, 2)];
  const foreign = Object.entries(SCRIPT).filter(([name, re]) => name !== own && re.test(body)).map(([name]) => `alfabeto ${name}`);
  // Espanhol/italiano dividem palavras com o português: só olhar as inequívocas.
  const romance = /^(es|it|gl|ca)/.test(lang);
  const words = [...new Set((body.match(PT_WORDS) ?? []).map((w) => w.toLowerCase()))];
  const strong = words.filter((w) => !romance || /^(você|voce|não|obrigad|então|anotei|úteis|carinho|preparação)/.test(w));
  return [...foreign, ...(strong.length >= 3 ? strong : [])];
}
