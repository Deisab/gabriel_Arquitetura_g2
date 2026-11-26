// Infraestrutura: healthchecks do compose e o sistema com peças fora do ar (Redis, catálogo, banco do pagamentos,
// notificações/Mailpit). Usa "docker compose stop/start": rode com o sistema no ar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  req, ENDERECO, loginCliente, loginAdmin, criarProduto, comprar, esperarPedido, ate, compose, emails,
} = require('./util');

async function healthy(servico, ms = 60000) {
  return ate(async () => compose(`ps ${servico} --format "{{.Status}}"`).includes('(healthy)'), ms);
}

test('docker compose ps: todos os serviços healthy', () => {
  const linhas = compose('ps --format "{{.Service}} {{.Status}}"').trim().split('\n');
  assert.equal(linhas.length, 15, linhas.join('\n'));
  const doentes = linhas.filter((l) => !l.includes('(healthy)'));
  assert.deepEqual(doentes, []);
});

test('Redis fora: a vitrine continua (X-Cache: OFF) e o catálogo fica degradado (200); volta sozinho', async () => {
  compose('stop redis');
  try {
    const r = await req('GET', '/produtos');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-cache'), 'OFF');
    const h = await req('GET', '/health/catalogo');
    assert.equal(h.status, 200);
    assert.equal(h.body.status, 'degradado');
    assert.equal(h.body.dependencias.cache, 'fora do ar');
  } finally {
    compose('start redis');
  }
  assert.ok(await ate(async () => (await req('GET', '/health/catalogo')).body.status === 'ok'), 'volta a ok');
  await req('GET', '/categorias');
  assert.equal((await req('GET', '/categorias')).headers.get('x-cache'), 'HIT');
});

test('catálogo fora: checkout 503 em até ~3 s (timeout); carrinho e pedidos continuam respondendo', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade: 1 } });
  compose('stop catalogo');
  try {
    const inicio = Date.now();
    const r = await req('POST', '/pedidos', { token: cliente, corpo: { enderecoEntrega: ENDERECO, formaPagamento: 'pix' } });
    const ms = Date.now() - inicio;
    assert.equal(r.status, 503);
    assert.ok(ms < 4500, `respondeu em ${ms} ms`);
    const carrinho = await req('GET', '/carrinho', { token: cliente });
    assert.equal(carrinho.status, 200);
    assert.ok(carrinho.body.aviso, 'carrinho sem preços, com aviso');
    assert.equal((await req('GET', '/pedidos', { token: cliente })).status, 200);
  } finally {
    compose('start catalogo');
  }
  assert.ok(await healthy('catalogo'), 'catálogo volta a healthy');
  await req('DELETE', `/carrinho/itens/${p.id}`, { token: cliente });
});

test('banco do pagamentos fora: /health 503 "fora do ar", container unhealthy; volta sozinho', async () => {
  compose('stop pagamentos-db');
  try {
    const h = await req('GET', '/health/pagamentos');
    assert.equal(h.status, 503);
    assert.equal(h.body.status, 'fora do ar');
    assert.equal(h.body.dependencias.banco, 'fora do ar');
    assert.ok(await ate(async () => compose('ps pagamentos --format "{{.Status}}"').includes('(unhealthy)'), 60000), 'Docker marca unhealthy');
  } finally {
    compose('start pagamentos-db');
  }
  assert.ok(await healthy('pagamentos'), 'volta a healthy sem reiniciar o serviço');
  assert.equal((await req('GET', '/health/pagamentos')).body.status, 'ok');
});

test('notificações fora: a loja continua vendendo; os e-mails saem quando ela volta (o evento espera no Kafka)', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  compose('stop notificacoes');
  let pedidoId;
  try {
    const r = await comprar(cliente, p.id);
    pedidoId = r.body.id;
    assert.equal((await esperarPedido(cliente, pedidoId)).status, 'PAGO');
  } finally {
    compose('start notificacoes');
  }
  assert.ok(await ate(async () => (await emails(pedidoId)).length >= 2, 45000), 'os e-mails chegaram depois');
});
