# ADR-010: O pedido copia preço, nome e endereço

- **Status:** aceita
- **Quando:** aula 7

## Contexto

Produtos mudam de preço e clientes mudam de endereço; o pedido de hoje não pode mudar com eles.

## Decisão

`itens_pedido` guarda `nome_produto` e `preco_unitario`; `pedidos` guarda `endereco_entrega` (JSONB) e só os 4 últimos dígitos do cartão.

## Consequências

**Ganha:** histórico fiel; o pedido não depende do catálogo para ser exibido.
**Perde:** dado repetido em dois bancos (de propósito: não é duplicação, é histórico). Corrigir um nome errado no catálogo não corrige os pedidos antigos.
