-- Agendador do Respondo DENTRO do Supabase (pg_cron + pg_net): chama a rota de
-- produção a cada 10 minutos. Não depende do Mac nem do GitHub Actions.
--
-- ANTES DE RODAR: troque COLE_AQUI_O_CRON_SECRET pelo valor de CRON_SECRET
-- (o mesmo que está nas variáveis de ambiente da Vercel).
-- Existe uma cópia já preenchida, só na sua máquina, em:
--   supabase/cron-setup.local.sql   (não vai pro GitHub)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- recria o job se já existir
select cron.unschedule(jobid) from cron.job where jobname = 'respondo-poll-inboxes';

select cron.schedule(
  'respondo-poll-inboxes',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://SEU-APP/api/cron/poll-inboxes',
    headers := jsonb_build_object('Authorization', 'Bearer COLE_AQUI_O_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
  $job$
);

-- limpeza diária do histórico de chamadas (senão a tabela cresce pra sempre)
select cron.unschedule(jobid) from cron.job where jobname = 'respondo-cron-cleanup';
select cron.schedule(
  'respondo-cron-cleanup',
  '17 3 * * *',
  $job$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  delete from net._http_response where created < now() - interval '2 days';
  $job$
);

-- CONFERIR (rode depois de uns 10 minutos):
--   select jobname, schedule, active from cron.job;
--   select status, start_time, return_message from cron.job_run_details order by start_time desc limit 5;
--   select status_code, left(content, 200) as resposta, created from net._http_response order by created desc limit 5;
-- status_code 200 com {"results":[...]} = funcionando.
