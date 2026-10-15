import { brandLook, cleanItemTitle } from "@/lib/receipts/build";
import { formatMoney } from "@/lib/forms/format";
import type { RecoveryItem, RecoveryStep } from "@/lib/recovery/types";

// Templates da régua: substituição de variáveis, escolha de idioma e de
// variante (WhatsApp sorteia uma por envio) e o HTML do e-mail com a cara da
// marca (logo/cor de brandLook, RTL pra hebraico).
//
// Variáveis aceitas no texto dos passos (regra 2.4 da spec + pós-compra):
//   {{nome}} {{produto}} {{itens}} {{valor}} {{link}} {{cupom}} {{desconto}} {{marca}} {{agente}}
//   {{pedido}} (número do pedido) {{rastreio}} (código) {{link_rastreio}} (página de rastreio)
// Chave desconhecida vira vazio. Sem nome, a vírgula/espaço ao redor some
// ("Oi {{nome}}, tudo bem?" → "Oi, tudo bem?"). Linha que fica só com um
// rótulo e uma variável vazia ("Código de rastreio: " sem código, ou uma
// linha só com {{link_rastreio}} vazio) é removida inteira.

export const TEMPLATE_VARS = ["nome", "produto", "itens", "valor", "link", "cupom", "desconto", "economia", "preco_final", "marca", "agente", "pedido", "rastreio", "link_rastreio"] as const;
export type TemplateVarName = (typeof TEMPLATE_VARS)[number];
export type TemplateVars = Partial<Record<TemplateVarName, string | null | undefined>> & Record<string, string | null | undefined>;

const NOME = "\\{\\{\\s*nome\\s*\\}\\}";
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Linha que, depois da substituição, ficou só com rótulo ("Código: ") ou
// vazia, porque TODAS as variáveis dela estavam vazias: cai fora. Linha sem
// variável nunca é tocada.
function renderLine(line: string, vars: TemplateVars): string | null {
  let hadVar = false;
  let hadValue = false;
  const out = line.replace(VAR_RE, (_m, key: string) => {
    hadVar = true;
    const v = vars[key as TemplateVarName];
    const s = v == null ? "" : String(v);
    if (s.trim()) hadValue = true;
    return s;
  });
  if (!hadVar || hadValue) return out;
  // sobrou só rótulo (termina em ":" ou é só pontuação/espaço) → remove a linha
  const rest = out.trim();
  if (!rest || /[:：]\s*$/.test(rest) || /^[\s\p{P}\p{S}]*$/u.test(rest)) return null;
  return out;
}

