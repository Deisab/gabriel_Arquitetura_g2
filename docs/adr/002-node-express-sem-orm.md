# ADR-002: Node.js + Express, sem ORM

- **Status:** aceita
- **Quando:** aula 6

## Contexto

O projeto tem cinco serviços pequenos, escritos pela dupla, e o objetivo é deixar visível o que cada banco garante.

## Decisão

Node 22 e Express 5 em todos os serviços, com os drivers oficiais (`pg`, `mongodb`, `ioredis`, `kafkajs`) e SQL escrito à mão. O Express 5 repassa erros de handlers `async` para o middleware de erro, que devolve sempre `{ erro, detalhes }`.

## Consequências

**Ganha:** pouco código entre a rota e o banco; dá para ler o `ON CONFLICT`, o `$gte` e o `WHERE status = ANY(...)` que fazem a idempotência.
**Perde:** sem migrations geradas nem mapeamento automático; cada serviço tem o seu `db.js`. Código como `erros.js` e `kafka.js` é copiado em cada serviço de propósito (nenhum serviço importa código de outro), e uma correção precisa ser repetida em todos.
