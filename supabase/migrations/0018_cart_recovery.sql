-- Recuperação de carrinho (fase 1: medir; fase 2: e-mail e WhatsApp).
-- Nada aqui liga envio nenhum: recovery_settings nasce com tudo desligado e
-- em modo de teste (envios só pro dono).
--
-- Uma linha por checkout abandonado da Shopify (cart_recoveries), um histórico
-- de eventos por envio/abertura/clique/resposta (recovery_events, com a MESMA
-- trava de chave única do email_log: grava antes, envia depois), a régua
-- editável por loja e canal (recovery_steps), lista de supressão, cupons,
-- conhecimento do agente vendedor, sessões e mensagens de WhatsApp.

create table if not exists cart_recoveries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  checkout_id text not null,                 -- gid://shopify/AbandonedCheckout/123
  checkout_name text,
  email text,
  phone text,                                -- E.164 (+9725...)
  first_name text,
  last_name text,
  locale text,                               -- he-IL, fr-BE, bg-BG
  language text,                             -- he, fr, bg
  country_code text,
  city text,
  currency text,
  total numeric,
  subtotal numeric,
  total_discount numeric,
  items jsonb not null default '[]'::jsonb,
  discount_codes text[] not null default '{}',
  recovery_url text not null,
  email_consent text,                        -- SUBSCRIBED / NOT_SUBSCRIBED / UNSUBSCRIBED / null
  sms_consent text,
  customer_orders_count integer,
  shopify_customer_id text,
  abandoned_at timestamptz not null,         -- createdAt na Shopify
  shopify_updated_at timestamptz,
  completed_at timestamptz,                  -- a Shopify marca quando vira pedido
  status text not null default 'ativo' check (status in (
    'ativo',                -- na régua / em conversa
    'pausado',              -- pausado à mão
    'recuperado',           -- o MESMO checkout virou pedido
    'parado_comprou',       -- comprou em outro pedido/loja (mesmo e-mail ou telefone)
    'parado_respondeu',     -- respondeu por e-mail (cai no Inbox de suporte): humano assume
    'parado_descadastrou',  -- descadastrou / pediu pra parar
    'parado_suprimido',     -- bounce/reclamação/lista de supressão
    'substituido',          -- a mesma pessoa abandonou um checkout mais novo
    'concluido_sem_compra'  -- régua terminou / janela expirou
  )),
  -- régua: passo e próximo envio por canal (+ resumo genérico pro painel)
  step integer not null default 0,           -- total de toques já feitos (todos os canais)
  next_send_at timestamptz,                  -- o mais cedo entre email_next_at e wa_next_at
  email_step integer not null default 0,
  email_next_at timestamptz,
  wa_step integer not null default 0,
  wa_next_at timestamptz,
  -- conversa de WhatsApp
  agent_mode text not null default 'agente' check (agent_mode in ('agente', 'humano', 'pausado')),
  needs_human boolean not null default false,
  needs_human_reason text,
  waha_session text,                         -- sessão (número) fixa pra esse cliente
  whatsapp_exists boolean,                   -- check-exists do WAHA
  whatsapp_checked_at timestamptz,
  first_contact_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  unread_count integer not null default 0,
  offered_discount_code text,
  offered_discount_percent numeric,
  summary_pt text,                           -- resumo da conversa em PT (lista do painel)
  tags text[] not null default '{}',
  notes text,
  -- recuperação
  recovered_order_id text,
  recovered_order_name text,
  recovered_at timestamptz,
  recovered_amount numeric,
  recovered_currency text,
  recovered_channel text,                    -- email / whatsapp / sms / organico
  recovered_discount_code text,
  attribution text,                          -- checkout / pedido_email / pedido_telefone / cupom
  stop_reason text,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, checkout_id)
);
create index if not exists cart_recoveries_email_idx on cart_recoveries (lower(email));
create index if not exists cart_recoveries_phone_idx on cart_recoveries (phone);
create index if not exists cart_recoveries_status_next_idx on cart_recoveries (status, next_send_at);
create index if not exists cart_recoveries_email_next_idx on cart_recoveries (status, email_next_at);
create index if not exists cart_recoveries_wa_next_idx on cart_recoveries (status, wa_next_at);
create index if not exists cart_recoveries_store_abandoned_idx on cart_recoveries (store_id, abandoned_at desc);
create index if not exists cart_recoveries_inbound_idx on cart_recoveries (last_inbound_at desc);

