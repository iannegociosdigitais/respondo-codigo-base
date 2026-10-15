import type { SupabaseClient } from "@supabase/supabase-js";

// Inbox só com quem escreveu há pouco tempo — responder e-mail de meses
// atrás só lembra o cliente de um problema que ele já esqueceu.
//  · até `days` dias: fica tudo;
//  · de `days` a `urgentDays` dias: só os urgentes (ameaça, raiva 5, "urgente");
//  · mais de `urgentDays` dias: só quem tem contestação bancária ABERTA.
// O resto é encerrado e marcado como lido (dá pra reabrir).
export async function archiveStale(admin: SupabaseClient, days = 20, urgentDays = 30): Promise<number> {
  const { data } = await admin
    .from("conversations")
    .select("id, urgency, anger_level, mentions_threat, last_message_at, cb:analysis->chargeback_open, customers(email)")
    .in("status", ["nova", "reaberta", "aguardando_humano"])
    .limit(2000);
  const rows = data ?? [];
  const latest = new Map<string, string>();
  const urgent = new Set<string>();
  const dispute = new Set<string>();
  for (const r of rows) {
    const email = ((r.customers as unknown as { email: string } | null)?.email ?? r.id).toLowerCase();
    const at = (r.last_message_at as string | null) ?? "";
    if (at > (latest.get(email) ?? "")) latest.set(email, at);
    if ((r as unknown as { cb: boolean | null }).cb === true) dispute.add(email);
    if (r.mentions_threat || ((r.anger_level as number | null) ?? 0) >= 5 || r.urgency === "urgente") urgent.add(email);
  }
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const hardCutoff = new Date(Date.now() - urgentDays * 86400000).toISOString();
  const ids = rows
    .filter((r) => {
      const email = ((r.customers as unknown as { email: string } | null)?.email ?? r.id).toLowerCase();
      const last = latest.get(email) ?? "";
      if (last < hardCutoff) return !dispute.has(email);
      return last < cutoff && !urgent.has(email);
    })
    .map((r) => r.id as string);
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 100) {
    await admin.from("conversations").update({ status: "encerrada", closed_at: now, unread: false }).in("id", ids.slice(i, i + 100));
  }
  return ids.length;
}
