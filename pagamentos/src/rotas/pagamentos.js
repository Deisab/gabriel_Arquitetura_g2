const express = require('express');
const { pool } = require('../db');
const { identificar, UUID } = require('../identidade');
const { ErroHttp } = require('../erros');

// No Kong as rotas são "logado" (jwt): o serviço confere o dono e o admin pelos X-User-*.
const router = express.Router();
router.use('/pagamentos', identificar);

const CAMPOS = `id, pedido_id, usuario_id, valor, forma, cartao_final, status, tentativas,
                codigo_transacao, motivo, criado_em, atualizado_em`;

// GET /pagamentos -> todos (só admin).
router.get('/pagamentos', async (req, res) => {
  if (req.usuario.perfil !== 'admin') throw new ErroHttp(403, 'Acesso restrito a administradores.');
  const { rows } = await pool.query(`SELECT ${CAMPOS} FROM pagamentos ORDER BY criado_em DESC LIMIT 200`);
  res.json(rows);
});

// GET /pagamentos/:pedidoId -> o pagamento do pedido; só o dono ou admin. 404 se não existe ou não é seu.
router.get('/pagamentos/:pedidoId', async (req, res) => {
  if (!UUID.test(req.params.pedidoId)) throw new ErroHttp(404, 'Pagamento não encontrado.');
  const { rows } = await pool.query(`SELECT ${CAMPOS} FROM pagamentos WHERE pedido_id = $1`, [req.params.pedidoId]);
  const pag = rows[0];
  if (!pag || (pag.usuario_id !== req.usuario.id && req.usuario.perfil !== 'admin')) {
    throw new ErroHttp(404, 'Pagamento não encontrado.');
  }
  res.json(pag);
});

module.exports = router;
