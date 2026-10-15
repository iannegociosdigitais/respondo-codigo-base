-- Links curtos das mensagens de WhatsApp (go.skininsiderdaily.com/<código>).
-- O código aponta para o token assinado de /api/public/r (clique) ou
-- /api/public/u (descadastro); o domínio do painel nunca aparece na mensagem.
create table if not exists public.short_links (
  code text primary key,
  kind text not null default 'r' check (kind in ('r', 'u')),
  token text not null,
  created_at timestamptz not null default now()
);

alter table public.short_links enable row level security;
