-- Intervalo mínimo entre e-mails de marketing: o padrão cai de 16 h para 2 h.
-- Entre passos do MESMO carrinho/pedido o motor usa min(min_gap_hours, delay do
-- passo); entre fluxos ou lojas diferentes vale o intervalo cheio. A 0018 já
-- está aplicada em produção com default 16, então: novo default e ajuste de
-- quem ficou no valor antigo (quem escolheu outro valor à mão não é tocado).
alter table recovery_settings alter column min_gap_hours set default 2;
update recovery_settings set min_gap_hours = 2 where min_gap_hours = 16;
