import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryFlow, RecoveryStep, StepSendIf } from "@/lib/recovery/types";
import { OLAVITA_HE_CART_STEPS, OLAVITA_HE_WELCOME_STEPS } from "@/lib/recovery/seeds/olavita-he";

// Passos padrão da régua (o Ian edita depois no painel). Texto curto, tom de
// vendedora humana, uma pergunta por mensagem no WhatsApp, duas variantes por
// idioma (sorteada por envio pra não repetir texto). Hebraico escrito como
// israelense escreve, não tradução literal. Sem travessão em lugar nenhum.
//
// Dois fluxos:
//   carrinho    e-mail: 10 passos (8 do Klaviyo + 2 desligados de 40/50%);
//               WhatsApp: 5 passos.
//   pos_compra  e-mail: 7 passos de boas-vindas (o passo 1 explica o nome na
//               fatura; os passos 3 a 7 só saem com o pedido enviado).
// O hebraico dos e-mails vem de lib/recovery/seeds/olavita-he.ts (transcrito
// do Klaviyo); en, fr, bg, hu, ro, tr são versões curtas com o mesmo sentido.
//
// `pt` entra como REFERÊNCIA no WhatsApp (o painel mostra body_pt): o motor
// nunca escolhe pt pra cliente (pickLanguage ignora).
//
// Variáveis: {{nome}} {{produto}} {{itens}} {{valor}} {{link}} {{cupom}} {{desconto}} {{marca}} {{agente}}
// Só no pós-compra: {{pedido}} {{rastreio}} {{link_rastreio}}

export type Channel = "email" | "whatsapp";

export interface StepSeed {
  position: number;
  name: string;
  delay_minutes: number;
  only_if_no_reply: boolean;
  discount_percent: number | null;
  send_if: StepSendIf;
  subject: Record<string, string>;
  preview: Record<string, string>;
  button: Record<string, string>;
  body: Record<string, string | string[]>;
  enabled: boolean;
}

type StepSeedBase = Omit<StepSeed, "send_if" | "preview" | "button">;

const WHATSAPP: StepSeedBase[] = [
  {
    position: 1,
    name: "Primeiro contato",
    delay_minutes: 1,
    only_if_no_reply: true,
    discount_percent: null,
    enabled: true,
    subject: {},
    body: {
      pt: [
        "Oi {{nome}}! Aqui é {{agente}} da {{marca}}. Vi que você começou um pedido do {{produto}} e não finalizou. Aconteceu alguma coisa?",
        "Olá {{nome}}! {{agente}} da {{marca}} aqui. Notei que o seu pedido do {{produto}} ficou parado no meio. Posso te ajudar com alguma coisa?",
      ],
      he: [
        "היי {{nome}}, כאן {{agente}} מהצוות של {{marca}}. ראיתי שהתחלת הזמנה של {{produto}} ולא סיימת. קרה משהו?",
        "שלום {{nome}}, זאת {{agente}} מהצוות של {{marca}}. שמתי לב שההזמנה של {{produto}} נעצרה באמצע. אפשר לעזור במשהו?",
      ],
      en: [
        "Hi {{nome}}, this is {{agente}} from {{marca}}. I saw you started an order for {{produto}} but didn't finish it. Did something go wrong?",
        "Hello {{nome}}! {{agente}} from {{marca}} here. I noticed your {{produto}} order stopped halfway. Is there anything I can help you with?",
      ],
      fr: [
        "Bonjour {{nome}}, c'est {{agente}} de {{marca}}. J'ai vu que vous aviez commencé une commande de {{produto}} sans la finaliser. Il y a eu un souci ?",
        "Bonjour {{nome}} ! {{agente}}, de {{marca}}. Votre commande de {{produto}} s'est arrêtée en cours de route. Je peux vous aider pour quelque chose ?",
      ],
      bg: [
        "Здравей, {{nome}}! Аз съм {{agente}} от {{marca}}. Видях, че започна поръчка за {{produto}}, но не я завърши. Случи ли се нещо?",
        "Здравей, {{nome}}, {{agente}} от {{marca}} е. Забелязах, че поръчката ти за {{produto}} спря по средата. Мога ли да помогна с нещо?",
      ],
      hu: [
        "Szia {{nome}}! {{agente}} vagyok a {{marca}} csapatából. Láttam, hogy elkezdtél egy rendelést ({{produto}}), de nem fejezted be. Történt valami?",
        "Szia {{nome}}, itt {{agente}} a {{marca}} csapatából. Észrevettem, hogy a {{produto}} rendelésed félbemaradt. Segíthetek valamiben?",
      ],
      ro: [
        "Bună {{nome}}, sunt {{agente}} de la {{marca}}. Am văzut că ai început o comandă pentru {{produto}}, dar nu ai finalizat-o. S-a întâmplat ceva?",
        "Bună {{nome}}! {{agente}} de la {{marca}} aici. Am observat că comanda ta pentru {{produto}} s-a oprit la jumătate. Te pot ajuta cu ceva?",
      ],
      tr: [
        "Merhaba {{nome}}, ben {{agente}}, {{marca}} ekibinden. {{produto}} için bir sipariş başlatmışsınız ama tamamlanmamış. Bir sorun mu oldu?",
        "Merhaba {{nome}}! {{marca}} ekibinden {{agente}} ben. {{produto}} siparişinizin yarıda kaldığını gördüm. Yardımcı olabileceğim bir şey var mı?",
      ],
    },
  },
  {
    position: 2,
    name: "Link do carrinho",
    delay_minutes: 20,
    only_if_no_reply: true,
    discount_percent: null,
    enabled: true,
    subject: {},
    body: {
      pt: [
        "Se preferir, deixei o seu carrinho guardado aqui: {{link}} Qualquer dúvida é só me chamar.",
        "Guardei tudo para você, é só continuar daqui: {{link}} Se precisar de alguma coisa, estou por aqui.",
      ],
      he: [
        "אם נוח לך, שמרתי לך את העגלה כאן: {{link}} אם יש שאלה, אני כאן.",
        "שמרתי לך הכול, אפשר להמשיך מכאן: {{link}} אם צריך משהו, אני זמינה.",
      ],
      en: [
        "If it helps, I saved your cart here: {{link}} Just message me if you have any questions.",
        "I kept everything for you, you can pick up right here: {{link}} I'm here if you need anything.",
      ],
      fr: [
        "Si vous préférez, j'ai mis votre panier de côté ici : {{link}} N'hésitez pas si vous avez une question.",
        "J'ai tout gardé pour vous, vous pouvez reprendre ici : {{link}} Je reste disponible si besoin.",
      ],
      bg: [
        "Ако предпочиташ, запазих количката ти тук: {{link}} Ако имаш въпрос, просто ми пиши.",
        "Запазих всичко за теб, можеш да продължиш оттук: {{link}} Тук съм, ако ти трябва нещо.",
      ],
      hu: [
        "Ha úgy kényelmesebb, itt megőriztem a kosarad: {{link}} Ha bármi kérdésed van, csak írj.",
        "Mindent megőriztem neked, innen folytathatod: {{link}} Itt vagyok, ha bármire szükséged van.",
      ],
      ro: [
        "Dacă preferi, ți-am păstrat coșul aici: {{link}} Pentru orice întrebare, scrie-mi.",
        "Am păstrat totul pentru tine, poți continua de aici: {{link}} Sunt aici dacă ai nevoie de ceva.",
      ],
      tr: [
        "İsterseniz sepetinizi burada sakladım: {{link}} Bir sorunuz olursa yazmanız yeterli.",
        "Her şeyi sizin için sakladım, buradan devam edebilirsiniz: {{link}} Bir şeye ihtiyacınız olursa buradayım.",
      ],
    },
  },
  {
    position: 3,
    name: "Posso ajudar?",
    delay_minutes: 60,
    only_if_no_reply: true,
    discount_percent: null,
    enabled: true,
    subject: {},
    body: {
      pt: [
        "Posso te ajudar com alguma coisa, tipo prazo de entrega, pagamento ou dúvida sobre o {{produto}}?",
        "Ficou alguma dúvida sobre o {{produto}}, a entrega ou o pagamento? Me conta que eu te ajudo.",
      ],
      he: [
        "אפשר לעזור במשהו, למשל זמן משלוח, תשלום או שאלה על {{produto}}?",
        "נשארה שאלה על {{produto}}, על המשלוח או על התשלום? אשמח לעזור.",
      ],
      en: [
        "Is there anything I can help with, like delivery time, payment or a question about {{produto}}?",
        "Any questions left about {{produto}}, the delivery or the payment? Tell me and I'll help.",
      ],
      fr: [
        "Je peux vous aider sur quelque chose, par exemple le délai de livraison, le paiement ou une question sur {{produto}} ?",
        "Il vous reste une question sur {{produto}}, la livraison ou le paiement ? Dites-moi, je vous aide.",
      ],
      bg: [
        "Мога ли да помогна с нещо, например срок на доставка, плащане или въпрос за {{produto}}?",
        "Остана ли ти въпрос за {{produto}}, доставката или плащането? Пиши ми и ще помогна.",
      ],
      hu: [
        "Segíthetek valamiben, például szállítási idő, fizetés vagy kérdés a {{produto}} kapcsán?",
        "Maradt kérdésed a {{produto}} termékről, a szállításról vagy a fizetésről? Írd meg, és segítek.",
      ],
      ro: [
        "Te pot ajuta cu ceva, de exemplu termenul de livrare, plata sau o întrebare despre {{produto}}?",
        "Ai rămas cu vreo întrebare despre {{produto}}, livrare sau plată? Spune-mi și te ajut.",
      ],
      tr: [
        "Teslimat süresi, ödeme ya da {{produto}} hakkında bir soru gibi yardımcı olabileceğim bir konu var mı?",
        "{{produto}}, teslimat ya da ödeme hakkında aklınızda kalan bir soru var mı? Yazın, yardımcı olayım.",
      ],
    },
  },
  {
    position: 4,
    name: "Cupom 15%",
    delay_minutes: 24 * 60,
    only_if_no_reply: true,
    discount_percent: 15,
    enabled: true,
    subject: {},
    body: {
      pt: [
        "{{nome}}, consegui liberar {{desconto}} para você fechar hoje com o cupom {{cupom}}: {{link}}",
        "{{nome}}, falei com a equipe e consegui {{desconto}} de desconto para você. É só usar o cupom {{cupom}} aqui: {{link}}",
      ],
      he: [
        "{{nome}}, הצלחתי לשחרר לך {{desconto}} הנחה כדי לסגור היום עם הקוד {{cupom}}: {{link}}",
        "{{nome}}, דיברתי עם הצוות והשגתי לך {{desconto}} הנחה. פשוט להשתמש בקוד {{cupom}} כאן: {{link}}",
      ],
      en: [
        "{{nome}}, I managed to get you {{desconto}} off to complete your order today with the code {{cupom}}: {{link}}",
        "{{nome}}, I spoke with the team and got you {{desconto}} off. Just use the code {{cupom}} here: {{link}}",
      ],
      fr: [
        "{{nome}}, j'ai pu vous obtenir {{desconto}} de réduction pour finaliser aujourd'hui avec le code {{cupom}} : {{link}}",
        "{{nome}}, j'ai vu avec l'équipe et je vous ai obtenu {{desconto}} de réduction. Il suffit d'utiliser le code {{cupom}} ici : {{link}}",
      ],
      bg: [
        "{{nome}}, успях да ти осигуря {{desconto}} отстъпка, за да завършиш днес с кода {{cupom}}: {{link}}",
        "{{nome}}, говорих с екипа и ти издействах {{desconto}} отстъпка. Просто използвай кода {{cupom}} тук: {{link}}",
      ],
      hu: [
        "{{nome}}, sikerült {{desconto}} kedvezményt szereznem neked, hogy ma le tudd zárni a {{cupom}} kóddal: {{link}}",
        "{{nome}}, beszéltem a csapattal, és {{desconto}} kedvezményt kaptál. Csak használd a {{cupom}} kódot itt: {{link}}",
      ],
      ro: [
        "{{nome}}, am reușit să îți obțin {{desconto}} reducere ca să finalizezi azi cu codul {{cupom}}: {{link}}",
        "{{nome}}, am vorbit cu echipa și ți-am obținut {{desconto}} reducere. Folosește codul {{cupom}} aici: {{link}}",
      ],
      tr: [
        "{{nome}}, bugün tamamlamanız için {{cupom}} koduyla size {{desconto}} indirim ayarlayabildim: {{link}}",
        "{{nome}}, ekiple konuştum ve size {{desconto}} indirim aldım. {{cupom}} kodunu burada kullanmanız yeterli: {{link}}",
      ],
    },
  },
  {
    position: 5,
    name: "Última chance 30%",
    delay_minutes: 3 * 24 * 60,
    only_if_no_reply: true,
    discount_percent: 30,
    enabled: true,
    subject: {},
    body: {
      pt: [
        "{{nome}}, essa é a minha última mensagem sobre o seu pedido: consegui {{desconto}} com o cupom {{cupom}}, é o melhor que eu posso fazer. Se quiser aproveitar: {{link}}",
        "{{nome}}, antes de encerrar por aqui: liberei {{desconto}} de desconto com o cupom {{cupom}}, válido só por pouco tempo. {{link}}",
      ],
      he: [
        "{{nome}}, זאת ההודעה האחרונה שלי לגבי ההזמנה: השגתי לך {{desconto}} הנחה עם הקוד {{cupom}}, זה הכי הרבה שאני יכולה. אם מתאים: {{link}}",
        "{{nome}}, לפני שאני סוגרת את הנושא: פתחתי לך {{desconto}} הנחה עם הקוד {{cupom}}, לזמן קצר בלבד. {{link}}",
      ],
      en: [
        "{{nome}}, this is my last message about your order: I got you {{desconto}} off with the code {{cupom}}, that's the best I can do. If you'd like to use it: {{link}}",
        "{{nome}}, before I close this: I unlocked {{desconto}} off with the code {{cupom}}, for a short time only. {{link}}",
      ],
      fr: [
        "{{nome}}, c'est mon dernier message au sujet de votre commande : j'ai obtenu {{desconto}} de réduction avec le code {{cupom}}, c'est le maximum possible. Si cela vous intéresse : {{link}}",
        "{{nome}}, avant de clore de mon côté : j'ai débloqué {{desconto}} de réduction avec le code {{cupom}}, pour peu de temps. {{link}}",
      ],
      bg: [
        "{{nome}}, това е последното ми съобщение за поръчката ти: осигурих ти {{desconto}} отстъпка с кода {{cupom}}, повече не мога. Ако искаш да се възползваш: {{link}}",
        "{{nome}}, преди да приключа от моя страна: отключих {{desconto}} отстъпка с кода {{cupom}}, само за кратко. {{link}}",
      ],
      hu: [
        "{{nome}}, ez az utolsó üzenetem a rendeléseddel kapcsolatban: {{desconto}} kedvezményt szereztem a {{cupom}} kóddal, ennél többet nem tudok adni. Ha élnél vele: {{link}}",
        "{{nome}}, mielőtt lezárom a részemről: {{desconto}} kedvezményt nyitottam meg a {{cupom}} kóddal, csak rövid ideig. {{link}}",
      ],
      ro: [
        "{{nome}}, acesta este ultimul meu mesaj despre comanda ta: am obținut {{desconto}} reducere cu codul {{cupom}}, mai mult nu pot. Dacă vrei să profiți: {{link}}",
        "{{nome}}, înainte să închid subiectul: am deblocat {{desconto}} reducere cu codul {{cupom}}, doar pentru scurt timp. {{link}}",
      ],
      tr: [
        "{{nome}}, siparişinizle ilgili son mesajım: {{cupom}} koduyla size {{desconto}} indirim aldım, yapabileceğimin en iyisi bu. Kullanmak isterseniz: {{link}}",
        "{{nome}}, konuyu kapatmadan önce: {{cupom}} koduyla {{desconto}} indirim açtım, kısa süreliğine. {{link}}",
      ],
    },
  },
];

