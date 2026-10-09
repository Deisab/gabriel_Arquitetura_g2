const express = require('express');
const { categorias } = require('../db');
const { ErroHttp } = require('../erros');
const { paraJson } = require('../json');
const { validarCategoria } = require('../validacao');

const router = express.Router();

router.get('/categorias', async (req, res) => {
  const lista = await categorias().find().sort({ nome: 1 }).toArray();
  res.json(lista.map(paraJson));
});

// slug é opcional: se não vier, é gerado a partir do nome.
router.post('/categorias', async (req, res) => {
  const categoria = validarCategoria(req.body ?? {});

  try {
    const { insertedId } = await categorias().insertOne(categoria);
    res.status(201).json(paraJson({ _id: insertedId, ...categoria }));
  } catch (err) {
    if (err.code === 11000) throw new ErroHttp(409, 'Já existe uma categoria com este slug.');
    throw err;
  }
});

module.exports = router;
