# Respondo: guia de instalação e funcionamento

Este guia explica o que o sistema faz, de quais serviços ele depende, como instalar do zero numa operação nova e o que trocar para que ele fale pela sua marca. Leia na ordem: as seções 1 e 2 explicam o sistema; a seção 3 é o passo a passo; a seção 4 é a lista do que é específico da operação original.

---

## 1. O que o sistema faz

O Respondo é um painel web (Next.js) que roda na Vercel, guarda tudo num banco Supabase e usa a OpenAI para ler e escrever. São cinco módulos que dividem o mesmo banco:

1. **Inbox de suporte por e-mail.** Lê as caixas de e-mail das lojas (IMAP), agrupa as mensagens por cliente, busca os pedidos do cliente na Shopify, classifica (triagem), e escreve um rascunho de resposta no idioma do cliente seguindo o contexto e as regras da loja. Nada sai sozinho: o dono lê, edita se quiser, e envia (SMTP, pela mesma caixa).
2. **E-mails automáticos de pedido.** Comprovante de compra e aviso de recebimento ("recebemos sua mensagem"), com trava de um envio por e-mail.
3. **Recuperação de carrinho.** Importa os checkouts abandonados da Shopify e segue uma régua de e-mails (ActiveCampaign, Resend ou Amazon SES) e de WhatsApp (WAHA), parando sozinha quando a pessoa compra.
4. **Agente de WhatsApp.** Quando a pessoa responde no WhatsApp, um agente vendedor (OpenAI) conversa seguindo um roteiro fixo do dono, com handoff para humano.
5. **Pós-compra (boas-vindas).** Sequência de e-mails depois da compra.

Mais: painel de controle com métricas, CRM de clientes, tickets, contestações (chargeback), formulário de solicitação, links curtos, rastreio real dos pacotes (17TRACK) e alertas.

---

## 2. Os serviços e como cada um se conecta

| Serviço | Para que serve | Obrigatório? | Custo aproximado | Onde configura |
|---|---|---|---|---|
| **GitHub** | guarda o código; opcionalmente agenda o cron | sim (código) | grátis | repositório privado |
| **Vercel** | hospeda o painel e as rotas de API | sim | grátis a US$ 20/mês | variáveis em Project Settings |
| **Supabase** | banco de dados, login do painel, agendador (pg_cron) | sim | grátis a US$ 25/mês | `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY` |
| **OpenAI** | triagem, rascunhos, traduções, agente de WhatsApp | sim | por uso (ver 2.3) | `OPENAI_API_KEY` |
| **Shopify** | pedidos, clientes, rastreio, carrinhos abandonados | sim para pedidos | grátis (app customizado) | dentro do painel (Minhas lojas) |
| **Caixas de e-mail** (Gmail, Hostinger...) | receber e responder o suporte | sim para o Inbox | o que você já paga | dentro do painel (Minhas lojas) |
| **ActiveCampaign** *ou* **Resend** *ou* **Amazon SES** | e-mails de carrinho e pós-compra | só para recuperação | AC a partir de ~US$ 15/mês; Resend grátis até 3 mil/mês; SES ~US$ 0,10 por mil | variáveis + tela de Recuperação |
| **WAHA** (servidor próprio) | enviar e receber WhatsApp | só para WhatsApp | VPS ~€5/mês + um chip | `WAHA_*` + sessões no painel |
| **17TRACK** | situação real do pacote nos rascunhos | opcional | 200 consultas grátis, depois planos pagos | `TRACK17_API_KEY` |
| **QuickEmailVerification** | checar se o e-mail existe antes de mandar | opcional | ~US$ 0,004 por e-mail | `QEV_API_KEY` |
| **Domínio próprio** | remetente de e-mail, links curtos, WAHA | recomendado | ~US$ 10/ano | DNS no seu provedor |

### 2.1 Como as peças conversam

```
Cliente manda e-mail ─► caixa (IMAP) ◄── a cada 10 min o agendador chama /api/cron/poll-inboxes
                                          │
                                          ├─ importa mensagens novas para o Supabase
                                          ├─ busca pedidos na Shopify (todas as lojas conectadas)
                                          ├─ OpenAI: triagem + rascunho (fica "Pendente" no Inbox)
                                          ├─ importa carrinhos abandonados da Shopify
                                          └─ manda comprovantes e avisos automáticos
Dono clica Enviar ─► SMTP da mesma caixa ─► cliente

A cada 1 min o agendador chama /api/cron/recovery-tick
  └─ régua de carrinho: e-mail (ActiveCampaign/Resend/SES) e WhatsApp (WAHA)

Cliente responde no WhatsApp ─► WAHA ─► /api/webhooks/waha ─► agente vendedor ─► WAHA ─► cliente
Aberturas, cliques, bounces ─► /api/webhooks/activecampaign | resend | ses
```

