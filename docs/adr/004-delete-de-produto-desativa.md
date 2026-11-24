# ADR-004: DELETE de produto desativa em vez de apagar

- **Status:** aceita
- **Quando:** aula 6

## Contexto

Pedidos e reservas referenciam produtos pelo id. Apagar um produto quebraria o histórico.

## Decisão

`DELETE /produtos/:id` faz `ativo = false`. `GET /produtos` lista só ativos; `GET /produtos/:id` ainda devolve o desativado, com `ativo: false`. O checkout recusa (409) produto desativado, e a reserva também.

## Consequências

**Ganha:** o histórico continua íntegro e o produto pode ser reativado.
**Perde:** a coleção cresce com produtos que ninguém compra; quem consulta precisa olhar o `ativo`.
