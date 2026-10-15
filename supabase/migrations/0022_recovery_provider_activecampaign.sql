-- Recuperação: ActiveCampaign como canal de envio do e-mail de marketing
-- (o Respondo decide tudo; o ActiveCampaign só entrega). Amplia a lista de
-- provedores aceitos em recovery_settings.email_provider.
alter table public.recovery_settings drop constraint if exists recovery_settings_email_provider_check;
alter table public.recovery_settings
  add constraint recovery_settings_email_provider_check
  check (email_provider in ('resend', 'ses', 'activecampaign'));
