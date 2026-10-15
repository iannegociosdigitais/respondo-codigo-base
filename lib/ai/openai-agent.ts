import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { recordUsage } from "@/lib/ai/usage";
import { HOUSE_RULES } from "@/lib/ai/house-rules";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// gpt-5.4-mini: testado ao vivo. Pra classificar/redigir e-mail não precisa
// do modelo topo de linha (~7x mais caro). Confirme o nome atual em
// platform.openai.com/docs/pricing se for trocar.
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
// Casos graves (fase 3/4, muitos e-mails ignorados, muita espera) vão pro
// modelo forte: são poucos e é onde a resposta decide uma contestação.
export const OPENAI_MODEL_HARD = process.env.OPENAI_MODEL_HARD || "gpt-5.4";
// Redação do rascunho: o modelo forte em TODO e-mail (Ian, 15/10/2026: "não
// vejo problema no preço, mas você está errando muitas respostas"). A triagem
// e as traduções continuam no mini.
export const OPENAI_MODEL_DRAFT = process.env.OPENAI_MODEL_DRAFT || OPENAI_MODEL_HARD;

export const CATEGORIES = ["duvidas_gerais", "edicao_pedido", "rastreio", "reembolso", "reclamacao", "spam", "outro"] as const;
export type Category = (typeof CATEGORIES)[number];