// --- E-mail: versões curtas por idioma ----------------------------------------
// O hebraico vem do seed do Klaviyo; aqui ficam os outros seis idiomas. Cada
// pacote tem os 10 passos do carrinho e os 7 do pós-compra (índice = posição - 1).

type Lang = "en" | "fr" | "bg" | "hu" | "ro" | "tr";
interface Txt { subject: string; preview?: string; button: string; body: string }
interface Pack { cart: Txt[]; welcome: Txt[] }

const EN: Pack = (() => {
  const L = {
    b1: "I want to say goodbye to wrinkles",
    bSave: "Complete my order and save {{desconto}}",
    bNow: "Complete my order now",
    b1d: "I want to say goodbye to wrinkles ({{desconto}} off)",
    b1w: "I want to say goodbye to wrinkles with {{desconto}} off",
    bWith: "Complete my order with {{desconto}} off",
    talk: "Click here to talk to us",
  };
  const S = "With love,\n{{agente}}, {{marca}} team";
  const W = "Warmly,\n{{agente}}\n{{marca}} team";
  const Q = "Have a question? Include your order number ({{pedido}}) when you contact us, so we can find everything faster.";
  const QI = "Important: if you need to talk to us, have your order number ({{pedido}}) ready.";
  const T = "Tracking code: {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 A message from {{agente}}, at {{marca}}", preview: "A quick question...", button: L.b1, body: `Hi {{nome}},

This is {{agente}} from {{marca}}. I'm writing because I saw your order wasn't completed and I wanted to make sure you have no questions left. You got all the way to the last step, so I didn't want your cart to just disappear without talking to you first.

Your order is still saved exactly as you left it. If something got stuck, or you'd like help to continue, just reply to this email. There is a real team on the other side and I'll do everything I can to help.

If you'd rather pick up where you stopped, here is the link:

{{link}}

${S}` },
      { subject: "🎁 Complete your order with {{desconto}} off", preview: "I probably wasn't supposed to approve this, but...", button: L.b1, body: `Hi {{nome}},

After my last message I kept thinking about your order and made a decision my finance team won't love: I approved {{desconto}} off, just for you.

This isn't a regular promotion and you won't find it on any banner on the site. It exists because I don't want the price to be the reason you close the page and keep worrying about the same lines, the loss of firmness or the thin, crepey skin that brought you to {{marca}} in the first place.

Your order is still saved and the discount is already active with the code {{cupom}}.

{{link}}

${S}` },
      { subject: "I approved a discount for you 🎁", preview: "The discount, {{marca}} and everything else worth knowing.", button: L.bSave, body: `Hi {{nome}},

Your {{marca}} order is still saved and your exclusive {{desconto}} discount is still active (code {{cupom}}). It just won't stay available forever.

What is inside {{marca}}? A complex of 7 peptides that work on several fronts to help improve the appearance of lines, wrinkles, loss of firmness and crepey texture, on the face, neck, décolleté and arms.

Will it work if my skin is already very wrinkled? The formula was not made only for the first lines. It was developed to act on the appearance of thinner, looser, wrinkled skin too. Every skin responds at its own pace, and many people start noticing a difference in texture and firmness in the first weeks of consistent use.

Your order is still saved, but time is running out.

{{link}}

${S}` },
      { subject: "This is your last chance ⚠️", preview: "The last chance before the discount disappears.", button: L.bNow, body: `Hi {{nome}},

I'll be short and direct. Your {{desconto}} discount ends today. After that I can't promise it will still be available, and I won't write again asking you to use the same terms.

If you have any question about {{marca}} or your order, just reply to this email and someone from our team will talk to you personally.

But if the only thing holding you back is that familiar hesitation, let me ask you one thing: what exactly are you waiting for that hasn't already happened in the past weeks? The wrinkles are still there, and your skin won't get firmer just because you decided to wait.

If you want to complete your order now, just click here:

{{link}}

${S}

P.S. Don't let the price be the reason you keep postponing this. Your code is {{cupom}}.` },
      { subject: "That moment in front of the mirror... 😳", preview: "When you realize your skin changed faster than you did.", button: L.b1d, body: `Hi {{nome}},

Has it ever happened that you looked in the mirror for a few seconds and felt the picture didn't match how you feel inside? Maybe it's the looser skin on the neck, the lines around the mouth, or arms that make you think twice before wearing a sleeveless top.

These changes do more than change how skin looks. They affect your confidence. And you don't have to accept them as something to put up with after a certain age.

{{marca}} was created to help you feel comfortable in your own skin again: smoother-looking skin, more firmness where you notice age the most, and more confidence to stop hiding.

Your {{desconto}} discount is still active (code {{cupom}}).

{{link}}

${S}` },
      { subject: "This isn't just talk: stock is running low ⚠️", preview: "Your order is still saved, but I don't know for how long.", button: L.b1d, body: `Hi {{nome}},

The problem with the signs of aging is that they don't stop just because we decide to wait. Natural collagen production changes over time, and loss of firmness starts to show in places you never noticed before.

Where will you be a year from now if you keep doing exactly the same? This time I need to be direct: your order is still saved, but our current stock is genuinely low. Demand grew faster than we expected, and I can't promise your saved order will stay available for many more days.

The question is no longer "maybe later?" but "will I use the chance while my order is still saved?".

Your {{desconto}} discount is still active (code {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) A few cancellations freed up stock", preview: "I managed to release a few units and increased your discount.", button: L.b1w, body: `Hi {{nome}},

I didn't expect to write to you again so soon, but something happened. A few orders were cancelled in the last hours, which freed a small number of {{marca}} units that were already reserved.

Since your order is still on our list, I wanted to give you priority on these units before offering them to someone else. To thank you for your patience, I increased your discount:

{{desconto}} off with the code {{cupom}}

It's a bigger discount, but it will also be available for a shorter time, because these units probably won't stay in stock for long.

{{link}}

${S}` },
      { subject: "({{desconto}}) A final personal message ⚠️", preview: "I didn't want to end this without talking to you one last time.", button: L.b1, body: `Hi {{nome}},

I didn't want to close your order without writing to you one last time, personally. A few days ago you started a {{marca}} order and for some reason it wasn't completed. I don't know what made you stop. Maybe it wasn't the right time, maybe a question was left, or maybe you just wanted to think about it. That's okay.

But if the wrinkles, the loss of firmness or the thinner skin still bother you, you don't have to keep choosing clothes by what you need to hide, and you don't have to wait for the signs to become more visible before you start taking care of them.

Our stock from this batch is really coming to an end, and I don't know when we can offer these terms again. This is the last personal message I'll write about this order, so I left you the biggest discount we've offered in this sequence:

{{desconto}} off with the code {{cupom}}

I hope you'll look in the mirror and feel beautiful, confident and comfortable in your skin.

{{link}}

${S}` },
      { subject: "({{desconto}}) I wasn't planning to write again", button: L.bWith, body: `Hi {{nome}},

I wasn't planning to write again, but I got an exceptional approval and I can't keep it to myself: {{desconto}} off the order you saved, with the code {{cupom}}. It's the furthest we have ever gone, and it is valid for a few days only.

If the wrinkles and the loss of firmness still bother you, this is the best chance you'll have to start.

{{link}}

${S}` },
      { subject: "({{desconto}}) The last time, really", button: L.bNow, body: `Hi {{nome}},

This is truly my last message. I left you {{desconto}} off with the code {{cupom}}, half the price, so the price isn't the reason you keep postponing. The code stops working in 24 hours and won't come back.

I sincerely hope you give yourself this chance.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "Congratulations on your first {{marca}} purchase 🎉", preview: "Your order is confirmed. Here is also important information about the charge.", button: L.talk, body: `Hi {{nome}}!

This is {{agente}} from the {{marca}} team. First of all, congratulations on your choice. We're very happy to have you with us :)

Your order was received and our team is already taking care of everything. You can relax from the start: we are a real team, with people who follow every step of your order and work every day to give you the best experience possible.

Our preparation time is up to 3 business days, and we do everything we can to send your {{marca}} out as soon as possible. As soon as it ships, you'll get an email with a tracking link so you can follow the delivery to your home.

One important thing, to avoid any worry when you look at your card statement: the charge may appear as "SP OSTEOPURE". Even though the name is different from {{marca}}, there is nothing to worry about. SP OSTEOPURE is the standard billing descriptor our payment provider uses to process some transactions. If you see it next to the amount of your purchase, it is the payment for your {{marca}} order.

If you have any question about your order, the charge or the shipping, write to us before you worry. A real human team is here to check everything and help.

${W}

${Q}` },
      { subject: "We're taking care of your order here 💚", preview: "Just wanting to reassure you and keep everything clear from the start.", button: L.talk, body: `Hi {{nome}}!

{{agente}} here again :) I just wanted to reassure you that everything is fine with your order and that our team keeps following every step.

We know that after a purchase it's natural to want to know everything is moving as it should. That's why we want you to stay calm and informed until your {{marca}} reaches your home.

If any question comes up about the order, the payment or the shipping, contact us. A real human team is here to check everything and help as fast as possible.

Thank you again for your trust. We're taking care of everything here.

${W}

${Q}` },
      { subject: "Your {{marca}} is on its way! 📦", preview: "Your order has shipped and now you can follow the delivery.", button: L.talk, body: `Hi {{nome}}!

Good news: your {{produto}} is ready and has already shipped! It is officially on its way to your home :)

Estimated delivery time is on average 9 to 12 business days after shipping. From here, the package travels through the network of the carrier and the postal services responsible for your area. We can't control every step of the delivery, but we keep following everything on our side.

${T}

If you have any question about the shipping or about adding the cream to your routine, contact us. We're as excited as you are that this little package will finally reach you :)

${W}

${Q}` },
      { subject: "Important update about your order", preview: "We saw a small change in the shipment and wanted to update you.", button: L.talk, body: `Hi {{nome}}!

I wanted to update you because we noticed a change in the shipping status of your order, and we preferred to tell you before you start to worry. The postal service responsible for your area is running a bit slower this week, so your {{marca}} may take a few more days to arrive.

But you can relax: your order is safe and keeps moving as usual. Our team follows the movement and checks the updates so the package reaches you as quickly as possible.

I know it's frustrating to wait when you're excited to start using {{marca}}, so we wanted to be transparent and keep you informed. If you have any question about the shipping, just contact us. We're here to help.

Thank you very much for your patience.

${S}

${QI}` },
      { subject: "We're following your {{marca}} closely 💚", preview: "Just updating you on the progress of your shipment.", button: L.talk, body: `Hi {{nome}}!

A short extra update about your {{marca}}. We know you're probably counting the days until you get the cream and start your routine, so our team keeps following the shipment closely.

Your order keeps moving through the distribution network and we check the updates with the parties responsible for delivery. We've also asked for extra attention to the shipment, to avoid any unnecessary delay.

Right now, everything is fine with your package. You can keep following the updates through your tracking link, and we'll keep following until it reaches you.

${T}

Thank you again for your trust and patience :)

${W}

${QI}` },
      { subject: "Good news: your {{marca}} is getting closer!", preview: "Your order moved one more step and is in the final stretch.", button: L.talk, body: `Hi {{nome}}!

Great news: your order moved one more step and keeps getting closer to you :) The package is in the final stretch of the shipment, and we hope it will soon be released for delivery to your address.

Our team keeps following the updates, and you can also check the latest movements directly through your tracking link. After all this waiting, very little is left until you receive your {{produto}} and start your skincare routine.

${T}

Once it arrives, if you want to ask anything about how to use the cream, just contact us. We're here.

${S}

${Q}` },
      { subject: "Just a little left until your {{marca}} arrives 💚", preview: "Your order is in the last stages before reaching your home.", button: L.talk, body: `Hi {{nome}}!

Now there's just a little left :) Your {{produto}} is getting very close to your home, and we're following this last stage with you.

It's worth paying attention to the courier and to the updates in your tracking. Your package is going through the final sorting and distribution steps in your area, so delivery is getting close.

If it doesn't arrive today, there's no need to worry. Depending on the postal activity in your area, this final step may vary by a few days. We'll keep following until your order arrives safely.

${T}

Thank you for all your patience through this process. We're very happy you chose {{marca}} and can't wait for you to start your routine with {{produto}}.

${W}

${Q}` },
    ],
  };
})();