export function renderTemplate(text: string | null | undefined, vars: TemplateVars): string {
  let out = text ?? "";
  if (!out) return "";
  const nome = (vars.nome ?? "").trim();
  if (!nome) {
    out = out
      // começo de linha: "{{nome}}, consegui liberar" → "Consegui liberar"
      .replace(new RegExp(`^([ \\t]*)${NOME}[ \\t]*[,!]?[ \\t]*(\\S)`, "gm"), (_m, ws: string, ch: string) => ws + ch.toLocaleUpperCase())
      // ", {{nome}}" → ""  (Здравей, {{nome}}! → Здравей!)
      .replace(new RegExp(`[,،][ \\t]*${NOME}`, "g"), "")
      // " {{nome}}," → ","  (Oi {{nome}}, tudo bem → Oi, tudo bem)
      .replace(new RegExp(`[ \\t]*${NOME}[ \\t]*,`, "g"), ",")
      // o que sobrou
      .replace(new RegExp(`[ \\t]*${NOME}`, "g"), "");
  }
  out = out
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => renderLine(line, vars))
    .filter((line): line is string => line != null)
    .join("\n");
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Idioma do texto: o do cliente; senão en; senão NADA (null = o passo não sai
// nesse idioma e o motor registra sem_idioma). Nunca mais hebraico pra quem
// não é hebraico, nem "o primeiro disponível". Português NUNCA vai pra
// cliente. (`countryCode` fica na assinatura por compatibilidade; não pesa.)
// allowPt: só o teste do dono ("como cliente", em português); cliente nunca recebe pt.
export function pickLanguage(available: string[], language: string | null | undefined, _countryCode?: string | null, allowPt = false): string | null {
  const want = (language ?? "").toLowerCase().slice(0, 2);
  if (allowPt && want === "pt" && available.some((l) => l.toLowerCase() === "pt")) return "pt";
  const avail = available.map((l) => l.toLowerCase()).filter((l) => l && !l.startsWith("pt"));
  if (avail.length === 0) return null;
  if (want && avail.includes(want)) return want;
  if (avail.includes("en")) return "en";
  return null;
}

// Texto por idioma de um campo jsonb (prévia, botão): o idioma pedido, senão
// en, senão vazio. Nunca pt.
export function pickLocalized(map: Record<string, string> | null | undefined, lang: string): string {
  const m = (map ?? {}) as Record<string, string>;
  if (nonEmpty(m[lang])) return m[lang].trim();
  if (lang !== "en" && nonEmpty(m.en)) return m.en.trim();
  return "";
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function variants(raw: string | string[] | undefined | null): string[] {
  if (Array.isArray(raw)) return raw.filter(nonEmpty);
  return nonEmpty(raw) ? [raw] : [];
}

export interface PickedBody {
  lang: string;
  text: string; // ainda com {{variáveis}}
  index: number; // variante escolhida (WhatsApp)
  textPt: string | null; // mesma variante em PT (body.pt), se existir, pro painel
}

// Corpo do passo no idioma certo. Array = sorteia uma variante (ou usa
// `variantIndex`, pra teste/prévia determinística).
export function pickStepBody(step: Pick<RecoveryStep, "body">, language: string | null | undefined, countryCode?: string | null, variantIndex?: number, allowPt = false): PickedBody | null {
  const body = (step.body ?? {}) as Record<string, string | string[]>;
  const available = Object.keys(body).filter((k) => variants(body[k]).length > 0);
  const lang = pickLanguage(available, language, countryCode, allowPt);
  if (!lang) return null;
  const list = variants(body[lang]);
  const index = variantIndex != null && Number.isFinite(variantIndex) ? ((variantIndex % list.length) + list.length) % list.length : Math.floor(Math.random() * list.length);
  const ptList = variants(body.pt);
  const textPt = ptList.length === 0 ? null : (ptList[index % ptList.length] ?? ptList[0]);
  return { lang, text: list[index], index, textPt };
}

// Assunto no idioma do corpo; senão en; senão vazio (o motor cai no rótulo
// padrão). Nunca "o primeiro disponível": seria assunto em outro idioma.
export function pickStepSubject(step: Pick<RecoveryStep, "subject">, lang: string): string {
  return pickLocalized((step.subject ?? {}) as Record<string, string>, lang);
}

// --- E-mail -------------------------------------------------------------------

// `order`/`contact`/`unsubscribeOrder`: pós-compra (cabeçalho dos itens com o
// número do pedido, botão "fale conosco", descadastro das atualizações).
interface EmailLabels { button: string; cart: string; total: string; coupon: string; unsubscribe: string; order: string; contact: string; unsubscribeOrder: string; reply?: string }
export const EMAIL_LABELS: Record<string, EmailLabels> = {
  he: { button: "להשלמת ההזמנה", cart: "העגלה שלך", total: 'סה"כ', coupon: "קוד קופון", unsubscribe: "להפסיק לקבל תזכורות על העגלה", order: "ההזמנה שלך", contact: "לדבר איתנו", unsubscribeOrder: "להפסיק לקבל עדכונים על ההזמנה", reply: "יש לך שאלה? פשוט השיבי למייל הזה ואני אעזור לך." },
  en: { button: "Complete my order", cart: "Your cart", total: "Total", coupon: "Coupon code", unsubscribe: "Stop receiving cart reminders", order: "Your order", contact: "Contact us", unsubscribeOrder: "Stop receiving order updates", reply: "Any question? Just reply to this email and I will help you." },
  fr: { button: "Finaliser ma commande", cart: "Votre panier", total: "Total", coupon: "Code promo", unsubscribe: "Ne plus recevoir de rappels de panier", order: "Votre commande", contact: "Nous contacter", unsubscribeOrder: "Ne plus recevoir de nouvelles de ma commande", reply: "Une question ? Répondez simplement à cet e-mail et je vous aide." },
  bg: { button: "Завърши поръчката", cart: "Твоята количка", total: "Общо", coupon: "Промо код", unsubscribe: "Спри напомнянията за количката", order: "Твоята поръчка", contact: "Свържи се с нас", unsubscribeOrder: "Спри новините за поръчката", reply: "Имаш въпрос? Просто отговори на този имейл и ще ти помогна." },
  hu: { button: "Rendelés befejezése", cart: "A kosarad", total: "Összesen", coupon: "Kuponkód", unsubscribe: "Nem kérek több kosár-emlékeztetőt", order: "A rendelésed", contact: "Írj nekünk", unsubscribeOrder: "Nem kérek több értesítést a rendelésről", reply: "Kérdésed van? Csak válaszolj erre az e-mailre, és segítek." },
  ro: { button: "Finalizează comanda", cart: "Coșul tău", total: "Total", coupon: "Cod de reducere", unsubscribe: "Nu mai vreau memento-uri despre coș", order: "Comanda ta", contact: "Contactează-ne", unsubscribeOrder: "Nu mai vreau noutăți despre comandă", reply: "Ai o întrebare? Răspunde la acest e-mail și te ajut." },
  tr: { button: "Siparişi tamamla", cart: "Sepetiniz", total: "Toplam", coupon: "İndirim kodu", unsubscribe: "Sepet hatırlatmalarını durdur", order: "Siparişiniz", contact: "Bize ulaşın", unsubscribeOrder: "Sipariş güncellemelerini durdur", reply: "Sorunuz mu var? Bu e-postayı yanıtlamanız yeterli, yardımcı olurum." },
  pl: { button: "Dokończ zamówienie", cart: "Twój koszyk", total: "Razem", coupon: "Kod rabatowy", unsubscribe: "Nie chcę więcej przypomnień o koszyku", order: "Twoje zamówienie", contact: "Napisz do nas", unsubscribeOrder: "Nie chcę więcej wiadomości o zamówieniu", reply: "Masz pytanie? Po prostu odpisz na tego maila, a pomogę." },
  sv: { button: "Slutför min beställning", cart: "Din varukorg", total: "Totalt", coupon: "Rabattkod", unsubscribe: "Sluta skicka påminnelser om varukorgen", order: "Din beställning", contact: "Kontakta oss", unsubscribeOrder: "Sluta skicka uppdateringar om beställningen", reply: "Har du en fråga? Svara bara på det här mejlet så hjälper jag dig." },
  de: { button: "Bestellung abschließen", cart: "Ihr Warenkorb", total: "Gesamt", coupon: "Gutscheincode", unsubscribe: "Keine Warenkorb-Erinnerungen mehr", order: "Ihre Bestellung", contact: "Kontakt aufnehmen", unsubscribeOrder: "Keine Updates zur Bestellung mehr", reply: "Eine Frage? Antworten Sie einfach auf diese E-Mail, ich helfe Ihnen gern." },
  es: { button: "Finalizar mi pedido", cart: "Tu carrito", total: "Total", coupon: "Código de descuento", unsubscribe: "No recibir más recordatorios del carrito", order: "Tu pedido", contact: "Contáctanos", unsubscribeOrder: "No recibir más novedades del pedido", reply: "¿Alguna pregunta? Responde a este correo y te ayudo." },
  it: { button: "Completa l'ordine", cart: "Il tuo carrello", total: "Totale", coupon: "Codice sconto", unsubscribe: "Non ricevere più promemoria del carrello", order: "Il tuo ordine", contact: "Contattaci", unsubscribeOrder: "Non ricevere più aggiornamenti sull'ordine", reply: "Hai una domanda? Rispondi a questa email e ti aiuto." },
  nl: { button: "Bestelling afronden", cart: "Je winkelwagen", total: "Totaal", coupon: "Kortingscode", unsubscribe: "Geen winkelwagen-herinneringen meer", order: "Je bestelling", contact: "Neem contact op", unsubscribeOrder: "Geen updates over de bestelling meer", reply: "Een vraag? Beantwoord gewoon deze e-mail en ik help je." },
  pt: { button: "Finalizar meu pedido", cart: "Seu carrinho", total: "Total", coupon: "Cupom", unsubscribe: "Não quero mais receber lembretes do carrinho", order: "Seu pedido", contact: "Fale conosco", unsubscribeOrder: "Não quero mais receber novidades do pedido", reply: "Alguma dúvida? É só responder este e-mail que eu te ajudo." },
};
export const emailLabels = (language: string | null | undefined): EmailLabels => EMAIL_LABELS[(language ?? "").toLowerCase().slice(0, 2)] ?? EMAIL_LABELS.en;

const RTL = new Set(["he", "ar"]);
export const isRtl = (language: string | null | undefined) => RTL.has((language ?? "").toLowerCase().slice(0, 2));

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// Texto simples → parágrafos HTML. Linha que é SÓ o link do botão some (o
// botão já leva o link); outras URLs viram link clicável.
function textToParagraphs(text: string, link: string, pStyle: string, accent: string): string {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l !== link && l !== `${link}.`);
    if (lines.length === 0) continue;
    const html = lines
      .map((line) => esc(line).replace(URL_RE, (u) => `<a href="${u}" style="color:${accent};text-decoration:underline;word-break:break-all;">${u}</a>`))
      .join("<br>");
    out.push(`<p style="${pStyle}">${html}</p>`);
  }
  return out.join("\n");
}

