// Pagamentos, banco-falso, compensações e resiliência (timeout, retry, circuit breaker).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  req, BANCO, loginCliente, loginAdmin, loginOutro, criarProduto, comprar, esperarPedido, esperarPagamento,
  produto, emails, ate, esperar, configBanco,
} = require('./util');

const CARTAO_OK = { formaPagamento: 'cartao', cartao: { numero: '4111 1111 1111 1111' } };
const CARTAO_0002 = { formaPagamento: 'cartao', cartao: { numero: '4111 1111 1111 0002' } };

// Nenhum teste deixa o banco do cartão quebrado para o próximo.
after(() => configBanco({ latenciaMs: 0, falhaPercent: 0 }));

async function esperarCircuito(estados, ms = 30000) {
  return ate(async () => {
    const h = (await req('GET', '/health/pagamentos')).body;
    return estados.includes(h.dependencias.circuitoBancoExterno) && h;
  }, ms);
}

test('banco-falso direto: 201 com código, 0002 dá 402, referência repetida não cobra de novo, estorno 201/404', async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  const ref = `teste-${Date.now()}`;
  const a = await req('POST', '/cobrancas', { base: BANCO, corpo: { valor: 60, cartaoFinal: '1111', referencia: ref } });
  const b = await req('POST', '/cobrancas', { base: BANCO, corpo: { valor: 60, cartaoFinal: '1111', referencia: ref } });
  assert.equal(a.status, 201);
  assert.match(a.body.codigo, /^TX-/);
  assert.equal(b.body.codigo, a.body.codigo, 'idempotente pela referência');
  const recusa = await req('POST', '/cobrancas', { base: BANCO, corpo: { valor: 60, cartaoFinal: '0002', referencia: `${ref}-r` } });
  assert.equal(recusa.status, 402);
  assert.equal(recusa.body.motivo, 'saldo insuficiente');
  assert.equal((await req('POST', '/estornos', { base: BANCO, corpo: { codigo: a.body.codigo, referencia: ref } })).status, 201);
  assert.equal((await req('POST', '/estornos', { base: BANCO, corpo: { referencia: 'nunca-cobrado' } })).status, 404);
  assert.equal((await req('POST', '/config', { base: BANCO, corpo: { falhaPercent: 150 } })).status, 400);
});

test('compra aprovada: pagamento APROVADO com TX-, 1 tentativa; consulta só do dono ou admin', async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const outro = await loginOutro();
  const p = await criarProduto(admin, { preco: 25 });
  const r = await comprar(cliente, p.id, 1, CARTAO_OK);
  assert.equal((await esperarPedido(cliente, r.body.id)).status, 'PAGO');
  const pag = (await req('GET', `/pagamentos/${r.body.id}`, { token: cliente })).body;
  assert.equal(pag.status, 'APROVADO');
  assert.match(pag.codigo_transacao, /^TX-/);
  assert.equal(pag.tentativas, 1);
  assert.equal(pag.valor, 25);
  assert.equal(pag.cartao_final, '1111');
  assert.equal((await req('GET', `/pagamentos/${r.body.id}`, { token: admin })).status, 200, 'admin vê qualquer um');
  assert.equal((await req('GET', `/pagamentos/${r.body.id}`, { token: outro })).status, 404, 'outro cliente não');
  assert.equal((await req('GET', `/pagamentos/${r.body.id}`)).status, 401);
  assert.equal((await req('GET', '/pagamentos', { token: cliente })).status, 403);
  const todos = await req('GET', '/pagamentos', { token: admin });
  assert.equal(todos.status, 200);
  assert.ok(todos.body.some((x) => x.pedido_id === r.body.id));
});

test('cartão 0002: RECUSADO, pedido CANCELADO com o motivo e o estoque volta (compensação)', async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  const r = await comprar(cliente, p.id, 3, CARTAO_0002);
  const pedido = await esperarPedido(cliente, r.body.id);
  assert.equal(pedido.status, 'CANCELADO');
  assert.equal(pedido.motivo, 'saldo insuficiente');
  assert.equal((await req('GET', `/pagamentos/${r.body.id}`, { token: cliente })).body.status, 'RECUSADO');
  assert.deepEqual(await ate(async () => {
    const e = (await produto(p.id)).estoque;
    return e.reservado === 0 && e;
  }), { disponivel: 10, reservado: 0 });
  assert.ok(await ate(async () => (await emails(r.body.id)).some((s) => /recusado/i.test(s))), 'e-mail de pagamento recusado');
});

