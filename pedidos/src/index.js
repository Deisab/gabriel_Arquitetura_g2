const app = require('./app');
const { pool, esperarBanco, migrar } = require('./db');
const kafka = require('./kafka');
const { handlers, TOPICOS_ESCUTADOS } = require('./eventos');

async function iniciar() {
  await esperarBanco();
  await migrar();
  await kafka.conectar();
  await kafka.consumir(TOPICOS_ESCUTADOS, handlers);

  const porta = Number(process.env.PORT) || 3003;
  const servidor = app.listen(porta, () => console.log(`pedidos ouvindo na porta ${porta}`));

  // docker compose stop manda SIGTERM: fecha o servidor, sai do grupo do Kafka e fecha o pool.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.once(sinal, () => {
      servidor.close();
      kafka.desconectar()
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de pedidos:', err);
  process.exit(1);
});