const FR: Pack = (() => {
  const L = {
    b1: "Je veux dire adieu aux rides",
    bSave: "Finaliser ma commande et économiser {{desconto}}",
    bNow: "Finaliser ma commande maintenant",
    b1d: "Je veux dire adieu aux rides ({{desconto}} de réduction)",
    b1w: "Je veux dire adieu aux rides avec {{desconto}} de réduction",
    bWith: "Finaliser ma commande avec {{desconto}} de réduction",
    talk: "Cliquez ici pour nous parler",
  };
  const S = "Chaleureusement,\n{{agente}}, équipe {{marca}}";
  const W = "Bien cordialement,\n{{agente}}\nÉquipe {{marca}}";
  const Q = "Une question ? Indiquez votre numéro de commande ({{pedido}}) quand vous nous contactez, nous retrouverons tout plus vite.";
  const QI = "Important : si vous avez besoin de nous parler, gardez votre numéro de commande ({{pedido}}) à portée de main.";
  const T = "Numéro de suivi : {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 Un message de {{agente}}, de {{marca}}", preview: "Une petite question...", button: L.b1, body: `Bonjour {{nome}},

C'est {{agente}}, de {{marca}}. Je reviens vers vous parce que j'ai vu que votre commande n'était pas terminée et je voulais m'assurer qu'il ne vous reste aucune question. Vous avez atteint la dernière étape, et je ne voulais pas laisser votre panier disparaître sans vous parler d'abord.

Votre commande est toujours gardée exactement comme vous l'avez laissée. Si quelque chose a bloqué, ou si vous souhaitez de l'aide pour continuer, répondez simplement à cet e-mail. Il y a une vraie équipe de l'autre côté et je ferai tout pour vous aider.

Si vous préférez reprendre votre commande là où elle s'est arrêtée, voici le lien :

{{link}}

${S}` },
      { subject: "🎁 Finalisez votre commande avec {{desconto}} de réduction", preview: "Je n'aurais sans doute pas dû valider ça, mais...", button: L.b1, body: `Bonjour {{nome}},

Après mon dernier message, j'ai continué à penser à votre commande et j'ai pris une décision que mon équipe financière n'appréciera pas trop : j'ai validé {{desconto}} de réduction, rien que pour vous.

Ce n'est pas une promotion classique et vous ne la trouverez sur aucune bannière du site. Elle existe parce que je ne veux pas que le prix soit la raison pour laquelle vous fermez la page et restez préoccupée par les mêmes rides, le relâchement ou la peau fine et crêpée qui vous ont amenée vers {{marca}}.

Votre commande est toujours gardée et la réduction est déjà active avec le code {{cupom}}.

{{link}}

${S}` },
      { subject: "Je vous ai validé une réduction 🎁", preview: "La réduction, {{marca}} et tout ce qui vaut la peine d'être su.", button: L.bSave, body: `Bonjour {{nome}},

Votre commande {{marca}} est toujours gardée et votre réduction exclusive de {{desconto}} est toujours active (code {{cupom}}). Mais elle ne restera pas disponible éternellement.

Que contient {{marca}} ? Un complexe de 7 peptides qui agissent sur plusieurs fronts pour aider à améliorer l'aspect des rides, du relâchement et de la peau crêpée, sur le visage, le cou, le décolleté et les bras.

Est-ce que cela convient si ma peau est déjà très marquée ? La formule n'a pas été pensée seulement pour les premières rides : elle a été développée pour agir aussi sur l'aspect d'une peau plus fine, plus relâchée et ridée. Chaque peau réagit à son rythme, et beaucoup de personnes remarquent une différence de texture et de fermeté dès les premières semaines d'utilisation régulière.

Votre commande est gardée, mais le temps file.

{{link}}

${S}` },
      { subject: "C'est votre dernière chance ⚠️", preview: "La dernière chance avant que la réduction disparaisse.", button: L.bNow, body: `Bonjour {{nome}},

Je serai brève et directe. Votre réduction de {{desconto}} se termine aujourd'hui. Après cela, je ne peux pas promettre qu'elle sera encore disponible, et je ne vous écrirai pas à nouveau pour vous proposer les mêmes conditions.

Si vous avez la moindre question sur {{marca}} ou sur votre commande, répondez simplement à cet e-mail et quelqu'un de notre équipe vous parlera personnellement.

Mais si la seule chose qui vous retient est cette hésitation bien connue, laissez-moi vous poser une question : qu'attendez-vous exactement qui ne soit pas déjà arrivé ces dernières semaines ? Les rides sont toujours là, et votre peau ne sera pas plus ferme simplement parce que vous avez décidé d'attendre.

Si vous voulez finaliser votre commande maintenant, cliquez ici :

{{link}}

${S}

P.S. Ne laissez pas le prix être la raison de ce report. Votre code : {{cupom}}.` },
      { subject: "Ce moment devant le miroir... 😳", preview: "Quand on réalise que sa peau a changé plus vite que soi.", button: L.b1d, body: `Bonjour {{nome}},

Vous est-il déjà arrivé de vous regarder dans le miroir quelques secondes et d'avoir l'impression que l'image ne correspond pas à ce que vous ressentez à l'intérieur ? Peut-être la peau plus relâchée du cou, les rides autour de la bouche, ou des bras qui vous font hésiter avant de mettre un haut sans manches.

Ces changements font plus que modifier l'aspect de la peau. Ils touchent la confiance en soi. Et il n'y a aucune raison de les accepter comme une fatalité après un certain âge.

{{marca}} a été créée pour vous aider à vous sentir de nouveau bien dans votre peau : une peau à l'aspect plus lisse, plus de fermeté là où l'âge se voit le plus, et plus de confiance pour arrêter de vous cacher.

Votre réduction de {{desconto}} est toujours active (code {{cupom}}).

{{link}}

${S}` },
      { subject: "Ce n'est pas une phrase en l'air : le stock baisse ⚠️", preview: "Votre commande est gardée, mais je ne sais pas pour combien de temps.", button: L.b1d, body: `Bonjour {{nome}},

Le problème avec les signes de l'âge, c'est qu'ils ne s'arrêtent pas parce que nous décidons d'attendre. La production naturelle de collagène change avec le temps, et le relâchement commence à apparaître à des endroits où vous ne l'aviez jamais remarqué.

Où en serez-vous dans un an si vous continuez exactement comme maintenant ? Cette fois, je dois être directe : votre commande est gardée, mais notre stock actuel est vraiment bas. La demande a augmenté plus vite que prévu, et je ne peux pas garantir que votre commande restera disponible encore beaucoup de jours.

La question n'est plus « peut-être plus tard ? » mais « vais-je saisir l'occasion tant que ma commande est encore gardée ? ».

Votre réduction de {{desconto}} est toujours active (code {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) Des annulations ont libéré du stock", preview: "J'ai pu libérer quelques unités et augmenter votre réduction.", button: L.b1w, body: `Bonjour {{nome}},

Je ne pensais pas vous écrire de nouveau si vite, mais il s'est passé quelque chose. Quelques commandes ont été annulées ces dernières heures, ce qui a libéré un petit nombre d'unités {{marca}} déjà réservées.

Comme votre commande est toujours sur notre liste, j'ai voulu vous donner la priorité sur ces unités avant de les proposer à quelqu'un d'autre. Pour vous remercier de votre patience, j'ai augmenté votre réduction :

{{desconto}} de réduction avec le code {{cupom}}

C'est une réduction plus grande, mais elle sera aussi disponible moins longtemps, car ces unités ne resteront probablement pas longtemps en stock.

{{link}}

${S}` },
      { subject: "({{desconto}}) Un dernier message personnel ⚠️", preview: "Je ne voulais pas terminer sans vous parler une dernière fois.", button: L.b1, body: `Bonjour {{nome}},

Je ne voulais pas clôturer votre commande sans vous écrire une dernière fois, personnellement. Il y a quelques jours, vous avez commencé une commande {{marca}} et, pour une raison quelconque, elle n'a pas été finalisée. Je ne sais pas ce qui vous a arrêtée. Ce n'était peut-être pas le bon moment, il restait peut-être une question, ou vous vouliez simplement réfléchir. Ce n'est pas grave.

Mais si les rides, le relâchement ou la peau plus fine vous gênent encore, vous n'avez pas à continuer de choisir vos vêtements selon ce qu'il faut cacher, ni à attendre que les signes deviennent plus visibles pour enfin vous en occuper.

Notre stock de ce lot touche vraiment à sa fin, et je ne sais pas quand nous pourrons proposer de nouveau ces conditions. C'est le dernier message personnel que je vous écris à propos de cette commande, alors je vous ai laissé la plus grande réduction proposée dans cette série :

{{desconto}} de réduction avec le code {{cupom}}

J'espère que vous vous regarderez dans le miroir en vous sentant belle, sûre de vous et bien dans votre peau.

{{link}}

${S}` },
      { subject: "({{desconto}}) Je ne comptais pas vous réécrire", button: L.bWith, body: `Bonjour {{nome}},

Je ne comptais pas vous écrire de nouveau, mais j'ai obtenu une validation exceptionnelle et je ne peux pas la garder pour moi : {{desconto}} de réduction sur la commande que vous avez gardée, avec le code {{cupom}}. C'est le plus loin que nous soyons jamais allés, et c'est valable quelques jours seulement.

Si les rides et le relâchement vous gênent encore, c'est la meilleure occasion que vous aurez de commencer.

{{link}}

${S}` },
      { subject: "({{desconto}}) La dernière fois, vraiment", button: L.bNow, body: `Bonjour {{nome}},

C'est vraiment mon dernier message. Je vous ai laissé {{desconto}} de réduction avec le code {{cupom}}, la moitié du prix, pour que le prix ne soit pas la raison de ce report. Le code cesse de fonctionner dans 24 heures et ne reviendra pas.

J'espère sincèrement que vous vous offrirez cette chance.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "Félicitations pour votre première commande {{marca}} 🎉", preview: "Votre commande est confirmée. Voici aussi une information importante sur le débit.", button: L.talk, body: `Bonjour {{nome}} !

C'est {{agente}}, de l'équipe {{marca}}. Tout d'abord, félicitations pour votre choix. Nous sommes très heureux de vous compter parmi nous :)

Votre commande a bien été reçue et notre équipe s'occupe déjà de tout. Vous pouvez être rassurée dès maintenant : nous sommes une vraie équipe, avec des personnes qui suivent chaque étape de votre commande et qui travaillent chaque jour pour vous offrir la meilleure expérience possible.

Notre délai de préparation est de 3 jours ouvrés maximum, et nous faisons tout pour que votre {{marca}} parte le plus vite possible. Dès l'expédition, vous recevrez un e-mail avec un lien de suivi pour suivre la livraison jusqu'à chez vous.

Une information importante, pour éviter toute inquiétude en regardant votre relevé bancaire : le débit peut apparaître sous le nom « SP OSTEOPURE ». Même si ce nom est différent de {{marca}}, il n'y a aucune raison de s'inquiéter. SP OSTEOPURE est le libellé standard utilisé par notre prestataire de paiement pour traiter certaines transactions. Si vous le voyez à côté du montant de votre achat, il s'agit bien du paiement de votre commande {{marca}}.

Si vous avez une question sur votre commande, le débit ou l'expédition, écrivez-nous avant de vous inquiéter. Une vraie équipe humaine est là pour tout vérifier et vous aider.

${W}

${Q}` },
      { subject: "Nous nous occupons de votre commande 💚", preview: "Juste pour vous rassurer et que tout soit clair dès le début.", button: L.talk, body: `Bonjour {{nome}} !

C'est encore {{agente}} :) Je voulais simplement vous confirmer que tout va bien avec votre commande et que notre équipe continue de suivre chaque étape.

Nous savons qu'après un achat, il est naturel de vouloir être sûr que tout avance comme il faut. C'est pourquoi nous tenons à ce que vous restiez sereine et informée jusqu'à ce que votre {{marca}} arrive chez vous.

Si une question se présente sur la commande, le paiement ou l'expédition, contactez-nous. Une vraie équipe humaine est là pour tout vérifier et vous aider le plus vite possible.

Merci encore pour votre confiance. Nous nous occupons de tout.

${W}

${Q}` },
      { subject: "Votre {{marca}} est en route ! 📦", preview: "Votre commande a été expédiée et vous pouvez maintenant suivre la livraison.", button: L.talk, body: `Bonjour {{nome}} !

Bonne nouvelle : votre {{produto}} est prêt et a déjà été expédié ! Il est officiellement en route vers chez vous :)

Le délai de livraison estimé est en moyenne de 9 à 12 jours ouvrés après l'expédition. À partir de maintenant, le colis circule dans le réseau du transporteur et des services postaux responsables de votre région. Nous ne pouvons pas contrôler chaque étape de la livraison, mais nous continuons de tout suivre de notre côté.

${T}

Si vous avez une question sur l'expédition ou sur la façon d'intégrer la crème à votre routine, contactez-nous. Nous sommes aussi impatients que vous de voir ce petit colis arriver :)

${W}

${Q}` },
      { subject: "Information importante sur votre commande", preview: "Nous avons vu un petit changement dans l'expédition et voulions vous tenir informée.", button: L.talk, body: `Bonjour {{nome}} !

Je voulais vous tenir informée car nous avons remarqué un changement dans l'état de l'expédition de votre commande, et nous avons préféré vous prévenir avant que vous ne vous inquiétiez. Le service postal responsable de votre région fonctionne un peu plus lentement cette semaine, il est donc possible que votre {{marca}} mette quelques jours de plus à arriver.

Mais vous pouvez être tranquille : votre commande est en sécurité et continue d'avancer normalement. Notre équipe suit les mouvements et vérifie les mises à jour pour que le colis vous parvienne le plus vite possible.

Je sais qu'il est frustrant d'attendre quand on a hâte de commencer à utiliser {{marca}}, alors nous voulions être transparents et vous garder informée. Si vous avez une question sur l'expédition, contactez-nous. Nous sommes là pour vous aider.

Merci beaucoup pour votre patience.

${S}

${QI}` },
      { subject: "Nous suivons de près votre {{marca}} 💚", preview: "Juste une mise à jour sur l'avancement de votre expédition.", button: L.talk, body: `Bonjour {{nome}} !

Une petite mise à jour supplémentaire sur votre {{marca}}. Nous savons que vous comptez sans doute les jours avant de recevoir la crème et de commencer votre routine, alors notre équipe continue de suivre l'expédition de près.

Votre commande continue d'avancer dans le réseau de distribution et nous vérifions les mises à jour auprès des acteurs responsables de la livraison. Nous avons aussi demandé une attention particulière pour ce colis, afin d'éviter tout retard inutile.

Pour l'instant, tout va bien avec votre colis. Vous pouvez suivre les prochaines mises à jour avec votre lien de suivi, et nous continuerons de suivre jusqu'à ce qu'il arrive chez vous.

${T}

Merci encore pour votre confiance et votre patience :)

${W}

${QI}` },
      { subject: "Bonne nouvelle : votre {{marca}} se rapproche !", preview: "Votre commande a franchi une nouvelle étape et approche de la dernière ligne droite.", button: L.talk, body: `Bonjour {{nome}} !

Excellente nouvelle : votre commande a franchi une nouvelle étape et se rapproche de vous :) Le colis est dans la dernière ligne droite de l'expédition, et nous espérons qu'il sera bientôt remis pour livraison à votre adresse.

Notre équipe continue de suivre les mises à jour, et vous pouvez aussi consulter les derniers mouvements directement avec votre lien de suivi. Après toute cette attente, il reste très peu de temps avant de recevoir votre {{produto}} et de commencer votre routine de soin.

${T}

Une fois qu'il sera arrivé, si vous voulez poser une question sur l'utilisation de la crème, contactez-nous. Nous sommes là.

${S}

${Q}` },
      { subject: "Il ne reste plus grand-chose avant l'arrivée de votre {{marca}} 💚", preview: "Votre commande est dans les dernières étapes avant d'arriver chez vous.", button: L.talk, body: `Bonjour {{nome}} !

Il ne reste plus grand-chose :) Votre {{produto}} se rapproche vraiment de chez vous, et nous suivons cette dernière étape avec vous.

