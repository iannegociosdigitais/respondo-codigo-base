// ActiveCampaign como CANAL DE ENVIO do e-mail de marketing (recuperação de
// carrinho e pós-compra). Toda a inteligência continua no Respondo (quando
// mandar, para quem, qual cupom, parar quando compra, idioma, ritmo); o
// ActiveCampaign só entrega, com a reputação e o domínio autenticado dele.
//
// Como funciona (a API v3 do ActiveCampaign não manda e-mail avulso):
//  1. contact/sync grava no contato os campos já renderizados pelo Respondo:
//     RC_SUBJECT, RC_PREHEADER, RC_HTML (corpo pronto), RC_LINK, RC_COUPON e
//     RC_REF (chave do envio, para casar o webhook);
//  2. o contato entra na lista (sem nunca reinscrever quem se descadastrou);
//  3. a tag "respondo-envio" é removida (se sobrou) e adicionada de novo.
//     A automação única do ActiveCampaign ("Tag adicionada: respondo-envio"
//     → "Enviar e-mail Respondo" → "Remover tag") manda o e-mail cujo
//     assunto é %RC_SUBJECT% e cujo corpo é %RC_HTML% + rodapé com
//     %UNSUBSCRIBELINK%. Cabe no plano Starter (3 ações).
//
// Env: ACTIVECAMPAIGN_API_URL (https://<conta>.api-us1.com),
//      ACTIVECAMPAIGN_API_KEY, opcionais ACTIVECAMPAIGN_LIST_ID (padrão 1) e
//      ACTIVECAMPAIGN_SEND_TAG (padrão respondo-envio).
// Eventos de volta: app/api/webhooks/activecampaign (descadastro, bounce,
// abertura, clique, resposta, envio).
import { SendError, networkErrorAmbiguous } from "@/lib/email/send-error";

export const activeCampaignConfigured = () => Boolean(process.env.ACTIVECAMPAIGN_API_URL && process.env.ACTIVECAMPAIGN_API_KEY);

const base = () => `${(process.env.ACTIVECAMPAIGN_API_URL ?? "").replace(/\/+$/, "")}/api/3`;
const listId = () => process.env.ACTIVECAMPAIGN_LIST_ID?.trim() || "3"; // "Master Contact List" (id padrão de conta nova)
const sendTag = () => process.env.ACTIVECAMPAIGN_SEND_TAG?.trim() || "respondo-envio";

export const AC_FIELDS = ["RC_SUBJECT", "RC_PREHEADER", "RC_HTML", "RC_LINK", "RC_COUPON", "RC_REF"] as const;
type AcField = (typeof AC_FIELDS)[number];

class AcHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function ac<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { "Api-Token": process.env.ACTIVECAMPAIGN_API_KEY ?? "", "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new AcHttpError(`ActiveCampaign ${method} ${path} ${res.status}: ${text.slice(0, 300)}`, res.status);
  return (text ? JSON.parse(text) : {}) as T;
}

// Ids dos campos e da tag (uma busca por instância; mudam só se alguém apagar no painel).
let fieldCache: { at: number; ids: Map<string, string> } | null = null;
async function fieldIds(): Promise<Map<string, string>> {
  if (fieldCache && Date.now() - fieldCache.at < 3600_000) return fieldCache.ids;
  const r = await ac<{ fields?: Array<{ id: string; perstag: string }> }>("GET", "/fields?limit=100");
  const ids = new Map((r.fields ?? []).map((f) => [String(f.perstag).toUpperCase(), String(f.id)]));
  const missing = AC_FIELDS.filter((f) => !ids.has(f));
  if (missing.length > 0) throw new Error(`ActiveCampaign sem os campos ${missing.join(", ")} (criar com o script de configuração).`);
  fieldCache = { at: Date.now(), ids };
  return ids;
}
let tagCache: { at: number; id: string } | null = null;
async function sendTagId(): Promise<string> {
  if (tagCache && Date.now() - tagCache.at < 3600_000) return tagCache.id;
  const name = sendTag();
  const r = await ac<{ tags?: Array<{ id: string; tag: string }> }>("GET", `/tags?search=${encodeURIComponent(name)}`);
  const hit = (r.tags ?? []).find((t) => t.tag === name);
  if (!hit) throw new Error(`ActiveCampaign sem a tag "${name}".`);
  tagCache = { at: Date.now(), id: String(hit.id) };
  return tagCache.id;
}

