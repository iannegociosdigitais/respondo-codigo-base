import { createAdminClient } from "@/lib/supabase/admin";
import { readRecoveryToken } from "@/lib/recovery/links";

// Descadastro das mensagens de recuperação.
//  GET  → página curta no idioma da pessoa com um botão de confirmação
//         (o GET NÃO descadastra sozinho: scanners de link do Gmail abrem
//         links e descadastrariam todo mundo).
//  POST → descadastra. É o que o botão da página e o "one-click" do Gmail/
//         Yahoo (List-Unsubscribe-Post, RFC 8058) chamam.
//
// Token de carrinho (padrão): grava a supressão do e-mail e, quando o
// carrinho tem telefone, também a do WhatsApp (a página diz que vale para
// todos os lembretes), para o carrinho e registra 'unsubscribed'.
// Token k = 'run' (pós-compra): o id é de post_purchase_runs. Suprime o e-mail
// (reason 'unsubscribed', source 'link'), run vira 'parado_descadastrou',
// next_at null e evento 'unsubscribed' com run_id (dedupe 'unsub:run:<id>').
// Ordem: supressão e status PRIMEIRO (erro = 500, o Gmail tenta de novo), o
// evento (trava de dedupe) por último.
//
// Token de teste (campo t): o carrinho é de um cliente real emprestado pro
// envio de teste. GET e POST só mostram a página avisando que é teste: nada
// de supressão, evento ou mudança de status (senão o botão "Cancelar
// inscrição" do Gmail no e-mail de teste descadastraria o cliente de verdade).

const TEST_NOTE = `<p style="margin:18px 0 0;font-size:13px;color:#6b7280;">Link de teste: nenhum descadastro foi gravado.</p>`;

