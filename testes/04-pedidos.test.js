// Serviço de pedidos: carrinho, checkout (202) e o pedido andando sozinho por evento.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  req, ENDERECO, loginCliente, loginAdmin, loginOutro, criarProduto, comprar, esperarPedido, produto, emails, ate,
} = require('./util');

async function esvaziarCarrinho(token) {
  const { body } = await req('GET', '/carrinho', { token });
  for (const item of body.itens || []) await req('DELETE', `/carrinho/itens/${item.produto_id}`, { token });
}

test('carrinho: adiciona (201), soma a quantidade, total com o preço atual, remove (204), 404 depois', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin, { preco: 12.5 });
  assert.equal((await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade: 2 } })).status, 201);
  const soma = await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade: 1 } });
  assert.equal(soma.body.quantidade, 3);
  const carrinho = (await req('GET', '/carrinho', { token: cliente })).body;
  assert.equal(carrinho.total, 37.5);
  assert.equal(carrinho.itens[0].disponivel, true);
  assert.equal((await req('DELETE', `/carrinho/itens/${p.id}`, { token: cliente })).status, 204);
  assert.equal((await req('DELETE', `/carrinho/itens/${p.id}`, { token: cliente })).status, 404);
});

test('carrinho: quantidade inválida 400, produto inexistente ou desativado 404', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  for (const quantidade of [0, -1, 100, 1.5, '2']) {
    assert.equal((await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade } })).status, 400, `quantidade ${quantidade}`);
  }
  assert.equal((await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: '000000000000000000000000' } })).status, 404);
  assert.equal((await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: 'xyz' } })).status, 404);
  await req('DELETE', `/produtos/${p.id}`, { token: admin });
  assert.equal((await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id } })).status, 404);
});

test('checkout: carrinho vazio 400; dados inválidos 400', async () => {
  const cliente = await loginCliente();
  await esvaziarCarrinho(cliente);
  assert.equal((await req('POST', '/pedidos', { token: cliente, corpo: { enderecoEntrega: ENDERECO, formaPagamento: 'pix' } })).status, 400);
  const invalido = await req('POST', '/pedidos', { token: cliente, corpo: { formaPagamento: 'cartao', cartao: { numero: '12' } } });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.body.detalhes.length, 2);
  assert.equal((await req('POST', '/pedidos', { token: cliente, corpo: { enderecoEntrega: ENDERECO, formaPagamento: 'cheque' } })).status, 400);
});

test('caminho feliz: 202 AGUARDANDO_ESTOQUE, depois PAGO; preço e nome copiados; carrinho esvaziado; estoque vendido', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin, { estoque: 10, preco: 30 });
  const r = await comprar(cliente, p.id, 2, { formaPagamento: 'cartao', cartao: { numero: '4111 1111 1111 1234' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'AGUARDANDO_ESTOQUE');
  assert.equal(r.body.valor_total, 60);
  assert.equal(r.body.cartao_final, '1234', 'do cartão só ficam os 4 últimos dígitos');
  assert.equal(r.headers.get('location'), `/pedidos/${r.body.id}`);
  assert.equal((await req('GET', '/carrinho', { token: cliente })).body.itens.length, 0);

  const pedido = await esperarPedido(cliente, r.body.id);
  assert.equal(pedido.status, 'PAGO');
  assert.equal(pedido.itens[0].nome_produto, p.nome);
  assert.equal(pedido.itens[0].preco_unitario, 30);
  const depois = await produto(p.id);
  assert.equal(depois.estoque.disponivel, 8);
  assert.equal(depois.estoque.reservado, 0, 'confirmado: saiu do reservado');
  assert.ok((await req('GET', '/pedidos', { token: cliente })).body.some((x) => x.id === r.body.id));

  const assuntos = await ate(async () => {
    const lista = await emails(r.body.id);
    return lista.some((s) => /Recebemos/.test(s)) && lista.some((s) => /aprovado/.test(s)) && lista;
  });
  assert.ok(assuntos, 'e-mails "Recebemos" e "Pagamento aprovado" no Mailpit');
});

test('o preço vem do catálogo na hora do checkout, não do momento em que foi ao carrinho', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin, { preco: 100 });
  await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade: 1 } });
  await req('PUT', `/produtos/${p.id}`, { token: admin, corpo: { sku: p.sku, nome: p.nome, categoria: 'livros', preco: 80, ativo: true, atributos: {} } });
  const r = await req('POST', '/pedidos', { token: cliente, corpo: { enderecoEntrega: ENDERECO, formaPagamento: 'pix' } });
  assert.equal(r.body.valor_total, 80);
  await esperarPedido(cliente, r.body.id);
});

test('sem estoque: o checkout aceita (202) e o pedido vira CANCELADO com o motivo; nada fica reservado', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const pouco = await criarProduto(admin, { estoque: 2 });
  const muito = await criarProduto(admin, { estoque: 50 });
  await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: muito.id, quantidade: 1 } });
  const r = await comprar(cliente, pouco.id, 3);
  assert.equal(r.status, 202);
  const pedido = await esperarPedido(cliente, r.body.id, ['CANCELADO', 'PAGO']);
  assert.equal(pedido.status, 'CANCELADO');
  assert.match(pedido.motivo, /estoque insuficiente/);
  // tudo ou nada: o item que tinha estoque também voltou
  assert.deepEqual((await produto(pouco.id)).estoque, { disponivel: 2, reservado: 0 });
  assert.deepEqual((await produto(muito.id)).estoque, { disponivel: 50, reservado: 0 });
  assert.ok(await ate(async () => (await emails(r.body.id)).some((s) => /sem estoque/.test(s))), 'e-mail de sem estoque');
});

test('produto desativado depois de ir ao carrinho: checkout 409', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin);
  await req('POST', '/carrinho/itens', { token: cliente, corpo: { produtoId: p.id, quantidade: 1 } });
  await req('DELETE', `/produtos/${p.id}`, { token: admin });
  const r = await req('POST', '/pedidos', { token: cliente, corpo: { enderecoEntrega: ENDERECO, formaPagamento: 'pix' } });
  assert.equal(r.status, 409);
  await esvaziarCarrinho(cliente);
});

test('pedido de outra pessoa: 404 para ver e para cancelar (não confirma que existe)', async () => {
  const cliente = await loginCliente();
  const outro = await loginOutro();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin);
  const r = await comprar(cliente, p.id);
  assert.equal((await req('GET', `/pedidos/${r.body.id}`, { token: outro })).status, 404);
  assert.equal((await req('POST', `/pedidos/${r.body.id}/cancelar`, { token: outro })).status, 404);
  assert.ok(!(await req('GET', '/pedidos', { token: outro })).body.some((x) => x.id === r.body.id));
  assert.equal((await req('GET', '/pedidos/00000000-0000-0000-0000-000000000000', { token: cliente })).status, 404);
  assert.equal((await req('GET', '/pedidos/abc', { token: cliente })).status, 404);
  await esperarPedido(cliente, r.body.id);
});

test('cancelar: PAGO e CANCELADO não podem (409)', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  await esvaziarCarrinho(cliente);
  const p = await criarProduto(admin);
  const r = await comprar(cliente, p.id);
  await esperarPedido(cliente, r.body.id);
  assert.equal((await req('POST', `/pedidos/${r.body.id}/cancelar`, { token: cliente })).status, 409);
});
