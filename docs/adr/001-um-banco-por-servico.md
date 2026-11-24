# ADR-001: Um banco por serviço, cada um do tipo que o dado pede

- **Status:** aceita
- **Quando:** aula 6

## Contexto

Cada serviço é dono dos seus dados e ninguém lê o banco do outro. Usuários têm estrutura fixa, e-mail único e vários endereços; produtos têm atributos diferentes por categoria (celular: memória e cor; livro: autor e páginas) e a vitrine é muito mais lida do que escrita; pedidos e pagamentos precisam de transação e de restrições (status válidos, um pagamento por pedido).

## Decisão

- `usuarios`: **Postgres** (`UNIQUE` no e-mail, `FK` endereço → usuário com `ON DELETE CASCADE`, `CHECK` no perfil).
- `catalogo`: **Mongo** (cada produto é um documento; os atributos livres ficam em `atributos`; as garantias ficam nos índices `sku` e `slug` únicos e `reservas.pedidoId` único).
- `pedidos` e `pagamentos`: **Postgres**, um banco para cada (transação no checkout, `CHECK` dos status, `pedido_id UNIQUE`).
- Nenhuma FK entre serviços: o pedido guarda `usuario_id` e `produto_id` sem FK, e quem garante que existem é o código, perguntando ao serviço dono.

## Consequências

**Ganha:** cada serviço evolui, escala e cai sozinho; o banco escolhido combina com o dado.
**Perde:** não há JOIN nem transação entre serviços. Consultar "pedidos com o nome do produto" exige copiar o dado (o pedido copia nome e preço, ADR-010) ou chamar outro serviço. Quatro bancos para operar em vez de um. A consistência entre eles é eventual e depende da saga (ADR-011).

## Relacionadas

- ADR-010
- ADR-011
