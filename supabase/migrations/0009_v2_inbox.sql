-- v2: ingestão por UID (sem marcar como lido), threading real por
-- Message-ID, leitura da pasta Enviados, pré-análise guardada na própria
-- conversa, envio automático por categoria e aprendizado a partir das
-- edições feitas no Inbox.

-- Caixa de e-mail: ponteiros de ingestão -----------------------------------
alter table store_email_accounts
  add column if not exists last_uid bigint not null default 0,
  add column if not exists sent_folder text,
  add column if not exists sent_last_uid bigint not null default 0,
  add column if not exists last_error text;

-- Mensagens: cabeçalhos reais pra threading e tradução em cache ------------
alter table messages
  add column if not exists message_id text,
  add column if not exists in_reply_to text,
  add column if not exists references_ids text[],
  add column if not exists subject text,
  add column if not exists body_pt text,
  add column if not exists body_raw text,
  add column if not exists sent_at timestamptz,
  add column if not exists imap_uid bigint;

create unique index if not exists messages_message_id_uidx
  on messages (message_id) where message_id is not null;
create index if not exists messages_in_reply_to_idx on messages (in_reply_to);

-- Conversas: estados novos + pré-análise + rascunho ------------------------
alter table conversations drop constraint if exists conversations_status_check;
update conversations set status = 'nova' where status = 'aberta';
update conversations set status = 'encerrada' where status = 'resolvida';
alter table conversations add constraint conversations_status_check
  check (status in (
    'nova', 'respondida_ia', 'aguardando_humano', 'respondida_humano',
    'reaberta', 'encerrada', 'spam'
  ));

alter table conversations drop constraint if exists conversations_category_check;
alter table conversations add constraint conversations_category_check
  check (category in (
    'duvidas_gerais', 'edicao_pedido', 'rastreio', 'reembolso', 'reclamacao',
    'spam', 'outro'
  ));

alter table conversations
  add column if not exists analysis jsonb,
  add column if not exists draft_reply text,
  add column if not exists draft_reply_pt text,
  add column if not exists shopify_order jsonb,
  add column if not exists unread boolean not null default true,
  add column if not exists thread_key text,
  add column if not exists analyzed_at timestamptz,
  add column if not exists closed_at timestamptz;

create index if not exists conversations_store_last_message_idx
  on conversations (store_id, last_message_at desc);
create index if not exists conversations_customer_idx on conversations (customer_id);
create index if not exists conversations_thread_key_idx on conversations (store_id, thread_key);

-- Loja: envio automático por categoria, assinatura -------------------------
alter table stores
  add column if not exists auto_send_categories text[] not null default '{}',
  add column if not exists signature text;

-- Shopify via custom app (token de Admin API): não tem client_id/secret ---
alter table store_shopify_credentials
  alter column client_id drop not null,
  alter column client_secret_encrypted drop not null;

-- Aprendizado: de onde veio cada regra ------------------------------------
alter table learned_responses
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'edicao', 'chat')),
  add column if not exists source_conversation_id uuid
    references conversations(id) on delete set null;

-- Métricas ----------------------------------------------------------------
alter table usage_logs drop constraint if exists usage_logs_event_type_check;
alter table usage_logs add constraint usage_logs_event_type_check
  check (event_type in (
    'email_received', 'email_answered_ai', 'email_answered_human',
    'escalated', 'reopened', 'error'
  ));

-- Cache de tradução e pedidos por cliente ----------------------------------
alter table customers
  add column if not exists shopify_orders jsonb,
  add column if not exists shopify_synced_at timestamptz;