-- Fluxo pós-compra: um registro por PRIMEIRO pedido pago (nunca renovação).
-- Criado pelo motor a cada minuto; só é processado quando welcome_enabled e
-- o pedido é posterior a welcome_since (ligar não dispara para pedidos antigos).
create table if not exists post_purchase_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  order_id text not null,                    -- gid://shopify/Order/123
  order_name text,
  email text,
  phone text,
  first_name text,
  last_name text,
  language text,
  country_code text,
  currency text,
  total numeric,
  items jsonb not null default '[]'::jsonb,
  purchased_at timestamptz not null,
  fulfilled_at timestamptz,
  tracking_number text,
  tracking_url text,
  tracking_company text,
  financial_status text,
  cancelled_at timestamptz,
  status text not null default 'ativo' check (status in ('ativo', 'pausado', 'concluido', 'parado_cancelado', 'parado_descadastrou', 'parado_suprimido')),
  step integer not null default 0,
  next_at timestamptz,
  receipt_sent boolean not null default false, -- o comprovante automático já saiu (email_log): passo 1 é pulado
  stop_reason text,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, order_id)
);
create index if not exists post_purchase_runs_next_idx on post_purchase_runs (status, next_at);
create index if not exists post_purchase_runs_email_idx on post_purchase_runs (lower(email));
create index if not exists post_purchase_runs_store_idx on post_purchase_runs (store_id, purchased_at desc);

create table if not exists recovery_events (
  id uuid primary key default gen_random_uuid(),
  recovery_id uuid references cart_recoveries(id) on delete cascade,
  run_id uuid references post_purchase_runs(id) on delete cascade,   -- evento do pós-compra
  store_id uuid references stores(id) on delete cascade,
  step integer,
  channel text not null check (channel in ('email', 'whatsapp', 'sms', 'system')),
  type text not null check (type in (
    'queued', 'sent', 'delivered', 'read', 'opened', 'clicked', 'replied',
    'bounced', 'complained', 'failed', 'unsubscribed', 'skipped', 'stopped', 'handoff'
  )),
  -- TRAVA: gravada ANTES de enviar ("recovery:<checkout>:<canal>:<passo>").
  -- Chave repetida = banco recusa = nada sai. Igual ao email_log.
  dedupe_key text unique,
  provider text,                             -- resend / waha / twilio
  message_id text,                           -- id no provedor (casa com webhooks de entrega/leitura)
  discount_code text,
  to_address text,
  language text,
  detail jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  check (recovery_id is not null or run_id is not null)
);
create index if not exists recovery_events_recovery_idx on recovery_events (recovery_id, created_at);
create index if not exists recovery_events_run_idx on recovery_events (run_id, created_at);
create index if not exists recovery_events_message_idx on recovery_events (message_id);
create index if not exists recovery_events_created_idx on recovery_events (created_at desc);

