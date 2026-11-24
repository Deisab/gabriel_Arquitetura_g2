const express = require('express');
const { pool } = require('./db');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Uma linha por requisição, com o X-Request-Id que o gateway gerou: um grep acha a história inteira.
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health a cada 10 s enterraria o que importa
  res.on('finish', () => {
    console.log(`[usuarios] ${req.method} ${req.originalUrl} ${res.statusCode} req=${req.get('x-request-id') ?? '-'}`);
  });
  next();
});

// No gateway: /health/usuarios. Sem o Postgres o serviço não consegue trabalhar: "fora do ar", 503.
app.get('/health', async (req, res) => {
  const banco = await pool.query('SELECT 1').then(() => 'ok', () => 'fora do ar');
  const status = banco === 'ok' ? 'ok' : 'fora do ar';
  res.status(status === 'ok' ? 200 : 503).json({ servico: 'usuarios', status, dependencias: { banco } });
});

app.use(require('./rotas/auth'));
app.use(require('./rotas/usuarios'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
