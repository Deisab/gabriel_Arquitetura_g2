// Serviço de catalogo: vitrine pública, gestão de admin e o cache Redis com invalidação.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req, loginAdmin, criarProduto } = require('./util');

test('vitrine: só ativos, filtro por categoria, busca, ordem por nome', async () => {
  const todos = (await req('GET', '/produtos')).body;
  assert.ok(todos.length >= 10, 'seed com pelo menos 10 produtos ativos');
  assert.ok(todos.every((p) => p.ativo === true));
  assert.ok(!todos.some((p) => p.sku === 'CEL-005'), 'o produto desativado do seed não aparece');
  const livros = (await req('GET', '/produtos?categoria=livros')).body;
  assert.ok(livros.length > 0 && livros.every((p) => p.categoria === 'livros'));
  const busca = (await req('GET', '/produtos?categoria=livros&busca=java')).body;
  assert.ok(busca.length >= 1 && busca.every((p) => /java/i.test(p.nome)));
  assert.deepEqual((await req('GET', '/produtos?busca=nao-tem-isso')).body, []);
  const nomes = livros.map((p) => p.nome);
  assert.deepEqual(nomes, [...nomes].sort((a, b) => a.localeCompare(b)), 'ordenado por nome');
});

test('atributos diferentes por categoria e estoque { disponivel, reservado }', async () => {
  const [celular] = (await req('GET', '/produtos?categoria=celulares')).body;
  const [livro] = (await req('GET', '/produtos?categoria=livros')).body;
  assert.ok('memoria' in celular.atributos);
  assert.ok('autor' in livro.atributos);
  assert.equal(typeof livro.estoque.disponivel, 'number');
  assert.equal(typeof livro.estoque.reservado, 'number');
});

test('produto: 200, 404 para id que não existe e para id que nem é ObjectId', async () => {
  const [primeiro] = (await req('GET', '/produtos')).body;
  assert.equal((await req('GET', `/produtos/${primeiro.id}`)).status, 200);
  assert.equal((await req('GET', '/produtos/000000000000000000000000')).status, 404);
  assert.equal((await req('GET', '/produtos/id-que-nao-existe')).status, 404);
});

test('categorias: lista pública; admin cria (201), slug repetido 409, sem nome 400', async () => {
  const admin = await loginAdmin();
  const lista = (await req('GET', '/categorias')).body;
  assert.ok(['celulares', 'roupas', 'livros'].every((s) => lista.some((c) => c.slug === s)));
  const nova = await req('POST', '/categorias', { token: admin, corpo: { nome: `Eletrônicos Teste ${Date.now()}` } });
  assert.equal(nova.status, 201);
  assert.match(nova.body.slug, /^eletronicos-teste-\d+$/, 'slug gerado sem acento');
  assert.equal((await req('POST', '/categorias', { token: admin, corpo: { nome: 'Livros', slug: 'livros' } })).status, 409);
  assert.equal((await req('POST', '/categorias', { token: admin, corpo: {} })).status, 400);
});

test('produto (admin): cria 201, SKU repetido 409, inválido 400, categoria inexistente 400', async () => {
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 7, preco: 129.9 });
  assert.equal(p.estoque.disponivel, 7);
  assert.equal(p.estoque.reservado, 0);
  assert.equal((await req('POST', '/produtos', { token: admin, corpo: { sku: p.sku, nome: 'x', categoria: 'livros', preco: 1 } })).status, 409);
  const invalido = await req('POST', '/produtos', { token: admin, corpo: { nome: 'Ruim', categoria: 'roupas', preco: -10 } });
  assert.equal(invalido.status, 400);
  assert.ok(invalido.body.detalhes.length >= 2);
  assert.equal((await req('POST', '/produtos', { token: admin, corpo: { sku: 'X-1', nome: 'x', categoria: 'brinquedos', preco: 1 } })).status, 400);
});

