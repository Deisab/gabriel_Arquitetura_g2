const app = require('./app');
const { pool, esperarBanco, migrar } = require('./db');
const kafka = require('./kafka');
const { handlers, reprocessarEstornosPendentes, TOPICOS_ESCUTADOS } = require('./saga');

async function iniciar() {
  await esperarBanco();
  await migrar();
  await kafka.conectar();
  await kafka.consumir(TOPICOS_ESCUTADOS, handlers);

  // A cada 30 s, tenta de novo os estornos que falharam.
  const rotina = setInterval(() => {
    reprocessarEstornosPendentes().catch((err) => console.error(`[pagamentos] ERRO reprocessando estornos: ${err.message}`));
  }, 30000);

  const porta = Number(process.env.PORT) || 3005;
  const servidor = app.listen(porta, () => console.log(`pagamentos ouvindo na porta ${porta}`));

  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.once(sinal, () => {
      clearInterval(rotina);
      servidor.close();
      kafka.desconectar()
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de pagamentos:', err);
  process.exit(1);
});
