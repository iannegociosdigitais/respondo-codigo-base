import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryRow, WhatsappMessageRow } from "@/lib/recovery/types";
import { authorize, dbError, isUuid, jsonError, loadStoreNames } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Lista de conversas do chat ao vivo (aba "Conversas" do painel).
// Só carrinhos com telefone (ou que já têm mensagem de WhatsApp). Painel
// interno: telefone aparece inteiro. Ordem: precisa de humano primeiro,
// depois última resposta do cliente, depois abandono mais recente.
// Leve de propósito (o painel consulta a cada 10 s): só as colunas usadas e a
// última mensagem de cada conversa sem trazer o raw do WAHA.

type Filter = "todos" | "humano" | "agente" | "comprou" | "ativos";
const FILTERS: Filter[] = ["todos", "humano", "agente", "comprou", "ativos"];
const BOUGHT = new Set(["recuperado", "parado_comprou"]);

const matches = (r: RecCols, f: Filter): boolean => {
  switch (f) {
    case "humano":
      // Só quem está esperando alguém: conversa assumida e resolvida
      // (agent_mode humano, needs_human false) não conta no badge vermelho.
      return r.needs_human;
    case "agente":
      return r.agent_mode === "agente" && !r.needs_human && r.last_inbound_at != null;
    case "comprou":
      return BOUGHT.has(r.status) || (r.tags ?? []).includes("disse_que_comprou");
    case "ativos":
      return r.status === "ativo";
    default:
      return true;
  }
};

// Colunas do carrinho que a lista usa (nada de select(*)).
const REC_COLS = "id, store_id, first_name, last_name, phone, email, language, country_code, total, currency, items, status, agent_mode, needs_human, needs_human_reason, unread_count, last_inbound_at, last_outbound_at, summary_pt, wa_step, email_step, offered_discount_percent, recovered_order_name, tags, abandoned_at, checkout_name";
type RecCols = Pick<RecoveryRow, "id" | "store_id" | "first_name" | "last_name" | "phone" | "email" | "language" | "country_code" | "total" | "currency" | "items" | "status" | "agent_mode" | "needs_human" | "needs_human_reason" | "unread_count" | "last_inbound_at" | "last_outbound_at" | "summary_pt" | "wa_step" | "email_step" | "offered_discount_percent" | "recovered_order_name" | "tags" | "abandoned_at" | "checkout_name">;
type LastMsg = Pick<WhatsappMessageRow, "recovery_id" | "body" | "body_pt" | "author" | "sent_at" | "created_at">;
// Última mensagem real (envio de teste não conta): is_test e status test/teste.
const MSG_COLS = "recovery_id, body, body_pt, author, sent_at, created_at";
const REAL_MSG = "status.is.null,status.not.in.(test,teste)";
const LIST_LIMIT = 200;
const BASE_LIMIT = 1000;