test('PUT substitui o produto mas não mexe no estoque; 404 e 409 nos casos de erro', async () => {
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 5 });
  const put = await req('PUT', `/produtos/${p.id}`, {
    token: admin,
    corpo: { sku: p.sku, nome: 'Nome novo', categoria: 'livros', preco: 20, ativo: true, atributos: { edicao: 2 } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.nome, 'Nome novo');
  assert.equal(put.body.estoque.disponivel, 5, 'estoque não muda no PUT');
  assert.equal((await req('PUT', '/produtos/000000000000000000000000', { token: admin, corpo: { sku: 'N-1', nome: 'n', categoria: 'livros', preco: 1 } })).status, 404);
  assert.equal((await req('PUT', `/produtos/${p.id}`, { token: admin, corpo: { sku: 'CEL-001', nome: 'n', categoria: 'livros', preco: 1 } })).status, 409);
});

test('estoque (PATCH): define, ajusta, nunca fica negativo', async () => {
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 3 });
  const patch = (corpo) => req('PATCH', `/produtos/${p.id}/estoque`, { token: admin, corpo });
  assert.equal((await patch({ disponivel: 20 })).body.estoque.disponivel, 20);
  assert.equal((await patch({ ajuste: -5 })).body.estoque.disponivel, 15);
  assert.equal((await patch({ ajuste: -1000 })).status, 400);
  assert.equal((await patch({ disponivel: -1 })).status, 400);
  assert.equal((await patch({ disponivel: 1, ajuste: 1 })).status, 400, 'os dois ao mesmo tempo não');
  assert.equal((await req('PATCH', '/produtos/000000000000000000000000/estoque', { token: admin, corpo: { ajuste: 1 } })).status, 404);
});

test('DELETE desativa em vez de apagar: some da vitrine, mas o GET mostra ativo: false', async () => {
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  assert.equal((await req('DELETE', `/produtos/${p.id}`, { token: admin })).status, 204);
  const depois = await req('GET', `/produtos/${p.id}`);
  assert.equal(depois.status, 200);
  assert.equal(depois.body.ativo, false);
  assert.ok(!(await req('GET', '/produtos?busca=' + encodeURIComponent(p.nome))).body.some((x) => x.id === p.id));
  assert.equal((await req('DELETE', '/produtos/000000000000000000000000', { token: admin })).status, 404);
});

test('cache: MISS e depois HIT; a escrita do admin invalida e o próximo GET já vem com o preço novo', async () => {
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { preco: 50 });
  const a = await req('GET', `/produtos/${p.id}`);
  const b = await req('GET', `/produtos/${p.id}`);
  assert.equal(a.headers.get('x-cache'), 'MISS');
  assert.equal(b.headers.get('x-cache'), 'HIT');
  assert.equal(b.body.preco, 50);
  await req('PUT', `/produtos/${p.id}`, { token: admin, corpo: { sku: p.sku, nome: p.nome, categoria: 'livros', preco: 45, ativo: true, atributos: {} } });
  const c = await req('GET', `/produtos/${p.id}`);
  assert.equal(c.headers.get('x-cache'), 'MISS');
  assert.equal(c.body.preco, 45, 'ninguém vê o preço velho');
});

test('cache: listagens e categorias também; cada filtro é uma chave', async () => {
  await req('GET', '/categorias');
  assert.equal((await req('GET', '/categorias')).headers.get('x-cache'), 'HIT');
  await req('GET', '/produtos?categoria=roupas');
  assert.equal((await req('GET', '/produtos?categoria=roupas')).headers.get('x-cache'), 'HIT');
  const outroFiltro = await req('GET', `/produtos?categoria=roupas&busca=filtro-novo-${Date.now()}`);
  assert.equal(outroFiltro.headers.get('x-cache'), 'MISS');
});

test('o ?ids= do checkout não passa pelo cache e devolve inclusive desativados', async () => {
  const r = await req('GET', '/produtos?ids=000000000000000000000000,xyz');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-cache'), null);
  assert.deepEqual(r.body, []);
});
