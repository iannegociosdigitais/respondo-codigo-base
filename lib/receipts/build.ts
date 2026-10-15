import type { ShopifyOrderSummary } from "@/lib/shopify/orders";
import { pickFormLang, RTL_LANGS } from "@/lib/forms/i18n";
import { formatDate, formatMoney, formLocale } from "@/lib/forms/format";
import { customerAmount } from "@/lib/forms/money";
import { APP_URL } from "@/lib/forms/token";
import { RECEIPT_STRINGS } from "@/lib/receipts/strings";
import { pickLetter } from "@/lib/receipts/letter";

// Recibo em HTML da COMPRA (sem IA, custo zero): marca certa pelo produto,
// idioma e moeda do cliente, com a logo da marca e sem nenhuma menção a
// assinatura. Refeito em 23/09/2026 a pedido do Ian: agradece a compra, tem
// a logo da loja e não pode parecer texto gerado.
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Logo e cor de cada marca. As imagens ficam em public/brand/ (servidas pelo
// próprio app na Vercel) — e-mail precisa de URL pública, não de arquivo.
// Endereço público das logos. NUNCA pode ser localhost: bug visto ao vivo
// (01/10) — todo teste disparado da máquina de desenvolvimento usava
// NEXT_PUBLIC_APP_URL=http://localhost:3000, então a logo não baixava pra
// embutir E o e-mail saía apontando pra localhost (ícone quebrado no Gmail).
const ASSET_URL = /localhost|127\.0\.0\.1|\[::1\]/.test(APP_URL) ? "https://SEU-APP" : APP_URL;

interface BrandLook { logo: string | null; logoWidth: number; accent: string; accentSoft: string }
const BRAND_LOOK: Record<string, BrandLook> = {
  olavita: { logo: `${ASSET_URL}/brand/olavita.png`, logoWidth: 150, accent: "#1c1c1e", accentSoft: "#f2f2f4" },
  osteopure: { logo: `${ASSET_URL}/brand/osteopure.png`, logoWidth: 190, accent: "#2f9e91", accentSoft: "#e6f4f2" },
};
const DEFAULT_LOOK: BrandLook = { logo: null, logoWidth: 0, accent: "#1f2a44", accentSoft: "#eef1f7" };
export function brandLook(brand: string): BrandLook {
  const key = brand.toLowerCase().replace(/[^a-z]/g, "");
  return Object.entries(BRAND_LOOK).find(([k]) => key.startsWith(k))?.[1] ?? DEFAULT_LOOK;
}

// Nome do plano que algumas lojas colam no título do item ("… — Cure Continue").
const PLAN_WORDS = /\s*[-–—|(·]?\s*\b(cure continue|traitement continu|abonnement|subscription|subscribe\s*&?\s*save|abo|abonnemang|abonnement mensuel|suscripci[oó]n|abbonamento|assinatura|מנוי)\b[^|]*$/i;
export const cleanItemTitle = (title: string) => title.replace(PLAN_WORDS, "").trim() || title;

function countryName(code: string | null, lang: string): string | null {
  try {
    return code ? new Intl.DisplayNames([formLocale(lang)], { type: "region" }).of(code) ?? null : null;
  } catch {
    return null;
  }
}

export interface BuiltReceipt { subject: string; html: string; text: string; language: string }

export function buildReceipt(params: { order: ShopifyOrderSummary; brand: string; language: string | null; customerName?: string | null; itemTitles?: Map<string, string>; replyTo?: string | null }): BuiltReceipt {
  const { order, brand } = params;
  const lang = pickFormLang(params.language);
  const t = RECEIPT_STRINGS[lang];
  const rtl = RTL_LANGS.includes(lang);
  const look = brandLook(brand);
  const shown = customerAmount({ total: order.totalPrice, currency: order.currency, presentmentTotal: order.presentmentTotal, presentmentCurrency: order.presentmentCurrency, country: order.countryCode });
  // pedido de Israel gravado em euro: tudo convertido pelo mesmo fator do total
  const factor = shown && Number(order.presentmentTotal ?? order.totalPrice) > 0 ? shown.amount / Number(order.presentmentTotal ?? order.totalPrice) : 1;
  const money = (raw: string | null | undefined) => (shown && raw != null && Number.isFinite(Number(raw)) ? formatMoney(Math.round(Number(raw) * factor * 100) / 100, shown.currency, lang) : "");

  const name = (params.customerName || order.customerFirstName || "").trim().split(/\s+/)[0] ?? "";
  const heading = name ? t.heading.replace("{name}", name) : t.headingNoName;
  const items = (order.lineItems ?? []).map((li) => {
    const title = cleanItemTitle(params.itemTitles?.get(li.title) ?? li.title);
    const price = li.lineTotal != null && Number(li.lineTotal) === 0 ? t.free : money(li.lineTotal);
    // "1 × 3 × Olavita…" fica estranho: quantidade 1 some quando o título já traz a sua
    const label = li.quantity === 1 && /^\s*(\d+\s*[×x]|\+)/i.test(title) ? title.replace(/^\s*\+\s*/, "") : `${li.quantity} × ${title}`;
    return { label, price };
  });
  const shippingLabel = order.shippingTotal == null ? "" : Number(order.shippingTotal) === 0 ? t.free : money(order.shippingTotal);
  const total = shown ? formatMoney(shown.amount, shown.currency, lang) : [order.currency, order.totalPrice].filter(Boolean).join(" ");
  const address = order.shipping ? [order.shipping.name, order.shipping.address1, order.shipping.address2, [order.shipping.zip, order.shipping.city].filter(Boolean).join(" "), order.shipping.province, countryName(order.countryCode, lang) ?? order.shipping.country].filter(Boolean) as string[] : [];
  const date = formatDate(order.createdAt, lang);
  const team = t.team.replace("{brand}", brand);
  const footer = t.footer.replace("{brand}", brand);
  const subject = t.subject.replace("{order}", order.name);

  const side = rtl ? "right" : "left";
  const other = rtl ? "left" : "right";
  const font = "font-family:Georgia,'Times New Roman',serif;";
  const sans = "font-family:Arial,Helvetica,sans-serif;";
  const row = (l: string, r: string, bold = false) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #eceef2;text-align:${side};color:${bold ? "#15181f" : "#2c3140"};${bold ? "font-weight:700;font-size:16px;" : ""}">${esc(l)}</td><td dir="ltr" style="padding:11px 0;border-bottom:1px solid #eceef2;text-align:${other};white-space:nowrap;color:#15181f;${bold ? "font-weight:700;font-size:18px;" : ""}">${esc(r)}</td></tr>`;

  const logoBlock = look.logo
    ? `<img src="${look.logo}" width="${look.logoWidth}" alt="${esc(brand)}" style="display:block;width:${look.logoWidth}px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto;">`
    : `<div style="${font}font-size:26px;letter-spacing:3px;text-transform:uppercase;color:${look.accent};">${esc(brand)}</div>`;

  // Formato carta (modelo aprovado em 01/10) quando existe texto pra essa
  // marca + idioma; senão segue o layout antigo logo abaixo.
  const L = pickLetter(brand, lang);
  if (L) {
    const lSubject = L.subject.replace("{order}", order.name);
    const greeting = name ? L.greeting.replace("{name}", name) : L.greetingNoName;
    const lItems = (order.lineItems ?? []).map((li) => {
      const title = cleanItemTitle(params.itemTitles?.get(li.title) ?? li.title);
      const price = li.lineTotal != null && Number(li.lineTotal) === 0 ? L.free : money(li.lineTotal);
      // "1 × 1 צנצנת … בחינם: חינם" (visto no teste de 01/10): quantidade 1 some
      // quando o título já começa com número, e o "Grátis" não repete quando o
      // título do brinde já diz que é grátis.
      const label = li.quantity === 1 && /^\s*(\d|\+)/.test(title) ? title.replace(/^\s*\+\s*/, "") : li.quantity === 1 && price === L.free ? title : `${li.quantity} × ${title}`;
      const saysFree = /חינם|gr[áa]tis|free|gratuit|offert|kostenlos|gratis/i.test(title);
      return { label, price: price === L.free && saysFree ? "" : price };
    });
    const lShipping = order.shippingTotal == null ? "" : Number(order.shippingTotal) === 0 ? L.free : money(order.shippingTotal);
    const orderLine = L.orderLine.replace("{order}", order.name).replace("{date}", date);
    const [orderHead, ...orderTail] = orderLine.split(",");
    const pStyle = "margin:0 0 16px;font-size:13px;line-height:1.65;color:#15181f;";
    const p = (inner: string) => `<p style="${pStyle}">${inner}</p>`;
    // valor sempre da esquerda pra direita (₪315), mesmo dentro de texto hebraico
    const amount = (v: string) => `<span dir="ltr" style="unicode-bidi:isolate;">${esc(v)}</span>`;
    const itemLines = lItems.map((i) => `${esc(i.label)}${i.price ? `: ${amount(i.price)}` : ""}`);
    const letterHtml = `<!DOCTYPE html><html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="x-apple-disable-message-reformatting"><title>${esc(lSubject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(orderLine)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:36px 20px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? "rtl" : "ltr"}" style="max-width:480px;background:#ffffff;${sans}color:#15181f;text-align:${side};">
<tr><td align="center" style="padding:0 0 30px;">${logoBlock}</td></tr>
<tr><td>
${p(esc(greeting))}
${p(esc(L.welcome))}
${p(esc(L.received))}
${p(`<strong>${esc(orderHead)}</strong>${orderTail.length ? esc("," + orderTail.join(",")) : ""}<br>${itemLines.join("<br>")}${lShipping ? `<br>${esc(L.shipping)}: ${amount(lShipping)}` : ""}<br><strong>${esc(L.totalPaid)}: ${amount(total)}</strong>`)}
${address.length ? p(`<strong>${esc(L.shipTo)}</strong><br>${address.map(esc).join("<br>")}`) : ""}
${p(esc(L.delivery))}
${p(`<strong>${esc(L.descriptorBold1)}</strong>${esc(L.descriptorMid)}<strong>${esc(L.descriptorBold2)}</strong>${esc(L.descriptorEnd)}`)}
${p(esc(L.help))}
<p style="margin:0 0 28px;font-size:13px;line-height:1.65;color:#15181f;">${esc(L.signoff)}<br>${esc(L.signer)}<br>${esc(L.team)}</p>
</td></tr>
${params.replyTo ? `<tr><td style="padding:0 0 30px;"><a href="mailto:${esc(params.replyTo)}" style="display:inline-block;background:#e3fbf5;color:#1f6f63;font-weight:700;font-size:12px;letter-spacing:.3px;text-decoration:none;padding:12px 30px;border-radius:10px;">${esc(L.cta)}</a></td></tr>` : ""}
<tr><td style="border-top:2px solid #15181f;padding:18px 0 0;"><p style="margin:0;font-size:12px;line-height:1.6;color:#15181f;"><strong>${esc(L.questionBold)}</strong>${esc(L.questionRest)}</p></td></tr>
</table>
</td></tr></table></body></html>`;
    const letterText = [greeting, "", L.welcome, "", L.received, "", orderLine, ...lItems.map((i) => `${i.label}${i.price ? `: ${i.price}` : ""}`), lShipping ? `${L.shipping}: ${lShipping}` : "", `${L.totalPaid}: ${total}`, "", ...(address.length ? [L.shipTo, ...address, ""] : []), L.delivery, "", `${L.descriptorBold1}${L.descriptorMid}${L.descriptorBold2}${L.descriptorEnd}`, "", L.help, "", L.signoff, L.signer, L.team, "", `${L.questionBold}${L.questionRest}`].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
    return { subject: lSubject, html: letterHtml, text: letterText, language: lang };
  }

  const html = `<!DOCTYPE html><html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(t.title)} · ${esc(order.name)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? "rtl" : "ltr"}" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;${sans}color:#2c3140;font-size:15px;line-height:1.6;text-align:${side};border-top:5px solid ${look.accent};">
<tr><td align="center" style="padding:34px 28px 10px;">${logoBlock}</td></tr>
<tr><td style="padding:14px 28px 0;">
  <h1 style="margin:0 0 12px;${font}font-weight:400;font-size:26px;line-height:1.25;color:#15181f;">${esc(heading)}</h1>
  <p style="margin:0;font-size:15.5px;color:#3a4050;">${esc(t.intro)}</p>
</td></tr>
<tr><td style="padding:24px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${look.accentSoft};border-radius:12px;"><tr>
    <td style="padding:14px 18px;text-align:${side};"><div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;">${esc(t.order)}</div><div dir="ltr" style="font-weight:700;font-size:16px;color:#15181f;text-align:${side};">${esc(order.name)}</div></td>
    <td style="padding:14px 18px;text-align:${side};"><div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;">${esc(t.date)}</div><div style="font-weight:700;color:#15181f;">${esc(date)}</div></td>
    <td style="padding:14px 18px;text-align:${other};vertical-align:middle;"><span style="display:inline-block;background:${look.accent};color:#ffffff;font-weight:700;font-size:12px;letter-spacing:.3px;padding:6px 13px;border-radius:999px;">✓ ${esc(t.paid)}</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:22px 28px 0;">
  <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;margin-bottom:2px;">${esc(t.summaryTitle)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${items.map((i) => row(i.label, i.price)).join("\n")}
${shippingLabel ? row(t.shipping, shippingLabel) : ""}
${row(t.total, total, true)}
  </table>
</td></tr>
${address.length ? `<tr><td style="padding:20px 28px 0;"><div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">${esc(t.shipTo)}</div><div style="color:#2c3140;">${address.map(esc).join("<br>")}</div></td></tr>` : ""}
<tr><td style="padding:26px 28px 30px;">
  <p style="margin:0 0 18px;color:#3a4050;">${esc(t.question)}</p>
  <p style="margin:0;color:#15181f;">${esc(t.closing)}<br><strong>${esc(team)}</strong></p>
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;"><tr><td style="padding:16px 24px 0;text-align:center;${sans}font-size:12px;line-height:1.5;color:#8a91a0;">${esc(footer)}</td></tr></table>
</td></tr></table></body></html>`;

  const text = [heading, "", t.intro, "", `${t.summaryTitle}`, `${t.order}: ${order.name}`, `${t.date}: ${date}`, ...items.map((i) => `${i.label}${i.price ? ` — ${i.price}` : ""}`), shippingLabel ? `${t.shipping}: ${shippingLabel}` : "", `${t.total}: ${total} (${t.paid})`, address.length ? `\n${t.shipTo}:\n${address.join("\n")}` : "", "", t.question, "", t.closing, team].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return { subject, html, text, language: lang };
}
