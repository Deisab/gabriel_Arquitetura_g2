# ADR-006: Consumers por perfil, não por pessoa

- **Status:** aceita
- **Quando:** aula 7

## Contexto

Os clientes se cadastram sozinhos, e o plugin `acl` decide pelo consumer. Criar um consumer por pessoa obrigaria o `usuarios` a chamar a Admin API do Kong a cada cadastro e o Kong a ter banco.

## Decisão

Dois consumers fixos, `cliente` e `admin`, cada um com uma credencial JWT de `key` igual ao perfil e o grupo acl do mesmo nome. O plugin `jwt` acha o consumer pelo campo `perfil` do token (`key_claim_name: perfil`, `claims_to_verify: [exp]`).

## Consequências

**Ganha:** milhares de usuários, dois consumers; o Kong continua sem banco e nada precisa ser sincronizado.
**Perde:** um perfil novo (ex.: estoquista) é uma mudança no `kong.yml`, não um cadastro. Mudar o perfil de alguém no banco só vale no próximo login: o token antigo segue valendo até vencer (por isso dura 2 h). Limites por pessoa no Kong ficam impossíveis (o consumer é o perfil).
