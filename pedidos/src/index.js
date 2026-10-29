const app = require('./app');
const { pool, esperarBanco, migrar } = require('./db');

async function iniciar() {
  await esperarBanco();
  await migrar();

  const porta = Number(process.env.PORT) || 3003;
  const servidor = app.listen(porta, () => console.log(`pedidos ouvindo na porta ${porta}`));

  // docker compose stop manda SIGTERM: fecha o servidor e o pool antes de sair.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      servidor.close(() => pool.end().finally(() => process.exit(0)));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de pedidos:', err);
  process.exit(1);
});
