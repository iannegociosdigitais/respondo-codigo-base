import { createAdminClient } from "@/lib/supabase/admin";

// Pixel de abertura dos e-mails automáticos. Público (o cliente de e-mail
// baixa sem login) e sempre devolve a imagem, mesmo se o registro falhar.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    try {
      await createAdminClient().rpc("email_log_opened", { log_id: id });
    } catch {}
  }
  return new Response(GIF, { headers: { "Content-Type": "image/gif", "Content-Length": String(GIF.length), "Cache-Control": "no-store, no-cache, must-revalidate, private", Pragma: "no-cache" } });
}
