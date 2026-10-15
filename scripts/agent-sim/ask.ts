// Pergunta avulsa ao agente: roda decideAgentReply (mesmo código de produção,
// nada é enviado nem gravado) para uma lista de mensagens da cliente, num
// histórico realista da conversa (régua -> apresentação -> condição -> link).
//
// Uso (raiz do repositório):
//   set -a && . ./.env.local && set +a
//   npx -y tsx --tsconfig tsconfig.json scripts/agent-sim/ask.ts <pt|he> "pergunta 1" "pergunta 2" ...
// pt = conversa-sandbox do dono (português); he = cliente israelense (hebraico).
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { agentCartLink, buildAgentContext, decideAgentReply, loadRecoverySettings } from "@/lib/recovery/agent";
import { scriptStepsFromNotes, type AgentHistoryEntry } from "@/lib/recovery/agent-prompt";
import type { RecoveryRow } from "@/lib/recovery/types";

const STORE = "COLE-AQUI-O-ID-DA-LOJA";
const mode = (process.argv[2] ?? "pt") as "pt" | "he";
const questions = process.argv.slice(3);
if (questions.length === 0) throw new Error("uso: ask.ts <pt|he> \"pergunta\" ...");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const settings = await loadRecoverySettings(admin as never, STORE);
  if (!settings) throw new Error("sem configuração da loja");
  const { data: models } = await admin.from("cart_recoveries").select("*").eq("store_id", STORE).eq("language", "he").not("checkout_id", "like", "sandbox:%").order("abandoned_at", { ascending: false }).limit(1);
  const model = (models ?? [])[0] as RecoveryRow;
  const owner = mode === "pt";
  const rec: RecoveryRow = { ...model, id: randomUUID(), first_name: owner ? "Ian" : "מיכל", last_name: null, phone: "+972500000000", email: null, language: owner ? "pt" : "he", country_code: owner ? "BR" : "IL", status: "ativo", wa_step: owner ? 99 : 1, email_step: 1, offered_discount_code: null, offered_discount_percent: null, tags: [], agent_mode: "agente", needs_human: false, last_inbound_at: null, waha_session: null, checkout_id: owner ? `sandbox:${STORE}` : model.checkout_id };
  const base = await buildAgentContext(admin as never, rec, settings);
  const regua = owner ? "Oii Ian, consigo falar com você? É importante." : "היי מיכל, אפשר לדבר איתך רגע? זה חשוב.";
  const hist: AgentHistoryEntry[] = [
    { author: "regua", body: regua, at: null },
    { author: "cliente", body: owner ? "Oi" : "היי", at: null },
    { author: "agente", body: owner ? "Oi Ian, tudo bem? Eu sou a Yael do time da Olavita.\n\nVi que você deixou no carrinho o kit com 3 unidades do complexo de peptídeos Olavita Tri-Lift, com 1 pote de brinde e um presente surpresa, e vi que não finalizou, aconteceu algo? 😕\n\nComo o seu pedido já está reservado e em preparação, eu falei com o meu gerente e ele liberou uma condição especial para você..." : "היי מיכל, מה שלומך? אני יעל מהצוות של Olavita.\n\nראיתי שהשארת בעגלה ערכה, ושלא סיימת את ההזמנה, קרה משהו? 😕", at: null },
    { author: "cliente", body: owner ? "Sim manda" : "כן תשלחי", at: null },
    { author: "agente", body: owner ? "Consegue fazer o pagamento agora?\n\nPergunto porque temos apenas mais 3 links promocionais.\n\nSegue o link com o seu desconto exclusivo: https://go.skininsiderdaily.com/QJXEjS3\n\nMe manda o comprovante para eu já liberar o seu envio? Corre, se não expira." : "אפשר לשלם עכשיו? הנה הלינק: https://go.skininsiderdaily.com/QJXEjS3", at: null },
  ];
  // AFTER_CLAIM=1: a conversa já tem "Já fiz o pagamento" e o pedido de comprovante (testa a marca que gruda).
  if (process.env.AFTER_CLAIM) hist.push({ author: "cliente", body: owner ? "Já fiz o pagamento" : "שילמתי כבר", at: null }, { author: "agente", body: owner ? "Ainda não apareceu aqui no sistema, mas às vezes leva alguns minutinhos para aparecer. Pode me mandar o comprovante, um print do pagamento, para eu conferir? 😉" : "עדיין לא רואה את התשלום אצלי במערכת, לפעמים לוקח כמה דקות עד שזה מופיע. אפשר לשלוח לי אישור תשלום, צילום מסך, כדי שאבדוק? 😉", at: null });
  const purchase = { state: (process.env.PURCHASE ?? "nao_encontrado") as "pago" | "nao_encontrado" | "desconhecido", order: process.env.PURCHASE === "pago" ? "#4150" : null };
  // FLOW=1: conversa sequencial a partir da abertura da régua (testa o roteiro em código).
  if (process.env.FLOW) {
    const flow: AgentHistoryEntry[] = [{ author: "regua", body: regua, at: null }];
    // REGUA15=1: a cliente responde à mensagem automática dos 15% (o cupom já foi oferecido).
    let stepsSent: string[] = [];
    let offeredPercent = process.env.REGUA15 ? 5 : 0;
    let offeredCode: string | null = process.env.REGUA15 ? "VOLTA15" : null;
    if (process.env.REGUA15) flow.push({ author: "regua", body: owner ? "Ian, consegui uma condição especial para o pedido que você iniciou. Consegui liberar mais 15% de desconto para você finalizar sua compra. Quer que eu te mande o link já com o desconto aplicado?" : "מיכל, הצלחתי להשיג לך תנאי מיוחד על ההזמנה שהתחלת. שחררתי לך עוד 15% הנחה כדי לסיים את הרכישה. רוצה שאשלח לך את הלינק עם ההנחה כבר בפנים?", at: null });
    for (const q of questions) {
      flow.push({ author: "cliente", body: q, at: null });
      const ctx = { ...base, purchase, history: [...flow], latestMessage: q, agentMessageCount: flow.filter((m) => m.author === "agente").length, offeredPercent, offeredCode, cartLink: agentCartLink(rec.id, 1, offeredCode), scriptStepsSent: stepsSent };
      const d = await decideAgentReply(ctx);
      if (d.action === "offer_discount" && d.discount_code) {
        offeredPercent = d.discount_percent ?? 5;
        offeredCode = d.discount_code;
      }
      if (d.reply) flow.push({ author: "agente", body: d.reply, at: null });
      stepsSent = [...new Set([...stepsSent, ...scriptStepsFromNotes(d.notes)])];
      console.log(`\nCLIENTE: ${q}\nYAEL (${d.action}${d.handoff_reason ? `, handoff: ${d.handoff_reason}` : ""}): ${d.reply.replace(/https?:\/\/\S+/g, "[link]")}\n  notas: ${d.notes.join(" | ")}`);
    }
    return;
  }
  for (const q of questions) {
    const ctx = { ...base, purchase, history: [...hist, { author: "cliente", body: q, at: null } as AgentHistoryEntry], latestMessage: q, agentMessageCount: 3, offeredPercent: 5, offeredCode: "VOLTA15", cartLink: agentCartLink(rec.id, 1, "VOLTA15") };
    const d = await decideAgentReply(ctx);
    console.log(`\nCLIENTE: ${q}\nYAEL (${d.action}${d.handoff_reason ? `, handoff: ${d.handoff_reason}` : ""}): ${d.reply}\n  notas: ${d.notes.join(" | ")}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
