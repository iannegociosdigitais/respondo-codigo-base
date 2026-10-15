-- Registro ÚNICO de todo e-mail automático (comprovante de compra e aviso de
-- recebimento) + trava de duplicidade no próprio banco.
--
-- Substitui as tabelas auto_receipts (0014) e auto_ack_log (0016), que nunca
-- chegaram a ser criadas em produção. Pode rodar só esta.
--
-- TRAVA: "dedupe_key" é UNIQUE. Antes de enviar, o sistema grava a linha com
-- a chave ("receipt:<email>" = um comprovante por e-mail, pra sempre;
-- "ack:<email>:<dia>" = um aviso por e-mail por dia). Se a chave já existe, o
-- banco recusa e NADA é enviado — mesmo com dois processos ao mesmo tempo.
-- Se a tabela não existir, o envio também é recusado (falha fechado).
create table if not exists email_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('receipt', 'auto_ack')),
  store_id uuid references stores(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  from_address text,
  to_address text not null,
  customer_name text,
  brand text,
  language text,
  subject text,
  order_id text,
  order_name text,
  message_id text,
  status text not null check (status in ('sending', 'sent', 'failed')),
  error text,
  is_test boolean not null default false,
  trigger text not null default 'manual' check (trigger in ('manual', 'auto', 'test')),
  dedupe_key text unique,
  open_count integer not null default 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists email_log_created_idx on email_log (created_at desc);
create index if not exists email_log_to_idx on email_log (to_address);
create index if not exists email_log_order_idx on email_log (store_id, order_id);

-- Comprovante automático por loja: desligado por padrão. "auto_receipt_since"
-- guarda quando foi ligado — só pedidos feitos DEPOIS disso recebem (ligar
-- não dispara pra pedidos antigos).
alter table stores add column if not exists auto_receipt boolean not null default false;
alter table stores add column if not exists auto_receipt_since timestamptz;

-- Abertura do e-mail (pixel): soma 1 de forma atômica.
create or replace function email_log_opened(log_id uuid) returns void
language sql security definer as $$
  update email_log
     set open_count = open_count + 1,
         first_opened_at = coalesce(first_opened_at, now()),
         last_opened_at = now()
   where id = log_id and status = 'sent';
$$;
