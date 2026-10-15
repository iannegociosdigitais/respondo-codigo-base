import type { SupabaseClient } from "@supabase/supabase-js";

// Situação REAL do pacote, pela API do 17TRACK (a mesma do link que mandamos
// ao cliente). Custo: registrar um código gasta 1 da cota; consultar um código
// já registrado é grátis. Por isso cada código entra na API UMA vez e o
// resultado fica em `tracking_cache` com validade curta.
//
// FALHA FECHADA: sem chave, sem tabela, cota baixa ou qualquer erro = devolve
// null (o rascunho segue sem rastreio real), nunca gasta cota em loop.
const BASE = "https://api.17track.net/track/v2.4";
const TTL_MS = 6 * 3600000; // revalida a cada 6h
const TTL_NOTFOUND_MS = 30 * 60000; // recém-registrado ainda sem dados: tenta de novo em 30 min
const MIN_QUOTA = 5; // abaixo disso não registra código novo
const ALREADY_REGISTERED = -18019901;

export type TrackingMainStatus = "NotFound" | "InfoReceived" | "InTransit" | "Expired" | "AvailableForPickup" | "OutForDelivery" | "DeliveryFailure" | "Delivered" | "Exception";

export interface TrackingStatus {
  number: string;
  status: TrackingMainStatus;
  subStatus: string | null;
  latestEventAt: string | null;
  latestEventText: string | null;
  deliveredAt: string | null;
  pickupAt: string | null;
  daysOfTransit: number | null;
  daysSinceUpdate: number | null;
  checkedAt: string;
}

// Pacote já está com o cliente (entregue) ou esperando por ele no ponto:
// nunca mais falar em "a caminho" nem em prazo.
export function trackingArrived(t: TrackingStatus | null): boolean {
  return Boolean(t && (t.status === "Delivered" || t.status === "AvailableForPickup"));
}

interface CacheRow {
  number: string;
  registered_at: string;
  checked_at: string | null;
  status: string | null;
  sub_status: string | null;
  latest_event_at: string | null;
  latest_event_text: string | null;
  delivered_at: string | null;
  pickup_at: string | null;
  days_of_transit: number | null;
  days_since_update: number | null;
}

let quotaCache: { remain: number; at: number } | null = null;

async function call<T>(key: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "17token": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`17track ${path} HTTP ${res.status}`);
  const json = (await res.json()) as { code: number; data?: T };
  if (json.code !== 0) throw new Error(`17track ${path} code ${json.code}`);
  return json.data as T;
}

async function quotaRemain(key: string): Promise<number> {
  if (quotaCache && Date.now() - quotaCache.at < 3600000) return quotaCache.remain;
  const q = await call<{ quota_remain: number }>(key, "/getquota", {});
  quotaCache = { remain: q.quota_remain, at: Date.now() };
  return q.quota_remain;
}

function rowToStatus(r: CacheRow): TrackingStatus | null {
  if (!r.status || !r.checked_at) return null;
  return {
    number: r.number,
    status: r.status as TrackingMainStatus,
    subStatus: r.sub_status,
    latestEventAt: r.latest_event_at,
    latestEventText: r.latest_event_text,
    deliveredAt: r.delivered_at,
    pickupAt: r.pickup_at,
    daysOfTransit: r.days_of_transit,
    daysSinceUpdate: r.days_since_update,
    checkedAt: r.checked_at,
  };
}

interface TrackInfo {
  number: string;
  track_info?: {
    latest_status?: { status?: string; sub_status?: string | null };
    latest_event?: { time_utc?: string | null; description?: string | null };
    time_metrics?: { days_of_transit?: number | null; days_after_last_update?: number | null };
    milestone?: Array<{ key_stage: string; time_utc: string | null }>;
  };
}

