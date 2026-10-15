import type { SupabaseClient } from "@supabase/supabase-js";

// O mesmo cliente às vezes escreve pra duas caixas diferentes (marcas
// diferentes que compartilham a mesma pessoa, ou ele responde um e-mail
// automático de marketing enviado por outra caixa) quase ao mesmo tempo, com
// a mensagem igual ou quase igual. Isso cria duas conversas paralelas: uma
// fica esquecida "pendente" mesmo depois de você já ter respondido a outra.
//
// Aqui a gente só fecha a duplicata quando tem certeza: mesmo e-mail, texto
// da mensagem muito parecido (uma contém boa parte da outra), criadas a
// poucas horas de distância. Nunca mexe na conversa "principal".
const PENDING = ["nova", "reaberta", "aguardando_humano"];
const WINDOW_HOURS = 72;

// Corta o pedaço de "citação da mensagem anterior" que alguns clientes de
// e-mail deixam (o remetente e a data que o cliente respondeu por cima), em
// vários idiomas — senão essas linhas poluem a comparação de similaridade.
const QUOTE_LINE = /^(on .+wrote:|le .+ a écrit\s*:?|em .+ escreveu:?|בתאריך .+(מאת|כתב).*:?)$/i;
export function stripQuoteLines(text: string): string {
  return (text || "")
    .split("\n")
    .filter((line) => !QUOTE_LINE.test(line.trim()))
    .join(" ");
}

// Prefixos de uma letra do hebraico (e, o, para, em, como, de, que...) que
// mudam a forma da palavra sem mudar o sentido — sem isso "קבלה" e "הקבלה"
// contam como palavras diferentes.
function stripHebrewPrefix(word: string): string {
  return /^[והלבכמש][א-ת]{3,}$/.test(word) ? word.slice(1) : word;
}

function normalize(text: string): string {
  return stripQuoteLines(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s\p{P}]+/gu, " ")
    .trim();
}

// Similaridade grosseira: uma string cabe quase inteira dentro da outra, ou
// compartilham boa parte das palavras (com stemming leve pro hebraico).
// Rápido, sem dependências — não precisa ser perfeito, só evitar falso positivo.
export function looksLikeSameMessage(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 8 || nb.length < 8) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (longer.includes(shorter)) return true;
  const words = (s: string) => new Set(s.split(" ").filter((w) => w.length > 2).map(stripHebrewPrefix));
  const wa = words(na);
  const wb = words(nb);
  if (wa.size < 2 || wb.size < 2) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.45;
}

export async function dedupeConversations(admin: SupabaseClient, limit = 500): Promise<number> {
  const { data: rows } = await admin
    .from("conversations")
    .select("id, store_id, created_at, last_message_at, customers(email), messages(direction, body, sent_at)")
    .in("status", PENDING)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  const byEmail = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const email = (r.customers as unknown as { email?: string } | null)?.email?.toLowerCase();
    if (!email) continue;
    (byEmail.get(email) ?? byEmail.set(email, []).get(email))!.push(r);
  }

  let closed = 0;
  const now = new Date().toISOString();
  for (const [, group] of byEmail) {
    if (!group || group.length < 2) continue;
    // Precisa ser de LOJAS diferentes: mesma loja com dois threads é outro problema.
    const byStore = new Map<string, (typeof group)[number][]>();
    for (const c of group) (byStore.get(c.store_id as string) ?? byStore.set(c.store_id as string, []).get(c.store_id as string))!.push(c);
    if (byStore.size < 2) continue;

    const withMsgs = group.map((c) => {
      const msgs = ((c.messages as unknown as Array<{ direction: string; body: string | null; sent_at: string | null }>) ?? []).sort((a, b) => (a.sent_at ?? "").localeCompare(b.sent_at ?? ""));
      const inbound = msgs.filter((m) => m.direction === "inbound");
      const hasReply = msgs.some((m) => m.direction !== "inbound");
      return { conv: c, inbound, hasReply, msgCount: msgs.length };
    });
    // Conversa sem NENHUMA resposta ainda é a única candidata a "duplicata
    // esquecida" — nunca fecha uma que já foi respondida por você.
    const candidates = withMsgs.filter((x) => !x.hasReply && x.inbound.length > 0);

    // Bug visto ao vivo (Galit, 21/09): cliente mandou a MESMA mensagem pra
    // duas lojas, nenhuma respondida ainda. A fechou como duplicata de B e,
    // na volta, B fechou como duplicata de A — as duas sumiram do Inbox e
    // ninguém respondeu. Agora: quem já foi fechada nesta rodada não serve
    // mais de "original", e entre duas sem resposta só a mais NOVA fecha.
    const closedNow = new Set<string>();
    for (const cand of candidates) {
      let bestMatch: (typeof withMsgs)[number] | null = null;
      for (const other of withMsgs) {
        if (other.conv.id === cand.conv.id || other.conv.store_id === cand.conv.store_id || closedNow.has(other.conv.id as string)) continue;
        // Compara CADA mensagem do candidato com CADA mensagem do outro lado —
        // a duplicata pode ter sido a primeira de uma conversa que já avançou.
        const matches = cand.inbound.some((ci) =>
          other.inbound.some((oi) => {
            const hoursApart = Math.abs(new Date(ci.sent_at ?? 0).getTime() - new Date(oi.sent_at ?? 0).getTime()) / 3_600_000;
            return hoursApart <= WINDOW_HOURS && looksLikeSameMessage(ci.body ?? "", oi.body ?? "");
          })
        );
        if (matches && (!bestMatch || other.hasReply)) bestMatch = other;
        if (matches && other.hasReply) break;
      }
      if (!bestMatch) continue;
      // Nenhuma das duas respondida: sobrevive a mais antiga (vai ser a
      // respondida); só fecha a candidata se ela for a mais nova.
      if (!bestMatch.hasReply && String(cand.conv.created_at ?? "") <= String(bestMatch.conv.created_at ?? "")) continue;
      closedNow.add(cand.conv.id as string);
      const { data: current } = await admin.from("conversations").select("analysis").eq("id", cand.conv.id).maybeSingle();
      const analysis = (current?.analysis ?? {}) as Record<string, unknown>;
      const { error } = await admin
        .from("conversations")
        .update({ status: "encerrada", closed_at: now, unread: false, analysis: { ...analysis, duplicate_of: bestMatch.conv.id, ticket: false, ticket_reason: null } })
        .eq("id", cand.conv.id);
      if (!error) closed += 1;
    }
  }
  return closed;
}

