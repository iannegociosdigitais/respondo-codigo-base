# Contexto · NOME DA LOJA

<!--
MODELO PARA GERAR O CONTEXTO FORA DA PLATAFORMA (GPT, Gemini, Claude) E IMPORTAR EM
Respondo → Contexto com Objeções → Importar .md

REGRAS DO FORMATO
1. Um bloco por assunto. Cada bloco começa com "## Título curto".
2. Logo abaixo do título, linhas opcionais de cabeçalho; depois uma linha "---"; depois o texto.
3. Texto no imperativo, direto, com os números exatos (prazos, valores, nomes). Sem floreio.
   Escreva o que dizer E o que nunca dizer. Pode incluir 1 frase-modelo no idioma do cliente.
4. Mesmo título + mesmo produto = atualiza o bloco existente. Título novo = cria.

CABEÇALHO
tipo:     base | idioma | loja | produto | prazo   → entram em TODA resposta daquele produto
          objecao | politica | fase               → entram quando tema, fase ou palavras batem
produto:  nome exato do produto cadastrado (vazio = vale para a loja inteira)
temas:    prazo_entrega, rastreio, atraso, consta_entregue, endereco, cancelamento, assinatura,
          cobranca, regularizacao_financeira, devolucao, chargeback_contestacao, produto_uso,
          produto_resultado, preco_oferta, pagamento, legitimidade_loja, agradecimento, outro
fases:    1 (até 15 dias) · 2 (15–30 dias ou já cobrou) · 3 (30+ dias, ameaça, contestação) · 4 (assinatura)
idiomas:  fr, he, tr, en…  (o bloco só entra para clientes nesses idiomas)
palavras: palavras que o CLIENTE usa, em qualquer idioma (krem, colis, where is my order)

ORDEM RECOMENDADA POR PRODUTO
A. Base (sempre): idioma e persona · informações do produto · informações da loja ·
   consulta do pedido · prazos de entrega
B. Fases: o que dizer na fase 1, 2, 3 e 4
C. Objeções: uma por bloco (não chegou, consta entregue, endereço, sem resultado, cobrança não reconhecida…)
D. Políticas: contestação/chargeback, devolução, cancelamento, assinatura, ameaça jurídica
-->

## PRODUTO · idioma e persona
produto: PRODUTO
tipo: idioma
---
Responder sempre no idioma da última mensagem do cliente, como nativo. Quem assina: NOME, CARGO,
fecho "FECHO" (por idioma: fr …, he …, tr …). Sempre chamar o cliente pelo primeiro nome.
Concordância de gênero de quem assina.

## PRODUTO · informações do produto
produto: PRODUTO
tipo: produto
---
O que é, para que serve, como usar, composição, o que NÃO contém, preços e ofertas oficiais,
o que nunca prometer.

## PRODUTO · informações da loja
produto: PRODUTO
tipo: loja
---
Nome da marca, site, de onde o cliente compra, moeda, formas de pagamento, o que nunca mencionar.

## PRODUTO · consulta do pedido
produto: PRODUTO
tipo: loja
---
Em qual Shopify ficam os pedidos. Se o pedido não for localizado: responder com os prazos e a
data que o cliente informou; nunca dizer que não encontrou; nunca abrir pedindo número do pedido.

## PRODUTO · prazos de entrega
produto: PRODUTO
tipo: prazo
temas: prazo_entrega, atraso, rastreio
---
Preparação: X dias após a compra. Entrega: Y a Z dias úteis após o envio. Como calcular e dizer
a janela de chegada a partir da data da compra. Código de rastreio: nunca enviar; oferecer como pergunta.

## PRODUTO · fase 1
produto: PRODUTO
tipo: fase
fases: 1
---
O que dizer no primeiro contato dentro do prazo.

## PRODUTO · fase 2
produto: PRODUTO
tipo: fase
fases: 2
---
O que muda quando o cliente já cobrou antes ou passou de 15 dias. Nunca repetir o prazo já dado.

## PRODUTO · fase 3
produto: PRODUTO
tipo: fase
fases: 3
---
Mais de 30 dias, ameaça ou contestação: estrutura da resposta, solução que pode ser afirmada, vocabulário.

## Objeção: EXEMPLO
produto: PRODUTO
tipo: objecao
temas: atraso
fases: 1, 2
palavras: where is my order, colis, krem
---
Resposta que resolve, passo a passo.

## Política: contestação no banco / chargeback
tipo: politica
temas: chargeback_contestacao
fases: 3
---
Como responder, o que oferecer, como negociar a retirada, vocabulário permitido.

## Política: ameaça jurídica (advogado, denúncia)
tipo: politica
temas: legitimidade_loja, chargeback_contestacao
fases: 3
---
Tom, o que afirmar, o que nunca dizer, quando oferecer a solução financeira.

## Política: devolução
tipo: politica
temas: devolucao
---
Quando aceita, como o cliente faz, custo, prazo da regularização financeira.
