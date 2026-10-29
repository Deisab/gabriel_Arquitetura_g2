const express = require('express');
const { pool } = require('../db');
const { identificar } = require('../identidade');
const { buscarProdutos, CatalogoIndisponivel } = require('../catalogo');
const { ErroHttp } = require('../erros');
const { OBJECT_ID, validarItem } = require('../validacao');

// Todas as rotas são de quem está logado: o gateway já exigiu o token (jwt).
const router = express.Router();
router.use('/carrinho', identificar);

const centavos = (valor) => Math.round(valor * 100);

// Produto à venda: existe, está ativo e tem estoque para a quantidade pedida.
function disponivel(produto, quantidade) {
  return Boolean(produto && produto.ativo && (produto.estoque?.disponivel ?? 0) >= quantidade);
}

// GET /carrinho -> { itens, total } com preços atuais do catálogo.
// Catálogo fora do ar: o carrinho continua funcionando, só sem preços (e com um aviso).
router.get('/carrinho', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT produto_id, quantidade, adicionado_em FROM carrinho_itens WHERE usuario_id = $1 ORDER BY adicionado_em',
    [req.usuario.id],
  );

  let produtos;
  try {
    produtos = await buscarProdutos(rows.map((r) => r.produto_id), req.get('x-request-id'));
  } catch (err) {
    if (!(err instanceof CatalogoIndisponivel)) throw err;
    return res.json({
      itens: rows.map((r) => ({ ...r, nome: null, preco_unitario: null, subtotal: null, disponivel: null })),
      total: null,
      aviso: 'Catálogo indisponível: preços e disponibilidade não puderam ser atualizados.',
    });
  }

  let totalCentavos = 0;
  const itens = rows.map((r) => {
    const produto = produtos.get(r.produto_id);
    const subtotalCentavos = produto ? centavos(produto.preco) * r.quantidade : 0;
    if (disponivel(produto, r.quantidade)) totalCentavos += subtotalCentavos;
    return {
      produto_id: r.produto_id,
      nome: produto?.nome ?? null,
      preco_unitario: produto?.preco ?? null,
      quantidade: r.quantidade,
      subtotal: produto ? subtotalCentavos / 100 : null,
      disponivel: disponivel(produto, r.quantidade),
      adicionado_em: r.adicionado_em,
    };
  });

  // total: só o que dá para comprar agora.
  res.json({ itens, total: totalCentavos / 100 });
});

// POST /carrinho/itens { produto_id, quantidade } -> 201.
// Se o produto já está no carrinho, soma a quantidade.
router.post('/carrinho/itens', async (req, res) => {
  const { produtoId, quantidade } = validarItem(req.body ?? {});
  if (!OBJECT_ID.test(produtoId)) throw new ErroHttp(404, 'Produto não encontrado.');

  // Sem FK para o catálogo: quem garante que o produto existe é a pergunta ao serviço dono.
  const produtos = await buscarProdutos([produtoId], req.get('x-request-id'));
  const produto = produtos.get(produtoId);
  if (!produto || !produto.ativo) throw new ErroHttp(404, 'Produto não encontrado.');

  const { rows } = await pool.query(
    `INSERT INTO carrinho_itens (usuario_id, produto_id, quantidade)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, produto_id)
     DO UPDATE SET quantidade = carrinho_itens.quantidade + EXCLUDED.quantidade
     RETURNING produto_id, quantidade, adicionado_em`,
    [req.usuario.id, produtoId, quantidade],
  );

  res.status(201).json({ ...rows[0], nome: produto.nome, preco_unitario: produto.preco });
});

// DELETE /carrinho/itens/:produtoId -> 204, ou 404 se não está no carrinho.
router.delete('/carrinho/itens/:produtoId', async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM carrinho_itens WHERE usuario_id = $1 AND produto_id = $2',
    [req.usuario.id, req.params.produtoId],
  );
  if (rowCount === 0) throw new ErroHttp(404, 'Produto não está no carrinho.');
  res.status(204).end();
});

module.exports = router;
