const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// O compose só sobe o serviço quando o Postgres está healthy, mas
// tentar de novo deixa o serviço resistente a reinícios do banco.
async function esperarBanco(tentativas = 30) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= tentativas) throw err;
      console.log(`Aguardando o Postgres (${i}/${tentativas})...`);
      await esperar(2000);
    }
  }
}

// Aplica, em ordem, os arquivos .sql de migrations/ que ainda não rodaram.
async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nome       TEXT PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const pasta = path.join(__dirname, '..', 'migrations');
  const arquivos = fs.readdirSync(pasta).filter((f) => f.endsWith('.sql')).sort();

  for (const arquivo of arquivos) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE nome = $1', [arquivo]);
    if (rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [arquivo]);
      await cliente.query('COMMIT');
      console.log(`Migration aplicada: ${arquivo}`);
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw err;
    } finally {
      cliente.release();
    }
  }
}

module.exports = { pool, esperarBanco, migrar };
