-- Sem FK para usuarios e produtos: eles moram em outros bancos.
-- Quem garante que existem é o código, perguntando ao serviço dono.

CREATE TABLE carrinho_itens (
  usuario_id    UUID NOT NULL,                -- sem FK: o usuário mora no banco de usuarios
  produto_id    TEXT NOT NULL,                -- id do Mongo do catálogo
  quantidade    INT  NOT NULL CHECK (quantidade > 0),
  adicionado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, produto_id)        -- o mesmo produto não aparece duas vezes no carrinho
);

-- O status já nasce com os 4 estados. Quem faz o pedido andar entre eles é o Kafka, nas próximas aulas.
CREATE TABLE pedidos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id       UUID NOT NULL,
  cliente_email    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'AGUARDANDO_ESTOQUE'
                   CHECK (status IN ('AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO', 'PAGO', 'CANCELADO')),
  valor_total      NUMERIC(12,2) NOT NULL CHECK (valor_total >= 0),
  endereco_entrega JSONB NOT NULL,            -- cópia do endereço: o pedido não muda se o endereço mudar
  forma_pagamento  TEXT NOT NULL CHECK (forma_pagamento IN ('cartao', 'pix', 'boleto')),
  cartao_final     TEXT CHECK (cartao_final ~ '^[0-9]{4}$'), -- só os 4 últimos dígitos, nunca o número
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preço e nome copiados: se o produto mudar de preço amanhã, o pedido de hoje não muda. É histórico.
CREATE TABLE itens_pedido (
  pedido_id      UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE, -- FK: mesmo banco
  produto_id     TEXT NOT NULL,
  nome_produto   TEXT NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL CHECK (preco_unitario > 0),
  quantidade     INT NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (pedido_id, produto_id)
);

-- toda consulta de pedido filtra pelo dono
CREATE INDEX idx_pedidos_usuario_id ON pedidos (usuario_id, criado_em DESC);
