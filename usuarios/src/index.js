const app = require('./app');
const { pool, esperarBanco, migrar } = require('./db');
const { seed } = require('../seeds/seed');

async function iniciar() {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET não definido. Configure a variável de ambiente.');
    process.exit(1);
  }

  await esperarBanco();
  await migrar();
  await seed(pool);

  const porta = Number(process.env.PORT) || 3001;
  const servidor = app.listen(porta, () => console.log(`usuarios ouvindo na porta ${porta}`));

  // docker compose stop manda SIGTERM: fecha o servidor e o pool antes de sair.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      servidor.close(() => pool.end().finally(() => process.exit(0)));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de usuarios:', err);
  process.exit(1);
});