test('cancelar no meio da cobrança: o banco cobra, pagamentos ESTORNA, o pedido segue CANCELADO e o estoque volta', async () => {
  await configBanco({ latenciaMs: 1500, falhaPercent: 0 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  const r = await comprar(cliente, p.id, 2, CARTAO_OK);
  // espera a reserva (a cobrança começa logo depois) e cancela enquanto o banco demora
  assert.equal((await esperarPedido(cliente, r.body.id, ['AGUARDANDO_PAGAMENTO'], 10000)).status, 'AGUARDANDO_PAGAMENTO');
  const cancelado = await req('POST', `/pedidos/${r.body.id}/cancelar`, { token: cliente });
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.body.motivo, 'cancelado pelo cliente');
  const pag = await esperarPagamento(cliente, r.body.id, ['ESTORNADO'], 20000);
  assert.equal(pag.status, 'ESTORNADO');
  assert.match(pag.codigo_transacao, /^TX-/);
  await esperar(1000);
  assert.equal((await req('GET', `/pedidos/${r.body.id}`, { token: cliente })).body.status, 'CANCELADO', 'não volta a PAGO');
  assert.deepEqual(await ate(async () => {
    const e = (await produto(p.id)).estoque;
    return e.disponivel === 10 && e;
  }), { disponivel: 10, reservado: 0 });
  assert.ok(await ate(async () => (await emails(r.body.id)).some((s) => /Estorno/.test(s))), 'e-mail de estorno');
  await configBanco({ latenciaMs: 0 });
});

test('cancelar antes da cobrança: pagamento CANCELADO e o banco nem é chamado', async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  const r = await comprar(cliente, p.id, 1, CARTAO_OK);
  await req('POST', `/pedidos/${r.body.id}/cancelar`, { token: cliente }); // logo em seguida
  const pag = await esperarPagamento(cliente, r.body.id, ['CANCELADO', 'ESTORNADO'], 15000);
  assert.ok(['CANCELADO', 'ESTORNADO'].includes(pag.status), `pagamento ${pag.status}`);
  assert.deepEqual(await ate(async () => {
    const e = (await produto(p.id)).estoque;
    return e.disponivel === 10 && e.reservado === 0 && e;
  }), { disponivel: 10, reservado: 0 });
});

// Garante o circuito fechado: espera sair do aberto e faz uma compra boa (a chamada de teste do meio-aberto).
async function fecharCircuito(cliente, produtoId) {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  if ((await req('GET', '/health/pagamentos')).body.dependencias.circuitoBancoExterno === 'fechado') return;
  await esperarCircuito(['meio-aberto', 'fechado'], 25000);
  const r = await comprar(cliente, produtoId, 1);
  await esperarPedido(cliente, r.body.id);
  assert.ok(await esperarCircuito(['fechado'], 5000), 'circuito fechado antes do teste');
}

test('banco instável (30% de 503): o retry resolve e os pedidos saem PAGO', async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 30 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await comprar(cliente, p.id, 1)).body.id);
  const finais = [];
  for (const id of ids) finais.push((await esperarPedido(cliente, id)).status);
  const pagos = finais.filter((s) => s === 'PAGO').length;
  assert.ok(pagos >= 5, `esperado quase tudo PAGO, veio ${finais.join(', ')}`);
  await configBanco({ falhaPercent: 0 });
});

test('banco fora (100%): ERRO, pedidos CANCELADO, estoque devolvido, CIRCUITO ABERTO e /health degradado; depois fecha sozinho', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  await fecharCircuito(cliente, p.id);
  const estoqueAntes = (await produto(p.id)).estoque.disponivel;
  await configBanco({ latenciaMs: 0, falhaPercent: 100 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await comprar(cliente, p.id, 1)).body.id);
  for (const id of ids) {
    const pedido = await esperarPedido(cliente, id, ['CANCELADO', 'PAGO'], 40000);
    assert.equal(pedido.status, 'CANCELADO');
    assert.match(pedido.motivo, /banco indisponível/);
  }
  const pag = (await req('GET', `/pagamentos/${ids[0]}`, { token: cliente })).body;
  assert.equal(pag.status, 'ERRO');
  assert.ok(pag.tentativas >= 1);

  const h = await esperarCircuito(['aberto'], 5000);
  assert.ok(h, 'o circuito abriu');
  assert.equal(h.status, 'degradado', 'circuito aberto não tira o serviço do ar');
  assert.equal((await req('GET', '/health/pagamentos')).status, 200);
  assert.deepEqual(await ate(async () => {
    const e = (await produto(p.id)).estoque;
    return e.disponivel === estoqueAntes && e;
  }), { disponivel: estoqueAntes, reservado: 0 }, 'estoque devolvido');

  // o banco volta: em 15 s o circuito vai a meio-aberto; a próxima compra testa e fecha
  await configBanco({ falhaPercent: 0 });
  assert.ok(await esperarCircuito(['meio-aberto', 'fechado'], 25000), 'saiu do aberto sozinho');
  const r = await comprar(cliente, p.id, 1);
  assert.equal((await esperarPedido(cliente, r.body.id)).status, 'PAGO');
  assert.ok(await esperarCircuito(['fechado'], 5000), 'fechou depois de uma chamada boa');
});

test('banco lento (3 s > timeout de 2 s): 3 tentativas, ERRO por timeout e o pedido é cancelado', async () => {
  await configBanco({ latenciaMs: 3000, falhaPercent: 0 });
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  const r = await comprar(cliente, p.id, 1);
  const pedido = await esperarPedido(cliente, r.body.id, ['CANCELADO', 'PAGO'], 40000);
  assert.equal(pedido.status, 'CANCELADO');
  assert.match(pedido.motivo, /timeout/);
  const pag = (await req('GET', `/pagamentos/${r.body.id}`, { token: cliente })).body;
  assert.equal(pag.status, 'ERRO');
  assert.equal(pag.tentativas, 3);
  await configBanco({ latenciaMs: 0 });
  // deixa o circuito fechar de novo para os próximos testes
  await esperarCircuito(['fechado', 'meio-aberto'], 25000);
});
