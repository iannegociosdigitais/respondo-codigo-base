-- Nome do atendente também vira opcional — mesma lógica do contexto
-- livre: não força campo que o usuário não quer preencher agora.
alter table stores
  alter column agent_name drop not null;
