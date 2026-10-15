// Prompt e constantes do AGENTE VENDEDOR do WhatsApp (recuperação de carrinho).
// O agente conversa com quem respondeu à régua: tira dúvida, contorna objeção,
// manda o link do carrinho e, se o cliente travar no preço, oferece cupom
// (só os percentuais cadastrados, até o teto da loja). Assunto de suporte
// (pedido feito, rastreio, reembolso, troca, cobrança) vai pra humano.
//
// Tudo aqui é instrução em português; a resposta sai no idioma do cliente.
// NUNCA travessão em texto que vai pro cliente (regra do Ian): as frases
// fixas abaixo já respeitam isso e o agent.ts ainda passa stripDashes.
import { LANG_LABEL } from "@/lib/ai/lang";

export const MAX_REPLY_CHARS = 650;

// Idioma → nome em português, pra instrução ("responda em hebraico").
const EXTRA_LANG_LABEL: Record<string, string> = { bg: "búlgaro", ro: "romeno", sv: "sueco", cs: "tcheco", el: "grego", uk: "ucraniano", sk: "eslovaco", hr: "croata", fi: "finlandês", nb: "norueguês" };
export function languageName(code: string | null | undefined): string {
  const c = (code ?? "").toLowerCase().slice(0, 2);
  return LANG_LABEL[c] ?? EXTRA_LANG_LABEL[c] ?? (c ? `idioma "${c}"` : "o idioma do cliente");
}

// Frase de espera enviada no handoff quando o modelo não deixou resposta
// (ou quando a resposta dele foi descartada pelos guardrails). Constante por
// idioma: nunca passa pelo modelo, nunca vaza português. Em hebraico a
// vendedora fala no feminino de si mesma e não flexiona o cliente.
export const WAIT_PHRASES: Record<string, string> = {
  he: "שאלתי את הצוות ואני חוזרת עם תשובה עוד רגע, בסדר?",
  en: "I asked the team and I will confirm this for you shortly, ok?",
  fr: "Je vérifie avec l'équipe et je reviens vers vous ici même.",
  bg: "Ще проверя с екипа и ще ви отговоря тук.",
  hu: "Egyeztetek a csapattal, és itt válaszolok Önnek.",
  ro: "Verific cu echipa și revin aici cu un răspuns.",
  tr: "Ekiple kontrol edip buradan size dönüş yapacağım.",
  pl: "Sprawdzę to z zespołem i odpiszę tutaj.",
  sv: "Jag kollar med teamet och återkommer här.",
  de: "Ich kläre das mit dem Team und melde mich hier bei Ihnen.",
  es: "Lo consulto con el equipo y te respondo por aquí.",
  it: "Verifico con il team e ti rispondo qui.",
  nl: "Ik check het even met het team en kom hier bij je terug.",
  da: "Jeg tjekker med teamet og vender tilbage her.",
  ru: "Я уточню у команды и отвечу вам здесь.",
  pt: "Perguntei para a equipe e já te confirmo isso, ok?",
  ar: "سألت الفريق وسأعود إليكِ بالجواب قريبًا، تمام؟",
};
// Frase padrão do Ian (09/10) para o que o agente não sabe.
export const WAIT_PHRASE_PT = "Perguntei para a equipe e já te confirmo isso, ok?";
export const waitPhrase = (language: string | null | undefined): string | null => WAIT_PHRASES[(language ?? "").toLowerCase().slice(0, 2)] ?? null;

// Variações do "vou confirmar e já te aviso" (Ian, 10/10: "não pode ser sempre a
// mesma frase, tem que parecer uma pessoa real"). A vendedora fala de si no
// feminino; a cliente sem flexão de gênero. A mesma posição nas listas é a
// mesma ideia (o pt serve de tradução no painel).
export const WAIT_VARIANTS: Record<string, string[]> = {
  pt: [
    "Perguntei para a equipe e já te confirmo isso, ok?",
    "Não tenho certeza dessa informação, então vou confirmar com o meu supervisor e já te aviso por aqui.",
    "Boa pergunta! Deixa eu confirmar direitinho com a equipe e já te respondo.",
    "Prefiro não te falar nada sem ter certeza. Já perguntei para o meu supervisor e te aviso assim que ele me responder.",
    "Vou verificar isso agora e já volto com a resposta, tá bom?",
    "Não quero te passar nenhuma informação errada, então vou checar com a equipe e já te falo.",
  ],
  he: [
    "שאלתי את הצוות ואני חוזרת עם תשובה עוד רגע, בסדר?",
    "אני לא בטוחה במידע הזה, אז אני בודקת עם המנהל שלי ומעדכנת כאן.",
    "שאלה טובה! רק מוודאת את זה מול הצוות וכבר חוזרת עם תשובה.",
    "לא רוצה להגיד משהו לא מדויק, אז שאלתי את המנהל שלי ואעדכן ברגע שהוא יחזור אליי.",
    "אני בודקת את זה עכשיו ותכף מעדכנת, בסדר?",
    "רגע, אני מוודאת את זה עם הצוות וחוזרת עם תשובה כאן.",
  ],
  en: [
    "I asked the team and I will confirm this for you shortly, ok?",
    "I'm not sure about that, so I'm checking with my supervisor and will let you know here.",
    "Good question! Let me double check with the team and I'll get right back to you.",
    "I don't want to tell you anything wrong, so I asked my supervisor and I'll update you as soon as I hear back.",
    "Let me check that now and I'll come back with the answer, ok?",
  ],
  ru: [
    "Я уточню у команды и отвечу вам здесь.",
    "Я не уверена в этой информации, уточню у руководителя и сразу напишу.",
    "Хороший вопрос! Сейчас проверю с командой и вернусь с ответом.",
    "Не хочу сказать что-то неточно, поэтому спросила руководителя и напишу, как только он ответит.",
  ],
  ar: [
    "سألت الفريق وسأعود إليكِ بالجواب قريبًا، تمام؟",
    "لست متأكدة من هذه المعلومة، سأتحقق مع مديري وأخبرك هنا.",
    "سؤال جيد! سأتأكد مع الفريق وأعود بالجواب.",
    "لا أريد أن أقول شيئًا غير دقيق، لذلك سألت مديري وسأخبرك فور رده.",
  ],
};
const normWait = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
// Uma variação que AINDA NÃO saiu nesta conversa (sem repetir); acabou a lista,
// volta ao começo pela contagem. Idioma sem variações: a frase fixa antiga.
export function pickWaitPhrase(language: string | null | undefined, history: Array<{ author: string; body: string }>): { text: string; pt: string } | null {
  const lang = (language ?? "").toLowerCase().slice(0, 2);
  const list = WAIT_VARIANTS[lang];
  if (!list || list.length === 0) {
    const fixed = waitPhrase(lang);
    return fixed ? { text: fixed, pt: WAIT_PHRASE_PT } : null;
  }
  const used = new Set(history.filter((m) => m.author === "agente").map((m) => normWait(m.body)));
  let idx = list.findIndex((v) => !used.has(normWait(v)));
  if (idx < 0) idx = used.size % list.length;
  const pt = WAIT_VARIANTS.pt;
  return { text: list[idx], pt: pt[idx % pt.length] };
}

