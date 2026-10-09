const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { autenticar, exigirAdmin } = require('../auth');
const { ErroHttp } = require('../erros');
const { UUID, validarUsuario, validarEndereco } = require('../validacao');

const router = express.Router();

// Colunas que podem sair do serviço. senha_hash nunca está aqui.
const CAMPOS = 'id, nome, email, perfil, criado_em';

function emailDuplicado(err) {
  if (err.code === '23505') return new ErroHttp(409, 'Este e-mail já está cadastrado.');
  return err;
}

// Cadastro público: sempre cria como 'cliente', mesmo que o corpo mande outro perfil.
router.post('/usuarios', async (req, res) => {
  const { nome, email, senha } = validarUsuario(req.body ?? {}, { senhaObrigatoria: true });
  const senhaHash = await bcrypt.hash(senha, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING ${CAMPOS}`,
      [nome, email, senhaHash],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    throw emailDuplicado(err);
  }
});

router.get('/usuarios', autenticar, exigirAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${CAMPOS} FROM usuarios ORDER BY criado_em`);
  res.json(rows);
});

router.get('/usuarios/me', autenticar, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${CAMPOS} FROM usuarios WHERE id = $1`, [req.usuario.id]);
  if (rows.length === 0) throw new ErroHttp(401, 'Usuário do token não existe mais.');
  res.json(rows[0]);
});

// PUT substitui os dados: nome e email obrigatórios; senha só muda se vier no corpo.
router.put('/usuarios/me', autenticar, async (req, res) => {
  const { nome, email, senha } = validarUsuario(req.body ?? {}, { senhaObrigatoria: false });
  const senhaHash = senha ? await bcrypt.hash(senha, 10) : null;

  try {
    const { rows } = await pool.query(
      `UPDATE usuarios
       SET nome = $1, email = $2, senha_hash = COALESCE($3, senha_hash)
       WHERE id = $4
       RETURNING ${CAMPOS}`,
      [nome, email, senhaHash, req.usuario.id],
    );
    if (rows.length === 0) throw new ErroHttp(401, 'Usuário do token não existe mais.');
    res.json(rows[0]);
  } catch (err) {
    throw emailDuplicado(err);
  }
});

router.get('/usuarios/me/enderecos', autenticar, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM enderecos WHERE usuario_id = $1 ORDER BY principal DESC, apelido',
    [req.usuario.id],
  );
  res.json(rows);
});

router.post('/usuarios/me/enderecos', autenticar, async (req, res) => {
  const e = validarEndereco(req.body ?? {});
  const cliente = await pool.connect();

  try {
    await cliente.query('BEGIN');
    // Só um endereço principal por usuário.
    if (e.principal) {
      await cliente.query('UPDATE enderecos SET principal = false WHERE usuario_id = $1', [req.usuario.id]);
    }
    const { rows } = await cliente.query(
      `INSERT INTO enderecos (usuario_id, apelido, cep, logradouro, numero, complemento, cidade, uf, principal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.usuario.id, e.apelido, e.cep, e.logradouro, e.numero, e.complemento, e.cidade, e.uf, e.principal],
    );
    await cliente.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
});

// 404 tanto se não existe quanto se é de outra pessoa: não revela endereços alheios.
router.delete('/usuarios/me/enderecos/:id', autenticar, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ErroHttp(404, 'Endereço não encontrado.');

  const { rowCount } = await pool.query(
    'DELETE FROM enderecos WHERE id = $1 AND usuario_id = $2',
    [req.params.id, req.usuario.id],
  );
  if (rowCount === 0) throw new ErroHttp(404, 'Endereço não encontrado.');
  res.status(204).end();
});

module.exports = router;
