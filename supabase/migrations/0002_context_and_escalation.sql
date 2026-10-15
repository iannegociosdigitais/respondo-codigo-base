-- Extensão do schema: prazo de entrega configurável, sinalizadores de
-- risco por conversa, e base de respostas ensinadas pelo humano depois
-- de um escalonamento.

alter table stores
  add column if not exists delivery_days_max int;

comment on column stores.delivery_days_max is
  'Prazo máximo de entrega em dias corridos a partir da compra, usado para calcular atraso. Ex: 12.';

alter table conversations
  add column if not exists anger_level smallint check (anger_level between 1 and 5),
  add column if not exists mentions_threat boolean not null default false,
  add column if not exists wants_refund boolean not null default false;

-- Respostas ensinadas: quando você resolve um escalonamento e explica como
-- deveria ter sido respondido, isso vira contexto reutilizável para casos
-- parecidos no futuro (ver lib/ai/context.ts -> getRelevantPlaybookRules).
create table learned_responses (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  category text
    check (category in (
      'duvidas_gerais', 'edicao_pedido', 'rastreio', 'reembolso', 'reclamacao', 'outro'
    )),
  situation_summary text not null,
  guidance text not null,
  source_escalation_id uuid references escalations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index on learned_responses (store_id, category);

alter table learned_responses enable row level security;
create policy "authenticated_full_access" on learned_responses for all to authenticated using (true) with check (true);
