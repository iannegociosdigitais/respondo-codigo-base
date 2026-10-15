import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

// Os títulos dos itens vêm da Shopify no idioma da loja (alemão, francês…).
// No formulário o cliente tem que ler no idioma dele. Tradução curta, com
// cache em memória e teto de tempo: se falhar, fica o título original.
const cache = new Map<string, string>();
const Out = z.object({ titles: z.array(z.string()) });
const LANG_NAME: Record<string, string> = { he: "hebraico", da: "dinamarquês", tr: "turco", hu: "húngaro", es: "espanhol", it: "italiano", nl: "holandês", ar: "árabe", ru: "russo", pt: "português do Brasil", en: "inglês", fr: "francês", de: "alemão" };

export async function localizeItemTitles(titles: string[], lang: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(titles)];
  const missing = unique.filter((t) => !cache.has(`${lang}|${t}`));
  if (missing.length > 0 && process.env.OPENAI_API_KEY) {
    try {
      const response = await Promise.race([
        client.responses.parse({
          model: MODEL,
          input: [
            { role: "system", content: `Você recebe uma lista JSON com nomes de itens de um pedido de loja online, escritos no idioma da loja (alemão, francês, inglês…). Reescreva CADA item em ${LANG_NAME[lang] ?? lang}, do jeito que uma loja local escreveria. TODA palavra comum tem que ser traduzida (ex.: "Überraschungsgeschenk GRATIS" = presente surpresa grátis; "Tiegel" = pote; "Cure" = tratamento; "GRATIS/FREE/OFFERT" = grátis). NÃO traduza nem translitere nomes próprios de marca e produto: Olavita, Tri-Lift, Peptide Complex, OsteoPure, Moringa — eles ficam em letras latinas exatamente como estão. Mantenha números, "×", "+" e "™". Devolva a lista na MESMA ordem e com o MESMO tamanho.` },
            { role: "user", content: JSON.stringify(missing) },
          ],
          text: { format: zodTextFormat(Out, "titles") },
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      const translated = response?.output_parsed?.titles;
      if (translated && translated.length === missing.length) missing.forEach((t, i) => cache.set(`${lang}|${t}`, translated[i].trim() || t));
    } catch (e) {
      console.error("localizeItemTitles:", e instanceof Error ? e.message : e);
    }
  }
  for (const t of unique) out.set(t, cache.get(`${lang}|${t}`) ?? t);
  return out;
}
