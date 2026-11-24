# Decisões de arquitetura (ADRs)

Cada arquivo: contexto, decisão e consequências (o que se ganha e o que se perde).

| ADR | Decisão | Aula |
|-----|---------|------|
| [001](001-um-banco-por-servico.md) | Um banco por serviço, cada um do tipo que o dado pede | aula 6 |
| [002](002-node-express-sem-orm.md) | Node.js + Express, sem ORM | aula 6 |
| [003](003-migrations-e-seed-na-subida.md) | Migrations, seed e tópicos criados na subida | aulas 6, 8 e 10 |
| [004](004-delete-de-produto-desativa.md) | DELETE de produto desativa em vez de apagar | aula 6 |
| [005](005-kong-sem-banco.md) | Kong sem banco como API Gateway | aula 7 |
| [006](006-consumers-por-perfil.md) | Consumers por perfil, não por pessoa | aula 7 |
| [007](007-identidade-por-x-user.md) | Identidade por X-User-*, emitida só pelo usuarios | aula 7 |
| [008](008-checkout-sincrono-so-para-o-preco.md) | Checkout consulta o catálogo de forma síncrona só para o preço, com timeout | aulas 7 e 8 |
| [009](009-kafka-e-coreografia.md) | Kafka e coreografia para o que pode esperar | aula 8 |
| [010](010-pedido-copia-preco-e-endereco.md) | O pedido copia preço, nome e endereço | aula 7 |
| [011](011-saga-por-coreografia-cancelar-quando-o-banco-cai.md) | Saga por coreografia; cancelar quando o banco do cartão cai | aula 9 |
| [012](012-resiliencia-no-pagamentos.md) | Timeout, retry e circuit breaker só no pagamentos → banco | aula 9 |
| [013](013-cache-na-vitrine-com-versao.md) | Cache-aside no Redis só na vitrine, invalidado por versão | aula 10 |
| [014](014-health-com-tres-estados.md) | Health com três estados e healthcheck no compose | aula 10 |
