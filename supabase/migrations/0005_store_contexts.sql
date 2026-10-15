-- Substitui os campos fixos (tom de voz, garantia, descrição) por um
-- sistema de contexto livre: cada loja define quantos blocos quiser
-- (objeção, produto, tom, política, o que for) em vez de preencher um
-- formulário genérico igual pra todo mundo.
--
-- As colunas antigas em stores continuam existindo (não quebra nada
-- que já rodou), só deixam de ser obrigatórias no cadastro.

create table store_contexts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  label text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index on store_contexts (store_id);

alter table store_contexts enable row level security;
create policy "authenticated_full_access" on store_contexts for all to authenticated using (true) with check (true);

alter table stores
  alter column tone_of_voice drop not null,
  alter column tone_of_voice drop default;
