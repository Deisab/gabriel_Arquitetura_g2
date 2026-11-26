// Serviço de usuarios: cadastro, login, /me, endereços e a rota de admin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req, loginCliente, loginAdmin, loginOutro } = require('./util');

const unico = () => `teste${Date.now()}${Math.floor(Math.random() * 1e6)}@loja.com`;

test('login: senha errada e e-mail inexistente dão o mesmo 401; sem senha, 400', async () => {
  const errada = await req('POST', '/auth/login', { corpo: { email: 'cliente@loja.com', senha: 'senha-errada' } });
  const inexistente = await req('POST', '/auth/login', { corpo: { email: 'ninguem@loja.com', senha: 'qualquer123' } });
  assert.equal(errada.status, 401);
  assert.equal(inexistente.status, 401);
  assert.equal(errada.body.erro, inexistente.body.erro, 'mesma mensagem: não revela quem tem conta');
  const semSenha = await req('POST', '/auth/login', { corpo: { email: 'cliente@loja.com' } });
  assert.equal(semSenha.status, 400);
  assert.ok(Array.isArray(semSenha.body.detalhes));
});

test('cadastro: 201 sem a senha, perfil sempre cliente, 409 e-mail repetido, 400 inválido e JSON quebrado', async () => {
  const email = unico();
  const r = await req('POST', '/usuarios', { corpo: { nome: 'Ana', email, senha: 'segredo123', perfil: 'admin' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.perfil, 'cliente', 'cadastro público nunca vira admin');
  assert.equal(r.body.senha, undefined);
  assert.equal(r.body.senha_hash, undefined);
  assert.equal((await req('POST', '/usuarios', { corpo: { nome: 'Ana', email, senha: 'segredo123' } })).status, 409);
  const invalido = await req('POST', '/usuarios', { corpo: { nome: 'Sem Email', senha: '123' } });
  assert.equal(invalido.status, 400);
  assert.ok(invalido.body.detalhes.length >= 2);
  assert.equal((await req('POST', '/usuarios', { corpo: '{ "nome": "Ana", }' })).status, 400);
});

test('/usuarios/me: lê, atualiza (sem trocar a senha) e recusa e-mail de outro (409)', async () => {
  const cliente = await loginCliente();
  const me = await req('GET', '/usuarios/me', { token: cliente });
  assert.equal(me.status, 200);
  assert.equal(me.body.senha_hash, undefined);
  const put = await req('PUT', '/usuarios/me', { token: cliente, corpo: { nome: 'Cliente Exemplo', email: 'cliente@loja.com' } });
  assert.equal(put.status, 200);
  assert.equal((await req('PUT', '/usuarios/me', { token: cliente, corpo: { email: 'cliente@loja.com' } })).status, 400);
  assert.equal((await req('PUT', '/usuarios/me', { token: cliente, corpo: { nome: 'X', email: 'admin@loja.com' } })).status, 409);
  // a senha continua a mesma: o login segue funcionando com o token atual
  assert.equal((await req('GET', '/usuarios/me', { token: cliente })).status, 200);
});

test('endereços: cria, lista, outro usuário não apaga (404), dono apaga (204), de novo 404', async () => {
  const cliente = await loginCliente();
  const outro = await loginOutro();
  const novo = await req('POST', '/usuarios/me/enderecos', {
    token: cliente,
    corpo: { apelido: 'Trabalho', cep: '97015900', logradouro: 'Av. Roraima', numero: '1000', cidade: 'Santa Maria', uf: 'rs' },
  });
  assert.equal(novo.status, 201);
  assert.equal(novo.body.cep, '97015-900');
  assert.equal(novo.body.uf, 'RS');
  const lista = await req('GET', '/usuarios/me/enderecos', { token: cliente });
  assert.ok(lista.body.some((e) => e.id === novo.body.id));
  assert.equal((await req('POST', '/usuarios/me/enderecos', { token: cliente, corpo: { logradouro: 'Sem cidade', uf: 'RSS' } })).status, 400);
  assert.equal((await req('DELETE', `/usuarios/me/enderecos/${novo.body.id}`, { token: outro })).status, 404);
  assert.equal((await req('DELETE', `/usuarios/me/enderecos/${novo.body.id}`, { token: cliente })).status, 204);
  assert.equal((await req('DELETE', `/usuarios/me/enderecos/${novo.body.id}`, { token: cliente })).status, 404);
  assert.equal((await req('DELETE', '/usuarios/me/enderecos/abc', { token: cliente })).status, 404);
});

test('GET /usuarios (admin): lista sem senha_hash', async () => {
  const admin = await loginAdmin();
  const r = await req('GET', '/usuarios', { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 2);
  assert.ok(r.body.every((u) => u.senha_hash === undefined));
});

test('formato de erro: { erro, detalhes? }, sem stack trace nem mensagem do banco', async () => {
  const r = await req('POST', '/usuarios', { corpo: { nome: 'x' } });
  assert.deepEqual(Object.keys(r.body).sort(), ['detalhes', 'erro']);
  assert.doesNotMatch(JSON.stringify(r.body), /at |stack|pg_|duplicate key/i);
});
