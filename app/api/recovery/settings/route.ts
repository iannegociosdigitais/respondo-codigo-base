import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECOVERY_MISSING_TABLE, type RecoveryDiscount, type RecoveryKnowledge, type RecoverySettings, type WhatsappSessionRow } from "@/lib/recovery/types";
import { normalizePhone } from "@/lib/recovery/phone";
import { marketingConfigured } from "@/lib/email/marketing";
import { sesConfigurationSet } from "@/lib/email/ses";
import { checkSenderDns } from "@/lib/email/deliverability";
import { wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, dbError, errMessage, isValidEmail, jsonError, loadStore, nowIso, parseBody, storeParam } from "@/app/api/recovery/_lib/shared";
import { PERSONAL_ADDRESS_RE } from "@/lib/recovery/engine";

export const maxDuration = 60;

// Configuração da recuperação por loja. GET cria a linha com os padrões do
// banco (tudo desligado, modo de teste) se ainda não existir. PUT aceita só
// os campos editáveis (nunca store_id nem last_*), valida e devolve avisos
// (não bloqueia: o Ian decide, o motor falha fechado de qualquer jeito).
// Única recusa dura: desligar o modo de teste sem remetente ou com DNS do
// remetente incompleto (SPF/DKIM/DMARC): 409 com a lista de problemas.

const PROVIDER_LABEL: Record<RecoverySettings["email_provider"], string> = { resend: "Resend (RESEND_API_KEY)", ses: "Amazon SES (AWS_SES_REGION + credenciais AWS)", activecampaign: "ActiveCampaign (ACTIVECAMPAIGN_API_URL + ACTIVECAMPAIGN_API_KEY)" };

async function loadOrCreateSettings(admin: ReturnType<typeof createAdminClient>, storeId: string): Promise<{ settings: RecoverySettings | null; error: { message: string } | null }> {
  const first = await admin.from("recovery_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (first.error) return { settings: null, error: first.error };
  if (first.data) return { settings: first.data as RecoverySettings, error: null };
  const ins = await admin.from("recovery_settings").upsert({ store_id: storeId }, { onConflict: "store_id", ignoreDuplicates: true });
  if (ins.error) return { settings: null, error: ins.error };
  const again = await admin.from("recovery_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (again.error) return { settings: null, error: again.error };
  return { settings: (again.data as RecoverySettings | null) ?? null, error: null };
}

const providers = () => ({ resend: marketingConfigured("resend"), ses: marketingConfigured("ses"), activecampaign: marketingConfigured("activecampaign"), waha: wahaConfigured() });

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);

  const { settings, error } = await loadOrCreateSettings(admin, storeId);
  if (error) return dbError(error);
  if (!settings) return jsonError("não consegui criar a configuração da loja", 500);

  const [discRes, knowRes, sessRes] = await Promise.all([
    admin.from("recovery_discounts").select("*").eq("store_id", storeId).order("percent", { ascending: true }),
    admin.from("recovery_knowledge").select("*").eq("store_id", storeId).order("created_at", { ascending: true }),
    admin.from("whatsapp_sessions").select("*").eq("store_id", storeId).order("name", { ascending: true }),
  ]);
  if (discRes.error) return dbError(discRes.error);
  if (knowRes.error) return dbError(knowRes.error);
  if (sessRes.error) return dbError(sessRes.error);

  return NextResponse.json({
    settings,
    store,
    discounts: (discRes.data ?? []) as RecoveryDiscount[],
    knowledge: (knowRes.data ?? []) as RecoveryKnowledge[],
    sessions: (sessRes.data ?? []) as WhatsappSessionRow[],
    providers: providers(),
  });
}

const QuietSchema = z.object({
  start: z.number().int().min(0).max(23).optional(),
  end: z.number().int().min(0).max(24).optional(),
  shabbat: z.boolean().optional(),
  tz: z.string().max(64).optional(),
});