// O corpo que vai no campo RC_HTML: só o miolo do <body>, sem o rodapé de
// descadastro do Respondo (o ActiveCampaign põe o dele, %UNSUBSCRIBELINK%,
// que também chega por webhook e vira supressão aqui).
export function acBodyFromHtml(html: string): string {
  let body = html;
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (m) body = m[1];
  return body
    .replace(/<!--rc-unsub-->[\s\S]*?<!--\/rc-unsub-->/g, "")
    // Sem foto do produto (pedido do Ian, 09/10): as miniaturas da lista de
    // itens (56x56) somem; o logo da marca fica.
    .replace(/<img\b[^>]*\bwidth="56"[^>]*\bheight="56"[^>]*>/gi, "")
    // O ActiveCampaign transforma quebra de linha do campo em <br>: entre
    // linhas de tabela isso vira espaço em branco grande. O HTML do Respondo
    // não depende de quebra de linha (as quebras do texto já são <br>), então
    // tudo vai numa linha só.
    .replace(/\r?\n+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

export interface AcEmail {
  to: string;
  subject: string;
  html: string;
  preheader?: string | null;
  link?: string | null;
  coupon?: string | null;
  ref: string; // chave do envio (dedupe_key do Respondo), volta no webhook via RC_REF
}

// Erro antes de acionar a tag = nada foi enviado (definitivo). Erro ao
// acionar a tag depois de conectar = ambíguo (a automação pode ter disparado).
export async function sendActiveCampaignEmail(input: AcEmail): Promise<{ id: string }> {
  if (!activeCampaignConfigured()) throw new Error("ActiveCampaign não configurado (ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY): e-mail não enviado.");
  const email = input.to.trim().toLowerCase();
  let contactId: string;
  let tagId: string;
  try {
    const ids = await fieldIds();
    tagId = await sendTagId();
    const values: Record<AcField, string> = {
      RC_SUBJECT: input.subject,
      RC_PREHEADER: input.preheader ?? "",
      RC_HTML: acBodyFromHtml(input.html),
      RC_LINK: input.link ?? "",
      RC_COUPON: input.coupon ?? "",
      RC_REF: input.ref.slice(0, 250),
    };
    const sync = await ac<{ contact?: { id: string } }>("POST", "/contact/sync", {
      contact: { email, fieldValues: AC_FIELDS.map((f) => ({ field: ids.get(f), value: values[f] })) },
    });
    contactId = String(sync.contact?.id ?? "");
    if (!contactId) throw new Error("ActiveCampaign contact/sync sem id");

    // Lista: entra só quem nunca esteve nela. Descadastrado (2) ou bounce (3)
    // NUNCA é reinscrito: isso seria ignorar o pedido da pessoa.
    const lists = await ac<{ contactLists?: Array<{ list: string; status: string }> }>("GET", `/contacts/${contactId}/contactLists`);
    const mine = (lists.contactLists ?? []).find((l) => String(l.list) === listId());
    if (mine && String(mine.status) !== "1") throw new Error(`contato descadastrado ou com bounce no ActiveCampaign (status ${mine.status}): não enviado`);
    if (!mine) await ac("POST", "/contactLists", { contactList: { list: listId(), contact: contactId, status: 1 } });

    // Tag que sobrou de um envio anterior: remove para o "tag adicionada" disparar de novo.
    const tags = await ac<{ contactTags?: Array<{ id: string; tag: string }> }>("GET", `/contacts/${contactId}/contactTags`);
    for (const ct of (tags.contactTags ?? []).filter((t) => String(t.tag) === tagId)) await ac("DELETE", `/contactTags/${ct.id}`);
  } catch (err) {
    const status = err instanceof AcHttpError ? err.status : undefined;
    throw new SendError(`ActiveCampaign (preparação): ${err instanceof Error ? err.message : String(err)}`, false, status);
  }

  // Disparo: a partir daqui a automação pode ter rodado.
  try {
    const r = await ac<{ contactTag?: { id: string } }>("POST", "/contactTags", { contactTag: { contact: contactId, tag: tagId } }, 20_000);
    const id = r.contactTag?.id;
    if (!id) throw new SendError("ActiveCampaign: tag de envio sem id na resposta", true);
    return { id: `ac:${contactId}:${id}` };
  } catch (err) {
    if (err instanceof SendError) throw err;
    if (err instanceof AcHttpError) throw new SendError(err.message, err.status >= 500, err.status);
    throw new SendError(`ActiveCampaign sem resposta ao acionar o envio: ${err instanceof Error ? err.message : String(err)}`, networkErrorAmbiguous(err));
  }
}
