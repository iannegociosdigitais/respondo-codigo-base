import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

// Dois jeitos de autenticar: token fixo de custom app (shpat_...) ou
// Client ID + Client secret de app do Dev Dashboard, trocados por um token
// de 24h via client credentials grant (renovado sozinho).
export async function exchangeClientCredentials(shopDomain: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Shopify OAuth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Shopify não devolveu access_token (o app está instalado na loja?)");
  return json.access_token;
}

export interface ResolvedShopify {
  shopDomain: string;
  accessToken: string;
}

export async function resolveShopify(admin: SupabaseClient, storeId: string): Promise<ResolvedShopify | null> {
  const { data } = await admin
    .from("store_shopify_credentials")
    .select("shop_domain, client_id, client_secret_encrypted, access_token_encrypted, connected_at")
    .eq("store_id", storeId)
    .maybeSingle();
  if (!data) return null;
  const shopDomain = data.shop_domain as string;

  const fresh = data.connected_at && Date.now() - new Date(data.connected_at as string).getTime() < TOKEN_TTL_MS;
  if (data.access_token_encrypted && (!data.client_id || fresh)) {
    return { shopDomain, accessToken: decrypt(data.access_token_encrypted as string) };
  }
  if (data.client_id && data.client_secret_encrypted) {
    const token = await exchangeClientCredentials(shopDomain, data.client_id as string, decrypt(data.client_secret_encrypted as string));
    await admin
      .from("store_shopify_credentials")
      .update({ access_token_encrypted: encrypt(token), connected_at: new Date().toISOString() })
      .eq("store_id", storeId);
    return { shopDomain, accessToken: token };
  }
  return null;
}
