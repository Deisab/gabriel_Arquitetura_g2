const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { gerarToken } = require('../auth');
const { ErroHttp } = require('../erros');

const router = express.Router();

router.post('/auth/login', async (req, res) => {
  const corpo = req.body ?? {};
  const email = typeof corpo.email === 'string' ? corpo.email.trim().toLowerCase() : '';
  const senha = typeof corpo.senha === 'string' ? corpo.senha : '';

  const detalhes = [];
  if (!email) detalhes.push('email é obrigatório');
  if (!senha) detalhes.push('senha é obrigatória');
  if (detalhes.length > 0) throw new ErroHttp(400, 'Dados inválidos.', detalhes);

  const { rows } = await pool.query(
    'SELECT id, nome, email, perfil, criado_em, senha_hash FROM usuarios WHERE email = $1',
    [email],
  );
  const usuario = rows[0];

  // Mesma mensagem para e-mail inexistente e senha errada: não revela quem tem conta.
  const senhaConfere = usuario && (await bcrypt.compare(senha, usuario.senha_hash));
  if (!senhaConfere) throw new ErroHttp(401, 'E-mail ou senha inválidos.');

  const { senha_hash: _, ...semSenha } = usuario;
  res.json({ token: gerarToken(semSenha), usuario: semSenha });
});

module.exports = router;
