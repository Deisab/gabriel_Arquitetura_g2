# E-commerce em microsserviços (G2)

Projeto da disciplina de Arquitetura de Sistemas. Cada aula acrescenta uma peça; esta é a **parte 1: usuários e catálogo**.

| Serviço    | O que faz                          | Banco    | Porta |
|------------|------------------------------------|----------|-------|
| `usuarios` | cadastro, login (JWT) e endereços  | Postgres | 3001  |
| `catalogo` | produtos, categorias e estoque     | Mongo    | 3002  |

## Como subir

Pré-requisito: Docker com Docker Compose.

```bash
docker compose up --build
```

Na primeira subida, cada serviço aplica as migrations e o seed sozinho. Para conferir:

- http://localhost:3001/health
- http://localhost:3002/health

Para derrubar tudo e **apagar os dados** (o seed roda de novo na próxima subida):

```bash
docker compose down -v
```

### Variáveis de ambiente

| Variável         | Serviço    | Padrão no compose                    |
|------------------|------------|--------------------------------------|
| `JWT_SECRET`     | usuarios   | `troque-este-segredo-em-producao`    |
| `JWT_EXPIRES_IN` | usuarios   | `1h`                                 |
| `DATABASE_URL`   | usuarios   | Postgres do compose                  |
| `MONGO_URL`      | catalogo   | Mongo do compose                     |
| `MONGO_DB`       | catalogo   | `catalogo`                           |

Para usar outro segredo: crie um arquivo `.env` na raiz com `JWT_SECRET=...` (ele está no `.gitignore`).

### Acessar os bancos pelo host

- Postgres: `localhost:5433`, usuário/senha/banco `usuarios`
- Mongo: `mongodb://localhost:27018`, banco `catalogo`

As portas no host são 5433 e 27018 para não conflitar com um Postgres ou Mongo instalado na máquina.

## Dados do seed

- `admin@loja.com` / `admin123` (perfil admin)
- `cliente@loja.com` / `cliente123` (perfil cliente, com um endereço)
- 3 categorias (`celulares`, `roupas`, `livros`) e 14 produtos, cada categoria com atributos diferentes (um deles desativado).

O seed é idempotente: rodar de novo não duplica nada nem sobrescreve o que foi alterado pela API.

## Testando a API

Não há front. As requisições ficam em [`http/`](http/), uma por serviço:

- [`http/usuarios.http`](http/usuarios.http)
- [`http/catalogo.http`](http/catalogo.http)

No VS Code, instale a extensão **REST Client** e clique em **Send Request** acima de cada requisição. Rode na ordem: os logins guardam o token (`# @name login`) e as próximas requisições o reaproveitam.

## Rotas

### usuarios (`:3001`)

| Método | Rota                          | Acesso  | Retornos |
|--------|-------------------------------|---------|----------|
| POST   | `/auth/login`                 | público | 200 `{ token, usuario }` · 400 · 401 |
| POST   | `/usuarios`                   | público | 201 · 400 · 409 |
| GET    | `/usuarios/me`                | logado  | 200 · 401 |
| PUT    | `/usuarios/me`                | logado  | 200 · 400 · 401 · 409 |
| GET    | `/usuarios/me/enderecos`      | logado  | 200 · 401 |
| POST   | `/usuarios/me/enderecos`      | logado  | 201 · 400 · 401 |
| DELETE | `/usuarios/me/enderecos/:id`  | logado  | 204 · 401 · 404 |
| GET    | `/usuarios`                   | admin   | 200 · 401 · 403 |
| GET    | `/health`                     | público | 200 · 503 |

O token é um JWT (HS256) com `id`, `email` e `perfil`, enviado como `Authorization: Bearer <token>`.

### catalogo (`:3002`)

| Método | Rota                            | Acesso  | Retornos |
|--------|---------------------------------|---------|----------|
| GET    | `/produtos?categoria=&busca=`   | público | 200 (só ativos) |
| GET    | `/produtos/:id`                 | público | 200 · 404 |
| POST   | `/produtos`                     | admin*  | 201 · 400 · 409 |
| PUT    | `/produtos/:id`                 | admin*  | 200 · 400 · 404 · 409 |
| PATCH  | `/produtos/:id/estoque`         | admin*  | 200 · 400 · 404 |
| DELETE | `/produtos/:id`                 | admin*  | 204 · 404 |
| GET    | `/categorias`                   | público | 200 |
| POST   | `/categorias`                   | admin*  | 201 · 400 · 409 |
| GET    | `/health`                       | público | 200 · 503 |

\* Por enquanto abertas; o gateway passa a exigir o token de admin na próxima aula.

`PATCH /produtos/:id/estoque` aceita **um** dos dois corpos:

- `{ "disponivel": 15 }`: define o valor.
- `{ "ajuste": -3 }`: soma ou subtrai. A checagem de "não pode ficar negativo" vai no próprio update do Mongo, então é atômica.

### Formato de erro (os dois serviços)

```json
{ "erro": "Dados inválidos.", "detalhes": ["preco deve ser maior que zero", "sku é obrigatório"] }
```

`detalhes` só aparece em erros de validação. Stack trace, mensagem do banco e `senha_hash` nunca saem do serviço.

## Estrutura

```
ecommerce/
├── docker-compose.yml
├── README.md
├── http/                   # requisições para o REST Client
├── usuarios/
│   ├── Dockerfile
│   ├── package.json
│   ├── migrations/         # .sql aplicados em ordem, controlados em schema_migrations
│   ├── seeds/
│   └── src/
└── catalogo/
    ├── Dockerfile
    ├── package.json
    ├── seeds/
    └── src/
```

Cada serviço é independente: tem o próprio `package.json`, `Dockerfile` e banco, e nenhum importa código do outro. Por isso `erros.js` aparece duplicado nos dois serviços, e é de propósito.

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

**Decisão.** Ao iniciar, cada serviço espera o banco, aplica migrations pendentes (usuarios) e cria índices (catalogo), depois roda o seed idempotente.
**Consequência.** `docker compose up` é o único comando necessário. Com réplicas (aula 6) será preciso mover as migrations para um passo separado.

### ADR-005: DELETE de produto desativa em vez de apagar

**Decisão.** `DELETE /produtos/:id` faz `ativo = false`.
**Motivo.** Pedidos (próximas aulas) vão referenciar produtos; apagar quebraria o histórico. `GET /produtos` lista só ativos, e `GET /produtos/:id` ainda devolve o produto desativado, com `ativo: false`.