Il est utile de rester attentive au passage du livreur et aux mises à jour de votre suivi. Votre colis passe par les dernières étapes de tri et de distribution dans votre région, la livraison approche donc.

S'il n'arrive pas aujourd'hui, ne vous inquiétez pas. Selon l'activité postale dans votre région, cette dernière étape peut varier de quelques jours. Nous continuerons de suivre jusqu'à ce que votre commande arrive en toute sécurité.

${T}

Merci pour toute votre patience pendant ce processus. Nous sommes très heureux que vous ayez choisi {{marca}} et nous avons hâte que vous commenciez votre routine avec {{produto}}.

${W}

${Q}` },
    ],
  };
})();

const BG: Pack = (() => {
  const L = {
    b1: "Искам да кажа сбогом на бръчките",
    bSave: "Завърши поръчката и спести {{desconto}}",
    bNow: "Завърши поръчката сега",
    b1d: "Искам да кажа сбогом на бръчките ({{desconto}} отстъпка)",
    b1w: "Искам да кажа сбогом на бръчките с {{desconto}} отстъпка",
    bWith: "Завърши поръчката с {{desconto}} отстъпка",
    talk: "Натисни тук, за да говорим",
  };
  const S = "С обич,\n{{agente}}, екипът на {{marca}}";
  const W = "Сърдечно,\n{{agente}}\nЕкипът на {{marca}}";
  const Q = "Имаш въпрос? Посочи номера на поръчката си ({{pedido}}), когато се свържеш с нас, за да намерим всичко по-бързо.";
  const QI = "Важно: ако искаш да говориш с нас, подготви номера на поръчката си ({{pedido}}).";
  const T = "Номер за проследяване: {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 Съобщение от {{agente}}, от {{marca}}", preview: "Един кратък въпрос...", button: L.b1, body: `Здравей, {{nome}},

Аз съм {{agente}} от {{marca}}. Пиша ти, защото видях, че поръчката ти още не е завършена, и исках да се уверя, че не са останали въпроси. Стигна до последната стъпка и не исках количката ти просто да изчезне, без първо да поговоря с теб.

Поръчката ти все още е запазена точно както я остави. Ако нещо е спряло, ако имаш въпрос или просто искаш помощ да продължиш, отговори на този имейл. От другата страна има истински екип и ще направя всичко възможно да помогна.

Ако предпочиташ да продължиш оттам, откъдето си спряла, ето връзката:

{{link}}

${S}` },
      { subject: "🎁 Завърши поръчката си с {{desconto}} отстъпка", preview: "Вероятно не трябваше да одобрявам това, но...", button: L.b1, body: `Здравей, {{nome}},

След последното ми съобщение продължих да мисля за поръчката ти и взех решение, което финансовият ми екип едва ли ще хареса: одобрих {{desconto}} отстъпка, само за теб.

Това не е обикновена промоция и няма да я намериш в никой банер на сайта. Съществува, защото не искам цената да е причината да затвориш страницата и да продължиш да се притесняваш от същите бръчки, отпуснатост или тънка, набръчкана кожа, които те доведоха до {{marca}}.

Поръчката ти още е запазена, а отстъпката вече е активна с кода {{cupom}}.

{{link}}

${S}` },
      { subject: "Одобрих ти отстъпка 🎁", preview: "Отстъпката, {{marca}} и всичко, което си струва да знаеш.", button: L.bSave, body: `Здравей, {{nome}},

Поръчката ти за {{marca}} още е запазена, а ексклузивната ти отстъпка от {{desconto}} все още е активна (код {{cupom}}). Но няма да остане налична завинаги.

Какво има в {{marca}}? Комплекс от 7 пептида, които действат в няколко посоки, за да помогнат за подобряване на вида на линиите, бръчките, загубата на стегнатост и набръчканата текстура на лицето, шията, деколтето и ръцете.

Подходящо ли е, ако кожата ми вече е много набръчкана? Формулата не е направена само за първите линии. Разработена е да действа и върху вида на по-тънка, отпусната и набръчкана кожа. Всяка кожа реагира със своето темпо и много хора забелязват разлика в текстурата и стегнатостта още през първите седмици на редовна употреба.

Поръчката ти е запазена, но времето изтича.

{{link}}

${S}` },
      { subject: "Това е последният ти шанс ⚠️", preview: "Последният шанс, преди отстъпката да изчезне.", button: L.bNow, body: `Здравей, {{nome}},

Ще бъда кратка и директна. Отстъпката ти от {{desconto}} изтича днес. След това не мога да обещая, че ще е налична, и няма да ти пиша отново да ползваш същите условия.

Ако имаш въпрос за {{marca}} или за поръчката си, просто отговори на този имейл и някой от екипа ни ще говори лично с теб.

Но ако единственото, което те спира, е онова познато колебание, ще те попитам нещо: какво точно чакаш, което не се е случило през последните седмици? Бръчките още са там и кожата ти няма да стане по-стегната само защото си решила да изчакаш.

Ако искаш да завършиш поръчката сега, натисни тук:

{{link}}

${S}

P.S. Не позволявай цената да е причината да отлагаш. Кодът ти е {{cupom}}.` },
      { subject: "Онзи момент пред огледалото... 😳", preview: "Когато осъзнаеш, че кожата ти се е променила по-бързо от теб.", button: L.b1d, body: `Здравей, {{nome}},

Случвало ли ти се е да се загледаш в огледалото за няколко секунди и да усетиш, че образът не съвпада с това, което чувстваш отвътре? Може би е по-отпуснатата кожа на шията, линиите около устата или ръцете, заради които се замисляш, преди да облечеш дреха без ръкави.

Тези промени не променят само вида на кожата. Те влияят на самочувствието. И не е нужно да ги приемаш като нещо, което трябва да се търпи след определена възраст.

{{marca}} е създадена, за да ти помогне отново да се чувстваш добре в собствената си кожа: по-гладък вид, повече стегнатост там, където възрастта се забелязва най-много, и повече увереност да спреш да се криеш.

Отстъпката ти от {{desconto}} още е активна (код {{cupom}}).

{{link}}

${S}` },
      { subject: "Не са просто приказки: наличността намалява ⚠️", preview: "Поръчката ти е запазена, но не знам докога.", button: L.b1d, body: `Здравей, {{nome}},

Проблемът със признаците на възрастта е, че не спират само защото сме решили да изчакаме. Естественото производство на колаген се променя с времето, а загубата на стегнатост започва да се проявява на места, които преди не си забелязвала.

Къде ще бъдеш след една година, ако продължиш да правиш същото? Този път трябва да съм директна: поръчката ти е запазена, но настоящата ни наличност е наистина ниска. Търсенето нарасна по-бързо от очакваното и не мога да обещая, че запазената ти поръчка ще остане налична още много дни.

Въпросът вече не е „може би по-късно?“, а „ще се възползвам ли от шанса, докато поръчката ми още е запазена?“.

Отстъпката ти от {{desconto}} още е активна (код {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) Няколко отказани поръчки освободиха наличност", preview: "Успях да освободя няколко бройки и увеличих отстъпката ти.", button: L.b1w, body: `Здравей, {{nome}},

Не очаквах да ти пиша отново толкова скоро, но се случи нещо. Няколко поръчки бяха отказани през последните часове и това освободи малко бройки {{marca}}, които вече бяха резервирани.

Тъй като поръчката ти още е в списъка ни, исках да ти дам предимство за тези бройки, преди да ги предложим на друг. За да ти благодаря за търпението, увеличих отстъпката ти:

{{desconto}} отстъпка с кода {{cupom}}

Отстъпката е по-голяма, но ще е налична за по-кратко време, защото тези бройки вероятно няма да останат дълго.

{{link}}

${S}` },
      { subject: "({{desconto}}) Последно лично съобщение ⚠️", preview: "Не исках да приключа, без да поговоря с теб за последен път.", button: L.b1, body: `Здравей, {{nome}},

Не исках да приключа с поръчката ти, без да ти пиша за последен път, лично. Преди няколко дни започна поръчка за {{marca}} и по някаква причина тя не беше завършена. Не знам какво те спря. Може би не е било подходящият момент, може би е останал въпрос, а може просто да си искала да помислиш. Това е напълно нормално.

Но ако бръчките, отпуснатостта или по-тънката кожа още те притесняват, не е нужно да продължаваш да избираш дрехите си според това, което трябва да скриеш, нито да чакаш признаците да станат по-видими, за да започнеш да се грижиш за тях.

Наличността ни от тази партида наистина приключва и не знам кога ще можем да предложим отново същите условия. Това е последното лично съобщение за тази поръчка, затова ти оставих най-голямата отстъпка, предлагана в тази поредица:

{{desconto}} отстъпка с кода {{cupom}}

Надявам се да се погледнеш в огледалото и да се почувстваш красива, уверена и спокойна в кожата си.

{{link}}

${S}` },
      { subject: "({{desconto}}) Не смятах да ти пиша отново", button: L.bWith, body: `Здравей, {{nome}},

Не смятах да ти пиша отново, но получих изключително одобрение и не мога да го задържа за себе си: {{desconto}} отстъпка за запазената ти поръчка с кода {{cupom}}. Това е най-доброто, което сме предлагали, и важи само няколко дни.

Ако бръчките и загубата на стегнатост още те притесняват, това е най-добрият шанс да започнеш.

{{link}}

${S}` },
      { subject: "({{desconto}}) Последният път, наистина", button: L.bNow, body: `Здравей, {{nome}},

Това наистина е последното ми съобщение. Оставих ти {{desconto}} отстъпка с кода {{cupom}}, половината от цената, за да не е цената причината да отлагаш. Кодът спира да работи след 24 часа и няма да се върне.

От сърце се надявам да си дадеш този шанс.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "Поздравления за първата ти поръчка от {{marca}} 🎉", preview: "Поръчката ти е потвърдена. Ето и важна информация за таксуването.", button: L.talk, body: `Здравей, {{nome}}!

Аз съм {{agente}} от екипа на {{marca}}. Преди всичко, поздравления за избора ти. Много се радваме, че си с нас :)

Поръчката ти е получена и екипът ни вече се грижи за всичко. Можеш да си спокойна от самото начало: ние сме истински екип, с хора, които следят всяка стъпка от поръчката ти и работят всеки ден, за да ти осигурят възможно най-доброто преживяване.

Времето ни за подготовка е до 3 работни дни и правим всичко възможно {{marca}} да потегли колкото се може по-скоро. Щом бъде изпратена, ще получиш имейл с връзка за проследяване, за да следиш доставката до дома си.

Едно важно нещо, за да не се притесняваш, когато погледнеш извлечението от картата си: таксуването може да се появи като „SP OSTEOPURE“. Въпреки че името е различно от {{marca}}, няма причина за притеснение. SP OSTEOPURE е стандартното описание, което нашият платежен доставчик използва за обработка на част от транзакциите. Ако го видиш до сумата на покупката си, това е плащането за поръчката ти за {{marca}}.

Ако имаш въпрос за поръчката, таксуването или доставката, пиши ни, преди да се притесняваш. Истински екип е тук, за да провери всичко и да помогне.

${W}

${Q}` },
      { subject: "Грижим се за поръчката ти 💚", preview: "Просто искаме да те успокоим и всичко да е ясно от самото начало.", button: L.talk, body: `Здравей, {{nome}}!

Пак съм аз, {{agente}} :) Исках само да те уверя, че всичко е наред с поръчката ти и че екипът ни продължава да следи всяка стъпка.

Знаем, че след покупка е естествено да искаш да си сигурна, че всичко върви както трябва. Затова държим да си спокойна и информирана, докато {{marca}} стигне до дома ти.

Ако възникне въпрос за поръчката, плащането или доставката, свържи се с нас. Истински екип е тук, за да провери всичко и да помогне възможно най-бързо.

Още веднъж благодарим за доверието. Грижим се за всичко.

${W}

${Q}` },
      { subject: "Твоят {{marca}} е на път! 📦", preview: "Поръчката ти е изпратена и вече можеш да следиш доставката.", button: L.talk, body: `Здравей, {{nome}}!

Хубава новина: {{produto}} е готов и вече е изпратен! Официално е на път към дома ти :)

Очакваният срок за доставка е средно 9 до 12 работни дни след изпращането. Оттук пратката преминава през мрежата на куриерската компания и пощенските услуги за твоя район. Не можем да контролираме всяка стъпка от доставката, но продължаваме да следим всичко от наша страна.

${T}

Ако имаш въпрос за доставката или как да включиш крема в рутината си, свържи се с нас. Вълнуваме се колкото теб, че тази малка пратка най-после ще стигне до теб :)

${W}

${Q}` },
      { subject: "Важна новина за поръчката ти", preview: "Забелязахме малка промяна в доставката и искахме да те информираме.", button: L.talk, body: `Здравей, {{nome}}!

Исках да те информирам, защото забелязахме промяна в статуса на доставката на поръчката ти и предпочетохме да ти кажем, преди да започнеш да се тревожиш. Пощенската служба за твоя район работи малко по-бавно тази седмица и затова е възможно {{marca}} да се позабави с още няколко дни.

Но можеш да си спокойна: поръчката ти е в безопасност и продължава да напредва. Екипът ни следи движението и проверява актуализациите, за да стигне пратката до теб възможно най-бързо.

Знам, че е досадно да чакаш, когато нямаш търпение да започнеш да ползваш {{marca}}, затова искахме да бъдем прозрачни и да те държим в течение. Ако имаш въпрос за доставката, просто се свържи с нас. Тук сме, за да помогнем.

Благодарим ти много за търпението.

${S}

${QI}` },
      { subject: "Следим отблизо твоя {{marca}} 💚", preview: "Само една кратка новина за напредъка на пратката ти.", button: L.talk, body: `Здравей, {{nome}}!

Още една кратка новина за твоя {{marca}}. Знаем, че вероятно броиш дните до получаването на крема и началото на рутината ти, затова екипът ни продължава да следи пратката отблизо.

Поръчката ти продължава да напредва през разпределителната мрежа и проверяваме актуализациите при отговорните за доставката. Помолихме и за специално внимание към пратката, за да се избегне излишно забавяне.

В момента всичко е наред с пратката ти. Можеш да следиш новите актуализации чрез връзката за проследяване, а ние ще продължим да следим, докато стигне до теб.

${T}

Още веднъж благодарим за доверието и търпението :)

${W}

${QI}` },
      { subject: "Хубава новина: твоят {{marca}} се приближава!", preview: "Поръчката ти направи още една стъпка и е в последната права.", button: L.talk, body: `Здравей, {{nome}}!

Страхотна новина: поръчката ти направи още една стъпка и се приближава към теб :) Пратката е в последната права на доставката и се надяваме скоро да бъде предадена за доставка на твоя адрес.

Екипът ни продължава да следи актуализациите, а ти също можеш да видиш последните движения направо през връзката за проследяване. След цялото това чакане остава съвсем малко, докато получиш {{produto}} и започнеш грижата за кожата си.

${T}

Когато пристигне, ако искаш да попиташ нещо за използването на крема, просто се свържи с нас. Тук сме.

${S}

${Q}` },
      { subject: "Остава съвсем малко до пристигането на твоя {{marca}} 💚", preview: "Поръчката ти е в последните етапи преди да стигне до дома ти.", button: L.talk, body: `Здравей, {{nome}}!

Остава съвсем малко :) {{produto}} се приближава много до дома ти и следим този последен етап заедно с теб.

Добре е да обръщаш внимание на куриера и на актуализациите в проследяването. Пратката ти преминава през последните етапи на сортиране и разпределение в твоя район, така че доставката наближава.

Ако не пристигне днес, няма причина за тревога. Според натовареността на пощенските услуги в района ти, този последен етап може да варира с няколко дни. Ще продължим да следим, докато поръчката ти пристигне безопасно.

${T}

Благодарим ти за цялото търпение по време на този процес. Много се радваме, че избра {{marca}}, и нямаме търпение да започнеш рутината си с {{produto}}.

${W}

${Q}` },
    ],
  };
})();

