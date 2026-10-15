import type { SupabaseClient } from "@supabase/supabase-js";
import { hasHebrew, isIsraeliEmail } from "@/lib/ai/lang";

export interface BrandStore {
  id: string;
  name: string;
  aliases: string[];
}

export interface Brands {
  enabled: boolean;
  stores: BrandStore[];
}

// Uma caixa recebe várias marcas. Cada loja declara em `stores.aliases` os
// endereços que são dela (migration 0010). Antes da migration, `enabled`
// fica false e tudo cai na loja dona da caixa — comportamento antigo.
export async function loadBrands(admin: SupabaseClient): Promise<Brands> {
  const { data, error } = await admin.from("stores").select("id, name, aliases");
  if (error) {
    const { data: plain } = await admin.from("stores").select("id, name");
    return { enabled: false, stores: (plain ?? []).map((s) => ({ id: s.id as string, name: s.name as string, aliases: [] })) };
  }
  return {
    enabled: true,
    stores: (data ?? []).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      aliases: ((s.aliases as string[] | null) ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean),
    })),
  };
}

export function olavitaStore(brands: Brands): BrandStore | null {
  return brands.stores.find((s) => /olavita/i.test(s.name)) ?? null;
}

// Loja da conversa: alias no destinatário real > hebraico no texto ou
// domínio israelense do cliente (Olavita) > loja dona da caixa.
export function routeStore(brands: Brands, defaultStoreId: string, recipients: string[], texts: Array<string | null | undefined>, customerEmail?: string | null): string {
  const rec = recipients.map((r) => r.toLowerCase());
  if (brands.enabled) {
    for (const s of brands.stores) {
      if (s.aliases.some((a) => rec.includes(a))) return s.id;
    }
  }
  if (texts.some((t) => hasHebrew(t)) || isIsraeliEmail(customerEmail)) {
    const olavita = olavitaStore(brands);
    if (olavita) return olavita.id;
  }
  return defaultStoreId;
}
