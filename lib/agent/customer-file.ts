import type { SupabaseClient } from "@supabase/supabase-js";

// Dossiê do cliente: TODAS as mensagens dele (todas as conversas, todas as
// lojas em que aparece com o mesmo e-mail), em ordem cronológica. É o que a
// IA lê antes de responder e o que o Inbox mostra como um chat único.
export interface FileMessage {
  id: string;
  conversation_id: string;
  direction: string;
  subject: string | null;
  body: string | null;
  body_pt: string | null;
  from_address: string | null;
  to_address: string | null;
  at: string;
}

export interface CustomerFile {
  messages: FileMessage[];
  conversationIds: string[];
  // E-mails do cliente depois da última resposta da loja (em qualquer conversa).
  unanswered: FileMessage[];
  waitingDays: number;
  firstContactAt: string | null;
  lastStoreReplyAt: string | null;
}

export async function loadCustomerFile(admin: SupabaseClient, customerId: string | null, customerEmail: string): Promise<CustomerFile> {
  const empty: CustomerFile = { messages: [], conversationIds: [], unanswered: [], waitingDays: 0, firstContactAt: null, lastStoreReplyAt: null };
  const { data: sameEmail } = await admin.from("customers").select("id").ilike("email", customerEmail);
  const customerIds = [...new Set([...(sameEmail ?? []).map((c) => c.id as string), ...(customerId ? [customerId] : [])])];
  if (customerIds.length === 0) return empty;

  const { data: convs } = await admin.from("conversations").select("id").in("customer_id", customerIds).neq("status", "spam").limit(200);
  const conversationIds = (convs ?? []).map((c) => c.id as string);
  if (conversationIds.length === 0) return empty;

  const { data: msgs } = await admin
    .from("messages")
    .select("id, conversation_id, direction, subject, body, body_pt, from_address, to_address, sent_at, created_at")
    .in("conversation_id", conversationIds)
    .limit(500);
  const messages: FileMessage[] = (msgs ?? [])
    .map((m) => ({
      id: m.id as string,
      conversation_id: m.conversation_id as string,
      direction: m.direction as string,
      subject: (m.subject as string | null) ?? null,
      body: (m.body as string | null) ?? null,
      body_pt: (m.body_pt as string | null) ?? null,
      from_address: (m.from_address as string | null) ?? null,
      to_address: (m.to_address as string | null) ?? null,
      at: ((m.sent_at as string | null) ?? (m.created_at as string)) as string,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const lastStore = [...messages].reverse().find((m) => m.direction !== "inbound") ?? null;
  const unanswered = messages.filter((m) => m.direction === "inbound" && (!lastStore || m.at > lastStore.at));
  const waitingDays = unanswered[0] ? Math.floor((Date.now() - new Date(unanswered[0].at).getTime()) / 86400000) : 0;
  return {
    messages,
    conversationIds,
    unanswered,
    waitingDays,
    firstContactAt: messages.find((m) => m.direction === "inbound")?.at ?? null,
    lastStoreReplyAt: lastStore?.at ?? null,
  };
}

// Histórico completo em texto pro modelo: cada mensagem até 1800 caracteres,
// total limitado mantendo as mais recentes (as antigas viram uma linha).
export function fileTranscript(file: CustomerFile, excludeMessageId: string | null, maxChars = 45000): string {
  const lines = file.messages
    .filter((m) => m.id !== excludeMessageId)
    .map((m) => {
      const quem = m.direction === "inbound" ? "Cliente" : m.direction === "outbound_human" ? "Loja (equipe)" : "Loja (IA)";
      const dia = new Date(m.at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
      return `[${dia}] ${quem}${m.subject ? ` — assunto "${m.subject}"` : ""}:\n${(m.body ?? "").slice(0, 1800)}`;
    });
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length;
    if (total > maxChars) {
      kept.unshift(`(… ${i + 1} mensagem(ns) mais antigas omitidas por tamanho …)`);
      break;
    }
    kept.unshift(lines[i]);
  }
  return kept.join("\n\n");
}
