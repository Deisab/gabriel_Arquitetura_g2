# ADR-005: Kong sem banco como API Gateway

- **Status:** aceita
- **Quando:** aula 7

## Contexto

Cada serviço tinha a sua porta, validava o token por conta própria e o catálogo deixava qualquer um criar produto. Toda porta publicada é uma porta para atacar.

## Decisão

Kong 3.9 em modo declarativo: toda a configuração em [`kong/kong.yml`](../../kong/kong.yml), versionado. A 8080 é a única porta da API. Três níveis de acesso por rota: público (nenhum plugin), logado (`jwt`, 401) e admin (`jwt` + `acl`, 403). Plugins globais `correlation-id`, `pre-function` (apaga `X-User-*` de fora) e `post-function` (injeta `X-User-*` do token); `rate-limiting` no login (10/min por IP).

## Consequências

**Ganha:** rotas, autenticação e perfis num arquivo revisável no Git; o token é validado num lugar só; os serviços nem conhecem JWT.
**Perde:** sem Admin API para mudar ao vivo (`docker compose restart gateway` a cada mudança). O gateway vira ponto único de falha: se ele cai, a loja some. Em produção, mais de uma réplica atrás de um balanceador. Copiar os campos do token para os cabeçalhos exigiu Lua (o Kong gratuito não tem plugin para isso).

## Relacionadas

- ADR-006
- ADR-007
