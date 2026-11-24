-- Aula de Kafka: o status passa a mudar por evento. Quando vira CANCELADO, o motivo fica gravado
-- (estoque insuficiente, pagamento recusado, cancelado pelo cliente): o suporte responde sem abrir log.
ALTER TABLE pedidos ADD COLUMN motivo TEXT;
ALTER TABLE pedidos ADD COLUMN atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now();
