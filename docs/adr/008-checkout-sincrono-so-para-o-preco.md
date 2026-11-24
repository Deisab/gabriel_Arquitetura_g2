# ADR-008: Checkout consulta o catálogo de forma síncrona só para o preço, com timeout

- **Status:** aceita
- **Quando:** aulas 7 e 8

## Contexto

No checkout o preço precisa ser o de agora; o resto (reservar, cobrar, avisar) pode acontecer daqui a pouco.

## Decisão

`pedidos` chama `GET http://catalogo:3002/produtos?ids=a,b,c` pela rede interna (sem passar pelo gateway), uma vez para o carrinho inteiro, com timeout de 3 s e repassando o `X-Request-Id`. Sem retry: o cliente está esperando. O estoque não é decidido aqui: a reserva acontece no catálogo, por evento. Esse `?ids=` não passa pelo cache.

## Consequências

**Ganha:** o preço é sempre o atual; catálogo lento não trava o checkout por mais de 3 s.
**Perde:** acoplamento temporal: com o catálogo fora, o checkout responde 503 (o carrinho e a lista de pedidos continuam). Um produto pode estar à venda no checkout e faltar na reserva logo depois: o pedido é aceito (202) e cancelado com o motivo.

## Relacionadas

- ADR-009
