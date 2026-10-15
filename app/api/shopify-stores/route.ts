import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAllShopifyCreds } from "@/lib/agent/analyze";
import { graphql } from "@/lib/shopify/orders";

// Lojas Shopify conectadas, para o filtro "Loja Shopify" do Inbox (onde o
// cliente comprou, que nem sempre é a caixa de e-mail que recebeu). O nome da
// loja vem da própria Shopify (ex.: SkinInsiderDaily) e fica 1h em memória.
let cache: { at: number; shops: Array<{ id: string; domain: string; name: string; respondo: string }> } | null = null;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (cache && Date.now() - cache.at < 3600000) return NextResponse.json({ shops: cache.shops });
  const admin = createAdminClient();
  const creds = await loadAllShopifyCreds(admin, null);
  const shops = await Promise.all(
    creds.map(async (c) => {
      let name = c.shopDomain.replace(".myshopify.com", "");
      try {
        const r = await graphql<{ shop?: { name?: string } }>(c.shopDomain, c.accessToken ?? "", "{ shop { name } }", {});
        if (r.shop?.name) name = r.shop.name;
      } catch {
        // sem nome da Shopify: fica o domínio
      }
      return { id: c.storeId, domain: c.shopDomain.replace(".myshopify.com", ""), name, respondo: c.storeName };
    })
  );
  shops.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), shops };
  return NextResponse.json({ shops });
}