-- Régua editável por loja e canal. position 1 = primeiro toque; delay_minutes
-- conta a partir do abandono (1º) ou do toque anterior (demais).
-- body: WhatsApp = {"he": ["variante 1", "variante 2"], "fr": [...]} (uma
-- variante sorteada por envio, pra não repetir texto); e-mail = {"he": "html
-- ou texto"}. subject só no e-mail. Variáveis: {{nome}} {{produto}} {{itens}}
-- {{valor}} {{link}} {{cupom}} {{desconto}} {{marca}} {{agente}}.
create table if not exists recovery_steps (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  -- carrinho = recuperação de checkout abandonado; pos_compra = boas-vindas
  -- depois do primeiro pedido pago (o comprovante é o passo 1)
  flow text not null default 'carrinho' check (flow in ('carrinho', 'pos_compra')),
  channel text not null check (channel in ('email', 'whatsapp')),
  position integer not null,
  -- pós-compra: 'enviado' só sai quando a Shopify mostra o envio (rastreio);
  -- 'nao_enviado' só enquanto não saiu; 'sempre' não olha o pedido
  send_if text not null default 'sempre' check (send_if in ('sempre', 'enviado', 'nao_enviado')),
  preview jsonb not null default '{}'::jsonb,   -- idioma → texto de prévia (preheader)
  button jsonb not null default '{}'::jsonb,    -- idioma → rótulo do botão
  name text,
  delay_minutes integer not null,
  only_if_no_reply boolean not null default true,
  discount_percent numeric,                  -- null = sem desconto
  subject jsonb not null default '{}'::jsonb,
  body jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, flow, channel, position)
);



-- Quem nunca mais recebe (descadastrou, bounce duro, reclamou de spam, pediu
-- pra parar no WhatsApp, ou você adicionou à mão). store_id null = todas.
create table if not exists recovery_suppressions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references stores(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp', 'sms', 'all')),
  address text not null,                     -- e-mail minúsculo ou telefone E.164
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'replied_stop', 'manual')),
  source text,
  created_at timestamptz not null default now(),
  unique (channel, address)
);

-- Cupons por loja. O app NÃO tem escopo write_discounts: o cupom é criado na
-- Shopify (Descontos) e o código é colado aqui. O passo da régua pede um
-- percentual; o motor acha o cupom ativo da loja com esse percentual.
create table if not exists recovery_discounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  code text not null,
  percent numeric not null,
  combinable boolean not null default false,
  active boolean not null default true,
  shopify_discount_id text,
  note text,
  created_at timestamptz not null default now(),
  unique (store_id, code)
);
create index if not exists recovery_discounts_percent_idx on recovery_discounts (store_id, percent) where active;