### 2.2 O agendador (sem ele nada roda sozinho)

O sistema não tem um processo ligado o tempo todo: ele trabalha quando uma rota é chamada. Quem chama é um agendador, de uma destas formas (use a primeira):

1. **Supabase pg_cron (recomendado).** O próprio banco chama as rotas. Está pronto em `supabase/migrations/0012_cron_poll.sql` (a cada 10 min, `/api/cron/poll-inboxes`). Para a régua de carrinho, agende também `/api/cron/recovery-tick` a cada 1 minuto (modelo de SQL na seção 3.6).
2. **GitHub Actions.** `.github/workflows/poll-inboxes.yml` chama a mesma rota a cada 10 min. Precisa do segredo `CRON_SECRET` e da variável `APP_URL` no repositório (Settings > Secrets and variables > Actions).
3. **Vercel Cron.** `vercel.json` agenda 1 vez por dia (limite do plano grátis): serve só de reserva.

Todas as rotas `/api/cron/*` exigem o cabeçalho `Authorization: Bearer <CRON_SECRET>`.

### 2.3 OpenAI: quais modelos e quanto custa

- **Triagem** (entender o e-mail): `gpt-5.4-mini`.
- **Rascunho de resposta**: `gpt-5.4` em todo e-mail (mais caro, escreve muito melhor). Para economizar, defina `OPENAI_MODEL_DRAFT=gpt-5.4-mini`.
- **Traduções**: mini. **Avisos da Shopify**: nano. **Agente de WhatsApp**: `gpt-5.4`.
- Custo medido na operação original: de US$ 0,07 a US$ 0,10 por rascunho com o gpt-5.4.
- Ligue a **recarga automática** de crédito na OpenAI. Sem crédito, o Inbox para de gerar rascunhos e o agente de WhatsApp responde só com frases fixas até o crédito voltar.

### 2.4 WAHA (WhatsApp): como funciona

O WAHA é um programa que você instala num servidor seu e que conecta um número de WhatsApp comum (como o WhatsApp Web). Não é a API oficial da Meta: é grátis por mensagem, mas o número pode ser restringido se mandar mensagem para muita gente nova de uma vez.

- **Onde roda:** uma VPS Linux com Docker (ex.: Hetzner CX22, 2 vCPU, 4 GB, ~€5/mês) e um subdomínio apontado para o IP dela (ex.: `wa.suaempresa.com`). A pasta `infra/waha/` tem tudo: `docker-compose.yml` (WAHA + Caddy, que emite o HTTPS sozinho) e o `Caddyfile`.
- **Instalação no servidor:**
  1. Copie a pasta `infra/waha/` para o servidor.
  2. Crie o arquivo `.env` ao lado do `docker-compose.yml` com: `WAHA_DOMAIN=wa.suaempresa.com`, `WAHA_API_KEY=sha512:<hash da sua chave>`, `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD`, `WHATSAPP_SWAGGER_USERNAME`, `WHATSAPP_SWAGGER_PASSWORD`. O hash: `echo -n 'SUA_CHAVE' | sha512sum`.
  3. `docker compose up -d`.
  4. Abra `https://wa.suaempresa.com/dashboard` (usuário e senha do `.env`) para conferir que está no ar.
- **No Respondo (Vercel):** `WAHA_URL=https://wa.suaempresa.com`, `WAHA_API_KEY=SUA_CHAVE` (o texto, não o hash) e `WAHA_WEBHOOK_SECRET` (qualquer segredo longo). O Respondo registra sozinho o webhook `APP_URL/api/webhooks/waha` em cada sessão, assinado com esse segredo.
- **Conectar o número:** no painel, Recuperação de carrinho > Configuração > WhatsApp: crie a sessão (ex.: `minhaloja-1`) e escaneie o QR com o WhatsApp do chip (Configurações > Aparelhos conectados). O status precisa ficar **WORKING**.
- **Quando o chip cai (status FAILED ou SCAN_QR_CODE):** nada de WhatsApp sai e o painel inicial mostra um alerta vermelho. Abra o dashboard do WAHA, reinicie a sessão e escaneie o QR de novo. Se o WhatsApp aplicou o bloqueio temporário de contatos novos ("reachout timelock"), espere terminar: reiniciar antes piora.
- **Para não perder o número:** use chip dedicado, aqueça o número (poucas conversas novas por dia nas primeiras semanas) e, se quiser, limite com `WA_NEW_CONTACTS_PER_DAY`. A operação original perdeu o login depois de 16 contatos novos num dia.