export interface RecoveryEmailInput {
  brand: string;
  language: string | null | undefined;
  bodyHtmlOrText: string; // já com as variáveis substituídas
  items: RecoveryItem[];
  total: number | string | null | undefined;
  currency: string | null | undefined;
  link: string; // vazio = sem botão (pós-compra sem "fale conosco")
  buttonLabel?: string | null;
  unsubscribeUrl: string;
  subject?: string | null;
  discountCode?: string | null;
  discountPercent?: number | null;
  // prévia (preheader): texto escondido no topo, que o Gmail/Apple Mail
  // mostram ao lado do assunto na caixa de entrada
  preheader?: string | null;
  // cabeçalho da lista de itens ("Seu pedido #1234" no pós-compra; sem isso, "Seu carrinho")
  itemsLabel?: string | null;
  // rótulo do link de descadastro (pós-compra: "parar as atualizações do pedido")
  unsubscribeLabel?: string | null;
  // linha "responde aqui que eu te ajudo" (padrão: ligada). Resposta é o
  // sinal mais forte de e-mail desejado para Gmail/Outlook.
  replyHint?: boolean;
  // Lista de itens com preço e quadro do cupom: DESLIGADOS por padrão (Ian,
  // 09/10: "tem que ser igual ao Klaviyo", só texto e botão; o cupom vai no
  // link do botão e, na maioria dos passos, no próprio texto).
  showItems?: boolean;
  showCouponBox?: boolean;
}

