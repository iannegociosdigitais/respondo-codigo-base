import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import { createClient } from "@/lib/supabase/server";
import { RECOVERY_MISSING_TABLE } from "@/lib/recovery/types";

// Pedaços comuns das rotas do painel de recuperação (app/api/recovery/**):
// autenticação (cron ou usuário logado), leitura do corpo com zod, erro de
// tabela ausente (migration 0018 ainda não rodou) e validações de destino.

// Bearer CRON_SECRET (automação) OU usuário logado (painel). Sem CRON_SECRET
// configurado, só o login vale: nunca aceitar "Bearer undefined".
export async function authorize(request: Request): Promise<NextResponse | null> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (secret && header === `Bearer ${secret}`) return null;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  return null;
}

export const jsonError = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

// Erro do Supabase → resposta. Tabela ausente = 503 com migrationMissing
// (o painel mostra o aviso de "rode a migration 0018").
export function dbError(error: { message: string } | null | undefined, fallbackStatus = 500): NextResponse {
  const message = error?.message ?? "erro desconhecido no banco";
  if (RECOVERY_MISSING_TABLE.test(message)) return NextResponse.json({ error: "Tabelas da recuperação de carrinho ainda não existem (migration 0018).", migrationMissing: true }, { status: 503 });
  return NextResponse.json({ error: message }, { status: fallbackStatus });
}

export const isMissingTable = (error: { message: string } | null | undefined) => Boolean(error && RECOVERY_MISSING_TABLE.test(error.message));

// Corpo JSON validado com zod. Corpo vazio/inválido vira {} antes de validar.
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<{ data: T; response: null } | { data: null; response: NextResponse }> {
  const raw = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { data: null, response: jsonError(`corpo inválido (${where}${issue?.message ?? "formato"})`, 400) };
  }
  return { data: parsed.data, response: null };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (v: string | null | undefined) => Boolean(v && EMAIL_RE.test(v.trim()));
export const isUuid = (v: string | null | undefined) => Boolean(v && UUID_RE.test(v));

// ?days= (janela em dias): ausente = padrão; número fora de 1..180 é ajustado ao
// limite; lixo (NaN, texto) devolve null e a rota responde 400 em vez de estourar
// em new Date(NaN).toISOString() (500).
export function parseDays(raw: string | null | undefined, fallback = 30): number | null {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(180, Math.max(1, Math.floor(n)));
}

// Loja da query string (?store=). Obrigatória nas rotas por loja.
export function storeParam(request: Request): { storeId: string; response: null } | { storeId: null; response: NextResponse } {
  const storeId = new URL(request.url).searchParams.get("store");
  if (!storeId || !isUuid(storeId)) return { storeId: null, response: jsonError("store (uuid) é obrigatório", 400) };
  return { storeId, response: null };
}

export async function loadStore(admin: SupabaseClient, storeId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await admin.from("stores").select("id, name").eq("id", storeId).maybeSingle();
  return data ? { id: String(data.id), name: String(data.name ?? "") } : null;
}

export async function loadStoreNames(admin: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await admin.from("stores").select("id, name");
  return new Map((data ?? []).map((s) => [String(s.id), String(s.name ?? "")]));
}

export const nowIso = () => new Date().toISOString();

// Mensagem de erro de qualquer coisa lançada (Error, string, objeto).
export const errMessage = (err: unknown) => (err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err));

// Status em que o próprio cliente pediu para parar: nada mais sai, nem à mão.
export const STOPPED_BY_CUSTOMER = new Set<string>(["parado_descadastrou", "parado_suprimido"]);

// Telefone em recovery_suppressions (whatsapp ou all)? Erro de banco = true
// (falhar fechado: o painel avisa e o envio humano é recusado).
export async function phoneSuppressed(admin: SupabaseClient, phone: string | null): Promise<boolean> {
  if (!phone) return false;
  const { data, error } = await admin.from("recovery_suppressions").select("id").eq("address", phone).in("channel", ["whatsapp", "all"]).limit(1);
  if (error) return true;
  return (data ?? []).length > 0;
}

// Canal da query string (?channel=email|whatsapp).
export function channelParam(request: Request, required: boolean): { channel: "email" | "whatsapp" | null; response: NextResponse | null } {
  const raw = new URL(request.url).searchParams.get("channel");
  if (!raw) return required ? { channel: null, response: jsonError("channel (email|whatsapp) é obrigatório", 400) } : { channel: null, response: null };
  if (raw !== "email" && raw !== "whatsapp") return { channel: null, response: jsonError("channel deve ser email ou whatsapp", 400) };
  return { channel: raw, response: null };
}
