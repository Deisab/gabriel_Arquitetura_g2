// Kong: a única porta, rotas públicas, logadas (jwt) e de admin (jwt + acl), X-Request-Id e X-User-*.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { req, loginCliente, loginAdmin } = require('./util');

test('health de cada serviço pelo gateway, sem token: 200 e status ok', async () => {
  for (const servico of ['usuarios', 'catalogo', 'pedidos', 'pagamentos']) {
    const r = await req('GET', `/health/${servico}`);
    assert.equal(r.status, 200, servico);
    assert.equal(r.body.servico, servico);
    assert.equal(r.body.status, 'ok', `${servico}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.dependencias, 'health traz as dependências');
  }
});

test('toda resposta traz X-Request-Id (correlation-id), inclusive as recusadas', async () => {
  const aceita = await req('GET', '/produtos');
  const recusada = await req('GET', '/usuarios/me');
  assert.match(aceita.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.match(recusada.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('o X-Request-Id que o cliente manda é mantido', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const r = await req('GET', '/produtos', { headers: { 'x-request-id': id } });
  assert.equal(r.headers.get('x-request-id'), id);
});

test('rota logada sem token, com token inventado e com assinatura falsa: 401', async () => {
  assert.equal((await req('GET', '/usuarios/me')).status, 401);
  assert.equal((await req('GET', '/carrinho', { token: 'token-inventado' })).status, 401);
  // payload { perfil: "admin" } assinado com outro segredo
  const falso = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJlbWFpbCI6ImhhY2tlckBsb2phLmNvbSIsInBlcmZpbCI6ImFkbWluIiwiZXhwIjo0MTAyNDQ0ODAwfQ.c2Vnd25kby1lcnJhZG8tYXNzaW5hdHVyYS1mYWxzYQ';
  assert.equal((await req('GET', '/usuarios', { token: falso })).status, 401);
});

test('token com perfil que nenhum consumer tem (superadmin): 401', async () => {
  // header.payload sem assinatura válida, mas o Kong recusa antes: não acha consumer para "superadmin"
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x', perfil: 'superadmin', exp: 4102444800 })}.assinatura`;
  const r = await req('GET', '/usuarios/me', { token });
  assert.equal(r.status, 401);
});

test('ninguém escolhe quem é: X-User-* de fora é apagado pelo gateway', async () => {
  // sem token, fingindo ser admin
  assert.equal((await req('GET', '/usuarios', { headers: { 'x-user-role': 'admin', 'x-user-id': '00000000-0000-0000-0000-000000000000' } })).status, 401);
  // com token de cliente + cabeçalho de outro usuário: vale o token
  const cliente = await loginCliente();
  const r = await req('GET', '/usuarios/me', { token: cliente, headers: { 'x-user-id': '00000000-0000-0000-0000-000000000000', 'x-user-role': 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'cliente@loja.com');
  assert.equal((await req('GET', '/usuarios', { token: cliente, headers: { 'x-user-role': 'admin' } })).status, 403);
});

test('rota de admin: 401 sem token, 403 para cliente, 200 para admin', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  for (const [metodo, caminho] of [['GET', '/usuarios'], ['POST', '/produtos'], ['POST', '/categorias']]) {
    const corpo = metodo === 'POST' ? {} : undefined;
    assert.equal((await req(metodo, caminho, { corpo })).status, 401, `${metodo} ${caminho} sem token`);
    assert.equal((await req(metodo, caminho, { corpo, token: cliente })).status, 403, `${metodo} ${caminho} cliente`);
  }
  assert.equal((await req('GET', '/usuarios', { token: admin })).status, 200);
  assert.equal((await req('POST', '/produtos', { token: admin, corpo: {} })).status, 400, 'admin passa pelo Kong e cai na validação');
});

test('rota que não existe: 404 do próprio Kong', async () => {
  const r = await req('GET', '/entregas');
  assert.equal(r.status, 404);
});

test('o JWT é emitido pelo usuarios: HS256 com sub, email, perfil, iss e exp de 2 h', async () => {
  const token = await loginAdmin();
  const [header, payload] = token.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url')));
  assert.equal(header.alg, 'HS256');
  assert.match(payload.sub, /^[0-9a-f-]{36}$/);
  assert.equal(payload.email, 'admin@loja.com');
  assert.equal(payload.perfil, 'admin');
  assert.equal(payload.iss, 'usuarios');
  assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
});

// Tenta abrir uma conexão TCP: true se alguém escuta na porta do host.
const portaAberta = (porta) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: porta });
  socket.setTimeout(1500);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
});

test('só as portas combinadas estão publicadas: serviços, bancos, Redis e Kafka ficam na rede interna', async () => {
  for (const porta of [3001, 3002, 3003, 3004, 3005, 5432, 5433, 27017, 27018, 6379, 9092]) {
    assert.equal(await portaAberta(porta), false, `porta ${porta} não deveria estar publicada`);
  }
  for (const porta of [8080, 8025, 8090, 9000]) {
    assert.equal(await portaAberta(porta), true, `porta ${porta} deveria estar publicada`);
  }
});
