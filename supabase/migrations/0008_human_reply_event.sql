-- Enviar resposta direto do Inbox (humano, não IA) precisa de um
-- event_type próprio em usage_logs pra não misturar com email_answered_ai
-- nas métricas do Painel de Controle.
alter table usage_logs drop constraint usage_logs_event_type_check;

alter table usage_logs add constraint usage_logs_event_type_check
  check (event_type in (
    'email_received', 'email_answered_ai', 'email_answered_human', 'escalated', 'error'
  ));
