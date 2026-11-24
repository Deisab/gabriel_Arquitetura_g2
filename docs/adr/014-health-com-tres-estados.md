# ADR-014: Health com três estados e healthcheck no compose

- **Status:** aceita
- **Quando:** aula 10

## Contexto

"O processo respondeu" não diz nada sobre as dependências. E um health que derruba o serviço por causa de uma dependência que só acelera tira a loja do ar à toa.

## Decisão

Todo serviço tem `GET /health` → `{ servico, status, dependencias }`, testando de verdade (`SELECT 1`, uma pergunta ao Kafka, `PING` no Redis, `verify` no SMTP), com prazo curto. `ok` e `degradado` → 200; `fora do ar` → 503 só quando falta o essencial (banco ou Kafka). Cache fora, circuito do banco aberto ou SMTP fora = degradado. O `/health` não chama outros serviços. No compose, cada serviço tem `healthcheck` com `wget` (10 s, 3 tentativas, `start_period`) e o gateway só sobe com os serviços healthy.

## Consequências

**Ganha:** `docker compose ps` mostra quem está doente; quando o `up -d` termina, a loja já vende; o painel distingue "pior" de "parado".
**Perde:** um health só, sem separar liveness de readiness. O Docker só marca `unhealthy`, não reinicia (o `restart: unless-stopped` cobre só o processo que morre); quem agiria é um orquestrador.
