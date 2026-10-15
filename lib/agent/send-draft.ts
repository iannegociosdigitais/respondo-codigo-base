import { bulletsToProse, stripDashes } from "@/lib/text/dashes";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendReply } from "@/lib/email/send-reply";
import { translateReplyForCustomer, isPortuguese } from "@/lib/ai/translate-reply";
import { portugueseLeak } from "@/lib/text/lang-leak";
import { learnFromEdit } from "@/lib/ai/learn";
import { extractPromises, type Todo } from "@/lib/ai/promises";
import { brandConflict, loadProducts } from "@/lib/agent/products";
import { hasHebrew } from "@/lib/ai/lang";
import { shortenLinks } from "@/lib/recovery/short-links";

export interface SendDraftOptions {
  replyPt: string;
  replyOriginal?: string;
  force?: boolean;
  forceBrand?: boolean;
  closeOthers?: boolean;
  skipLearning?: boolean;
}

export interface SendDraftOk {
  ok: true;
  sentBody: string;
  learned: { situation_summary: string; guidance: string } | null;
  closedOthers: number;
  todos: Todo[];
}
export interface SendDraftErr {
  ok: false;
  status: number;
  error: string;
}

// Lógica de envio compartilhada entre o botão "Enviar" da conversa e o envio
// em massa (selecionar vários rascunhos prontos e mandar de uma vez): traduz
// pro idioma do cliente se precisar, envia na mesma thread, fecha o ticket,
// avança a sequência de chargeback e vira lembrete ("A fazer") o que foi
// prometido. Se você editou o rascunho, aprende a regra por trás da edição.
export async function sendConversationDraft(admin: SupabaseClient, id: string, opts: SendDraftOptions): Promise<SendDraftOk | SendDraftErr> {
  const replyPt = bulletsToProse(stripDashes(opts.replyPt.trim()));
  const replyOriginal = bulletsToProse(stripDashes((opts.replyOriginal ?? "").trim()));
  if (!replyPt && !replyOriginal) return { ok: false, status: 400, error: "resposta vazia" };

  const { data: conv } = await admin
    .from("conversations")
    .select("id, store_id, subject, language, category, draft_reply, draft_reply_pt, customers(email)")
    .eq("id", id)
    .single();
  if (!conv) return { ok: false, status: 404, error: "conversa não encontrada" };

  // Trava contra resposta em dobro: se a última mensagem da conversa já é da
  // loja, só envia de novo com confirmação explícita ("Escrever outra resposta").
  const { data: lastAny } = await admin.from("messages").select("direction, sent_at, created_at").eq("conversation_id", id).order("sent_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  // Conversa que voltou a ficar pendente por iniciativa nossa (sequência de
  // chargeback) pode receber novo e-mail mesmo sem mensagem nova do cliente.
  const { data: statusRow } = await admin.from("conversations").select("status").eq("id", id).maybeSingle();
  const pendingNow = ["nova", "reaberta", "aguardando_humano"].includes((statusRow?.status as string) ?? "");
  if (lastAny && lastAny.direction !== "inbound" && !opts.force && !pendingNow) {
    return { ok: false, status: 409, error: "Essa conversa já foi respondida e o cliente ainda não escreveu de novo. Se quiser mandar outra mensagem mesmo assim, clique em 'Escrever outra resposta'." };
  }

  const customerEmail = (conv.customers as unknown as { email: string } | null)?.email;
  if (!customerEmail) return { ok: false, status: 400, error: "cliente sem e-mail" };

  const { data: lastInbound } = await admin
    .from("messages")
    .select("id, message_id, references_ids, subject, body_pt, body, to_address")
    .eq("conversation_id", id)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  // A caixa que recebeu o e-mail responde — mesmo que a conversa tenha sido
  // roteada pra outra marca sem caixa própria.
  const receiving = (lastInbound?.to_address ?? "").toLowerCase();
  const { data: byAddress } = receiving
    ? await admin.from("store_email_accounts").select("*").eq("email_address", receiving).not("connected_at", "is", null).limit(1)
    : { data: null };
  const { data: accounts } = await admin.from("store_email_accounts").select("*").eq("store_id", conv.store_id).not("connected_at", "is", null);
  // Conversa aberta pela loja (sem e-mail do cliente): usa a caixa da última
  // mensagem nossa; senão, a caixa da marca pelo idioma (hebraico = Olavita,
  // help@skininsiderdaily.com). Antes caía na 1ª caixa da loja, sem ordem, e
  // podia mandar mensagem da Olavita pelo e-mail da OsteoPure.
  let fallback = (accounts ?? [])[0];
  if (!byAddress?.[0] && (accounts ?? []).length > 1) {
    const { data: lastOut } = await admin.from("messages").select("from_address").eq("conversation_id", id).neq("direction", "inbound").order("sent_at", { ascending: false }).limit(1).maybeSingle();
    const prev = (accounts ?? []).find((a) => a.email_address === (lastOut?.from_address ?? "").toLowerCase());
    const byLang = conv.language === "he" ? (accounts ?? []).find((a) => /skininsiderdaily/i.test(a.email_address)) : null;
    fallback = prev ?? byLang ?? fallback;
  }
  const account = byAddress?.[0] ?? fallback;
  if (!account) return { ok: false, status: 400, error: "nenhuma caixa de e-mail conectada nessa loja" };

  // Se a pessoa editou direto no idioma do cliente, vai como está; senão
  // traduz o PT-BR.
  const norm = (x: string | null | undefined) => (x ?? "").replace(/\s+/g, " ").trim();
  const unchanged = Boolean(conv.draft_reply) && norm(replyPt) === norm(conv.draft_reply_pt as string | null);
  // Sem idioma gravado, isPortuguese(null) dá true e o PT-BR iria sem tradução
  // pra um cliente estrangeiro. Só importa quando vai traduzir (texto editado
  // e sem versão no idioma do cliente): hebraico dá pra detectar no e-mail
  // dele; fora isso, melhor recusar do que chutar errado.
  let language = ((conv.language as string | null) ?? "").trim() || null;
  if (!language && !replyOriginal && !unchanged) {
    if (hasHebrew(lastInbound?.body) || hasHebrew(lastInbound?.subject)) language = "he";
    else return { ok: false, status: 400, error: "idioma do cliente desconhecido — clique em Gerar resposta antes de enviar" };
  }
  let finalBody: string;
  try {
    // Rascunho aprovado sem edição: vai o original já gerado no idioma do
    // cliente (com todo o contexto), sem retradução.
    finalBody = replyOriginal || (unchanged ? (conv.draft_reply as string) : await translateReplyForCustomer(replyPt, language));
    // Rascunho com português misturado no idioma do cliente: retraduz do PT;
    // se ainda vazar, não envia.
    if (!replyOriginal && portugueseLeak(finalBody, language).length > 0) finalBody = await translateReplyForCustomer(replyPt, language);
  } catch (err) {
    return { ok: false, status: 502, error: `tradução falhou: ${(err as Error).message}` };
  }
  finalBody = bulletsToProse(finalBody);
  const leak = portugueseLeak(finalBody, language);
  if (leak.length > 0) return { ok: false, status: 409, error: `NÃO ENVIADO: o texto em ${language} tem português misturado (${leak.slice(0, 5).join(", ")}). Clique em Gerar resposta e envie de novo.` };

  // Trava de marca no envio: creme Olavita nunca sai ASSINADO como OsteoPure
  // (citar "SP OSTEOPURE" da fatura no corpo é permitido).
  const { data: prodRow } = await admin.from("conversations").select("product_id").eq("id", id).maybeSingle();
  const mix = brandConflict(await loadProducts(admin), (prodRow as { product_id?: string | null } | null)?.product_id ?? null, finalBody, { signatureOnly: true });
  if (mix && !opts.forceBrand) {
    return { ok: false, status: 409, error: `NÃO ENVIADO — mistura de marca: ${mix}. Corrija o texto (ou clique em Gerar resposta) e envie de novo.` };
  }

  // Link do formulário de solicitação vira link curto no domínio da loja (mais
  // bonito). Qualquer falha mantém o link original: o e-mail nunca deixa de sair.
  finalBody = await shortenLinks(admin, finalBody).catch(() => finalBody);

  const subject = lastInbound?.subject ?? conv.subject ?? "";
  let messageId: string | null = null;
  try {
    const sent = await sendReply({
      emailAccount: {
        smtpHost: account.smtp_host,
        smtpPort: account.smtp_port,
        emailAddress: account.email_address,
        credentialEncrypted: account.credential_encrypted,
      },
      to: customerEmail,
      // contato proativo (sem e-mail do cliente pra responder) não leva "Re:"
      subject: !lastInbound || /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`,
      body: finalBody,
      inReplyTo: lastInbound?.message_id ?? null,
      references: [...((lastInbound?.references_ids as string[] | null) ?? []), lastInbound?.message_id ?? ""].filter(Boolean),
    });
    messageId = sent.messageId;
  } catch (err) {
    return { ok: false, status: 502, error: `Falha ao enviar: ${(err as Error).message}` };
  }

  const now = new Date().toISOString();
  await admin.from("messages").insert({
    conversation_id: id,
    direction: "outbound_human",
    from_address: account.email_address,
    to_address: customerEmail,
    subject: `Re: ${subject}`,
    body: finalBody,
    body_pt: isPortuguese(language) ? null : replyPt || null,
    message_id: messageId,
    in_reply_to: lastInbound?.message_id ?? null,
    sent_at: now,
  });
  // O rascunho enviado sai da conversa (fica no histórico como mensagem).
  await admin.from("conversations").update({ status: "respondida_humano", unread: false, last_message_at: now, draft_reply: null, draft_reply_pt: null }).eq("id", id);
  await admin.from("usage_logs").insert({ store_id: conv.store_id, event_type: "email_answered_human" });

  // Cliente que mandou 15 e-mails: uma resposta cobre tudo — as outras
  // pendências dele são encerradas junto (opção marcada no Inbox).
  let closedOthers = 0;
  if (opts.closeOthers) {
    const { data: customerRow } = await admin.from("conversations").select("customer_id").eq("id", id).single();
    if (customerRow?.customer_id) {
      const { data: closed } = await admin
        .from("conversations")
        .update({ status: "encerrada", closed_at: now, unread: false })
        .eq("customer_id", customerRow.customer_id)
        .neq("id", id)
        .in("status", ["nova", "reaberta", "aguardando_humano"])
        .select("id");
      closedOthers = closed?.length ?? 0;
    }
  }

  // Sequência de chargeback: este envio conta como mais um e-mail da série.
  {
    const { data: cur } = await admin.from("conversations").select("analysis").eq("id", id).single();
    const analysis = (cur?.analysis ?? {}) as Record<string, unknown>;
    const cbState = analysis.chargeback as { step?: number; first_sent_at?: string | null; resolved_at?: string | null; orders?: unknown[] } | undefined;
    if (cbState && !cbState.resolved_at) {
      const step = Math.min((cbState.step ?? 0) + 1, 3);
      await admin
        .from("conversations")
        .update({ analysis: { ...analysis, chargeback: { ...cbState, step, first_sent_at: cbState.first_sent_at ?? now, last_sent_at: now }, ticket_reason: `CHARGEBACK ABERTO (${cbState.orders?.length ?? 1} pedido(s), ${step} de 3 e-mails enviados)` } })
        .eq("id", id);
    }
  }

  // O que foi prometido neste e-mail vira lembrete ("A fazer"): cancelar
  // assinatura, pedir regularização… pra não ficar só na promessa.
  let todos: Todo[] = [];
  try {
    const found = await extractPromises(replyPt || finalBody);
    if (found.length > 0) {
      const { data: cur } = await admin.from("conversations").select("analysis").eq("id", id).single();
      const analysis = (cur?.analysis ?? {}) as Record<string, unknown>;
      const prev = (Array.isArray(analysis.todos) ? analysis.todos : []) as Todo[];
      todos = [...prev, ...found.filter((f) => !prev.some((p) => !p.done && p.type === f.type)).map((f) => ({ ...f, created_at: now, done: false }))];
      await admin.from("conversations").update({ analysis: { ...analysis, todos } }).eq("id", id);
    }
  } catch (err) {
    console.error("extractPromises falhou:", (err as Error).message);
  }

  // Aprendizado automático a partir da edição.
  let learned: { situation_summary: string; guidance: string } | null = null;
  if (replyPt && conv.draft_reply_pt && !unchanged && !opts.skipLearning) {
    try {
      const rule = await learnFromEdit({
        customerMessagePt: lastInbound?.body_pt ?? lastInbound?.body ?? "",
        draftPt: conv.draft_reply_pt,
        finalPt: replyPt,
        category: conv.category,
      });
      if (rule) {
        await admin.from("learned_responses").insert({
          store_id: conv.store_id,
          category: conv.category === "spam" ? null : conv.category,
          situation_summary: rule.situation_summary,
          guidance: rule.guidance,
          source: "edicao",
          source_conversation_id: id,
        });
        learned = rule;
      }
    } catch (err) {
      console.error("learnFromEdit falhou:", err);
    }
  }

  return { ok: true, sentBody: finalBody, learned, closedOthers, todos: todos.filter((t) => !t.done) };
}
