// Remetentes automáticos: notificações de sistema (Shopify, Stripe, PayPal,
// no-reply, billing...). Não são clientes — nunca entram no Inbox/Tickets/CRM.
export const NOISE_SENDER =
  /shopifyemail\.com|[@.]shopify\.com|no-?reply|noreply|notifications?@|tagadapay|disputifier|mailer-daemon|postmaster|@facebookmail|@google\.com|@stripe\.com|@paypal\.com|@klaviyo|@meta\.com|billing@|invoice@|@vercel\.com|@supabase|@github\.com|@apple\.com|@amazon|@aliexpress|@alibaba|@hostinger|@ovh|@godaddy|@wix|@zendesk|@intercom|@tiktok|@bytedance|failed-payments|@vturb\.|@outbrain\.|@teads\.|@taboola\.|@mgid\.|@parcelpanel\.|@payfresco\.|@cartivo\./i;

// Aviso de "nova compra" que a própria Shopify manda para a caixa da loja
// (ex.: "[SkinMagazin] Commande #1325 placée par ..."). Não é mensagem de
// cliente: confirmação de compra, nunca pendente no Inbox.
export const NOISE_SUBJECT = /^\s*\[[^\]]+\]\s*(commande|order|bestellung|pedido|הזמנה)\s*#?\d+\s+(placée par|placee par|placed by|von|feita por|בוצעה)/i;

// E-mail vindo da própria Shopify (risco, pagamento, conformidade, cobrança,
// contestação...). Regra do Ian (13/10/2026): TUDO que é da Shopify é
// prioridade número 1 no Inbox. Fica de fora só o aviso rotineiro de "nova
// compra" (NOISE_SUBJECT), que não precisa de ninguém.
export const SHOPIFY_SENDER = /[@.]shopify\.com$/i;
// email@email.shopify.com é só marketing da própria Shopify ("alcance milhões
// de clientes", "escolha o design da loja"): não é operacional, segue como spam.
const SHOPIFY_MARKETING = /^email@email\.shopify\.com$/i;
export function isShopifyNotice(fromAddress: string, subject: string): boolean {
  const from = fromAddress.trim();
  return SHOPIFY_SENDER.test(from) && !SHOPIFY_MARKETING.test(from) && !NOISE_SUBJECT.test(subject ?? "");
}
