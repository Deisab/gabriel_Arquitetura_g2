const express = require('express');
const { ping } = require('./db');
const { kafkaOk } = require('./kafka');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Uma linha por requisição, com o X-Request-Id que o gateway gerou: um grep acha a história inteira.
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health a cada 10 s enterraria o que importa
  res.on('finish', () => {
    console.log(`[catalogo] ${req.method} ${req.originalUrl} ${res.statusCode} req=${req.get('x-request-id') ?? '-'}`);
  });
  next();
});

// No gateway: /health/catalogo. Sem Mongo ou sem Kafka: "fora do ar", 503.
app.get('/health', async (req, res) => {
  const [banco, kafka] = await Promise.all([
    ping().then(() => 'ok', () => 'fora do ar'),
    kafkaOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
  ]);
  const status = banco === 'ok' && kafka === 'ok' ? 'ok' : 'fora do ar';
  res.status(status === 'ok' ? 200 : 503).json({ servico: 'catalogo', status, dependencias: { banco, kafka } });
});

app.use(require('./rotas/produtos'));
app.use(require('./rotas/categorias'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
