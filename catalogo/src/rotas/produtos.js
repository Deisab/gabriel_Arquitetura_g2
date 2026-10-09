const express = require('express');
const { produtos, categorias } = require('../db');
const { ErroHttp } = require('../erros');
const { paraJson } = require('../json');
const { idDoProduto, validarProduto } = require('../validacao');

// Rotas de admin, por enquanto, ficam abertas: validar o token é trabalho do gateway (próxima aula).
const router = express.Router();

const escaparRegex = (valor) => valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function exigirCategoria(slug) {
  const existe = await categorias().countDocuments({ slug }, { limit: 1 });
  if (!existe) throw new ErroHttp(400, 'Dados inválidos.', [`categoria '${slug}' não existe`]);
}

function skuDuplicado(err) {
  if (err.code === 11000) return new ErroHttp(409, 'Já existe um produto com este SKU.');
  return err;
}

// GET /produtos?categoria=livros&busca=java  -> só produtos ativos
router.get('/produtos', async (req, res) => {
  const filtro = { ativo: true };
  const categoria = typeof req.query.categoria === 'string' ? req.query.categoria.trim().toLowerCase() : '';
  const busca = typeof req.query.busca === 'string' ? req.query.busca.trim() : '';

  if (categoria) filtro.categoria = categoria;
  if (busca) filtro.nome = { $regex: escaparRegex(busca), $options: 'i' };

  const lista = await produtos().find(filtro).sort({ nome: 1 }).toArray();
  res.json(lista.map(paraJson));
});

// Devolve também produtos desativados (com ativo: false): quem consulta decide o que fazer.
router.get('/produtos/:id', async (req, res) => {
  const produto = await produtos().findOne({ _id: idDoProduto(req.params.id) });
  if (!produto) throw new ErroHttp(404, 'Produto não encontrado.');
  res.json(paraJson(produto));
});

router.post('/produtos', async (req, res) => {
  const produto = validarProduto(req.body ?? {}, { criando: true });
  await exigirCategoria(produto.categoria);

  try {
    const { insertedId } = await produtos().insertOne(produto);
    res.status(201).json(paraJson({ _id: insertedId, ...produto }));
  } catch (err) {
    throw skuDuplicado(err);
  }
});

router.put('/produtos/:id', async (req, res) => {
  const _id = idDoProduto(req.params.id);
  const dados = validarProduto(req.body ?? {}, { criando: false });
  await exigirCategoria(dados.categoria);

  try {
    const produto = await produtos().findOneAndUpdate({ _id }, { $set: dados }, { returnDocument: 'after' });
    if (!produto) throw new ErroHttp(404, 'Produto não encontrado.');
    res.json(paraJson(produto));
  } catch (err) {
    throw skuDuplicado(err);
  }
});

// Corpo: { "disponivel": 15 } define o valor, ou { "ajuste": -3 } soma/subtrai.
router.patch('/produtos/:id/estoque', async (req, res) => {
  const _id = idDoProduto(req.params.id);
  const corpo = req.body ?? {};
  const temDisponivel = corpo.disponivel !== undefined;
  const temAjuste = corpo.ajuste !== undefined;

  if (temDisponivel === temAjuste) {
    throw new ErroHttp(400, 'Dados inválidos.', ['envie "disponivel" (novo valor) ou "ajuste" (quanto somar ou subtrair), não os dois']);
  }

  const filtro = { _id };
  let atualizacao;

  if (temDisponivel) {
    if (!Number.isInteger(corpo.disponivel)) throw new ErroHttp(400, 'Dados inválidos.', ['disponivel deve ser um número inteiro']);
    if (corpo.disponivel < 0) throw new ErroHttp(400, 'Estoque não pode ficar negativo.');
    atualizacao = { $set: { 'estoque.disponivel': corpo.disponivel } };
  } else {
    if (!Number.isInteger(corpo.ajuste) || corpo.ajuste === 0) {
      throw new ErroHttp(400, 'Dados inválidos.', ['ajuste deve ser um inteiro diferente de zero']);
    }
    // A condição vai junto do update: é atômico, dois ajustes ao mesmo tempo não deixam o estoque negativo.
    if (corpo.ajuste < 0) filtro['estoque.disponivel'] = { $gte: -corpo.ajuste };
    atualizacao = { $inc: { 'estoque.disponivel': corpo.ajuste } };
  }

  const produto = await produtos().findOneAndUpdate(filtro, atualizacao, { returnDocument: 'after' });
  if (!produto) {
    const existe = await produtos().countDocuments({ _id }, { limit: 1 });
    if (!existe) throw new ErroHttp(404, 'Produto não encontrado.');
    throw new ErroHttp(400, 'Estoque não pode ficar negativo.', [`estoque disponível é menor que ${-corpo.ajuste}`]);
  }
  res.json(paraJson(produto));
});

// Não apaga: desativa (ativo = false). Pedidos antigos continuam apontando para o produto.
router.delete('/produtos/:id', async (req, res) => {
  const { matchedCount } = await produtos().updateOne({ _id: idDoProduto(req.params.id) }, { $set: { ativo: false } });
  if (matchedCount === 0) throw new ErroHttp(404, 'Produto não encontrado.');
  res.status(204).end();
});

module.exports = router;
