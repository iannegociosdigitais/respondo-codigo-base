-- Registro de cada envio (ou tentativa) do aviso automático de recebimento,
-- pra dar visibilidade tipo "logs" pro Ian enquanto ele valida a feature
-- antes de ligar de verdade (auto_ack continua desligado por padrão).
create table if not exists auto_ack_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  to_address text not null,
  customer_name text,
  brand text not null,
  language text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists auto_ack_log_store_id_idx on auto_ack_log(store_id, created_at desc);

comment on table auto_ack_log is
  'Uma linha por tentativa de envio do aviso automático de recebimento (lib/agent/auto-ack.ts) — sucesso ou falha, pra o dono acompanhar antes de ativar de vez.';
