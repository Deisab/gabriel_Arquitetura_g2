const express = require('express');
const kafka = require('./kafka');
const { handlers, smtpOk, TOPICOS_ESCUTADOS } = require('./emails');

// Serviço só de escuta: ninguém chama, ninguém conhece, nenhuma rota no Kong.
// Se cair, a loja continua vendendo; os eventos esperam no Kafka.
// A porta HTTP existe só para o healthcheck do Docker, dentro da rede interna.
const app = express();
app.disable('x-powered-by');

// Sem Kafka não recebe nada: "fora do ar", 503. Sem o SMTP: "degradado" (os e-mails falham, o resto segue).
app.get('/health', async (req, res) => {
  const [kafkaStatus, smtp] = await Promise.all([
    kafka.kafkaOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
    smtpOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
  ]);
  let status = 'ok';
  if (kafkaStatus !== 'ok') status = 'fora do ar';
  else if (smtp !== 'ok') status = 'degradado';
  res.status(status === 'fora do ar' ? 503 : 200).json({ servico: 'notificacoes', status, dependencias: { kafka: kafkaStatus, smtp } });
});

async function iniciar() {
  await kafka.conectar();
  await kafka.consumir(TOPICOS_ESCUTADOS, handlers);

  const porta = Number(process.env.PORT) || 3004;
  const servidor = app.listen(porta, () => console.log(`notificacoes ouvindo na porta ${porta} (só /health)`));

  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.once(sinal, () => {
      servidor.close();
      kafka.desconectar().finally(() => process.exit(0));
    });
  }
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o serviço de notificacoes:', err);
  process.exit(1);
});
