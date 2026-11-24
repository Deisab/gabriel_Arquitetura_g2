# ADR-007: Identidade por X-User-*, emitida só pelo usuarios

- **Status:** aceita
- **Quando:** aula 7

## Contexto

Os serviços precisam saber quem está chamando, mas não devem guardar o segredo do JWT nem repetir a validação.

## Decisão

Só o `usuarios` emite JWT (HS256, `{ sub, email, perfil, iss, exp }`, 2 h, perfil lido do banco). O Kong valida e repassa `X-User-Id`, `X-User-Email` e `X-User-Role`; os serviços só leem os cabeçalhos. O gateway decide a porta (401/403); o serviço decide o recurso ("este pedido é seu?" → 404, que não confirma que o pedido existe).

## Consequências

**Ganha:** o segredo fica em dois lugares (quem assina e quem confere); trocar de linguagem num serviço não exige biblioteca de JWT.
**Perde:** a confiança nos cabeçalhos só é segura porque **nenhum serviço publica porta**: quem publicasse a 3003 "para testar" deixaria qualquer um mandar o `X-User-Id` de outra pessoa. Se a rede interna não for confiável, seria preciso mTLS (service mesh), fora do escopo.
