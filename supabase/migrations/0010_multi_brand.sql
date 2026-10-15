-- Uma caixa de e-mail pode receber várias marcas (support@osteopure.fr
-- recebe OsteoPure, Olavita, SkinMagazin...). Cada loja declara os
-- endereços/aliases que são dela; a ingestão roteia a conversa pela loja
-- cujo alias aparece no destinatário real do e-mail.
alter table stores
  add column if not exists aliases text[] not null default '{}',
  add column if not exists default_language text;

comment on column stores.aliases is
  'Endereços de destino que pertencem a esta loja (ex: {support@olavita.co.il, olavita@...}). Usado pra rotear e-mails de uma caixa compartilhada.';

-- Destinatários reais da mensagem (antes guardávamos só a conta monitorada).
alter table messages
  add column if not exists to_addresses text[];
