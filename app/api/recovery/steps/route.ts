import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryStep } from "@/lib/recovery/types";
import { authorize, channelParam, dbError, jsonError, loadStore, nowIso, parseBody, storeParam } from "@/app/api/recovery/_lib/shared";
import { flowParam } from "@/app/api/recovery/_lib/flow";

export const maxDuration = 60;

// Régua por loja, fluxo (carrinho abandonado / pós-compra) e canal. GET lista
// (channel opcional: sem ele, os dois canais do fluxo). PUT substitui a régua
// inteira do fluxo+canal: upsert por posição e depois apaga as posições que
// sobraram (nada se perde se o insert falhar). O pós-compra só tem e-mail.

export async function GET(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const { channel, response: badChannel } = channelParam(request, false);
  if (badChannel) return badChannel;
  const { flow, response: badFlow } = flowParam(request);
  if (badFlow || !flow) return badFlow ?? jsonError("flow inválido", 400);
  const admin = createAdminClient();
  let query = admin.from("recovery_steps").select("*").eq("store_id", storeId).eq("flow", flow).order("channel", { ascending: true }).order("position", { ascending: true });
  if (channel) query = query.eq("channel", channel);
  const { data, error } = await query;
  if (error) return dbError(error);
  return NextResponse.json({ flow, steps: (data ?? []) as RecoveryStep[] });
}

const LangKey = z.string().min(2).max(10);
const BodyValue = z.union([z.string().max(20000), z.array(z.string().max(4000)).max(20)]);
const StepSchema = z.object({
  position: z.number().int().min(1).max(50),
  delay_minutes: z.number().int().min(0).max(60 * 24 * 60),
  body: z.record(LangKey, BodyValue),
  subject: z.record(LangKey, z.string().max(500)).optional(),
  // Prévia (preheader) e rótulo do botão por idioma; vazios = comportamento padrão.
  preview: z.record(LangKey, z.string().max(500)).optional(),
  button: z.record(LangKey, z.string().max(120)).optional(),
  // Só no pós-compra: manda sempre / só com pedido enviado / só antes do envio.
  send_if: z.enum(["sempre", "enviado", "nao_enviado"]).optional(),
  discount_percent: z.number().min(0).max(90).nullable().optional(),
  enabled: z.boolean().optional(),
  name: z.string().trim().max(120).nullable().optional(),
  only_if_no_reply: z.boolean().optional(),
});
const PutSchema = z.object({ steps: z.array(StepSchema).max(50) });

// Mapa idioma → texto, sem chaves vazias e com o código em minúsculas.
function langMap(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, v] of Object.entries(input ?? {})) if (v.trim()) out[lang.toLowerCase()] = v.trim();
  return out;
}

export async function PUT(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { storeId, response } = storeParam(request);
  if (response) return response;
  const { channel, response: badChannel } = channelParam(request, true);
  if (badChannel || !channel) return badChannel ?? jsonError("channel é obrigatório", 400);
  const { flow, response: badFlow } = flowParam(request);
  if (badFlow || !flow) return badFlow ?? jsonError("flow inválido", 400);
  if (flow === "pos_compra" && channel !== "email") return jsonError("o pós-compra só tem régua de e-mail", 400);
  const { data, response: bad } = await parseBody(request, PutSchema);
  if (bad) return bad;

  // Posições únicas; a ordem enviada vira 1..n (a tela pode mandar buracos
  // depois de apagar um passo).
  const positions = data.steps.map((s) => s.position);
  if (new Set(positions).size !== positions.length) return jsonError("posições repetidas na régua", 400);
  const ordered = [...data.steps].sort((a, b) => a.position - b.position);

  const admin = createAdminClient();
  const store = await loadStore(admin, storeId);
  if (!store) return jsonError("loja não encontrada", 404);

  const now = nowIso();
  const rows = ordered.map((s, i) => {
    // WhatsApp: cada idioma vira lista de variantes; e-mail: texto único.
    const body: Record<string, string | string[]> = {};
    for (const [lang, v] of Object.entries(s.body)) {
      const key = lang.toLowerCase();
      if (channel === "whatsapp") {
        const list = (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean);
        if (list.length > 0) body[key] = list;
      } else {
        const text = Array.isArray(v) ? v.join("\n\n").trim() : v.trim();
        if (text) body[key] = text;
      }
    }
    const discount = s.discount_percent == null || s.discount_percent === 0 ? null : s.discount_percent;
    return {
      store_id: storeId,
      flow,
      channel,
      position: i + 1,
      name: s.name ?? null,
      delay_minutes: s.delay_minutes,
      only_if_no_reply: s.only_if_no_reply ?? true,
      discount_percent: discount,
      subject: langMap(s.subject),
      preview: langMap(s.preview),
      button: langMap(s.button),
      // "Enviar se" só faz sentido no pós-compra (depende do envio do pedido).
      send_if: flow === "pos_compra" ? (s.send_if ?? "sempre") : "sempre",
      body,
      enabled: s.enabled ?? true,
      updated_at: now,
    };
  });

  if (rows.length > 0) {
    const up = await admin.from("recovery_steps").upsert(rows, { onConflict: "store_id,flow,channel,position" });
    if (up.error) return dbError(up.error);
  }
  const del = admin.from("recovery_steps").delete().eq("store_id", storeId).eq("flow", flow).eq("channel", channel);
  const { error: delErr } = rows.length > 0 ? await del.gt("position", rows.length) : await del;
  if (delErr) return dbError(delErr);

  const { data: steps, error } = await admin.from("recovery_steps").select("*").eq("store_id", storeId).eq("flow", flow).eq("channel", channel).order("position", { ascending: true });
  if (error) return dbError(error);
  return NextResponse.json({ flow, steps: (steps ?? []) as RecoveryStep[] });
}
