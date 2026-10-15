// Corta a parte citada de uma resposta ("Le 12 mars, X a écrit :", "On ...
// wrote:", "> ...") pra guardar só o que foi escrito de novo. O texto
// completo continua guardado em messages.body_raw.
const CUT_PATTERNS: RegExp[] = [
  /^On .{5,120} wrote:\s*$/m,
  /^Le .{5,120} a écrit\s?:\s*$/m,
  /^Em .{5,120} escreveu:\s*$/m,
  /^El .{5,120} escribió:\s*$/m,
  /^Am .{5,120} schrieb .{0,60}:\s*$/m,
  /^-{2,}\s*(Original Message|Message d'origine|Mensagem original|Mensaje original)\s*-{2,}\s*$/im,
  /^(From|De|Von|Da)\s?:\s.+\n(Sent|Envoyé|Enviado|Gesendet|Date)\s?:/m,
  /^_{10,}\s*$/m,
  /^Envoyé depuis l'application .+$/m,
  /^Envoyé de mon .+$/m,
  /^Sent from my .+$/m,
];

export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const pattern of CUT_PATTERNS) {
    const m = pattern.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  let head = text.slice(0, cut);

  const lines = head.split("\n");
  const firstQuoted = lines.findIndex((l) => l.trimStart().startsWith(">"));
  if (firstQuoted > 0) head = lines.slice(0, firstQuoted).join("\n");

  return head.replace(/\n{3,}/g, "\n\n").trim();
}

// "Re: RE : TR: Fwd: Commande" -> "commande"
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/^(\s*(re|fw|fwd|tr|aw|wg|enc|res|rép|réf)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
