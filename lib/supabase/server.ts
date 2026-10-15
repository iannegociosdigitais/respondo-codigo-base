import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Cliente autenticado para uso em Server Components / Route Handlers,
// respeitando o login do usuário e as políticas de RLS.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // set() chamado a partir de um Server Component — ignorável
            // quando há middleware cuidando do refresh da sessão.
          }
        },
      },
    }
  );
}
