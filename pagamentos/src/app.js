const express = require('express');
const { pool } = require('./db');
const { kafkaOk } = require('./kafka');
const { estadoCircuito } = require('./banco');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Uma linha por requisição, com o X-Request-Id que o gateway gerou: um grep acha a história inteira.
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health a cada 10 s enterraria o que importa
  res.on('finish', () => {
    console.log(`[pagamentos] ${req.method} ${req.originalUrl} ${res.statusCode} req=${req.get('x-request-id') ?? '-'}`);
  });
  next();
});

// No gateway: /health/pagamentos.
// Sem banco ou sem Kafka: "fora do ar", 503. Circuito do banco do cartão aberto: "degradado", 200
// (o serviço faz o que deve, recusar rápido; um 503 o tiraria do ar à toa).
app.get('/health', async (req, res) => {
  const [banco, kafka] = await Promise.all([
    pool.query('SELECT 1').then(() => 'ok', () => 'fora do ar'),
    kafkaOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
  ]);
  const circuitoBancoExterno = estadoCircuito();
  let status = 'ok';
  if (banco !== 'ok' || kafka !== 'ok') status = 'fora do ar';
  else if (circuitoBancoExterno !== 'fechado') status = 'degradado';
  res.status(status === 'fora do ar' ? 503 : 200).json({
    servico: 'pagamentos', status, dependencias: { banco, kafka, circuitoBancoExterno },
  });
});

app.use(require('./rotas/pagamentos'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
