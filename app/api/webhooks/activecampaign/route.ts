import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECOVERY_MISSING_TABLE } from "@/lib/recovery/types";

export const maxDuration = 30;

// Webhook do ActiveCampaign (quando ele é o canal de envio do e-mail de
// recuperação; ver lib/email/activecampaign.ts). O ActiveCampaign não assina
// o webhook: a URL cadastrada leva ?token=ACTIVECAMPAIGN_WEBHOOK_SECRET.
// Sem segredo no ambiente = recusa.
//
//  sent        → delivered
//  open        → opened (conta para "engajou" nos passos 5-7)
//  click       → clicked
//  reply       → replied (a régua de e-mail para)
//  bounce      → bounced; hard = supressão + régua para
//  unsubscribe → unsubscribed + supressão (e-mail e WhatsApp) + régua para
// Alvo: o último evento 'sent' do Respondo pelo ActiveCampaign para aquele
// e-mail (45 dias). Envio de teste (is_test) só registra, não mexe em nada.
// Formato: application/x-www-form-urlencoded com chaves "contact[email]" etc.
// (aceita JSON também). Dedupe por tipo + e-mail + data + campanha.

const MAP: Record<string, string> = { sent: "delivered", open: "opened", click: "clicked", reply: "replied", bounce: "bounced", unsubscribe: "unsubscribed" };

function tokenOk(request: Request): boolean {
  const secret = process.env.ACTIVECAMPAIGN_WEBHOOK_SECRET?.trim();
  const got = new URL(request.url).searchParams.get("token") ?? "";
  if (!secret || !got || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

async function readPayload(request: Request): Promise<Record<string, string>> {
  const raw = await request.text();
  const out: Record<string, string> = {};
  if (/^\s*\{/.test(raw)) {
    const flat = (obj: unknown, prefix: string) => {
      if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flat(v, prefix ? `${prefix}[${k}]` : k);
      else if (prefix) out[prefix] = obj == null ? "" : String(obj);
    };
    try {
      flat(JSON.parse(raw), "");
    } catch {
      /* corpo inválido: trata como vazio */
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export async function POST(request: Request) {
  if (!tokenOk(request)) return NextResponse.json({ error: "token inválido" }, { status: 401 });
  const p = await readPayload(request);
  const acType = (p.type ?? "").toLowerCase();
  const type = MAP[acType];
  if (!type) return NextResponse.json({ ok: true, ignored: acType || "sem tipo" });
  const email = (p["contact[email]"] ?? p.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: true, ignored: "sem e-mail" });

  const admin = createAdminClient();
  const now = new Date().toISOString();
  try {
    const since = new Date(Date.now() - 45 * 86400e3).toISOString();
    const { data: sent, error: sentErr } = await admin
      .from("recovery_events")
      .select("recovery_id, run_id, store_id, step, is_test, message_id")
      .eq("type", "sent")
      .eq("provider", "activecampaign")
      .eq("to_address", email)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sentErr) throw new Error(sentErr.message);
    // E-mail que não saiu pelo Respondo (campanha manual no painel do AC): ignora.
    if (!sent) return NextResponse.json({ ok: true, unknown: true });
    const isTest = Boolean(sent.is_test);
    const kind: "run" | "recovery" = sent.run_id ? "run" : "recovery";
    const targetId = (sent.run_id ?? sent.recovery_id) as string | null;
    if (!targetId) return NextResponse.json({ ok: true, unknown: true });

    if (!isTest) {
      const touch = kind === "run"
        ? await admin.from("post_purchase_runs").update({ last_event_at: now, updated_at: now }).eq("id", targetId)
        : await admin.from("cart_recoveries").update({ last_event_at: now, updated_at: now }).eq("id", targetId);
      if (touch.error) throw new Error(touch.error.message);

      const bounceType = (p["bounce[type]"] ?? p["bounce_type"] ?? "").toLowerCase();
      const hardBounce = type === "bounced" && !/soft/.test(bounceType);
      if (type === "unsubscribed" || hardBounce) {
        const reason = type === "unsubscribed" ? "unsubscribed" : "bounced";
        const addresses: Array<{ channel: string; address: string }> = [{ channel: "email", address: email }];
        if (type === "unsubscribed" && kind === "recovery") {
          const { data: rec } = await admin.from("cart_recoveries").select("phone").eq("id", targetId).maybeSingle();
          if (rec?.phone) addresses.push({ channel: "whatsapp", address: rec.phone as string });
        }
        for (const a of addresses) {
          const sup = await admin.from("recovery_suppressions").upsert({ store_id: null, channel: a.channel, address: a.address, reason, source: "activecampaign" }, { onConflict: "channel,address", ignoreDuplicates: true });
          if (sup.error) throw new Error(sup.error.message);
        }
        const status = type === "unsubscribed" ? "parado_descadastrou" : "parado_suprimido";
        const stopReason = type === "unsubscribed" ? "descadastrou" : "bounced";
        const stop = kind === "run"
          ? await admin.from("post_purchase_runs").update({ status, stop_reason: stopReason, next_at: null, updated_at: now }).eq("id", targetId).in("status", ["ativo", "pausado"])
          : await admin.from("cart_recoveries").update({ status, stop_reason: stopReason, next_send_at: null, email_next_at: null, wa_next_at: null, updated_at: now }).eq("id", targetId).in("status", ["ativo", "pausado"]);
        if (stop.error) throw new Error(stop.error.message);
      }
    }

    const dedupe = `ac:${acType}:${email}:${p.date_time ?? ""}:${p["campaign[id]"] ?? ""}:${p["link[url]"] ?? ""}`.slice(0, 500);
    const { error } = await admin.from("recovery_events").insert({
      recovery_id: kind === "recovery" ? targetId : null,
      run_id: kind === "run" ? targetId : null,
      store_id: sent.store_id,
      step: sent.step,
      channel: "email",
      type,
      dedupe_key: dedupe,
      provider: "activecampaign",
      message_id: sent.message_id ?? null,
      to_address: email,
      is_test: isTest,
      detail: { bounce: type === "bounced" ? { type: /soft/i.test(p["bounce[type]"] ?? "") ? "Transient" : "Permanent", raw: p["bounce[type]"] ?? null } : null, link: p["link[url]"] ?? null, date_time: p.date_time ?? null, campaign: p["campaign[id]"] ?? null },
    });
    if (error) {
      if (/duplicate key/i.test(error.message)) return NextResponse.json({ ok: true, duplicate: true });
      throw new Error(error.message);
    }
    return NextResponse.json({ ok: true, ...(isTest ? { test: true } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("webhook activecampaign:", message);
    if (RECOVERY_MISSING_TABLE.test(message)) return NextResponse.json({ ok: true, skipped: "tabela ausente" });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
