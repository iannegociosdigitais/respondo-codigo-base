// PRODUTO DOS FLUXOS AUTOMÁTICOS (Ian, 13/10): carrinho por e-mail e
// WhatsApp, agente Yael, retomadas, boas-vindas pós-compra e comprovante
// automático são do Olavita Tri-Lift. Produtos novos vão entrar nas mesmas
// lojas de Israel e NÃO podem receber nada do Olavita.
//
// Regra (falha fechado): só entra carrinho/pedido com pelo menos um item do
// Olavita no título. Sem itens = não entra. Brinde ("מתנה סודית נוספת") e
// upsell ("מבצע בזק — צנצנת נוספת") andam junto com o creme e não decidem
// nada sozinhos. Produto novo que precise de fluxo próprio entra aqui de
// propósito, nunca por acaso.
const FLOW_PRODUCT_RE = /olavita|tri[\s-]?lift|טרי[\s-]?ליפט/i;

export const FLOW_PRODUCT_STOP = "produto_fora_do_fluxo";

export function isFlowProduct(items: ReadonlyArray<{ title?: string | null } | null | undefined> | null | undefined): boolean {
  return (items ?? []).some((i) => FLOW_PRODUCT_RE.test(i?.title ?? ""));
}

// Títulos pra registrar no evento/motivo (curto).
export function itemTitles(items: ReadonlyArray<{ title?: string | null } | null | undefined> | null | undefined): string {
  return (items ?? []).map((i) => i?.title ?? "").filter(Boolean).join(" | ").slice(0, 300) || "sem itens";
}
