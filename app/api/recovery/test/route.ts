import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { SANDBOX_PREFIX } from "@/lib/recovery/sandbox";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendStepTo } from "@/lib/recovery/engine";
import { fakeWelcomeRun, sendWelcomeStepTo } from "@/lib/recovery/welcome";
import type { PostPurchaseRun, RecoveryRow, RecoverySettings, RecoveryStep } from "@/lib/recovery/types";
import { marketingConfigured } from "@/lib/email/marketing";
import { wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, channelParam, dbError, errMessage, isValidEmail, jsonError, loadStore, nowIso, parseBody, storeParam } from "@/app/api/recovery/_lib/shared";
import { flowParam } from "@/app/api/recovery/_lib/flow";

export const maxDuration = 60;

// "Testar este passo": renderiza o passo com um carrinho (ou pedido, no
// pós-compra) real recente da loja, ou um fictício só em memória, e envia
// SOMENTE para o destino de teste da loja (settings.test_email / test_phone).
// O corpo da requisição NÃO escolhe o destino: body.to é ignorado, senão
// qualquer chamada autenticada mandaria e-mail/WhatsApp de marketing para
// terceiros. is_test = true. Não passa pelos gates de enabled (o
// teste é explícito), mas exige o provedor configurado. O cliente real nunca
// recebe.

// `to` é aceito só por compatibilidade com o painel antigo e IGNORADO.
const BodySchema = z.object({ to: z.string().trim().max(200).optional() });

const LANGS_SAMPLE: Record<string, { first: string; product: string }> = {
  he: { first: "נועה", product: "Olavita Night Cream" },
  fr: { first: "Camille", product: "Crème de nuit Olavita" },
  bg: { first: "Мария", product: "Нощен крем Olavita" },
  hu: { first: "Eszter", product: "Olavita éjszakai krém" },
  ro: { first: "Ana", product: "Cremă de noapte Olavita" },
  tr: { first: "Elif", product: "Olavita Gece Kremi" },
  en: { first: "Emma", product: "Olavita Night Cream" },
};
const countryFor = (language: string) => (language === "he" ? "IL" : language === "fr" ? "FR" : language === "bg" ? "BG" : language === "hu" ? "HU" : language === "ro" ? "RO" : language === "tr" ? "TR" : language === "pt" ? "BR" : "US");

