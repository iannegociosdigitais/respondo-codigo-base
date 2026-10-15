import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { resolveMailServers } from "@/lib/email/providers";

// Conecta uma caixa de e-mail numa loja já existente. Fica separado do
// onboarding por conversa de propósito — senha é sempre um campo de
// formulário dedicado, nunca texto solto mandado pro GPT.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();

  const { imapHost, imapPort, smtpHost, smtpPort } = resolveMailServers(body);

  if (!imapHost || !smtpHost || !imapPort || !smtpPort) {
    return NextResponse.json({ error: "host/porta de e-mail incompletos" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("store_email_accounts").insert({
    store_id: id,
    provider: body.provider,
    email_address: body.emailAddress,
    imap_host: imapHost,
    imap_port: imapPort,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    credential_encrypted: encrypt(body.emailPassword),
    start_mode: body.startMode ?? "all_unread",
    connected_at: new Date().toISOString(),
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
