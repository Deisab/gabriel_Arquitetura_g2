const app = require('./app');
const { conectar, fechar } = require('./db');
const { seed } = require('../seeds/seed');

async function iniciar() {
  await conectar();
  await seed();

  const porta = Number(process.env.PORT) || 3002;
  const servidor = app.listen(porta, () => console.log(`catalogo ouvindo na porta ${porta}`));

  // docker compose stop manda SIGTERM: fecha o servidor e a conexão antes de sair.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      servidor.close(() => fechar().finally(() => process.exit(0)));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de catalogo:', err);
  process.exit(1);
});
