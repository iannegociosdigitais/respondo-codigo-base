import { randomInt } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_URL } from "@/lib/forms/token";
import { shortLinkBase } from "@/lib/recovery/short-link-host";

// Links curtos para o WhatsApp (pedido do Ian, 09/10): a mensagem nunca leva o
// domínio do painel (email-checker...vercel.app/api/public/r/<token enorme>).
// Vai SHORT_LINK_BASE_URL/<código de 7 letras>; o middleware, nesse domínio,
// só aceita o código e reescreve para /api/public/s/<código>, que resolve o
// token e reaproveita as rotas /r (clique) e /u (descadastro).
//
// Env: SHORT_LINK_BASE_URL (ex.: https://go.skininsiderdaily.com).

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 7 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Troca todo link /api/public/(r|u)/<token> do painel por um link curto.
// Sem SHORT_LINK_BASE_URL ou com erro no banco: lança (a mensagem não sai com
// o link longo).
export async function shortenLinks(admin: SupabaseClient, text: string): Promise<string> {
  const appBase = escapeRe(APP_URL.replace(/\/+$/, ""));
  // Links /r e /u (token com ponto) e o link do formulário de solicitação
  // (/solicitacao?t=<token sem ponto>, 13/10: o Ian achou o link feio). O do
  // formulário usa kind 'r' com token SEM ponto; a rota /s o reconhece assim
  // (a tabela só aceita kind r/u, então não precisa de migração).
  const re = new RegExp(`${appBase}/api/public/(r|u)/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)|${appBase}/solicitacao\\?t=([A-Za-z0-9_-]+)`, "g");
  const found = [...text.matchAll(re)];
  if (found.length === 0) return text;
  const base = shortLinkBase();
  if (!base) throw new Error("SHORT_LINK_BASE_URL não configurada: a mensagem não sai com o link do painel.");
  let out = text;
  for (const m of found) {
    const full = m[0];
    const kind = m[1] ?? "r";
    const token = m[2] ?? m[3];
    let code = "";
    for (let attempt = 0; attempt < 4 && !code; attempt++) {
      const c = newCode();
      const { error } = await admin.from("short_links").insert({ code: c, kind, token });
      if (!error) code = c;
      else if (!/duplicate key/i.test(error.message)) throw new Error(`link curto: ${error.message}`);
    }
    if (!code) throw new Error("link curto: não consegui gerar um código único");
    out = out.replace(full, `${base}/${code}`);
  }
  return out;
}
