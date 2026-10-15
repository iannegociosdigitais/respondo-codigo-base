import { decrypt } from "@/lib/crypto";

// Conferir a versão mais recente em shopify.dev/docs/api/admin-graphql —
// a Shopify libera uma nova versão trimestral. REST está em modo legado
// desde out/2024, por isso usamos GraphQL direto via fetch.
const SHOPIFY_API_VERSION = "2026-07";

export interface ShopifyOrderLineItem {
  productId: string | null;
  title: string;
  quantity: number;
  // total da linha já com desconto, na moeda que o cliente pagou
  lineTotal?: string | null;
  lineCurrency?: string | null;
}

export interface ShopifyShippingAddress {
  name: string | null;
  address1: string | null;
  address2: string | null;
  zip: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
}

export interface ShopifyFulfillment {
  createdAt: string;
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
}

export interface ShopifyOrderSummary {
  id: string;
  name: string;
  email: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  createdAt: string;
  cancelledAt: string | null;
  fulfillmentStatus: string;
  financialStatus: string;
  totalPrice: string | null;
  currency: string | null;
  // O que o CLIENTE viu e pagou no checkout (ex.: 470 DKK, 198 ILS), que pode
  // ser diferente da moeda da loja (EUR).
  presentmentTotal?: string | null;
  presentmentCurrency?: string | null;
  statusPageUrl: string | null;
  countryCode: string | null;
  // idioma em que o cliente viu o checkout (ex.: "he", "fr-CA") — sinal mais
  // preciso que o país pra escolher o idioma do comprovante
  customerLocale?: string | null;
  // cobrança recorrente de assinatura (renovação), nunca a 1ª compra
  isRenewal?: boolean;
  // telefone de entrega (a transportadora de Israel não entrega sem)
  phone?: string | null;
  // contestação bancária em aberto neste pedido (prova de chargeback real,
  // em vez de confiar só no que o cliente escreveu)
  disputeOpen?: boolean;
  // cupons usados no pedido (atribuição da recuperação de carrinho)
  discountCodes?: string[];
  city: string | null;
  fulfilledAt: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  fulfillments: ShopifyFulfillment[];
  lineItems: ShopifyOrderLineItem[];
  shipping?: ShopifyShippingAddress | null;
  shippingTotal?: string | null;
  // Em qual Shopify conectada o pedido foi achado (o mesmo cliente pode
  // comprar em qualquer uma das lojas).
  sourceStoreId?: string;
  sourceShopName?: string;
}

export interface ShopifyCredentials {
  shopDomain: string;
  accessTokenEncrypted?: string;
  accessToken?: string;
}

interface GraphQLOrderNode {
  id: string;
  name: string;
  email: string | null;
  customerLocale?: string | null;
  sourceName?: string | null;
  tags?: string[] | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  createdAt: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  statusPageUrl: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string }; presentmentMoney?: { amount: string; currencyCode: string } | null } | null;
  totalShippingPriceSet?: { presentmentMoney?: { amount: string } | null } | null;
  phone?: string | null;
  shippingAddress: { countryCode: string | null; city: string | null; firstName?: string | null; name?: string | null; address1?: string | null; address2?: string | null; zip?: string | null; province?: string | null; country?: string | null; phone?: string | null } | null;
  lineItems: { edges: Array<{ node: { title: string; quantity: number; product: { id: string } | null; originalTotalSet?: { presentmentMoney?: { amount: string; currencyCode: string } | null } | null; discountAllocations?: Array<{ allocatedAmountSet?: { presentmentMoney?: { amount: string } | null } | null }> | null } }> };
  fulfillments: Array<{
    createdAt: string;
    status: string;
    trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
  }>;
  disputes?: Array<{ status: string }> | null;
  discountCodes?: string[] | null;
}