// Cliente manda o MESMO problema em e-mails separados (thread novo cada vez,
// sem responder o anterior) — comum quando ele clica em "escrever" de novo em
// vez de "responder". Você acaba respondendo só o mais recente, mas os
// antigos ficam esquecidos "pendentes" pra sempre (visto ao vivo, 24/09: 3
// casos onde uma resposta já enviada cobria uma conversa mais velha que não
// tinha ligação de thread nenhuma com ela — o checkbox "encerrar as outras
// pendências" do Inbox existe pra isso, mas só age no momento do envio; isso
// aqui é a rede de segurança pra quando ele não pegou ou já tinha mandado
// antes da resposta existir).
//
// Só fecha quando: mesmo cliente, e a resposta (mais recente) foi mandada
// DEPOIS do último e-mail dele na conversa pendente — ou seja, ele já tinha
// escrito aquilo quando a resposta saiu, então dá pra supor que ela cobre.
// Nunca fecha se a pendente for MAIS NOVA que a resposta (aí é assunto novo).
interface CoveredRow {
  id: string;
  customer_id: string;
  status: string;
  last_message_at: string | null;
  messages: Array<{ direction: string; sent_at: string | null }> | null;
}
export async function closeCoveredConversations(admin: SupabaseClient, limit = 500): Promise<number> {
  const { data: rows } = await admin
    .from("conversations")
    .select("id, customer_id, status, last_message_at, messages(direction, sent_at)")
    .neq("status", "spam")
    .not("customer_id", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  const byCustomer = new Map<string, CoveredRow[]>();
  for (const r of (rows ?? []) as unknown as CoveredRow[]) {
    const key = r.customer_id;
    (byCustomer.get(key) ?? byCustomer.set(key, []).get(key))!.push(r);
  }

  const ANSWERED = new Set(["respondida_humano", "respondida_ia"]);
  const now = new Date().toISOString();
  let closed = 0;
  for (const [, group] of byCustomer) {
    if (group.length < 2) continue;
    const withTimes = group.map((c) => {
      const msgs = (c.messages as unknown as Array<{ direction: string; sent_at: string | null }>) ?? [];
      const lastInbound = msgs.filter((m) => m.direction === "inbound").map((m) => m.sent_at ?? "").sort().pop() ?? "";
      const lastOutbound = msgs.filter((m) => m.direction !== "inbound").map((m) => m.sent_at ?? "").sort().pop() ?? "";
      return { conv: c, lastInbound, lastOutbound };
    });
    const pendingOnes = withTimes.filter((x) => PENDING.includes(x.conv.status as string) && x.lastInbound);
    const answeredOnes = withTimes.filter((x) => ANSWERED.has(x.conv.status as string) && x.lastOutbound);
    for (const p of pendingOnes) {
      const covering = answeredOnes.find((a) => a.conv.id !== p.conv.id && a.lastOutbound > p.lastInbound);
      if (!covering) continue;
      const { data: current } = await admin.from("conversations").select("analysis").eq("id", p.conv.id).maybeSingle();
      const analysis = (current?.analysis ?? {}) as Record<string, unknown>;
      const { error } = await admin
        .from("conversations")
        .update({ status: "encerrada", closed_at: now, unread: false, analysis: { ...analysis, covered_by: covering.conv.id, ticket: false, ticket_reason: null } })
        .eq("id", p.conv.id);
      if (!error) closed += 1;
    }
  }
  return closed;
}
