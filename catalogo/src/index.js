const app = require('./app');
const { conectar, fechar } = require('./db');
const { seed } = require('../seeds/seed');
const kafka = require('./kafka');
const { handlers, TOPICOS_ESCUTADOS } = require('./estoque');

async function iniciar() {
  await conectar();
  await seed();
  await kafka.conectar();
  await kafka.consumir(TOPICOS_ESCUTADOS, handlers);

  const porta = Number(process.env.PORT) || 3002;
  const servidor = app.listen(porta, () => console.log(`catalogo ouvindo na porta ${porta}`));

  // docker compose stop manda SIGTERM: fecha o servidor, sai do grupo do Kafka e fecha a conexão.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.once(sinal, () => {
      servidor.close();
      kafka.desconectar()
        .then(() => fechar())
        .finally(() => process.exit(0));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de catalogo:', err);
  process.exit(1);
});