const HU: Pack = (() => {
  const L = {
    b1: "Búcsút intek a ráncoknak",
    bSave: "Rendelés befejezése, {{desconto}} megtakarítással",
    bNow: "Rendelés befejezése most",
    b1d: "Búcsút intek a ráncoknak ({{desconto}} kedvezmény)",
    b1w: "Búcsút intek a ráncoknak, {{desconto}} kedvezménnyel",
    bWith: "Rendelés befejezése {{desconto}} kedvezménnyel",
    talk: "Kattints ide, és beszélgessünk",
  };
  const S = "Szeretettel,\n{{agente}}, a {{marca}} csapata";
  const W = "Szívélyesen,\n{{agente}}\nA {{marca}} csapata";
  const Q = "Kérdésed van? A megkeresésedben add meg a rendelésszámodat ({{pedido}}), így gyorsabban megtalálunk mindent.";
  const QI = "Fontos: ha írnál nekünk, tartsd kéznél a rendelésszámodat ({{pedido}}).";
  const T = "Követési kód: {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 Üzenet a {{marca}} csapatától: {{agente}}", preview: "Egy gyors kérdés...", button: L.b1, body: `Szia {{nome}},

{{agente}} vagyok a {{marca}} csapatából. Azért írok, mert láttam, hogy a rendelésed még nem fejeződött be, és szerettem volna megbizonyosodni arról, hogy nem maradt kérdésed. Eljutottál az utolsó lépésig, és nem akartam, hogy a kosarad egyszerűen eltűnjön anélkül, hogy előtte beszéltem volna veled.

A rendelésed még pontosan úgy van elmentve, ahogy hagytad. Ha valami elakadt, ha van kérdésed, vagy csak segítséget szeretnél a folytatáshoz, válaszolj erre az e-mailre. A túloldalon igazi csapat van, és mindent megteszek, hogy segítsek.

Ha inkább ott folytatnád, ahol abbahagytad, itt a link:

{{link}}

${S}` },
      { subject: "🎁 Fejezd be a rendelésedet {{desconto}} kedvezménnyel", preview: "Valószínűleg nem kellett volna jóváhagynom, de...", button: L.b1, body: `Szia {{nome}},

Az előző üzenetem után tovább gondolkodtam a rendelésedről, és olyan döntést hoztam, aminek a pénzügyi csapatom nem fog örülni: jóváhagytam {{desconto}} kedvezményt, csak neked.

Ez nem egy szokásos akció, és az oldalon egyetlen bannerben sem találod meg. Azért létezik, mert nem szeretném, hogy az ár legyen az oka, hogy bezárod az oldalt, és tovább aggódsz ugyanazok a ráncok, a petyhüdtség vagy a vékony, ráncos bőr miatt, amelyek miatt a {{marca}} termékhez jutottál.

A rendelésed még el van mentve, a kedvezmény pedig már aktív a {{cupom}} kóddal.

{{link}}

${S}` },
      { subject: "Kedvezményt hagytam jóvá neked 🎁", preview: "A kedvezmény, a {{marca}} és minden, amit érdemes tudnod.", button: L.bSave, body: `Szia {{nome}},

A {{marca}} rendelésed még el van mentve, és a kizárólagos {{desconto}} kedvezményed is aktív (kód: {{cupom}}). Csak nem marad elérhető örökké.

Mi van a {{marca}} termékben? 7 peptidből álló komplex, amely több fronton dolgozik, hogy segítsen javítani a vonalak, ráncok, a feszesség elvesztése és a ráncos textúra megjelenését az arcon, a nyakon, a dekoltázson és a karokon.

Működik, ha a bőröm már nagyon ráncos? A formulát nem csak az első ráncokra fejlesztették ki. Arra is készült, hogy a vékonyabb, petyhüdtebb, ráncos bőr megjelenésén segítsen. Minden bőr a saját tempójában reagál, és sokan már az első hetekben észreveszik a textúra és a feszesség változását rendszeres használat mellett.

A rendelésed el van mentve, de az idő fogy.

{{link}}

${S}` },
      { subject: "Ez az utolsó esélyed ⚠️", preview: "Az utolsó esély, mielőtt a kedvezmény eltűnik.", button: L.bNow, body: `Szia {{nome}},

Rövid és egyenes leszek. A {{desconto}} kedvezményed ma lejár. Utána nem ígérhetem, hogy még elérhető lesz, és nem fogok újra írni, hogy ugyanezekkel a feltételekkel élj.

Ha bármilyen kérdésed van a {{marca}} termékről vagy a rendelésedről, válaszolj erre az e-mailre, és valaki a csapatunkból személyesen beszél veled.

De ha az egyetlen, ami visszatart, az az ismerős tétovázás, hadd kérdezzek valamit: mire vársz pontosan, ami az elmúlt hetekben még nem történt meg? A ráncok még mindig ott vannak, és a bőröd nem lesz feszesebb attól, hogy várni döntöttél.

Ha most befejeznéd a rendelést, kattints ide:

{{link}}

${S}

P.S. Ne hagyd, hogy az ár legyen az oka a halogatásnak. A kódod: {{cupom}}.` },
      { subject: "Az a pillanat a tükör előtt... 😳", preview: "Amikor rájössz, hogy a bőröd gyorsabban változott, mint te.", button: L.b1d, body: `Szia {{nome}},

Előfordult már, hogy néhány másodpercig néztél a tükörbe, és úgy éreztél, hogy a kép nem egyezik azzal, amit belül érzel? Talán a nyak petyhüdtebb bőre, a száj körüli vonalak, vagy a kar miatt, ami miatt kétszer is meggondolod, hogy ujjatlan felsőt vegyél fel.

Ezek a változások nem csak a bőr megjelenését érintik. A magabiztosságodra is hatnak. És nem kell úgy elfogadnod őket, mintha egy bizonyos kor után ezt egyszerűen tűrni kellene.

A {{marca}} azért készült, hogy segítsen újra jól érezned magad a saját bőrödben: simább megjelenésű bőr, több feszesség ott, ahol a kor leginkább látszik, és több magabiztosság ahhoz, hogy ne kelljen elbújnod.

A {{desconto}} kedvezményed még aktív (kód: {{cupom}}).

{{link}}

${S}` },
      { subject: "Ez nem üres beszéd: fogy a készlet ⚠️", preview: "A rendelésed el van mentve, de nem tudom, meddig.", button: L.b1d, body: `Szia {{nome}},

Az öregedés jeleivel az a gond, hogy nem állnak meg attól, hogy mi várni döntünk. A természetes kollagéntermelés idővel változik, és a feszesség elvesztése olyan helyeken kezd látszani, amelyeket korábban észre sem vettél.

Hol leszel egy év múlva, ha pontosan ugyanazt csinálod? Most egyenesnek kell lennem: a rendelésed el van mentve, de a jelenlegi készletünk valóban alacsony. A kereslet gyorsabban nőtt a vártnál, és nem ígérhetem, hogy az elmentett rendelésed még sok napig elérhető marad.

A kérdés már nem az, hogy „talán majd később?”, hanem az, hogy „élek-e a lehetőséggel, amíg a rendelésem még el van mentve?”.

A {{desconto}} kedvezményed még aktív (kód: {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) Néhány lemondás készletet szabadított fel", preview: "Sikerült felszabadítanom néhány darabot, és megemeltem a kedvezményed.", button: L.b1w, body: `Szia {{nome}},

Nem számítottam rá, hogy ilyen hamar újra írok, de történt valami. Az elmúlt órákban néhány rendelést lemondtak, ami felszabadított néhány már lefoglalt {{marca}} darabot.

Mivel a rendelésed még a listánkon van, azt szerettem volna, hogy te elsőbbséget kapj ezekre a darabokra, mielőtt másnak ajánljuk fel őket. Hogy megköszönjem a türelmedet, megemeltem a kedvezményed:

{{desconto}} kedvezmény a {{cupom}} kóddal

Ez nagyobb kedvezmény, de rövidebb ideig lesz elérhető, mert ezek a darabok valószínűleg nem maradnak sokáig készleten.

{{link}}

${S}` },
      { subject: "({{desconto}}) Egy utolsó személyes üzenet ⚠️", preview: "Nem akartam befejezni anélkül, hogy még egyszer beszéltem volna veled.", button: L.b1, body: `Szia {{nome}},

Nem akartam lezárni a rendelésedet anélkül, hogy még egyszer, személyesen ne írtam volna neked. Néhány napja elkezdtél egy {{marca}} rendelést, és valamiért nem fejeződött be. Nem tudom, mi állított meg. Talán nem volt jó az időzítés, talán maradt egy kérdésed, vagy csak szerettél volna még gondolkodni. Ez teljesen rendben van.

De ha a ráncok, a petyhüdtség vagy a vékonyabb bőr még mindig zavar, nem kell tovább úgy választanod ruhát, hogy mit kell elrejtened, és nem kell megvárnod, hogy a jelek még látványosabbak legyenek, mielőtt végre foglalkozol velük.

A készletünk ebből a tételből tényleg a végéhez közeledik, és nem tudom, mikor tudjuk újra felajánlani ezeket a feltételeket. Ez az utolsó személyes üzenetem erről a rendelésről, ezért meghagytam neked a legnagyobb kedvezményt, amit ebben a sorozatban kínáltunk:

{{desconto}} kedvezmény a {{cupom}} kóddal

Remélem, hogy majd a tükörbe nézve szépnek, magabiztosnak és otthon érzed magad a bőrödben.

{{link}}

${S}` },
      { subject: "({{desconto}}) Nem terveztem újra írni", button: L.bWith, body: `Szia {{nome}},

Nem terveztem újra írni, de rendkívüli jóváhagyást kaptam, és nem tudom megtartani magamnak: {{desconto}} kedvezmény az elmentett rendelésedre a {{cupom}} kóddal. Ez a legtöbb, amit valaha adtunk, és csak néhány napig érvényes.

Ha a ráncok és a feszesség elvesztése még mindig zavar, ez a legjobb lehetőséged a kezdésre.

{{link}}

${S}` },
      { subject: "({{desconto}}) Tényleg utoljára", button: L.bNow, body: `Szia {{nome}},

Ez tényleg az utolsó üzenetem. Meghagytam neked {{desconto}} kedvezményt a {{cupom}} kóddal, az ár felét, hogy ne az ár legyen az oka a halogatásnak. A kód 24 óra múlva megszűnik, és nem jön vissza.

Őszintén remélem, hogy megadod magadnak ezt az esélyt.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "Gratulálunk az első {{marca}} rendelésedhez 🎉", preview: "A rendelésed megerősítve. Itt van egy fontos információ is a terhelésről.", button: L.talk, body: `Szia {{nome}}!

{{agente}} vagyok a {{marca}} csapatából. Először is gratulálunk a választásodhoz. Nagyon örülünk, hogy velünk vagy :)

A rendelésedet megkaptuk, és a csapatunk már mindent intéz. Az elejétől nyugodt lehetsz: igazi csapat vagyunk, olyan emberekkel, akik a rendelésed minden lépését követik, és minden nap azon dolgoznak, hogy a lehető legjobb élményt adják.

Az előkészítési időnk legfeljebb 3 munkanap, és mindent megteszünk, hogy a {{marca}} minél hamarabb útnak induljon. Amint feladjuk, kapsz egy e-mailt követési linkkel, hogy nyomon követhesd a szállítást egészen az otthonodig.

Egy fontos dolog, hogy ne aggódj, amikor a kártyakivonatodat nézed: a terhelés „SP OSTEOPURE” néven jelenhet meg. Bár a név eltér a {{marca}} névtől, nincs ok aggodalomra. Az SP OSTEOPURE a fizetési szolgáltatónk szokásos terhelési megnevezése, amelyet egyes tranzakciók feldolgozásához használ. Ha a vásárlásod összege mellett ezt látod, az a {{marca}} rendelésed kifizetése.

Ha kérdésed van a rendeléssel, a terheléssel vagy a szállítással kapcsolatban, írj nekünk, mielőtt aggódnál. Igazi emberi csapat áll készen, hogy mindent ellenőrizzen és segítsen.

${W}

${Q}` },
      { subject: "Gondoskodunk a rendelésedről 💚", preview: "Csak megnyugtatnánk, hogy az elejétől minden egyértelmű legyen.", button: L.talk, body: `Szia {{nome}}!

Újra {{agente}} vagyok :) Csak meg szerettem volna erősíteni, hogy minden rendben van a rendeléseddel, és a csapatunk továbbra is követi minden lépését.

Tudjuk, hogy egy vásárlás után természetes, hogy biztos akarsz lenni abban, hogy minden a megfelelő módon halad. Ezért fontos nekünk, hogy nyugodt és tájékozott maradj, amíg a {{marca}} meg nem érkezik hozzád.

Ha bármilyen kérdésed merül fel a rendeléssel, a fizetéssel vagy a szállítással kapcsolatban, keress minket. Igazi emberi csapat áll készen, hogy mindent ellenőrizzen és a lehető leggyorsabban segítsen.

Még egyszer köszönjük a bizalmadat. Mindent intézünk.

${W}

${Q}` },
      { subject: "Úton van a {{marca}} csomagod! 📦", preview: "A rendelésed feladásra került, és már követheted a szállítást.", button: L.talk, body: `Szia {{nome}}!

Jó hírem van: a {{produto}} elkészült, és már fel is adtuk! Hivatalosan úton van hozzád :)

A becsült szállítási idő a feladás után átlagosan 9 és 12 munkanap között. Innentől a csomag a futárszolgálat és a te területedért felelős postai szolgáltatások hálózatán halad. A szállítás minden lépését nem tudjuk közvetlenül irányítani, de a magunk részéről mindent tovább követünk.

${T}

Ha kérdésed van a szállítással vagy azzal kapcsolatban, hogyan illeszd be a krémet a rutinodba, keress minket. Ugyanúgy izgulunk, mint te, hogy ez a kis csomag végre megérkezik hozzád :)

${W}

${Q}` },
      { subject: "Fontos tájékoztatás a rendelésedről", preview: "Kisebb változást láttunk a szállításban, és szerettünk volna tájékoztatni.", button: L.talk, body: `Szia {{nome}}!

Azért írok, mert változást vettünk észre a rendelésed szállítási állapotában, és inkább szóltunk, mielőtt aggódni kezdenél. A te területedért felelős postai szolgáltatás ezen a héten kicsit lassabban dolgozik, ezért előfordulhat, hogy a {{marca}} még néhány nappal később érkezik.

De nyugodt lehetsz: a rendelésed biztonságban van, és a szokásos módon halad tovább. A csapatunk követi a mozgást, és ellenőrzi a frissítéseket, hogy a csomag minél előbb megérkezzen hozzád.

Tudom, hogy frusztráló várni, amikor izgatottan szeretnéd elkezdeni a {{marca}} használatát, ezért átláthatóak szerettünk volna lenni, és tájékoztatni téged. Ha kérdésed van a szállítással kapcsolatban, keress minket. Itt vagyunk, hogy segítsünk.

Nagyon köszönjük a türelmedet.

${S}

${QI}` },
      { subject: "Közelről követjük a {{marca}} csomagodat 💚", preview: "Csak egy rövid frissítés a szállításod előrehaladásáról.", button: L.talk, body: `Szia {{nome}}!

Egy rövid további frissítés a {{marca}} csomagodról. Tudjuk, hogy valószínűleg számolod a napokat, amíg megkapod a krémet, és elkezded a rutinodat, ezért a csapatunk továbbra is közelről követi a szállítást.

A rendelésed halad a szállítási hálózaton belül, és a kézbesítésért felelős felekkel ellenőrizzük a frissítéseket. Külön figyelmet is kértünk a csomagra, hogy elkerüljük a felesleges késést.

Jelenleg minden rendben van a csomagoddal. A következő frissítéseket a követési linken keresztül nyomon követheted, mi pedig addig követjük, amíg meg nem érkezik hozzád.

${T}

Még egyszer köszönjük a bizalmadat és a türelmedet :)

${W}

${QI}` },
      { subject: "Jó hír: közeledik a {{marca}} csomagod!", preview: "A rendelésed újabb lépést tett, és az utolsó szakaszban van.", button: L.talk, body: `Szia {{nome}}!

Remek hír: a rendelésed újabb lépést tett, és egyre közelebb ér hozzád :) A csomag a szállítás utolsó szakaszában van, és reméljük, hamarosan kiadják kézbesítésre a címedre.

A csapatunk továbbra is követi a frissítéseket, te pedig a legutóbbi mozgásokat közvetlenül a követési linken is megnézheted. Ennyi várakozás után már nagyon kevés van hátra, mire megkapod a {{produto}} termékedet, és elkezded a bőrápolási rutinodat.

${T}

Ha megérkezett, és kérdezni szeretnél a krém használatáról, keress minket. Itt vagyunk.

${S}

${Q}` },
      { subject: "Már csak egy kicsi hiányzik a {{marca}} megérkezéséig 💚", preview: "A rendelésed az utolsó szakaszban van, mielőtt hozzád ér.", button: L.talk, body: `Szia {{nome}}!

Már csak egy kicsi hiányzik :) A {{produto}} nagyon közel jár az otthonodhoz, és ezt az utolsó szakaszt is veled együtt követjük.

Érdemes figyelni a futárra és a követésedben megjelenő frissítésekre. A csomagod a területeden az utolsó válogatási és kézbesítési lépéseken halad át, így a kézbesítés közeleg.

Ha ma nem érkezik meg, nem kell aggódnod. A területeden működő postai szolgáltatás tevékenységétől függően ez az utolsó szakasz néhány napot változhat. Addig követjük, amíg a rendelésed biztonságban meg nem érkezik.

${T}

Köszönjük a sok türelmedet ebben a folyamatban. Nagyon örülünk, hogy a {{marca}} mellett döntöttél, és alig várjuk, hogy elkezdd a rutinodat a {{produto}} termékkel.

${W}

${Q}` },
    ],
  };
})();

