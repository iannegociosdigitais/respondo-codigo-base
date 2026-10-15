-- Recuperação: idiomas liberados por loja.
-- Uma loja Shopify pode vender em vários mercados (a OsteoPure vende Olavita em
-- Israel, Bulgária, Grécia e Bélgica). send_languages limita quem recebe a
-- régua (carrinho e pós-compra, e-mail e WhatsApp) aos idiomas aprovados.
-- null ou vazio = todos os idiomas que têm texto na régua.
alter table public.recovery_settings
  add column if not exists send_languages text[];

comment on column public.recovery_settings.send_languages is
  'Idiomas (he, bg, fr...) que recebem a régua desta loja. null/vazio = todos.';