export async function getTrackingStatus(admin: SupabaseClient, number: string): Promise<TrackingStatus | null> {
  const key = process.env.TRACK17_API_KEY;
  const num = number.trim();
  if (!key || !num) return null;

  // Tabela ausente ou banco fora: não registra nada (gastaria cota a cada análise).
  const { data: row, error } = await admin.from("tracking_cache").select("*").eq("number", num).maybeSingle();
  if (error) return null;
  const cached = row ? rowToStatus(row as CacheRow) : null;
  if (cached) {
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    const ttl = cached.status === "Delivered" ? Infinity : cached.status === "NotFound" || cached.status === "InfoReceived" ? TTL_NOTFOUND_MS : TTL_MS;
    if (age < ttl) return cached;
  }

  try {
    if (!row) {
      if ((await quotaRemain(key)) < MIN_QUOTA) return null;
      const reg = await call<{ accepted: Array<{ number: string; carrier: number }>; rejected: Array<{ number: string; error: { code: number } }> }>(key, "/register", [{ number: num }]);
      const rej = reg.rejected?.[0];
      if (rej && rej.error?.code !== ALREADY_REGISTERED) {
        await admin.from("tracking_cache").upsert({ number: num, error: `register ${rej.error?.code}` });
        return null;
      }
      await admin.from("tracking_cache").upsert({ number: num, carrier: reg.accepted?.[0]?.carrier ?? null, error: null });
      if (quotaCache) quotaCache.remain -= 1;
    }

    const info = await call<{ accepted: TrackInfo[] }>(key, "/gettrackinfo", [{ number: num }]);
    const t = info.accepted?.[0]?.track_info;
    if (!t) return cached;
    const ms = (stage: string) => t.milestone?.find((m) => m.key_stage === stage)?.time_utc ?? null;
    const status: TrackingStatus = {
      number: num,
      status: (t.latest_status?.status as TrackingMainStatus) ?? "NotFound",
      subStatus: t.latest_status?.sub_status ?? null,
      latestEventAt: t.latest_event?.time_utc ?? null,
      latestEventText: t.latest_event?.description ?? null,
      deliveredAt: ms("Delivered"),
      pickupAt: ms("AvailableForPickup"),
      daysOfTransit: t.time_metrics?.days_of_transit ?? null,
      daysSinceUpdate: t.time_metrics?.days_after_last_update ?? null,
      checkedAt: new Date().toISOString(),
    };
    await admin.from("tracking_cache").upsert({
      number: num,
      checked_at: status.checkedAt,
      status: status.status,
      sub_status: status.subStatus,
      latest_event_at: status.latestEventAt,
      latest_event_text: status.latestEventText,
      delivered_at: status.deliveredAt,
      pickup_at: status.pickupAt,
      days_of_transit: status.daysOfTransit,
      days_since_update: status.daysSinceUpdate,
      error: null,
    });
    return status;
  } catch (err) {
    console.error("17track:", (err as Error).message);
    return cached;
  }
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : null);

// Texto que entra nos fatos do pedido: o que a transportadora diz de verdade e
// o que a resposta pode ou não afirmar por causa disso.
export function trackingFacts(t: TrackingStatus): string {
  const ev = t.latestEventText ? ` Último evento: "${t.latestEventText}"${t.latestEventAt ? ` em ${fmt(t.latestEventAt)}` : ""}.` : "";
  const stale = t.daysSinceUpdate != null && t.daysSinceUpdate >= 7 ? ` Sem atualização há ${t.daysSinceUpdate} dias.` : "";
  switch (t.status) {
    case "Delivered":
      return `RASTREIO REAL (17TRACK): ENTREGUE${t.deliveredAt ? ` em ${fmt(t.deliveredAt)}` : ""}.${ev} NUNCA diga que está a caminho, que vai chegar ou que está dentro do prazo. Se o cliente diz que não recebeu, trate como "consta entregue mas cliente nega" (regra do contexto).`;
    case "AvailableForPickup":
      return `RASTREIO REAL (17TRACK): o pacote está NO PONTO DE RETIRADA da transportadora local${t.pickupAt ? ` desde ${fmt(t.pickupAt)}` : ""}, esperando o cliente buscar.${ev} NUNCA diga que está a caminho nem fale de prazo. Diga que a transportadora deixou o pacote no ponto indicado na mensagem que ela mandou ao telefone dele (regra "entrega em casa ou retirada no ponto").`;
    case "OutForDelivery":
      return `RASTREIO REAL (17TRACK): SAIU PARA ENTREGA${t.latestEventAt ? ` em ${fmt(t.latestEventAt)}` : ""}.${ev} Diga que está em rota de entrega; não prometa hora nem dia.`;
    case "DeliveryFailure":
      return `RASTREIO REAL (17TRACK): TENTATIVA DE ENTREGA FALHOU.${ev}${stale} A transportadora não conseguiu entregar (endereço ou ausência). Explique isso e peça para conferir o endereço/telefone; não diga que está a caminho normalmente.`;
    case "Exception":
      return `RASTREIO REAL (17TRACK): EXCEÇÃO no transporte (retido, devolvido ou problema).${ev}${stale} Não diga que está tudo normal; diga que estamos verificando com a transportadora.`;
    case "Expired":
      return `RASTREIO REAL (17TRACK): rastreio EXPIRADO, sem movimentação há muito tempo${t.daysOfTransit != null ? ` (${t.daysOfTransit} dias desde o envio)` : ""}.${ev} Trate como pacote provavelmente perdido (regra do contexto): não prometa chegada.`;
    case "InTransit":
    case "InfoReceived":
      return `RASTREIO REAL (17TRACK): EM TRÂNSITO${t.daysOfTransit != null ? `, ${t.daysOfTransit} dias desde o envio` : ""}.${ev}${stale}`;
    default:
      return `RASTREIO REAL (17TRACK): ainda sem informação da transportadora para este código.`;
  }
}
