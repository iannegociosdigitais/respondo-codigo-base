import { withPixel } from "@/lib/email/log";
import { hasHebrew, isIsraeliEmail } from "@/lib/ai/lang";
import { sendReply } from "@/lib/email/send-reply";
import { brandLook } from "@/lib/receipts/build";
import { routeProduct, type Products } from "@/lib/agent/products";

// Detecção RÁPIDA e sem IA (roda no momento da importação, antes de
// qualquer análise) — não tenta ser perfeita, só decidir entre os idiomas
// mais comuns da base de clientes. Se não achar pista nenhuma, cai no
// idioma padrão da loja (definido em "Minhas lojas") ou inglês.
// Detector SEM IA (o aviso sai antes da análise). Conta palavras comuns de
// cada idioma e só decide quando há um vencedor claro; senão usa o idioma
// padrão da loja. Auditoria de 01/10: a versão antiga marcava como turco
// qualquer texto com "ü" (alemão "für", húngaro) e não conhecia húngaro,
// dinamarquês, italiano, espanhol nem holandês.
const LANG_WORDS: Record<string, RegExp> = {
  tr: /\b(merhaba|teşekkür|sipariş|siparişim|kargo|ürün|için|değil|lütfen|bir|ve|ne zaman|iade)\b|[şığ]/g,
  de: /\b(guten tag|hallo|sehr geehrte|bestellung|danke|bitte|ich|nicht|und|habe|meine|wann|für)\b|ß/g,
  fr: /\b(bonjour|bonsoir|merci|commande|cordialement|je|vous|pas|mon|ma|est|pour|avec|remboursement|colis)\b/g,
  pt: /\b(olá|obrigad[oa]|pedido|encomenda|você|não|meu|minha|quando|reembolso)\b/g,
  es: /\b(hola|gracias|pedido|usted|cuando|cuándo|envío|reembolso|buenos días|quiero|mi)\b|[ñ¿¡]/g,
  it: /\b(buongiorno|salve|grazie|ordine|quando|vorrei|rimborso|spedizione|non|sono|il mio)\b/g,
  hu: /\b(köszönöm|rendelés|rendelésem|kérem|hogy|nem|és|mikor|tisztelt|üdvözlöm)\b|[őű]/g,
  da: /\b(hej|tak|ordre|bestilling|jeg|ikke|og|hvornår|venlig hilsen|min)\b|[æø]/g,
  nl: /\b(hallo|bedankt|bestelling|ik|niet|een|het|wanneer|mijn|graag)\b/g,
  en: /\b(hello|hi|thanks|thank you|order|please|the|my|when|refund|have|would)\b/g,
};
export function quickDetectLanguage(text: string, email: string, storeDefault: string | null): string {
  if (hasHebrew(text)) return "he";
  const t = text.toLowerCase();
  const scores = Object.entries(LANG_WORDS).map(([lang, re]) => [lang, (t.match(re) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] >= 2 && best[1] > second[1]) return best[0];
  // texto curto/ambíguo: e-mail israelense vale mais que o padrão da loja
  if (isIsraeliEmail(email)) return "he";
  if (best[1] >= 1 && second[1] === 0) return best[0];
  return storeDefault ?? "en";
}


// MARCA do aviso. Bug visto ao vivo (01/10, 1º dia ligado): usava o NOME DA
// LOJA como marca — cliente da Olavita recebeu aviso assinado "DermaMagazin",
// e uma pergunta sem produto que chegou no help@skininsiderdaily.com saiu
// com a logo da OsteoPure. Loja não é marca. Regra do Ian: nunca misturar
// logos; se não der pra saber a marca, manda SEM logo.
// Ordem: produto citado no texto (inclui o e-mail nosso que o cliente citou
// embaixo, ex.: "יעל מ-Olavita") → idioma da marca (hebraico = Olavita) →
// caixa exclusiva de uma marca (osteopure.fr) → desconhecida (null).
const MAILBOX_BRAND: Array<[RegExp, string]> = [[/@osteopure\.fr$/i, "OsteoPure"]];
export function resolveAckBrand(products: Products, input: { storeId: string; mailbox: string; subject: string | null; text: string | null; textFull: string | null; language: string }): string | null {
  const product = routeProduct(products, { storeId: input.storeId, recipients: [input.mailbox], texts: [input.subject, input.textFull ?? input.text], language: input.language });
  const fromProduct = product?.name?.split(/\s+/)[0] ?? null;
  if (fromProduct) return fromProduct;
  return MAILBOX_BRAND.find(([re]) => re.test(input.mailbox))?.[1] ?? null;
}

const RTL_LANGS = new Set(["he", "ar"]);

interface AckStrings {
  subjectPrefix: string;
  greeting: (name: string | null) => string;
  lead: string;
  eta: string;
  reply: string;
  human: string;
  signoff: string;
  team: string;
  cta: string;
  questionBold: string;
  questionRest: string;
}

const ACK: Record<string, AckStrings> = {
  he: {
    subjectPrefix: "קיבלנו את ההודעה שלך",
    greeting: (name) => (name ? `היי ${name}!` : "היי!"),
    lead: "ההודעה שלך התקבלה אצלנו ונמצאת עכשיו עם הצוות שלנו, תודה שכתבת לנו.",
    eta: "זמן המענה הממוצע שלנו הוא בין 12 ל-24 שעות, ובסופי שבוע הוא עשוי להתארך מעט. אנחנו כבר מטפלים בפנייה שלך, ותשובה מלאה תישלח אליך בקרוב.",
    reply: "אם תרצה/י להוסיף פרט נוסף בינתיים, אפשר פשוט להשיב למייל הזה, זה מגיע ישירות לצוות שלנו.",
    human: "אנחנו צוות אנושי אמיתי, וכבר מטפלים בעניין שלך בכל הרצינות.",
    signoff: "באהבה,",
    team: "צוות התמיכה",
    cta: "לחצו כאן כדי לדבר איתנו",
    questionBold: "יש לך שאלה?",
    questionRest: " כבר קיבלנו את ההודעה שלך, ונענה בהקדם האפשרי.",
  },
  fr: {
    subjectPrefix: "Nous avons bien reçu votre message",
    greeting: (name) => (name ? `Bonjour ${name} !` : "Bonjour !"),
    lead: "Votre message nous est bien parvenu et est déjà entre les mains de notre équipe, merci de nous avoir écrit.",
    eta: "Notre délai de réponse moyen est de 12 à 24 heures, et il peut être un peu plus long le week-end. Nous nous occupons déjà de votre demande et vous recevrez une réponse complète très prochainement.",
    reply: "Si vous souhaitez ajouter une information en attendant, il vous suffit de répondre directement à cet e-mail, il arrive directement à notre équipe.",
    human: "Nous sommes une équipe humaine, bien réelle, et nous nous occupons déjà de votre cas avec tout le sérieux nécessaire.",
    signoff: "Chaleureusement,",
    team: "L'équipe support",
    cta: "Cliquez ici pour nous répondre",
    questionBold: "Une question ?",
    questionRest: " Nous avons déjà reçu votre message et nous vous répondrons au plus vite.",
  },
  de: {
    subjectPrefix: "Wir haben Ihre Nachricht erhalten",
    greeting: (name) => (name ? `Hallo ${name}!` : "Hallo!"),
    lead: "Ihre Nachricht ist bei uns angekommen und liegt bereits bei unserem Team, danke, dass Sie uns geschrieben haben.",
    eta: "Unsere durchschnittliche Antwortzeit beträgt 12 bis 24 Stunden, am Wochenende kann es etwas länger dauern. Wir kümmern uns bereits um Ihr Anliegen und Sie erhalten in Kürze eine vollständige Antwort.",
    reply: "Wenn Sie in der Zwischenzeit noch etwas ergänzen möchten, antworten Sie einfach direkt auf diese E-Mail, sie geht direkt an unser Team.",
    human: "Wir sind ein echtes, menschliches Team und kümmern uns bereits mit vollem Ernst um Ihren Fall.",
    signoff: "Herzliche Grüße,",
    team: "Ihr Support-Team",
    cta: "Hier klicken, um uns zu antworten",
    questionBold: "Haben Sie eine Frage?",
    questionRest: " Wir haben Ihre Nachricht bereits erhalten und antworten so schnell wie möglich.",
  },
  tr: {
    subjectPrefix: "Mesajınızı aldık",
    greeting: (name) => (name ? `Merhaba ${name}!` : "Merhaba!"),
    lead: "Mesajınız bize ulaştı ve şu anda ekibimizde. Bize yazdığınız için teşekkür ederiz.",
    eta: "Ortalama yanıt süremiz 12 ila 24 saattir, hafta sonlarında biraz uzayabilir. Talebinizle şimdiden ilgileniyoruz ve kısa süre içinde ayrıntılı bir yanıt alacaksınız.",
    reply: "Bu arada eklemek istediğiniz bir bilgi olursa bu e-postayı doğrudan yanıtlamanız yeterli. Yanıtınız doğrudan ekibimize ulaşır.",
    human: "Biz gerçek insanlardan oluşan bir ekibiz ve talebinizle tüm ciddiyetimizle ilgileniyoruz.",
    signoff: "Sevgilerle,",
    team: "Destek Ekibi",
    cta: "Bize yanıt vermek için tıklayın",
    questionBold: "Bir sorunuz mu var?",
    questionRest: " Mesajınızı aldık ve en kısa sürede size dönüş yapacağız.",
  },
  hu: {
    subjectPrefix: "Megkaptuk az üzenetét",
    greeting: (name) => (name ? `Kedves ${name}!` : "Üdvözöljük!"),
    lead: "Üzenete megérkezett hozzánk, és már a csapatunknál van. Köszönjük, hogy írt nekünk.",
    eta: "Átlagos válaszidőnk 12-24 óra, hétvégén ez valamivel hosszabb lehet. Már foglalkozunk a kérésével, és hamarosan részletes választ küldünk.",
    reply: "Ha addig is szeretne még valamit hozzátenni, egyszerűen válaszoljon erre az e-mailre. A válasza közvetlenül a csapatunkhoz érkezik.",
    human: "Valódi emberekből álló csapat vagyunk, és teljes odafigyeléssel foglalkozunk az ügyével.",
    signoff: "Üdvözlettel,",
    team: "Ügyfélszolgálati csapat",
    cta: "Kattintson ide a válaszhoz",
    questionBold: "Kérdése van?",
    questionRest: " Üzenetét megkaptuk, és a lehető leghamarabb válaszolunk.",
  },
  it: {
    subjectPrefix: "Abbiamo ricevuto il suo messaggio",
    greeting: (name) => (name ? `Buongiorno ${name}!` : "Buongiorno!"),
    lead: "Il suo messaggio ci è arrivato ed è già nelle mani del nostro team. Grazie per averci scritto.",
    eta: "Il nostro tempo medio di risposta è di 12-24 ore e può allungarsi un po' nel fine settimana. Ci stiamo già occupando della sua richiesta e riceverà presto una risposta completa.",
    reply: "Se nel frattempo desidera aggiungere altre informazioni, le basta rispondere direttamente a questa e-mail. Arriva direttamente al nostro team.",
    human: "Siamo un team di persone reali e ci stiamo già occupando del suo caso con la massima serietà.",
    signoff: "Cordiali saluti,",
    team: "Il team di assistenza",
    cta: "Clicchi qui per risponderci",
    questionBold: "Ha una domanda?",
    questionRest: " Abbiamo già ricevuto il suo messaggio e le risponderemo al più presto.",
  },
  da: {
    subjectPrefix: "Vi har modtaget din besked",
    greeting: (name) => (name ? `Hej ${name}!` : "Hej!"),
    lead: "Din besked er nået frem til os og ligger allerede hos vores team. Tak fordi du skrev til os.",
    eta: "Vores gennemsnitlige svartid er 12 til 24 timer, og i weekenden kan det tage lidt længere. Vi er allerede i gang med din henvendelse, og du får snart et fyldestgørende svar.",
    reply: "Hvis du vil tilføje noget i mellemtiden, skal du blot svare direkte på denne e-mail. Den går direkte til vores team.",
    human: "Vi er et team af rigtige mennesker, og vi tager os allerede af din sag med fuld opmærksomhed.",
    signoff: "Venlig hilsen,",
    team: "Supportteamet",
    cta: "Klik her for at svare os",
    questionBold: "Har du et spørgsmål?",
    questionRest: " Vi har allerede modtaget din besked og vender tilbage hurtigst muligt.",
  },
  pt: {
    subjectPrefix: "Recebemos sua mensagem",
    greeting: (name) => (name ? `Oi, ${name}!` : "Oi!"),
    lead: "Sua mensagem chegou até nós e já está com a nossa equipe, obrigado por escrever pra gente.",
    eta: "Nosso tempo médio de resposta costuma ser de 12 a 24 horas, podendo se estender um pouco nos finais de semana. Já estamos cuidando do seu caso e você vai receber uma resposta completa em breve.",
    reply: "Se quiser adicionar mais alguma informação enquanto isso, é só responder direto a este e-mail, ele chega direto pra nossa equipe.",
    human: "Somos uma equipe humana de verdade, e já estamos cuidando do seu caso com toda a seriedade.",
    signoff: "Com carinho,",
    team: "Equipe de Suporte",
    cta: "Clique aqui para falar com a gente",
    questionBold: "Tem alguma dúvida?",
    questionRest: " Já recebemos sua mensagem, e vamos te responder o quanto antes.",
  },
  en: {
    subjectPrefix: "We've received your message",
    greeting: (name) => (name ? `Hi ${name}!` : "Hi!"),
    lead: "Your message has reached us and is already with our team, thanks for writing to us.",
    eta: "Our average response time is 12 to 24 hours, and it may take a little longer on weekends. We're already looking into your request and you'll receive a full reply soon.",
    reply: "If you'd like to add any information in the meantime, just reply directly to this email, it goes straight to our team.",
    human: "We're a real human team, and we're already taking care of your case with full attention.",
    signoff: "Warmly,",
    team: "Support Team",
    cta: "Click here to reply to us",
    questionBold: "Have a question?",
    questionRest: " We've already received your message, and we'll get back to you as soon as possible.",
  },
};

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Visual pedido pelo Ian, 29/09/2026: igual ao layout já usado nos e-mails
// de marketing da marca (Klaviyo) — sem cartão/borda, logo centralizada,
// texto corrido, um destaque em negrito, botão colorido de CTA e rodapé
// fino com o nome da marca.
function buildAckHtml(t: AckStrings, name: string | null, brand: string | null, lang: string, replyTo: string, logoCid: string | null): string {
  const rtl = RTL_LANGS.has(lang);
  const side = rtl ? "right" : "left";
  const look = brandLook(brand ?? "");
  const sans = "font-family:Arial,Helvetica,sans-serif;";
  const font = "font-family:Georgia,'Times New Roman',serif;";
  // Logo embutida no e-mail (cid:) em vez de link remoto — o cliente de
  // e-mail não depende de buscar nada de fora pra exibir (visto ao vivo,
  // 29/09: logo aparecia quebrada mesmo com o arquivo 100% acessível —
  // provavelmente cache do proxy de imagem do Gmail numa tentativa
  // anterior). Sem cid disponível, cai pro nome da marca em texto.
  const logoBlock = logoCid
    ? `<img src="cid:${logoCid}" width="${look.logoWidth}" alt="${esc(brand ?? "")}" style="display:block;width:${look.logoWidth}px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto;">`
    : brand
      ? `<div style="${font}font-size:26px;letter-spacing:4px;text-transform:uppercase;color:#15181f;">${esc(brand)}</div>`
      : "";
  const p = (text: string, strong = false) => `<p style="margin:0 0 16px;font-size:13px;line-height:1.65;color:#15181f;${strong ? "font-weight:700;" : ""}">${esc(text)}</p>`;

  return `<!DOCTYPE html><html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:36px 20px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? "rtl" : "ltr"}" style="max-width:480px;background:#ffffff;${sans}color:#15181f;text-align:${side};">
${logoBlock ? `<tr><td align="center" style="padding:0 0 30px;">${logoBlock}</td></tr>` : ""}
<tr><td>
  <p style="margin:0 0 16px;font-size:13px;line-height:1.65;color:#15181f;">${esc(t.greeting(name))}</p>
  ${p(t.lead)}
  ${p(t.eta, true)}
  ${p(t.reply)}
  ${p(t.human)}
  <p style="margin:0 0 4px;font-size:13px;line-height:1.65;color:#15181f;">${esc(t.signoff)}</p>
  <p style="margin:0 0 28px;font-size:13px;line-height:1.65;color:#15181f;">${esc(t.team)}</p>
</td></tr>
<tr><td style="padding:0 0 30px;">
  <a href="mailto:${esc(replyTo)}" style="display:inline-block;background:#e3fbf5;color:#1f6f63;font-weight:700;font-size:12px;letter-spacing:.3px;text-decoration:none;padding:12px 30px;border-radius:10px;">${esc(t.cta)}</a>
</td></tr>
<tr><td style="border-top:2px solid #15181f;padding:18px 0 0;">
  <p style="margin:0;font-size:12px;line-height:1.6;color:#15181f;"><strong>${esc(t.questionBold)}</strong>${esc(t.questionRest)}</p>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

export interface AutoAckAccount {
  smtpHost: string;
  smtpPort: number;
  emailAddress: string;
  credentialEncrypted: string;
}

// Aviso genérico e "meio robótico" de propósito (pedido do Ian, 28/09/2026):
// não é um rascunho personalizado, é só pra o cliente saber na hora que a
// mensagem chegou e que uma pessoa vai responder — evita a sensação de
// "mandei e não aconteceu nada". Só dispara na 1ª mensagem de uma conversa
// nova de cliente real (nunca em conversa já existente, nunca em spam) e só
// quando a loja tiver isso ligado (stores.auto_ack).
// Busca os bytes da logo do próprio servidor (Vercel), não do lado do
// cliente de e-mail — evita qualquer cache/bloqueio de proxy de imagem de
// quem recebe. Falha silenciosa: sem logo, cai pro nome da marca em texto.
export async function fetchLogoBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function sendAutoAck(
  account: AutoAckAccount,
  params: { to: string; customerName: string | null; subject: string; text: string; storeDefaultLanguage: string | null; brand: string | null; logId?: string | null; forceLanguage?: string | null; subjectPrefix?: string; inReplyTo?: string | null; references?: string[] }
): Promise<{ language: string; messageId: string | null; subject: string }> {
  const lang = params.forceLanguage || quickDetectLanguage(params.text, params.to, params.storeDefaultLanguage);
  const t = ACK[lang] ?? ACK.en;
  const name = (params.customerName ?? "").trim() || null;
  const plainText = [t.greeting(name), "", t.lead, "", t.eta, "", t.reply, "", t.human, "", t.signoff, t.team].join("\n");

  const look = brandLook(params.brand ?? "");
  const logoBuffer = look.logo ? await fetchLogoBuffer(look.logo) : null;
  const logoCid = logoBuffer ? "brand-logo" : null;

  const baseSubject = /^re\s*:/i.test(params.subject) ? params.subject : `Re: ${params.subject || t.subjectPrefix}`;
  const subject = `${params.subjectPrefix ?? ""}${baseSubject}`;
  const html = buildAckHtml(t, name, params.brand, lang, account.emailAddress, logoCid);
  const { messageId } = await sendReply({
    emailAccount: account,
    to: params.to,
    subject,
    body: plainText,
    html: params.logId ? withPixel(html, params.logId) : html,
    // RESPOSTA dentro da conversa do cliente (mesma thread), nunca um e-mail
    // novo solto: In-Reply-To/References apontam pra mensagem que ele mandou.
    inReplyTo: params.inReplyTo ?? null,
    references: params.references,
    // marca desconhecida: remetente neutro ("Equipe de Suporte"), sem logo
    fromName: params.brand ?? t.team,
    attachments: logoBuffer && logoCid ? [{ filename: "logo.png", content: logoBuffer, cid: logoCid, contentType: "image/png" }] : undefined,
  });
  return { language: lang, messageId, subject };
}
