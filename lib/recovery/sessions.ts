import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryRow, WhatsappSessionRow } from "@/lib/recovery/types";

// Rotação de números do WhatsApp (whatsapp_sessions) por loja.
//  - o cliente fica preso ao número que já falou com ele (rec.waha_session)
//    enquanto esse número estiver ativo e WORKING. Se esse número está no
//    teto diário ou em restrição temporária, NÃO troca de número (a conversa
//    ficaria dividida em dois chats no celular do cliente): devolve
//    { session: null, reason: "aguardar" } e o motor tenta mais tarde;
//  - só quando o número fixo não está mais ativo/WORKING (desligado,
//    deslogado, apagado) é que entra a rotação: entre os números da loja
//    ativos, WORKING, sem restrição vigente e abaixo do teto diário, sai o que
//    está há mais tempo sem usar;
//  - sent_today zera sozinho quando o dia (UTC) muda.

const today = () => new Date().toISOString().slice(0, 10);

const isWorking = (s: WhatsappSessionRow) => s.active && s.status === "WORKING";
const isRestricted = (s: WhatsappSessionRow, now: Date) => Boolean(s.restricted_until && new Date(s.restricted_until).getTime() > now.getTime());
const isCapped = (s: WhatsappSessionRow) => (s.sent_today_date === today() ? s.sent_today : 0) >= (s.daily_cap ?? 0);

function usable(s: WhatsappSessionRow, now: Date): boolean {
  return isWorking(s) && !isRestricted(s, now) && !isCapped(s);
}

