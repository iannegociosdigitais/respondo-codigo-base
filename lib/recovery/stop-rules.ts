import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAbandonedCheckoutState, type ShopifyAuth } from "@/lib/shopify/abandoned";
import { fetchPaidOrdersWindow, findCustomerOrdersByPhone, getRecentOrdersByEmail } from "@/lib/shopify/orders";
import { normalizePhone } from "@/lib/recovery/phone";
import { FLOW_PRODUCT_STOP, isFlowProduct, itemTitles } from "@/lib/recovery/product-gate";
import type { RecoveryChannel, RecoveryRow, RecoveryStatus } from "@/lib/recovery/types";

// O "100% de certeza de que não manda se a pessoa comprou". Roda ANTES de
// cada envio, na hora, consultando a Shopify ao vivo (não o cache). Qualquer
// regra que bater = não envia. Em caso de erro na consulta = não envia.
// Sem credencial Shopify DA LOJA do carrinho = não dá pra verificar = não
// envia (erro_na_verificacao). Nunca cai na credencial de outra loja.
//
// Ordem (barata → cara): status, janela, contato, supressão, respondeu,
// checkout mais novo, Shopify (checkout completado), pedido em qualquer loja
// por e-mail e por telefone (depois do abandono, ou pago nas 72 h antes dele:
// 'comprou_antes'), consentimento.
//
// "Respondeu" é por canal:
//  - e-mail: resposta por e-mail = mensagem inbound no Inbox de suporte
//    (messages: direction inbound, from_address = e-mail do carrinho, depois
//    do abandono) ou evento replied de e-mail → parada terminal
//    (parado_respondeu). Resposta no WhatsApp NÃO para o e-mail: quem pausa o
//    e-mail durante a conversa é o webhook do WAHA (email_next_at = null);
//  - WhatsApp: replied de WhatsApp = o agente vendedor cuida; a régua só
//    pausa (cliente_respondeu, não terminal, wa_next_at = null), o status
//    continua ativo.

export type StopReason =
  | "nao_ativo"
  | "janela_expirada"
  | "sem_contato"
  | "suprimido"
  | "respondeu"
  | "cliente_respondeu"
  | "checkout_mais_novo"
  | "comprou_checkout"
  | "comprou_outro_pedido"
  | "comprou_antes"
  | "ja_cliente"
  | "sem_consentimento"
  | "produto_fora_do_fluxo"
  | "erro_na_verificacao";

export type StopCheck = { ok: true } | { ok: false; reason: StopReason; detail?: string; terminal: boolean; patch?: Partial<RecoveryRow> };

// Credencial com a loja dona: a verificação do checkout só vale na Shopify
// certa; a busca de pedidos roda em todas.
export type StoreShopifyAuth = ShopifyAuth & { storeId: string };

// Pra qual status cada motivo leva (terminal = a régua acaba).
const STATUS_FOR: Partial<Record<StopReason, RecoveryStatus>> = {
  janela_expirada: "concluido_sem_compra",
  suprimido: "parado_suprimido",
  respondeu: "parado_respondeu",
  checkout_mais_novo: "substituido",
  comprou_checkout: "recuperado",
  comprou_outro_pedido: "parado_comprou",
  // Pagou ANTES de abrir este checkout: a régua acaba, mas NÃO é recuperação.
  // 'concluido_sem_compra' (já aceito pelo check da 0018, sem migration) fica
  // fora de BOUGHT no painel; stop_reason = 'comprou_antes' (coluna sem check)
  // diferencia da janela expirada.
  comprou_antes: "concluido_sem_compra",
  // Já comprou alguma vez, em qualquer loja (Ian, 10/10: "nunca manda mensagem
  // para cliente que já comprou"). Não é recuperação: fecha sem mensagem.
  ja_cliente: "concluido_sem_compra",
  // Carrinho sem item do Olavita (produto novo): os fluxos são do Olavita,
  // fecha sem mensagem (ver product-gate.ts).
  produto_fora_do_fluxo: "concluido_sem_compra",
};

// Pedido que foi pago em algum momento (mesmo depois reembolsado ou cancelado):
// a pessoa já é cliente.
const EVER_PAID = /^(PAID|PARTIALLY_PAID|PARTIALLY_REFUNDED|REFUNDED)$/i;