-- Conhecimento do agente VENDEDOR (separado do contexto de suporte):
-- script de abordagem, produto, objeções, preços, garantia, regras.
create table if not exists recovery_knowledge (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  kind text not null default 'outro' check (kind in ('script', 'produto', 'objecao', 'preco', 'garantia', 'regra', 'outro')),
  title text not null,
  content text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recovery_knowledge_store_idx on recovery_knowledge (store_id);

-- Configuração por loja. TUDO desligado e em modo de teste por padrão.
create table if not exists recovery_settings (
  store_id uuid primary key references stores(id) on delete cascade,
  enabled boolean not null default false,            -- chave geral da régua
  email_enabled boolean not null default false,
  whatsapp_enabled boolean not null default false,
  sms_enabled boolean not null default false,
  agent_enabled boolean not null default false,      -- agente vendedor responde no WhatsApp
  test_mode boolean not null default true,           -- true = todo envio vai pro dono (test_email / test_phone)
  test_email text not null default 'dono@suaempresa.com',
  test_phone text,
  require_consent boolean not null default false,    -- degraus com desconto só pra quem marcou opt-in
  from_name text,                                    -- "Monique da Olavita"
  from_email text,                                   -- monique@mail.skininsiderdaily.com (Resend)
  reply_to text,                                     -- caixa de suporte (resposta cai no Inbox)
  agent_name text,                                   -- nome da vendedora no WhatsApp (ex.: נועה)
  agent_prompt text,                                 -- instruções extras do Ian pro agente
  agent_max_discount numeric not null default 15,    -- o agente nunca oferece mais que isso sozinho
  daily_cap_email integer not null default 100,
  daily_cap_whatsapp integer not null default 30,
  max_days integer not null default 10,              -- depois disso nada mais sai
  quiet_hours jsonb not null default '{"start": 9, "end": 21, "shabbat": false}'::jsonb, -- shabbat desligado: o Ian liberou sexta e sábado (09/10)
  -- pós-compra (boas-vindas)
  welcome_enabled boolean not null default false,
  welcome_since timestamptz,                         -- só pedidos feitos depois disso entram
  welcome_skip_first_if_receipt boolean not null default true,
  contact_url text,                                  -- link do botão "fale conosco" (sem ele: mailto do reply_to)
  -- e-mail de marketing
  email_provider text not null default 'resend' check (email_provider in ('resend', 'ses')),
  min_gap_hours integer not null default 16,         -- nunca dois e-mails de marketing pra mesma pessoa em menos de N h
  production_since timestamptz,                      -- quando o test_mode foi desligado: base da rampa de aquecimento
  measure_since timestamptz not null default now(),
  last_sync_at timestamptz,
  last_tick_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Sessões do WhatsApp (WAHA). Várias por loja (rotação de números).
create table if not exists whatsapp_sessions (
  name text primary key,                     -- nome da sessão no WAHA (ex.: olavita-1)
  store_id uuid references stores(id) on delete set null,
  label text,
  phone text,
  status text,                               -- STOPPED / SCAN_QR_CODE / WORKING / FAILED...
  me_id text,
  me_name text,
  active boolean not null default true,
  daily_cap integer not null default 30,
  sent_today integer not null default 0,
  sent_today_date date,
  last_used_at timestamptz,
  restricted_until timestamptz,              -- 463/475 do WAHA: espera, não reinicia
  alerted_at timestamptz,                    -- último alerta por e-mail sobre esta sessão
  last_event_at timestamptz,
  detail jsonb,
  updated_at timestamptz not null default now()
);

-- Mensagens de WhatsApp (entrada e saída): o chat ao vivo do painel.
create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  session text not null,
  chat_id text not null,
  phone text,
  direction text not null check (direction in ('inbound', 'outbound')),
  author text not null default 'cliente' check (author in ('cliente', 'agente', 'humano', 'regua')),
  message_id text unique,
  body text,
  body_pt text,                              -- tradução pra você ler
  has_media boolean not null default false,
  media_url text,
  step integer,
  ack integer,                               -- -1 erro, 0 pendente, 1 servidor, 2 entregue, 3 lido
  status text,
  error text,
  is_test boolean not null default false,      -- envio de teste (vai pro test_phone), fora do chat do cliente
  recovery_id uuid references cart_recoveries(id) on delete set null,
  raw jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_messages_chat_idx on whatsapp_messages (session, chat_id, created_at desc);
create index if not exists whatsapp_messages_recovery_idx on whatsapp_messages (recovery_id, created_at);

-- Alertas operacionais (WhatsApp caiu, WAHA fora do ar, muitas falhas de
-- envio). Criados pela vigilância do tick; o painel mostra; e-mail pro dono.
create table if not exists recovery_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sessao', 'waha', 'envio', 'humano', 'outro')),
  key text not null,
  message text not null,
  store_id uuid references stores(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists recovery_alerts_open_idx on recovery_alerts (kind, key) where resolved_at is null;

-- SEGURANÇA: telefones e e-mails de clientes. RLS ligada e SEM política =
-- a chave pública (anon) e usuários logados não leem nada pela API do
-- Supabase; só o servidor do app (service role) acessa.
alter table cart_recoveries enable row level security;
alter table post_purchase_runs enable row level security;
alter table recovery_events enable row level security;
alter table recovery_steps enable row level security;
alter table recovery_suppressions enable row level security;
alter table recovery_discounts enable row level security;
alter table recovery_knowledge enable row level security;
alter table recovery_settings enable row level security;
alter table whatsapp_sessions enable row level security;
alter table whatsapp_messages enable row level security;
alter table recovery_alerts enable row level security;
