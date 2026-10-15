# ActiveCampaign como canal de envio do Respondo

O Respondo continua decidindo tudo (quando mandar, para quem, cupom, parar quando
compra, idioma, ritmo, bloqueio de e-mail errado). O ActiveCampaign só entrega.

## Como o envio acontece

1. O Respondo grava no contato do ActiveCampaign os campos já prontos:
   `RC_SUBJECT`, `RC_PREHEADER`, `RC_HTML`, `RC_LINK`, `RC_COUPON`, `RC_REF`.
2. Coloca o contato na lista "Master Contact List" (id 3) (nunca reinscreve quem se descadastrou).
3. Tira e põe de novo a tag `respondo-envio`.
4. A automação abaixo manda o e-mail e tira a tag.
5. O webhook "Respondo eventos" devolve envio, abertura, clique, resposta, bounce e
   descadastro para `/api/webhooks/activecampaign`.

Já criado pela API: os 6 campos, a tag `respondo-envio` e o webhook.

## O que montar na tela (uma vez)

### 1. Domínio de envio

Settings > Domains (ou Settings > Advanced > Domain authentication): adicionar
`mail.skininsiderdaily.com`. Copiar os registros DKIM/DMARC que aparecerem
(o Claude cria na Hostinger pelo MCP, ou cole manualmente).

### 2. E-mail "Respondo envio"

- Remetente (nome): `יעל מ-Olavita`
- Remetente (e-mail): `olavita@mail.skininsiderdaily.com`
- Responder para: `help@skininsiderdaily.com`
- Assunto: `%RC_SUBJECT%`
- Pré-cabeçalho (preheader): `%RC_PREHEADER%`
- Editor: HTML personalizado ("Custom HTML" / "Code your own"), colar o HTML abaixo.

```html
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f5f8;">
%RC_HTML%
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;">
  <tr><td align="center" style="padding:8px 24px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8a91a0;">
    <a href="%UNSUBSCRIBELINK%" style="color:#8a91a0;text-decoration:underline;">להפסיק לקבל תזכורות על העגלה</a><br>
    %SENDER-INFO-SINGLELINE%
  </td></tr>
</table>
</body>
</html>
```

Sem imagem de produto (pedido do Ian): o corpo do Respondo para o ActiveCampaign
já vai sem foto do produto.

### 3. Automação "Respondo envio"

- Gatilho: **Tag is added** → `respondo-envio`
- Runs: **Multiple times** (cada passo da régua dispara de novo)
- Ação 1: **Send an email** → "Respondo envio"
- Ação 2: **Remove a tag** → `respondo-envio`
- Ativar.

Cabe no Starter (2 ações).

### 4. Ligar no Respondo

Depois do SQL `0022` rodado: Recuperação > Configuração > Provedor = ActiveCampaign.
Teste: "Testar este passo" manda para dono@suaempresa.com.