### 2.5 E-mail de marketing (carrinho e pós-compra)

Escolha um provedor em Recuperação de carrinho > Configuração > Provedor. Use sempre um **subdomínio de envio** separado da caixa de suporte (ex.: `mail.suaempresa.com`), com SPF, DKIM e DMARC configurados. A aba **Entregabilidade** do painel confere o DNS e mostra aquecimento, bounce e reclamação.

- **ActiveCampaign:** o Respondo decide tudo (texto, quando, para quem) e o ActiveCampaign só entrega. O passo a passo da tela (campos personalizados, tag, automação de 2 ações, webhook) está em `docs/activecampaign-envio.md`.
- **Resend:** só a chave e o domínio verificado; webhook em `APP_URL/api/webhooks/resend` com `RESEND_WEBHOOK_SECRET`.
- **Amazon SES:** precisa sair do "sandbox" (pedido na AWS) antes de mandar para clientes; eventos chegam por SNS em `APP_URL/api/webhooks/ses`.

### 2.6 Shopify

Cada loja é conectada em Minhas lojas > (loja) > Shopify com um **app customizado** criado na Shopify (Dev Dashboard), só com permissões de leitura: `read_orders`, `read_all_orders`, `read_customers`, `read_fulfillments`, `read_products`. Cole o domínio `xxxx.myshopify.com` e as credenciais do app. O sistema nunca altera nada na Shopify. Os tokens ficam criptografados com `CREDENTIALS_ENCRYPTION_KEY`.

### 2.7 Caixas de e-mail do suporte

Minhas lojas > (loja) > E-mail: endereço, servidor IMAP/SMTP e senha.
- **Gmail / Google Workspace:** ative a verificação em duas etapas e crie uma **senha de app** (myaccount.google.com > Segurança > Senhas de app). Servidores `imap.gmail.com:993` e `smtp.gmail.com:465`. Se o Google recusar ("BadCredentials"), gere outra senha de app.
- **Hostinger:** `imap.hostinger.com:993` e `smtp.hostinger.com:465`, com a senha da caixa.
- O sistema nunca apaga nem marca e-mails como lidos: ele lembra o último e-mail lido pelo número interno da caixa.

---

## 3. Instalação do zero, passo a passo

### 3.1 Código
1. Crie um repositório **privado** no GitHub e suba esta pasta.
2. No computador: Node 20+, `npm install`, copie `.env.example` para `.env.local`.

### 3.2 Supabase
1. Crie um projeto em supabase.com (região próxima dos clientes).
2. SQL Editor: rode os arquivos de `supabase/migrations/` **em ordem**, do `0001` ao último. Antes do `0012`, troque a URL e o `COLE_AQUI_O_CRON_SECRET` pelos seus valores.
3. Authentication > Users: crie o usuário (e-mail e senha) que vai entrar no painel.
4. Project Settings > API: copie a URL, a chave `anon` e a `service_role` para o `.env.local`.

### 3.3 Chaves
Preencha o `.env.local` seguindo os comentários do `.env.example`. As obrigatórias são as do primeiro bloco. Gere `CREDENTIALS_ENCRYPTION_KEY` e `CRON_SECRET` com `openssl rand -hex 32` e **guarde em lugar seguro**: perder a chave de criptografia obriga a reconectar todas as caixas e lojas.