// Whitelist dos campos editáveis.
const PutSchema = z.object({
  enabled: z.boolean().optional(),
  email_enabled: z.boolean().optional(),
  whatsapp_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
  agent_enabled: z.boolean().optional(),
  test_mode: z.boolean().optional(),
  test_email: z.string().trim().max(200).optional(),
  test_phone: z.string().trim().max(40).nullable().optional(),
  require_consent: z.boolean().optional(),
  from_name: z.string().trim().max(120).nullable().optional(),
  from_email: z.string().trim().max(200).nullable().optional(),
  reply_to: z.string().trim().max(200).nullable().optional(),
  agent_name: z.string().trim().max(80).nullable().optional(),
  agent_prompt: z.string().max(20000).nullable().optional(),
  agent_max_discount: z.number().min(0).max(90).optional(),
  daily_cap_email: z.number().int().min(0).max(100000).optional(),
  daily_cap_whatsapp: z.number().int().min(0).max(100000).optional(),
  max_days: z.number().int().min(1).max(60).optional(),
  quiet_hours: QuietSchema.nullable().optional(),
  // Pós-compra, provedor e intervalo mínimo (spec v2).
  welcome_enabled: z.boolean().optional(),
  welcome_skip_first_if_receipt: z.boolean().optional(),
  email_provider: z.enum(["resend", "ses", "activecampaign"]).optional(),
  min_gap_hours: z.number().int().min(1).max(168).optional(),
  contact_url: z.string().trim().max(500).nullable().optional(),
  // Idiomas liberados (migration 0021). null ou [] = todos.
  send_languages: z.array(z.string().trim().toLowerCase().regex(/^[a-z]{2}$/)).max(20).nullable().optional(),
});

