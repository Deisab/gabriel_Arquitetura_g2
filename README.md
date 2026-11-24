# E-commerce em microsserviços (G2)

Projeto da disciplina de Arquitetura de Sistemas. Cada aula acrescenta uma peça:

- **parte 1:** usuários e catálogo;
- **parte 2:** API Gateway (Kong) e pedidos (tag `aula-gateway-pedidos`);
- **parte 3: Kafka e eventos** (tag `aula-kafka`): o checkout vira evento, o catálogo reserva, as notificações avisam.

```
                 :8080 (a única porta da API)
Cliente ──JWT──> gateway (Kong, sem banco, kong/kong.yml)
                   │ valida o JWT, confere o perfil, injeta X-User-*, dá X-Request-Id
                   ├──> usuarios :3001 ── Postgres
                   ├──> catalogo :3002 ── Mongo
                   └──> pedidos  :3003 ── Postgres
                                 └──────> catalogo (direto, rede interna, timeout 3 s)

KAFKA (KRaft, tópicos pedidos · estoque, 3 partições cada)
  pedidos ──pedido.criado──> catalogo (reserva) ──estoque.reservado / estoque.insuficiente──> pedidos
                        └──> notificacoes ──> Mailpit (e-mails)  <── estoque.insuficiente
```

| Serviço    | O que faz                                   | Banco    | Porta |
|------------|---------------------------------------------|----------|-------|
| `gateway`  | Kong: rotas, JWT, perfis, rate limit, ids   | (nenhum) | **8080 no host** |
| `usuarios` | cadastro, login (emite o JWT) e endereços   | Postgres | 3001, só na rede interna |
| `catalogo` | produtos, categorias e estoque              | Mongo    | 3002, só na rede interna |
| `pedidos`  | carrinho e checkout; status por evento      | Postgres | 3003, só na rede interna |
| `notificacoes` | só escuta eventos e manda e-mail        | (nenhum) | 3004, só o /health, na rede interna |
| `kafka`    | broker de eventos (KRaft, sem ZooKeeper)    | (log)    | 9092, só na rede interna |
| `kafka-ui` | painel do Kafka: tópicos, mensagens, lag    | --       | **8090 no host** |
| `mailpit`  | servidor de e-mail de mentira               | --       | **8025 no host** |

Portas no host: só o gateway (8080, e 8001/8002 do painel em `127.0.0.1`), o Kafka UI (8090) e o Mailpit (8025). Serviços, bancos e o Kafka ficam na rede interna do compose.

## Como subir

Pré-requisito: Docker com Docker Compose.

```bash
docker compose up --build
```

Na primeira subida, cada serviço aplica as migrations e o seed sozinho. Para conferir, tudo pelo gateway:

- http://localhost:8080/health/usuarios
- http://localhost:8080/health/catalogo
- http://localhost:8080/health/pedidos

Para derrubar tudo e **apagar os dados** (o seed roda de novo na próxima subida):

```bash
docker compose down -v
```

Mudou o `kong/kong.yml`? Basta reiniciar o gateway:

```bash
docker compose restart gateway
```

Para ver a configuração carregada: Admin API em http://localhost:8001/routes e Kong Manager em http://localhost:8002. As duas só respondem nesta máquina (publicadas em `127.0.0.1`), e no modo sem banco a Admin API é só leitura.

### Variáveis de ambiente

| Variável              | Serviço            | Padrão no compose                 |
|-----------------------|--------------------|-----------------------------------|
| `JWT_SECRET`          | usuarios e gateway | `troque-este-segredo-em-producao` |
| `JWT_EXPIRES_IN`      | usuarios           | `2h`                              |
| `DATABASE_URL`        | usuarios, pedidos  | o Postgres de cada um no compose  |
| `MONGO_URL`           | catalogo           | Mongo do compose                  |
| `MONGO_DB`            | catalogo           | `catalogo`                        |
| `CATALOGO_URL`        | pedidos            | `http://catalogo:3002`            |
| `CATALOGO_TIMEOUT_MS` | pedidos            | `3000`                            |

Para usar outro segredo: crie um arquivo `.env` na raiz com `JWT_SECRET=...` (ele está no `.gitignore`). O mesmo valor vai para o `usuarios`, que assina, e para o gateway, que confere.

