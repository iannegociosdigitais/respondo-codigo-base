// Simulação do agente vendedor do WhatsApp: N conversas com clientes
// simuladas (perfis e cenários de scenarios.ts), passando pelo MESMO código de
// produção (buildAgentContext + decideAgentReply, com as travas). Nada é
// enviado e nada é gravado no banco (só leituras: configuração, cupons,
// conhecimento, regras da loja e carrinhos reais como modelo).
//
// Uso (na raiz do repositório):
//   set -a && . ./.env.local && set +a
//   npx tsx --tsconfig tsconfig.json scripts/agent-sim/simulate.ts <pasta-saida> [N=1000] [concorrência=12]
// Retoma de onde parou (pula ids já gravados em <pasta>/results.jsonl).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { agentCartLink, buildAgentContext, decideAgentReply, loadRecoverySettings } from "@/lib/recovery/agent";
import type { AgentContext, AgentHistoryEntry } from "@/lib/recovery/agent-prompt";
import { MAX_REPLY_CHARS, scriptStepsFromNotes } from "@/lib/recovery/agent-prompt";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { recordUsage, trackUsage } from "@/lib/ai/usage";
import type { RecoveryRow } from "@/lib/recovery/types";
import { SCENARIOS, type Scenario } from "./scenarios";

const STORE = "COLE-AQUI-O-ID-DA-LOJA";
const OUT = process.argv[2];
const N = Number(process.argv[3] ?? 1000);
const CONC = Number(process.argv[4] ?? 12);
const CUSTOMER_MODEL = process.env.SIM_CUSTOMER_MODEL || "gpt-5.4-mini";
const JUDGE_MODEL = process.env.SIM_JUDGE_MODEL || "gpt-5.4";
const MAX_CUSTOMER_TURNS = 5;
if (!OUT) throw new Error("uso: simulate.ts <pasta-saida> [N] [concorrência]");
mkdirSync(OUT, { recursive: true });
const RESULTS = `${OUT}/results.jsonl`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// --- Aleatoriedade com semente (cada conversa é reproduzível pelo id) ---------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)];

const FEMALE = ["נועה", "מיכל", "שירה", "רותם", "אורית", "דנה", "ליאת", "מורן", "הילה", "אסנת", "רחל", "שרית", "טל", "סיגל", "אתי", "ענבל", "קרן", "לימור", "גלית", "אילנה", "ורד", "מירי", "אורנה", "חני", "בתיה"];
const MALE = ["דוד", "משה", "אבי", "יוסי", "אלון", "רון", "עמית"];
const RUSSIAN = ["אולגה", "סבטלנה", "אירינה", "נטליה"];
const ARABIC = ["אמל", "סמאח", "רנא"];
const CITIES = ["חיפה", "קריית מוצקין", "ראשון לציון", "באר שבע", "אשדוד", "נתניה", "פתח תקווה", "ירושלים", "חולון", "כרמיאל", "נצרת", "אשקלון"];
const STYLES = [
  "frases curtas, sem pontuação, às vezes com erro de digitação",
  "educada e completa, mas direta",
  "usa muitos emojis e 'חחח'",
  "seca, responde com o mínimo",
  "escreve mensagens longas e conta detalhes da vida",
  "escreve em várias mensagens pequenas, mas aqui junte numa só",
];

const OPENER_HE = (n: string) => `היי ${n}, אפשר לדבר איתך רגע? זה חשוב.`;
const STEP2_HE = (n: string) => `${n}, הצלחתי להשיג לך תנאי מיוחד על ההזמנה שהתחלת. שחררתי לך עוד 44 ₪ הנחה כדי לסיים את הרכישה, כך שההזמנה יוצאת בערך 271 ₪. רוצה שאשלח לך את הלינק עם ההנחה כבר בפנים?`;
const STEP3_HE = (n: string) => `${n}, אני רק מעדכנת כי לא רציתי שתפספסי את התנאי הזה. ההנחה הנוספת שוחררה במיוחד להזמנה שלך, ואחר כך אני לא יכולה להבטיח שהיא עדיין תהיה זמינה. רוצה שאשמור אותה בשבילך?`;

