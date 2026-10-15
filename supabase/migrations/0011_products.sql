-- Contexto por PRODUTO/MARCA, não só por loja: a mesma loja Shopify (e a
-- mesma caixa) vende vários produtos (OsteoPure, Olavita...). Cada produto
-- tem seus aliases de e-mail, palavras-chave, idiomas, persona/assinatura
-- por idioma e blocos de contexto próprios.

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  email_aliases text[] not null default '{}',
  keywords text[] not null default '{}',
  languages text[] not null default '{}',
  shopify_product_ids text[] not null default '{}',
  personas jsonb not null default '{}',
  created_at timestamptz not null default now()
);

comment on column products.personas is
  'Por idioma: {"fr":{"name":"Monique","role":"La Responsable du Support OsteoPure","closing":"Chaleureusement"},"he":{...}}';

create index if not exists products_store_idx on products (store_id);

alter table products enable row level security;
create policy "authenticated_full_access" on products for all to authenticated using (true) with check (true);

alter table store_contexts
  add column if not exists product_id uuid references products(id) on delete cascade;
create index if not exists store_contexts_product_idx on store_contexts (product_id);

alter table conversations
  add column if not exists product_id uuid references products(id) on delete set null;
create index if not exists conversations_product_idx on conversations (product_id);

alter table learned_responses
  add column if not exists product_id uuid references products(id) on delete set null;

alter table tone_profiles
  add column if not exists product_id uuid references products(id) on delete cascade;