### 3.4 Vercel
1. Importe o repositório na Vercel.
2. Cadastre todas as variáveis do `.env.local` em Project Settings > Environment Variables (Production).
3. Deploy. Defina `NEXT_PUBLIC_APP_URL` e `APP_URL` com o endereço final (ou o domínio próprio) e faça um novo deploy.
4. Teste: `npm run dev` no computador (http://localhost:3000) e o login com o usuário do 3.2.

### 3.5 Dentro do painel
1. **Onboarding / Minhas lojas:** crie cada loja, conecte a caixa de e-mail e a Shopify.
2. **Produtos:** cadastre o produto (nome, idioma, persona que assina).
3. **Contexto com Objeções:** escreva o contexto da loja (o modelo está em `docs/CONTEXTO-MODELO.md`). É dele que a IA tira o que pode afirmar: produto, prazos, políticas de reembolso, respostas para objeções. Sem contexto, os rascunhos saem genéricos.
4. Aguarde o primeiro ciclo do agendador e confira o Inbox.

### 3.6 Agendador
Rode o `0012` (passo 3.2) para o ciclo de 10 minutos. Para a régua de carrinho em tempo real, rode também no SQL Editor:

```sql
select cron.schedule(
  'respondo-recovery-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://SEU-APP/api/cron/recovery-tick',
    headers := jsonb_build_object('Authorization', 'Bearer SEU_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);
```

Conferir: `select jobname, schedule, active from cron.job;`

### 3.7 Recuperação de carrinho (quando quiser ligar)
1. Configure um provedor de e-mail (2.5) e, se for usar WhatsApp, o WAHA (2.4).
2. Recuperação de carrinho > Configuração: comece em **modo de teste** (`test_mode`): tudo vai só para o e-mail e o telefone de teste da loja.
3. Revise a régua (passos, textos, descontos) e o roteiro do agente de WhatsApp.
4. Só então desligue o modo de teste. Nada é enviado a clientes antes disso.

---

## 4. O que é específico da operação original (trocar na operação nova)

O código foi escrito para uma operação real e tem regras dela embutidas. Na operação nova, revise:

| Onde | O que tem | O que fazer |
|---|---|---|
| `lib/ai/house-rules.ts` | regras de redação ditadas pelo dono (prazos, rastreio, reembolso, estilo) | ajustar às suas políticas |
| `lib/ai/openai-agent.ts`, `lib/agent/analyze.ts` | instruções do rascunho, personas, casos graves | revisar o tom e as regras |
| `lib/agent/products.ts`, `lib/agent/brands.ts` | nomes de persona por idioma e roteamento de marcas | cadastrar as suas marcas e personas |
| `lib/recovery/product-gate.ts` | **trava: os fluxos automáticos só rodam para pedidos com o produto "Olavita"** | trocar pelo seu produto, senão nada automático sai |
| `lib/recovery/defaults.ts`, `lib/recovery/seeds/` | régua, textos e roteiro do WhatsApp em hebraico | escrever os seus |
| `lib/recovery/links.ts` | mapa de cupons antigos e `HOLD_LEGACY_COUPON_CARTS` | apagar o mapa e desligar a trava |
| `lib/receipts/` | comprovante de compra (visual e textos) | trocar marca, cores e textos |
| `lib/agent/shopify-notice.ts`, `lib/agent/noise.ts` | filtros de remetentes e assuntos de avisos | conferir com os seus remetentes |
| `docs/activecampaign-envio.md` | remetente, lista e domínio da operação original | usar os seus |
| `infra/waha/docker-compose.yml` | fuso horário `Asia/Jerusalem` | trocar pelo seu |
| Banco (`store_contexts`, `recovery_knowledge`, `recovery_steps`) | contexto, conhecimento do agente e régua | começa vazio na operação nova: preencher pelo painel |

Nesta cópia, os e-mails, URLs e IDs da operação original foram trocados por marcadores: `dono@suaempresa.com`, `https://SEU-APP`, `https://SEU-SITE`, `COLE-AQUI-O-ID-DA-LOJA`, `wa.suaempresa.com`. Procure por eles e preencha com os seus.


---

## 5. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| Inbox não recebe nada | agendador não roda ou caixa com senha errada | `select * from cron.job`; Minhas lojas mostra o erro da caixa |
| "Command failed" ou "BadCredentials" na caixa Gmail | senha de app inválida | gerar nova senha de app e reconectar |
| Rascunhos param de aparecer | OpenAI sem crédito | recarregar e ligar a recarga automática |
| WhatsApp não sai | sessão do WAHA fora de WORKING | reiniciar e escanear o QR (2.4) |
| E-mails de carrinho não saem | modo de teste ligado, provedor não configurado ou trava de produto | conferir Configuração e `product-gate.ts` |
| Tudo some depois de trocar a chave de criptografia | `CREDENTIALS_ENCRYPTION_KEY` mudou | voltar a chave antiga ou reconectar caixas e lojas |
