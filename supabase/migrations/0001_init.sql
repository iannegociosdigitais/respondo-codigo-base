-- Schema inicial do Atende IA.
-- Rodar via `supabase db push` ou colar no SQL editor do painel Supabase.

create extension if not exists "pgcrypto";

-- Lojas -----------------------------------------------------------------

create table stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agent_name text not null,
  escalation_email text not null,
  tone_of_voice text not null default 'profissional'
    check (tone_of_voice in ('profissional', 'amigavel', 'casual', 'entusiasmado')),
  delivery_time text,
  dispatch_time text,
  warranty_info text,
  description text,
  status text not null default 'onboarding'
    check (status in ('onboarding', 'active', 'paused')),
  created_at timestamptz not null default now()
);

create table store_shopify_credentials (
  store_id uuid primary key references stores(id) on delete cascade,
  shop_domain text not null,
  client_id text not null,
  client_secret_encrypted text not null,
  access_token_encrypted text,
  scopes text[],
  connected_at timestamptz
);

create table store_email_accounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  provider text not null
    check (provider in (
      'gmail', 'outlook', 'zoho', 'titan', 'locaweb', 'hostinger',
      'hostgator', 'godaddy', 'kinghost', 'migadu', 'manual'
    )),
  email_address text not null,
  imap_host text not null,
  imap_port int not null default 993,
  smtp_host text not null,
  smtp_port int not null default 465,
  credential_encrypted text not null,
  auth_type text not null default 'password' check (auth_type in ('password', 'oauth')),
  start_mode text not null default 'all_unread'
    check (start_mode in ('all_unread', 'from_integration_date')),
  connected_at timestamptz,
  last_synced_at timestamptz,
  unique (store_id, email_address)
);

-- Clientes e conversas ----------------------------------------------------

create table customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  email text not null,
  name text,
  shopify_customer_id text,
  created_at timestamptz not null default now(),
  unique (store_id, email)
);

create table tone_profiles (
  store_id uuid primary key references stores(id) on delete cascade,
  style_summary text not null,
  example_snippets jsonb,
  based_on_email_count int not null default 0,
  generated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  subject text,
  category text
    check (category in (
      'duvidas_gerais', 'edicao_pedido', 'rastreio', 'reembolso', 'reclamacao', 'outro'
    )),
  urgency text not null default 'normal'
    check (urgency in ('baixa', 'normal', 'alta', 'urgente')),
  status text not null default 'aberta'
    check (status in ('aberta', 'respondida_ia', 'aguardando_humano', 'resolvida', 'spam')),
  language text,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null
    check (direction in ('inbound', 'outbound_ai', 'outbound_human', 'escalation_internal')),
  from_address text,
  to_address text,
  body text,
  ai_confidence numeric,
  ai_reasoning text,
  created_at timestamptz not null default now()
);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  reason text not null,
  summary text not null,
  sent_to text not null,
  sent_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table usage_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  event_type text not null
    check (event_type in ('email_received', 'email_answered_ai', 'escalated', 'error')),
  created_at timestamptz not null default now()
);

create index on conversations (store_id, status);
create index on messages (conversation_id, created_at);
create index on usage_logs (store_id, event_type, created_at);

-- RLS ---------------------------------------------------------------------
-- Modelo simples para ferramenta de uso interno: qualquer usuário
-- autenticado (você e eventuais colegas) pode ler e escrever em tudo.
-- O pipeline do agente roda com a service role key e ignora RLS.

alter table stores enable row level security;
alter table store_shopify_credentials enable row level security;
alter table store_email_accounts enable row level security;
alter table customers enable row level security;
alter table tone_profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table escalations enable row level security;
alter table usage_logs enable row level security;

create policy "authenticated_full_access" on stores for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on store_shopify_credentials for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on store_email_accounts for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on customers for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on tone_profiles for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on conversations for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on messages for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on escalations for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on usage_logs for all to authenticated using (true) with check (true);
