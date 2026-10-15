// Provedor de e-mail de MARKETING (recuperação de carrinho e pós-compra),
// escolhido por loja em recovery_settings.email_provider:
//
//   'resend' → lib/email/resend.ts (API HTTPS do Resend)
//   'ses'    → lib/email/ses.ts    (Amazon SES v2)
//   'activecampaign' → lib/email/activecampaign.ts (o ActiveCampaign só
//                entrega; corpo e assunto já vêm prontos do Respondo)
//
// Nunca pela caixa de suporte (Hostinger/Gmail): uma campanha ruim derrubaria
// a entrega dos comprovantes e das respostas. Transacional continua no SMTP.
//
// Falha fechado: provedor sem credencial → lança. O motor registra o evento
// como `skipped: provedor_nao_configurado` e não envia por outro caminho.
import { resendConfigured, sendResendEmail } from "@/lib/email/resend";
import { sendSesEmail, sesConfigured, sesConfigurationSet } from "@/lib/email/ses";
import { activeCampaignConfigured, sendActiveCampaignEmail } from "@/lib/email/activecampaign";

export type MarketingProvider = "resend" | "ses" | "activecampaign";

export const MARKETING_PROVIDERS: readonly MarketingProvider[] = ["resend", "ses", "activecampaign"];

export const MARKETING_PROVIDER_LABELS: Record<MarketingProvider, string> = {
  resend: "Resend",
  ses: "Amazon SES",
  activecampaign: "ActiveCampaign",
};

export interface MarketingEmail {
  // "Monique da Olavita <monique@mail.olavita.co.il>"
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | null;
  // List-Unsubscribe etc. (unsubscribeHeaders de lib/email/resend.ts)
  headers?: Record<string, string>;
  // recovery_id / run_id / step / channel / store_id / flow / test
  tags?: Record<string, string>;
  // Resend: mesma chave em 24 h = não manda duas vezes. O SES não tem
  // equivalente: a trava é o dedupe_key gravado em recovery_events ANTES do
  // envio (o motor já faz isso para os dois provedores).
  idempotencyKey?: string;
  // ActiveCampaign: prévia, link do botão e cupom também vão para campos do
  // contato (o corpo já tem tudo; servem para quem editar o e-mail no painel).
  preheader?: string | null;
  link?: string | null;
  coupon?: string | null;
}

export const isMarketingProvider = (value: unknown): value is MarketingProvider => value === "resend" || value === "ses" || value === "activecampaign";

// Opções de marketingConfigured/sendMarketingEmail. `production: true` (modo
// de teste desligado) endurece o SES: sem SES_CONFIGURATION_SET os eventos de
// bounce e reclamação não chegam ao webhook, a supressão não se alimenta e o
// remetente queima reputação sem a gente saber. Omitido = como antes.
export interface MarketingOpts {
  production?: boolean;
}

// Credenciais do provedor presentes no ambiente? (Não garante que a
// identidade/domínio esteja verificada: isso o painel de entregabilidade
// mostra.)
export function marketingConfigured(provider: MarketingProvider, opts: MarketingOpts = {}): boolean {
  if (provider === "resend") return resendConfigured();
  if (provider === "ses") return sesConfigured() && (!opts.production || Boolean(sesConfigurationSet()));
  if (provider === "activecampaign") return activeCampaignConfigured();
  return false;
}

export async function sendMarketingEmail(provider: MarketingProvider, input: MarketingEmail, opts: MarketingOpts = {}): Promise<{ id: string; provider: MarketingProvider }> {
  if (!isMarketingProvider(provider)) throw new Error(`Provedor de e-mail desconhecido: '${String(provider)}'.`);
  if (!marketingConfigured(provider, opts)) {
    throw new Error(
      provider === "activecampaign"
        ? "ActiveCampaign não configurado (ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY): e-mail de marketing não enviado."
        : provider === "resend"
        ? "Resend não configurado (RESEND_API_KEY): e-mail de marketing não enviado."
        : sesConfigured()
          ? "Amazon SES sem SES_CONFIGURATION_SET: em produção o envio é recusado (bounce e reclamação não chegariam ao webhook). E-mail de marketing não enviado."
          : "Amazon SES não configurado (AWS_SES_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY): e-mail de marketing não enviado.",
    );
  }
  if (!input.to || !input.from) throw new Error("E-mail de marketing sem remetente ou destinatário: não enviado.");

  if (provider === "activecampaign") {
    const r = await sendActiveCampaignEmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      preheader: input.preheader,
      link: input.link,
      coupon: input.coupon,
      ref: input.idempotencyKey ?? "",
    });
    return { id: r.id, provider };
  }

  if (provider === "resend") {
    const r = await sendResendEmail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
      headers: input.headers,
      tags: input.tags,
      idempotencyKey: input.idempotencyKey,
    });
    return { id: r.id, provider };
  }

  const r = await sendSesEmail({
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    headers: input.headers,
    tags: input.tags,
  });
  return { id: r.id, provider };
}