const ORDER_FIELDS = `
  id
  name
  email
  createdAt
  cancelledAt
  displayFulfillmentStatus
  displayFinancialStatus
  statusPageUrl
  customerLocale
  sourceName
  tags
  customer { firstName lastName }
  totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  totalShippingPriceSet { presentmentMoney { amount } }
  phone
  shippingAddress { countryCode city firstName name address1 address2 zip province country phone }
  lineItems(first: 10) {
    edges { node { title quantity product { id } originalTotalSet { presentmentMoney { amount currencyCode } } discountAllocations { allocatedAmountSet { presentmentMoney { amount } } } } }
  }
  fulfillments {
    createdAt
    status
    trackingInfo { number url company }
  }
  disputes { status }
  discountCodes
`;

export async function graphql<T>(shopDomain: string, accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Shopify ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const json = await response.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

function mapOrder(node: GraphQLOrderNode): ShopifyOrderSummary {
  const fulfillments: ShopifyFulfillment[] = (node.fulfillments ?? []).map((f) => ({
    createdAt: f.createdAt,
    status: f.status,
    trackingNumber: f.trackingInfo?.[0]?.number ?? null,
    trackingUrl: f.trackingInfo?.[0]?.url ?? null,
    trackingCompany: f.trackingInfo?.[0]?.company ?? null,
  }));
  const latest = fulfillments[fulfillments.length - 1];
  return {
    id: node.id,
    name: node.name,
    email: node.email,
    customerFirstName: node.customer?.firstName ?? node.shippingAddress?.firstName ?? null,
    customerLastName: node.customer?.lastName ?? null,
    createdAt: node.createdAt,
    cancelledAt: node.cancelledAt,
    fulfillmentStatus: node.displayFulfillmentStatus,
    financialStatus: node.displayFinancialStatus,
    totalPrice: node.totalPriceSet?.shopMoney.amount ?? null,
    currency: node.totalPriceSet?.shopMoney.currencyCode ?? null,
    presentmentTotal: node.totalPriceSet?.presentmentMoney?.amount ?? null,
    presentmentCurrency: node.totalPriceSet?.presentmentMoney?.currencyCode ?? null,
    statusPageUrl: node.statusPageUrl,
    countryCode: node.shippingAddress?.countryCode ?? null,
    phone: node.shippingAddress?.phone || node.phone || null,
    customerLocale: node.customerLocale ?? null,
    isRenewal: isSubscriptionRenewal(node),
    disputeOpen: (node.disputes ?? []).some((d) => d.status === "NEEDS_RESPONSE" || d.status === "UNDER_REVIEW"),
    discountCodes: node.discountCodes ?? [],
    city: node.shippingAddress?.city ?? null,
    fulfilledAt: latest?.createdAt ?? null,
    trackingNumber: latest?.trackingNumber ?? null,
    trackingUrl: latest?.trackingUrl ?? null,
    trackingCompany: latest?.trackingCompany ?? null,
    fulfillments,
    // product.id vem como "gid://shopify/Product/123" — guardamos só o
    // número, igual ao que aparece na URL do admin e em store_products.
    lineItems: node.lineItems.edges.map(({ node: item }) => ({
      productId: item.product?.id?.split("/").pop() ?? null,
      title: item.title,
      quantity: item.quantity,
      // preço cheio da linha menos TODOS os descontos (de linha e de pedido)
      lineTotal: item.originalTotalSet?.presentmentMoney ? String(Math.max(0, Math.round((Number(item.originalTotalSet.presentmentMoney.amount) - (item.discountAllocations ?? []).reduce((sum, d) => sum + Number(d.allocatedAmountSet?.presentmentMoney?.amount ?? 0), 0)) * 100) / 100)) : null,
      lineCurrency: item.originalTotalSet?.presentmentMoney?.currencyCode ?? null,
    })),
    shipping: node.shippingAddress ? { name: node.shippingAddress.name ?? null, address1: node.shippingAddress.address1 ?? null, address2: node.shippingAddress.address2 ?? null, zip: node.shippingAddress.zip ?? null, city: node.shippingAddress.city ?? null, province: node.shippingAddress.province ?? null, country: node.shippingAddress.country ?? null } : null,
    shippingTotal: node.totalShippingPriceSet?.presentmentMoney?.amount ?? null,
  };
}

export async function verifyShopifyConnection(shopDomain: string, accessToken: string): Promise<{ shopName: string; ordersVisible: number }> {
  const data = await graphql<{ shop: { name: string }; orders: { edges: Array<{ node: { id: string } }> } }>(
    shopDomain,
    accessToken,
    `query { shop { name } orders(first: 5, sortKey: CREATED_AT, reverse: true) { edges { node { id } } } }`,
    {}
  );
  return { shopName: data.shop.name, ordersVisible: data.orders.edges.length };
}

async function searchOrders(creds: ShopifyCredentials, searchQuery: string, limit: number): Promise<ShopifyOrderSummary[]> {
  const accessToken = creds.accessToken ?? decrypt(creds.accessTokenEncrypted ?? "");
  const data = await graphql<{ orders: { edges: Array<{ node: GraphQLOrderNode }> } }>(
    creds.shopDomain,
    accessToken,
    `query Orders($searchQuery: String!, $limit: Int!) {
      orders(first: $limit, query: $searchQuery, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { searchQuery, limit }
  );
  return data.orders.edges.map(({ node }) => mapOrder(node));
}

export function getRecentOrdersByEmail(creds: ShopifyCredentials, customerEmail: string, limit = 5) {
  return searchOrders(creds, `email:${customerEmail}`, limit);
}

// Pedidos pagos criados a partir de `sinceIso`, pra checar quem comprou pela
// primeira vez e mandar o recibo automático (independe da notificação da
// própria Shopify). `created_at:>` é hora UTC.
export function fetchRecentPaidOrders(creds: ShopifyCredentials, sinceIso: string, limit = 100) {
  return searchOrders(creds, `created_at:>'${sinceIso}' AND financial_status:paid`, limit);
}

// Versão enxuta do pedido pago, para a regra de parada por TELEFONE da
// recuperação de carrinho: só o que a regra usa (custo de consulta baixo,
// 250 por página cabem no limite de custo da Shopify).
export interface PaidOrderLite {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  cancelledAt: string | null;
  financialStatus: string;
  phone: string | null;
  countryCode: string | null;
}

// TODOS os pedidos pagos criados depois de `sinceIso`, paginando pelo cursor
// (250 por página, até `maxPages`). `complete = false` quando sobrou página
// (a janela não foi coberta inteira): quem chama deve falhar fechado.
export async function fetchPaidOrdersWindow(creds: ShopifyCredentials, sinceIso: string, opts: { maxPages?: number } = {}): Promise<{ orders: PaidOrderLite[]; complete: boolean }> {
  const accessToken = creds.accessToken ?? decrypt(creds.accessTokenEncrypted ?? "");
  const maxPages = Math.max(1, opts.maxPages ?? 8);
  const orders: PaidOrderLite[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data: {
      orders: {
        edges: Array<{ node: { id: string; name: string; email: string | null; createdAt: string; cancelledAt: string | null; displayFinancialStatus: string; phone: string | null; shippingAddress: { countryCode: string | null; phone: string | null } | null } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await graphql(
      creds.shopDomain,
      accessToken,
      `query PaidWindow($searchQuery: String!, $after: String) {
        orders(first: 250, after: $after, query: $searchQuery, sortKey: CREATED_AT, reverse: true) {
          edges { node { id name email createdAt cancelledAt displayFinancialStatus phone shippingAddress { countryCode phone } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { searchQuery: `created_at:>'${sinceIso}' AND financial_status:paid`, after }
    );
    for (const { node } of data.orders.edges) {
      orders.push({
        id: node.id,
        name: node.name,
        email: node.email,
        createdAt: node.createdAt,
        cancelledAt: node.cancelledAt,
        financialStatus: node.displayFinancialStatus,
        phone: node.shippingAddress?.phone || node.phone || null,
        countryCode: node.shippingAddress?.countryCode ?? null,
      });
    }
    if (!data.orders.pageInfo.hasNextPage) return { orders, complete: true };
    after = data.orders.pageInfo.endCursor;
    if (!after) break;
  }
  return { orders, complete: false };
}

// Renovação de assinatura (Kaching Subscriptions): a Shopify marca com
// sourceName "subscription_contract..." e a etiqueta "... Recurring Order".
// A 1ª compra vem da loja ("web") com a etiqueta "... First Order".
export function isSubscriptionRenewal(order: { sourceName?: string | null; tags?: string[] | null }): boolean {
  if (/^subscription_contract/i.test(order.sourceName ?? "")) return true;
  return (order.tags ?? []).some((t) => /recurring order|renewal|recorrente|r[ée]current/i.test(t));
}

// Pra saber se um pedido é a COMPRA INICIAL do cliente (e não uma cobrança
// recorrente de assinatura): existe algum pedido dele, na mesma loja, mais
// antigo que esse? Conta pedido pago E reembolsado (antes só contava "pago":
// quem teve a 1ª compra reembolsada parecia "1ª compra" de novo na
// renovação). Só ignora tentativa que nunca virou cobrança (anulada/expirada).
export async function isFirstPaidOrder(creds: ShopifyCredentials, customerEmail: string, orderCreatedAt: string): Promise<boolean> {
  const earlier = await searchOrders(creds, `email:${customerEmail} AND created_at:<'${orderCreatedAt}'`, 10);
  return !earlier.some((o) => !/^(VOIDED|EXPIRED)$/i.test(o.financialStatus ?? ""));
}

export function getOrdersByName(creds: ShopifyCredentials, orderNumber: string) {
  return searchOrders(creds, `name:${orderNumber.replace(/^#/, "")}`, 3);
}

// "Já paguei" no WhatsApp: a cliente informa o número do pedido, o e-mail ou o
// nome com que pagou. Só pedido PAGO criado a partir de `sinceIso`. Número e
// e-mail valem direto; nome só vale com UM pedido pago na janela cujo nome do
// cliente contém todas as palavras que ela escreveu (nunca "o primeiro que
// aparece": confirmar o pedido de outra pessoa seria pior que pedir o comprovante).
export async function findPaidOrderByHint(creds: ShopifyCredentials, hint: { orderNumber?: string | null; email?: string | null; name?: string | null }, sinceIso: string): Promise<ShopifyOrderSummary | null> {
  const since = new Date(sinceIso).getTime();
  const paid = (o: ShopifyOrderSummary) => !o.cancelledAt && !/^(VOIDED|EXPIRED|PENDING|REFUNDED|AUTHORIZED)$/i.test(o.financialStatus ?? "") && new Date(o.createdAt).getTime() >= since;
  if (hint.orderNumber) {
    const hit = (await getOrdersByName(creds, hint.orderNumber)).find(paid);
    if (hit) return hit;
  }
  if (hint.email) {
    const hit = (await getRecentOrdersByEmail(creds, hint.email, 5)).find(paid);
    if (hit) return hit;
  }
  if (hint.name) {
    const words = (s: string | null | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
    const want = words(hint.name);
    if (want.length === 0 || want.length > 4) return null;
    const found = await searchOrders(creds, `created_at:>'${sinceIso}' AND financial_status:paid AND ${want.join(" ")}`, 10);
    const matches = found.filter(paid).filter((o) => {
      const have = new Set([...words(o.customerFirstName), ...words(o.customerLastName)]);
      return want.every((w) => have.has(w));
    });
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Clientes da loja com este telefone e os últimos pedidos de cada um (a busca
// de clientes da Shopify aceita "phone:"). Para a regra "nunca chamar quem já
// comprou" (Ian, 10/10): pedido pago em qualquer data, em qualquer loja.
export async function findCustomerOrdersByPhone(creds: ShopifyCredentials, phoneE164: string): Promise<Array<{ name: string; createdAt: string; financialStatus: string }>> {
  const accessToken = creds.accessToken ?? decrypt(creds.accessTokenEncrypted ?? "");
  const data = await graphql<{ customers: { edges: Array<{ node: { orders: { edges: Array<{ node: { name: string; createdAt: string; displayFinancialStatus: string } }> } } }> } }>(
    creds.shopDomain,
    accessToken,
    `query CustomersByPhone($q: String!) {
      customers(first: 5, query: $q) {
        edges { node { orders(first: 5, sortKey: CREATED_AT, reverse: true) { edges { node { name createdAt displayFinancialStatus } } } } }
      }
    }`,
    { q: `phone:${phoneE164}` }
  );
  return data.customers.edges.flatMap((c) => c.node.orders.edges.map((o) => ({ name: o.node.name, createdAt: o.node.createdAt, financialStatus: o.node.displayFinancialStatus })));
}

// Um pedido pelo gid ("gid://shopify/Order/123"), com os mesmos campos da
// busca (ORDER_FIELDS + mapOrder). Usado pelo pós-compra pra reler envio,
// rastreio, status financeiro e cancelamento antes de cada e-mail. Pedido
// apagado/inexistente → null (quem chama decide; nunca inventa estado).
export async function fetchOrderById(creds: ShopifyCredentials, orderId: string): Promise<ShopifyOrderSummary | null> {
  const accessToken = creds.accessToken ?? decrypt(creds.accessTokenEncrypted ?? "");
  const gid = /^gid:\/\//.test(orderId) ? orderId : `gid://shopify/Order/${orderId.replace(/\D/g, "")}`;
  const data = await graphql<{ order: GraphQLOrderNode | null }>(
    creds.shopDomain,
    accessToken,
    `query OrderById($id: ID!) {
      order(id: $id) { ${ORDER_FIELDS} }
    }`,
    { id: gid }
  );
  return data.order ? mapOrder(data.order) : null;
}

// "#1771", "commande 1771", "order n° 1771", "pedido 1771"
export function extractOrderNumbers(text: string): string[] {
  const found = new Set<string>();
  const re = /(?:#|n[°ºo]\.?\s?|commande\s(?:n[°º]\s?)?|order\s(?:number\s|no\.?\s|#)?|pedido\s(?:n[°º]\s?)?|bestellung\s|הזמנה\s)(\d{3,7})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found].slice(0, 3);
}

// Pedido mais relevante pro e-mail: primeiro os citados por número no
// texto, depois os do e-mail do cliente (mais recente primeiro).
// PRIVACIDADE: um número de pedido escrito no e-mail NÃO prova que o pedido é
// de quem escreveu (cliente erra o número e cairia no pedido de outra pessoa).
// Pedido achado por número só vale se o e-mail do pedido for o do cliente;
// senão é descartado e o número volta em `foreignNumbers` pra IA saber que
// não pode falar dele.
export async function findOrdersForEmail(
  creds: ShopifyCredentials,
  customerEmail: string,
  text: string
): Promise<ShopifyOrderSummary[] & { foreignNumbers?: string[] }> {
  const byEmail = await getRecentOrdersByEmail(creds, customerEmail, 5);
  const numbers = extractOrderNumbers(text);
  const byNumber: ShopifyOrderSummary[] = [];
  const foreignNumbers: string[] = [];
  const mine = customerEmail.trim().toLowerCase();
  for (const n of numbers) {
    if (byEmail.some((o) => o.name.replace("#", "") === n)) continue;
    const found = await getOrdersByName(creds, n);
    // Mesmo e-mail, ou mesma parte antes do @ (ex.: momoo0@walla.co.il escreve e
    // o pedido está em momoo0@walla.com): a pessoa tem dois endereços, e o
    // número que ela cita é dela. Domínio diferente com nome diferente continua
    // sendo pedido de terceiro.
    const own = found.filter((o) => {
      const theirs = (o.email ?? "").trim().toLowerCase();
      return theirs === mine || (theirs.includes("@") && mine.includes("@") && theirs.split("@")[0] === mine.split("@")[0] && mine.split("@")[0].length >= 5);
    });
    byNumber.push(...own);
    if (found.length > 0 && own.length === 0) foreignNumbers.push(n);
  }
  const result: ShopifyOrderSummary[] & { foreignNumbers?: string[] } = [...byNumber, ...byEmail];
  result.foreignNumbers = foreignNumbers;
  return result;
}
