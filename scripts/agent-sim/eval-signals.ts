// Avaliação (só leitura) da Decisions API da OpenAI (POST /v1/decisions) para ler a
// mensagem da cliente, contra o que já existe em código (classifyCustomerMessage,
// isStopMessage, isPaidClaim), num conjunto rotulado (hebraico em primeiro lugar,
// mais ru/ar/en/pt/fr). Resultado de 10/10 (203 mensagens): palavras de parada
// pegam 30% das frases de parada, a API 93 a 96% (0 falsos positivos); "já paguei"
// 78% contra 100%; intenção do roteiro 91% contra 94 a 96%. Só a PARADA foi ligada
// no sistema (ver lib/recovery/message-signals.ts, que explica por quê).
//
// Uso (raiz do repositório):
//   set -a && . ./.env.local && set +a
//   npx -y tsx --tsconfig tsconfig.json scripts/agent-sim/eval-signals.ts [--verbose]
// Não escreve em banco nem manda mensagem; cada chamada custa frações de centavo.
import { classifyCustomerMessage, isPaidClaim, isStopMessage, type CustomerMessageKind } from "@/lib/recovery/agent-prompt";
import { choiceOf, decide, probabilityOf, type DecisionQuestion } from "@/lib/ai/decisions";
import { STOP_THRESHOLD } from "@/lib/recovery/message-signals";

const PAID_THRESHOLD = 0.85;
const HUMAN_THRESHOLD = 0.9;
type Intent = "agrees" | "asks_link" | "asks_offer" | "price_objection" | "who_is_this" | "confused" | "question" | "declines" | "other";
interface Signals { stop: number; paid: number; human: number; intent: { value: Intent; confidence: number } }

const CONTEXT = "A sales assistant (Yael) from an online skincare store is chatting on WhatsApp with a customer who left a cart without paying. The customer may write in any language (mostly Hebrew).";
const QUESTIONS: DecisionQuestion[] = [
  { type: "predicate", name: "wants_stop", instructions: "Does the customer explicitly ask the assistant to stop messaging her, to remove her from the list, to unsubscribe, or never to contact her again? A polite 'not interested', 'not now', 'no thanks', 'I am busy' or 'I will think about it' is NOT a stop request." },
  { type: "predicate", name: "claims_paid", instructions: "Does the customer say that she has ALREADY paid or completed the purchase? Saying she has not paid yet, asking how to pay, or asking for the link is NOT a claim." },
  { type: "predicate", name: "asks_human", instructions: "Does the customer ask to talk to a real person, a manager, or to be called on the phone?" },
  {
    type: "choice",
    name: "intent",
    instructions: "What is the customer's reply mainly doing, in this conversation?",
    choices: [
      { value: "agrees", description: "Says yes, ok, sure, go ahead, tell me, or tells the assistant to send it, or just greets back." },
      { value: "asks_link", description: "Asks to receive the payment link or the cart link." },
      { value: "asks_offer", description: "Asks what the offer, the special condition, the discount or the final price is." },
      { value: "price_objection", description: "Says it is expensive or too much, or asks for a lower price." },
      { value: "who_is_this", description: "Asks who is writing, who this is, or where we got her number." },
      { value: "confused", description: "Does not remember or does not know the matter: asks what product, order or purchase this is about, or says she did not order anything." },
      { value: "question", description: "Asks a factual question about the product, delivery, payment, warranty or the company." },
      { value: "declines", description: "Says no, not now, not interested, or that she will think about it." },
      { value: "other", description: "Anything else: small talk, thanks, an unclear message." },
    ],
  },
];
async function read(customerMessage: string, lastAgentMessage: string | null): Promise<Signals | null> {
  const input = [CONTEXT, lastAgentMessage ? `Assistant's last message: """${lastAgentMessage}"""` : null, `Customer's reply: """${customerMessage}"""`].filter(Boolean).join("\n");
  const a = await decide(input, QUESTIONS);
  const stop = probabilityOf(a, "wants_stop"), paid = probabilityOf(a, "claims_paid"), human = probabilityOf(a, "asks_human"), intent = choiceOf(a, "intent");
  return stop === null || paid === null || human === null || !intent ? null : { stop, paid, human, intent: { value: intent.choice as Intent, confidence: intent.confidence } };
}

interface Case {
  text: string;
  kind?: CustomerMessageKind; // o que o roteiro precisa saber (sem rótulo = não entra na conta de intenção)
  stop?: boolean;
  paid?: boolean;
  human?: boolean;
}
const k = (kind: CustomerMessageKind, texts: string[], extra: Partial<Case> = {}): Case[] => texts.map((text) => ({ text, kind, ...extra }));

