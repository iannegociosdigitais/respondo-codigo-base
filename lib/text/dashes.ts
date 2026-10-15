// Regra do Ian (05/10/2026): NUNCA travessão ("—" ou "–") em texto que vai
// pro cliente. A regra também está no prompt, mas o modelo escorrega; isto é
// a garantia final, aplicada no rascunho e de novo no envio.
export function stripDashes(text: string): string;
export function stripDashes(text: string | null | undefined): string | null | undefined;
export function stripDashes(text: string | null | undefined): string | null | undefined {
  if (!text || !/[—–]/.test(text)) return text;
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2") // faixa numérica: 9–12 → 9-12
    .replace(/^[ \t]*[—–][ \t]*/gm, "") // travessão abrindo a linha
    .replace(/[ \t]*[—–][ \t]*$/gm, "") // travessão fechando a linha
    .replace(/[ \t]*[—–][ \t]*/g, ", ") // no meio da frase vira vírgula
    .replace(/,\s*([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

// Regra do Ian (15/10/2026): nunca lista com marcadores ("•", "-", "*") em
// texto que vai pro cliente. O prompt proíbe; isto garante no envio: cada
// bloco de itens vira um parágrafo de frases corridas.
export function bulletsToProse(text: string): string {
  if (!/^[ \t]*(?:[•*·▪]|-(?=\s))[ \t]+/m.test(text)) return text;
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(run.map((t) => (/[.!?:;]$/.test(t) ? t : `${t}.`)).join(" "));
    run = [];
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^[ \t]*(?:[•*·▪]|-(?=\s))[ \t]+(.*)$/);
    if (m) {
      const item = m[1].trim();
      if (item) run.push(item.charAt(0).toUpperCase() + item.slice(1));
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}
