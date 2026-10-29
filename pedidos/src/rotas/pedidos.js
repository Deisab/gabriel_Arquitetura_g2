const express = require('express');
const { pool } = require('../db');
const { identificar, UUID } = require('../identidade');
const { buscarProdutos } = require('../catalogo');
const { ErroHttp } = require('../erros');
const { validarCheckout } = require('../validacao');

// Todas as rotas são de quem está logado: o gateway já exigiu o token (jwt).
// "Este pedido é seu?" é pergunta do serviço, não do gateway: 404 se não for (um 403 confirmaria que existe).
const router = express.Router();
router.use('/pedidos', identificar);

const CANCELAVEIS = ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_PAGAMENTO'];
const CAMPOS = `id, usuario_id, cliente_email, status, valor_total, endereco_entrega,
                forma_pagamento, cartao_final, criado_em`;

const centavos = (valor) => Math.round(valor * 100);

async function buscarItens(pedidoId) {
  const { rows } = await pool.query(
    `SELECT produto_id, nome_produto, preco_unitario, quantidade
     FROM itens_pedido WHERE pedido_id = $1 ORDER BY nome_produto`,
    [pedidoId],
  );
  return rows;
}

// POST /pedidos -> 202: o checkout.
// 400 dados inválidos ou carrinho vazio · 409 produto indisponível · 503 catálogo fora.
router.post('/pedidos', async (req, res) => {
  const { enderecoEntrega, formaPagamento, cartaoFinal } = validarCheckout(req.body ?? {});

  const { rows: carrinho } = await pool.query(
    'SELECT produto_id, quantidade FROM carrinho_itens WHERE usuario_id = $1 ORDER BY produto_id',
    [req.usuario.id],
  );
  if (carrinho.length === 0) throw new ErroHttp(400, 'Carrinho vazio. Adicione produtos antes de finalizar.');

  // Chamada síncrona, com timeout: pergunta ao catálogo o preço e o estoque de todos os itens de uma vez.
  const produtos = await buscarProdutos(carrinho.map((i) => i.produto_id), req.get('x-request-id'));

  const indisponiveis = [];
  for (const item of carrinho) {
    const produto = produtos.get(item.produto_id);
    if (!produto || !produto.ativo) {
      indisponiveis.push(`produto ${item.produto_id} não está mais à venda`);
    } else if ((produto.estoque?.disponivel ?? 0) < item.quantidade) {
      indisponiveis.push(`${produto.nome}: pedido ${item.quantidade}, disponível ${produto.estoque?.disponivel ?? 0}`);
    }
  }
  if (indisponiveis.length > 0) throw new ErroHttp(409, 'Produto indisponível.', indisponiveis);

  // Preço e nome copiados do catálogo agora: o pedido guarda o histórico.
  const itens = carrinho.map((item) => {
    const produto = produtos.get(item.produto_id);
    return { produto_id: item.produto_id, nome_produto: produto.nome, preco_unitario: produto.preco, quantidade: item.quantidade };
  });
  const totalCentavos = itens.reduce((soma, i) => soma + centavos(i.preco_unitario) * i.quantidade, 0);

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // Esvazia o carrinho na mesma transação. Se ele mudou enquanto o catálogo respondia
    // (outra aba adicionou um item, por exemplo), o pedido não corresponde mais ao carrinho: 409.
    const { rows: removidos } = await cliente.query(
      'DELETE FROM carrinho_itens WHERE usuario_id = $1 RETURNING produto_id, quantidade',
      [req.usuario.id],
    );
    const chave = (lista) => lista.map((i) => `${i.produto_id}:${i.quantidade}`).sort().join(',');
    if (chave(removidos) !== chave(carrinho)) {
      throw new ErroHttp(409, 'O carrinho mudou durante o checkout. Confira o carrinho e tente de novo.');
    }

    const { rows } = await cliente.query(
      `INSERT INTO pedidos (usuario_id, cliente_email, valor_total, endereco_entrega, forma_pagamento, cartao_final)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CAMPOS}`,
      [req.usuario.id, req.usuario.email, totalCentavos / 100, enderecoEntrega, formaPagamento, cartaoFinal],
    );
    const pedido = rows[0];

    for (const i of itens) {
      await cliente.query(
        `INSERT INTO itens_pedido (pedido_id, produto_id, nome_produto, preco_unitario, quantidade)
         VALUES ($1, $2, $3, $4, $5)`,
        [pedido.id, i.produto_id, i.nome_produto, i.preco_unitario, i.quantidade],
      );
    }

    await cliente.query('COMMIT');

    // 202 e não 201: o pedido foi aceito, mas ainda não terminou (falta reservar o estoque e cobrar).
    // Hoje ele fica em AGUARDANDO_ESTOQUE; na próxima aula, o Kafka o faz andar.
    res.status(202).location(`/pedidos/${pedido.id}`).json({ ...pedido, itens });
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
});

// GET /pedidos -> só os meus, do mais novo para o mais antigo.
router.get('/pedidos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS} FROM pedidos WHERE usuario_id = $1 ORDER BY criado_em DESC`,
    [req.usuario.id],
  );
  res.json(rows);
});

// GET /pedidos/:id -> pedido com itens; 404 se não existe ou não é meu.
router.get('/pedidos/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ErroHttp(404, 'Pedido não encontrado.');

  const { rows } = await pool.query(
    `SELECT ${CAMPOS} FROM pedidos WHERE id = $1 AND usuario_id = $2`,
    [req.params.id, req.usuario.id],
  );
  if (rows.length === 0) throw new ErroHttp(404, 'Pedido não encontrado.');

  res.json({ ...rows[0], itens: await buscarItens(rows[0].id) });
});

// POST /pedidos/:id/cancelar -> 200; 404 não existe ou não é meu; 409 status não permite.
router.post('/pedidos/:id/cancelar', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ErroHttp(404, 'Pedido não encontrado.');

  // A condição de status vai junto do UPDATE: dois cancelamentos ao mesmo tempo não brigam.
  const { rows } = await pool.query(
    `UPDATE pedidos SET status = 'CANCELADO'
     WHERE id = $1 AND usuario_id = $2 AND status = ANY($3)
     RETURNING ${CAMPOS}`,
    [req.params.id, req.usuario.id, CANCELAVEIS],
  );

  if (rows.length === 0) {
    const { rows: existentes } = await pool.query(
      'SELECT status FROM pedidos WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.id],
    );
    if (existentes.length === 0) throw new ErroHttp(404, 'Pedido não encontrado.');
    throw new ErroHttp(409, `Pedido com status ${existentes[0].status} não pode ser cancelado.`);
  }

  res.json({ ...rows[0], itens: await buscarItens(rows[0].id) });
});

module.exports = router;
