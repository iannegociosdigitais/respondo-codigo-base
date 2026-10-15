import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECOVERY_MISSING_TABLE } from "@/lib/recovery/types";

export const maxDuration = 30;

// Webhook do Resend (e-mail de recuperação e pós-compra). Assinatura no
// padrão Svix: HMAC-SHA256(base64) de "<svix-id>.<svix-timestamp>.<corpo cru>"
// com o segredo RESEND_WEBHOOK_SECRET ("whsec_<base64>"). Sem segredo = recusa.
//
//  email.delivered / opened / clicked → evento na recovery_events
//  email.bounced                      → evento + supressão (nunca mais recebe)
//  email.complained                   → evento + supressão + régua para
//  email.failed                       → evento failed
// Alvo: tags.run_id (pós-compra) ou tags.recovery_id (carrinho); senão o
// evento 'sent' com message_id = email_id (recovery_id ou run_id dele).
// Dedupe pelo svix-id (o Resend reenvia com o mesmo id). A trava de dedupe é
// gravada POR ÚLTIMO, depois da supressão e do status (cada escrita é
// conferida; erro = 500 sem trava, o Resend reentrega e reaplica, e a
// supressão é idempotente).
// Evento de teste do painel do Resend (dados fictícios, sem alvo) → 200 com
// unknown: true, para o Resend marcar o endpoint como saudável.

const TOLERANCE_S = 5 * 60;