// A cliente diz, na mensagem, que JÁ pagou/comprou (palavras de pagamento no
// passado, nos idiomas das lojas). Fronteiras por letra Unicode (hebraico e
// cirílico não têm \\b). "Como é o pagamento?" ou "quero comprar" não casam.
export const PAID_CLAIM_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:" +
    [
      // pt / es
      "j[aá] (?:paguei|pagu[eé]|comprei|compr[eé]|finalizei|fechei)", "paguei", "pagu[eé] ", "comprei", "finalizei (?:a |o |meu |minha )?(?:compra|pedido|pagamento)", "fiz (?:o |a )?(?:pagamento|pedido|compra)", "pagamento (?:feito|conclu[ií]do|realizado|efetuado)", "j[aá] est[aá] pago",
      // he
      "שילמתי", "שילמנו", "שולם", "קניתי", "הזמנתי", "סיימתי (?:את )?(?:ההזמנה|הרכישה|התשלום)", "ביצעתי (?:את )?(?:התשלום|הזמנה|רכישה)", "עשיתי (?:את )?(?:ההזמנה|התשלום)",
      // en
      "(?:i )?(?:have |already |just )?paid", "(?:i )?(?:have |already |just )?(?:bought|purchased|ordered)", "payment (?:done|made|completed|sent)", "completed (?:the |my )?(?:order|payment|purchase)", "made (?:the |a )?payment",
      // ru / bg
      "оплатил[аи]?", "заплатил[аи]?", "купил[аи]?", "заказал[аи]?", "платих", "купих", "поръчах",
      // ar
      "دفعت", "اشتريت", "تم الدفع", "طلبت",
      // fr / de / others
      "j['’]ai (?:pay[eé]|achet[eé]|command[eé])", "paiement effectu[eé]", "ich habe (?:bezahlt|gekauft|bestellt)", "bezahlt", "ya pagu[eé]", "zap[lł]aci[lł][aeoy]?m?", "plătit", "fizettem", "ödedim", "πλήρωσα", "αγόρασα",
    ].join("|") +
    ")(?![\\p{L}\\p{N}])",
  "iu"
);

