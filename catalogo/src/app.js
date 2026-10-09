const express = require('express');
const { ping } = require('./db');
const { rotaNaoEncontrada, tratarErros } = require('./erros');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await ping();
    res.json({ status: 'ok', servico: 'catalogo', banco: 'ok' });
  } catch {
    res.status(503).json({ status: 'erro', servico: 'catalogo', banco: 'indisponível' });
  }
});

app.use(require('./rotas/produtos'));
app.use(require('./rotas/categorias'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
