import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runStoreAccount } from "@/lib/agent/run-store";
import { archiveStale } from "@/lib/agent/archive-stale";
import { chargebackFollowUps } from "@/lib/agent/chargeback";
import { dedupeConversations, closeCoveredConversations } from "@/lib/agent/dedupe";
import { runAutoReceipts } from "@/lib/receipts/auto";
import { syncAbandonedCheckouts } from "@/lib/recovery/sync";

export const maxDuration = 300;

// Roda a cada 10 minutos via GitHub Actions (Vercel Hobby só permite
// cron 1x/dia). Cada ciclo importa o que há de novo e analisa até N
// conversas pendentes por caixa — o backlog é drenado ao longo dos ciclos.
export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const skipAnalysis = url.searchParams.get("skipAnalysis") === "1";
  const analyzeLimit = Math.min(Number(url.searchParams.get("analyzeLimit") ?? 8), 30);
  const onlyStore = url.searchParams.get("store");
  const deadline = Date.now() + 250_000;

  const admin = createAdminClient();
  let query = admin.from("store_email_accounts").select("*, stores(*)").not("connected_at", "is", null);
  if (onlyStore) query = query.eq("store_id", onlyStore);
  const { data: accounts, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const account of accounts ?? []) {
    const store = account.stores as any;
    results.push(await runStoreAccount(admin, store, account as any, { analyzeLimit, skipAnalysis, deadline }));
  }
  // Inbox só com e-mails de até 20 dias (urgentes ficam).
  const archived = await archiveStale(admin, 20).catch(() => 0);
  // 2º e 3º e-mail da sequência de chargeback (só redige; quem envia é o dono).
  const chargebackDrafts = await chargebackFollowUps(admin, 4).catch(() => 0);
  // Mesmo cliente escreveu quase a mesma mensagem pra duas caixas: fecha a
  // duplicata que ainda não foi respondida, referenciando a conversa principal.
  const deduped = await dedupeConversations(admin).catch(() => 0);
  // Cliente manda o mesmo assunto em e-mails separados (sem responder o
  // anterior); você respondeu só o mais recente e os antigos ficam
  // "pendentes" esquecidos pra sempre. Rede de segurança do checkbox
  // "encerrar as outras pendências" do Inbox (visto ao vivo, 24/09).
  const covered = await closeCoveredConversations(admin).catch(() => 0);
  // Comprovante automático: só em loja com "auto_receipt" ligado em Minhas
  // lojas (desligado por padrão). Um por e-mail de cliente, trava no banco —
  // ver runAutoReceipts. Desligado em 20/09 depois de mandar em dobro; voltou
  // em 01/10 com a trava de chave única gravada ANTES do envio.
  const autoReceipts = onlyStore ? null : await runAutoReceipts(admin, deadline + 20_000).catch((err) => ({ sent: 0, skipped: 0, failed: 0, error: (err as Error).message }));
  // Recuperação de carrinho, fase 1 (só medir): importa os checkouts
  // abandonados da Shopify e marca quem comprou. NÃO envia nada; sem a
  // migration 0018 devolve skipped e segue.
  const cartRecovery = onlyStore ? null : await syncAbandonedCheckouts(admin, { deadline: deadline + 30_000 }).catch((err) => ({ error: (err as Error).message }));
  return NextResponse.json({ results, archived, chargebackDrafts, deduped, covered, autoReceipts, cartRecovery });
}
