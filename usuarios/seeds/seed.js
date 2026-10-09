const bcrypt = require('bcryptjs');

const USUARIOS = [
  { nome: 'Administrador', email: 'admin@loja.com', senha: 'admin123', perfil: 'admin' },
  { nome: 'Cliente Exemplo', email: 'cliente@loja.com', senha: 'cliente123', perfil: 'cliente' },
];

// Idempotente: rodar duas vezes não duplica nada.
async function seed(pool) {
  for (const u of USUARIOS) {
    const senhaHash = await bcrypt.hash(u.senha, 10);
    await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [u.nome, u.email, senhaHash, u.perfil],
    );
  }

  // Endereço do cliente: só insere se ele ainda não tiver nenhum.
  await pool.query(`
    INSERT INTO enderecos (usuario_id, apelido, cep, logradouro, numero, cidade, uf, principal)
    SELECT u.id, 'Casa', '97010-000', 'Rua do Acampamento', '100', 'Santa Maria', 'RS', true
    FROM usuarios u
    WHERE u.email = 'cliente@loja.com'
      AND NOT EXISTS (SELECT 1 FROM enderecos e WHERE e.usuario_id = u.id)
  `);

  console.log('Seed de usuarios aplicado.');
}

module.exports = { seed };

// Permite rodar sozinho: npm run seed
if (require.main === module) {
  const { pool, esperarBanco, migrar } = require('../src/db');
  esperarBanco()
    .then(migrar)
    .then(() => seed(pool))
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
