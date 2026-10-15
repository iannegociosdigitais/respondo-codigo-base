import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Painel de controle: métricas do período (hoje / 7 / 30 / 90 dias),
// volume por dia, categorias, contadores de tickets e conversas recentes.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const storeId = url.searchParams.get("store");
  const days = Math.max(1, Math.min(Number(url.searchParams.get("days") ?? 7), 365));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const sinceIso = since.toISOString();

  const admin = createAdminClient();

  let convQuery = admin
    .from("conversations")
    .select("id, status, category, urgency, last_message_at, created_at")
    .gte("last_message_at", sinceIso)
    .neq("status", "spam");
  if (storeId) convQuery = convQuery.eq("store_id", storeId);

  let msgQuery = admin.from("messages").select("direction, sent_at, created_at, conversations!inner(store_id)").gte("sent_at", sinceIso);
  if (storeId) msgQuery = msgQuery.eq("conversations.store_id", storeId);
  let allQuery = admin.from("conversations").select("status").neq("status", "spam");
  if (storeId) allQuery = allQuery.eq("store_id", storeId);
  let spamQuery = admin.from("conversations").select("id", { count: "exact", head: true }).eq("status", "spam");
  if (storeId) spamQuery = spamQuery.eq("store_id", storeId);
  // Todas as consultas em paralelo: o Painel abre no tempo da mais lenta.
  const [{ data: convs }, { data: msgs }, { data: all }, { count: spam }] = await Promise.all([convQuery, msgQuery, allQuery, spamQuery]);

  const recebidas = (msgs ?? []).filter((m) => m.direction === "inbound").length;
  const atendidasIA = (msgs ?? []).filter((m) => m.direction === "outbound_ai").length;
  const atendidasHumano = (msgs ?? []).filter((m) => m.direction === "outbound_human").length;
  const atendidas = atendidasIA + atendidasHumano;

  const porDia: Record<string, { recebidas: number; respondidas: number }> = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    porDia[d.toISOString().slice(0, 10)] = { recebidas: 0, respondidas: 0 };
  }
  for (const m of msgs ?? []) {
    const key = ((m.sent_at as string | null) ?? (m.created_at as string)).slice(0, 10);
    if (!porDia[key]) continue;
    if (m.direction === "inbound") porDia[key].recebidas += 1;
    else porDia[key].respondidas += 1;
  }

  const categorias: Record<string, number> = {};
  for (const c of convs ?? []) {
    const k = (c.category as string | null) ?? "sem_categoria";
    categorias[k] = (categorias[k] ?? 0) + 1;
  }

  const tickets = { pendentes: 0, respondidos: 0, reabertos: 0, encerrados: 0 };
  for (const c of all ?? []) {
    const s = c.status as string;
    if (s === "nova" || s === "aguardando_humano") tickets.pendentes += 1;
    else if (s === "reaberta") tickets.reabertos += 1;
    else if (s === "respondida_ia" || s === "respondida_humano") tickets.respondidos += 1;
    else if (s === "encerrada") tickets.encerrados += 1;
  }


  const resolvidasSemHumano = (convs ?? []).filter((c) => c.status === "respondida_ia").length;
  const totalTratadas = (convs ?? []).filter((c) => c.status !== "nova").length;

  // Modo revisão: o que a IA já deixou pronto e só falta o dono ler e enviar.
  const PEND = ["nova", "reaberta", "aguardando_humano"];
  let readyQ = admin.from("conversations").select("id", { count: "exact", head: true }).in("status", PEND).not("draft_reply", "is", null).neq("draft_reply", "");
  let noDraftQ = admin.from("conversations").select("id", { count: "exact", head: true }).in("status", PEND).or("draft_reply.is.null,draft_reply.eq.");
  if (storeId) {
    readyQ = readyQ.eq("store_id", storeId);
    noDraftQ = noDraftQ.eq("store_id", storeId);
  }
  // Consumo da OpenAI: soma do que cada conversa gastou (triagem + redação +
  // tradução), contando regenerações. Só existe a partir de 18/09/2026.
  let usageQ = admin.from("conversations").select("analysis->usage_total, analysis->model").not("analysis->usage_total", "is", null).gte("analyzed_at", sinceIso).limit(2000);
  if (storeId) usageQ = usageQ.eq("store_id", storeId);
  // Recuperação de carrinho e pós-compra no período (regra do Ian, 15/10):
  // o painel inicial mostra quanto foi recuperado COM contato nosso (e-mail
  // ou WhatsApp antes da compra), separado de quem comprou sozinho.
  let cartsQ = admin.from("cart_recoveries").select("id, store_id, status, first_contact_at, recovered_at, recovered_amount, recovered_currency, recovered_channel, abandoned_at, next_send_at").or(`first_contact_at.gte.${sinceIso},recovered_at.gte.${sinceIso},abandoned_at.gte.${sinceIso}`).limit(5000);
  let evQ = admin.from("recovery_events").select("recovery_id, run_id, step, channel, type, is_test").gte("created_at", sinceIso).in("type", ["sent", "opened", "read", "clicked", "replied", "bounced", "unsubscribed"]).limit(20000);
  let runsQ = admin.from("post_purchase_runs").select("id", { count: "exact", head: true }).gte("purchased_at", sinceIso);
  if (storeId) {
    cartsQ = cartsQ.eq("store_id", storeId);
    evQ = evQ.eq("store_id", storeId);
    runsQ = runsQ.eq("store_id", storeId);
  }
  const waQ = admin.from("whatsapp_sessions").select("name, status, active, restricted_until");
  const [ready, noDraft, alertRows, { data: usageRows }, cartsRes, evRes, runsRes, waRes] = await Promise.all([readyQ, noDraftQ, admin.from("store_email_accounts").select("email_address, last_error").not("last_error", "is", null), usageQ, cartsQ, evQ, runsQ, waQ]);

  const BOUGHT = new Set(["recuperado", "parado_comprou"]);
  const CONTACT = new Set(["email", "whatsapp", "sms"]);
  const money = (v: unknown) => (v == null ? 0 : Number(v));
  const cur = (c: unknown) => (typeof c === "string" && c ? c : "ILS");
  const canal = { email: { compras: 0, valor: {} as Record<string, number> }, whatsapp: { compras: 0, valor: {} as Record<string, number> } };
  const rec = { contatados: 0, comprouComContato: 0, valorComContato: {} as Record<string, number>, comprouSozinho: 0, valorSozinho: {} as Record<string, number>, abandonados: 0, ativos: 0, taxa: 0 };
  for (const c of (cartsRes.data ?? []) as Array<Record<string, unknown>>) {
    if ((c.abandoned_at as string) >= sinceIso) rec.abandonados += 1;
    if (c.status === "ativo") rec.ativos += 1;
    if (c.first_contact_at && (c.first_contact_at as string) >= sinceIso) rec.contatados += 1;
    if (!BOUGHT.has(c.status as string) || !c.recovered_at || (c.recovered_at as string) < sinceIso) continue;
    const k = cur(c.recovered_currency);
    const ch = c.recovered_channel as string | null;
    if (ch && CONTACT.has(ch)) {
      rec.comprouComContato += 1;
      rec.valorComContato[k] = (rec.valorComContato[k] ?? 0) + money(c.recovered_amount);
      const b = ch === "whatsapp" ? canal.whatsapp : canal.email;
      b.compras += 1;
      b.valor[k] = (b.valor[k] ?? 0) + money(c.recovered_amount);
    } else {
      rec.comprouSozinho += 1;
      rec.valorSozinho[k] = (rec.valorSozinho[k] ?? 0) + money(c.recovered_amount);
    }
  }
  rec.taxa = rec.contatados ? Math.round((rec.comprouComContato / rec.contatados) * 1000) / 10 : 0;
  // Funil de e-mail por pessoa (abertura e clique únicos por envio), carrinho x pós-compra.
  const mk = () => ({ enviados: 0, pessoas: new Set<string>(), abertos: new Set<string>(), cliques: new Set<string>(), bounces: 0, descadastros: 0 });
  const fCart = mk();
  const fPos = mk();
  const wa = { contatos: new Set<string>(), mensagens: 0, respostas: new Set<string>(), cliques: new Set<string>() };
  for (const e of (evRes.data ?? []) as Array<{ recovery_id: string | null; run_id: string | null; step: number | null; channel: string; type: string; is_test: boolean }>) {
    if (e.is_test) continue;
    const id = e.run_id ?? e.recovery_id;
    if (!id) continue;
    const key = `${id}:${e.step ?? 0}`;
    if (e.channel === "whatsapp") {
      if (e.type === "sent") { wa.mensagens += 1; wa.contatos.add(id); }
      else if (e.type === "replied") wa.respostas.add(id);
      else if (e.type === "clicked") wa.cliques.add(id);
      continue;
    }
    if (e.channel !== "email") continue;
    const f = e.run_id ? fPos : fCart;
    if (e.type === "sent") { f.enviados += 1; f.pessoas.add(id); }
    else if (e.type === "opened" || e.type === "read") f.abertos.add(key);
    else if (e.type === "clicked") f.cliques.add(key);
    else if (e.type === "bounced") f.bounces += 1;
    else if (e.type === "unsubscribed") f.descadastros += 1;
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const funil = (f: ReturnType<typeof mk>) => ({ enviados: f.enviados, pessoas: f.pessoas.size, abertos: f.abertos.size, taxaAbertura: pct(f.abertos.size, f.enviados), cliques: f.cliques.size, taxaClique: pct(f.cliques.size, f.enviados), bounces: f.bounces, descadastros: f.descadastros });
  const recuperacao = {
    ...rec,
    porCanal: canal,
    email: funil(fCart),
    whatsapp: { contatos: wa.contatos.size, mensagens: wa.mensagens, respostas: wa.respostas.size, taxaResposta: pct(wa.respostas.size, wa.contatos.size), cliques: wa.cliques.size },
    posCompra: { compras: runsRes.count ?? 0, ...funil(fPos) },
  };
  // Chip de WhatsApp fora do ar = recuperação parada: vira alerta no topo.
  const waAlerts = ((waRes.data ?? []) as Array<{ name: string; status: string | null; active: boolean; restricted_until: string | null }>)
    .filter((s) => s.active && s.status !== "WORKING")
    .map((s) => `WhatsApp (${s.name}): sessão ${s.status ?? "desconhecida"}. Nenhuma mensagem de carrinho sai até escanear o QR de novo.`);
  const ia = { respostas: 0, custoUsd: 0, chamadas: 0, tokensEntrada: 0, tokensSaida: 0, porModelo: {} as Record<string, number> };
  for (const r of (usageRows ?? []) as Array<{ usage_total: { cost_usd?: number; calls?: number; input_tokens?: number; cached_tokens?: number; output_tokens?: number; by_model?: Record<string, number> } | null }>) {
    const u = r.usage_total;
    if (!u) continue;
    ia.respostas += 1;
    ia.custoUsd += u.cost_usd ?? 0;
    ia.chamadas += u.calls ?? 0;
    ia.tokensEntrada += (u.input_tokens ?? 0) + (u.cached_tokens ?? 0);
    ia.tokensSaida += u.output_tokens ?? 0;
    for (const [m, c] of Object.entries(u.by_model ?? {})) ia.porModelo[m] = (ia.porModelo[m] ?? 0) + c;
  }


  return NextResponse.json({
    revisao: { prontos: ready.count ?? 0, semRascunho: noDraft.count ?? 0 },
    ia: { ...ia, custoUsd: Number(ia.custoUsd.toFixed(4)), custoMedioUsd: ia.respostas ? Number((ia.custoUsd / ia.respostas).toFixed(4)) : 0 },
    alertas: [...waAlerts, ...(alertRows.data ?? []).map((a) => `${a.email_address}: ${a.last_error}`)],
    recuperacao,
    periodoDias: days,
    recebidas,
    atendidas,
    atendidasIA,
    atendidasHumano,
    automacao: atendidas > 0 ? Math.round((atendidasIA / atendidas) * 1000) / 10 : 0,
    sucesso: totalTratadas > 0 ? Math.round((resolvidasSemHumano / totalTratadas) * 1000) / 10 : 0,
    tickets,
    spam: spam ?? 0,
    porDia: Object.entries(porDia).map(([dia, v]) => ({ dia, ...v })),
    categorias,
  });
}
