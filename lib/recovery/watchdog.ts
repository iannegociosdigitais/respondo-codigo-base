import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession, wahaConfigured } from "@/lib/whatsapp/waha";
import { APP_URL } from "@/lib/forms/token";
import { syncReachoutTimelock } from "@/lib/recovery/sessions";
import { RECOVERY_MISSING_TABLE, type RecoveryAlert, type RecoverySettings, type WhatsappSessionRow } from "@/lib/recovery/types";
import { alertRecipient, createAlert, findOpenAlert, lastAlertAt, listOpenAlerts, listRecentAlerts, resolveAlertsById, resolveOpenAlerts, sendAlertEmail, type AlertKind } from "@/lib/recovery/alerts";

// Vigilância da recuperação de carrinho, chamada no fim de cada tick da
// régua (runRecoveryTick → runWatchdog). Quatro verificações:
//   1. o servidor do WhatsApp (WAHA) responde ao ping;
//   2. cada número ativo (whatsapp_sessions) continua WORKING;
//   3. não há enxurrada de envios com falha (recovery_events type=failed);
//   4. clientes marcados "precisa de humano" no chat geram aviso.
// Cada problema vira um alerta em recovery_alerts (o painel mostra) e um
// e-mail pro dono, com trava pra não inundar. NUNCA lança: todo erro vira
// console.error e o resultado sai parcial. Não envia nada pra cliente.

export interface WatchdogResult {
  ping: "ok" | "falhou" | "nao_configurado";
  sessions: Array<{ name: string; status: string | null; changed: boolean }>;
  alertsCreated: number;
  alertsResolved: number;
}

const PING_TIMEOUT_MS = 5_000;
// Consulta de sessão no WAHA (getSession): curta, pra um WAHA lento não comer
// o tempo do tick (maxDuration da rota).
const SESSION_TIMEOUT_MS = 5_000;
// Orçamento próprio da vigilância quando o chamador não passa deadline.
export const WATCHDOG_BUDGET_MS = 20_000;
// Mesmo kind+key: no máximo 1 e-mail a cada 6 h (e, depois de resolvido à
// mão com o problema ainda de pé, no máximo 1 alerta novo a cada 6 h).
const ALERT_COOLDOWN_MS = 6 * 3600e3;
// Alerta aberto e problema ainda de pé: lembrete por e-mail a cada 4 h. Em
// 11/10 o número do WhatsApp ficou 31 h fora do ar com um único e-mail (9h15).
const ALERT_REMIND_MS = 4 * 3600e3;
const FAILED_WINDOW_MS = 2 * 3600e3;
const FAILED_THRESHOLD = 5; // mais de 5 falhas na janela → alerta
// "Precisa de humano": carrinhos marcados nos últimos 60 min (a spec fala em
// 10; a janela maior cobre tick parado, e a trava de alerta aberto por
// carrinho impede repetição).
const HUMAN_WINDOW_MS = 60 * 60e3;
const HUMAN_EMAIL_GAP_MS = 15 * 60e3;
const HUMAN_HISTORY_MS = 24 * 3600e3;

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Ctx {
  admin: SupabaseClient;
  now: Date;
  nowIso: string;
  settings: RecoverySettings[];
  deadline?: number;
  result: WatchdogResult;
}

const overDeadline = (ctx: Ctx) => Boolean(ctx.deadline && Date.now() > ctx.deadline);

