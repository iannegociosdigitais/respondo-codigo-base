import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Cliente com a service role key — ignora RLS. Uso restrito a código de
// servidor sem sessão de usuário (cron de polling, pipeline do agente,
// webhooks). Nunca importar isso em código que roda no browser.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
