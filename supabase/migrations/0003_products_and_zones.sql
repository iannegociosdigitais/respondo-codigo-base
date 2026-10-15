-- Contexto por produto e por país dentro de uma mesma loja. Cobre o caso
-- de uma loja vender vários produtos e/ou embarcar pra vários países,
-- cada combinação com prazo/garantia/observações diferentes.
--
-- Preenchimento por enquanto: direto no Table Editor do Supabase
-- (Table Editor -> store_products / store_shipping_zones -> Insert row).
-- Um formulário no painel entra numa próxima etapa.

create table store_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  shopify_product_id text,
  name text not null,
  description text,
  warranty_info text,
  notes text,
  created_at timestamptz not null default now(),
  unique (store_id, shopify_product_id)
);

create table store_shipping_zones (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  country_code text not null,
  delivery_days_max int,
  default_language text,
  notes text,
  created_at timestamptz not null default now(),
  unique (store_id, country_code)
);

create index on store_products (store_id, shopify_product_id);
create index on store_shipping_zones (store_id, country_code);

alter table store_products enable row level security;
alter table store_shipping_zones enable row level security;
create policy "authenticated_full_access" on store_products for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on store_shipping_zones for all to authenticated using (true) with check (true);
