import { createAdminClient } from "@/lib/supabase/admin";
import { SHORT_CODE_RE } from "@/lib/recovery/short-link-host";
import { APP_URL } from "@/lib/forms/token";
import { GET as clickGet } from "@/app/api/public/r/[token]/route";
import { GET as unsubGet, POST as unsubPost } from "@/app/api/public/u/[token]/route";

// Link curto (SHORT_LINK_BASE_URL/<código>, reescrito pelo middleware para
// cá): resolve o código e responde exatamente como /r (clique → checkout) ou
// /u (página de descadastro, que faz POST para a mesma URL curta).

async function resolve(code: string): Promise<{ kind: string; token: string } | null> {
  if (!SHORT_CODE_RE.test(code)) return null;
  const { data } = await createAdminClient().from("short_links").select("kind, token").eq("code", code).maybeSingle();
  return data ? { kind: String(data.kind), token: String(data.token) } : null;
}

const notFound = () => new Response("Link expired.", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const hit = await resolve((await params).code);
  if (!hit) return notFound();
  // Token sem ponto = link do formulário de solicitação (shortenLinks): vai para a página do formulário.
  if (hit.kind === "r" && !hit.token.includes(".")) return Response.redirect(`${APP_URL.replace(/\/+$/, "")}/solicitacao?t=${hit.token}`, 302);
  const p = { params: Promise.resolve({ token: hit.token }) };
  return hit.kind === "u" ? unsubGet(request, p) : clickGet(request, p);
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const hit = await resolve((await params).code);
  if (!hit || hit.kind !== "u") return notFound();
  return unsubPost(request, { params: Promise.resolve({ token: hit.token }) });
}
