const express = require('express');
const { pool } = require('./db');
const { kafkaOk } = require('./kafka');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Uma linha por requisição, com o X-Request-Id que o gateway gerou: um grep acha a história inteira.
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health a cada 10 s enterraria o que importa
  res.on('finish', () => {
    console.log(`[pedidos] ${req.method} ${req.originalUrl} ${res.statusCode} req=${req.get('x-request-id') ?? '-'}`);
  });
  next();
});

// No gateway: /health/pedidos. Testa as dependências de verdade: SELECT 1 e uma pergunta ao Kafka.
// Sem banco ou sem Kafka o serviço não consegue trabalhar: "fora do ar", 503.
// O catálogo NÃO entra aqui: se ele cair, o checkout responde 503, mas o pedidos continua de pé.
app.get('/health', async (req, res) => {
  const [banco, kafka] = await Promise.all([
    pool.query('SELECT 1').then(() => 'ok', () => 'fora do ar'),
    kafkaOk().then((ok) => (ok ? 'ok' : 'fora do ar')),
  ]);
  const status = banco === 'ok' && kafka === 'ok' ? 'ok' : 'fora do ar';
  res.status(status === 'ok' ? 200 : 503).json({ servico: 'pedidos', status, dependencias: { banco, kafka } });
});

app.use(require('./rotas/carrinho'));
app.use(require('./rotas/pedidos'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
