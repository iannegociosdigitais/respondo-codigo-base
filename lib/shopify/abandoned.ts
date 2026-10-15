import { graphql } from "@/lib/shopify/orders";

// Checkouts abandonados da Shopify (Admin GraphQL). Testado ao vivo em
// 08/10/2026: funciona com o escopo read_orders que o app já tem. Campos
// confirmados: URL de recuperação (já vem com ?key=...&locale=he-IL, então
// o cupom entra como &discount=CODIGO), cupom do funil já aplicado, telefone
// do endereço, consentimento de marketing e imagem do item.
//
// Não existe sortKey UPDATED_AT: ordena por CREATED_AT e filtra por
// "updated_at:>=" na query.

export interface AbandonedLineItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  sku: string | null;
  productId: string | null;
  variantId: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  imageUrl: string | null;
}

export interface AbandonedCheckoutSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recoveryUrl: string;
  discountCodes: string[];
  total: string | null;
  subtotal: string | null;
  totalDiscount: string | null;
  currency: string | null;
  customer: {
    id: string | null;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    locale: string | null;
    ordersCount: number | null;
    emailConsent: string | null;
    smsConsent: string | null;
  } | null;
  shippingPhone: string | null;
  billingPhone: string | null;
  countryCode: string | null;
  city: string | null;
  lineItems: AbandonedLineItem[];
}

interface Money { amount: string; currencyCode?: string }
interface Node {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  abandonedCheckoutUrl: string;
  discountCodes: string[];
  totalPriceSet: { presentmentMoney: Money | null } | null;
  subtotalPriceSet: { presentmentMoney: Money | null } | null;
  totalDiscountSet: { presentmentMoney: Money | null } | null;
  customer: {
    id: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    locale: string | null;
    numberOfOrders: string | null;
    emailMarketingConsent: { marketingState: string } | null;
    smsMarketingConsent: { marketingState: string } | null;
  } | null;
  shippingAddress: { phone: string | null; countryCode: string | null; city: string | null } | null;
  billingAddress: { phone: string | null; countryCode: string | null } | null;
  lineItems: { nodes: Array<{
    title: string;
    quantity: number;
    variantTitle: string | null;
    sku: string | null;
    product: { id: string } | null;
    variant: { id: string } | null;
    originalUnitPriceSet: { presentmentMoney: Money | null } | null;
    discountedTotalPriceSet: { presentmentMoney: Money | null } | null;
    image: { url: string } | null;
  }> };
}

const FIELDS = `
  id name createdAt updatedAt completedAt abandonedCheckoutUrl discountCodes
  totalPriceSet { presentmentMoney { amount currencyCode } }
  subtotalPriceSet { presentmentMoney { amount currencyCode } }
  totalDiscountSet { presentmentMoney { amount } }
  customer { id email phone firstName lastName locale numberOfOrders emailMarketingConsent { marketingState } smsMarketingConsent { marketingState } }
  shippingAddress { phone countryCode city }
  billingAddress { phone countryCode }
  lineItems(first: 20) { nodes { title quantity variantTitle sku product { id } variant { id } originalUnitPriceSet { presentmentMoney { amount } } discountedTotalPriceSet { presentmentMoney { amount } } image { url } } }
`;

const gidNumber = (gid: string | null | undefined) => gid?.split("/").pop() ?? null;

function map(node: Node): AbandonedCheckoutSummary {
  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    completedAt: node.completedAt,
    recoveryUrl: node.abandonedCheckoutUrl,
    discountCodes: node.discountCodes ?? [],
    total: node.totalPriceSet?.presentmentMoney?.amount ?? null,
    subtotal: node.subtotalPriceSet?.presentmentMoney?.amount ?? null,
    totalDiscount: node.totalDiscountSet?.presentmentMoney?.amount ?? null,
    currency: node.totalPriceSet?.presentmentMoney?.currencyCode ?? null,
    customer: node.customer
      ? {
          id: node.customer.id,
          email: node.customer.email,
          phone: node.customer.phone,
          firstName: node.customer.firstName,
          lastName: node.customer.lastName,
          locale: node.customer.locale,
          ordersCount: node.customer.numberOfOrders != null ? Number(node.customer.numberOfOrders) : null,
          emailConsent: node.customer.emailMarketingConsent?.marketingState ?? null,
          smsConsent: node.customer.smsMarketingConsent?.marketingState ?? null,
        }
      : null,
    shippingPhone: node.shippingAddress?.phone ?? null,
    billingPhone: node.billingAddress?.phone ?? null,
    countryCode: node.shippingAddress?.countryCode ?? node.billingAddress?.countryCode ?? null,
    city: node.shippingAddress?.city ?? null,
    lineItems: (node.lineItems?.nodes ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      variantTitle: li.variantTitle,
      sku: li.sku,
      productId: gidNumber(li.product?.id),
      variantId: gidNumber(li.variant?.id),
      unitPrice: li.originalUnitPriceSet?.presentmentMoney?.amount ?? null,
      lineTotal: li.discountedTotalPriceSet?.presentmentMoney?.amount ?? null,
      imageUrl: li.image?.url ?? null,
    })),
  };
}

export interface ShopifyAuth { shopDomain: string; accessToken: string }

// Todos os checkouts atualizados desde `updatedSince` (ISO), paginando de 50
// em 50 até `max`. Inclui os que viraram pedido (completedAt preenchido):
// é assim que a parada "comprou" é detectada.
export async function fetchAbandonedCheckouts(auth: ShopifyAuth, opts: { updatedSince: string; max?: number }): Promise<AbandonedCheckoutSummary[]> {
  const out: AbandonedCheckoutSummary[] = [];
  const max = opts.max ?? 1000;
  let after: string | null = null;
  const query = `updated_at:>='${opts.updatedSince}'`;
  for (let page = 0; page < 40 && out.length < max; page++) {
    const data: { abandonedCheckouts: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } = await graphql(
      auth.shopDomain,
      auth.accessToken,
      `query($q: String, $after: String) { abandonedCheckouts(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`,
      { q: query, after }
    );
    out.push(...data.abandonedCheckouts.nodes.map(map));
    if (!data.abandonedCheckouts.pageInfo.hasNextPage) break;
    after = data.abandonedCheckouts.pageInfo.endCursor;
  }
  return out.slice(0, max);
}

// Releitura de UM checkout na hora do envio (regra de parada nº 1: nunca
// confiar no cache pra decidir se a pessoa já comprou).
export async function fetchAbandonedCheckoutState(auth: ShopifyAuth, checkoutId: string): Promise<{ completedAt: string | null; updatedAt: string } | null> {
  const data: { node: { completedAt: string | null; updatedAt: string } | null } = await graphql(
    auth.shopDomain,
    auth.accessToken,
    `query($id: ID!) { node(id: $id) { ... on AbandonedCheckout { completedAt updatedAt } } }`,
    { id: checkoutId }
  );
  return data.node ?? null;
}

export async function countAbandonedCheckouts(auth: ShopifyAuth, query: string): Promise<number> {
  const data: { c: { count: number } | null } = await graphql(auth.shopDomain, auth.accessToken, `query($q: String) { c: abandonedCheckoutsCount(query: $q) { count } }`, { q: query });
  return data.c?.count ?? 0;
}
