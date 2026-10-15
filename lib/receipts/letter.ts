// Comprovante em formato de CARTA (modelo aprovado pelo Ian em 01/10/2026,
// copiado do e-mail de boas-vindas dele na Klaviyo): fundo branco, logo,
// texto corrido assinado por uma pessoa, pedido em linhas simples, botão
// verde-água e uma linha preta no rodapé. Nada de cartão arredondado nem
// selo colorido — o layout antigo "tinha muita cara de IA".
//
// O texto é POR MARCA (fala de pele, cita a cobrança "SP OSTEOPURE" e é
// assinado pela Monique — só faz sentido pra Olavita). Marca/idioma sem
// carta aqui continua no layout antigo de lib/receipts/build.ts.
//
// Hebraico escrito SEM gênero de propósito (plural/substantivo em vez de
// verbo no feminino): já tivemos cliente reclamando de ser tratada no
// masculino, e homem também compra.
export interface LetterStrings {
  subject: string;
  greeting: string; // {name}
  greetingNoName: string;
  welcome: string;
  received: string;
  orderLine: string; // {order} {date}
  shipping: string;
  free: string;
  totalPaid: string;
  shipTo: string;
  delivery: string;
  descriptorBold1: string;
  descriptorMid: string;
  descriptorBold2: string;
  descriptorEnd: string;
  help: string;
  signoff: string;
  signer: string;
  team: string;
  cta: string;
  questionBold: string;
  questionRest: string;
}

export const LETTERS: Record<string, Partial<Record<string, LetterStrings>>> = {
  olavita: {
    he: {
      subject: "אישור הזמנה {order}, תודה על הרכישה",
      greeting: "היי {name},",
      greetingNoName: "היי,",
      welcome: "כאן מוניק מצוות Olavita. קודם כול, ברכות על הבחירה שלך. זו אחת ההחלטות הטובות של השנה לטיפוח העור, ואנחנו שמחים מאוד על ההצטרפות שלך :)",
      received: "ההזמנה שלך התקבלה בהצלחה והצוות שלנו כבר מטפל בהכול. חשוב לנו שיהיה לך שקט כבר מההתחלה: אנחנו צוות אמיתי, אנשים שעוקבים אחרי כל שלב בהזמנה שלך.",
      orderLine: "הזמנה {order}, בוצעה ב-{date}",
      shipping: "משלוח",
      free: "חינם",
      totalPaid: "סה\"כ שולם",
      shipTo: "כתובת למשלוח:",
      delivery: "זמן ההכנה והמשלוח הוא עד 3 ימי עסקים. ברגע שההזמנה תישלח, יישלח אליך מייל עם קישור למעקב, כדי שיהיה אפשר לעקוב אחרי המשלוח עד הבית.",
      descriptorBold1: "החיוב עבור הרכישה שלך עשוי להופיע בפירוט האשראי בשם “SP OSTEOPURE”.",
      descriptorMid: " גם אם השם שונה מ-Olavita, אין סיבה לדאגה: ",
      descriptorBold2: "SP OSTEOPURE הוא תיאור החיוב הסטנדרטי של ספק התשלומים שלנו.",
      descriptorEnd: " אם השם הזה מופיע לצד סכום הרכישה שלך, זהו התשלום עבור הזמנת ה-Olavita שלך.",
      help: "אם עולה שאלה כלשהי לגבי ההזמנה, החיוב או המשלוח, אפשר לפנות אלינו לפני שדואגים. תודה רבה על האמון.",
      signoff: "באהבה,",
      signer: "מוניק",
      team: "צוות Olavita",
      cta: "לחצו כאן כדי לדבר איתנו",
      questionBold: "יש לך שאלה?",
      questionRest: " כדאי להכין את מספר ההזמנה לפני הפנייה אלינו. כך נוכל לאתר הכול מהר יותר.",
    },
    pt: {
      subject: "Pedido {order} confirmado, obrigada pela sua compra",
      greeting: "Oi, {name}!",
      greetingNoName: "Oi!",
      welcome: "Aqui é a Monique, da equipe Olavita. Antes de tudo, parabéns pela sua escolha. É uma das melhores decisões do ano para o cuidado da pele, e estamos muito felizes de ter você com a gente :)",
      received: "Seu pedido foi recebido com sucesso e a nossa equipe já está cuidando de tudo. Queremos que você tenha tranquilidade desde o começo: somos uma equipe de verdade, pessoas que acompanham cada etapa do seu pedido.",
      orderLine: "Pedido {order}, feito em {date}",
      shipping: "Frete",
      free: "Grátis",
      totalPaid: "Total pago",
      shipTo: "Entrega para:",
      delivery: "O prazo de preparação e envio é de até 3 dias úteis. Assim que o pedido sair, você recebe um e-mail com o link de rastreio para acompanhar até chegar na sua casa.",
      descriptorBold1: "A cobrança da sua compra pode aparecer na fatura com o nome “SP OSTEOPURE”.",
      descriptorMid: " Mesmo sendo um nome diferente de Olavita, não precisa se preocupar: ",
      descriptorBold2: "SP OSTEOPURE é a descrição padrão usada pelo nosso processador de pagamentos.",
      descriptorEnd: " Se esse nome aparecer ao lado do valor da sua compra, é o pagamento do seu pedido Olavita.",
      help: "Se surgir qualquer dúvida sobre o pedido, a cobrança ou a entrega, fale com a gente antes de se preocupar. Obrigada pela confiança.",
      signoff: "Com carinho,",
      signer: "Monique",
      team: "Equipe Olavita",
      cta: "Clique aqui para falar com a gente",
      questionBold: "Tem alguma dúvida?",
      questionRest: " Tenha o número do seu pedido em mãos ao falar com a gente. Assim conseguimos localizar tudo mais rápido.",
    },
  },
};

export function pickLetter(brand: string, lang: string): LetterStrings | null {
  const key = brand.toLowerCase().replace(/[^a-z]/g, "");
  const entry = Object.entries(LETTERS).find(([k]) => key.startsWith(k));
  return entry?.[1][lang] ?? null;
}
