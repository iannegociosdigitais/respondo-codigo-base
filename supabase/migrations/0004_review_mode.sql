-- Modo de revisão: enquanto auto_send = false, NENHUMA resposta sai
-- sozinha pro cliente, mesmo quando o agente está confiante — tudo vira
-- e-mail de revisão pro endereço de escalonamento (reaproveita o mesmo
-- fluxo de escalonamento já existente). Serve pra "treinar" olhando os
-- rascunhos antes de ligar o envio automático de verdade.

alter table stores
  add column if not exists auto_send boolean not null default false;

comment on column stores.auto_send is
  'false = todo rascunho vai por e-mail pra revisão, nada é enviado sozinho ao cliente. true = envio automático real.';
