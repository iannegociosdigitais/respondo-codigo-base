import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkoutUrlFor, readRecoveryToken } from "@/lib/recovery/links";
import { resolveContactTarget } from "@/lib/recovery/welcome";
import type { RecoveryRow, RecoverySettings } from "@/lib/recovery/types";

// Link de clique das mensagens de recuperação: registra o clique e manda a
// pessoa pro checkout da Shopify já com o carrinho e o cupom do degrau.
// Público (sem login). Token assinado: não dá pra forjar nem enumerar.
//
// Cupom: o token traz o código que SAIU na mensagem (campo d). Links antigos
// sem d caem no passo da régua (recovery_steps, pelo canal e posição) →
// percentual → cupom ativo da loja com esse percentual. Nada encontrado =
// redireciona sem cupom (nunca inventa código).
//
// Token k = 'run' (pós-compra): o id é de post_purchase_runs. Registra o clique
// (evento 'clicked' com run_id) e leva ao "fale conosco": contact_url da loja
// (http/https) vira redirecionamento; mailto ou sem destino devolve uma página
// mínima com o link de contato (mailto não abre por redirecionamento 302 de
// forma confiável).
//
// Teste (campo t no token): o carrinho é de um cliente real emprestado pro
// envio de teste. Só redireciona: nenhum evento, nada muda no carrinho.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = readRecoveryToken(token);
  if (!payload) return new Response("Link inválido.", { status: 404 });
  const admin = createAdminClient();
  if (payload.k === "run") return handleRun(admin, payload);
  const { data: rec } = await admin.from("cart_recoveries").select("id, store_id, recovery_url, step, discount_codes, items").eq("id", payload.r).maybeSingle();
  if (!rec) return new Response(payload.t ? "Link de teste de um carrinho fictício: não há checkout para abrir." : "Link expirado.", { status: 404 });
  const isTest = payload.t === 1;
  // Destino: a URL de recuperação com o cupom, ou (cupom antigo dos anúncios)
  // um checkout novo pelo permalink do carrinho. Ver checkoutUrlFor.
  const cart = rec as Pick<RecoveryRow, "recovery_url" | "discount_codes" | "items">;

  const channel = payload.c ?? "email";
  const step = payload.s ?? (rec.step as number);
  let code: string | null = payload.d?.trim() || null;
  if (!code && (channel === "email" || channel === "whatsapp")) {
    // Só a régua do carrinho: o pós-compra tem as mesmas posições por canal e,
    // sem o filtro de fluxo, a consulta devolve duas linhas e o cupom some.
    const { data: stepRow } = await admin.from("recovery_steps").select("discount_percent").eq("store_id", rec.store_id).eq("flow", "carrinho").eq("channel", channel).eq("position", step).maybeSingle();
    const percent = stepRow?.discount_percent == null ? NaN : Number(stepRow.discount_percent);
    if (Number.isFinite(percent) && percent > 0) {
      const { data: discount } = await admin.from("recovery_discounts").select("code").eq("store_id", rec.store_id).eq("percent", percent).eq("active", true).limit(1).maybeSingle();
      code = (discount?.code as string | undefined) ?? null;
    }
  }

  // Clique de teste: só redireciona (nada gravado no carrinho real).
  if (isTest) return NextResponse.redirect(checkoutUrlFor(cart, code), { status: 302, headers: { "Cache-Control": "no-store" } });

  // Primeiro clique por degrau/canal fica na chave única; os seguintes só contam no detalhe.
  const now = new Date().toISOString();
  const { error } = await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step, channel, type: "clicked", dedupe_key: `click:${rec.id}:${step}:${channel}`, discount_code: code, detail: { at: now } });
  if (error && /duplicate key/i.test(error.message)) {
    await admin.from("recovery_events").insert({ recovery_id: rec.id, store_id: rec.store_id, step, channel, type: "clicked", discount_code: code, detail: { at: now, repeat: true } });
  }
  await admin.from("cart_recoveries").update({ last_event_at: now, updated_at: now }).eq("id", rec.id);

  return NextResponse.redirect(checkoutUrlFor(cart, code), { status: 302, headers: { "Cache-Control": "no-store" } });
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// Página mínima com o link de contato (destino mailto ou sem destino).
function contactPage(target: string | null): Response {
  const body = target
    ? `<p><a href="${escapeHtml(target)}" style="color:#111;font-size:18px;">${escapeHtml(target.replace(/^mailto:/i, "").replace(/\?.*$/, ""))}</a></p>`
    : `<p style="font-size:16px;">Please reply to the email you received.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Contact</title></head><body style="font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;margin:0;padding:40px 16px;color:#222;text-align:center">${body}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Clique de e-mail do pós-compra (token k = 'run').
async function handleRun(admin: ReturnType<typeof createAdminClient>, payload: NonNullable<ReturnType<typeof readRecoveryToken>>): Promise<Response> {
  const isTest = payload.t === 1;
  const { data: run } = await admin.from("post_purchase_runs").select("id, store_id, step, order_name").eq("id", payload.r).maybeSingle();
  if (!run) return new Response(isTest ? "Link de teste de um pedido fictício: não há página de contato para abrir." : "Link expirado.", { status: 404 });

  // Destino: contact_url (http/https), senão mailto do reply_to / caixa conectada.
  const { data: settings } = await admin.from("recovery_settings").select("store_id, contact_url, reply_to").eq("store_id", run.store_id).maybeSingle();
  const target = settings ? await resolveContactTarget(admin, settings as Pick<RecoverySettings, "store_id" | "contact_url" | "reply_to">, (run.order_name as string | null) ?? null).catch(() => null) : null;

  // Clique de teste: só leva ao destino (nada gravado no run real).
  if (!isTest) {
    const step = payload.s ?? (run.step as number);
    const now = new Date().toISOString();
    const { error } = await admin.from("recovery_events").insert({ recovery_id: null, run_id: run.id, store_id: run.store_id, step, channel: "email", type: "clicked", dedupe_key: `click:run:${run.id}:${step}:email`, detail: { at: now } });
    if (error && /duplicate key/i.test(error.message)) {
      await admin.from("recovery_events").insert({ recovery_id: null, run_id: run.id, store_id: run.store_id, step, channel: "email", type: "clicked", detail: { at: now, repeat: true } });
    }
    await admin.from("post_purchase_runs").update({ last_event_at: now, updated_at: now }).eq("id", run.id);
  }

  if (target && /^https?:\/\//i.test(target)) return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
  return contactPage(target);
}
