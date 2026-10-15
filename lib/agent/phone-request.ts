import type { SupabaseClient } from "@supabase/supabase-js";
import { orderInStore } from "@/lib/agent/chargeback";

// Pedido curto e proativo (não é resposta a nada do cliente): confirmar o
// telefone de entrega que falta no pedido. Nunca envia sozinho.
const COUNTRY_LANG: Record<string, string> = { FR: "fr", CA: "fr", CH: "fr", BE: "fr", LU: "fr", TR: "tr", IL: "he", DE: "de", AT: "de", DK: "da", HU: "hu" };

interface Template { subject: string; body: string; bodyPt: string }
const PHONE_REQUEST: Record<string, (name: string, order: string) => Template> = {
  fr: (name, order) => ({
    subject: `Votre commande ${order} — pouvez-vous confirmer votre numéro de téléphone ?`,
    body: `Bonjour ${name || ""},\n\nPetite question rapide au sujet de votre commande ${order} : pourriez-vous nous confirmer votre numéro de téléphone ? Le transporteur en a besoin pour vous contacter au moment de la livraison.\n\nMerci d'avance, et n'hésitez pas si vous avez la moindre question.\n\nCordialement,\nL'équipe OstéoPure`,
    bodyPt: `Olá ${name || ""},\n\nUma pergunta rápida sobre seu pedido ${order}: você pode confirmar seu número de telefone? A transportadora precisa dele para entrar em contato na hora da entrega.\n\nDesde já agradecemos, e qualquer dúvida é só chamar.\n\nAtenciosamente,\nEquipe OstéoPure`,
  }),
  he: (name, order) => ({
    subject: `ההזמנה שלך ${order} — נוכל לקבל אישור למספר הטלפון?`,
    body: `שלום ${name || ""},\n\nשאלה קצרה לגבי ההזמנה ${order}: תוכלו לאשר לנו את מספר הטלפון שלכם? חברת המשלוחים זקוקה לו כדי ליצור איתכם קשר בזמן המסירה.\n\nתודה מראש, ואנחנו כאן לכל שאלה.\n\nבברכה,\nצוות התמיכה`,
    bodyPt: `Olá ${name || ""},\n\nUma pergunta rápida sobre seu pedido ${order}: você pode confirmar seu número de telefone? A transportadora precisa dele para entrar em contato na hora da entrega.\n\nDesde já agradecemos, e qualquer dúvida é só chamar.\n\nAtenciosamente,\nEquipe de suporte`,
  }),
  en: (name, order) => ({
    subject: `Your order ${order} — can you confirm your phone number?`,
    body: `Hi ${name || ""},\n\nQuick question about your order ${order}: could you confirm your phone number for us? The courier needs it to reach you for delivery.\n\nThanks in advance, and let us know if you have any questions.\n\nBest,\nThe OstéoPure team`,
    bodyPt: `Olá ${name || ""},\n\nUma pergunta rápida sobre seu pedido ${order}: você pode confirmar seu número de telefone? A transportadora precisa dele para entrar em contato na hora da entrega.\n\nDesde já agradecemos, e qualquer dúvida é só chamar.\n\nAtenciosamente,\nEquipe OstéoPure`,
  }),
};

export async function draftPhoneRequest(admin: SupabaseClient, storeId: string, orderNumber: string): Promise<{ conversationId: string | null; error?: string }> {
  const order = await orderInStore(admin, storeId, orderNumber);
  if (!order?.email) return { conversationId: null, error: "pedido ou e-mail não encontrado nessa loja" };
  const email = order.email.trim().toLowerCase();
  const lang = COUNTRY_LANG[order.country ?? ""] ?? "en";
  const tpl = (PHONE_REQUEST[lang] ?? PHONE_REQUEST.en)(order.firstName ?? "", order.name);

  const { data: custs } = await admin.from("customers").select("id, store_id").ilike("email", email);
  let customer = (custs ?? []).find((c) => c.store_id === storeId) ?? (custs ?? [])[0] ?? null;
  if (!customer) {
    const { data: created, error } = await admin.from("customers").insert({ store_id: storeId, email, name: order.firstName ?? null }).select("id, store_id").single();
    if (error) return { conversationId: null, error: error.message };
    customer = created;
  }
  const customerIds = [...new Set([...(custs ?? []).map((c) => c.id as string), customer!.id as string])];
  const { data: convs } = await admin
    .from("conversations")
    .select("id")
    .in("customer_id", customerIds)
    .neq("status", "spam")
    .order("last_message_at", { ascending: false })
    .limit(1);
  let conversationId = (convs ?? [])[0]?.id as string | undefined;
  const now = new Date().toISOString();
  if (!conversationId) {
    const { data: created, error } = await admin
      .from("conversations")
      .insert({
        // storeId (não customer!.store_id): o cliente pode já existir em
        // outra loja de uma interação antiga (ex.: Olavita, que não tem
        // caixa de e-mail própria — visto ao vivo, gerava rascunho
        // impossível de enviar). O pedido foi encontrado NESSA loja.
        store_id: storeId,
        customer_id: customer!.id,
        subject: tpl.subject,
        status: "aguardando_humano",
        unread: true,
        urgency: "baixa",
        language: lang,
        last_message_at: now,
        category: "duvidas_gerais",
        anger_level: 1,
        // Toda conversa precisa de "analysis" preenchido — a tela do Inbox
        // quebra sem isso (visto ao vivo: 19 conversas criadas sem esse
        // campo travaram a página de abrir para o Ian).
        analysis: { phase: 1, intent_pt: "Pedido proativo da loja: confirmar telefone de entrega.", tone_pt: "neutro", needs_human: false, human_reason: null, forced_escalation: false, ticket: false, topics: [], todos: [] },
      })
      .select("id")
      .single();
    if (error) return { conversationId: null, error: error.message };
    conversationId = created!.id as string;
  }
  const { error } = await admin
    .from("conversations")
    // shopify_order fica de fora de propósito: a tela do Inbox espera o
    // objeto completo (lineItems, etc.) e quebra com um objeto parcial —
    // visto ao vivo. O número do pedido já está no texto do rascunho.
    .update({ draft_reply: tpl.body, draft_reply_pt: tpl.bodyPt, status: "aguardando_humano", unread: true, language: lang })
    .eq("id", conversationId);
  if (error) return { conversationId: null, error: error.message };
  return { conversationId };
}
