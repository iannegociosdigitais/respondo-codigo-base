-- Situação real de cada código de rastreio, consultada na API do 17TRACK
-- (a mesma do link que mandamos ao cliente). Registrar um código gasta 1 da
-- cota; consultar depois é grátis. Por isso cada código é registrado UMA vez
-- e a consulta fica guardada aqui, com validade curta.
create table if not exists public.tracking_cache (
  number text primary key,
  carrier integer,
  registered_at timestamptz not null default now(),
  checked_at timestamptz,
  status text,
  sub_status text,
  latest_event_at timestamptz,
  latest_event_text text,
  delivered_at timestamptz,
  pickup_at timestamptz,
  days_of_transit integer,
  days_since_update integer,
  error text
);

alter table public.tracking_cache enable row level security;