// Negação logo antes do verbo ("não paguei", "לא שילמתי", "didn't pay") não é
// dizer que pagou. Olha até ~3 palavras antes de cada ocorrência.
const NEGATION_BEFORE_RE = /(?<![\p{L}\p{N}])(?:n[aã]o|nunca|nem|ainda n[aã]o|לא|עוד לא|עדיין לא|didn'?t|did not|haven'?t|have not|hasn'?t|not|never|не|ещё не|еще не|لم|ما|pas|jamais|nicht|no)(?:\s+\p{L}+){0,2}\s*$/iu;
export function isPaidClaim(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const re = new RegExp(PAID_CLAIM_RE.source, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    if (!NEGATION_BEFORE_RE.test(before)) return true;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return false;
}

// Alguma ocorrência de `re` SEM negação logo antes ("não fui cobrada", "לא
// חויבתי" não é reclamação de cobrança).
export function testUnnegated(re: RegExp, text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(t))) {
    if (!NEGATION_BEFORE_RE.test(t.slice(Math.max(0, m.index - 30), m.index))) return true;
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return false;
}

// Pergunta sobre a GARANTIA antes de comprar ("e se eu não gostar, tem
// reembolso?"): é política (garantia de 90 dias, no CONHECIMENTO), não suporte.
export const GUARANTEE_RE = new RegExp("(?<![\\p{L}\\p{N}])(?:garantia|garantem|garante|satisfeita|satisfa[cç][aã]o|se n[aã]o (?:funcionar|gostar|der certo|ficar satisfeita)|אחריות|אם לא (?:יעבוד|אהבתי|אהיה מרוצה|מתאים)|לא מרוצה|guarantee|warranty|money back|if (?:it )?(?:doesn'?t|does not) work|if i don'?t like|гаранти\\p{L}*|если не понравится|ضمان|إذا لم)(?![\\p{L}\\p{N}])", "iu");

// Cliente diz que já pagou e a Shopify NÃO mostra pedido pago: texto fixo
// (o agente nunca confirma pagamento que a verificação não mostrou).
// Texto do Ian (10/10): confere, pergunta em que nome e e-mail e pede o
// comprovante. Se ela responder com nome, e-mail ou número do pedido, o
// sistema busca na Shopify (findPaidOrderByHint) antes da próxima resposta.
export const PAYMENT_NOT_FOUND: Record<string, string> = {
  pt: "Deixa eu conferir aqui... ainda não encontrei o seu pagamento no sistema, às vezes demora alguns minutinhos. Qual nome e e-mail você usou no pedido? Se tiver o comprovante, me manda que eu já libero o seu envio 😉",
  he: "רגע, אני בודקת... עדיין לא מצאתי את התשלום במערכת, לפעמים זה לוקח כמה דקות. באיזה שם ואימייל בוצעה ההזמנה? אם יש אישור תשלום, אפשר לשלוח לי כאן ואני כבר משחררת את המשלוח 😉",
  en: "Let me check... I still can't find your payment in our system, it sometimes takes a few minutes. Which name and email did you use for the order? If you have the receipt, send it to me and I will release your shipment right away 😉",
  ru: "Сейчас проверю... пока не вижу вашу оплату в системе, иногда это занимает несколько минут. На какое имя и email был оформлен заказ? Если есть подтверждение оплаты, пришлите мне, и я сразу передам заказ в отправку 😉",
  ar: "لحظة، أتحقق... لم أجد الدفع في النظام بعد، أحياناً يستغرق بضع دقائق. بأي اسم وبريد إلكتروني تم الطلب؟ إذا كان لديك إيصال الدفع، أرسليه لي وسأحرر الشحنة فوراً 😉",
};

// Ela já informou nome, e-mail ou número do pedido, o sistema procurou na
// Shopify e não achou: não pergunta de novo, pede o print do comprovante.
export const PAYMENT_NOT_FOUND_AFTER_HINT: Record<string, string> = {
  pt: "Procurei aqui pelos dados que você me passou e ainda não encontrei o pagamento, às vezes demora alguns minutinhos. Pode me mandar um print do comprovante para eu conferir? 😉",
  he: "בדקתי לפי הפרטים ששלחת ועדיין לא מצאתי את התשלום, לפעמים זה לוקח כמה דקות. אפשר לשלוח לי צילום מסך של אישור התשלום כדי שאבדוק? 😉",
  en: "I searched with the details you gave me and still can't find the payment, it sometimes takes a few minutes. Could you send me a screenshot of the receipt so I can check? 😉",
  ru: "Я поискала по вашим данным и пока не нашла оплату, иногда это занимает несколько минут. Пришлите, пожалуйста, скриншот подтверждения оплаты, я проверю 😉",
  ar: "بحثت بالتفاصيل التي أرسلتِها ولم أجد الدفع بعد، أحياناً يستغرق بضع دقائق. هل يمكنك إرسال صورة لإيصال الدفع لأتحقق؟ 😉",
};

// Classificação da mensagem da cliente para o ROTEIRO em código (a ordem
// etapa1 → etapa2 → etapa3 é do sistema, não do modelo):
//  - afirmativa/saudação: "sim", "ok", "pode falar", "oi", "כן", "סבבה"... → próxima etapa
//  - pede_link: quer o link → etapa2 se a condição ainda não foi dita, senão etapa3
//  - confusa: não sabe do que se trata → texto "confusa" do roteiro
//  - pergunta/outra: o modelo responde (livre) e puxa para a próxima etapa
export type CustomerMessageKind = "afirmativa" | "pede_link" | "pede_condicao" | "objecao_preco" | "confusa" | "pergunta" | "outra";
const AFFIRMATIVE_WORDS = [
  // pt / es
  "sim", "ok", "okay", "pode", "pode ser", "pode falar", "pode mandar", "claro", "manda", "me manda", "quero", "bora", "vamos", "beleza", "show", "fechado", "faz sentido", "com certeza", "isso", "aham", "uhum", "t[aá]", "t[aá] bom", "tudo bem", "combinado", "perfeito", "[oó]timo", "legal", "boa", "diga", "fala", "conta", "me conta", "me explica", "envia", "envie", "a[ií]", "agora", "pra mim", "por favor", "pfv", "pf", "qual (?:[eé] )?a condi[cç][aã]o", "que condi[cç][aã]o", "qual (?:[eé] )?a proposta", "qual (?:[eé] )?a oferta", "o que voc[eê] consegue", "pode continuar", "continua", "segue", "e a[ií]", "oi", "oii", "oie", "ol[aá]", "bom dia", "boa tarde", "boa noite", "s[ií]",
  // he
  "כן", "אוקיי", "אוקי", "אוקיי מה", "בסדר", "סבבה", "יאללה", "בטח", "ברור", "מתאים", "מתאים לי", "מעולה", "נשמע טוב", "מעוניינת", "מעוניין", "רוצה", "אפשר", "מה התנאי", "מה ההצעה", "מה המבצע", "ספרי", "תספרי", "ספר", "תספר", "דברי", "דבר", "אני מקשיבה", "אני מקשיב", "נו", "קדימה", "בואי", "בוא", "היי", "הי", "שלום", "אהלן", "בוקר טוב", "ערב טוב", "מה", "מה קרה", "מה העניין", "תמשיכי", "המשיכי", "כן בטח", "אוקיי בטח", "תשלחי", "תשלח", "שלחי", "שלח", "תשלחו", "לי", "אותו", "אותה", "עכשיו", "מעולה", "יופי", "אחלה", "בכיף",
  // he: "כן אשמח בבקשה" ficou 10 h sem resposta em 11/10 porque "אשמח" e "בבקשה" não estavam na lista (virava "outra" e o roteiro não andava)
  "אשמח", "אשמח לשמוע", "בבקשה", "בשמחה", "בהחלט", "ודאי", "מעניין", "נשמע מעניין", "תגידי", "תגיד", "תסבירי", "תסביר",
  // en
  "yes", "yeah", "yep", "ok", "okay", "sure", "send", "send it", "go ahead", "tell me", "what(?:'s| is) the (?:offer|deal|condition)", "sounds good", "i'm in", "deal", "fine", "alright", "hi", "hello", "hey", "go on", "continue",
  // ru
  "да", "ок", "окей", "хорошо", "давай", "давайте", "конечно", "отправь", "отправьте", "расскажи", "расскажите", "какое условие", "интересно", "привет", "здравствуйте", "слушаю",
  // ar
  "نعم", "اوك", "أوك", "تمام", "طيب", "ارسلي", "أرسلي", "ارسل", "ماشي", "اكيد", "أكيد", "ايوه", "أيوه", "مرحبا", "اهلا", "أهلا",
  // fr
  "oui", "d'accord", "d accord", "envoie", "envoyez", "dites-moi", "je veux bien", "bonjour", "salut", "allez-y",
];
const AFFIRMATIVE_RE = new RegExp("^(?:" + AFFIRMATIVE_WORDS.join("|") + ")(?:\\s+(?:" + AFFIRMATIVE_WORDS.join("|") + "))*$", "iu");
// Fronteira por letra Unicode (\b do JS não enxerga hebraico/cirílico/árabe):
// sem isso "כמה זה עולה" (quanto custa) casava "מה זה" (o que é isso).
const wordRe = (alts: string[], flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, flags);
const CONFUSED_RE = wordRe([
  "que produto", "qual produto", "n[aã]o (?:me )?lembro", "n[aã]o sei do que", "n[aã]o fiz (?:nenhum )?(?:pedido|compra)", "n[aã]o comprei", "do que voc[eê] (?:est[aá] )?fala\\p{L}*", "n[aã]o sei o que [eé]",
  "מה זה", "איזה מוצר", "איזו הזמנה", "לא זוכרת", "לא זוכר", "לא הזמנתי", "על מה את מדברת", "על מה מדובר", "לא יודעת על מה", "לא יודע על מה",
  "what product", "don'?t remember", "didn'?t order", "what is this",
  "какой товар", "не помню", "не заказывала?", "о ч[её]м вы",
  "ما هذا", "لم أطلب", "أي منتج",
]);
// Pediu a condição em qualquer lugar da mensagem ("me diga qual é a condição especial").
const ASKS_CONDITION_RE = wordRe(["qual (?:[eé] )?(?:a )?condi[cç][aã]o(?: especial)?", "que condi[cç][aã]o", "me (?:diga|fala|fale|conta|conte|explica) (?:qual [eé] )?a condi[cç][aã]o", "a condi[cç][aã]o especial", "qual (?:[eé] )?a (?:oferta|proposta|promo[cç][aã]o)", "מה התנאי", "מה התנאי המיוחד", "מה ההצעה", "מה המבצע", "מה ההנחה", "איזה תנאי", "תגידי מה התנאי", "what(?:'s| is) the (?:offer|deal|condition|discount)", "какое условие", "какая скидка", "ما هو العرض", "ما العرض", "quelle (?:est l'|)offre"]);
// Objeção de preço: a condição especial (etapa2) é a resposta do roteiro.
const PRICE_OBJECTION_RE = wordRe(["caro", "car[ií]ssimo", "muito caro", "t[aá] caro", "sem dinheiro", "n[aã]o tenho dinheiro", "pesado", "יקר", "יקר לי", "יקר מדי", "אין לי כסף", "קצת יקר", "expensive", "too much", "can'?t afford", "дорого", "дороговато", "غالي", "غالية", "cher", "trop cher"]);
const ASKS_LINK_RE = wordRe(["link", "links", "לינק", "הלינק", "קישור", "הקישור", "ссылк\\p{L}*", "رابط", "الرابط", "lien"]);
const QUESTION_WORD_RE = wordRe(["quanto", "qual", "quais", "como", "onde", "quando", "por ?que", "o que", "tem", "será", "existe", "d[aá] pra", "posso", "pode", "כמה", "מה", "איך", "איפה", "מתי", "למה", "האם", "יש", "אפשר", "how", "what", "when", "where", "why", "is it", "do you", "can i", "could", "сколько", "как", "что", "где", "когда", "почему", "كم", "ماذا", "كيف", "متى", "لماذا", "هل", "combien", "comment", "quand", "pourquoi", "est-ce"]);
export function classifyCustomerMessage(text: string): CustomerMessageKind {
  const t = (text ?? "").normalize("NFKC").replace(/https?:\/\/\S+/g, " ").replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, " ").replace(/[!.,;:…"'“”‘’()\-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return "afirmativa"; // só emoji/figurinha
  if (ASKS_CONDITION_RE.test(t)) return "pede_condicao";
  if (CONFUSED_RE.test(t)) return "confusa";
  if (PRICE_OBJECTION_RE.test(t)) return "objecao_preco";
  if (ASKS_LINK_RE.test(t) && t.split(" ").length <= 8) return "pede_link";
  const words = t.replace(/\?/g, "").trim();
  if (words.split(" ").length <= 6 && AFFIRMATIVE_RE.test(words)) return "afirmativa";
  if (t.includes("?") || QUESTION_WORD_RE.test(t.split(" ").slice(0, 2).join(" "))) return "pergunta";
  return "outra";
}

// Confirmação curta quando o cliente pede pra parar (palavra de parada no
// webhook ou action=stop do agente sem texto).
export const STOP_CONFIRMATIONS: Record<string, string> = {
  he: "בסדר גמור, לא נשלח יותר הודעות. תודה ויום טוב.",
  en: "Understood, you will not receive any more messages from us. Thank you.",
  fr: "C'est noté, vous ne recevrez plus de messages de notre part. Merci.",
  bg: "Разбрано, няма да получавате повече съобщения от нас. Благодарим.",
  hu: "Rendben, nem küldünk több üzenetet. Köszönjük.",
  ro: "Am înțeles, nu veți mai primi mesaje de la noi. Mulțumim.",
  tr: "Anlaşıldı, bir daha mesaj göndermeyeceğiz. Teşekkürler.",
  pl: "Jasne, nie będziemy już wysyłać wiadomości. Dziękujemy.",
  sv: "Uppfattat, du får inga fler meddelanden från oss. Tack.",
  de: "Alles klar, Sie erhalten keine weiteren Nachrichten von uns. Danke.",
  es: "Entendido, no recibirás más mensajes nuestros. Gracias.",
  it: "Capito, non riceverai altri messaggi da noi. Grazie.",
  nl: "Begrepen, u ontvangt geen berichten meer van ons. Bedankt.",
  da: "Forstået, du modtager ikke flere beskeder fra os. Tak.",
  ru: "Поняла, больше сообщений от нас не будет. Спасибо.",
  pt: "Combinado, não vamos mandar mais mensagens. Obrigada.",
};
export const STOP_CONFIRMATION_PT = "Combinado, não vamos mandar mais mensagens. Obrigada.";
export const stopConfirmation = (language: string | null | undefined): string | null => STOP_CONFIRMATIONS[(language ?? "").toLowerCase().slice(0, 2)] ?? null;

// Palavra de parada no começo da mensagem do cliente ("stop", "הסר", "стоп",
// "Stopp bitte"...). Caminho determinístico do webhook: supressão + status
// parado_descadastrou + confirmação curta, sem passar pelo modelo.
// Sem \b: em JS ele só enxerga [A-Za-z0-9_], então "הסר" e "стоп" nunca
// casariam. A fronteira aqui é independente de alfabeto (fim ou espaço/
// pontuação). Flag u: maiúscula/minúscula também em cirílico.
const STOP_WORDS_RE = /^[\s"'«»(¿¡]*(stop|stopp|parar|pare|cancelar|unsubscribe|remover|remove|הסר|הסירו|תפסיקו|לא מעוניין|לא מעוניינת|arrêt|arret|спри|стоп|leiratkozás)(?=$|[\s,.!?)])/iu;
// Palavras curtas e ambíguas ("די" também é "bastante": "די יקר" = "bem caro";
// "dur" é "duro" em francês): só valem como a mensagem inteira.
const STOP_EXACT_RE = /^[\s"'«»(¿¡]*(די|dur)[\s,.!?)]*$/iu;
export const isStopMessage = (text: string | null | undefined): boolean => {
  const t = (text ?? "").trim();
  return t.length > 0 && (STOP_WORDS_RE.test(t) || STOP_EXACT_RE.test(t));
};

// Assunto de suporte na mensagem do cliente: mesmo que o modelo tente
// responder, vai pra humano (rede de segurança em código). Só palavras
// inequívocas; "onde está o meu pedido" também, porque quem abandonou um
// carrinho e pergunta isso já comprou em outro lugar ou acha que comprou.
const escapeWord = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Reembolso, estorno, troca, devolução e cobrança: SEMPRE humano.
const SUPPORT_HARD_WORDS = [
  "refund", "rembours", "remboursement", "erstattung", "rückerstattung", "iade", "para iadesi", "възстанов", "visszatérít", "rambursa", "zwrot", "återbetal", "reembolso", "rimborso", "החזר", "זיכוי", "chargeback", "возврат",
  "exchange", "échange", "devolução", "devolver", "umtausch", "değişim", "замяна", "csere", "schimb", "wymiana", "החלפה", "להחזיר", "charged twice", "double charge", "débité", "cobrança", "חויבתי", "חיוב",
];
// Rastreio e "onde está o meu pedido": humano, EXCETO quando a Shopify acabou de
// confirmar a compra desta cliente (aí prazo e rastreio o agente responde).
const SUPPORT_TRACKING_WORDS = [
  "tracking", "track my", "suivi", "colis", "sendungsverfolgung", "kargo takip", "проследяване", "nyomon követ", "urmărire", "śledzenie", "spårning", "מעקב", "משלוח שלי", "החבילה",
  "where is my order", "where's my order", "où est ma commande", "wo ist meine bestellung", "siparişim nerede", "къде е поръчката", "hol van a rendelésem", "unde este comanda", "gdzie jest moje zamówienie", "var är min beställning", "איפה ההזמנה", "где мой заказ",
];
export const SUPPORT_HARD_RE = new RegExp(SUPPORT_HARD_WORDS.map(escapeWord).join("|"), "i");
export const SUPPORT_TOPIC_RE = new RegExp([...SUPPORT_HARD_WORDS, ...SUPPORT_TRACKING_WORDS].map(escapeWord).join("|"), "i");

export interface AgentCartItem {
  title: string;
  variant: string | null;
  quantity: number;
  unitPrice: string | null;
  lineTotal: string | null;
  // Item de brinde (preço zero ou "grátis/בחינם/free" no título).
  free?: boolean;
}

export interface AgentDiscountOption {
  percent: number;
  code: string;
}

// Percentual que a cliente ouve: o do NOME do cupom (VOLTA15 → 15), decisão do
// Ian. O percentual interno (5/9/10 do subtotal na Shopify) nunca aparece.
export const shownPercent = (d: { percent: number; code?: string | null }): number => {
  const m = /(\d{1,2})\s*$/.exec(d.code ?? "");
  return m ? Number(m[1]) : d.percent;
};

export interface AgentHistoryEntry {
  author: "cliente" | "agente" | "humano" | "regua";
  body: string;
  at: string | null;
}

// Tudo que o agente sabe na hora de responder. Montado por buildAgentContext
// (agent.ts) a partir do banco; um script de teste pode montar à mão.
export interface AgentContext {
  recoveryId: string;
  waStep: number;
  storeName: string;
  brand: string;
  agentName: string;
  customerName: string | null;
  language: string;
  countryCode: string | null;
  items: AgentCartItem[];
  total: string | null;
  appliedCodes: string[];
  cartLink: string;
  offeredPercent: number;
  offeredCode: string | null;
  maxDiscount: number;
  // Cupons ativos da loja com percent <= maxDiscount (ordem crescente).
  discounts: AgentDiscountOption[];
  knowledge: string;
  storeContext: string;
  ownerPrompt: string | null;
  history: AgentHistoryEntry[];
  latestMessage: string;
  agentMessageCount: number;
  // Conversa de teste do dono (carrinho-sandbox): pode responder em português.
  ownerTest?: boolean;
  // Desconto que o carrinho JÁ tem (cupom do site), em % do preço cheio.
  appliedPercent?: number | null;
  // Resumo do que está no carrinho, pronto (ex.: "kit com 4 unidades do Olavita Tri-Lift (3 + 1 de brinde) + presente surpresa").
  productSummary?: string | null;
  productSummaryHe?: string | null;
  // Valor estimado do carrinho com o adicional (ex.: "₪181"), já na moeda da cliente.
  estimatedWithExtra?: string | null;
  // Quanto o cupom extra tira deste carrinho (ex.: "₪44"), já na moeda da cliente.
  extraSaving?: string | null;
  // Roteiro do dono em texto fixo (recovery_knowledge kind 'script', título
  // "roteiro:<etapa>"): etapa → idioma (pt, he, he_m) → texto com {nome},
  // {produto}, {kit_curto}, {X}, {E}, {T}, {preco_atual}, {preco_final} e {{link}}.
  scriptTemplates?: Record<string, Record<string, string>>;
  // Valores dessas marcações por idioma (pt, he).
  scriptVars?: Record<string, Record<string, string>>;
  // Frase do desconto total com o adicional (ex.: "quase 80%"): os descontos
  // da loja somam (a Shopify calcula os dois sobre o mesmo subtotal).
  totalDiscountPhrase?: string | null;
  // Porcentagens que são fato neste carrinho (a trava aceita no texto).
  factualPercents?: number[];
  // Verificação de compra feita AGORA na Shopify (checkout completado ou pedido
  // pago por e-mail/telefone). pago = já comprou; nao_encontrado = nada pago;
  // desconhecido = a consulta falhou (não afirme nada sobre pagamento).
  // hint = o que ela informou e o sistema procurou sem achar (ex.: "nome Michal Cohen").
  purchase?: { state: "pago" | "nao_encontrado" | "desconhecido"; order?: string | null; detail?: string | null; hint?: string | null };
  // Hora local da cliente agora (ex.: "sexta-feira, 02:35 (madrugada)").
  localTime?: string | null;
  // Mensagens do agente nas últimas 24 h (limite de segurança contra loop com robô).
  agentMessages24h?: number;
  // Onde a conversa está no ROTEIRO (calculado pelo sistema a partir do histórico).
  stageHint?: string | null;
  // Etapas do roteiro já enviadas (pelas notas gravadas em cada envio): vale
  // também para a etapa traduzida (russo, árabe...), que não bate com o texto fixo.
  scriptStepsSent?: string[];
  // Resposta atrasada (o modelo esteve fora): quanto tempo ela ficou esperando.
  delayNote?: string | null;
}

// Etapas enviadas a partir das notas de cada resposta ("roteiro: etapa1",
// "roteiro: etapa2 traduzida para ru"...). "roteiro em código: ..." é a decisão,
// não o envio; "sem texto" quer dizer que não saiu.
export function scriptStepsFromNotes(notes: string[]): string[] {
  const out = new Set<string>();
  for (const n of notes) {
    const m = /^roteiro: (etapa1|etapa2|etapa3|confusa|retomada)\b(.*)$/.exec(n.trim());
    if (m && !/sem texto/.test(m[2])) out.add(m[1]);
  }
  return [...out];
}

// Percentuais que o agente pode oferecer AGORA: cadastrados, dentro do teto
// e acima do que já foi dado nesta conversa.
export function offerableDiscounts(ctx: Pick<AgentContext, "discounts" | "maxDiscount" | "offeredPercent">): AgentDiscountOption[] {
  return ctx.discounts.filter((d) => d.percent <= ctx.maxDiscount && d.percent > ctx.offeredPercent).sort((a, b) => a.percent - b.percent);
}

// Regras fixas (as de venda do house-rules do suporte + as do WhatsApp).
export function agentRules(ctx: AgentContext): string[] {
  const lang = languageName(ctx.language);
  const offerable = offerableDiscounts(ctx);
  return [
    `Você é ${ctx.agentName}, vendedora da marca ${ctx.brand}, conversando pelo WhatsApp com uma pessoa que começou um pedido no site e não finalizou. Não se apresente como IA por conta própria e nunca cite ferramentas, Shopify, "sistema", revisão ou bastidores. Mas se a cliente perguntar sinceramente se está falando com um robô, uma IA ou uma pessoa, NÃO minta: diga com leveza que é a assistente virtual do time da Olavita, que tem uma equipe de verdade acompanhando, e ofereça chamar alguém da equipe se ela preferir; depois siga a conversa. Essa oferta de chamar a equipe é SÓ para essa pergunta: em qualquer outra resposta, não ofereça chamar ninguém, a menos que ela peça.`,
    ctx.ownerTest
      ? "IDIOMA (TESTE DO DONO): quem escreve é o dono da loja testando você como se fosse uma cliente. Responda no idioma da última mensagem dele (português do Brasil ou hebraico), como uma nativa, com o mesmo jeito que usaria com uma cliente real. Não comente que é teste."
      : `IDIOMA: responda SEMPRE em ${lang} (o idioma do carrinho) como uma nativa, a menos que a última mensagem do cliente esteja claramente em outro idioma: aí responda no idioma dele e informe o código em "language". NUNCA escreva em português para o cliente: nenhuma palavra, nem a saudação, nem a despedida. Hebraico tem que ser hebraico de verdade, natural e coloquial, não tradução literal.`,
    "GÊNERO (hebraico e árabe): 'אתה' é masculino e 'את' feminino, com verbo junto. Procure pista de gênero na mensagem do cliente (verbo na 1ª pessoa, adjetivo, nome só de um gênero). Sem pista, use formulação que evite a flexão (ex.: infinitivo, 'אפשר', frases sem 'você'). Nunca assuma masculino por padrão. Você fala de si mesma no feminino.",
    `FORMATO WHATSAPP: escreva como uma vendedora no WhatsApp. Resposta simples: 1 ou 2 frases. Mensagem maior (como as do ROTEIRO do dono): quebre em parágrafos curtos separados por UMA linha em branco, exatamente como no roteiro. Máximo ${MAX_REPLY_CHARS} caracteres. Sem markdown (nada de asteriscos, listas, títulos), sem travessão (use vírgula, ponto ou dois-pontos), no máximo UMA pergunta por mensagem (as perguntas dos modelos do ROTEIRO valem como estão). Emojis: os do roteiro (😕 e 😉); fora do roteiro, no máximo um e só se a cliente usou. Tom caloroso, direto e humano, sem fórmulas de call center ('prezado cliente', 'estamos à disposição').`,
    "OBJETIVO: fechar o pedido pelo link do carrinho, seguindo o ROTEIRO do dono (INSTRUÇÕES EXTRAS) quando houver. Você só fala do carrinho desta pessoa e do produto que está nele. Se ela perguntou algo, responda primeiro e depois siga a etapa do roteiro. Nunca pressione, nunca invente urgência falsa, nunca repita o link se ele já foi mandado na última mensagem sua e o cliente não pediu.",
    `PRODUTO: nunca diga só 'o pedido' ou 'o produto'. Para dizer o que ela deixou no carrinho, use o RESUMO DO PRODUTO do bloco CARRINHO${ctx.productSummary ? ` ("${ctx.productSummary}")` : ""}, traduzido para o idioma da conversa, com a marca e o nome do produto como estão (sem 'complexo de peptídeos'). Depois da primeira menção, pode dizer só 'o Tri-Lift'.`,
    "LINK: o link do carrinho está no bloco CARRINHO. Quando quiser mandar o link, escreva exatamente a marcação {{link}} no lugar dele (o sistema troca pela URL certa). Nunca invente outra URL, nunca mande o link quebrado ou alterado.",
    `PREÇO: o valor do carrinho está no bloco CARRINHO, pode informar como está lá (já formatado na moeda do cliente). ${ctx.estimatedWithExtra ? `Com o adicional, o valor estimado é ${ctx.estimatedWithExtra}: se ela perguntar o valor ou quanto fica, diga SEMPRE os dois: o valor atual do carrinho e o valor com a condição especial (ex.: "Hoje o seu carrinho está em ${ctx.total ?? "X"}; com a condição que eu consegui, mais ${ctx.extraSaving ?? "o desconto extra"} de desconto, fica em torno de ${ctx.estimatedWithExtra}"), e que o valor exato aparece no checkout pelo link.` : "Não calcule valor com desconto em dinheiro: fale a porcentagem e diga que o valor final aparece no checkout."} Não converta moeda e não calcule nenhum outro valor.`,
    "PRAZO DE ENTREGA: se perguntarem, a média é de 9 a 12 dias úteis depois do envio. Nunca prometa data, nunca diga 'amanhã', 'em 1 dia', 'a qualquer momento', nunca garanta prazo. Se o CONHECIMENTO trouxer outro prazo para esta marca, use o do CONHECIMENTO.",
    "NUNCA FALE de assinatura, renovação, cobrança recorrente ou 'tratamento contínuo', a menos que o próprio cliente pergunte, e aí: action = handoff.",
    `NÃO INVENTE: ingrediente, origem, tamanho da embalagem, modo de uso, forma de pagamento (PayPal, parcelamento), telefone da loja, garantia, estoque, promoção. Só afirme o que está no CONHECIMENTO, no CONTEXTO DA LOJA ou no CARRINHO. Se perguntarem um FATO sobre o produto, a empresa ou o pedido que não está lá (perguntas sobre você e sobre a conversa são suas: veja PERGUNTAS QUE VOCÊ MESMA RESPONDE), diga com as SUAS palavras, como uma pessoa real, que não tem certeza dessa informação e vai confirmar com o seu supervisor ou com a equipe e já avisa (handoff_tipo = fato_desconhecido: você continua a conversa normalmente depois) (ex.: "Não tenho certeza dessa informação, vou confirmar com o meu supervisor e já te aviso", "Boa pergunta! Deixa eu confirmar com a equipe e já te respondo"), citando o assunto quando fizer sentido ("sobre o retinol, ..."). NUNCA repita uma frase que você já usou nesta conversa. action = handoff com a pergunta exata da cliente em handoff_reason (a equipe responde e acrescenta ao CONHECIMENTO). Se a mensagem tem VÁRIAS perguntas, responda antes as que você sabe e só diga que vai confirmar a que você não sabe. Nunca diga 'não temos' nem 'não é possível' sem base.`,
    `PERGUNTAS QUE VOCÊ MESMA RESPONDE, sem frase padrão e sem handoff (são sobre você e sobre a conversa, não sobre fatos da empresa): "quem é você", "qual é o seu nome", "de onde você fala / de onde você é", "por que está me mandando mensagem (agora, nesse horário)", "que horas são aí", saudação (no meio da conversa: cumprimente em poucas palavras e volte ao pedido, sem se apresentar de novo), agradecimento, "ok", "não entendi", "pode repetir", "como pago / como funciona o link", "vou pensar". Como responder: (1) quem é / de onde fala: você é ${ctx.agentName}, do time de atendimento online da ${ctx.brand}, e atende os pedidos por aqui pelo WhatsApp e por e-mail; o número do WhatsApp é internacional porque o atendimento é online. NUNCA invente cidade, país, endereço, telefone ou empresa. (2) por que escreveu ou por que nesse horário: ela deixou um pedido da ${ctx.brand} no carrinho sem finalizar e você quis ajudar; se for noite ou madrugada na HORA LOCAL dela, peça desculpa pelo horário em uma frase; diga que, se ela preferir, você para de mandar mensagem. (3) as demais (inclusive "que horas são aí": diga a HORA LOCAL e volte ao pedido): resposta curta e natural, sem oferecer parar de mandar mensagem. Em todas, termine voltando ao pedido dela com UMA pergunta, sem repetir o roteiro.`,
    `PAGAMENTO FEITO: o bloco CARRINHO traz a VERIFICAÇÃO DE COMPRA, conferida agora na Shopify (pelo checkout, pelo e-mail e telefone do carrinho e, se ela informou, pelo nome, e-mail ou número do pedido que ela escreveu). Se a cliente disser que já pagou, comprou ou finalizou, marque cliente_diz_que_pagou = true e siga o estado: PAGO = action bought; agradeça com carinho (sem cumprimentar nem se apresentar de novo), confirme que o pedido dela foi recebido${ctx.purchase?.order ? ` (pedido ${ctx.purchase.order})` : ""} e que você já acompanha o envio; sem link e sem desconto; se ela perguntar prazo, a média é de 9 a 12 dias úteis depois do envio (nunca prometa data); se perguntar rastreio, depois do envio ela recebe um e-mail com o link de rastreio. NÃO ENCONTRADO = NÃO confirme o pagamento e NÃO use a frase padrão: diga que ainda não apareceu aqui no sistema (às vezes leva alguns minutinhos) e peça o comprovante, um print do pagamento, para conferir; action = reply. NÃO VERIFICADO = diga que vai conferir e já retorna; action = handoff com handoff_reason "não consegui verificar a compra agora". Nunca confirme um pagamento que a VERIFICAÇÃO não mostrou. Com estado PAGO a cliente JÁ COMPROU: não ofereça link nem desconto, seja qual for a pergunta; agradeça e responda o que ela perguntou.`,
    "PEDIU PESSOA OU TELEFONE: se ela pede para falar com uma pessoa de verdade ou com a equipe, responda com carinho que vai chamar alguém da equipe para falar com ela por aqui e que já retorna (nunca diga que a equipe liga); action = handoff com handoff_reason 'pediu para falar com uma pessoa'; não use a frase padrão. Se ela pede só o TELEFONE: não existe telefone de atendimento (CONHECIMENTO); diga isso com simpatia, que o atendimento é por aqui e por e-mail, e ofereça chamar alguém da equipe para continuar por aqui (action = reply; só handoff se ela aceitar ou insistir).",
    "SUPORTE É COM HUMANO: pedido já feito, 'onde está o meu pedido', rastreio, entrega atrasada, reembolso, estorno, troca, devolução, cobrança, contestação, reclamação de produto recebido, dado pessoal ou endereço. Nesses casos NÃO responda o assunto nem parcialmente: action = handoff, handoff_reason em PT-BR, e reply com uma frase curta dizendo que vai verificar com a equipe e já retorna por aqui.",
    `DESCONTO: siga as INSTRUÇÕES EXTRAS DO DONO sobre quando apresentar o desconto; sem instrução do dono, só ofereça quando o cliente mostrar objeção de preço ou pedir. Só os percentuais do bloco DESCONTOS DISPONÍVEIS, começando pelo MENOR. Nunca dois descontos na mesma conversa sem o cliente ter recusado o anterior. ${ctx.totalDiscountPhrase ? `DESCONTO TOTAL: os descontos desta loja somam; com o adicional, o total é "${ctx.totalDiscountPhrase}" (use exatamente essa frase, nunca um número maior).` : "Não calcule desconto total."} Quando oferecer: action = offer_discount, discount_percent com o número exato. ${ctx.offeredPercent > 0 ? `O desconto adicional de ${shownPercent({ percent: ctx.offeredPercent, code: ctx.offeredCode })}% JÁ foi oferecido a esta cliente: pode reforçar essa condição e mandar o {{link}} (o link já leva o cupom); não invente outro maior.` : offerable.length === 0 ? "AGORA NÃO HÁ DESCONTO DISPONÍVEL PARA OFERECER: não prometa, não cite porcentagem; se o cliente insistir no preço, action = handoff com motivo 'pede desconto'." : `Agora você pode oferecer: ${offerable.map((d) => `${shownPercent(d)}%`).join(", ")}. Esse é o percentual que você diz à cliente e o valor de discount_percent. NUNCA diga o nome ou o código do cupom: o desconto já vai aplicado dentro do link.`}`,
    "AÇÕES: reply = resposta normal. offer_discount = está oferecendo cupom agora. handoff = passa pra equipe humana (motivo em PT-BR em handoff_reason). stop = o cliente pediu para parar de receber mensagens (confirme em uma frase curta, sem vender). bought = a VERIFICAÇÃO DE COMPRA está PAGO e a conversa é sobre essa compra (agradeça, sem link, sem desconto). Se ela diz que pagou e o estado é NÃO ENCONTRADO, use reply (ver PAGAMENTO FEITO). not_interested = o cliente disse claramente que não quer (despedida curta e educada, sem insistir, sem desconto).",
    "HISTÓRICO: leia a conversa inteira antes de escrever. Não repita o que já disse, não cumprimente de novo no meio da conversa, não contradiga o que a régua ou a equipe já escreveu. Se você já mandou 6 mensagens sem resposta útil do cliente (ele some ou só manda monossílabos), action = handoff com motivo 'sem avanço'.",
    "MARCA: fale só da marca deste carrinho. Nunca cite outra marca ou outro produto da operação.",
    "DADOS: nunca peça cartão, senha ou dado sensível. O pagamento é pelo link do carrinho, no site.",
    "CAMPOS EM PORTUGUÊS: reply_pt (tradução fiel e completa de reply), summary_pt (1 frase: onde a conversa está) e handoff_reason são SEMPRE em português do Brasil, só com alfabeto latino (nome de produto traduzido ou transliterado).",
  ];
}

function fmtAt(at: string | null): string {
  if (!at) return "";
  try {
    return new Date(at).toLocaleString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC";
  } catch {
    return at;
  }
}

const AUTHOR_LABEL: Record<AgentHistoryEntry["author"], string> = { cliente: "CLIENTE", agente: "VOCÊ", humano: "EQUIPE (humano)", regua: "RÉGUA (mensagem automática sua)" };

export function formatHistory(history: AgentHistoryEntry[]): string {
  if (history.length === 0) return "(nenhuma mensagem ainda)";
  return history.map((m) => `[${fmtAt(m.at)}] ${AUTHOR_LABEL[m.author]}: ${m.body}`).join("\n");
}

// Prompt do sistema. `corrections` entra numa segunda chamada quando a
// primeira resposta vazou português, passou do tamanho etc.
export function buildAgentInstructions(ctx: AgentContext, corrections: string[] = []): string {
  const items = ctx.items.length
    ? ctx.items.map((i) => `- ${i.quantity}× ${i.title}${i.variant ? ` (${i.variant})` : ""}${i.free ? " · BRINDE GRÁTIS" : `${i.unitPrice ? ` · unitário ${i.unitPrice}` : ""}${i.lineTotal ? ` · total ${i.lineTotal}` : ""}`}`).join("\n")
    : "- (itens não informados)";
  const offerable = offerableDiscounts(ctx);
  const blocks = [
    `REGRAS (obrigatórias):\n${agentRules(ctx).map((r) => `- ${r}`).join("\n")}`,
    `LOJA\nLoja: ${ctx.storeName}\nMarca do carrinho: ${ctx.brand}\nSeu nome: ${ctx.agentName}`,
    `CLIENTE\nNome: ${ctx.customerName || "(não informado; não invente nome)"}\nIdioma do carrinho: ${languageName(ctx.language)} (${ctx.language})\nPaís: ${ctx.countryCode || "?"}`,
    `CARRINHO\n${items}${ctx.productSummary ? `\nRESUMO DO PRODUTO: ${ctx.productSummary}${ctx.productSummaryHe ? `\nRESUMO DO PRODUTO EM HEBRAICO (use este, igual, quando escrever em hebraico): ${ctx.productSummaryHe}` : ""}` : ""}\nTotal do carrinho: ${ctx.total ?? "(não informado)"}\nCupom já aplicado no carrinho: ${ctx.appliedCodes.length ? ctx.appliedCodes.join(", ") : "nenhum"}${ctx.appliedPercent ? ` (a cliente já tem ${ctx.appliedPercent}% de desconto sobre o preço cheio)` : ""}\nLink do carrinho: escreva {{link}} no texto quando quiser mandá-lo (URL real: ${ctx.cartLink})\nVERIFICAÇÃO DE COMPRA (conferida agora na Shopify): ${ctx.purchase?.state === "pago" ? `PAGO: esta cliente JÁ TEM pedido pago${ctx.purchase.order ? ` (${ctx.purchase.order})` : ""}` : ctx.purchase?.state === "desconhecido" ? "NÃO VERIFICADO: a consulta falhou agora; não afirme nada sobre pagamento e não mande link nem desconto" : "NÃO ENCONTRADO: nenhum pedido pago deste carrinho, e-mail ou telefone"}${ctx.localTime ? `\nHORA LOCAL DA CLIENTE AGORA: ${ctx.localTime}` : ""}`,
    `DESCONTOS DISPONÍVEIS${ctx.appliedPercent ? `\nDesconto que a cliente já tem no carrinho: ${ctx.appliedPercent}%` : ""}${ctx.totalDiscountPhrase ? `\nDesconto total com o adicional: ${ctx.totalDiscountPhrase}` : ""}${ctx.extraSaving ? `\nO adicional tira deste carrinho: cerca de ${ctx.extraSaving}` : ""}${ctx.estimatedWithExtra ? `\nValor estimado com o adicional: em torno de ${ctx.estimatedWithExtra}` : ""}${ctx.scriptVars?.pt?.E ? `\nDesconto adicional para dizer à cliente: ${ctx.scriptVars.pt.E} em cima do valor que ela já via (é o mesmo cupom; nunca cite outra porcentagem para o adicional)` : ""}${ctx.scriptVars?.pt?.T ? `\nDesconto total para dizer à cliente: ${ctx.scriptVars.pt.T}` : ""}\nTeto desta loja: ${ctx.maxDiscount}%\nJá oferecido nesta conversa: ${ctx.offeredPercent > 0 ? `${shownPercent({ percent: ctx.offeredPercent, code: ctx.offeredCode })}%` : "nenhum"}\nPode oferecer agora: ${offerable.length ? offerable.map((d) => `${shownPercent(d)}%`).join("; ") : "NENHUM (não prometa desconto)"} (o desconto vai dentro do link; nunca cite o código)`,
    `CONHECIMENTO (do dono da loja; é a única fonte de fatos sobre o produto)\n${ctx.knowledge.trim() || "(nada cadastrado: não afirme nada sobre o produto além do que está no carrinho)"}`,
    ctx.storeContext.trim() ? `CONTEXTO DA LOJA (regras e fatos do suporte; valem também aqui)\n${ctx.storeContext.trim()}` : null,
    ctx.scriptTemplates && Object.keys(ctx.scriptTemplates).length ? `ROTEIRO DO DONO EM TEXTO FIXO (escolha a etapa em script_step; o sistema envia exatamente este texto, em hebraico para a cliente)\n${Object.entries(ctx.scriptTemplates).map(([k, v]) => `[${k}] ${(v.pt ?? v.he ?? "").replace(/\n+/g, " / ")}`).join("\n")}` : null,
    ctx.ownerPrompt?.trim() ? `INSTRUÇÕES EXTRAS DO DONO (prioridade sobre o tom, nunca sobre as regras de segurança acima)\n${ctx.ownerPrompt.trim()}` : null,
    corrections.length ? `CORREÇÃO OBRIGATÓRIA (a resposta anterior foi rejeitada):\n${corrections.map((c) => `- ${c}`).join("\n")}` : null,
  ];
  return blocks.filter(Boolean).join("\n\n");
}

export function buildAgentInput(ctx: AgentContext): string {
  const latest = ctx.latestMessage.trim();
  const task = latest
    ? `ÚLTIMA MENSAGEM DO CLIENTE (responda a esta):\n${latest}`
    : ctx.history.length > 0
      ? "A cliente parou de responder há mais de 1 hora (sua mensagem foi a última). Se a condição (etapa2) ainda não foi apresentada, use script_step = retomada. Se já foi, script_step = livre: uma mensagem curta perguntando se ela conseguiu ver a condição e se pode mandar o link, sem repetir o texto anterior e sem pressão."
      : "O cliente ainda não escreveu nada. Escreva uma abertura curta e natural, uma pergunta só, sem desconto.";
  const stage = ctx.stageHint ? `ETAPA DO ROTEIRO AGORA (calculada pelo sistema): ${ctx.stageHint}` : null;
  const delay = ctx.delayNote ? `ATENÇÃO: ${ctx.delayNote}. Comece pedindo desculpas pela demora em poucas palavras (sem explicar o motivo técnico) e responda o que ela escreveu.` : null;
  return [`HISTÓRICO DA CONVERSA (mais antigo → mais novo):\n${formatHistory(ctx.history)}`, stage, delay, task].filter(Boolean).join("\n\n");
}
