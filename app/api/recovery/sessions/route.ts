import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WhatsappSessionRow } from "@/lib/recovery/types";
import { ensureSession, getSession, wahaConfigured } from "@/lib/whatsapp/waha";
import { authorize, dbError, errMessage, isUuid, jsonError, loadStore, nowIso, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Números de WhatsApp (sessões do WAHA) por loja. GET enriquece com o
// status ao vivo e grava de volta. POST cria/inicia a sessão no WAHA e
// registra a linha (depois disso o painel mostra o QR para ler no celular).

const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{1,40}$/i;

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const storeId = new URL(request.url).searchParams.get("store");
  if (storeId && !isUuid(storeId)) return jsonError("store inválida", 400);
  const admin = createAdminClient();
  let query = admin.from("whatsapp_sessions").select("*").order("name", { ascending: true });
  if (storeId) query = query.eq("store_id", storeId);
  const { data, error } = await query;
  if (error) return dbError(error);
  let sessions = (data ?? []) as Array<WhatsappSessionRow & { liveError?: string }>;

  if (wahaConfigured() && sessions.length > 0) {
    const now = nowIso();
    sessions = await Promise.all(
      sessions.map(async (s) => {
        try {
          const live = await getSession(s.name);
          const patch = { status: live?.status ?? "STOPPED", me_id: live?.me?.id ?? s.me_id, me_name: live?.me?.pushName ?? s.me_name, updated_at: now };
          if (patch.status !== s.status || patch.me_id !== s.me_id || patch.me_name !== s.me_name) {
            await admin.from("whatsapp_sessions").update(patch).eq("name", s.name);
          }
          return { ...s, ...patch };
        } catch (err) {
          return { ...s, liveError: errMessage(err) };
        }
      })
    );
  }
  return NextResponse.json({ sessions, wahaConfigured: wahaConfigured() });
}

const PostSchema = z.object({
  store: z.string(),
  name: z.string().trim().min(2).max(40),
  label: z.string().trim().max(120).nullable().optional(),
  daily_cap: z.number().int().min(0).max(5000).optional(),
});

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { data, response: bad } = await parseBody(request, PostSchema);
  if (bad) return bad;
  if (!isUuid(data.store)) return jsonError("store inválida", 400);
  if (!SESSION_NAME.test(data.name)) return jsonError("nome da sessão: só letras, números, hífen e sublinhado (ex.: olavita-1)", 400);
  if (!wahaConfigured()) return jsonError("WAHA não configurado (WAHA_URL / WAHA_API_KEY).", 503);
  const admin = createAdminClient();
  const store = await loadStore(admin, data.store);
  if (!store) return jsonError("loja não encontrada", 404);

  // Sessão com esse nome já ligada a OUTRA loja: não roubar.
  const { data: existing, error: exErr } = await admin.from("whatsapp_sessions").select("name, store_id").eq("name", data.name).maybeSingle();
  if (exErr) return dbError(exErr);
  if (existing && existing.store_id && existing.store_id !== data.store) return jsonError("essa sessão já pertence a outra loja", 409);

  let live;
  try {
    live = await ensureSession(data.name);
  } catch (err) {
    return jsonError(`WAHA não conseguiu criar/iniciar a sessão: ${errMessage(err)}`, 502);
  }
  const now = nowIso();
  const row: Record<string, unknown> = { name: data.name, store_id: data.store, status: live.status ?? null, me_id: live.me?.id ?? null, me_name: live.me?.pushName ?? null, last_event_at: now, updated_at: now };
  if (data.label !== undefined) row.label = data.label;
  if (data.daily_cap !== undefined) row.daily_cap = data.daily_cap;
  const { data: session, error } = await admin.from("whatsapp_sessions").upsert(row, { onConflict: "name" }).select("*").maybeSingle();
  if (error) return dbError(error);
  return NextResponse.json({ session: session as WhatsappSessionRow });
}
