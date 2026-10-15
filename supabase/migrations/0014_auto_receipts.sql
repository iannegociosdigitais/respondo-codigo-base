-- Registro de recibos automáticos (comprovante de compra em HTML, mandado
-- sozinho pelo sistema pra CADA compra inicial, sem depender da notificação
-- da própria Shopify). "order_id" é o id numérico do pedido na Shopify
-- (único por loja), por isso a chave é composta com store_id.
create table if not exists auto_receipts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  order_id text not null,
  order_name text not null,
  customer_email text not null,
  status text not null default 'enviado' check (status in ('enviado', 'erro', 'semeado')),
  error text,
  created_at timestamptz not null default now(),
  unique (store_id, order_id)
);

create index if not exists auto_receipts_email_idx on auto_receipts (customer_email);