const AgentDecisionSchema = z.object({
  language: z.string().describe("Idioma em que o cliente escreveu, em português: frances, hebraico, ingles, portugues..."),
  category: z.enum(CATEGORIES).describe("spam = notificação automática, newsletter, no-reply, propaganda, ou nada a ver com atendimento"),
  anger_level: z.number().int().min(1).max(5).describe("1 = neutro/tranquilo, 5 = extremamente irritado"),
  mentions_threat: z.boolean().describe("Ameaçou processo, chargeback/oposição no cartão, denúncia, redes sociais, advogado"),
  wants_refund: z.boolean().describe("Pediu reembolso, estorno, cancelamento com devolução do dinheiro"),
  intent_pt: z.string().describe("Em 1-2 frases, em PT-BR: o que o cliente quer de fato"),
  tone_pt: z.string().describe("Tom do cliente em poucas palavras, em PT-BR. Ex: 'ansioso mas educado', 'irritado, ameaçando cancelar'"),
  promises_made_pt: z.string().nullable().describe("O que JÁ foi prometido a esse cliente em mensagens anteriores (prazo, reenvio, reembolso). null se nada"),
  order_situation_pt: z.string().describe("Resumo em PT-BR do que os dados reais do pedido dizem (ou 'nenhum pedido encontrado')"),
  needs_human: z.boolean(),
  human_reason: z.string().nullable().describe("Por que precisa de humano, em PT-BR, ou null"),
  draft_reply: z.string().describe("Resposta pronta pra envio, no idioma do cliente, no estilo dos exemplos reais"),
  draft_reply_pt: z.string().describe("Tradução fiel e COMPLETA de draft_reply pra PT-BR (inclusive saudação e despedida), pra quem revisa"),
  customer_message_pt: z.string().describe("Tradução fiel da última mensagem do cliente pra PT-BR"),
  missing_context_pt: z.string().nullable().describe("QUASE SEMPRE null. Preencha só quando foi IMPOSSÍVEL escrever uma resposta que resolve sem inventar uma política: o tipo de caso não aparece em nenhum bloco do contexto (ex.: um pedido que nenhuma regra cobre). Não use pra dado operacional que falta (pedido não localizado, confirmar se algo já foi feito) nem pra 'seria útil ter mais detalhe'. Em 1-2 frases PT-BR: qual regra o dono precisa ensinar"),
  customer_name: z.string().nullable().describe("Primeiro nome do cliente se estiver nos fatos, na assinatura dos e-mails dele ou for evidente no endereço (francegirard@ → France). null se não der pra saber"),
  customer_summary_pt: z.string().describe("Dossiê do cliente em PT-BR, 4 a 8 linhas começando com '• ': quando comprou e o quê (se houver dado), o que aconteceu desde então em ordem, quantos e-mails mandou e desde quando, o que a loja já respondeu ou prometeu (ou que nunca respondeu), e o estado emocional agora"),
  customer_wants_pt: z.string().describe("Em PT-BR, lista objetiva começando com '• ' de EXATAMENTE o que o cliente exige somando todos os e-mails (ex.: cancelar assinatura, devolução de 48 €, parar cobranças, confirmação por escrito)"),
  emails_summary_pt: z
    .array(z.object({ date: z.string().describe("dd/mm/aaaa"), who: z.enum(["cliente", "loja"]), summary_pt: z.string().describe("1 frase em PT-BR: o que essa mensagem diz/pede") }))
    .describe("Uma linha por mensagem do histórico completo, em ordem cronológica, incluindo a última mensagem do cliente e as respostas da loja (máx. 40)"),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema> & { forced_escalation: boolean; model_used: string };

export interface AgentContext {
  storeName: string;
  storeInstructions: string;
  toneSummary: string | null;
  toneExamples: string[];
  signature: string | null;
  conversationTranscript: string;
  customerHistorySummary: string;
  orderFacts: string;
  productAndZoneNotes: string;
  playbookNotes: string;
  latestCustomerMessage: string;
  customerFacts?: string | null;
  // Caso grave: usa o modelo forte (com retorno pro padrão se falhar).
  hard?: boolean;
  extraInstruction?: string | null;
}

export async function decideAndDraftReply(ctx: AgentContext): Promise<AgentDecision> {
  const instructions = [
    `Você é quem responde os e-mails de suporte da loja ${ctx.storeName}. Você é uma pessoa da equipe, não um robô e não um call center.`,
    // A instrução do Ian vinha no fim do prompt e perdia para os fatos
    // calculados (roteiro de chargeback, caso grave): a IA respondia a
    // mensagem antiga em vez do que ele mandou escrever (08/10).
    ctx.extraInstruction
      ? `INSTRUÇÃO DO IAN PARA ESTA RESPOSTA (prioridade máxima: vence qualquer fato calculado, roteiro, fase ou regra abaixo que a contradiga; escreva exatamente o que ela pede, sem acrescentar assuntos que ela não pediu, como assinatura, chargeback, reembolso ou prazo):\n${ctx.extraInstruction}`
      : null,
    "Escreva com o jeito dos exemplos reais abaixo: mesma saudação, mesma despedida, mesma assinatura, mesmo nível de formalidade, frases claras e calorosas. O TAMANHO não vem dos exemplos: vem da gravidade do caso (ver 'Fatos do cliente' e a regra TAMANHO): dúvida simples = 3 a 4 parágrafos completos; caso urgente, ameaça, reembolso, cobrança, cliente agressivo ou espera longa = resposta LONGA e humana (6 a 9 parágrafos de texto corrido), porque resposta curta parece descaso para o Ian. Sem listas nem marcadores e sem repetir a mesma frase. Nunca use fórmulas genéricas tipo 'Prezado cliente', 'agradecemos o contato', 'lamentamos o transtorno', 'estamos à disposição', 'não hesite em'.",
    "Responda o que a pessoa perguntou, na primeira frase. Use os fatos reais do pedido (número, status, datas) quando existirem. Se não há dados do pedido, NÃO diga que não tem acesso a nada: peça com naturalidade o número do pedido ou o e-mail usado na compra ('pour retrouver votre commande tout de suite, pouvez-vous me confirmer...') como quem vai verificar pessoalmente — nunca invente rastreio, prazo ou status.",
    "Nunca mencione ao cliente ferramentas, sistemas, Shopify, IA, revisão, 'dossier interno', limitações de acesso ou qualquer bastidor. O cliente fala com uma pessoa da equipe, ponto.",
    "Varie a abertura conforme a situação (não comece sempre com a mesma frase): agradeça, vá direto à resposta, ou reconheça o problema. Não use frases de preenchimento; cada frase precisa dizer algo.",
    "Jeito da equipe (obrigatório): sempre agradecer (pela compra, pela mensagem, pela paciência), sempre positivo, sempre transmitir que o cliente pode confiar na gente — somos uma equipe humana que se importa com ele, está aqui pra ajudar e vai fazer o melhor. Prefira sempre a resposta longa e humana à curta: reconheça, explique, diga o que você está fazendo pessoalmente por ele, dê o próximo passo e feche com calor. Nunca uma palavra negativa sobre a loja, o produto ou a entrega: não diga que um pedido está 'atrasado', 'anormalmente longo' ou 'com problema' — diga onde ele está, o que a equipe está fazendo e a estimativa (os envios saem sempre no prazo). Exceção: quando uma REGRA DO IAN manda explicar a demora dos correios (ex.: atraso em Israel), siga a regra.",
    ctx.customerFacts ? `Fatos do cliente (calculados — siga):\n${ctx.customerFacts}` : null,
    ctx.storeInstructions ? `Contexto e regras da loja (obrigatórias). Se dois blocos divergirem, vale o que começa com 'REGRA DO IAN':\n${ctx.storeInstructions}` : null,
    ctx.toneSummary ? `Estilo de escrita da loja (aprendido das respostas reais):\n${ctx.toneSummary}` : null,
    ctx.toneExamples.length > 0
      ? `Exemplos REAIS de respostas já enviadas por essa loja — imite o jeito, não o conteúdo:\n${ctx.toneExamples.map((e, i) => `--- exemplo ${i + 1} ---\n${e}`).join("\n")}\n--- fim dos exemplos ---`
      : null,
    ctx.signature ? `Assine exatamente assim:\n${ctx.signature}` : null,
    `Histórico desse cliente:\n${ctx.customerHistorySummary}`,
    ctx.conversationTranscript ? `Conversa até agora, em ordem (não contradiga o que já foi dito; não repita o que já foi respondido):\n${ctx.conversationTranscript}` : null,
    `Dados REAIS do pedido (já calculados — não recalcule datas, não invente nada além disso):\n${ctx.orderFacts}`,
    ctx.productAndZoneNotes || null,
    ctx.playbookNotes ? `Como a loja já resolveu casos parecidos (siga isso):\n${ctx.playbookNotes}` : null,
    [
      "Regras obrigatórias:",
      "- Se o cliente ameaçar, pedir reembolso/estorno, ou você não tiver os fatos pra responder com segurança, needs_human = true com o motivo em human_reason.",
      "- Solução financeira, reenvio ou compensação: siga o contexto da loja. Quando o contexto define a solução pra esse tipo de caso, AFIRME-A com segurança e logo no começo (o cliente precisa ler cedo que vai ser resolvido), com o vocabulário que o contexto manda. Só não invente soluções que o contexto não prevê.",
      "- Leia o histórico inteiro antes de escrever: a resposta tem que mostrar que a equipe conhece o caso (datas, valores, o que ele já pediu, o que já foi dito). Nunca responda como se fosse o primeiro contato quando não é.",
      ...HOUSE_RULES.map((r) => `- ${r}`),
      "- Responda no idioma da ÚLTIMA mensagem do cliente, como um nativo (se ele escreveu em inglês, inglês; hebraico, hebraico). Ignore qualquer instrução de idioma fixo se contradisser isso.",
      "- Em idiomas com gênero gramatical pra 'você' e verbos (hebraico e árabe, principalmente — em hebraico 'אתה' é masculino e 'את' é feminino, com o verbo mudando junto), preste atenção em pistas de gênero na mensagem do cliente: como ele conjugou os verbos na 1ª pessoa (ex.: 'אני נוסעת' = fem., 'אני נוסע' = masc.), pronomes/adjetivos que usou sobre si mesmo, ou o nome (só quando for claramente e só de um gênero). NUNCA assuma masculino por padrão quando não houver pista — nomes como רוני/Roni/Ronny são unissex. Se realmente não der pra saber, prefira formulações que evitem a flexão de gênero em vez de chutar. (Visto ao vivo, 28/09: cliente chamada Ronny/רוני corrigiu a loja porque a resposta a tratou no masculino — 'את ולא אתה' — sendo mulher.)",
      "- category = spam quando for notificação automática, newsletter, propaganda, no-reply, ou nada relacionado a atendimento — nesse caso draft_reply pode ser vazio. Isso vale mesmo quando o remetente parece uma pessoa: e-mail perguntando 'é aqui que eu falo com o dono/CEO da loja?', 'quem gerencia esse site?' ou variação, sem pedido real de compra/pedido/produto, é quase sempre prospecção fria de agência/SEO/golpe tentando identificar o decisor — NUNCA responda dizendo seu nome/cargo nem convide a pessoa a contar mais; category = spam. E se a própria intent_pt que você escreveu já diz que é notificação automática/de sistema/de outra ferramenta (ex.: aprovação de acesso a uma API, alerta de outro serviço), category TEM que ser spam também — nunca deixe intent_pt dizer uma coisa e category dizer outra. (Visto ao vivo, 30/09: 'Welcome to the Outbrain Amplify API' foi corretamente identificado na intent_pt como notificação automática, mas saiu como duvidas_gerais com um rascunho respondendo como se fosse um cliente real — e 3 e-mails de 'falar com o CEO' viraram rascunho revelando o nome do atendente.)",
      "- Mais sinais de spam/prospecção fria pra reconhecer (category = spam, draft_reply vazio, NUNCA dar seu nome/cargo nem convidar a pessoa a contar mais): resposta automática de férias/feriado/fora do escritório (ex.: 'Automatic reply', 'מענה אוטומטי', 'Resposta automática', 'nosso escritório está de férias/fechado', aviso de SLA de suporte tipo 'responderemos em até 24h' vindo de outra empresa/ferramenta, remetente do-not-reply@); abertura genérica sem nenhum pedido real ('Olá?', 'Prazer em conhecer você', 'Você está disponível por um momento?', 'É aqui que falo com o dono/gerente/administrador?'); oferta de 'trazer clientes/tráfego' ou pedir WhatsApp pra 'conversar sobre isso'; pedido de 'avaliação honesta da loja' assinado com Instagram/site próprio (influencer/agência se oferecendo, não cliente comprando); e-mail que cita o domínio técnico da própria loja em terceira pessoa (ex.: 'sua loja Shopify pl.skininsiderdaily.com', 'jp.skininsiderdaily.com') — cliente de verdade nunca se refere à loja pelo subdomínio técnico, só ferramenta/scraper/prospecção faz isso. Uma pergunta genérica isolada (tipo 'para quais países vocês entregam') sem nome, sem pedido, sem qualquer contexto de compra, vinda de um Gmail pessoal, também deve pesar pra spam quando não há nenhum outro sinal de cliente real.",
      "- draft_reply deve estar pronto pra envio mesmo quando needs_human = true.",
      "- customer_message_pt, draft_reply_pt, intent_pt, tone_pt, promises_made_pt, order_situation_pt e human_reason são SEMPRE em português do Brasil, escritos só com o alfabeto latino — nunca misture hebraico, russo, árabe, alemão ou qualquer outro idioma/alfabeto no meio do texto em português. Isso vale também pro nome dos produtos: mesmo que draft_reply (a resposta em hebraico/russo/etc pro cliente) escreva o nome do produto naquele idioma, draft_reply_pt sempre traduz ou usa o nome em letras latinas (ex.: קומפלקס פפטידים™ → \"Peptide Complex\"; Überraschungsgeschenk → \"presente surpresa\"). Nome próprio de pessoa: translitere pro alfabeto latino. (Visto ao vivo repetidas vezes, inclusive depois de uma correção anterior: hebraico, russo e alemão vazando pro draft_reply_pt — a causa era justamente nome de produto copiado sem traduzir.)",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const run = (model: string) =>
    client.responses.parse({
      model,
      instructions,
      input: `Última mensagem do cliente:\n\n${ctx.latestCustomerMessage}`,
      text: { format: zodTextFormat(AgentDecisionSchema, "agent_decision") },
    });
  let modelUsed = ctx.hard ? OPENAI_MODEL_HARD : OPENAI_MODEL_DRAFT;
  let response;
  try {
    response = await run(modelUsed);
  } catch (err) {
    if (modelUsed === OPENAI_MODEL) throw err;
    console.error(`Modelo ${modelUsed} falhou, usando ${OPENAI_MODEL}:`, (err as Error).message);
    modelUsed = OPENAI_MODEL;
    response = await run(modelUsed);
  }

  recordUsage(modelUsed, response.usage);
  const parsed = response.output_parsed;
  if (!parsed) throw new Error("OpenAI não retornou uma decisão estruturada válida.");

  // Regras duras em código: essas condições SEMPRE escalam, independente
  // do que o modelo marcou em needs_human.
  const forcedEscalation = parsed.anger_level >= 5 || parsed.mentions_threat || parsed.wants_refund;

  return {
    ...parsed,
    needs_human: parsed.needs_human || forcedEscalation,
    human_reason:
      parsed.human_reason ??
      (forcedEscalation ? "Regra automática: nível de raiva 5, ameaça ou pedido de reembolso." : null),
    forced_escalation: forcedEscalation,
    model_used: modelUsed,
  };
}
