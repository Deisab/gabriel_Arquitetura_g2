# ADR-009: Kafka e coreografia para o que pode esperar

- **Status:** aceita
- **Quando:** aula 8

## Contexto

Um checkout que chama catálogo, pagamento e e-mail em corrente multiplica a chance de falhar (0,99⁴ = 96%) e soma as latências.

## Decisão

Kafka (um broker KRaft) com eventos no passado (`entidade.fato`), tópicos por entidade (`pedidos`, `estoque`, `pagamentos`, 3 partições), envelope único `{ id, tipo, pedidoId, ocorridoEm, correlationId, dados }`, chave = id do pedido, um consumer group por serviço. Coreografia: ninguém manda, cada serviço reage aos eventos e publica os seus. Os eventos levam o necessário (o pagamento cobra sem consultar ninguém), nunca o número do cartão.

## Consequências

**Ganha:** serviço fora do ar não impede a venda (o evento espera no tópico); picos são absorvidos; serviço novo só começa a escutar.
**Perde:** consistência eventual (o pedido passa alguns instantes em `AGUARDANDO_*`); entrega pelo menos uma vez, então todo handler precisa ser idempotente; o fluxo inteiro só aparece somando os serviços; publicar depois do COMMIT deixa a janela da escrita dupla (sem Outbox).

## Relacionadas

- ADR-011