### Acessar os bancos

As portas dos bancos não são mais publicadas. Para entrar neles, use o próprio container:

```bash
docker compose exec usuarios-db psql -U usuarios
```

```bash
docker compose exec pedidos-db psql -U pedidos
```

```bash
docker compose exec catalogo-db mongosh catalogo
```

## Dados do seed

- `admin@loja.com` / `admin123` (perfil admin)
- `cliente@loja.com` / `cliente123` (perfil cliente, com um endereço)
- 3 categorias (`celulares`, `roupas`, `livros`) e 14 produtos, cada categoria com atributos diferentes (um deles desativado).

O seed é idempotente: rodar de novo não duplica nada nem sobrescreve o que foi alterado pela API.

## Testando a API

Não há front. As requisições ficam em [`http/`](http/), uma por serviço, **todas pelo gateway** (`http://localhost:8080`):

- [`http/usuarios.http`](http/usuarios.http): login, cadastro, `/me`, rate limit do login, tentativas de se passar por admin
- [`http/catalogo.http`](http/catalogo.http): vitrine pública e gestão de admin (401 sem token, 403 cliente)
- [`http/pedidos.http`](http/pedidos.http): login → carrinho → checkout (202) → consultar o pedido; carrinho vazio, sem estoque, pedido de outro usuário, catálogo fora

No VS Code, instale a extensão **REST Client** e clique em **Send Request** acima de cada requisição. Rode na ordem: os logins guardam o token (`# @name login`) e as próximas requisições o reaproveitam.

## Eventos (Kafka)

O checkout não espera mais ninguém além do preço: grava o pedido em `AGUARDANDO_ESTOQUE`, publica `pedido.criado` **depois do COMMIT** e responde 202. Cada interessado reage (coreografia):

| Evento                 | Tópico    | Publica   | Consome                  | dados |
|------------------------|-----------|-----------|--------------------------|-------|
| `pedido.criado`        | `pedidos` | pedidos   | catalogo, notificacoes   | usuarioId, clienteEmail, itens, valorTotal, formaPagamento, cartaoFinal |
| `estoque.reservado`    | `estoque` | catalogo  | pedidos                  | usuarioId, clienteEmail, itens, valorTotal, formaPagamento, cartaoFinal |
| `estoque.insuficiente` | `estoque` | catalogo  | pedidos, notificacoes    | motivo, usuarioId, clienteEmail |

- **Envelope** igual em todos ([`kafka.js`](pedidos/src/kafka.js), copiado em cada serviço): `{ id, tipo, pedidoId, ocorridoEm, correlationId, dados }`.
- **Chave** de toda mensagem = id do pedido: os eventos de um pedido caem na mesma partição, em ordem.
- **correlationId** = o `X-Request-Id` do Kong. Segue de evento em evento e aparece em toda linha de log (`req=...`).
- **Tópicos** `pedidos`, `estoque` e `pagamentos`, com 3 partições, criados por quem sobe primeiro (`listTopics` + `createTopics`).
- **Consumer groups**: um por serviço (`pedidos`, `catalogo`, `notificacoes`). Réplicas do mesmo serviço dividem as partições.
- **Pelo menos uma vez**: o offset é confirmado depois do handler. Todo handler é idempotente:
  - catálogo: `reservas.pedidoId` é único; o mesmo `pedido.criado` não reserva duas vezes;
  - pedidos: filtro de estado (`estoque.reservado` só muda o pedido se ele ainda está em `AGUARDANDO_ESTOQUE`).
