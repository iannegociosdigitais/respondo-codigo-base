import type { SupabaseClient } from "@supabase/supabase-js";
import { syncEmailAccount, type EmailAccountRow } from "@/lib/agent/sync-account";
import { analyzePendingConversations, type StoreRow } from "@/lib/agent/analyze";
import { ensureToneProfile } from "@/lib/ai/tone";
import { loadBrands } from "@/lib/agent/brands";

export interface RunResult {
  store: string;
  account: string;
  inbound: number;
  sent: number;
  remaining: number;
  analyzed: number;
  autoSent: number;
  errors: number;
  tone?: string;
  error?: string;
}

// Um ciclo completo pra uma caixa: importa o que há de novo, atualiza o
// perfil de tom se estiver velho, e analisa as conversas pendentes.
export async function runStoreAccount(
  admin: SupabaseClient,
  store: StoreRow,
  account: EmailAccountRow,
  opts: { analyzeLimit: number; skipAnalysis?: boolean; deadline?: number }
): Promise<RunResult> {
  const result: RunResult = {
    store: store.name,
    account: account.email_address,
    inbound: 0,
    sent: 0,
    remaining: 0,
    analyzed: 0,
    autoSent: 0,
    errors: 0,
  };

  try {
    const brands = await loadBrands(admin);
    const autoAckConfig = { enabled: Boolean(store.auto_ack), defaultLanguage: store.default_language ?? null, fallbackBrand: store.name };
    const sync = await syncEmailAccount(admin, account, store.id, [(store as { escalation_email?: string }).escalation_email ?? ""], brands, autoAckConfig);
    result.inbound = sync.inbound;
    result.sent = sync.sent;
    result.remaining = sync.remaining;
  } catch (err) {
    result.error = `sync: ${(err as Error).message}`;
    await admin.from("store_email_accounts").update({ last_error: result.error }).eq("id", account.id);
    return result;
  }

  try {
    const tone = await ensureToneProfile(admin, store.id);
    result.tone = `${tone.status} (${tone.basedOn})`;
  } catch (err) {
    result.tone = `erro: ${(err as Error).message}`;
  }

  if (!opts.skipAnalysis) {
    const a = await analyzePendingConversations(admin, store, account, opts.analyzeLimit, opts.deadline);
    result.analyzed = a.analyzed;
    result.autoSent = a.autoSent;
    result.errors = a.errors;
  }

  return result;
}

export async function requireUser(supabase: { auth: { getUser: () => Promise<{ data: { user: unknown } }> } }) {
  const { data } = await supabase.auth.getUser();
  return data.user;
}
