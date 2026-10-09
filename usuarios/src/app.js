const express = require('express');
const { pool } = require('./db');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

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