const RO: Pack = (() => {
  const L = {
    b1: "Vreau să spun adio ridurilor",
    bSave: "Finalizează comanda și economisește {{desconto}}",
    bNow: "Finalizează comanda acum",
    b1d: "Vreau să spun adio ridurilor ({{desconto}} reducere)",
    b1w: "Vreau să spun adio ridurilor cu {{desconto}} reducere",
    bWith: "Finalizează comanda cu {{desconto}} reducere",
    talk: "Apasă aici ca să vorbim",
  };
  const S = "Cu drag,\n{{agente}}, echipa {{marca}}";
  const W = "Cu căldură,\n{{agente}}\nEchipa {{marca}}";
  const Q = "Ai o întrebare? Menționează numărul comenzii ({{pedido}}) când ne contactezi, ca să găsim totul mai repede.";
  const QI = "Important: dacă vrei să ne scrii, ține la îndemână numărul comenzii ({{pedido}}).";
  const T = "Cod de urmărire: {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 Un mesaj de la {{agente}}, de la {{marca}}", preview: "O întrebare scurtă...", button: L.b1, body: `Bună {{nome}},

Sunt {{agente}}, de la {{marca}}. Îți scriu pentru că am văzut că comanda ta nu a fost finalizată și am vrut să mă asigur că nu ți-a rămas nicio întrebare. Ai ajuns până la ultimul pas și nu am vrut să las coșul tău să dispară fără să vorbesc mai întâi cu tine.

Comanda ta este încă păstrată exact așa cum ai lăsat-o. Dacă ceva s-a blocat, dacă ai o întrebare sau pur și simplu vrei ajutor ca să continui, răspunde la acest e-mail. De cealaltă parte este o echipă reală și voi face tot ce pot ca să te ajut.

Dacă preferi să continui de unde ai rămas, iată linkul:

{{link}}

${S}` },
      { subject: "🎁 Finalizează comanda cu {{desconto}} reducere", preview: "Probabil nu ar fi trebuit să aprob asta, dar...", button: L.b1, body: `Bună {{nome}},

După ultimul meu mesaj m-am tot gândit la comanda ta și am luat o decizie care probabil nu va plăcea echipei mele financiare: am aprobat {{desconto}} reducere, doar pentru tine.

Nu este o promoție obișnuită și nu o vei găsi pe niciun banner de pe site. Există pentru că nu vreau ca prețul să fie motivul pentru care închizi pagina și continui să te îngrijorezi pentru aceleași riduri, aceeași lipsă de fermitate sau pielea subțire și încrețită care te-au adus la {{marca}}.

Comanda ta este încă păstrată, iar reducerea este deja activă cu codul {{cupom}}.

{{link}}

${S}` },
      { subject: "Ți-am aprobat o reducere 🎁", preview: "Reducerea, {{marca}} și tot ce merită să știi.", button: L.bSave, body: `Bună {{nome}},

Comanda ta {{marca}} este încă păstrată, iar reducerea ta exclusivă de {{desconto}} este încă activă (cod {{cupom}}). Dar nu va rămâne disponibilă la nesfârșit.

Ce conține {{marca}}? Un complex de 7 peptide care acționează pe mai multe planuri, pentru a ajuta la îmbunătățirea aspectului liniilor, ridurilor, pierderii de fermitate și texturii încrețite, pe față, gât, decolteu și brațe.

Funcționează și dacă pielea mea este deja foarte încrețită? Formula nu a fost creată doar pentru primele linii. A fost dezvoltată să acționeze și asupra aspectului unei pieli mai subțiri, mai flasce și cu riduri. Fiecare piele reacționează în ritmul ei, iar multe persoane observă o diferență de textură și fermitate încă din primele săptămâni de utilizare constantă.

Comanda ta este păstrată, dar timpul se scurge.

{{link}}

${S}` },
      { subject: "Aceasta este ultima ta șansă ⚠️", preview: "Ultima șansă înainte ca reducerea să dispară.", button: L.bNow, body: `Bună {{nome}},

Voi fi scurtă și directă. Reducerea ta de {{desconto}} se încheie astăzi. După aceea nu pot promite că va mai fi disponibilă și nu îți voi mai scrie ca să te rog să folosești aceleași condiții.

Dacă ai vreo întrebare despre {{marca}} sau despre comandă, răspunde la acest e-mail și cineva din echipa noastră va vorbi personal cu tine.

Dar dacă singurul lucru care te oprește este acea ezitare cunoscută, lasă-mă să te întreb ceva: ce anume aștepți, care nu s-a întâmplat deja în ultimele săptămâni? Ridurile sunt încă acolo, iar pielea ta nu va deveni mai fermă doar pentru că ai decis să aștepți.

Dacă vrei să finalizezi comanda acum, apasă aici:

{{link}}

${S}

P.S. Nu lăsa prețul să fie motivul pentru care amâni. Codul tău este {{cupom}}.` },
      { subject: "Momentul acela în fața oglinzii... 😳", preview: "Când realizezi că pielea ta s-a schimbat mai repede decât tine.", button: L.b1d, body: `Bună {{nome}},

Ți s-a întâmplat vreodată să te uiți în oglindă câteva secunde și să simți că imaginea nu se potrivește cu ce simți înăuntru? Poate este pielea mai lăsată de la gât, liniile din jurul gurii sau brațele care te fac să te gândești de două ori înainte să porți o bluză fără mâneci.

Aceste schimbări fac mai mult decât să schimbe aspectul pielii. Îți afectează încrederea. Și nu trebuie să le accepți ca pe ceva de îndurat după o anumită vârstă.

{{marca}} a fost creată ca să te ajute să te simți din nou bine în pielea ta: un aspect mai neted, mai multă fermitate acolo unde vârsta se vede cel mai mult și mai multă încredere ca să nu mai trebuiască să te ascunzi.

Reducerea ta de {{desconto}} este încă activă (cod {{cupom}}).

{{link}}

${S}` },
      { subject: "Nu sunt vorbe goale: stocul scade ⚠️", preview: "Comanda ta este păstrată, dar nu știu pentru cât timp.", button: L.b1d, body: `Bună {{nome}},

Problema semnelor vârstei este că nu se opresc doar pentru că decidem să așteptăm. Producția naturală de colagen se schimbă în timp, iar pierderea fermității începe să apară în locuri pe care înainte nu le observai.

Unde vei fi peste un an dacă vei continua exact la fel? De data aceasta trebuie să fiu directă: comanda ta este păstrată, dar stocul nostru actual este într-adevăr redus. Cererea a crescut mai repede decât ne-am așteptat și nu pot promite că rezervarea ta va rămâne disponibilă încă multe zile.

Întrebarea nu mai este „poate mai târziu?”, ci „voi folosi ocazia cât comanda mea este încă păstrată?”.

Reducerea ta de {{desconto}} este încă activă (cod {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) Câteva anulări au eliberat stoc", preview: "Am reușit să eliberez câteva unități și ți-am mărit reducerea.", button: L.b1w, body: `Bună {{nome}},

Nu mă așteptam să îți scriu din nou atât de repede, dar s-a întâmplat ceva. Câteva comenzi au fost anulate în ultimele ore, ceea ce a eliberat un număr mic de unități {{marca}} care erau deja rezervate.

Cum comanda ta este încă pe lista noastră, am vrut să îți dau prioritate la aceste unități înainte să le oferim altcuiva. Ca să îți mulțumesc pentru răbdare, ți-am mărit reducerea:

{{desconto}} reducere cu codul {{cupom}}

Este o reducere mai mare, dar va fi disponibilă mai puțin timp, pentru că aceste unități probabil nu vor rămâne mult în stoc.

{{link}}

${S}` },
      { subject: "({{desconto}}) Un ultim mesaj personal ⚠️", preview: "N-am vrut să închei fără să vorbesc cu tine încă o dată.", button: L.b1, body: `Bună {{nome}},

N-am vrut să închid comanda ta fără să îți scriu o ultimă dată, personal. Acum câteva zile ai început o comandă {{marca}} și, dintr-un motiv oarecare, nu a fost finalizată. Nu știu ce te-a oprit. Poate nu era momentul potrivit, poate a rămas o întrebare sau poate ai vrut doar să te gândești mai mult. E în regulă.

Dar dacă ridurile, pierderea fermității sau pielea mai subțire încă te deranjează, nu trebuie să continui să îți alegi hainele după ce ai de ascuns și nici să aștepți ca semnele să devină mai vizibile ca să începi să ai grijă de ele.

Stocul nostru din acest lot chiar se apropie de sfârșit și nu știu când vom putea oferi din nou aceste condiții. Acesta este ultimul mesaj personal pe care ți-l scriu despre această comandă, așa că ți-am lăsat cea mai mare reducere oferită în această serie:

{{desconto}} reducere cu codul {{cupom}}

Sper că te vei privi în oglindă simțindu-te frumoasă, încrezătoare și bine în pielea ta.

{{link}}

${S}` },
      { subject: "({{desconto}}) Nu plănuiam să îți mai scriu", button: L.bWith, body: `Bună {{nome}},

Nu plănuiam să îți mai scriu, dar am primit o aprobare excepțională și nu o pot ține pentru mine: {{desconto}} reducere la comanda păstrată, cu codul {{cupom}}. Este cel mai departe la care am ajuns vreodată și este valabilă doar câteva zile.

Dacă ridurile și pierderea fermității încă te deranjează, aceasta este cea mai bună ocazie de a începe.

{{link}}

${S}` },
      { subject: "({{desconto}}) Ultima dată, cu adevărat", button: L.bNow, body: `Bună {{nome}},

Acesta este cu adevărat ultimul meu mesaj. Ți-am lăsat {{desconto}} reducere cu codul {{cupom}}, jumătate din preț, ca prețul să nu mai fie motivul pentru care amâni. Codul nu va mai funcționa peste 24 de ore și nu se va mai întoarce.

Sper din suflet că îți vei oferi această șansă.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "Felicitări pentru prima ta comandă {{marca}} 🎉", preview: "Comanda ta este confirmată. Iată și o informație importantă despre debitare.", button: L.talk, body: `Bună {{nome}}!

Sunt {{agente}}, din echipa {{marca}}. Mai întâi, felicitări pentru alegerea ta. Ne bucurăm foarte mult că ești alături de noi :)

Comanda ta a fost primită și echipa noastră se ocupă deja de tot. Poți fi liniștită de la început: suntem o echipă reală, cu oameni care urmăresc fiecare pas al comenzii tale și lucrează în fiecare zi ca să îți ofere cea mai bună experiență posibilă.

Timpul nostru de pregătire este de cel mult 3 zile lucrătoare și facem tot ce putem ca {{marca}} să plece cât mai repede. Imediat ce este expediată, vei primi un e-mail cu un link de urmărire, ca să poți urmări livrarea până la tine acasă.

Un lucru important, ca să nu te îngrijorezi când te uiți pe extrasul de card: debitarea poate apărea sub numele „SP OSTEOPURE”. Chiar dacă numele este diferit de {{marca}}, nu e niciun motiv de îngrijorare. SP OSTEOPURE este descrierea standard pe care o folosește procesatorul nostru de plăți pentru unele tranzacții. Dacă îl vezi lângă suma achiziției tale, este plata pentru comanda ta {{marca}}.

Dacă ai o întrebare despre comandă, debitare sau livrare, scrie-ne înainte să te îngrijorezi. O echipă umană reală este aici ca să verifice totul și să te ajute.

${W}

${Q}` },
      { subject: "Ne ocupăm de comanda ta 💚", preview: "Vrem doar să te liniștim și să fie totul clar de la început.", button: L.talk, body: `Bună {{nome}}!

Sunt din nou {{agente}} :) Am vrut doar să te asigur că totul este în regulă cu comanda ta și că echipa noastră continuă să urmărească fiecare pas.

Știm că, după o achiziție, este firesc să vrei să știi că totul decurge cum trebuie. De aceea ne dorim să rămâi liniștită și informată până când {{marca}} ajunge la tine acasă.

Dacă apare vreo întrebare despre comandă, plată sau livrare, contactează-ne. O echipă umană reală este aici ca să verifice totul și să te ajute cât mai repede.

Îți mulțumim încă o dată pentru încredere. Ne ocupăm noi de tot.

${W}

${Q}` },
      { subject: "{{marca}} al tău este pe drum! 📦", preview: "Comanda ta a fost expediată și acum poți urmări livrarea.", button: L.talk, body: `Bună {{nome}}!

Am vești bune: {{produto}} este pregătit și a fost deja expediat! Este oficial pe drum spre tine acasă :)

Timpul estimat de livrare este în medie de 9 până la 12 zile lucrătoare după expediere. De aici, coletul circulă prin rețeaua firmei de curierat și a serviciilor poștale responsabile de zona ta. Nu putem controla direct fiecare etapă a livrării, dar continuăm să urmărim totul din partea noastră.

${T}

Dacă ai o întrebare despre livrare sau despre cum să incluzi crema în rutina ta, contactează-ne. Suntem la fel de entuziasmați ca tine că acest colet mic va ajunge în sfârșit la tine :)

${W}

${Q}` },
      { subject: "Informație importantă despre comanda ta", preview: "Am văzut o mică schimbare în livrare și am vrut să te informăm.", button: L.talk, body: `Bună {{nome}}!

Am vrut să te informez, pentru că am observat o schimbare în starea livrării comenzii tale și am preferat să îți spunem înainte să începi să te îngrijorezi. Serviciul poștal responsabil de zona ta lucrează puțin mai lent săptămâna aceasta, așa că este posibil ca {{marca}} să mai întârzie câteva zile.

Dar poți fi liniștită: comanda ta este în siguranță și continuă să avanseze ca de obicei. Echipa noastră urmărește mișcarea și verifică actualizările, ca să ajungă coletul la tine cât mai repede.

Știu că e frustrant să aștepți când abia aștepți să începi să folosești {{marca}}, de aceea am vrut să fim transparenți și să te ținem la curent. Dacă ai o întrebare despre livrare, contactează-ne. Suntem aici ca să te ajutăm.

Îți mulțumim mult pentru răbdare.

${S}

${QI}` },
      { subject: "Urmărim îndeaproape {{marca}} al tău 💚", preview: "Doar o scurtă actualizare despre progresul livrării tale.", button: L.talk, body: `Bună {{nome}}!

O scurtă actualizare în plus despre {{marca}}. Știm că probabil numeri zilele până primești crema și începi rutina, așa că echipa noastră continuă să urmărească îndeaproape livrarea.

Comanda ta avansează prin rețeaua de distribuție, iar noi verificăm actualizările cu cei responsabili de livrare. Am cerut și o atenție suplimentară pentru colet, ca să evităm orice întârziere inutilă.

În acest moment, totul este în regulă cu coletul tău. Poți urmări următoarele actualizări prin linkul de urmărire, iar noi vom continua să urmărim până ajunge la tine.

${T}

Îți mulțumim încă o dată pentru încredere și răbdare :)

${W}

${QI}` },
      { subject: "Veste bună: {{marca}} al tău se apropie!", preview: "Comanda ta a mai făcut un pas și este pe ultima porțiune.", button: L.talk, body: `Bună {{nome}}!

Veste excelentă: comanda ta a mai făcut un pas și se apropie de tine :) Coletul este pe ultima porțiune a livrării și sperăm ca în curând să fie predat pentru livrare la adresa ta.

Echipa noastră continuă să urmărească actualizările, iar tu poți verifica ultimele mișcări direct prin linkul de urmărire. După toată această așteptare, a rămas foarte puțin până vei primi {{produto}} și vei începe rutina de îngrijire a pielii.

${T}

Când ajunge, dacă vrei să întrebi ceva despre cum se folosește crema, contactează-ne. Suntem aici.

${S}

${Q}` },
      { subject: "A mai rămas foarte puțin până ajunge {{marca}} 💚", preview: "Comanda ta este în ultimele etape înainte să ajungă la tine acasă.", button: L.talk, body: `Bună {{nome}}!

A mai rămas foarte puțin :) {{produto}} se apropie tot mai mult de casa ta și urmărim această ultimă etapă împreună cu tine.

Merită să fii atentă la curier și la actualizările din urmărire. Coletul tău trece prin ultimele etape de sortare și distribuție din zona ta, așa că livrarea se apropie.

Dacă nu ajunge astăzi, nu e nevoie să te îngrijorezi. În funcție de activitatea serviciului poștal din zona ta, această ultimă etapă poate varia cu câteva zile. Vom continua să urmărim până când comanda ta ajunge în siguranță.

${T}

Îți mulțumim pentru toată răbdarea din acest proces. Ne bucurăm foarte mult că ai ales {{marca}} și abia așteptăm să începi rutina cu {{produto}}.

${W}

${Q}` },
    ],
  };
})();