// --- Chamadas com nova tentativa (limite de taxa da OpenAI) -------------------
async function retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let wait = 2000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = status === 429 || (status != null && status >= 500) || /rate limit|timeout|ECONNRESET|fetch failed|overloaded/i.test(msg);
      if (!transient || i >= 6) throw new Error(`${label}: ${msg}`);
      await new Promise((r) => setTimeout(r, wait + Math.random() * 1000));
      wait = Math.min(wait * 2, 60_000);
    }
  }
}

// --- Cliente simulada --------------------------------------------------------
const CustomerSchema = z.object({
  message: z.string().describe("A próxima mensagem da cliente, no idioma dela. Vazia só se ela não responderia mais."),
  message_pt: z.string().describe("Tradução fiel da mensagem para português do Brasil (vazia se message for vazia)."),
  end: z.boolean().describe("true quando a conversa acabaria naturalmente depois desta mensagem (comprou/pagou, se despediu, bloqueou, não responderia mais)."),
});
const LANG_NAME: Record<string, string> = { he: "hebraico coloquial de Israel", en: "inglês", ru: "russo", ar: "árabe" };

async function customerTurn(p: Persona, sc: Scenario, transcript: string) {
  const r = await retry(
    () =>
      openai.responses.parse({
        model: CUSTOMER_MODEL,
        instructions: [
          "Você simula UMA cliente real no WhatsApp para testar uma vendedora. Contexto: a cliente começou uma compra no site da Olavita (creme/adesivos anti-idade 'Olavita Tri-Lift', loja online que vende para Israel) e não finalizou. A vendedora 'Yael', da Olavita, mandou mensagem.",
          `Persona: ${p.name}, ${p.gender === "f" ? "mulher" : "homem"}, ${p.age} anos, mora em ${p.city}. Estilo de escrita: ${p.style}.`,
          `Escreva SEMPRE em ${LANG_NAME[p.lang] ?? p.lang}, como uma pessoa real no WhatsApp (curto, natural).`,
          `Cenário (o que ela quer e como reage): ${sc.brief}`,
          "Regras: escreva só a próxima mensagem dela. Reaja ao que a vendedora disse por último, sem ignorar. Seja realista: nem educada nem colaborativa demais. Não diga que a vendedora falou algo que ela não falou. Quando a conversa acabaria naturalmente, end = true.",
        ].join("\n"),
        input: `CONVERSA ATÉ AGORA:\n${transcript}\n\nEscreva a próxima mensagem da cliente.`,
        text: { format: zodTextFormat(CustomerSchema, "customer") },
      }),
    "cliente",
  );
  recordUsage(CUSTOMER_MODEL, r.usage);
  if (!r.output_parsed) throw new Error("cliente: sem saída");
  return r.output_parsed;
}

// --- Checagens automáticas de cada resposta da vendedora ----------------------
// Ian (10/10) liberou as frases de venda do roteiro dele (pedido reservado e em
// preparação, frete expresso/envio hoje, garantia estendida, maior desconto,
// 3 links, comprovante, expira). Só fica o que continua sendo erro de fato.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["fala em ~90% de desconto", /9\d\s?%|כמעט 90|quase 90/i],
  ["escassez de estoque (não é do roteiro)", /המלאי אוזל|estoque acabando|últimas? unidades/i],
];
const MASC_TO_WOMAN = /(?:^|\s)(?:אתה|תגיד(?!י)|תעדכן(?!י)|תשלח(?!י)|יכול(?!ה)(?:\s|$|\?)|רוצה לשלם\? אתה)/;
const FEM_TO_MAN = /(?:^|\s)(?:את יכולה|תגידי|תעדכני|תשלחי|סיימת\? את)/;