// Roda uma etapa com teto de tempo: se o deadline chegar antes dela acabar, a
// vigilância devolve o que tem (a etapa pendurada é abandonada) e a função do
// tick nunca estoura o maxDuration. Nunca lança por tempo.
async function withinDeadline(ctx: Ctx, work: Promise<void>): Promise<"ok" | "timeout"> {
  const left = ctx.deadline ? ctx.deadline - Date.now() : Number.POSITIVE_INFINITY;
  if (left <= 0) return "timeout";
  if (!Number.isFinite(left)) {
    await work;
    return "ok";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), left);
  });
  try {
    return await Promise.race([work.then(() => "ok" as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => {}); // etapa abandonada: o erro dela não vira rejeição solta
  }
}

let warnedMissingTable = false;

export async function runWatchdog(admin: SupabaseClient, input: { settings: RecoverySettings[]; deadline?: number }): Promise<WatchdogResult> {
  const result: WatchdogResult = { ping: "nao_configurado", sessions: [], alertsCreated: 0, alertsResolved: 0 };
  const now = new Date();
  // Sem deadline do chamador, a vigilância se limita a WATCHDOG_BUDGET_MS.
  const deadline = input.deadline ?? Date.now() + WATCHDOG_BUDGET_MS;
  const ctx: Ctx = { admin, now, nowIso: now.toISOString(), settings: input.settings ?? [], deadline, result };

  // Tabela de alertas ausente (migration 0018 não rodou): nada a vigiar.
  try {
    const probe = await admin.from("recovery_alerts").select("id").limit(1);
    if (probe.error) {
      if (RECOVERY_MISSING_TABLE.test(probe.error.message)) {
        if (!warnedMissingTable) console.warn("vigilância: recovery_alerts não existe (rode a migration 0018).");
        warnedMissingTable = true;
      } else console.error("vigilância: recovery_alerts:", probe.error.message);
      return result;
    }
  } catch (err) {
    console.error("vigilância: banco:", errMsg(err));
    return result;
  }

  const steps: Array<[string, (c: Ctx) => Promise<void>]> = [
    ["ping", checkPing],
    ["sessões", checkSessions],
    ["falhas de envio", checkFailures],
    ["precisa de humano", checkNeedsHuman],
  ];
  for (const [label, step] of steps) {
    if (overDeadline(ctx)) break;
    try {
      if ((await withinDeadline(ctx, step(ctx))) === "timeout") {
        console.warn(`vigilância (${label}): deadline atingido, etapa abandonada.`);
        break;
      }
    } catch (err) {
      console.error(`vigilância (${label}):`, errMsg(err));
    }
  }
  return result;
}

// --- Alerta com trava --------------------------------------------------------

// Cria o alerta se não houver outro aberto com o mesmo kind+key. Depois de
// um alerta resolvido à mão com o problema ainda de pé, só cria outro
// passadas 6 h (a não ser que a queda tenha sido observada agora: force).
// E-mail: só se o último (lastEmailAt, ou o último alerta do mesmo kind+key)
// tiver mais de 6 h. O e-mail sai NA HORA, logo depois de criar o alerta (antes
// de seguir pras outras sessões): se o deadline cortar a vigilância, o alerta
// que já existe não fica sem aviso. `sessionName`: carimba alerted_at da
// sessão quando o e-mail sai. Sem tempo (deadline), nem cria: o próximo tick
// tenta de novo.
async function raiseAlert(ctx: Ctx, a: { kind: AlertKind; key: string; message: string; storeId?: string | null; lastEmailAt?: Date | null; force?: boolean; sessionName?: string; remind?: boolean }): Promise<{ created: boolean; emailed: boolean }> {
  if (overDeadline(ctx)) return { created: false, emailed: false };
  const open = await findOpenAlert(ctx.admin, a.kind, a.key);
  if (open) {
    // Lembrete: o alerta já existe e o problema continua.
    if (a.remind && a.lastEmailAt && ctx.now.getTime() - a.lastEmailAt.getTime() > ALERT_REMIND_MS) {
      const hours = Math.max(1, Math.round((ctx.now.getTime() - new Date(open.created_at).getTime()) / 3600e3));
      const sent = await emailOpsAlert(ctx, `${a.message} Continua fora do ar há ${hours} h: enquanto isso nenhum WhatsApp sai nem chega.`);
      if (sent && a.sessionName) {
        const { error } = await ctx.admin.from("whatsapp_sessions").update({ alerted_at: ctx.nowIso, updated_at: ctx.nowIso }).eq("name", a.sessionName);
        if (error) console.error("vigilância: alerted_at (lembrete):", error.message);
      }
      return { created: false, emailed: sent };
    }
    return { created: false, emailed: false };
  }
  const last = await lastAlertAt(ctx.admin, a.kind, a.key);
  const cooled = !last || ctx.now.getTime() - last.getTime() > ALERT_COOLDOWN_MS;
  if (!a.force && !cooled) return { created: false, emailed: false };
  const created = await createAlert(ctx.admin, { kind: a.kind, key: a.key, message: a.message, storeId: a.storeId ?? null });
  if (!created) return { created: false, emailed: false };
  ctx.result.alertsCreated++;
  const lastEmail = a.lastEmailAt === undefined ? last : a.lastEmailAt;
  const emailOk = !lastEmail || ctx.now.getTime() - lastEmail.getTime() > ALERT_COOLDOWN_MS;
  if (!emailOk) return { created: true, emailed: false };
  const sent = await emailOpsAlert(ctx, a.message);
  if (sent && a.sessionName) {
    const { error } = await ctx.admin.from("whatsapp_sessions").update({ alerted_at: ctx.nowIso, updated_at: ctx.nowIso }).eq("name", a.sessionName);
    if (error) console.error("vigilância: alerted_at:", error.message);
  }
  return { created: true, emailed: sent };
}

const shorten = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

// E-mail de UM alerta operacional (waha, sessao, envio). Nunca lança.
async function emailOpsAlert(ctx: Ctx, message: string): Promise<boolean> {
  try {
    const r = await sendAlertEmail(ctx.admin, {
      to: alertRecipient(ctx.settings),
      subject: `[Respondo] Alerta: ${shorten(message, 90)}`,
      text: [message, "", `Painel: ${APP_URL}/recuperacao`].join("\n"),
      settings: ctx.settings,
    });
    if (!r.ok) {
      if (r.via !== "nenhum") console.error("vigilância: e-mail de alerta não saiu:", r.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("vigilância: e-mail de alerta:", errMsg(err));
    return false;
  }
}

// --- 1. Ping do WAHA ----------------------------------------------------------

async function checkPing(ctx: Ctx): Promise<void> {
  if (!wahaConfigured()) {
    ctx.result.ping = "nao_configurado";
    return;
  }
  const url = (process.env.WAHA_URL ?? "").replace(/\/$/, "");
  let failure: string | null = null;
  try {
    const res = await fetch(`${url}/ping`, {
      method: "GET",
      headers: { "X-Api-Key": process.env.WAHA_API_KEY ?? "", Accept: "application/json" },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!res.ok) failure = `HTTP ${res.status}`;
  } catch (err) {
    failure = errMsg(err);
  }
  if (!failure) {
    ctx.result.ping = "ok";
    ctx.result.alertsResolved += await resolveOpenAlerts(ctx.admin, "waha", "ping");
    return;
  }
  ctx.result.ping = "falhou";
  await raiseAlert(ctx, {
    kind: "waha",
    key: "ping",
    message: `O servidor do WhatsApp (WAHA) não respondeu ao ping em ${url}: ${failure}. Nenhuma mensagem de WhatsApp sai enquanto isso. Verifique o Docker/VPS (infra/waha) e a variável WAHA_URL.`,
  });
}

// --- 2. Sessões (números) -----------------------------------------------------

async function checkSessions(ctx: Ctx): Promise<void> {
  const { admin, nowIso } = ctx;
  const { data, error } = await admin.from("whatsapp_sessions").select("*").eq("active", true).order("name");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as WhatsappSessionRow[];
  if (rows.length === 0) return;

  // Sem WAHA configurado não há como consultar: só relata o que o banco tem.
  if (!wahaConfigured()) {
    for (const row of rows) ctx.result.sessions.push({ name: row.name, status: row.status ?? null, changed: false });
    return;
  }

  // Consulta todas as sessões ao mesmo tempo, cada uma com timeout curto
  // (SESSION_TIMEOUT_MS): um WAHA lento custa 5 s no total, não 5 s por número.
  const live = await Promise.all(
    rows.map(async (row) => {
      try {
        return { session: await getSession(row.name, SESSION_TIMEOUT_MS), error: null as string | null };
      } catch (err) {
        return { session: null, error: errMsg(err) };
      }
    }),
  );

  for (const [i, row] of rows.entries()) {
    if (overDeadline(ctx)) break;
    const prev = row.status ?? null;
    let status: string | null = prev;
    let me: { id: string; pushName?: string } | null = null;
    const queryError: string | null = live[i].error;
    if (!queryError) {
      const s = live[i].session;
      if (s) {
        status = s.status ?? null;
        me = s.me ?? null;
      } else {
        // 404: a sessão não existe mais no WAHA.
        status = "NOT_FOUND";
      }
    }
    const changed = !queryError && status !== prev;
    const working = !queryError && status === "WORKING";
    ctx.result.sessions.push({ name: row.name, status: queryError ? prev : status, changed });

    // Grava o que a consulta trouxe. me_id/me_name só quando vieram (a
    // sessão caída devolve me=null e não vale apagar quem era o número).
    if (!queryError) {
      const patch: Record<string, unknown> = { status, last_event_at: nowIso, updated_at: nowIso };
      if (me?.id) {
        patch.me_id = me.id;
        patch.me_name = me.pushName ?? null;
      }
      if (working && row.alerted_at) patch.alerted_at = null;
      // Trava de contatos novos do WhatsApp (me.reachoutTimelock): vale mesmo com a sessão caída.
      await syncReachoutTimelock(admin, row, live[i].session?.me).catch((e) => console.error("vigilância: timelock:", errMsg(e)));
      const { error: upErr } = await admin.from("whatsapp_sessions").update(patch).eq("name", row.name);
      if (upErr) console.error(`vigilância: whatsapp_sessions ${row.name}:`, upErr.message);
    }

    if (working) {
      ctx.result.alertsResolved += await resolveOpenAlerts(admin, "sessao", row.name);
      continue;
    }

    // Caiu? O webhook session.status costuma gravar o status novo antes da
    // vigilância rodar, então "anterior era WORKING" raramente é visto aqui.
    // Por isso também conta como queda o número que já esteve em uso (tem
    // me_id ou last_used_at) e está fora do WORKING sem alerta aberto. Número
    // recém-criado que nunca logou (SCAN_QR_CODE, sem me_id) não alerta.
    const observedDrop = prev === "WORKING";
    const wasInUse = observedDrop || Boolean(row.me_id) || Boolean(row.last_used_at);
    if (!wasInUse) continue;

    const label = row.label?.trim() || row.phone || row.name;
    const shown = queryError ? `desconhecido (falha ao consultar: ${queryError})` : status ?? "desconhecido";
    const message = `O número ${label} (${row.name}) saiu do ar: status ${shown}. Abra Recuperação de carrinho → Configuração → Números e leia o QR de novo se aparecer SCAN_QR_CODE.`;
    await raiseAlert(ctx, {
      kind: "sessao",
      key: row.name,
      message,
      storeId: row.store_id,
      lastEmailAt: row.alerted_at ? new Date(row.alerted_at) : null,
      force: observedDrop,
      sessionName: row.name,
      remind: true,
    });
  }
}

// --- 3. Falhas de envio -------------------------------------------------------

async function checkFailures(ctx: Ctx): Promise<void> {
  const since = new Date(ctx.now.getTime() - FAILED_WINDOW_MS).toISOString();
  const { count, error } = await ctx.admin.from("recovery_events").select("id", { count: "exact", head: true }).eq("type", "failed").eq("is_test", false).gte("created_at", since);
  if (error) throw new Error(error.message);
  const n = count ?? 0;
  if (n > FAILED_THRESHOLD) {
    await raiseAlert(ctx, {
      kind: "envio",
      key: "falhas",
      message: `${n} envios da régua falharam nas últimas 2 horas (limite: ${FAILED_THRESHOLD}). Abra Recuperação de carrinho → Painel e veja os eventos com falha; pode ser provedor de e-mail, WAHA ou número bloqueado.`,
    });
    return;
  }
  // Janela limpou: fecha o alerta sozinho.
  ctx.result.alertsResolved += await resolveOpenAlerts(ctx.admin, "envio", "falhas");
}

// --- 4. Cliente precisa de humano --------------------------------------------

interface HumanRec {
  id: string;
  store_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  checkout_name: string | null;
  needs_human_reason: string | null;
}

function describeCustomer(rec: HumanRec): string {
  const name = [rec.first_name, rec.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  if (name && rec.phone) return `${name} (${rec.phone})`;
  return name || rec.phone || rec.email || rec.checkout_name || "sem nome";
}

// Trava de "1 e-mail a cada 15 min" sem coluna de marcação: reconstrói, a
// partir do histórico dos próprios alertas (determinístico, todo tick chega
// ao mesmo resultado), quando saiu o último e-mail: o 1º alerta dispara; os
// seguintes só se já passaram 15 min do último disparo; os que ficaram no
// meio entram no e-mail seguinte.
function replayLastEmail(asc: Array<{ created_at: string }>): number | null {
  let last: number | null = null;
  for (const a of asc) {
    const t = Date.parse(a.created_at);
    if (Number.isNaN(t)) continue;
    if (last == null || t - last >= HUMAN_EMAIL_GAP_MS) last = t;
  }
  return last;
}

async function checkNeedsHuman(ctx: Ctx): Promise<void> {
  const { admin, now } = ctx;

  // a) Resolve sozinho: alerta aberto cujo carrinho já não precisa de humano.
  const open = await listOpenAlerts(admin, { kind: "humano", limit: 200 });
  const openKeys = new Set(open.map((a) => a.key));
  if (open.length > 0) {
    const { data, error } = await admin.from("cart_recoveries").select("id, needs_human").in("id", [...openKeys]);
    if (error) throw new Error(error.message);
    const still = new Set(((data ?? []) as Array<{ id: string; needs_human: boolean }>).filter((r) => r.needs_human).map((r) => r.id));
    const done = open.filter((a) => !still.has(a.key));
    if (done.length > 0) {
      ctx.result.alertsResolved += await resolveAlertsById(admin, done.map((a) => a.id));
      for (const a of done) openKeys.delete(a.key);
    }
  }

  // b) Novos: needs_human marcado há pouco e sem alerta aberto.
  const since = new Date(now.getTime() - HUMAN_WINDOW_MS).toISOString();
  const { data: recRows, error: recErr } = await admin
    .from("cart_recoveries")
    .select("id, store_id, first_name, last_name, phone, email, checkout_name, needs_human_reason")
    .eq("needs_human", true)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (recErr) throw new Error(recErr.message);
  const fresh: RecoveryAlert[] = [];
  for (const rec of (recRows ?? []) as HumanRec[]) {
    if (openKeys.has(rec.id)) continue;
    if (overDeadline(ctx)) break;
    const reason = (rec.needs_human_reason ?? "").trim() || "motivo não informado";
    const message = `Cliente ${describeCustomer(rec)} precisa de resposta humana no WhatsApp: ${reason}. Abra Recuperação de carrinho → Conversas.`;
    const created = await createAlert(admin, { kind: "humano", key: rec.id, message, storeId: rec.store_id });
    if (!created) continue;
    ctx.result.alertsCreated++;
    fresh.push(created);
  }
  if (fresh.length === 0) return;

  // c) Um e-mail agrupando os novos, no máximo 1 a cada 15 min.
  const history = await listRecentAlerts(admin, "humano", new Date(now.getTime() - HUMAN_HISTORY_MS).toISOString());
  const freshIds = new Set(fresh.map((a) => a.id));
  const past = history.filter((a) => !freshIds.has(a.id));
  const lastEmail = replayLastEmail(past);
  const firstFreshAt = Date.parse(fresh[0].created_at) || now.getTime();
  if (lastEmail != null && firstFreshAt - lastEmail < HUMAN_EMAIL_GAP_MS) return; // entra no próximo e-mail

  // Os que ficaram sem e-mail desde o último disparo (e seguem abertos) vão junto.
  const carried = past.filter((a) => !a.resolved_at && (lastEmail == null || Date.parse(a.created_at) > lastEmail));
  const all = [...carried, ...fresh];
  const storeNames = await loadStoreNames(admin, all.map((a) => a.store_id));
  const lines = all.map((a) => {
    const store = a.store_id ? storeNames.get(a.store_id) : null;
    return `• ${store ? `[${store}] ` : ""}${a.message}`;
  });
  const to = alertRecipient(ctx.settings);
  const subject = all.length === 1 ? "[Respondo] 1 cliente precisa de resposta humana no WhatsApp" : `[Respondo] ${all.length} clientes precisam de resposta humana no WhatsApp`;
  const text = [...lines, "", `Conversas: ${APP_URL}/recuperacao`].join("\n");
  const r = await sendAlertEmail(admin, { to, subject, text, settings: ctx.settings });
  if (!r.ok && r.via !== "nenhum") console.error("vigilância: e-mail de 'precisa de humano' não saiu:", r.error);
}

async function loadStoreNames(admin: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const { data, error } = await admin.from("stores").select("id, name").in("id", unique);
  if (error) {
    console.error("vigilância: lojas:", error.message);
    return new Map();
  }
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]));
}
