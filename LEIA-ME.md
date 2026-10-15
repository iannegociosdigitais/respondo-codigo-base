# Respondo (código base)

Cópia do código do Respondo para guardar e reutilizar numa operação nova. Não tem dados, clientes, chaves nem histórico da operação original.

**Comece por aqui:** `docs/GUIA-INSTALACAO.md`. Ele explica o que o sistema faz, cada serviço (Supabase, Vercel, OpenAI, Shopify, caixas de e-mail, ActiveCampaign / Resend / SES, WAHA para WhatsApp, 17TRACK), a instalação passo a passo e o que trocar para a sua marca.

## Resumo do que você vai precisar

1. Conta no GitHub (repositório privado), na Vercel, no Supabase e na OpenAI.
2. Rodar as migrações de `supabase/migrations/` em ordem no Supabase.
3. Preencher as variáveis do `.env.example` na Vercel (e num `.env.local` para testar no computador).
4. Agendar as rotas de cron (Supabase pg_cron): sem isso nada roda sozinho.
5. No painel: cadastrar lojas, caixas de e-mail, Shopify, produto e o contexto da loja.
6. Opcional: WAHA num servidor para WhatsApp; ActiveCampaign, Resend ou SES para e-mails de carrinho.

## Antes de colocar em produção

- Troque os marcadores `dono@suaempresa.com`, `https://SEU-APP`, `https://SEU-SITE`, `COLE-AQUI-O-ID-DA-LOJA` e `wa.suaempresa.com`.
- Troque a trava de produto em `lib/recovery/product-gate.ts`: hoje os fluxos automáticos só rodam para pedidos com o produto "Olavita".
- Revise as regras de redação em `lib/ai/house-rules.ts` e os textos da régua em `lib/recovery/defaults.ts` e `lib/recovery/seeds/`.
- Deixe a recuperação de carrinho em modo de teste até revisar tudo.

## Comandos

```bash
npm install
npm run dev
```