// Preheader: texto invisível no topo do corpo (cor do fundo, 1px, sem
// quebra) seguido de espaços não visíveis pra "empurrar" o resto do HTML
// pra fora da prévia da caixa de entrada.
function preheaderBlock(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const pad = "&#847;&zwnj;&nbsp;".repeat(40);
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f5f8;opacity:0;">${esc(t)}${pad}</div>`;
}

// HTML do e-mail de recuperação. Se o corpo já é um HTML completo (<html),
// vai como está (as variáveis já foram injetadas pelo renderTemplate).
export function buildRecoveryEmailHtml(input: RecoveryEmailInput): string {
  if (/<html[\s>]/i.test(input.bodyHtmlOrText)) return input.bodyHtmlOrText;
  const lang = (input.language ?? "en").toLowerCase().slice(0, 2);
  const t = emailLabels(lang);
  const rtl = isRtl(lang);
  const look = brandLook(input.brand);
  const side = rtl ? "right" : "left";
  const other = rtl ? "left" : "right";
  const serif = "font-family:Georgia,'Times New Roman',serif;";
  const sans = "font-family:Arial,Helvetica,sans-serif;";
  const pStyle = `margin:0 0 16px;font-size:15px;line-height:1.65;color:#15181f;text-align:${side};`;
  const money = (v: number | string | null | undefined) => (v != null && v !== "" && input.currency && Number.isFinite(Number(v)) ? formatMoney(Number(v), input.currency, lang) : "");
  const amount = (v: string) => `<span dir="ltr" style="unicode-bidi:isolate;white-space:nowrap;">${esc(v)}</span>`;

  const logoBlock = look.logo
    ? `<img src="${look.logo}" width="${look.logoWidth}" alt="${esc(input.brand)}" style="display:block;width:${look.logoWidth}px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto;">`
    : `<div style="${serif}font-size:26px;letter-spacing:3px;text-transform:uppercase;color:${look.accent};">${esc(input.brand)}</div>`;

  const itemRows = (input.items ?? [])
    .map((li) => {
      const title = cleanItemTitle(li.title ?? "");
      const qty = Number(li.quantity) || 1;
      const label = qty === 1 && /^\s*(\d+\s*[×x]|\+)/i.test(title) ? title.replace(/^\s*\+\s*/, "") : `${qty} × ${title}`;
      const price = money(li.lineTotal ?? (li.unitPrice != null ? Number(li.unitPrice) * qty : null));
      const img = li.imageUrl ? `<img src="${esc(li.imageUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:8px;border:0;">` : `<div style="width:56px;height:56px;border-radius:8px;background:${look.accentSoft};"></div>`;
      return `<tr>
<td width="64" style="padding:10px 0;border-bottom:1px solid #eceef2;vertical-align:middle;">${img}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eceef2;vertical-align:middle;text-align:${side};color:#2c3140;font-size:14px;line-height:1.4;">${esc(label)}</td>
<td style="padding:10px 0;border-bottom:1px solid #eceef2;vertical-align:middle;text-align:${other};white-space:nowrap;color:#15181f;font-size:14px;">${price ? amount(price) : ""}</td>
</tr>`;
    })
    .join("\n");
  const totalLabel = money(input.total);
  const totalRow = totalLabel ? `<tr><td colspan="2" style="padding:12px 8px 0 0;text-align:${side};font-weight:700;font-size:15px;color:#15181f;">${esc(t.total)}</td><td style="padding:12px 0 0;text-align:${other};font-weight:700;font-size:17px;color:#15181f;white-space:nowrap;">${amount(totalLabel)}</td></tr>` : "";
  const couponBlock = input.showCouponBox && input.discountCode
    ? `<tr><td style="padding:0 28px 6px;text-align:center;"><div style="display:inline-block;background:${look.accentSoft};border:1px dashed ${look.accent};border-radius:10px;padding:10px 18px;${sans}font-size:14px;color:#15181f;">${esc(t.coupon)}: <strong dir="ltr" style="unicode-bidi:isolate;letter-spacing:1px;">${esc(input.discountCode)}</strong>${input.discountPercent ? ` <span dir="ltr">(-${input.discountPercent}%)</span>` : ""}</div></td></tr>`
    : "";
  const button = input.buttonLabel || t.button;
  const title = input.subject || t.cart;
  const link = (input.link ?? "").trim();
  const buttonRow = link
    ? `<tr><td align="center" style="padding:26px 28px 10px;"><a href="${esc(link)}" style="display:inline-block;background:${look.accent};color:#ffffff;font-weight:700;font-size:16px;letter-spacing:.3px;text-decoration:none;padding:15px 34px;border-radius:12px;${sans}">${esc(button)}</a></td></tr>`
    : "";
  const itemsLabel = input.itemsLabel || t.cart;
  const unsubscribeLabel = input.unsubscribeLabel || t.unsubscribe;
  const replyRow = input.replyHint !== false && t.reply ? `<tr><td style="padding:14px 28px 0;text-align:center;font-size:14px;line-height:1.5;color:#4b5263;">${esc(t.reply)}</td></tr>` : "";

  return `<!DOCTYPE html><html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="x-apple-disable-message-reformatting"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8;">
${preheaderBlock(input.preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? "rtl" : "ltr"}" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;${sans}color:#2c3140;font-size:15px;line-height:1.6;text-align:${side};border-top:5px solid ${look.accent};">
<tr><td align="center" style="padding:34px 28px 18px;">${logoBlock}</td></tr>
<tr><td style="padding:6px 28px 0;">
${textToParagraphs(input.bodyHtmlOrText, link, pStyle, look.accent)}
</td></tr>
${input.showItems && itemRows ? `<tr><td style="padding:8px 28px 0;">
  <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;margin-bottom:4px;text-align:${side};">${esc(itemsLabel)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${itemRows}
${totalRow}
  </table>
</td></tr>` : ""}
${buttonRow}
${couponBlock}
${replyRow}
<tr><td style="padding:12px 28px 30px;"></td></tr>
</table>
<!--rc-unsub--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;"><tr><td style="padding:16px 24px 0;text-align:center;${sans}font-size:12px;line-height:1.5;color:#8a91a0;"><a href="${esc(input.unsubscribeUrl)}" style="color:#8a91a0;text-decoration:underline;">${esc(unsubscribeLabel)}</a></td></tr></table><!--/rc-unsub-->
</td></tr></table></body></html>`;
}

// Versão texto do e-mail (clientes sem HTML e pré-visualização do painel).
// `link` vazio = sem botão (não acrescenta linha nenhuma).
export function buildRecoveryEmailText(input: { bodyText: string; link: string; unsubscribeUrl: string; language: string | null | undefined; discountCode?: string | null; buttonLabel?: string | null; unsubscribeLabel?: string | null; replyHint?: boolean }): string {
  const t = emailLabels(input.language);
  const body = /<html[\s>]/i.test(input.bodyText) ? htmlToText(input.bodyText) : input.bodyText.trim();
  const parts = [body];
  const link = (input.link ?? "").trim();
  if (link && !body.includes(link)) parts.push("", input.buttonLabel ? `${input.buttonLabel}: ${link}` : link);
  if (input.discountCode && !body.includes(input.discountCode)) parts.push("", `${t.coupon}: ${input.discountCode}`);
  if (input.replyHint !== false && t.reply) parts.push("", t.reply);
  parts.push("", `${input.unsubscribeLabel || t.unsubscribe}: ${input.unsubscribeUrl}`);
  return parts.join("\n");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