// Janela "comprou antes": pedido pago até 72 h ANTES do abandono para a régua.
export const PAID_BEFORE_WINDOW_HOURS = 72;

const lower = (s: string | null | undefined) => (s ? s.trim().toLowerCase() : null);

// Pedido que conta como pago: não cancelado e não anulado/reembolsado/expirado/pendente.
export const isPaidOrder = (o: { cancelledAt?: string | null; financialStatus?: string | null }) => !o.cancelledAt && !/^(VOIDED|EXPIRED|PENDING|REFUNDED)$/i.test(o.financialStatus ?? "");

// Posição do pedido em relação ao abandono: 'depois' (comprou depois de
// abandonar), 'antes' (pagou nas PAID_BEFORE_WINDOW_HOURS anteriores) ou null
// (mais antigo que a janela, ou data inválida).
export function paidOrderRelation(orderCreatedAt: string, abandonedAt: string): "depois" | "antes" | null {
  const at = new Date(orderCreatedAt).getTime();
  const ab = new Date(abandonedAt).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(ab)) return null;
  if (at > ab) return "depois";
  return ab - at <= PAID_BEFORE_WINDOW_HOURS * 3600e3 ? "antes" : null;
}

const makeStop = (reason: StopReason, detail?: string, patch?: Partial<RecoveryRow>): StopCheck => ({ ok: false, reason, detail, terminal: Boolean(STATUS_FOR[reason]), patch });

// Shopify AO VIVO: o checkout virou pedido? Ou o e-mail/telefone pagou outro
// pedido, em QUALQUER loja (depois do abandono, ou nas PAID_BEFORE_WINDOW_HOURS
// antes dele)? Devolve a parada, ou null quando não há compra. Lança em erro
// de consulta (quem chama trata como erro_na_verificacao: falha fechado).
async function shopifyPurchaseCheck(rec: RecoveryRow, own: StoreShopifyAuth, creds: StoreShopifyAuth[], opts: { pastCustomers?: boolean } = {}): Promise<StopCheck | null> {
  const email = lower(rec.email);
  const phone = rec.phone;
  // Checkout não encontrado (null) = verificação inconclusiva, não "não comprou".
  const state = await fetchAbandonedCheckoutState(own, rec.checkout_id);
  if (!state) return makeStop("erro_na_verificacao", "checkout não encontrado na Shopify da loja");
  if (state.completedAt) return makeStop("comprou_checkout", state.completedAt, { completed_at: state.completedAt, recovered_at: state.completedAt, attribution: "checkout" });

  // Pedido pago em QUALQUER loja (e-mail e telefone):
  //  - DEPOIS do abandono: comprou em outro pedido (conta como recuperado);
  //  - nas PAID_BEFORE_WINDOW_HOURS (72 h) ANTES do abandono: pagou e abriu
  //    um checkout novo minutos depois (ex.: voltou pra ver o pedido). Não
  //    é recuperação, mas a régua não pode mandar cupom pra quem acabou de
  //    comprar: parada terminal 'comprou_antes', SEM recovered_*/attribution.
  // Pedido depois do abandono tem prioridade (atribuição); o "antes" só é
  // devolvido depois de olhar todas as lojas.
  const abandonedMs = new Date(rec.abandoned_at).getTime();
  const windowStartIso = new Date(abandonedMs - PAID_BEFORE_WINDOW_HOURS * 3600e3).toISOString();
  let before: { name: string } | null = null;
  let pastOrder: string | null = null;
  for (const cred of creds) {
    if (email) {
      const orders = await getRecentOrdersByEmail(cred, email, 5);
      if (opts.pastCustomers) pastOrder ??= orders.find((o) => EVER_PAID.test(o.financialStatus ?? ""))?.name ?? null;
      const paid = orders.filter(isPaidOrder);
      const hit = paid.find((o) => paidOrderRelation(o.createdAt, rec.abandoned_at) === "depois");
      if (hit) return makeStop("comprou_outro_pedido", hit.name, { recovered_order_id: hit.id, recovered_order_name: hit.name, recovered_at: hit.createdAt, attribution: "pedido_email" });
      before ??= paid.find((o) => paidOrderRelation(o.createdAt, rec.abandoned_at) === "antes") ?? null;
    }
    if (phone) {
      // Janela inteira: de (abandono - 72 h) até agora, paginada. Carrinho
      // de 14 dias numa loja movimentada passa de 250 pedidos; sem cobrir
      // a janela toda não dá pra afirmar "não comprou" (falha fechado).
      if (opts.pastCustomers) pastOrder ??= (await findCustomerOrdersByPhone(cred, phone)).find((o) => EVER_PAID.test(o.financialStatus ?? ""))?.name ?? null;
      const { orders, complete } = await fetchPaidOrdersWindow(cred, windowStartIso);
      if (!complete) return makeStop("erro_na_verificacao", `pedidos pagos da janela não cobertos por inteiro (${orders.length}+ desde ${windowStartIso})`);
      const paid = orders.filter((o) => isPaidOrder(o) && normalizePhone(o.phone, o.countryCode) === phone);
      const hit = paid.find((o) => paidOrderRelation(o.createdAt, rec.abandoned_at) === "depois");
      if (hit) return makeStop("comprou_outro_pedido", hit.name, { recovered_order_id: hit.id, recovered_order_name: hit.name, recovered_at: hit.createdAt, attribution: "pedido_telefone" });
      before ??= paid.find((o) => paidOrderRelation(o.createdAt, rec.abandoned_at) === "antes") ?? null;
    }
  }
  if (before) return makeStop("comprou_antes", before.name);
  if (pastOrder) return makeStop("ja_cliente", pastOrder);
  return null;
}