// runTitle/runDone: pós-compra (token k = run), que cobre lembretes e e-mails sobre o pedido, não o carrinho.
const TEXT: Record<string, { title: string; button: string; done: string; all: string; runTitle: string; runDone: string }> = {
  he: { title: "להפסיק לקבל תזכורות על העגלה?", button: "כן, להסיר אותי", done: "הוסרת. לא נשלח יותר תזכורות על העגלה.", all: "ההסרה חלה על כל התזכורות שלנו (אימייל ו-WhatsApp).", runTitle: "להפסיק לקבל תזכורות ואימיילים על ההזמנה שלך?", runDone: "הוסרת. לא נשלח יותר תזכורות ואימיילים על ההזמנה." },
  fr: { title: "Ne plus recevoir de rappels de panier ?", button: "Oui, me désinscrire", done: "C'est fait. Vous ne recevrez plus de rappels.", all: "Cela vaut pour tous nos rappels (e-mail et WhatsApp).", runTitle: "Ne plus recevoir de rappels et d'e-mails concernant votre commande ?", runDone: "C'est fait. Vous ne recevrez plus de rappels ni d'e-mails concernant votre commande." },
  bg: { title: "Да спрем напомнянията за количката?", button: "Да, отпиши ме", done: "Готово. Няма да получавате повече напомняния.", all: "Това важи за всички наши напомняния (имейл и WhatsApp).", runTitle: "Да спрем напомнянията и имейлите за вашата поръчка?", runDone: "Готово. Няма да получавате повече напомняния и имейли за поръчката." },
  hu: { title: "Leiratkozik a kosár-emlékeztetőkről?", button: "Igen, leiratkozom", done: "Kész. Nem küldünk több emlékeztetőt.", all: "Ez minden emlékeztetőnkre vonatkozik (e-mail és WhatsApp).", runTitle: "Leiratkozik a rendeléséről szóló emlékeztetőkről és e-mailekről?", runDone: "Kész. Nem küldünk több emlékeztetőt és e-mailt a rendelésedről." },
  ro: { title: "Nu mai vrei memento-uri despre coș?", button: "Da, dezabonează-mă", done: "Gata. Nu vei mai primi memento-uri.", all: "Se aplică tuturor memento-urilor noastre (e-mail și WhatsApp).", runTitle: "Nu mai vrei memento-uri și e-mailuri despre comanda ta?", runDone: "Gata. Nu vei mai primi memento-uri și e-mailuri despre comandă." },
  tr: { title: "Sepet hatırlatmalarını durdurmak ister misiniz?", button: "Evet, beni çıkar", done: "Tamam. Artık hatırlatma göndermeyeceğiz.", all: "Bu, tüm hatırlatmalarımız için geçerlidir (e-posta ve WhatsApp).", runTitle: "Siparişinizle ilgili hatırlatma ve e-postaları durdurmak ister misiniz?", runDone: "Tamam. Siparişinizle ilgili artık hatırlatma ve e-posta göndermeyeceğiz." },
  de: { title: "Keine Warenkorb-Erinnerungen mehr?", button: "Ja, abmelden", done: "Erledigt. Sie erhalten keine Erinnerungen mehr.", all: "Das gilt für alle unsere Erinnerungen (E-Mail und WhatsApp).", runTitle: "Keine Erinnerungen und E-Mails zu Ihrer Bestellung mehr?", runDone: "Erledigt. Sie erhalten keine Erinnerungen und E-Mails zu Ihrer Bestellung mehr." },
  es: { title: "¿Dejar de recibir recordatorios del carrito?", button: "Sí, darme de baja", done: "Listo. No recibirás más recordatorios.", all: "Vale para todos nuestros recordatorios (correo y WhatsApp).", runTitle: "¿Dejar de recibir recordatorios y correos sobre tu pedido?", runDone: "Listo. No recibirás más recordatorios ni correos sobre tu pedido." },
  it: { title: "Non ricevere più promemoria del carrello?", button: "Sì, cancellami", done: "Fatto. Non riceverai più promemoria.", all: "Vale per tutti i nostri promemoria (e-mail e WhatsApp).", runTitle: "Non ricevere più promemoria ed e-mail sul tuo ordine?", runDone: "Fatto. Non riceverai più promemoria ed e-mail sul tuo ordine." },
  nl: { title: "Geen winkelwagen-herinneringen meer?", button: "Ja, uitschrijven", done: "Klaar. U ontvangt geen herinneringen meer.", all: "Dit geldt voor al onze herinneringen (e-mail en WhatsApp).", runTitle: "Geen herinneringen en e-mails over uw bestelling meer?", runDone: "Klaar. U ontvangt geen herinneringen en e-mails over uw bestelling meer." },
  pt: { title: "Parar de receber lembretes do carrinho?", button: "Sim, me descadastrar", done: "Pronto. Você não receberá mais lembretes.", all: "Vale para todos os nossos lembretes (e-mail e WhatsApp).", runTitle: "Parar de receber lembretes e e-mails sobre o seu pedido?", runDone: "Pronto. Você não receberá mais lembretes e e-mails sobre o seu pedido." },
  sv: { title: "Sluta få påminnelser om varukorgen?", button: "Ja, avsluta", done: "Klart. Du får inga fler påminnelser.", all: "Detta gäller alla våra påminnelser (e-post och WhatsApp).", runTitle: "Sluta få påminnelser och e-post om din beställning?", runDone: "Klart. Du får inga fler påminnelser och e-post om din beställning." },
  en: { title: "Stop receiving cart reminders?", button: "Yes, unsubscribe me", done: "Done. You will not receive more cart reminders.", all: "This applies to all of our reminders (email and WhatsApp).", runTitle: "Stop receiving reminders and emails about your order?", runDone: "Done. You will not receive more reminders or emails about your order." },
};

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(lang: string, body: string): Response {
  const rtl = lang === "he" || lang === "ar";
  const html = `<!doctype html><html lang="${escapeHtml(lang)}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;margin:0;padding:40px 16px;color:#222}.box{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 20px}p.note{margin:16px 0 0;font-size:13px;color:#6b7280}button{background:#111;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:16px;cursor:pointer}</style></head><body><div class="box">${body}</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

interface Loaded {
  admin: ReturnType<typeof createAdminClient>;
  kind: "cart" | "run";
  rec: { id: string; store_id: string; email: string | null; phone: string | null; language: string | null; step: number };
  channel: string;
  isTest: boolean;
}

async function load(token: string): Promise<Loaded | null> {
  const payload = readRecoveryToken(token);
  if (!payload) return null;
  const admin = createAdminClient();
  const kind = payload.k === "run" ? "run" : "cart";
  const isTest = payload.t === 1;
  const { data: rec } = kind === "run"
    ? await admin.from("post_purchase_runs").select("id, store_id, email, phone, language, step").eq("id", payload.r).maybeSingle()
    : await admin.from("cart_recoveries").select("id, store_id, email, phone, language, step").eq("id", payload.r).maybeSingle();
  if (!rec) {
    // Link de TESTE de carrinho/pedido fictício: mostra a página de teste, sem gravar nada.
    if (isTest) return { admin, kind, rec: { id: payload.r, store_id: "", email: null, phone: null, language: null, step: 0 }, channel: payload.c ?? "email", isTest: true };
    return null;
  }
  return { admin, kind, rec: rec as Loaded["rec"], channel: payload.c ?? "email", isTest };
}

const langOf = (rec: { language: string | null }) => (rec.language && TEXT[rec.language] ? rec.language : "en");

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await load(token);
  if (!ctx) return new Response("Link inválido.", { status: 404 });
  const lang = langOf(ctx.rec);
  const t = TEXT[lang];
  // A página de carrinho avisa que vale para todos os lembretes (e-mail e WhatsApp).
  const all = ctx.kind === "cart" ? `<p class="note">${t.all}</p>` : "";
  return page(lang, `<h1>${ctx.kind === "run" ? t.runTitle : t.title}</h1><form method="post"><button type="submit">${t.button}</button></form>${all}${ctx.isTest ? TEST_NOTE : ""}`);
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await load(token);
  if (!ctx) return new Response("Link inválido.", { status: 404 });
  const { admin, rec, channel, kind } = ctx;
  const now = new Date().toISOString();

  // One-click (Gmail/Yahoo mandam "List-Unsubscribe=One-Click" como form): só 202.
  const ct = request.headers.get("content-type") ?? "";
  const body = ct.includes("application/x-www-form-urlencoded") ? await request.text().catch(() => "") : "";
  const oneClick = /List-Unsubscribe=One-Click/i.test(body);
  const lang = langOf(rec);
  const t = TEXT[lang];

  // Descadastro de TESTE: não grava nada, só confirma na tela que é teste.
  if (ctx.isTest) {
    if (oneClick) return new Response(null, { status: 202 });
    return page(lang, `<h1>${kind === "run" ? t.runDone : t.done}</h1>${TEST_NOTE}`);
  }

  const fail = (what: string, message: string) => {
    console.error(`unsubscribe ${what}:`, message);
    return new Response("Erro temporário, tente de novo.", { status: 500 });
  };
  const email = rec.email?.trim().toLowerCase() || null;
  const phone = rec.phone?.trim() || null;

  if (kind === "run") {
    // Pós-compra: só e-mail. Supressão e status primeiro, evento (trava) por último.
    if (email) {
      const sup = await admin.from("recovery_suppressions").upsert({ store_id: null, channel: "email", address: email, reason: "unsubscribed", source: "link" }, { onConflict: "channel,address", ignoreDuplicates: true });
      if (sup.error) return fail("supressão (run)", sup.error.message);
    }
    const upd = await admin.from("post_purchase_runs").update({ status: "parado_descadastrou", stop_reason: "descadastrou", next_at: null, last_event_at: now, updated_at: now }).eq("id", rec.id).in("status", ["ativo", "pausado"]);
    if (upd.error) return fail("status (run)", upd.error.message);
    const ev = await admin.from("recovery_events").insert({ recovery_id: null, run_id: rec.id, store_id: rec.store_id, step: rec.step, channel: "email", type: "unsubscribed", dedupe_key: `unsub:run:${rec.id}`, to_address: email });
    if (ev.error && !/duplicate key/i.test(ev.error.message)) return fail("evento (run)", ev.error.message);
  } else {
    // Carrinho: supressão do canal do link e, no e-mail, também a do WhatsApp
    // do mesmo carrinho (a página promete parar todos os lembretes).
    const address = channel === "email" ? email : phone;
    const suppressions: Array<{ channel: string; address: string }> = [];
    if (address) suppressions.push({ channel, address });
    if (channel === "email" && phone) suppressions.push({ channel: "whatsapp", address: phone });
    for (const sp of suppressions) {
      const sup = await admin.from("recovery_suppressions").upsert({ store_id: null, channel: sp.channel, address: sp.address, reason: "unsubscribed", source: "link" }, { onConflict: "channel,address", ignoreDuplicates: true });
      if (sup.error) return fail("supressão", sup.error.message);
    }
    const upd = await admin.from("cart_recoveries").update({ status: "parado_descadastrou", stop_reason: "descadastrou", next_send_at: null, email_next_at: null, wa_next_at: null, last_event_at: now, updated_at: now }).eq("id", rec.id).in("status", ["ativo", "pausado"]);
    if (upd.error) return fail("status", upd.error.message);
    const ev = await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: rec.step, channel, type: "unsubscribed", dedupe_key: `unsub:${rec.id}:${channel}`, to_address: address });
    if (ev.error && !/duplicate key/i.test(ev.error.message)) return fail("evento", ev.error.message);
  }

  if (oneClick) return new Response(null, { status: 202 });
  const all = kind === "cart" ? `<p class="note">${t.all}</p>` : "";
  return page(lang, `<h1>${kind === "run" ? t.runDone : t.done}</h1>${all}`);
}