const CASES: Case[] = [
  // concordou / cumprimentou (próxima etapa do roteiro)
  ...k("afirmativa", ["כן", "כן בטח", "סבבה", "אוקיי", "אוקי תספרי", "בסדר", "יאללה", "אשמח לשמוע", "ספרי לי", "תשלחי", "סבבה תשלחי", "כן אשמח", "היי", "שלום", "אהלן", "נשמע טוב", "תמשיכי", "ok", "yes sure", "go ahead", "sim", "pode falar", "claro", "да", "хорошо", "давайте", "نعم", "طيب", "oui", "d'accord"]),
  // pede o link
  ...k("pede_link", ["תשלחי לי את הלינק", "אפשר את הקישור?", "איפה הלינק?", "שלחי לינק לתשלום", "תשלחו לי קישור", "אני רוצה את הלינק", "send me the link", "can I get the link?", "пришлите ссылку", "скиньте ссылку", "ارسلي الرابط", "envoyez-moi le lien", "me manda o link"]),
  // pede a condição / o preço final
  ...k("pede_condicao", ["מה התנאי?", "מה ההצעה שלך?", "מה ההנחה?", "מה המחיר הסופי?", "איזה הנחה את יכולה לתת?", "what's the offer?", "what is the final price?", "какое условие?", "ما هو العرض؟", "qual a condição?", "quanto fica no final?"]),
  // objeção de preço
  ...k("objecao_preco", ["זה יקר", "יקר לי", "יקר מדי בשבילי", "אין לי כסף עכשיו", "קצת יקר", "אפשר יותר זול?", "המחיר גבוה", "too expensive", "that's a lot of money", "дорого", "слишком дорого", "غالي", "c'est trop cher", "tá caro", "muito caro"]),
  // não sabe do que se trata
  ...k("confusa", ["על מה מדובר?", "לא הזמנתי כלום", "איזה מוצר?", "לא זוכרת שהזמנתי", "what is this about?", "о чём речь?", "do que você tá falando?"]),
  // "quem é você?" não é "confusa": a apresentação da etapa1 responde (o texto de quem não lembra do pedido não se apresenta)
  ...k("pergunta", ["מי זו?", "היי מי זו?", "מי את?", "אני לא מכירה אותך", "who is this?", "кто вы?", "من انتِ؟", "quem é você?", "qui êtes-vous ?"]),
  // pergunta factual (o modelo responde)
  ...k("pergunta", ["כמה זמן לוקח המשלוח?", "יש אחריות?", "זה מתאים לעור יבש?", "איך משתמשים בזה?", "מאיפה אתם?", "כמה זה עולה?", "אפשר לשלם בתשלומים?", "זה עובד על קמטים?", "כמה זמן עד שרואים תוצאות?", "how long is delivery?", "is there a warranty?", "сколько идёт доставка?", "كم يستغرق الشحن؟", "qual o prazo de entrega?", "tem garantia?", "combien de temps pour la livraison ?"]),
  // recusa (não é pedido de parada)
  ...k("outra", ["לא תודה", "לא.", "אחשוב על זה", "כרגע אוותר", "לא עכשיו", "אולי בהמשך", "תודה אבל לא", "no thanks", "not now", "I'll think about it", "нет, спасибо", "не сейчас", "لا شكرا", "não, obrigada", "agora não", "non merci"]),
  // agradecimento e conversa solta
  ...k("outra", ["תודה", "תודה רבה", "נהדר", "thanks", "спасибо", "شكرا", "merci", "obrigada"]),

  // pedidos de parada (todos devem parar a régua; compliance)
  ...k("outra", ["הסר אותי מהרשימה", "תפסיקו לשלוח לי הודעות", "בבקשה תפסיקו לשלוח לי", "אל תכתבו לי יותר", "אל תשלחו לי יותר הודעות", "תורידו אותי מהרשימה", "די, תפסיקו", "תפסיקי לכתוב לי", "אני לא רוצה לקבל יותר הודעות", "הסר", "stop", "please stop messaging me", "unsubscribe me", "don't contact me again", "remove me from your list", "не пишите мне больше", "отпишите меня", "стоп", "прекратите писать мне", "لا تراسلوني مرة أخرى", "توقفوا عن ارسال الرسائل", "احذفوني من القائمة", "para de me mandar mensagem", "não me mande mais mensagens", "pare", "arrêtez de m'écrire", "ne me contactez plus"], { stop: true }),
  // quase pedidos de parada que NÃO são (não podem suprimir a cliente)
  ...k("afirmativa", ["אל תפסיקי, תמשיכי לספר", "stop, that's too good, tell me more"], { stop: false }),
  ...k("objecao_preco", ["די יקר"], { stop: false }),
  // negativos de parada que se parecem com parada (nenhum pode suprimir a cliente)
  ...k("outra", ["אני עסוקה כרגע, תכתבי לי מאוחר יותר", "לא עכשיו תודה", "אני לא יכולה לדבר עכשיו", "מתי תפסיקו להעלות מחירים?", "די כבר עם המחירים האלה", "תפסיקי, זה מצחיק", "אל תדאגי, אני אחזור אלייך", "stop it, you are funny", "I'm busy, write me later", "не сейчас, я на работе", "اكتبي لي لاحقا", "agora não, estou ocupada", "mais tarde eu vejo"], { stop: false }),

  // já pagou (a verificação na Shopify decide; aqui só a frase)
  ...k("outra", ["שילמתי", "כבר שילמתי", "שילמתי אתמול", "הזמנתי כבר", "ביצעתי הזמנה", "קניתי כבר", "סיימתי את התשלום", "עשיתי הזמנה לפני שעה", "I already paid", "I just ordered", "done, paid", "я уже оплатила", "заказ оформлен", "دفعت بالفعل", "já paguei", "já comprei", "acabei de pagar", "j'ai déjà payé"], { paid: true }),
  // ainda não pagou (não é reivindicação)
  ...k("pergunta", ["איך משלמים?", "when I pay will it ship today?"], { paid: false }),
  ...k("outra", ["אשלם מחר", "I haven't paid yet", "אשלם אחרי השבת", "עוד לא שילמתי"], { paid: false }),
  ...k("pede_link", ["לא שילמתי עדיין, תשלחי לי את הלינק", "עוד לא שילמתי, שלחי לינק"], { paid: false }),

  // pede uma pessoa ou telefone (a intenção para o roteiro não importa: o modelo faz o handoff)
  ...[ "אפשר לדבר עם מישהו?", "תתקשרי אליי", "אני רוצה לדבר עם נציג", "תחזרי אליי בטלפון", "can I speak to a person?", "call me please", "позвоните мне", "اتصلي بي", "pode me ligar?" ].map((text): Case => ({ text, human: true })),
];

