-- A tradução PT-BR (customer_message_pt / draft_reply_pt) já era gerada
-- pelo agente, mas só ia pro e-mail de escalonamento — não ficava
-- guardada pra mostrar na tela de Tickets do painel.
alter table escalations
  add column if not exists customer_message_pt text,
  add column if not exists draft_reply_pt text;