export async function listStoreSessions(admin: SupabaseClient, storeId: string): Promise<WhatsappSessionRow[]> {
  const { data, error } = await admin.from("whatsapp_sessions").select("*").eq("store_id", storeId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as WhatsappSessionRow[];
  // Virou o dia: zera o contador (no banco também, pro painel mostrar certo).
  const stale = rows.filter((s) => s.sent_today_date !== today() && s.sent_today !== 0);
  if (stale.length > 0) {
    await admin.from("whatsapp_sessions").update({ sent_today: 0, sent_today_date: today(), updated_at: new Date().toISOString() }).in("name", stale.map((s) => s.name));
    for (const s of stale) {
      s.sent_today = 0;
      s.sent_today_date = today();
    }
  }
  return rows;
}

// Resultado da escolha de número:
//  - session: o número a usar;
//  - reason "aguardar": o número fixo do cliente está ativo e WORKING, mas no
//    teto diário ou restrito. Não troca de número: o motor adia (60 min);
//  - reason "sem_sessao": nenhum número da loja serve agora (30 min).
export type PickSessionResult = { session: WhatsappSessionRow; reason: null } | { session: null; reason: "aguardar" | "sem_sessao" };

export async function pickSessionDetailed(admin: SupabaseClient, storeId: string, rec: Pick<RecoveryRow, "waha_session">): Promise<PickSessionResult> {
  const now = new Date();
  const sessions = await listStoreSessions(admin, storeId);
  if (rec.waha_session) {
    const fixed = sessions.find((s) => s.name === rec.waha_session);
    if (fixed && isWorking(fixed)) {
      if (isRestricted(fixed, now) || isCapped(fixed)) return { session: null, reason: "aguardar" };
      return { session: fixed, reason: null };
    }
    // Número fixo desligado/deslogado/apagado: cai na rotação.
  }
  const candidates = sessions.filter((s) => usable(s, now)).sort((a, b) => {
    const ta = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const tb = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    return ta - tb;
  });
  return candidates[0] ? { session: candidates[0], reason: null } : { session: null, reason: "sem_sessao" };
}

// Mesma regra, só o número (ou null). Usado pelo agente vendedor e pelo
// envio manual do painel.
export async function pickSession(admin: SupabaseClient, storeId: string, rec: Pick<RecoveryRow, "waha_session">): Promise<WhatsappSessionRow | null> {
  return (await pickSessionDetailed(admin, storeId, rec)).session;
}

// Depois de um envio bem-sucedido: +1 no dia e marca o uso.
export async function bumpSessionSent(admin: SupabaseClient, session: WhatsappSessionRow): Promise<void> {
  const nowIso = new Date().toISOString();
  const sent = session.sent_today_date === today() ? session.sent_today : 0;
  const { error } = await admin.from("whatsapp_sessions").update({ sent_today: sent + 1, sent_today_date: today(), last_used_at: nowIso, updated_at: nowIso }).eq("name", session.name);
  if (error) console.error("whatsapp_sessions bump:", error.message);
  session.sent_today = sent + 1;
  session.sent_today_date = today();
  session.last_used_at = nowIso;
}

// 463/475 do WAHA: o número está em restrição temporária. Espera (24h por
// padrão), NÃO reinicia nem desloga.
export async function restrictSession(admin: SupabaseClient, name: string, hours = 24, detail?: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  const { error } = await admin.from("whatsapp_sessions").update({ restricted_until: until, last_event_at: nowIso, updated_at: nowIso, detail: { restriction: detail ?? null, at: nowIso } }).eq("name", name);
  if (error) console.error("whatsapp_sessions restrict:", error.message);
}

// --- Reachout Timelock (trava do WhatsApp para contatos novos) ----------------
// O WAHA devolve, no perfil do número (me.reachoutTimelock), se a trava está
// ativa e quando acaba. A sessão pode CAIR (FAILED) antes de qualquer envio
// devolver 463 (foi o que aconteceu em 11 e 12/10), então a vigilância lê o
// perfil a cada minuto e grava restricted_until com o fim informado pelo
// WhatsApp. O motor segura os contatos novos sozinho e volta sozinho.
export const TIMELOCK_KIND = "reachout_timelock";
const TIMELOCK_NO_END_MS = 60 * 60_000; // ativa sem horário de fim: espera 1 h e consulta de novo
const TIMELOCK_MARGIN_MS = 5 * 60_000; // folga depois do horário informado

export const isTimelockDetail = (detail: unknown): boolean => Boolean(detail && typeof detail === "object" && (detail as { restriction?: unknown }).restriction === TIMELOCK_KIND);

// null = o perfil não trouxe a informação (não mexe em nada); { until: null } = trava inativa.
export function timelockFromProfile(me: { reachoutTimelock?: { isActive?: boolean; timeEnforcementEnds?: number | null } | null } | null | undefined, nowMs = Date.now()): { until: Date | null } | null {
  const t = me?.reachoutTimelock;
  if (!t || typeof t.isActive !== "boolean") return null;
  if (!t.isActive) return { until: null };
  const endMs = typeof t.timeEnforcementEnds === "number" && Number.isFinite(t.timeEnforcementEnds) && t.timeEnforcementEnds > 0 ? t.timeEnforcementEnds * 1000 : null;
  const until = endMs && endMs > nowMs ? endMs + TIMELOCK_MARGIN_MS : nowMs + TIMELOCK_NO_END_MS;
  return { until: new Date(until) };
}

// Grava/limpa a restrição do número a partir do perfil. Só limpa o que ela
// mesma gravou (um 463 de envio, que marca 24 h, não é apagado por aqui).
export async function syncReachoutTimelock(admin: SupabaseClient, row: Pick<WhatsappSessionRow, "name" | "restricted_until" | "detail">, me: Parameters<typeof timelockFromProfile>[0], nowMs = Date.now()): Promise<"restricted" | "cleared" | "unchanged"> {
  const tl = timelockFromProfile(me, nowMs);
  if (!tl) return "unchanged";
  const nowIso = new Date(nowMs).toISOString();
  if (tl.until) {
    const current = row.restricted_until ? new Date(row.restricted_until).getTime() : 0;
    if (isTimelockDetail(row.detail) && Math.abs(current - tl.until.getTime()) < 1000) return "unchanged";
    const { error } = await admin.from("whatsapp_sessions").update({ restricted_until: tl.until.toISOString(), detail: { restriction: TIMELOCK_KIND, until: tl.until.toISOString(), at: nowIso }, updated_at: nowIso }).eq("name", row.name);
    if (error) console.error("whatsapp_sessions timelock:", error.message);
    return "restricted";
  }
  if (row.restricted_until && isTimelockDetail(row.detail)) {
    const { error } = await admin.from("whatsapp_sessions").update({ restricted_until: null, detail: null, updated_at: nowIso }).eq("name", row.name);
    if (error) console.error("whatsapp_sessions timelock clear:", error.message);
    return "cleared";
  }
  return "unchanged";
}

// Evento session.status do webhook: o WAHA manda em `data` o mesmo perfil
// (data.reachoutTimelock). Devolve o que gravar em restricted_until/detail SEM
// apagar a marca da trava quando o evento não traz a informação (o webhook
// sobrescrevia `detail` a cada mudança de status).
export function sessionStatusPatch(cur: Pick<WhatsappSessionRow, "restricted_until" | "detail"> | null, data: unknown, nowMs = Date.now()): { restricted_until?: string | null; detail: unknown } {
  const tl = timelockFromProfile({ reachoutTimelock: (data as { reachoutTimelock?: { isActive?: boolean; timeEnforcementEnds?: number | null } } | null | undefined)?.reachoutTimelock }, nowMs);
  const marked = Boolean(cur?.restricted_until && isTimelockDetail(cur?.detail));
  if (tl?.until) return { restricted_until: tl.until.toISOString(), detail: { restriction: TIMELOCK_KIND, until: tl.until.toISOString(), at: new Date(nowMs).toISOString() } };
  if (tl && !tl.until && marked) return { restricted_until: null, detail: data ?? null };
  if (!tl && marked) return { detail: cur?.detail ?? null };
  return { detail: data ?? null };
}