// Mapeia a intenção da API para o que o roteiro usa.
const KIND_OF_INTENT: Record<Intent, CustomerMessageKind> = { agrees: "afirmativa", asks_link: "pede_link", asks_offer: "pede_condicao", price_objection: "objecao_preco", who_is_this: "pergunta", confused: "confusa", question: "pergunta", declines: "outra", other: "outra" };

const CONTEXTS: Array<{ name: string; agent: string | null }> = [
  { name: "sem contexto", agent: null },
  { name: "após a abertura da régua", agent: "היי, אפשר לדבר איתך רגע? זה חשוב." },
  { name: "após a condição (etapa2)", agent: "התחלת את ההזמנה עם הנחה גדולה, והשגתי לך הנחה נוספת של 15%. זו ההנחה הכי גדולה שנתנו למישהו אי פעם. ההצעה הזאת מתאימה לך?" },
];

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const j = i++; if (j >= items.length) return; out[j] = await fn(items[j]); } }));
  return out;
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const KIND_CASES = CASES.filter((c) => c.kind !== undefined);
  console.log(`${CASES.length} mensagens rotuladas (${KIND_CASES.length} com intenção)\n`);

  // Código atual (sem contexto).
  const regexKind = KIND_CASES.map((c) => classifyCustomerMessage(c.text) === c.kind);
  const kindRegexAcc = regexKind.filter(Boolean).length / KIND_CASES.length;
  const stopCases = CASES.filter((c) => c.stop !== undefined);
  const stopRegex = stopCases.map((c) => isStopMessage(c.text));
  const paidCases = CASES.filter((c) => c.paid !== undefined);
  const paidRegex = paidCases.map((c) => isPaidClaim(c.text));
  const pr = (pred: boolean[], truth: boolean[]) => {
    const tp = pred.filter((p, i) => p && truth[i]).length, fp = pred.filter((p, i) => p && !truth[i]).length, fn = pred.filter((p, i) => !p && truth[i]).length;
    return `acerta ${tp} de ${tp + fn} (recall ${((tp / Math.max(1, tp + fn)) * 100).toFixed(0)}%), falsos positivos ${fp}`;
  };
  console.log("CÓDIGO ATUAL");
  console.log(`  intenção (roteiro): ${(kindRegexAcc * 100).toFixed(0)}% (${regexKind.filter(Boolean).length}/${KIND_CASES.length})`);
  console.log(`  parada: ${pr(stopRegex, stopCases.map((c) => c.stop === true))}`);
  console.log(`  já pagou: ${pr(paidRegex, paidCases.map((c) => c.paid === true))}`);

  for (const ctx of CONTEXTS) {
    const t0 = Date.now();
    const sig: Array<Signals | null> = await pool(CASES, 6, (c) => read(c.text, ctx.agent));
    const ms = (Date.now() - t0) / CASES.length;
    const failed = sig.filter((s) => !s).length;
    const sigOf = (c: Case) => sig[CASES.indexOf(c)];
    const kindOk = KIND_CASES.map((c) => { const s = sigOf(c); return s ? KIND_OF_INTENT[s.intent.value] === c.kind : false; });
    const stopApi = stopCases.map((c) => (sig[CASES.indexOf(c)]?.stop ?? 0) >= STOP_THRESHOLD);
    const stopUnion = stopCases.map((c, i) => stopApi[i] || stopRegex[i]);
    const paidApi = paidCases.map((c) => (sig[CASES.indexOf(c)]?.paid ?? 0) >= PAID_THRESHOLD);
    const paidUnion = paidCases.map((c, i) => paidApi[i] || paidRegex[i]);
    const humanCases = CASES.filter((c) => c.human !== undefined || c.kind === "pergunta");
    const humanApi = humanCases.map((c) => (sig[CASES.indexOf(c)]?.human ?? 0) >= HUMAN_THRESHOLD);
    console.log(`\nDECISIONS API, ${ctx.name} (${ms.toFixed(0)} ms por mensagem em média, ${failed} falhas)`);
    console.log(`  intenção (roteiro): ${((kindOk.filter(Boolean).length / KIND_CASES.length) * 100).toFixed(0)}% (${kindOk.filter(Boolean).length}/${KIND_CASES.length})`);
    console.log(`  parada (≥ ${STOP_THRESHOLD}): ${pr(stopApi, stopCases.map((c) => c.stop === true))}; união com o regex: ${pr(stopUnion, stopCases.map((c) => c.stop === true))}`);
    console.log(`  já pagou (≥ ${PAID_THRESHOLD}): ${pr(paidApi, paidCases.map((c) => c.paid === true))}; união com o regex: ${pr(paidUnion, paidCases.map((c) => c.paid === true))}`);
    console.log(`  pede pessoa (≥ ${HUMAN_THRESHOLD}): ${pr(humanApi, humanCases.map((c) => c.human === true))}`);
    if (verbose) {
      for (const [i, c] of CASES.entries()) {
        const s = sig[i];
        const problems: string[] = [];
        const ki = KIND_CASES.indexOf(c);
        if (ki >= 0 && !kindOk[ki]) problems.push(`intenção ${s ? s.intent.value + " " + s.intent.confidence.toFixed(2) : "falhou"} esperado ${c.kind}`);
        if (c.stop !== undefined && (s?.stop ?? 0) >= STOP_THRESHOLD !== c.stop) problems.push(`parada ${(s?.stop ?? 0).toFixed(2)} esperado ${c.stop}`);
        if (c.paid !== undefined && (s?.paid ?? 0) >= PAID_THRESHOLD !== c.paid) problems.push(`pago ${(s?.paid ?? 0).toFixed(2)} esperado ${c.paid}`);
        if (c.human !== undefined && (s?.human ?? 0) >= HUMAN_THRESHOLD !== c.human) problems.push(`pessoa ${(s?.human ?? 0).toFixed(2)} esperado ${c.human}`);
        if (problems.length > 0) console.log(`    ${c.text.slice(0, 50).padEnd(50)} ${problems.join(" | ")}`);
      }
    }
  }
  if (verbose) {
    console.log("\nERROS DO CÓDIGO ATUAL");
    for (const [i, c] of KIND_CASES.entries()) if (!regexKind[i]) console.log(`    ${c.text.slice(0, 50).padEnd(50)} regex=${classifyCustomerMessage(c.text)} esperado ${c.kind}`);
    for (const [i, c] of stopCases.entries()) if (stopRegex[i] !== (c.stop === true)) console.log(`    PARADA ${c.text.slice(0, 50).padEnd(50)} regex=${stopRegex[i]} esperado ${c.stop}`);
    for (const [i, c] of paidCases.entries()) if (paidRegex[i] !== (c.paid === true)) console.log(`    PAGO ${c.text.slice(0, 50).padEnd(50)} regex=${paidRegex[i]} esperado ${c.paid}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
