-- Aviso automático "recebemos sua mensagem" pro primeiro e-mail de um
-- cliente novo — sai na hora, antes da IA analisar/redigir, só pra ele
-- saber que não vai ficar sem resposta. Texto fixo e genérico (não é o
-- rascunho de verdade), só nas caixas onde o dono ligar.
--
-- false por padrão de propósito (pedido do Ian, 28/09/2026): construir e
-- deixar desligado até ele validar o texto/comportamento antes de ativar.

alter table stores
  add column if not exists auto_ack boolean not null default false;

comment on column stores.auto_ack is
  'true = manda um aviso automático genérico ("recebemos sua mensagem") na primeira mensagem de cada conversa nova de cliente real, antes da análise da IA. false = desligado (padrão).';
