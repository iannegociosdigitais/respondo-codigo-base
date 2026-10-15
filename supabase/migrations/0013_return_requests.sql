-- Formulários de solicitação (devolução / regularização / reenvio) preenchidos
-- pelo cliente numa página pública, com assinatura. É o registro único de
-- todo mundo que pediu o dinheiro de volta.
create table if not exists return_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'rejeitado', 'encerrado')),
  product_name text,
  store_id uuid references stores(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  customer_email text not null,
  customer_name text,
  phone text,
  language text,
  orders jsonb not null default '[]'::jsonb,
  received_at date,
  not_received boolean not null default false,
  address jsonb,
  description text,
  resolution text check (resolution in ('reenvio', 'regularizacao')),
  consents jsonb,
  signature_png text,
  fill_seconds integer,
  ip text,
  user_agent text,
  messages jsonb not null default '[]'::jsonb,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists return_requests_email_idx on return_requests (lower(customer_email));
create index if not exists return_requests_status_idx on return_requests (status, created_at desc);

-- Só o servidor (service role) lê e escreve; a página pública passa pela API.
alter table return_requests enable row level security;
