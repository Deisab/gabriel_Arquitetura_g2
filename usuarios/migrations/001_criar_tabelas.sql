CREATE TABLE usuarios (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,          -- não repete
  senha_hash TEXT NOT NULL,                 -- bcrypt, nunca a senha
  perfil     TEXT NOT NULL DEFAULT 'cliente' CHECK (perfil IN ('cliente','admin')),
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enderecos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  apelido     TEXT,
  cep         TEXT NOT NULL,
  logradouro  TEXT NOT NULL,
  numero      TEXT,
  complemento TEXT,
  cidade      TEXT NOT NULL,
  uf          CHAR(2) NOT NULL,
  principal   BOOLEAN NOT NULL DEFAULT false
);

-- toda consulta de endereço filtra pelo dono
CREATE INDEX idx_enderecos_usuario_id ON enderecos (usuario_id);
