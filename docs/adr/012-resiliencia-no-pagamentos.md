# ADR-012: Timeout, retry e circuit breaker só no pagamentos → banco

- **Status:** aceita
- **Quando:** aula 9

## Contexto

O banco do cartão não é nosso: demora, cai e recusa. Lento é pior que fora do ar (requisições presas derrubam os vizinhos). Retry em todas as camadas multiplica as chamadas (3 × 3 × 3).

## Decisão

Na chamada ao banco ([`pagamentos/src/banco.js`](../../pagamentos/src/banco.js)): timeout de 2 s; até 3 tentativas com espera de 500 ms e 1 s (+ jitter), só para timeout, erro de rede e 5xx (402 é uma resposta); circuit breaker (opossum: 50% de falha em ≥ 5 chamadas numa janela de 10 s, 15 s até o meio-aberto). A referência (id do pedido) é a chave de idempotência no banco. O estorno não passa pelo circuito. Desistiu por timeout: pede o estorno da referência por segurança. O estado do circuito aparece no `/health`.

## Consequências

**Ganha:** falhas passageiras se resolvem sozinhas (30% de falha vira quase tudo `PAGO`); banco no chão recebe muito menos chamadas e o pagamento falha rápido.
**Perde:** cada réplica tem o seu circuito em memória (podem discordar por alguns segundos; o banco recebe até 5 chamadas ruins por réplica antes de abrir). O retry fica escondido: sem os logs de cada tentativa, ninguém percebe que o banco está piorando.