const HTTP_URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export async function PUT(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const { data, response: bad } = await parseBody(request, PutSchema);
  if (bad) return bad;
  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);

  const now = nowIso();
  const patch: Record<string, unknown> = { ...data, updated_at: now };
  const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
  for (const k of ["from_name", "from_email", "reply_to", "agent_name", "agent_prompt", "test_phone", "contact_url"] as const) {
    if (k in patch) patch[k] = empty(patch[k]);
  }
  if (patch.test_email !== undefined && !isValidEmail(String(patch.test_email))) return jsonError("test_email inválido", 400);
  if (patch.from_email != null && !isValidEmail(String(patch.from_email))) return jsonError("from_email inválido", 400);
  if (patch.reply_to != null && !isValidEmail(String(patch.reply_to))) return jsonError("reply_to inválido", 400);
  // E-mail pessoal do dono nunca vira remetente nem "responder para" de cliente.
  if (PERSONAL_ADDRESS_RE.test(`${patch.from_email ?? ""} ${patch.reply_to ?? ""}`)) return jsonError("Remetente e 'responder para' não podem ser um e-mail pessoal: use o endereço da marca.", 400);
  if (patch.contact_url != null && !HTTP_URL_RE.test(String(patch.contact_url))) return jsonError("contact_url inválido: use um endereço começando com http:// ou https:// (ou deixe vazio)", 400);
  if (patch.test_phone != null) {
    const e164 = normalizePhone(String(patch.test_phone), null);
    if (!e164) return jsonError("test_phone inválido: use o formato internacional (+5511999998888)", 400);
    patch.test_phone = e164;
  }
  if (patch.quiet_hours === null) patch.quiet_hours = { start: 9, end: 21, shabbat: false };

  const { settings: existing, error: loadErr } = await loadOrCreateSettings(admin, storeId);
  if (loadErr) return dbError(loadErr);
  if (!existing) return jsonError("não consegui criar a configuração da loja", 500);

  // Transições que reiniciam o corte de lançamento.
  const leavingTestMode = data.test_mode === false && existing.test_mode;
  const enablingWelcome = data.welcome_enabled === true && !existing.welcome_enabled;

  // Ligar o pós-compra OU sair do modo de teste marca "desde quando": só
  // pedidos feitos DEPOIS entram (ligar hoje não dispara e-mail para quem
  // comprou mês passado, nem ao ir para produção para quem comprou durante o
  // teste). Grava SEMPRE o instante da transição, não só quando vazio.
  if (leavingTestMode || enablingWelcome) patch.welcome_since = now;
  else if (data.welcome_enabled === true && !existing.welcome_since) patch.welcome_since = now;

  // SES em produção sem SES_CONFIGURATION_SET perde bounce e reclamação
  // (o webhook nunca recebe): não deixa sair do modo de teste assim.
  {
    const finalTest = data.test_mode ?? existing.test_mode;
    const finalProvider = (data.email_provider ?? existing.email_provider ?? "resend") as RecoverySettings["email_provider"];
    if ((data.test_mode === false || data.email_provider !== undefined) && !finalTest && finalProvider === "ses" && !sesConfigurationSet()) {
      return jsonError("Com o Amazon SES, a variável SES_CONFIGURATION_SET é obrigatória em produção: sem ela os eventos de bounce e reclamação não chegam ao webhook e a lista de supressão não se alimenta. Configure o configuration set (ver topo de lib/email/ses.ts) e a variável na Vercel; o modo de teste continua ligado.", 409, { problems: ["SES_CONFIGURATION_SET ausente."] });
    }
  }

  if (data.test_mode === false) {
    const fromEmail = (patch.from_email !== undefined ? patch.from_email : existing.from_email) as string | null;
    const provider = (data.email_provider ?? existing.email_provider ?? "resend") as RecoverySettings["email_provider"];
    if (existing.test_mode) {
      // Teste → produção: só com remetente e DNS completo. Nada é salvo se
      // falhar (o Ian corrige o DNS e tenta de novo). Sem cache: é a decisão
      // de ir para produção, vale olhar o DNS de verdade.
      if (!fromEmail) return jsonError("Para desligar o modo de teste, configure antes o remetente (from_email) da loja.", 409, { problems: ["Sem remetente (from_email)."] });
      let dns: Awaited<ReturnType<typeof checkSenderDns>>;
      try {
        dns = await checkSenderDns(fromEmail, { provider, force: true });
      } catch (err) {
        return jsonError(`Não consegui verificar o DNS de ${fromEmail}; modo de teste continua ligado.`, 409, { problems: [`Verificação de DNS falhou: ${errMessage(err)}`] });
      }
      if (!dns.ok) return jsonError(`O remetente ${fromEmail} não passou na verificação de DNS (SPF, DKIM e DMARC precisam existir). Modo de teste continua ligado.`, 409, { problems: dns.problems, needed: dns.needed ?? [], dns });
    }
    // Corte de lançamento: a CADA saída do modo de teste. Só entra carrinho
    // abandonado depois disso (o corte do motor lê production_since). Sem
    // transição (já estava em produção) só preenche se estiver vazio.
    if (leavingTestMode || !existing.production_since) patch.production_since = now;
    // Base da rampa de aquecimento: a data ORIGINAL (migration 0019), que não
    // reinicia. Preenche só quando vazio, com o production_since anterior se
    // existir. Coluna ausente (0019 não rodou) = nem tenta gravar.
    if ("warmup_since" in existing && !existing.warmup_since) patch.warmup_since = existing.production_since ?? now;
  }

  // Runs ativos do pós-compra de pedidos ANTERIORES ao novo corte ficam pausados
  // (nunca saem). Antes de salvar: se falhar, nada muda; se a gravação das
  // configurações falhar depois, os runs ficam pausados (lado seguro).
  if (leavingTestMode || enablingWelcome) {
    const pause = await admin
      .from("post_purchase_runs")
      .update({ status: "pausado", stop_reason: "anterior_ao_lancamento", next_at: null, updated_at: now })
      .eq("store_id", storeId)
      .eq("status", "ativo")
      .lt("purchased_at", now);
    if (pause.error && !RECOVERY_MISSING_TABLE.test(pause.error.message)) return dbError(pause.error);
  }

  let upd = await admin.from("recovery_settings").update(patch).eq("store_id", storeId).select("*").maybeSingle();
  // Coluna warmup_since ainda não existe (migration 0019 não rodou): grava sem ela.
  if (upd.error && "warmup_since" in patch && /warmup_since/i.test(upd.error.message)) {
    const { warmup_since: _ignored, ...withoutWarmup } = patch;
    void _ignored;
    upd = await admin.from("recovery_settings").update(withoutWarmup).eq("store_id", storeId).select("*").maybeSingle();
  }
  if (upd.error) return dbError(upd.error);
  const settings = upd.data as RecoverySettings;

  // Avisos (não bloqueiam).
  const warnings: string[] = [];
  const { data: working } = await admin.from("whatsapp_sessions").select("name").eq("store_id", storeId).eq("active", true).eq("status", "WORKING").limit(1);
  const hasWorking = (working ?? []).length > 0;
  const emailProvider = settings.email_provider ?? "resend";
  if (settings.email_enabled && !settings.from_email) warnings.push("E-mail ligado sem remetente (from_email): nenhum e-mail vai sair.");
  if (settings.email_enabled && !marketingConfigured(emailProvider)) warnings.push(`Provedor ${PROVIDER_LABEL[emailProvider]} não configurado: nenhum e-mail vai sair.`);
  if (settings.email_enabled && !settings.test_mode && emailProvider === "ses" && marketingConfigured("ses") && !sesConfigurationSet()) warnings.push("Amazon SES em produção sem SES_CONFIGURATION_SET: nenhum e-mail vai sair (bounce e reclamação não chegariam ao webhook).");
  if (settings.whatsapp_enabled && !wahaConfigured()) warnings.push("WAHA_URL / WAHA_API_KEY não configurados: nenhum WhatsApp vai sair.");
  if (settings.whatsapp_enabled && !hasWorking) warnings.push("WhatsApp ligado sem nenhum número conectado (sessão WORKING).");
  if (settings.test_mode && settings.whatsapp_enabled && !settings.test_phone) warnings.push("Modo de teste sem test_phone: o WhatsApp não envia nada.");
  if (!settings.test_mode && settings.enabled) warnings.push("Modo de teste DESLIGADO: os envios vão para clientes reais.");
  if (settings.agent_enabled && !settings.whatsapp_enabled) warnings.push("Agente vendedor ligado, mas o canal WhatsApp está desligado: o agente não responde.");
  if (settings.welcome_enabled && !settings.email_enabled) warnings.push("Pós-compra ligado, mas o canal e-mail está desligado: nenhum e-mail de boas-vindas sai.");
  if (settings.welcome_enabled && !settings.enabled) warnings.push("Pós-compra ligado, mas a régua está desligada (chave geral): nada sai.");
  if (settings.welcome_enabled && !settings.contact_url && !settings.reply_to) warnings.push("Pós-compra sem link de contato nem reply-to: o botão \"fale conosco\" usa a caixa conectada da loja (sem caixa, o botão some).");
  if (Number(settings.agent_max_discount) > 0) {
    const { data: coupons } = await admin.from("recovery_discounts").select("percent").eq("store_id", storeId).eq("active", true).lte("percent", Number(settings.agent_max_discount)).limit(1);
    if ((coupons ?? []).length === 0) warnings.push(`Nenhum cupom ativo até ${Number(settings.agent_max_discount)}%: o agente não consegue oferecer desconto.`);
  }
  // Já em produção: DNS do remetente como aviso (o motor adia o envio se
  // faltar algo; aqui só mostra o que falta).
  if (!settings.test_mode && settings.from_email) {
    try {
      const dns = await checkSenderDns(settings.from_email);
      if (!dns.ok) warnings.push(`DNS do remetente ${settings.from_email} incompleto: ${dns.problems.join("; ") || "verifique SPF, DKIM e DMARC"}.`);
    } catch (err) {
      warnings.push(`Não consegui verificar o DNS do remetente: ${errMessage(err)}`);
    }
  }

  return NextResponse.json({ settings, warnings, providers: providers() });
}