// Carrinho fictício para a prévia quando a loja ainda não tem abandono com
// contato nesse canal. Nunca gravado.
function fakeRecovery(storeId: string, channel: "email" | "whatsapp", language: string, to: string): RecoveryRow {
  const sample = LANGS_SAMPLE[language] ?? LANGS_SAMPLE.en;
  const now = nowIso();
  return {
    id: randomUUID(),
    store_id: storeId,
    checkout_id: "gid://shopify/AbandonedCheckout/0",
    checkout_name: "#TESTE",
    email: channel === "email" ? to : "teste@example.com",
    phone: channel === "whatsapp" ? to : null,
    first_name: sample.first,
    last_name: null,
    locale: null,
    language,
    country_code: countryFor(language),
    city: null,
    currency: language === "he" ? "ILS" : "EUR",
    total: 199,
    subtotal: 199,
    total_discount: 0,
    items: [{ title: sample.product, quantity: 2, variantTitle: null, sku: null, productId: null, variantId: null, unitPrice: "99.50", lineTotal: "199.00", imageUrl: null }],
    discount_codes: [],
    recovery_url: "https://example.com/checkouts/teste",
    email_consent: "SUBSCRIBED",
    sms_consent: "SUBSCRIBED",
    customer_orders_count: 0,
    shopify_customer_id: null,
    abandoned_at: now,
    shopify_updated_at: null,
    completed_at: null,
    status: "ativo",
    step: 0,
    next_send_at: null,
    email_step: 0,
    email_next_at: null,
    wa_step: 0,
    wa_next_at: null,
    agent_mode: "agente",
    needs_human: false,
    needs_human_reason: null,
    waha_session: null,
    whatsapp_exists: null,
    whatsapp_checked_at: null,
    first_contact_at: null,
    last_inbound_at: null,
    last_outbound_at: null,
    unread_count: 0,
    offered_discount_code: null,
    offered_discount_percent: null,
    summary_pt: null,
    tags: [],
    notes: null,
    recovered_order_id: null,
    recovered_order_name: null,
    recovered_at: null,
    recovered_amount: null,
    recovered_currency: null,
    recovered_channel: null,
    recovered_discount_code: null,
    attribution: null,
    stop_reason: null,
    last_event_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const { channel, response: badChannel } = channelParam(request, true);
  if (badChannel || !channel) return badChannel ?? jsonError("channel é obrigatório", 400);
  const { flow, response: badFlow } = flowParam(request);
  if (badFlow || !flow) return badFlow ?? jsonError("flow inválido", 400);
  if (flow === "pos_compra" && channel !== "email") return jsonError("o pós-compra só tem régua de e-mail", 400);
  const { response: bad } = await parseBody(request, BodySchema);
  if (bad) return bad;
  const positionRaw = new URL(request.url).searchParams.get("position");
  const position = positionRaw ? Number(positionRaw) : null;
  if (positionRaw && (!Number.isInteger(position) || (position as number) < 1)) return jsonError("position inválida", 400);

  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);

  const setRes = await admin.from("recovery_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (setRes.error) return dbError(setRes.error);
  let settings = setRes.data as RecoverySettings | null;
  if (!settings) {
    const ins = await admin.from("recovery_settings").upsert({ store_id: storeId }, { onConflict: "store_id", ignoreDuplicates: true });
    if (ins.error) return dbError(ins.error);
    const again = await admin.from("recovery_settings").select("*").eq("store_id", storeId).maybeSingle();
    if (again.error) return dbError(again.error);
    settings = again.data as RecoverySettings | null;
  }
  if (!settings) return jsonError("configuração da loja não encontrada", 500);

  // Provedor do canal: sem ele, nada sai (nem teste).
  const emailProvider = settings.email_provider ?? "resend";
  if (channel === "email" && !marketingConfigured(emailProvider)) return jsonError(emailProvider === "ses" ? "Amazon SES não configurado (AWS_SES_REGION + credenciais AWS): teste de e-mail não enviado." : "RESEND_API_KEY não configurada: teste de e-mail não enviado.", 503);
  if (channel === "whatsapp" && !wahaConfigured()) return jsonError("WAHA não configurado: teste de WhatsApp não enviado.", 503);

  // Destino: SEMPRE o de teste da loja. body.to é ignorado.
  const to: string | null = channel === "email" ? (isValidEmail(settings.test_email) ? settings.test_email.trim().toLowerCase() : null) : settings.test_phone;
  if (!to) return jsonError(channel === "email" ? "sem test_email configurado" : "sem test_phone configurado: defina o telefone de teste na Configuração", 400);

  // Passo: o pedido ou o primeiro ligado do fluxo+canal.
  let stepQuery = admin.from("recovery_steps").select("*").eq("store_id", storeId).eq("flow", flow).eq("channel", channel).order("position", { ascending: true });
  if (position) stepQuery = stepQuery.eq("position", position);
  else stepQuery = stepQuery.eq("enabled", true);
  const stepRes = await stepQuery.limit(1).maybeSingle();
  if (stepRes.error) return dbError(stepRes.error);
  const step = stepRes.data as RecoveryStep | null;
  if (!step) return jsonError(position ? `passo ${position} de ${channel} não existe nesta loja` : `a régua de ${channel} desta loja não tem passos ligados`, 404);

  if (flow === "pos_compra") return testWelcome(admin, { storeId, settings, step, to });

  // Carrinho de exemplo: o mais recente da loja com contato nesse canal, num
  // idioma liberado (send_languages), para o teste sair no idioma que o cliente recebe.
  const langs = (settings.send_languages ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  let sampleQ = admin.from("cart_recoveries").select("*").eq("store_id", storeId).not(channel === "email" ? "email" : "phone", "is", null);
  if (langs.length > 0) sampleQ = sampleQ.in("language", langs);
  const sampleRes = await sampleQ.order("abandoned_at", { ascending: false }).limit(1).maybeSingle();
  if (sampleRes.error) return dbError(sampleRes.error);
  let recovery = sampleRes.data as RecoveryRow | null;
  let fictitious = false;
  if (!recovery) {
    // Sem abandono com contato nesse canal: serve qualquer carrinho real da loja
    // (o destino é o de teste de qualquer jeito, e assim a trava do motor grava).
    const anyRes = await admin.from("cart_recoveries").select("*").eq("store_id", storeId).order("abandoned_at", { ascending: false }).limit(1).maybeSingle();
    if (anyRes.error) return dbError(anyRes.error);
    recovery = anyRes.data as RecoveryRow | null;
  }
  if (!recovery) {
    // Loja sem nenhum carrinho ainda: carrinho fictício, só em memória.
    fictitious = true;
    recovery = fakeRecovery(storeId, channel, "en", to);
  }
  // WhatsApp: com a conversa-sandbox do dono criada (lib/recovery/sandbox),
  // o teste sai por ela. Quando o dono responder, o agente vê na mesma
  // conversa o que a régua já mandou.
  let sandbox: RecoveryRow | null = null;
  if (channel === "whatsapp") {
    const sb = await admin.from("cart_recoveries").select("*").eq("store_id", storeId).eq("checkout_id", `${SANDBOX_PREFIX}${storeId}`).maybeSingle();
    if (sb.data) {
      sandbox = sb.data as RecoveryRow;
      recovery = sandbox;
      fictitious = false;
    }
  }
  // ?lang=pt&name=Ian: o dono testa "como cliente" no idioma dele. Só muda a
  // cópia em memória do carrinho de exemplo (idioma, país e primeiro nome).
  const params = new URL(request.url).searchParams;
  const langOverride = params.get("lang")?.trim().toLowerCase() || (sandbox?.language === "pt" ? "pt" : undefined);
  if (langOverride) {
    if (!/^[a-z]{2}$/.test(langOverride)) return jsonError("lang inválido (2 letras, ex.: pt)", 400);
    recovery = { ...recovery, language: langOverride, country_code: countryFor(langOverride) };
  }
  const nameOverride = params.get("name")?.trim().slice(0, 40);
  if (nameOverride) recovery = { ...recovery, first_name: nameOverride, last_name: null };

  try {
    // Teste em português: nome da atendente em letras latinas (o configurado é hebraico).
    const testSettings = langOverride === "pt" ? { ...settings, agent_name: "Yael" } : settings;
    const result = await sendStepTo(admin, { recovery, step, settings: testSettings, channel, to, isTest: true, allowPt: langOverride === "pt" });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error ?? "o motor recusou o envio de teste", preview: result.preview, to, isTest: true }, { status: 502 });
    // Passo com cupom na conversa-sandbox: o agente passa a saber que o cupom já foi oferecido.
    const pctStep = Number(step.discount_percent ?? 0);
    if (sandbox && pctStep > 0) {
      const { data: d } = await admin.from("recovery_discounts").select("code").eq("store_id", storeId).eq("percent", pctStep).eq("active", true).limit(1).maybeSingle();
      if (d?.code) await admin.from("cart_recoveries").update({ offered_discount_code: d.code, offered_discount_percent: pctStep }).eq("id", sandbox.id);
    }
    // O teste usa um carrinho real, mas tudo que o motor grava nele já sai
    // com is_test = true (evento da trava e linha de whatsapp_messages em
    // deliverWhatsapp), então o chat e a linha do tempo não mostram o teste
    // como se o cliente tivesse recebido. Nada a remarcar aqui.
    return NextResponse.json({ ok: true, isTest: true, flow, preview: result.preview, to, sample: { id: recovery.id, name: [recovery.first_name, recovery.last_name].filter(Boolean).join(" ") || null, language: recovery.language, fictitious } });
  } catch (err) {
    return jsonError(`teste não enviado: ${errMessage(err)}`, 502);
  }
}

