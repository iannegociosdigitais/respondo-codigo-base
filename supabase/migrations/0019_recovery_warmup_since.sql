-- Início ORIGINAL da rampa de aquecimento do e-mail. production_since passa a
-- reiniciar a cada saída do modo de teste (corte de lançamento: só entra
-- carrinho/pedido depois dele); warmup_since guarda a data em que a loja
-- começou a aquecer e nunca reinicia. O app tolera a coluna ausente (usa
-- production_since) até esta migration rodar.
alter table recovery_settings add column if not exists warmup_since timestamptz;