const TR: Pack = (() => {
  const L = {
    b1: "Kırışıklıklara veda etmek istiyorum",
    bSave: "Siparişimi tamamla ve {{desconto}} kazan",
    bNow: "Siparişimi şimdi tamamla",
    b1d: "Kırışıklıklara veda etmek istiyorum ({{desconto}} indirim)",
    b1w: "Kırışıklıklara {{desconto}} indirimle veda etmek istiyorum",
    bWith: "Siparişimi {{desconto}} indirimle tamamla",
    talk: "Bizimle konuşmak için tıklayın",
  };
  const S = "Sevgiyle,\n{{agente}}, {{marca}} ekibi";
  const W = "Sevgiyle,\n{{agente}}\n{{marca}} ekibi";
  const Q = "Sorunuz mu var? Bize ulaşırken sipariş numaranızı ({{pedido}}) belirtin, her şeyi daha hızlı bulalım.";
  const QI = "Önemli: bizimle konuşmanız gerekirse sipariş numaranızı ({{pedido}}) hazır bulundurun.";
  const T = "Takip kodu: {{rastreio}}\n{{link_rastreio}}";
  return {
    cart: [
      { subject: "💌 {{marca}} ekibinden bir mesaj ({{agente}})", preview: "Kısa bir soru...", button: L.b1, body: `Merhaba {{nome}},

Ben {{agente}}, {{marca}} ekibinden. Size yazıyorum çünkü siparişinizin tamamlanmadığını gördüm ve aklınızda hiçbir soru kalmadığından emin olmak istedim. Son adıma kadar geldiniz ve sepetinizin sizinle konuşmadan kaybolmasını istemedim.

Siparişiniz tam bıraktığınız gibi saklı duruyor. Bir şey takıldıysa, sorunuz varsa ya da devam etmek için yardım istiyorsanız bu e-postayı yanıtlayın. Diğer tarafta gerçek bir ekip var ve yardımcı olmak için elimden geleni yapacağım.

Kaldığınız yerden devam etmeyi tercih ederseniz bağlantı burada:

{{link}}

${S}` },
      { subject: "🎁 Siparişinizi {{desconto}} indirimle tamamlayın", preview: "Muhtemelen bunu onaylamamam gerekiyordu ama...", button: L.b1, body: `Merhaba {{nome}},

Son mesajımdan sonra siparişinizi düşünmeye devam ettim ve finans ekibimin pek hoşlanmayacağı bir karar verdim: yalnızca sizin için {{desconto}} indirimi onayladım.

Bu sıradan bir kampanya değil ve sitedeki hiçbir bannerda bulamazsınız. Fiyatın, sayfayı kapatıp sizi {{marca}} ürününe getiren aynı çizgiler, sarkma ya da ince, kırışık cilt konusunda endişelenmeye devam etmenizin nedeni olmasını istemediğim için var.

Siparişiniz hâlâ saklı ve indirim {{cupom}} koduyla şimdiden aktif.

{{link}}

${S}` },
      { subject: "Sizin için bir indirim onayladım 🎁", preview: "İndirim, {{marca}} ve bilmeye değer her şey.", button: L.bSave, body: `Merhaba {{nome}},

{{marca}} siparişiniz hâlâ saklı ve size özel {{desconto}} indiriminiz hâlâ aktif (kod: {{cupom}}). Ancak sonsuza kadar geçerli kalmayacak.

{{marca}} içinde ne var? Yüz, boyun, dekolte ve kollarda çizgilerin, kırışıklıkların, sıkılık kaybının ve krepe benzeyen dokunun görünümünü iyileştirmeye yardımcı olmak için birkaç yönden etki eden 7 peptitlik bir kompleks.

Cildim zaten çok kırışıksa işe yarar mı? Formül yalnızca ilk çizgiler için tasarlanmadı. Daha ince, sarkık ve kırışık cildin görünümü üzerinde de etki etmek için geliştirildi. Her cilt kendi hızında tepki verir ve birçok kişi düzenli kullanımın ilk haftalarında doku ve sıkılıkta fark görmeye başlar.

Siparişiniz saklı ama zaman azalıyor.

{{link}}

${S}` },
      { subject: "Bu son şansınız ⚠️", preview: "İndirim kaybolmadan önceki son şans.", button: L.bNow, body: `Merhaba {{nome}},

Kısa ve net olacağım. {{desconto}} indiriminiz bugün sona eriyor. Bundan sonra geçerli kalacağını garanti edemem ve aynı koşulları kullanmanızı istemek için tekrar yazmayacağım.

{{marca}} ya da siparişiniz hakkında herhangi bir sorunuz varsa bu e-postayı yanıtlayın, ekibimizden biri sizinle bizzat konuşacaktır.

Ama sizi tutan tek şey o tanıdık tereddütse size şunu sormak istiyorum: son haftalarda olmayan ve tam olarak neyin olmasını bekliyorsunuz? Kırışıklıklar hâlâ orada ve beklemeye karar verdiniz diye cildiniz daha sıkı olmayacak.

Siparişinizi şimdi tamamlamak isterseniz buraya tıklayın:

{{link}}

${S}

Not: Fiyatın ertelemenizin nedeni olmasına izin vermeyin. Kodunuz: {{cupom}}.` },
      { subject: "Aynanın karşısındaki o an... 😳", preview: "Cildinizin sizden daha hızlı değiştiğini fark ettiğinizde.", button: L.b1d, body: `Merhaba {{nome}},

Hiç aynaya birkaç saniye bakıp gördüğünüz görüntünün içinizde hissettiğinizle uyuşmadığını düşündünüz mü? Belki boyundaki daha sarkık cilt, ağız çevresindeki çizgiler ya da kolsuz bir şey giymeden önce iki kez düşündüren kollar.

Bu değişiklikler cildin görünümünden fazlasını değiştirir. Özgüveninizi etkiler. Ve bunları belli bir yaştan sonra katlanılması gereken bir şey olarak kabul etmek zorunda değilsiniz.

{{marca}}, kendi cildinizde yeniden rahat hissetmenize yardımcı olmak için geliştirildi: daha pürüzsüz görünen cilt, yaşın en çok belli olduğu yerlerde daha fazla sıkılık ve saklanmayı bırakmak için daha fazla özgüven.

{{desconto}} indiriminiz hâlâ aktif (kod: {{cupom}}).

{{link}}

${S}` },
      { subject: "Boş laf değil: stok azalıyor ⚠️", preview: "Siparişiniz saklı ama ne kadar süreyle bilmiyorum.", button: L.b1d, body: `Merhaba {{nome}},

Yaşlanma belirtilerinin sorunu, biz beklemeye karar verdik diye durmamalarıdır. Doğal kolajen üretimi zamanla değişir ve sıkılık kaybı daha önce fark etmediğiniz yerlerde görünmeye başlar.

Tam olarak aynısını yapmaya devam ederseniz bir yıl sonra nerede olacaksınız? Bu sefer net olmam gerekiyor: siparişiniz saklı ama mevcut stokumuz gerçekten az. Talep beklediğimizden hızlı arttı ve saklı siparişinizin daha çok gün geçerli kalacağını garanti edemem.

Soru artık "belki sonra mı?" değil, "siparişim hâlâ saklıyken fırsatı değerlendirecek miyim?".

{{desconto}} indiriminiz hâlâ aktif (kod: {{cupom}}).

{{link}}

${S}` },
      { subject: "({{desconto}}) Birkaç iptal stok açtı", preview: "Birkaç ürünü serbest bırakmayı başardım ve indiriminizi artırdım.", button: L.b1w, body: `Merhaba {{nome}},

Size bu kadar çabuk tekrar yazmayı beklemiyordum ama bir şey oldu. Son saatlerde birkaç sipariş iptal edildi ve zaten rezerve edilmiş az sayıda {{marca}} ürünü serbest kaldı.

Siparişiniz hâlâ listemizde olduğu için, bu ürünleri başkasına sunmadan önce size öncelik vermek istedim. Sabrınız için teşekkür etmek amacıyla indiriminizi artırdım:

{{cupom}} koduyla {{desconto}} indirim

Bu daha büyük bir indirim ama daha kısa süre geçerli olacak, çünkü bu ürünler muhtemelen uzun süre stokta kalmayacak.

{{link}}

${S}` },
      { subject: "({{desconto}}) Son kişisel mesajım ⚠️", preview: "Sizinle son bir kez konuşmadan bitirmek istemedim.", button: L.b1, body: `Merhaba {{nome}},

Siparişinizi, size son bir kez ve kişisel olarak yazmadan kapatmak istemedim. Birkaç gün önce bir {{marca}} siparişi başlattınız ve bir nedenle tamamlanmadı. Sizi neyin durdurduğunu bilmiyorum. Belki zamanı doğru değildi, belki bir soru kalmıştı ya da sadece biraz daha düşünmek istediniz. Sorun değil.

Ama kırışıklıklar, sıkılık kaybı ya da daha ince cilt hâlâ sizi rahatsız ediyorsa, kıyafetlerinizi saklamanız gerekene göre seçmeye devam etmek zorunda değilsiniz ve belirtiler daha belirgin hâle gelene kadar bekleyip sonra ilgilenmeniz de gerekmiyor.

Bu partideki stokumuz gerçekten tükenmek üzere ve bu koşulları ne zaman yeniden sunabileceğimizi bilmiyorum. Bu sipariş hakkında size yazacağım son kişisel mesaj bu, bu yüzden bu seride sunduğumuz en büyük indirimi bıraktım:

{{cupom}} koduyla {{desconto}} indirim

Umarım aynaya baktığınızda kendinizi güzel, kendinden emin ve cildinizde rahat hissedersiniz.

{{link}}

${S}` },
      { subject: "({{desconto}}) Tekrar yazmayı planlamıyordum", button: L.bWith, body: `Merhaba {{nome}},

Tekrar yazmayı planlamıyordum ama olağanüstü bir onay aldım ve bunu kendime saklayamam: sakladığınız siparişte {{cupom}} koduyla {{desconto}} indirim. Bugüne kadar gittiğimiz en uç nokta bu ve yalnızca birkaç gün geçerli.

Kırışıklıklar ve sıkılık kaybı hâlâ sizi rahatsız ediyorsa, başlamak için elinizdeki en iyi fırsat bu.

{{link}}

${S}` },
      { subject: "({{desconto}}) Son kez, gerçekten", button: L.bNow, body: `Merhaba {{nome}},

Bu gerçekten son mesajım. Size {{cupom}} koduyla {{desconto}} indirim bıraktım, yani fiyatın yarısı, böylece fiyat ertelemenizin nedeni olmasın. Kod 24 saat içinde çalışmayı bırakacak ve geri gelmeyecek.

Kendinize bu şansı vereceğinizi içtenlikle umuyorum.

{{link}}

${S}` },
    ],
    welcome: [
      { subject: "İlk {{marca}} siparişiniz için tebrikler 🎉", preview: "Siparişiniz onaylandı. Ödemeyle ilgili önemli bir bilgi de var.", button: L.talk, body: `Merhaba {{nome}}!

Ben {{agente}}, {{marca}} ekibinden. Öncelikle seçiminiz için tebrik ederiz. Bizimle olduğunuz için çok mutluyuz :)

Siparişiniz alındı ve ekibimiz şimdiden her şeyle ilgileniyor. Baştan içiniz rahat olsun: gerçek bir ekibiz, siparişinizin her adımını takip eden ve size mümkün olan en iyi deneyimi sunmak için her gün çalışan insanlarla.

Hazırlık süremiz en fazla 3 iş günüdür ve {{marca}} ürününüzün en kısa sürede yola çıkması için elimizden geleni yapıyoruz. Gönderildiği anda, teslimatı evinize kadar takip edebilmeniz için takip bağlantısı içeren bir e-posta alacaksınız.

Kart ekstrenize bakarken endişelenmemeniz için önemli bir bilgi: ödeme "SP OSTEOPURE" adıyla görünebilir. Ad {{marca}} adından farklı olsa da endişelenecek bir şey yok. SP OSTEOPURE, ödeme sağlayıcımızın bazı işlemleri gerçekleştirirken kullandığı standart ödeme açıklamasıdır. Satın alma tutarınızın yanında bunu görürseniz, bu {{marca}} siparişinizin ödemesidir.

Siparişiniz, ödeme ya da gönderimle ilgili bir sorunuz olursa endişelenmeden önce bize yazın. Gerçek bir ekip her şeyi kontrol etmek ve yardımcı olmak için burada.

${W}

${Q}` },
      { subject: "Siparişinizle ilgileniyoruz 💚", preview: "Sadece içinizi rahatlatmak ve baştan her şeyin net olmasını sağlamak istedik.", button: L.talk, body: `Merhaba {{nome}}!

Yine ben, {{agente}} :) Siparişinizle ilgili her şeyin yolunda olduğunu ve ekibimizin her adımı takip etmeye devam ettiğini belirtmek istedim.

Bir alışverişten sonra her şeyin olması gerektiği gibi ilerlediğini bilmek istemenin doğal olduğunu biliyoruz. Bu yüzden {{marca}} ürününüz evinize ulaşana kadar içinizin rahat ve bilgili olmasını istiyoruz.

Sipariş, ödeme ya da gönderimle ilgili bir sorunuz olursa bize ulaşın. Gerçek bir ekip her şeyi kontrol etmek ve en kısa sürede yardımcı olmak için burada.

Güveniniz için bir kez daha teşekkür ederiz. Her şeyle biz ilgileniyoruz.

${W}

${Q}` },
      { subject: "{{marca}} ürününüz yolda! 📦", preview: "Siparişiniz gönderildi ve artık teslimatı takip edebilirsiniz.", button: L.talk, body: `Merhaba {{nome}}!

Güzel haber: {{produto}} hazırlandı ve gönderildi! Resmen evinize doğru yolda :)

Tahmini teslimat süresi, gönderimden sonra ortalama 9 ile 12 iş günü arasıdır. Buradan sonra paket, bölgenizden sorumlu kargo şirketinin ve posta hizmetlerinin ağı içinde ilerler. Teslimatın her adımını doğrudan kontrol edemiyoruz ama kendi tarafımızdan her şeyi takip etmeye devam ediyoruz.

${T}

Gönderim ya da kremi bakım rutininize nasıl dahil edeceğiniz hakkında sorunuz olursa bize ulaşın. Bu küçük paketin sonunda size ulaşacak olmasına sizin kadar heyecanlıyız :)

${W}

${Q}` },
      { subject: "Siparişiniz hakkında önemli bir güncelleme", preview: "Gönderimde küçük bir değişiklik gördük ve sizi bilgilendirmek istedik.", button: L.talk, body: `Merhaba {{nome}}!

Sizi bilgilendirmek istedim çünkü siparişinizin gönderim durumunda bir değişiklik fark ettik ve endişelenmeye başlamadan önce söylemeyi tercih ettik. Bölgenizden sorumlu posta hizmeti bu hafta biraz daha yavaş çalışıyor, bu yüzden {{marca}} ürününüzün ulaşması birkaç gün daha sürebilir.

Ama içiniz rahat olsun: siparişiniz güvende ve her zamanki gibi ilerlemeye devam ediyor. Ekibimiz hareketi takip ediyor ve güncellemeleri kontrol ediyor, böylece paket size mümkün olan en kısa sürede ulaşır.

{{marca}} kullanmaya başlamak için heyecanlıyken beklemenin sinir bozucu olduğunu biliyorum, bu yüzden şeffaf olmak ve sizi bilgilendirmek istedik. Gönderimle ilgili bir sorunuz olursa bize ulaşın. Yardımcı olmak için buradayız.

Sabrınız için çok teşekkür ederiz.

${S}

${QI}` },
      { subject: "{{marca}} ürününüzü yakından takip ediyoruz 💚", preview: "Gönderinizin ilerleyişi hakkında kısa bir güncelleme.", button: L.talk, body: `Merhaba {{nome}}!

{{marca}} ürününüzle ilgili kısa bir güncelleme daha. Kremi alıp rutininize başlamak için muhtemelen günleri saydığınızı biliyoruz, bu yüzden ekibimiz gönderiyi yakından takip etmeye devam ediyor.

Siparişiniz dağıtım ağı içinde ilerlemeye devam ediyor ve güncellemeleri teslimattan sorumlu taraflarla kontrol ediyoruz. Gereksiz bir gecikmeyi önlemek için pakete özel dikkat gösterilmesini de talep ettik.

Şu anda paketinizle ilgili her şey yolunda. Sonraki güncellemeleri takip bağlantınızdan izleyebilirsiniz, biz de size ulaşana kadar takip etmeye devam edeceğiz.

${T}

Güveniniz ve sabrınız için bir kez daha teşekkür ederiz :)

${W}

${QI}` },
      { subject: "Güzel haber: {{marca}} ürününüz yaklaşıyor!", preview: "Siparişiniz bir adım daha ilerledi ve son düzlükte.", button: L.talk, body: `Merhaba {{nome}}!

Harika bir haber: siparişiniz bir adım daha ilerledi ve size giderek yaklaşıyor :) Paket gönderimin son düzlüğünde ve yakında adresinize teslim edilmek üzere dağıtıma çıkarılacağını umuyoruz.

Ekibimiz güncellemeleri takip etmeye devam ediyor, siz de son hareketleri doğrudan takip bağlantınızdan görebilirsiniz. Bunca beklemeden sonra {{produto}} ürününüzü alıp cilt bakım rutininize başlamanıza çok az kaldı.

${T}

Ulaştığında, kremin kullanımı hakkında bir şey sormak isterseniz bize ulaşmanız yeterli. Buradayız.

${S}

${Q}` },
      { subject: "{{marca}} ürününüzün ulaşmasına çok az kaldı 💚", preview: "Siparişiniz evinize ulaşmadan önceki son aşamalarda.", button: L.talk, body: `Merhaba {{nome}}!

Artık çok az kaldı :) {{produto}} evinize çok yaklaşıyor ve bu son aşamayı sizinle birlikte takip ediyoruz.

Kuryeye ve takipteki güncellemelere dikkat etmekte fayda var. Paketiniz bölgenizdeki son ayrıştırma ve dağıtım aşamalarından geçiyor, bu yüzden teslimat yaklaşıyor.

Bugün ulaşmazsa endişelenmenize gerek yok. Bölgenizdeki posta hizmetinin yoğunluğuna bağlı olarak bu son aşama birkaç gün değişebilir. Siparişiniz güvenle ulaşana kadar takip etmeye devam edeceğiz.

${T}

Bu süreç boyunca gösterdiğiniz tüm sabır için teşekkür ederiz. {{marca}} ürününü seçtiğiniz için çok mutluyuz ve {{produto}} ile rutininize başlamanızı sabırsızlıkla bekliyoruz.

${W}

${Q}` },
    ],
  };
})();