interface Check { rule: string; detail?: string }
function checkReply(reply: string, lang: string, persona: Persona, prev: string[]): Check[] {
  const out: Check[] = [];
  for (const [rule, re] of FORBIDDEN) if (re.test(reply)) out.push({ rule, detail: re.exec(reply)?.[0] });
  if (lang === "he" && portugueseLeak(reply, "he").length > 0) out.push({ rule: "português/alfabeto errado no texto", detail: portugueseLeak(reply, "he").join(", ") });
  if (/[—–]/.test(reply)) out.push({ rule: "travessão" });
  if (/\*\*|^#|^\s*[-•]\s/m.test(reply)) out.push({ rule: "markdown/lista" });
  const size = reply.replace(/https?:\/\/\S+/g, "{{link}}").length;
  if (size > MAX_REPLY_CHARS) out.push({ rule: "longa demais", detail: String(size) });
  if ((reply.match(/\?/g) ?? []).length > 2) out.push({ rule: "perguntas demais", detail: String((reply.match(/\?/g) ?? []).length) });
  if (prev.some((p) => p.slice(0, 80) === reply.slice(0, 80))) out.push({ rule: "repetiu mensagem anterior" });
  if (lang === "he" && persona.gender === "f" && MASC_TO_WOMAN.test(reply)) out.push({ rule: "masculino para mulher", detail: MASC_TO_WOMAN.exec(reply)?.[0] });
  if (lang === "he" && persona.gender === "m" && FEM_TO_MAN.test(reply)) out.push({ rule: "feminino para homem", detail: FEM_TO_MAN.exec(reply)?.[0] });
  return out;
}

// --- Juíza (avalia a conversa inteira) -----------------------------------------
const JudgeSchema = z.object({
  nota: z.number().int().min(1).max(5).describe("1 péssimo, 3 aceitável, 5 excelente (vendedora humana e boa)"),
  seguiu_roteiro: z.boolean(),
  tom_humano: z.number().int().min(1).max(5),
  resultado: z.enum(["comprou_ou_vai_comprar", "pediu_link", "passou_para_humano", "parou_ou_descadastrou", "sem_resolucao"]),
  problemas: z.array(z.object({
    tipo: z.enum(["mentira_ou_promessa_falsa", "inventou_fato", "ignorou_pergunta", "fora_do_roteiro", "tom_robotico", "repetitivo", "insistiu_demais", "nao_parou_quando_pediu", "humano_sem_necessidade", "deveria_passar_para_humano", "idioma_ou_genero", "link_ou_cupom", "formato", "outro"]),
    gravidade: z.enum(["alta", "media", "baixa"]),
    turno: z.number().int(),
    descricao: z.string().describe("em português, curta e concreta"),
  })),
  resumo: z.string().describe("1 frase em português sobre como a vendedora se saiu"),
});
const JUDGE_RULES = `Você avalia a VENDEDORA (Yael, Olavita) numa conversa de recuperação de carrinho pelo WhatsApp, com uma cliente israelense. Avalie só as mensagens da Yael (as da RÉGUA são automáticas e fixas).
O ROTEIRO DO DONO (texto fixo, aprovado por ele; não conta como invenção nem como fora do roteiro):
1) Apresentação: "Oi {nome}, tudo bem? Eu sou a Yael do time da Olavita. Vi que você deixou no carrinho o kit com N unidades do complexo de peptídeos Olavita Tri-Lift, com 1 pote de brinde e um presente surpresa, e vi que não finalizou, aconteceu algo? 😕 Como o seu pedido já está reservado e em preparação, eu falei com o meu gerente e ele liberou uma condição especial para você..."
2) Condição: "Vamos lá! Conversei com ele, expliquei sua situação e a condição que consegui exclusivamente para você é a seguinte: Você já tinha iniciado o pedido com um desconto de X%, certo? Eu consegui um desconto adicional de 15% pra você, então basicamente você vai ter Y% de desconto. É o maior desconto que já fizemos pra alguém. Além disso, eu consigo liberar uma condição de frete expresso, ou seja, como seu pedido já está sendo preparado, conseguimos enviar ainda hoje, e te dar uma garantia estendida. Me fala se essa proposta faz sentido pra você?"
3) Fechamento: "Consegue fazer o pagamento agora? Pergunto porque temos apenas mais 3 links promocionais. Segue o link com o seu desconto exclusivo: [link]. Me manda o comprovante para eu já liberar o seu envio? Corre, se não expira."
Cliente confusa: "Estou falando do kit com N unidades do Olavita Tri Lift. Você iniciou uma compra, mas acabou não finalizando, se lembra? Nós deixamos o seu pedido reservado, mas preciso falar com você."
Retomada: "Oii {nome}, eu acabei de falar com o meu gerente, e como o seu pedido já está reservado e pronto para ser enviado, ele falou que consegue te dar um desconto adicional de 15%, posso te mandar o link?"
A ORDEM do roteiro é do sistema: a 1ª resposta da Yael é sempre a apresentação (1); se a cliente perguntou algo, a resposta curta vem embaixo da apresentação; "sim"/"ok"/"qual a condição" depois da apresentação = condição (2); "sim"/"manda" depois da condição = link (3); perguntas no meio são respondidas e puxam para a próxima etapa. Se a cliente respondeu "sim" à mensagem automática dos 15%, o link (3) vem direto. Os descontos adicionais são ditos como 15%, 25% e 30% (decisão do dono); o valor estimado pode ser dito como "fica em torno de ₪X".
Casos: brava/pede para parar → desculpa e para; já comprou → agradece; suporte de pedido feito → humano; saúde (anticoagulante, gravidez, alergia, pele muito sensível) → "perguntei para a equipe" e humano; Bit/pagamento na entrega → não aceita, pagamento seguro pela Stripe só no site; pede link → manda; "é robô?" → diz que é a assistente virtual da equipe e oferece alguém da equipe.
Fatos que ela pode afirmar (conhecimento do dono): preparo até 3 dias úteis e entrega média de 9 a 12 dias úteis depois do envio; frete grátis; garantia de 90 dias com dinheiro de volta; pagamento seguro pela Stripe; "SP OSTEOPURE" na fatura; SkinInsiderDaily é o sistema que processa os pedidos; kit 3+1 = 4 potes por ₪315 (₪78,75 por pote); pote de 50 ml, camada fina de manhã e à noite; pode guardar na geladeira; entrega em casa, a transportadora liga; não tem telefone; produto com 7 peptídeos para a aparência de rugas, flacidez e textura em rosto, pescoço, colo e braços.
Frases do dono que ela PODE usar (não são mentira nem invenção): pedido reservado e em preparação, frete expresso e envio ainda hoje, garantia estendida, "maior desconto que já fizemos", "só restam 3 links", "corre, se não expira", pedir o comprovante depois do pagamento. PROIBIDO: "quase 90%" ou porcentagem fora de 15/25/30, estoque acabando, resultado garantido, prazo de resultado.
Pagamento: o sistema confere na Shopify. Se a cliente diz que pagou e o pedido NÃO aparece, a vendedora diz que está conferindo, que ainda não encontrou, pergunta o nome e o e-mail usados no pedido e pede o comprovante (texto fixo do dono, correto); se ela informa nome ou e-mail e ainda não aparece, pede o print do comprovante (texto fixo, correto). Se o pedido está CONFIRMADO, ela agradece e responde sem mandar link nem desconto. Confirmar pagamento que a verificação não mostrou é erro grave.
Perguntas sobre ela ela responde sozinha, sem "perguntei para a equipe": de onde fala = faz parte do time de atendimento online da Olavita (número internacional porque o atendimento é online); por que escreveu = a cliente deixou o pedido no carrinho e ela quis ajudar (pede desculpa pelo horário se for tarde ou madrugada); presente surpresa = uma surpresa que vai junto; e-mail da equipe = help@skininsiderdaily.com. Ela não inventa cidade, país nem endereço. "Perguntei para a equipe" só vale para fato do produto, da empresa ou do pedido que ela não tem.
Formato: WhatsApp, parágrafos curtos, hebraico natural, feminino para mulher e masculino para homem, sem português para a cliente. Responder no idioma em que a cliente escreve.`;

async function judge(transcriptPt: string) {
  const r = await retry(
    () =>
      openai.responses.parse({
        model: JUDGE_MODEL,
        instructions: JUDGE_RULES,
        input: `CONVERSA (com tradução em português entre colchetes):\n${transcriptPt}\n\nAvalie a Yael.`,
        text: { format: zodTextFormat(JudgeSchema, "avaliacao") },
      }),
    "juíza",
  );
  recordUsage(JUDGE_MODEL, r.usage);
  return r.output_parsed;
}

// --- Uma conversa ----------------------------------------------------------------
interface Persona { name: string; gender: "f" | "m"; age: number; city: string; style: string; lang: string }
interface Turn { who: "regua" | "cliente" | "agente"; text: string; pt?: string; action?: string; notes?: string[]; handoff_reason?: string | null; checks?: Check[]; retomada?: boolean }

// Rodadas por peso: as primeiras conversas cobrem todos os cenários (piloto),
// depois os de peso maior aparecem mais.
const BAG: Scenario[] = (() => {
  const bag: Scenario[] = [];
  const maxW = Math.max(...SCENARIOS.map((s) => s.weight));
  for (let round = 1; round <= maxW; round++) for (const s of SCENARIOS) if (s.weight >= round) bag.push(s);
  return bag;
})();
function scenarioFor(i: number): Scenario {
  return BAG[i % BAG.length];
}

async function runOne(i: number, carts: RecoveryRow[], baseSettings: NonNullable<Awaited<ReturnType<typeof loadRecoverySettings>>>) {
  const r = rng(1000 + i * 7919);
  const sc = scenarioFor(i);
  const lang = sc.lang ?? "he";
  const gender: "f" | "m" = sc.id === "homem" || sc.id === "marido" ? "m" : r() < 0.08 ? "m" : "f";
  const name = lang === "ru" ? pick(r, RUSSIAN) : lang === "ar" ? pick(r, ARABIC) : gender === "m" ? pick(r, MALE) : pick(r, FEMALE);
  const persona: Persona = { name, gender, age: 28 + Math.floor(r() * 40), city: pick(r, CITIES), style: pick(r, STYLES), lang };
  const cart = pick(r, carts);
  const rec: RecoveryRow = { ...cart, id: randomUUID(), first_name: name, last_name: null, phone: "+972500000000", email: null, language: "he", country_code: "IL", status: "ativo", wa_step: 1, email_step: 1, offered_discount_code: null, offered_discount_percent: null, tags: [], agent_mode: "agente", needs_human: false, last_inbound_at: null, waha_session: null };
  const ctx: AgentContext = await retry(() => buildAgentContext(admin as never, rec, baseSettings), "contexto");
  ctx.purchase = { state: sc.purchase ?? "nao_encontrado", order: sc.purchase === "pago" ? "#4150" : null };

  const turns: Turn[] = [{ who: "regua", text: OPENER_HE(name) }];
  const history: AgentHistoryEntry[] = [{ author: "regua", body: OPENER_HE(name), at: null }];
  const entry = sc.entry ?? "abertura";
  if (entry === "oferta15" || entry === "escassez") {
    turns.push({ who: "regua", text: STEP2_HE(name) });
    history.push({ author: "regua", body: STEP2_HE(name), at: null });
    ctx.offeredPercent = 5;
    ctx.offeredCode = "VOLTA15";
    ctx.cartLink = agentCartLink(rec.id, 1, "VOLTA15");
  }
  if (entry === "escassez") {
    turns.push({ who: "regua", text: STEP3_HE(name) });
    history.push({ author: "regua", body: STEP3_HE(name), at: null });
  }

  const transcript = () => turns.map((t) => `${t.who === "cliente" ? "CLIENTE" : t.who === "agente" ? "YAEL" : "YAEL (mensagem automática)"}: ${t.text}`).join("\n");
  let agentReplies = 0;
  let ended = "";
  for (let k = 0; k < MAX_CUSTOMER_TURNS && !ended; k++) {
    // Cliente some: testa a retomada (o agente fala sem mensagem nova).
    if (sc.silenceAfter != null && agentReplies >= sc.silenceAfter) {
      ctx.history = [...history];
      ctx.latestMessage = "";
      ctx.agentMessageCount = turns.filter((t) => t.who === "agente").length;
      const d = await retry(() => decideAgentReply(ctx), "agente");
      const prev = turns.filter((t) => t.who === "agente").map((t) => t.text);
      turns.push({ who: "agente", text: d.reply, pt: d.reply_pt, action: d.action, notes: d.notes, handoff_reason: d.handoff_reason, checks: checkReply(d.reply, d.language, persona, prev), retomada: true });
      ended = "silencio";
      break;
    }
    const c = await customerTurn(persona, sc, transcript());
    if (!c.message.trim()) {
      ended = "cliente_parou";
      break;
    }
    turns.push({ who: "cliente", text: c.message, pt: c.message_pt });
    history.push({ author: "cliente", body: c.message, at: null });
    ctx.history = [...history];
    ctx.latestMessage = c.message;
    ctx.agentMessageCount = turns.filter((t) => t.who === "agente").length;
    const d = await retry(() => decideAgentReply(ctx), "agente");
    const prev = turns.filter((t) => t.who === "agente").map((t) => t.text);
    turns.push({ who: "agente", text: d.reply, pt: d.reply_pt, action: d.action, notes: d.notes, handoff_reason: d.handoff_reason, checks: checkReply(d.reply, d.language, persona, prev) });
    if (d.reply) history.push({ author: "agente", body: d.reply, at: null });
    ctx.scriptStepsSent = [...new Set([...(ctx.scriptStepsSent ?? []), ...scriptStepsFromNotes(d.notes)])];
    agentReplies += 1;
    if (d.action === "offer_discount" && d.discount_code) {
      ctx.offeredPercent = d.discount_percent ?? 5;
      ctx.offeredCode = d.discount_code;
      ctx.cartLink = agentCartLink(rec.id, 1, d.discount_code);
    }
    if (["handoff", "stop", "bought", "not_interested"].includes(d.action)) ended = d.action;
    else if (c.end) ended = "cliente_encerrou";
  }

  const transcriptPt = turns
    .map((t, idx) => `[${idx}] ${t.who === "cliente" ? "CLIENTE" : t.who === "agente" ? `YAEL${t.retomada ? " (retomada após silêncio)" : ""}${t.action ? ` (ação: ${t.action})` : ""}` : "RÉGUA"}: ${t.text}${t.pt ? `\n    [${t.pt}]` : ""}`)
    .join("\n");
  const verdict = await judge(`Cenário de teste: ${sc.label}. Verificação de compra na Shopify: ${ctx.purchase?.state ?? "nao_encontrado"}. Cliente: ${persona.gender === "f" ? "mulher" : "homem"}. Carrinho: ${ctx.productSummary ?? "?"}; desconto que já tinha: ${ctx.appliedPercent ?? "?"}%; total com o adicional: ${ctx.totalDiscountPhrase ?? "?"}.\n\n${transcriptPt}`);
  const actions = turns.filter((t) => t.who === "agente").map((t) => t.action ?? "");
  const expectMiss = sc.expect && !sc.expect.some((a) => actions.includes(a)) ? `esperado ${sc.expect.join("/")}, veio ${actions.join(",") || "nada"}` : null;
  const mustNotHit = (sc.mustNot ?? []).filter((a) => actions.includes(a));
  return { i, scenario: sc.id, label: sc.label, persona, cart: ctx.productSummary, applied: ctx.appliedPercent, total: ctx.totalDiscountPhrase, entry, ended, turns, actions, expectMiss, mustNotHit, judge: verdict };
}

async function main() {
  const done = new Set<number>();
  if (existsSync(RESULTS)) for (const line of readFileSync(RESULTS, "utf8").split("\n")) if (line.trim()) done.add(JSON.parse(line).i);
  const settings = await loadRecoverySettings(admin as never, STORE);
  if (!settings) throw new Error("sem configuração da loja");
  const { data: carts, error } = await admin.from("cart_recoveries").select("*").eq("store_id", STORE).eq("language", "he").not("checkout_id", "like", "sandbox:%").order("abandoned_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const todo = Array.from({ length: N }, (_, i) => i).filter((i) => !done.has(i));
  console.log(`simulando ${todo.length} conversas (${done.size} já feitas), concorrência ${CONC}`);
  let cursor = 0;
  let finished = 0;
  let cost = 0;
  const started = Date.now();
  async function worker() {
    while (cursor < todo.length) {
      const i = todo[cursor++];
      try {
        const { result, usage } = await trackUsage(() => runOne(i, carts as RecoveryRow[], settings!));
        cost += usage.cost_usd;
        appendFileSync(RESULTS, JSON.stringify({ ...result, usage }) + "\n");
      } catch (err) {
        appendFileSync(`${OUT}/errors.log`, `${i}\t${err instanceof Error ? err.message : String(err)}\n`);
      }
      finished += 1;
      if (finished % 10 === 0) console.log(`${finished}/${todo.length} · US$ ${cost.toFixed(2)} · ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`FIM: ${finished} conversas · US$ ${cost.toFixed(2)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
