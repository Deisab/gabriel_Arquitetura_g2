const express = require('express');
const { pool } = require('./db');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Uma linha por requisição, com o X-Request-Id que o gateway gerou: um grep acha a história inteira.
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} | x-request-id=${req.get('x-request-id') ?? '-'}`);
  });
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', servico: 'usuarios', banco: 'ok' });
  } catch {
    res.status(503).json({ status: 'erro', servico: 'usuarios', banco: 'indisponível' });
  }
});

app.use(require('./rotas/auth'));
app.use(require('./rotas/usuarios'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
