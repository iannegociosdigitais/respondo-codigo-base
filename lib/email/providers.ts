export const PROVIDER_PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  gmail: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
  zoho: { imapHost: "imap.zoho.com", imapPort: 993, smtpHost: "smtp.zoho.com", smtpPort: 465 },
  titan: { imapHost: "imap.titan.email", imapPort: 993, smtpHost: "smtp.titan.email", smtpPort: 465 },
  locaweb: { imapHost: "imap.locaweb.com.br", imapPort: 993, smtpHost: "email-ssl.com.br", smtpPort: 465 },
  hostinger: { imapHost: "imap.hostinger.com", imapPort: 993, smtpHost: "smtp.hostinger.com", smtpPort: 465 },
  hostgator: { imapHost: "imap.hostgator.com", imapPort: 993, smtpHost: "smtp.hostgator.com", smtpPort: 465 },
  godaddy: { imapHost: "imap.secureserver.net", imapPort: 993, smtpHost: "smtpout.secureserver.net", smtpPort: 465 },
  kinghost: { imapHost: "imap.kinghost.net", imapPort: 993, smtpHost: "smtp.kinghost.net", smtpPort: 465 },
  migadu: { imapHost: "imap.migadu.com", imapPort: 993, smtpHost: "smtp.migadu.com", smtpPort: 465 },
};

export const PROVIDER_LABELS: Array<[string, string]> = [
  ["gmail", "Gmail / Google Workspace"],
  ["outlook", "Outlook / Microsoft 365"],
  ["zoho", "Zoho"],
  ["titan", "Titan"],
  ["hostinger", "Hostinger"],
  ["locaweb", "Locaweb"],
  ["hostgator", "HostGator"],
  ["godaddy", "GoDaddy"],
  ["kinghost", "KingHost"],
  ["migadu", "Migadu"],
  ["manual", "Outro (manual)"],
];

export function resolveMailServers(body: Record<string, unknown>) {
  const preset = body.provider === "manual" ? null : PROVIDER_PRESETS[String(body.provider)];
  return {
    imapHost: preset?.imapHost ?? String(body.imapHost ?? ""),
    imapPort: preset?.imapPort ?? Number(body.imapPort ?? 993),
    smtpHost: preset?.smtpHost ?? String(body.smtpHost ?? ""),
    smtpPort: preset?.smtpPort ?? Number(body.smtpPort ?? 465),
  };
}