- **Reserva tudo ou nada**: `updateOne` com `estoque.disponivel: { $gte: quantidade }` (dois pedidos ao mesmo tempo não deixam o estoque negativo). Faltou um item: devolve os que já tirou e publica `estoque.insuficiente`. Reservado não é vendido: `disponivel` diminui e `reservado` aumenta.
- **E-mails** (Mailpit, http://localhost:8025): "Recebemos o seu pedido" (`pedido.criado`) e "cancelado: sem estoque" (`estoque.insuficiente`).

O status do pedido:

```
AGUARDANDO_ESTOQUE ──estoque.reservado──> AGUARDANDO_PAGAMENTO ──(pagamento: próxima aula)──> PAGO
        └──────────estoque.insuficiente──> CANCELADO (com o motivo)
```

Para seguir uma compra pelos logs:

```bash
docker compose logs -t --no-log-prefix | grep <X-Request-Id da resposta do checkout> | sort
```

## O gateway (Kong)

Kong sem banco: toda a configuração está em [`kong/kong.yml`](kong/kong.yml), versionado. Ao subir, o container troca `__JWT_SECRET__` pelo segredo e carrega o arquivo.

| Peça      | No kong.yml |
|-----------|-------------|
| services  | `usuarios`, `catalogo`, `pedidos` (e um service de health para cada) |
| routes    | uma por grupo de caminhos e métodos, com a tag `publico`, `logado` ou `admin` |
| consumers | `cliente` e `admin`: são **perfis, não pessoas**. Cada um tem uma credencial JWT com `key` igual ao perfil e o grupo acl do mesmo nome |
| plugins   | globais: `correlation-id`, `pre-function`, `post-function`; nas rotas: `jwt`, `acl`, `rate-limiting` |

Os três níveis de acesso:

- **publico:** nenhum plugin de acesso.
- **logado:** `jwt` (`key_claim_name: perfil`, `claims_to_verify: [exp]`). Sem token, token falso ou vencido: **401**.
- **admin:** `jwt` + `acl` com `allow: [admin]`. Sem token: **401**; token de cliente: **403**.

O caminho de uma requisição no Kong:

1. `correlation-id` dá um `X-Request-Id` (ou mantém o do cliente) e o devolve na resposta.
2. `pre-function` apaga `X-User-Id`, `X-User-Email` e `X-User-Role` que vieram de fora: ninguém escolhe quem é.
3. A route é escolhida pelo método e pelo caminho (nenhuma casou: 404 do próprio Kong).
4. `jwt` lê o token, acha o consumer pelo campo `perfil` e confere assinatura e `exp` (401).
5. `acl` confere o grupo do consumer nas rotas de admin (403).
6. `post-function` copia `sub`, `email` e `perfil` do token para `X-User-Id`, `X-User-Email` e `X-User-Role`.
7. O Kong encaminha para o serviço, que só lê os `X-User-*` (e loga o `X-Request-Id` em cada requisição).

No login, o `rate-limiting` aceita **10 tentativas por minuto por IP**; a 11ª recebe 429.

O JWT é emitido **só** pelo `usuarios`, no login: HS256, `{ sub, email, perfil, iss: "usuarios", iat, exp }`, com o perfil lido do banco e validade de 2 h.

## Rotas (todas em `http://localhost:8080`)

### usuarios

| Método | Rota                          | Acesso  | No Kong                       | Retornos |
|--------|-------------------------------|---------|-------------------------------|----------|
| POST   | `/auth/login`                 | público | rate-limiting (10/min por IP) | 200 `{ token, usuario }` · 400 · 401 · 429 |
| POST   | `/usuarios`                   | público | --                            | 201 · 400 · 409 |
| GET    | `/usuarios/me`                | logado  | jwt                           | 200 · 401 |
| PUT    | `/usuarios/me`                | logado  | jwt                           | 200 · 400 · 401 · 409 |
| GET    | `/usuarios/me/enderecos`      | logado  | jwt                           | 200 · 401 |
| POST   | `/usuarios/me/enderecos`      | logado  | jwt                           | 201 · 400 · 401 |
| DELETE | `/usuarios/me/enderecos/:id`  | logado  | jwt                           | 204 · 401 · 404 (não existe ou não é seu) |
| GET    | `/usuarios`                   | admin   | jwt + acl allow [admin]       | 200 · 401 · 403 |
| GET    | `/health/usuarios`            | público | --                            | 200 · 503 |

Na parte 1, o próprio serviço validava o token nas rotas `/me`. Agora quem valida é o Kong; o serviço só lê `X-User-Id`. O 404 do endereço continua sendo do serviço: o Kong sabe quem você é, mas não sabe de quem é cada endereço.

### catalogo

| Método | Rota                          | Acesso  | No Kong                 | Retornos |
|--------|-------------------------------|---------|-------------------------|----------|
| GET    | `/produtos?categoria=&busca=` | público | --                      | 200 (só ativos) |
| GET    | `/produtos?ids=a,b,c`         | público | --                      | 200 (esses produtos, ativos ou não; usado pelo checkout) |
| GET    | `/produtos/:id`               | público | --                      | 200 · 404 |
| GET    | `/categorias`                 | público | --                      | 200 |
| POST   | `/produtos`                   | admin   | jwt + acl allow [admin] | 201 · 400 · 401 · 403 · 409 |
| PUT    | `/produtos/:id`               | admin   | jwt + acl allow [admin] | 200 · 400 · 401 · 403 · 404 · 409 |
| PATCH  | `/produtos/:id/estoque`       | admin   | jwt + acl allow [admin] | 200 · 400 · 401 · 403 · 404 |
| DELETE | `/produtos/:id`               | admin   | jwt + acl allow [admin] | 204 · 401 · 403 · 404 |
| POST   | `/categorias`                 | admin   | jwt + acl allow [admin] | 201 · 400 · 401 · 403 · 409 |
| GET    | `/health/catalogo`            | público | --                      | 200 · 503 |

Acabou o catálogo aberto: cliente logado recebe 403 e quem não tem token recebe 401. Mesmo caminho, métodos diferentes: `GET /produtos` é público e `POST /produtos` é admin, por isso são duas routes no `kong.yml`. O catálogo ainda confere `X-User-Role` nas rotas de admin, como segunda linha de defesa.

`PATCH /produtos/:id/estoque` aceita **um** dos dois corpos:

- `{ "disponivel": 15 }`: define o valor.
- `{ "ajuste": -3 }`: soma ou subtrai. A checagem de "não pode ficar negativo" vai no próprio update do Mongo, então é atômica.

### pedidos

| Método | Rota                          | Acesso  | Retornos |
|--------|-------------------------------|---------|----------|
| GET    | `/carrinho`                   | logado  | 200 `{ itens, total }` com preços atuais do catálogo (catálogo fora: 200 sem preços, com `aviso`) |
| POST   | `/carrinho/itens`             | logado  | 201 item adicionado · 400 quantidade inválida · 404 produto não existe · 503 catálogo fora |
| DELETE | `/carrinho/itens/:produtoId`  | logado  | 204 removido · 404 não está no carrinho |
| POST   | `/pedidos`                    | logado  | 202 pedido aceito · 400 dados inválidos ou carrinho vazio · 409 produto não existe ou desativado · 503 catálogo fora |
| GET    | `/pedidos`                    | logado  | 200 meus pedidos |
| GET    | `/pedidos/:id`                | logado  | 200 pedido com itens · 404 não existe ou não é meu |
| POST   | `/pedidos/:id/cancelar`       | logado  | 200 cancelado · 404 · 409 status não permite |
| GET    | `/health/pedidos`             | público | 200 · 503 |

No Kong, todas as rotas de `/carrinho` e `/pedidos` são uma route só, com `jwt`.

Corpo do `POST /carrinho/itens`: `{ "produtoId": "<id do catálogo>", "quantidade": 2 }` (quantidade de 1 a 99; adicionar o mesmo produto de novo soma; `produto_id` também é aceito).

Corpo do checkout (`POST /pedidos`):

```json
{
  "enderecoEntrega": { "cep": "97010-000", "logradouro": "Rua do Acampamento", "numero": "100", "cidade": "Santa Maria", "uf": "RS" },
  "formaPagamento": "cartao",
  "cartao": { "numero": "4111 1111 1111 1111" }
}
```

`formaPagamento`: `cartao`, `pix` ou `boleto`. Do cartão, só os 4 últimos dígitos são gravados (e só eles vão no evento). Os nomes em snake_case (`endereco_entrega`, `forma_pagamento`) também são aceitos.

O pedido nasce em `AGUARDANDO_ESTOQUE` (202 e não 201: foi aceito, mas ainda não terminou) e anda sozinho pelos eventos (seção **Eventos**). O estoque não é decidido no checkout: quem decide é a reserva no catálogo. Sem estoque, o checkout ainda responde 202 e o pedido vira `CANCELADO` com o `motivo`. Cancelar só é possível em `AGUARDANDO_ESTOQUE` ou `AGUARDANDO_PAGAMENTO`.

### Formato de erro (todos os serviços)

```json
{ "erro": "Dados inválidos.", "detalhes": ["preco deve ser maior que zero", "sku é obrigatório"] }
```

`detalhes` só aparece em erros de validação. Stack trace, mensagem do banco e `senha_hash` nunca saem do serviço. Os 401, 403, 429 e o 404 de rota inexistente vêm do gateway, no formato do Kong: `{ "message": "..." }`.

## Estrutura

```
.
├── docker-compose.yml
├── README.md
├── kong/
│   └── kong.yml            # gateway declarativo: services, routes, consumers, plugins
├── http/                   # requisições para o REST Client, todas pelo gateway
├── usuarios/
│   ├── migrations/         # .sql aplicados em ordem, controlados em schema_migrations
│   ├── seeds/
│   └── src/
├── catalogo/
│   ├── seeds/
│   └── src/
├── pedidos/
│   ├── migrations/         # carrinho_itens, pedidos, itens_pedido; 002: motivo
│   └── src/
│       ├── catalogo.js     # cliente HTTP do catálogo (timeout de 3 s)
│       ├── eventos.js      # reações a estoque.* (filtro de estado)
│       ├── identidade.js   # lê X-User-* do gateway
│       └── kafka.js        # envelope, publicar, consumir (igual em todos os serviços)
└── notificacoes/           # sem banco, sem rota no Kong: escuta e manda e-mail
    └── src/
```

O catálogo ganhou `src/estoque.js` (reserva) e a coleção `reservas`.

Cada serviço é independente: tem o próprio `package.json`, `Dockerfile` e banco, e nenhum importa código do outro. Por isso `erros.js` aparece duplicado nos serviços, e é de propósito.

## Decisões (ADRs)

### ADR-001: Postgres no serviço de usuários

**Contexto.** Usuário tem estrutura fixa (nome, e-mail, senha, perfil), o e-mail não pode repetir e cada pessoa tem vários endereços.
**Decisão.** Postgres.
**Consequência.** O próprio banco garante `UNIQUE` no e-mail, a `FK` endereço → usuário e o `CHECK` do perfil. A validação no serviço dá mensagens melhores, e o banco é a última linha de defesa.

### ADR-002: Mongo no serviço de catálogo

**Contexto.** Cada categoria tem atributos diferentes (celular: memória e cor; camiseta: tamanho e tecido; livro: autor e páginas), e a vitrine é muito mais lida do que escrita.
**Decisão.** Mongo, com cada produto como um documento e os atributos livres em `atributos`.
**Consequência.** Não há uma coluna por atributo possível. Sem schema, as garantias ficam nos índices (`sku` único, `slug` único) e na validação do serviço.

### ADR-003: Node.js + Express

**Decisão.** Node 22 e Express 5, com os drivers oficiais `pg` e `mongodb`, sem ORM.
**Motivo.** Pouco código entre a rota e o banco, o que deixa visível o que cada banco garante. O Express 5 já repassa erros de handlers `async` para o middleware de erro.

### ADR-004: migrations e seed na subida do serviço

**Decisão.** Ao iniciar, cada serviço espera o banco, aplica migrations pendentes (usuarios e pedidos) e cria índices (catalogo), depois roda o seed idempotente.
**Consequência.** `docker compose up` é o único comando necessário. Com réplicas será preciso mover as migrations para um passo separado.

### ADR-005: DELETE de produto desativa em vez de apagar

**Decisão.** `DELETE /produtos/:id` faz `ativo = false`.
**Motivo.** Pedidos referenciam produtos; apagar quebraria o histórico. `GET /produtos` lista só ativos, e `GET /produtos/:id` ainda devolve o produto desativado, com `ativo: false`.

### ADR-006: Kong sem banco como API Gateway

**Contexto.** Cada serviço tinha a sua porta, validava o token por conta própria e o catálogo deixava qualquer um criar produto.
**Decisão.** Kong 3.9 em modo declarativo (sem banco), com toda a configuração em `kong/kong.yml`, versionado. A 8080 é a única porta da API.
**Consequência.** Rotas, autenticação e perfis ficam num arquivo revisável no Git; mudar o gateway é `docker compose restart gateway`. O gateway vira ponto único de falha: em produção, rodaria com mais de uma réplica atrás de um balanceador.

### ADR-007: consumers por perfil, não por pessoa

**Contexto.** Os clientes se cadastram sozinhos, e o `acl` do Kong decide pelo consumer.
**Decisão.** Dois consumers fixos, `cliente` e `admin`, cada um com uma credencial JWT de `key` igual ao perfil e o grupo acl do mesmo nome. O plugin `jwt` acha o consumer pelo campo `perfil` do token (`key_claim_name: perfil`).
**Consequência.** O `usuarios` não precisa chamar a Admin API a cada cadastro e o Kong não precisa de banco. Perfil novo (ex.: estoquista) é um consumer e um grupo novos no `kong.yml`: decisão de arquitetura, não cadastro. Perfil alterado no banco só vale no próximo login, por isso o token dura só 2 h.

### ADR-008: identidade por X-User-*, emitida só pelo usuarios

**Decisão.** Só o `usuarios` emite JWT (HS256, perfil lido do banco). O gateway valida e repassa `X-User-Id`, `X-User-Email` e `X-User-Role`; os serviços não validam token, só leem os cabeçalhos. O `pre-function` apaga os `X-User-*` vindos de fora antes de tudo.
**Consequência.** Os serviços não precisam conhecer o segredo nem a biblioteca de JWT. Essa confiança só é segura porque **nenhum serviço publica porta**: quem publicasse a 3003 "para testar" deixaria qualquer um mandar o `X-User-Id` de outra pessoa. O gateway decide a porta (401/403); o serviço decide o recurso ("este pedido é seu?" → 404, que não confirma que o pedido existe).

### ADR-009: pedidos chama o catálogo direto, com timeout

**Contexto.** No checkout o pedidos precisa do preço e do estoque atuais de cada produto.
**Decisão.** Chamada HTTP síncrona `GET http://catalogo:3002/produtos?ids=a,b,c` pela rede interna, sem passar pelo gateway, uma só para o carrinho inteiro, com timeout de 3 s e repassando o `X-Request-Id`.
**Consequência.** Acoplamento temporal: com o catálogo fora ou lento, o checkout responde 503 em até 3 s em vez de travar. Carrinho e lista de pedidos continuam funcionando. Desde a aula de Kafka, só o preço é síncrono; a reserva do estoque é por evento (ADR-011).

### ADR-010: o pedido copia preço, nome e endereço

**Decisão.** `itens_pedido` guarda `nome_produto` e `preco_unitario`; `pedidos` guarda `endereco_entrega` (JSONB) e só os 4 últimos dígitos do cartão. Não há FK para usuários nem produtos: eles moram em outros bancos.
**Consequência.** Se o produto mudar de preço amanhã, o pedido de hoje não muda: não é duplicação, é histórico. Quem garante que o produto existe é o código, perguntando ao catálogo.

### ADR-011: Kafka e coreografia para o que pode esperar

**Contexto.** Checkout que chama catálogo, pagamento e e-mail em corrente: cada serviço a mais multiplica a chance de falhar e soma latência.
**Decisão.** Kafka (um broker KRaft) com eventos no passado (`pedido.criado`, `estoque.reservado`), chave = id do pedido, um consumer group por serviço e coreografia: ninguém manda, cada um reage. O preço continua síncrono, porque precisa ser o de agora.
**Consequência.** Catálogo ou notificações fora do ar não impedem a venda: os eventos esperam no tópico. Em troca: consistência eventual (o pedido fica alguns instantes em `AGUARDANDO_ESTOQUE`), entrega pelo menos uma vez (todo handler idempotente) e o fluxo inteiro só aparece somando os serviços.

## Limitações conhecidas

- **Escrita dupla:** o pedido é gravado e o evento publicado depois do COMMIT. Se o Kafka cair entre os dois, o pedido fica parado em `AGUARDANDO_ESTOQUE`. A solução é o padrão Outbox (gravar o evento numa tabela na mesma transação e publicar depois), que não foi feito.
- **Sem DLQ:** um handler que falha é tentado 5 vezes com espera crescente; depois disso o erro é logado e o offset avança. Um tópico de erros (DLQ) para reprocessar fica para depois.
- **Um broker só, fator 1:** ótimo para aprender, inaceitável em produção.
- **E-mail repetido:** como a entrega é pelo menos uma vez, um evento reprocessado pode mandar o mesmo e-mail duas vezes.
