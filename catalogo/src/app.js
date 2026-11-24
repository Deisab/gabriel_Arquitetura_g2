const express = require('express');
const { ping } = require('./db');
const { kafkaOk } = require('./kafka');
const { redisOk } = require('./cache');
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

const comPrazo = (promessa, ms = 2000) => Promise.race([
  promessa,
  new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('timeout')), ms)),
]);

// No gateway: /health/catalogo. Sem Mongo ou sem Kafka: "fora do ar", 503.
// Redis fora: "degradado", 200. O cache só acelera: nunca tira o serviço do ar.
app.get('/health', async (req, res) => {
  const [banco, kafka, cache] = await Promise.all([
    comPrazo(ping()).then(() => 'ok', () => 'fora do ar'),
    kafkaOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
    redisOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
  ]);
  let status = 'ok';
  if (banco !== 'ok' || kafka !== 'ok') status = 'fora do ar';
  else if (cache !== 'ok') status = 'degradado';
  res.status(status === 'fora do ar' ? 503 : 200).json({ servico: 'catalogo', status, dependencias: { banco, kafka, cache } });
});

app.use(require('./rotas/produtos'));
app.use(require('./rotas/categorias'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