// Doublecheck de compra do agente vendedor (Ian, 10/10): antes de cada
// resposta e de cada retomada, SÓ a parte da Shopify ao vivo (checkout
// completado e pedidos pagos por e-mail/telefone). As regras de resposta e
// supressão não entram: a cliente acabou de responder, por definição, e a
// supressão o agente já confere. Status não ativo para; erro = não responde.
export async function checkPurchased(rec: RecoveryRow, creds: StoreShopifyAuth[]): Promise<StopCheck> {
  if (rec.status !== "ativo") return makeStop("nao_ativo", rec.status);
  if (!isFlowProduct(rec.items)) return makeStop(FLOW_PRODUCT_STOP, itemTitles(rec.items));
  const own = creds.find((c) => c.storeId === rec.store_id);
  if (!own) return makeStop("erro_na_verificacao", creds.length === 0 ? "nenhuma credencial Shopify carregada" : "sem credencial Shopify da loja do carrinho");
  try {
    return (await shopifyPurchaseCheck(rec, own, creds)) ?? { ok: true };
  } catch (err) {
    return makeStop("erro_na_verificacao", err instanceof Error ? err.message : String(err));
  }
}

export async function checkStopRules(
  admin: SupabaseClient,
  rec: RecoveryRow,
  input: { channel: RecoveryChannel; withDiscount: boolean; requireConsent: boolean; maxDays: number; creds: StoreShopifyAuth[]; now?: Date }
): Promise<StopCheck> {
  const now = input.now ?? new Date();
  const stop = makeStop;

  if (rec.status !== "ativo") return stop("nao_ativo", rec.status);
  if (!isFlowProduct(rec.items)) return stop(FLOW_PRODUCT_STOP, itemTitles(rec.items));
  if (now.getTime() - new Date(rec.abandoned_at).getTime() > input.maxDays * 86400e3) return stop("janela_expirada");
  const email = lower(rec.email);
  const phone = rec.phone;
  if (input.channel === "email" ? !email : !phone) return stop("sem_contato");

  // Falha FECHADO: sem a credencial da loja do carrinho não dá pra confirmar
  // na Shopify. Nunca usar a credencial de outra loja (o checkout não existe
  // lá e "não encontrado" viraria "não comprou").
  const own = input.creds.find((c) => c.storeId === rec.store_id);
  if (!own) return stop("erro_na_verificacao", input.creds.length === 0 ? "nenhuma credencial Shopify carregada" : "sem credencial Shopify da loja do carrinho");

  try {
    // Supressão (descadastrou, bounce, reclamação, pediu pra parar).
    const addresses = [email, phone].filter((x): x is string => Boolean(x));
    const { data: sup, error: supErr } = await admin.from("recovery_suppressions").select("channel, address, reason").in("address", addresses).in("channel", [input.channel, "all"]);
    if (supErr) throw new Error(supErr.message);
    if ((sup ?? []).length > 0) return stop("suprimido", (sup ?? []).map((s) => `${s.channel}:${s.reason}`).join(","));

    // Descadastrou / reclamou (qualquer canal): não quer contato, régua para.
    const { data: optedOut, error: outErr } = await admin.from("recovery_events").select("id").eq("recovery_id", rec.id).in("type", ["unsubscribed", "complained"]).limit(1);
    if (outErr) throw new Error(outErr.message);
    if ((optedOut ?? []).length > 0) return stop("respondeu", "descadastrou_ou_reclamou");

    // Respondeu, por canal (ver cabeçalho).
    const { data: replied, error: repErr } = await admin.from("recovery_events").select("id").eq("recovery_id", rec.id).eq("type", "replied").eq("channel", input.channel).limit(1);
    if (repErr) throw new Error(repErr.message);
    if ((replied ?? []).length > 0) return input.channel === "email" ? stop("respondeu", "replied_email") : stop("cliente_respondeu");
    if (input.channel === "email" && email) {
      // A resposta ao e-mail cai no Inbox de suporte (reply-to): mensagem
      // inbound do e-mail do carrinho, depois do abandono.
      const { data: inbound, error: inErr } = await admin.from("messages").select("id").eq("direction", "inbound").eq("from_address", email).gt("sent_at", rec.abandoned_at).limit(1);
      if (inErr) throw new Error(inErr.message);
      if ((inbound ?? []).length > 0) return stop("respondeu", `inbox:${inbound?.[0]?.id as string}`);
    }

    // Checkout mais novo da mesma pessoa.
    let newer = admin.from("cart_recoveries").select("id, abandoned_at").neq("id", rec.id).gt("abandoned_at", rec.abandoned_at).in("status", ["ativo", "pausado", "recuperado", "parado_comprou"]).limit(1);
    newer = email && phone ? newer.or(`email.eq.${email},phone.eq.${phone}`) : email ? newer.eq("email", email) : newer.eq("phone", phone as string);
    const { data: newerRows, error: newerErr } = await newer;
    if (newerErr) throw new Error(newerErr.message);
    if ((newerRows ?? []).length > 0) return stop("checkout_mais_novo", newerRows?.[0]?.id as string);

    // Shopify ao vivo (checkout completado, pedidos pagos por e-mail/telefone).
    const bought = await shopifyPurchaseCheck(rec, own, input.creds, { pastCustomers: true });
    if (bought) return bought;
  } catch (err) {
    // Falha fechado: não conseguiu verificar = não manda.
    return stop("erro_na_verificacao", err instanceof Error ? err.message : String(err));
  }

  // Consentimento: degraus com desconto (marketing) só pra quem marcou opt-in
  // na Shopify. Mensagem sem desconto (lembrete) passa.
  if (input.requireConsent && input.withDiscount) {
    const consent = input.channel === "email" ? rec.email_consent : rec.sms_consent;
    if (consent !== "SUBSCRIBED") return stop("sem_consentimento", consent ?? "sem registro");
  }
  return { ok: true };
}

// Aplica a parada na linha (status + motivo) e registra o evento "stopped".
export async function applyStop(admin: SupabaseClient, rec: RecoveryRow, check: Exclude<StopCheck, { ok: true }>): Promise<void> {
  const status = STATUS_FOR[check.reason];
  if (!status) return; // não terminal (sem consentimento, erro): continua ativo, só não manda agora
  const now = new Date().toISOString();
  await admin
    .from("cart_recoveries")
    .update({ ...(check.patch ?? {}), status, stop_reason: check.reason, next_send_at: null, updated_at: now })
    .eq("id", rec.id)
    .in("status", ["ativo", "pausado"]);
  await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step: rec.step, channel: "system", type: "stopped", detail: { reason: check.reason, detail: check.detail ?? null } });
}