function verify(raw: string, id: string | null, ts: string | null, sig: string | null): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !id || !ts || !sig) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return sig.split(/\s+/).some((part) => {
    const [, value] = part.split(",");
    return value && value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

interface ResendEvent {
  type: string;
  created_at?: string;
  data: { email_id?: string; to?: string[] | string; tags?: Record<string, string> | Array<{ name: string; value: string }>; bounce?: { type?: string; subType?: string; message?: string }; click?: { link?: string } };
}

const tagMap = (tags: ResendEvent["data"]["tags"]): Record<string, string> => (Array.isArray(tags) ? Object.fromEntries(tags.map((t) => [t.name, t.value])) : (tags ?? {}));

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

type Target = { kind: "recovery" | "run"; id: string; store_id: string; step: number | null };

export async function POST(request: Request) {
  const raw = await request.text();
  const svixId = request.headers.get("svix-id");
  if (!verify(raw, svixId, request.headers.get("svix-timestamp"), request.headers.get("svix-signature"))) {
    return NextResponse.json({ error: "assinatura inválida" }, { status: 401 });
  }
  let event: ResendEvent;
  try {
    event = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "json inválido" }, { status: 400 });
  }
  if (!event || typeof event !== "object" || !event.data || typeof event.data !== "object") return NextResponse.json({ ok: true, ignored: "evento sem dados" });
  const map: Record<string, string> = { "email.delivered": "delivered", "email.opened": "opened", "email.clicked": "clicked", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed" };
  const type = map[event.type];
  if (!type) return NextResponse.json({ ok: true, ignored: event.type });

  const admin = createAdminClient();
  const now = new Date().toISOString();
  try {
    const tags = tagMap(event.data.tags);
    // Envio de teste (foi pro test_email, não pro cliente): tag test=1 ou o
    // evento 'sent' do envio marcado is_test. O evento fica registrado como
    // teste e NÃO mexe no status do carrinho/run nem na supressão.
    type SentEvent = { recovery_id: string | null; run_id: string | null; store_id: string; step: number | null; is_test: boolean };
    let sentEvent: SentEvent | null = null;
    if (event.data.email_id) {
      const { data, error: sentErr } = await admin.from("recovery_events").select("recovery_id, run_id, store_id, step, is_test").eq("message_id", event.data.email_id).eq("type", "sent").order("created_at", { ascending: false }).limit(1).maybeSingle();
      // Sem saber se o envio é de teste não dá pra decidir supressão: 500 (o Resend reentrega).
      if (sentErr) throw new Error(sentErr.message);
      sentEvent = (data as SentEvent | null) ?? null;
    }
    const isTest = tags.test === "1" || Boolean(sentEvent?.is_test);

    let target: Target | null = null;
    if (isUuid(tags.run_id)) {
      const { data } = await admin.from("post_purchase_runs").select("id, store_id, step").eq("id", tags.run_id).maybeSingle();
      if (data) target = { kind: "run", id: data.id as string, store_id: data.store_id as string, step: (data.step as number | null) ?? null };
    }
    if (!target && isUuid(tags.recovery_id)) {
      const { data } = await admin.from("cart_recoveries").select("id, store_id, step").eq("id", tags.recovery_id).maybeSingle();
      if (data) target = { kind: "recovery", id: data.id as string, store_id: data.store_id as string, step: (data.step as number | null) ?? null };
    }
    if (!target && sentEvent) {
      if (sentEvent.run_id) target = { kind: "run", id: sentEvent.run_id, store_id: sentEvent.store_id, step: sentEvent.step };
      else if (sentEvent.recovery_id) target = { kind: "recovery", id: sentEvent.recovery_id, store_id: sentEvent.store_id, step: sentEvent.step };
    }
    if (!target) return NextResponse.json({ ok: true, unknown: true });

    const to = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;
    const stepFromTag = tags.step ? Number(tags.step) : NaN;
    const step = Number.isFinite(stepFromTag) ? stepFromTag : target.step;
    // 1) Efeitos de parada/supressão PRIMEIRO (escritas conferidas, idempotentes).
    //    Envio de teste não mexe em nada.
    if (!isTest) {
      const touch = target.kind === "run"
        ? await admin.from("post_purchase_runs").update({ last_event_at: now, updated_at: now }).eq("id", target.id)
        : await admin.from("cart_recoveries").update({ last_event_at: now, updated_at: now }).eq("id", target.id);
      if (touch.error) throw new Error(touch.error.message);

      if ((type === "bounced" || type === "complained") && to) {
        const hard = type === "complained" || /permanent|hard/i.test(event.data.bounce?.type ?? "permanent");
        if (hard) {
          const sup = await admin.from("recovery_suppressions").upsert({ channel: "email", address: to.toLowerCase(), reason: type, source: "resend" }, { onConflict: "channel,address", ignoreDuplicates: true });
          if (sup.error) throw new Error(sup.error.message);
          const stop = target.kind === "run"
            ? await admin.from("post_purchase_runs").update({ status: "parado_suprimido", stop_reason: type, next_at: null, updated_at: now }).eq("id", target.id).in("status", ["ativo", "pausado"])
            : await admin.from("cart_recoveries").update({ status: "parado_suprimido", stop_reason: type, next_send_at: null, email_next_at: null, wa_next_at: null, updated_at: now }).eq("id", target.id).in("status", ["ativo", "pausado"]);
          if (stop.error) throw new Error(stop.error.message);
        }
      }
    }

    // 2) Trava de dedupe POR ÚLTIMO.
    const { error } = await admin.from("recovery_events").insert({
      recovery_id: target.kind === "recovery" ? target.id : null,
      run_id: target.kind === "run" ? target.id : null,
      store_id: target.store_id,
      step,
      channel: "email",
      type,
      dedupe_key: svixId ? `resend:${svixId}` : null,
      provider: "resend",
      message_id: event.data.email_id ?? null,
      to_address: to?.toLowerCase() ?? null,
      is_test: isTest,
      detail: { bounce: event.data.bounce ?? null, link: event.data.click?.link ?? null, created_at: event.created_at ?? null },
    });
    if (error) {
      // Reentrega: já processado (efeitos acima são idempotentes).
      if (/duplicate key/i.test(error.message)) return NextResponse.json({ ok: true, duplicate: true });
      throw new Error(error.message);
    }
    if (isTest) return NextResponse.json({ ok: true, test: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("webhook resend:", message);
    // Migration 0018 ainda não rodou: 200 para o Resend não desativar o
    // endpoint por falhas repetidas; o evento se perde (não há onde gravar).
    if (RECOVERY_MISSING_TABLE.test(message)) return NextResponse.json({ ok: true, skipped: "tabela ausente" });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
