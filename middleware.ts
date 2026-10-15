import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SHORT_CODE_RE, shortLinkHost } from "@/lib/recovery/short-link-host";

// Protege tudo com login, exceto /login e as rotas de API (que têm sua
// própria autenticação — CRON_SECRET para o cron, tokens da Shopify etc.
// Sem essa exceção, o cron receberia um redirect HTML em vez de rodar.
export async function middleware(request: NextRequest) {
  // Domínio dos links curtos do WhatsApp (SHORT_LINK_BASE_URL): só o código
  // passa (vira /api/public/s/<código>). Qualquer outra coisa nesse domínio
  // vai para a loja: o painel e o login nunca aparecem nele.
  const shortHost = shortLinkHost();
  if (shortHost && (request.headers.get("host") ?? "").toLowerCase() === shortHost) {
    const code = request.nextUrl.pathname.slice(1);
    if (SHORT_CODE_RE.test(code)) return NextResponse.rewrite(new URL(`/api/public/s/${code}`, request.url));
    return NextResponse.redirect(process.env.SHORT_LINK_FALLBACK_URL || "https://SEU-SITE", 302);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/api") ||
    // formulário público de solicitação (o cliente não tem login)
    request.nextUrl.pathname.startsWith("/solicitacao") ||
    // logos das marcas usadas dentro dos e-mails (o cliente de e-mail baixa sem login)
    request.nextUrl.pathname.startsWith("/brand/");

  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  // icon.png/apple-icon.png: favicon gerado pelo Next (app/icon.png) — o
  // navegador pede isso sem estar logado (visto ao vivo: caía no /login e o
  // favicon nunca aparecia).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