// Pós-compra: o pedido mais recente da loja com e-mail (ou um fictício) e o
// envio pelo motor de boas-vindas, só para o destino de teste.
async function testWelcome(admin: ReturnType<typeof createAdminClient>, input: { storeId: string; settings: RecoverySettings; step: RecoveryStep; to: string }) {
  const { storeId, settings, step, to } = input;
  const sampleRes = await admin.from("post_purchase_runs").select("*").eq("store_id", storeId).not("email", "is", null).order("purchased_at", { ascending: false }).limit(1).maybeSingle();
  if (sampleRes.error) return dbError(sampleRes.error);
  let run = sampleRes.data as PostPurchaseRun | null;
  let fictitious = false;
  if (!run) {
    // Loja sem pedido ainda: pedido fictício do próprio motor (só em memória,
    // já enviado e com rastreio para a prévia mostrar todas as variáveis).
    fictitious = true;
    run = fakeWelcomeRun(storeId, "en", to, { fulfilled: true });
  }
  try {
    const result = await sendWelcomeStepTo(admin, { run, step, settings, to, isTest: true });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error ?? "o motor recusou o envio de teste", preview: result.preview, to, isTest: true }, { status: 502 });
    return NextResponse.json({ ok: true, isTest: true, flow: "pos_compra", preview: result.preview, to, sample: { id: run.id, name: [run.first_name, run.last_name].filter(Boolean).join(" ") || null, language: run.language, order: run.order_name, fictitious } });
  } catch (err) {
    return jsonError(`teste não enviado: ${errMessage(err)}`, 502);
  }
}