const PACKS: Record<Lang, Pack> = { en: EN, fr: FR, bg: BG, hu: HU, ro: RO, tr: TR };
const LANGS = Object.keys(PACKS) as Lang[];

function localized(he: Pick<Txt, "subject" | "preview" | "button" | "body">, pick: (p: Pack) => Txt | undefined) {
  const subject: Record<string, string> = { he: he.subject };
  const preview: Record<string, string> = {};
  const button: Record<string, string> = { he: he.button };
  const body: Record<string, string> = { he: he.body };
  if (he.preview) preview.he = he.preview;
  for (const lang of LANGS) {
    const t = pick(PACKS[lang]);
    if (!t) continue;
    subject[lang] = t.subject;
    button[lang] = t.button;
    body[lang] = t.body;
    if (t.preview) preview[lang] = t.preview;
  }
  return { subject, preview, button, body };
}

// Carrinho, e-mail: cadência do Klaviyo (30 min, +3 h, +1 d, +1 d, +3 d, +2 d,
// +2 d, +3 d) e os degraus de 40% e 50% desligados até o Ian definir o preço.
const EMAIL_CART: StepSeed[] = OLAVITA_HE_CART_STEPS.map((s) => ({
  position: s.position,
  name: s.name,
  delay_minutes: s.delayMinutes,
  only_if_no_reply: true,
  discount_percent: s.discountPercent,
  send_if: "sempre" as const,
  enabled: s.enabled,
  ...localized(s, (p) => p.cart[s.position - 1]),
}));

// Pós-compra, e-mail: boas-vindas (0, +2 d, +2 d, +2 d, +3 d, +4 d, +3 d). Não
// depende de resposta do cliente: ele pode responder e ainda assim precisa saber
// do envio. Os passos 3 a 7 só saem quando a Shopify mostra o envio (send_if).
const EMAIL_WELCOME: StepSeed[] = OLAVITA_HE_WELCOME_STEPS.map((s) => ({
  position: s.position,
  name: s.name,
  delay_minutes: s.delayMinutes,
  only_if_no_reply: false,
  discount_percent: null,
  send_if: s.sendIf,
  enabled: s.enabled,
  ...localized(s, (p) => p.welcome[s.position - 1]),
}));

const WHATSAPP_CART: StepSeed[] = WHATSAPP.map((s) => ({ send_if: "sempre" as const, preview: {}, button: {}, ...s }));

// Cópia nova a cada chamada (quem recebe pode editar sem afetar o padrão).
// `storeName` fica reservado pra personalizações futuras por loja; o texto usa
// {{marca}} e {{agente}}, resolvidos na hora do envio. O pós-compra só existe
// por e-mail.
export function DEFAULT_STEPS(_storeName?: string | null, flow: RecoveryFlow = "carrinho"): Record<Channel, StepSeed[]> {
  if (flow === "pos_compra") return { email: EMAIL_WELCOME.map((s) => structuredClone(s)), whatsapp: [] };
  return {
    email: EMAIL_CART.map((s) => structuredClone(s)),
    whatsapp: WHATSAPP_CART.map((s) => structuredClone(s)),
  };
}

// Insere os passos padrão SÓ nos (fluxo, canal) em que a loja ainda não tem
// passo nenhum (nunca sobrescreve o que o Ian editou). Devolve os passos da
// loja no fluxo e nos canais tratados, em ordem.
export async function seedDefaultSteps(admin: SupabaseClient, storeId: string, channel?: Channel, flow: RecoveryFlow = "carrinho"): Promise<RecoveryStep[]> {
  const all: Channel[] = channel ? [channel] : ["email", "whatsapp"];
  const channels = flow === "pos_compra" ? all.filter((c) => c === "email") : all;
  const { data: store } = await admin.from("stores").select("name").eq("id", storeId).maybeSingle();
  const defaults = DEFAULT_STEPS((store?.name as string | undefined) ?? null, flow);
  for (const ch of channels) {
    const { count, error } = await admin.from("recovery_steps").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("flow", flow).eq("channel", ch);
    if (error) throw new Error(error.message);
    if ((count ?? 0) > 0) continue;
    if (defaults[ch].length === 0) continue;
    const rows = defaults[ch].map((s) => ({ store_id: storeId, flow, channel: ch, ...s }));
    const { error: insertError } = await admin.from("recovery_steps").insert(rows);
    if (insertError) throw new Error(insertError.message);
  }
  if (channels.length === 0) return [];
  const { data, error } = await admin.from("recovery_steps").select("*").eq("store_id", storeId).eq("flow", flow).in("channel", channels).order("channel").order("position");
  if (error) throw new Error(error.message);
  return (data ?? []) as RecoveryStep[];
}
