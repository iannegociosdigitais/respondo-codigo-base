import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { resolveMailServers } from "@/lib/email/providers";

// Nova loja em um passo: nome + caixa de e-mail. Contexto, Shopify e tom
// vêm depois, nas telas próprias.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const name = String(body.storeName ?? "").trim();
  const shared = body.sharedMailbox === true || body.sharedMailbox === "on";
  const aliases = String(body.aliases ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  // Marca que recebe e-mail na caixa de outra loja: só a loja + aliases
  // (roteamento acontece na ingestão; precisa da migration 0010).
  if (shared) {
    if (!name || aliases.length === 0) return NextResponse.json({ error: "nome da loja e pelo menos um endereço da marca são obrigatórios" }, { status: 400 });
    const admin = createAdminClient();
    const { data: store, error } = await admin
      .from("stores")
      .insert({ name, agent_name: body.agentName ? String(body.agentName).trim() : null, escalation_email: aliases[0], delivery_days_max: body.deliveryDaysMax ? Number(body.deliveryDaysMax) : null, status: "active", aliases })
      .select("id")
      .single();
    if (error) {
      const msg = /aliases/.test(error.message) ? "Rode a migration 0010 (stores.aliases) antes de criar marca com caixa compartilhada." : error.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    return NextResponse.json({ storeId: store.id });
  }

  const emailAddress = String(body.emailAddress ?? "").trim().toLowerCase();
  const password = String(body.emailPassword ?? "");
  if (!name || !emailAddress || !password) {
    return NextResponse.json({ error: "nome da loja, e-mail e senha são obrigatórios" }, { status: 400 });
  }
  const servers = resolveMailServers(body);
  if (!servers.imapHost || !servers.smtpHost) {
    return NextResponse.json({ error: "host IMAP/SMTP incompletos" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: store, error: storeError } = await admin
    .from("stores")
    .insert({
      name,
      agent_name: body.agentName ? String(body.agentName).trim() : null,
      escalation_email: emailAddress,
      delivery_days_max: body.deliveryDaysMax ? Number(body.deliveryDaysMax) : null,
      status: "active",
    })
    .select("id")
    .single();
  if (storeError || !store) return NextResponse.json({ error: storeError?.message ?? "erro ao criar loja" }, { status: 500 });

  const { error: accountError } = await admin.from("store_email_accounts").insert({
    store_id: store.id,
    provider: body.provider ?? "manual",
    email_address: emailAddress,
    imap_host: servers.imapHost,
    imap_port: servers.imapPort,
    smtp_host: servers.smtpHost,
    smtp_port: servers.smtpPort,
    credential_encrypted: encrypt(password),
    connected_at: new Date().toISOString(),
  });
  if (accountError) {
    await admin.from("stores").delete().eq("id", store.id);
    return NextResponse.json({ error: accountError.message }, { status: 500 });
  }

  return NextResponse.json({ storeId: store.id });
}
