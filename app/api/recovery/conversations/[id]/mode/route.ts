import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RecoveryRow, RecoverySettings, RecoveryStep } from "@/lib/recovery/types";
import { nextAllowedTime } from "@/lib/recovery/schedule";
import { authorize, dbError, isUuid, jsonError, nowIso, parseBody } from "@/app/api/recovery/_lib/shared";

export const maxDuration = 60;

// Quem responde a conversa: agente (IA), humano (você) ou pausado (ninguém).
// resolve=true limpa o "precisa de humano"; devolver ao agente também limpa.
// Assumir (humano) desagenda só o WhatsApp (wa_next_at): o motor só pula
// agent_mode = pausado, então sem isso o próximo passo de WhatsApp sairia no
// meio da conversa humana. O e-mail (email_next_at) NÃO é mexido: a conversa
// humana é no WhatsApp e a régua de e-mail segue o seu curso (ela para sozinha
// se o cliente responder o e-mail ou comprar).
// Devolver ao agente reagenda o próximo passo do e-mail, se houver passo
// seguinte, o carrinho estiver ativo e o cliente não tiver respondido por
// e-mail (o WhatsApp não volta: a conversa segue pelo agente). A resposta traz
// `warnings` para o painel dizer o que aconteceu com a régua.

const BodySchema = z.object({
  mode: z.enum(["agente", "humano", "pausado"]),
  resolve: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await authorize(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return jsonError("id inválido", 400);
  const { data, response } = await parseBody(request, BodySchema);
  if (response) return response;

  const patch: Record<string, unknown> = { agent_mode: data.mode, updated_at: nowIso() };
  if (data.resolve || data.mode === "agente") {
    patch.needs_human = false;
    patch.needs_human_reason = null;
  }
  const admin = createAdminClient();
  const warnings: string[] = [];
  if (data.mode === "humano" || data.mode === "agente") {
    const curRes = await admin.from("cart_recoveries").select("*").eq("id", id).maybeSingle();
    if (curRes.error) return dbError(curRes.error);
    const cur = curRes.data as RecoveryRow | null;
    if (!cur) return jsonError("conversa não encontrada", 404);

    if (data.mode === "humano") {
      patch.wa_next_at = null;
      // O próximo envio passa a ser só o do e-mail (se ainda agendado).
      patch.next_send_at = cur.email_next_at ?? null;
      if (cur.wa_next_at) warnings.push("Os próximos passos de WhatsApp foram desagendados: a conversa é sua.");
      if (cur.email_next_at && cur.status === "ativo") warnings.push("A régua de e-mail continua agendada (ela para sozinha se o cliente responder o e-mail ou comprar).");
    } else if (cur.status !== "ativo") {
      warnings.push("O carrinho não está ativo (pausado, encerrado ou comprou): nada foi reagendado na régua.");
    } else if (!cur.email) {
      warnings.push("Sem e-mail neste carrinho: nenhum e-mail da régua para reagendar.");
    } else {
      const [setRes, stepsRes, repRes] = await Promise.all([
        admin.from("recovery_settings").select("quiet_hours").eq("store_id", cur.store_id).maybeSingle(),
        admin.from("recovery_steps").select("*").eq("store_id", cur.store_id).eq("enabled", true).eq("channel", "email").order("position", { ascending: true }),
        admin.from("recovery_events").select("id").eq("recovery_id", id).eq("type", "replied").eq("channel", "email").limit(1),
      ]);
      if (setRes.error) return dbError(setRes.error);
      if (stepsRes.error) return dbError(stepsRes.error);
      if (repRes.error) return dbError(repRes.error);
      const quiet = (setRes.data as Pick<RecoverySettings, "quiet_hours"> | null)?.quiet_hours ?? null;
      // Só a régua de carrinho (o campo flow pode não existir em bancos antigos: sem ele, é carrinho).
      const steps = ((stepsRes.data ?? []) as Array<RecoveryStep & { flow?: string }>).filter((st) => (st.flow ?? "carrinho") === "carrinho");
      const nextEmail = steps.find((st) => st.position === (cur.email_step ?? 0) + 1);
      if ((repRes.data ?? []).length > 0) {
        warnings.push("O cliente respondeu por e-mail: a régua de e-mail não volta.");
      } else if (!nextEmail) {
        warnings.push("A régua de e-mail já terminou para este carrinho: nenhum e-mail novo será agendado.");
      } else {
        const now = new Date();
        const soon = nextAllowedTime(now, cur.country_code, quiet).toISOString();
        const keepFuture = (v: string | null) => (v && new Date(v).getTime() > now.getTime() ? v : null);
        const emailAt = keepFuture(cur.email_next_at) ?? soon;
        patch.email_next_at = emailAt;
        const nexts = [emailAt, cur.wa_next_at].filter((x): x is string => typeof x === "string").map((x) => new Date(x).getTime());
        patch.next_send_at = new Date(Math.min(...nexts)).toISOString();
        warnings.push(`Régua de e-mail reagendada: passo ${nextEmail.position} sai a partir de ${new Date(emailAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (horário de Brasília), respeitando o horário do cliente.`);
      }
      if (!cur.wa_next_at) warnings.push("O WhatsApp não volta para a régua: a conversa segue com o agente.");
    }
  }
  const { data: recovery, error } = await admin.from("cart_recoveries").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return dbError(error);
  if (!recovery) return jsonError("conversa não encontrada", 404);
  return NextResponse.json({ ok: true, recovery: recovery as RecoveryRow, warnings });
}
