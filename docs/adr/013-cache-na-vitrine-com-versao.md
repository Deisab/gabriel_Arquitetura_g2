# ADR-013: Cache-aside no Redis só na vitrine, invalidado por versão

- **Status:** aceita
- **Quando:** aula 10

## Contexto

A vitrine é lida mil vezes para cada vez que um produto muda. Mas preço velho no checkout custa dinheiro, e carrinho, pedido e pagamento são de uma pessoa só e mudam a cada clique.

## Decisão

Redis sem persistência (`--save ""`, sem AOF) com cache-aside em `GET /produtos`, `GET /produtos/:id` e `GET /categorias`, TTL de 60 s. A chave leva uma versão (`catalogo:v<n>:...`); toda escrita de produto, categoria ou estoque (inclusive reserva e devolução por evento) faz `INCR catalogo:versao`. Cabeçalho `X-Cache: HIT | MISS | OFF`. Redis fora: vai direto ao Mongo (`OFF`) e o `/health` fica degradado. Não cacheamos o `?ids=` do checkout, o carrinho, pedidos nem pagamentos.

## Consequências

**Ganha:** a vitrine responde da memória; uma escrita invalida todas as listagens de uma vez, com um comando; o cache nunca tira o catálogo do ar.
**Perde:** se a invalidação falhar (Redis fora naquele instante), a vitrine pode mostrar o dado velho até o TTL vencer (60 s), mas o checkout sempre consulta o preço atual. Toda escrita esfria o cache inteiro, inclusive cada reserva de estoque.
