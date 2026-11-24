# ADR-003: Migrations, seed e tópicos criados na subida

- **Status:** aceita
- **Quando:** aulas 6, 8 e 10

## Contexto

Requisito nº 1: num clone novo, `docker compose up -d --build` tem que colocar tudo no ar com dados, sem passo manual.

## Decisão

Ao iniciar, cada serviço espera as suas dependências (Postgres, Mongo, Kafka) com novas tentativas, aplica as migrations pendentes (controladas em `schema_migrations`), cria os índices e roda o seed idempotente. O primeiro serviço que conecta no Kafka cria os tópicos (`listTopics` + `createTopics`). O compose usa `depends_on` com `condition: service_healthy` e todas as variáveis têm valor padrão (nenhum `.env` obrigatório).

## Consequências

**Ganha:** um comando sobe tudo; subir duas vezes não duplica nada.
**Perde:** com várias réplicas do mesmo serviço, todas tentariam migrar ao mesmo tempo; em produção as migrations iriam para um passo separado (um job antes do deploy). O seed não sobrescreve dados alterados pela API, então "voltar ao seed" exige `docker compose down -v`.
