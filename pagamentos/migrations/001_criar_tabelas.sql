-- Um pagamento por pedido. pedido_id UNIQUE faz dois papéis:
--   1. idempotência: o mesmo estoque.reservado entregue duas vezes não cobra duas vezes;
--   2. cancelamento: um pedido cancelado antes da cobrança ocupa o pedido_id com CANCELADO,
--      e a cobrança que chegar depois é ignorada.
-- Sem FK para pedidos e usuários: moram em outros bancos.
CREATE TABLE pagamentos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        UUID NOT NULL UNIQUE,
  usuario_id       UUID NOT NULL,
  valor            NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  forma            TEXT,
  cartao_final     TEXT,                        -- só os 4 últimos dígitos
  status           TEXT NOT NULL CHECK (status IN (
                     'PENDENTE',          -- gravado antes de chamar o banco
                     'APROVADO',          -- o banco cobrou
                     'RECUSADO',          -- o banco disse não (402)
                     'ERRO',              -- o banco não respondeu: timeout, 503, circuito aberto
                     'CANCELADO',         -- o pedido foi cancelado antes da cobrança
                     'ESTORNADO',         -- cobrado e devolvido
                     'ESTORNO_PENDENTE'   -- o estorno falhou: fica gravado e é tentado de novo
                   )),
  tentativas       INT NOT NULL DEFAULT 0,
  codigo_transacao TEXT,                        -- o TX-... do banco
  motivo           TEXT,                        -- o suporte responde "por que foi cancelado?" sem abrir log
  cliente_email    TEXT,                        -- para os eventos (e e-mails) de um estorno tentado mais tarde
  correlation_id   TEXT,                        -- o X-Request-Id da compra, para os logs do estorno tentado mais tarde
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pagamentos_status ON pagamentos (status);