const num = (v: number | string | null | undefined) => (v == null ? null : Number(v));

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const storeId = url.searchParams.get("store");
  const filterRaw = (url.searchParams.get("filter") ?? "todos") as Filter;
  const filter: Filter = FILTERS.includes(filterRaw) ? filterRaw : "todos";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (storeId && !isUuid(storeId)) return jsonError("store inválida", 400);
  const admin = createAdminClient();

  // Carrinhos com telefone (os que a régua de WhatsApp alcança).
  let query = admin.from("cart_recoveries").select(REC_COLS).not("phone", "is", null).order("abandoned_at", { ascending: false }).limit(BASE_LIMIT);
  if (storeId) query = query.eq("store_id", storeId);
  const recRes = await query;
  if (recRes.error) return dbError(recRes.error);
  const baseRows = recRes.data as unknown as RecCols[];
  const queryCapped = baseRows.length >= BASE_LIMIT; // há carrinhos com telefone mais antigos fora da consulta
  const rows = new Map<string, RecCols>(baseRows.map((r) => [r.id, r]));

  // Carrinhos sem telefone mas com mensagem (caso raro: número ligado à mão).
  const msgIdsRes = await admin.from("whatsapp_messages").select("recovery_id").not("recovery_id", "is", null).order("created_at", { ascending: false }).limit(2000);
  if (msgIdsRes.error) return dbError(msgIdsRes.error);
  const missing = [...new Set((msgIdsRes.data ?? []).map((m) => String(m.recovery_id)))].filter((id) => !rows.has(id)).slice(0, 200);
  if (missing.length > 0) {
    let extra = admin.from("cart_recoveries").select(REC_COLS).in("id", missing);
    if (storeId) extra = extra.eq("store_id", storeId);
    const extraRes = await extra;
    if (extraRes.error) return dbError(extraRes.error);
    for (const r of extraRes.data as unknown as RecCols[]) rows.set(r.id, r);
  }

  const storeNames = await loadStoreNames(admin);
  const all = [...rows.values()];
  const searched = q
    ? all.filter((r) => {
        const hay = [r.first_name, r.last_name, r.phone, r.email, r.summary_pt, r.checkout_name, storeNames.get(r.store_id), ...(r.items ?? []).map((i) => i.title)].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
    : all;

  const counts = { todos: 0, humano: 0, agente: 0, comprou: 0, ativos: 0 };
  for (const r of searched) for (const f of FILTERS) if (matches(r, f)) counts[f] += 1;

  const ts = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0);
  const matched = searched
    .filter((r) => matches(r, filter))
    .sort((a, b) => Number(b.needs_human) - Number(a.needs_human) || ts(b.last_inbound_at) - ts(a.last_inbound_at) || ts(b.abandoned_at) - ts(a.abandoned_at));
  const total = matched.length;
  const filtered = matched.slice(0, LIST_LIMIT);

  // Última mensagem de cada conversa. Envios de teste (foram para o
  // test_phone, não para o cliente) não contam: a lista mostraria "Régua: ..."
  // como se o cliente tivesse recebido. Só consulta quem já trocou mensagem
  // (last_inbound_at/last_outbound_at). 1ª passada: uma consulta limitada
  // (sem raw); quem ficou sem resposta (conversa longa de outro carrinho
  // ocupou o limite) é buscado à parte, no máximo 30 por vez.
  const lastMessage = new Map<string, LastMsg>();
  const withMsgs = filtered.filter((r) => r.last_inbound_at || r.last_outbound_at).map((r) => r.id);
  if (withMsgs.length > 0) {
    const msgRes = await admin.from("whatsapp_messages").select(MSG_COLS).in("recovery_id", withMsgs).eq("is_test", false).or(REAL_MSG).order("created_at", { ascending: false }).limit(withMsgs.length * 4);
    if (msgRes.error) return dbError(msgRes.error);
    for (const m of msgRes.data as unknown as LastMsg[]) if (m.recovery_id && !lastMessage.has(m.recovery_id)) lastMessage.set(m.recovery_id, m);
    const stillMissing = withMsgs.filter((id) => !lastMessage.has(id)).slice(0, 30);
    if (stillMissing.length > 0) {
      const extra = await Promise.all(stillMissing.map((rid) => admin.from("whatsapp_messages").select(MSG_COLS).eq("recovery_id", rid).eq("is_test", false).or(REAL_MSG).order("created_at", { ascending: false }).limit(1).maybeSingle()));
      for (const e of extra) {
        const m = e.data as unknown as LastMsg | null;
        if (m?.recovery_id) lastMessage.set(m.recovery_id, m);
      }
    }
  }

  const items = filtered.map((r) => {
    const last = lastMessage.get(r.id) ?? null;
    return {
      id: r.id,
      storeId: r.store_id,
      store: storeNames.get(r.store_id) ?? r.store_id,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      phone: r.phone,
      email: r.email,
      language: r.language,
      country: r.country_code,
      total: num(r.total),
      currency: r.currency,
      items: (r.items ?? []).map((i) => `${i.quantity}× ${i.title}`).join("; "),
      status: r.status,
      agentMode: r.agent_mode,
      needsHuman: r.needs_human,
      needsHumanReason: r.needs_human_reason,
      unreadCount: r.unread_count ?? 0,
      lastInboundAt: r.last_inbound_at,
      lastOutboundAt: r.last_outbound_at,
      lastMessage: last ? { body: last.body, bodyPt: last.body_pt, author: last.author, at: last.sent_at ?? last.created_at } : null,
      summaryPt: r.summary_pt,
      waStep: r.wa_step ?? 0,
      emailStep: r.email_step ?? 0,
      offeredDiscountPercent: num(r.offered_discount_percent),
      recoveredOrder: r.recovered_order_name,
      tags: r.tags ?? [],
      abandonedAt: r.abandoned_at,
    };
  });

  // total = quantas conversas batem com o filtro; a lista mostra no máximo `limit`.
  return NextResponse.json({ items, counts, total, limit: LIST_LIMIT, queryCapped });
}
