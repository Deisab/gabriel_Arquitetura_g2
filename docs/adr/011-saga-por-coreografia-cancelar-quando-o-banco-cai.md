# ADR-011: Saga por coreografia; cancelar quando o banco do cartão cai

- **Status:** aceita
- **Quando:** aula 9

## Contexto

Uma compra grava em três bancos (pedidos, catálogo, pagamentos) e chama um banco de cartão externo. Não existe ROLLBACK que desfaça os três, e 2PC não é opção (Kafka, Mongo e o banco externo não participam).

## Decisão

Saga por coreografia: cada passo é uma transação local com uma compensação que o próprio serviço conhece (catálogo devolve o estoque ao ouvir `pagamento.recusado` ou `pedido.cancelado`; pagamentos estorna ao ouvir `pedido.cancelado`; pedidos vira `CANCELADO` com o motivo). A ordem segue o custo de desfazer: reservar antes de cobrar. Com o banco do cartão fora (timeout, 503, circuito aberto), o pagamento vira `ERRO` e publica `pagamento.recusado`: o pedido é cancelado e o estoque devolvido.

## Consequências

**Ganha:** nenhum orquestrador para manter; o cliente tem resposta rápida e o estoque não fica preso.
**Perde:** não há isolamento (outro cliente pode ver "esgotado" por causa de uma reserva que vai ser desfeita); vendas que dariam certo minutos depois são perdidas quando o banco cai. A alternativa (pagamento `PENDENTE`, pausar o consumo com o circuito aberto e tentar de novo, com prazo) não perde a venda, mas prende o estoque e deixa o cliente sem resposta. Decisão de negócio; ficamos com o mais simples.

## Relacionadas

- ADR-012
