// Teste de carga pequeno, pelo gateway. Uso: node carga.js
//   1. Vitrine: muitas leituras simultâneas (cache Redis) -> vazão, p50/p95/p99, erros.
//   2. Compras em paralelo: vários clientes comprando ao mesmo tempo -> todas chegam a PAGO, estoque e
//      pagamentos batem (nenhuma cobrança dupla), lag do Kafka volta a zero.
//   3. Disputa pelo estoque: mais pedidos do que unidades -> vende exatamente o que existe, nunca negativo.
const { spawnSync } = require('node:child_process');
const {
  req, login, loginCliente, loginAdmin, loginOutro, criarProduto, comprar, esperarPedido, produto, ate, configBanco,
} = require('./util');

const VITRINE_TOTAL = Number(process.env.VITRINE_TOTAL) || 2000;
const VITRINE_CONCORRENCIA = Number(process.env.VITRINE_CONCORRENCIA) || 50;
const COMPRAS_POR_CLIENTE = Number(process.env.COMPRAS_POR_CLIENTE) || 10;

let falhas = 0;
function confere(nome, ok, detalhe = '') {
  if (!ok) falhas++;
  console.log(`${ok ? '  OK    ' : '  FALHOU'} ${nome}${detalhe ? `: ${detalhe}` : ''}`);
}

const percentil = (lista, p) => {
  const ordenada = [...lista].sort((a, b) => a - b);
  return ordenada[Math.min(ordenada.length - 1, Math.floor((p / 100) * ordenada.length))];
};
const ms = (v) => `${Math.round(v)} ms`;

// Executa "total" tarefas com no máximo "concorrencia" ao mesmo tempo.
async function emParalelo(total, concorrencia, tarefa) {
  let proxima = 0;
  const trabalhadores = Array.from({ length: concorrencia }, async () => {
    while (proxima < total) {
      const i = proxima++;
      await tarefa(i);
    }
  });
  await Promise.all(trabalhadores);
}

async function clientes(n) {
  // cliente e "outro" vêm do cache de tokens; os demais são cadastrados agora (o login tem limite de 10/min)
  const tokens = [await loginCliente(), await loginOutro()];
  for (let i = tokens.length; i < n; i++) {
    const email = `carga${i}@loja.com`;
    await req('POST', '/usuarios', { corpo: { nome: `Cliente de carga ${i}`, email, senha: 'segredo123' } });
    tokens.push(await login(email, 'segredo123'));
  }
  return tokens;
}

async function esvaziar(token) {
  const { body } = await req('GET', '/carrinho', { token });
  for (const item of body.itens || []) await req('DELETE', `/carrinho/itens/${item.produto_id}`, { token });
}

function lagTotal() {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-consumer-groups.sh',
    '--bootstrap-server', 'localhost:9092', '--describe', '--all-groups'], { cwd: `${__dirname}/..`, encoding: 'utf8' });
  return (r.stdout || '').split('\n')
    .filter((l) => /^(pedidos|catalogo|pagamentos|notificacoes)\s/.test(l))
    .reduce((soma, l) => soma + (Number(l.split(/\s+/)[5]) || 0), 0);
}

async function vitrine() {
  console.log(`\n1) VITRINE: ${VITRINE_TOTAL} GETs, ${VITRINE_CONCORRENCIA} ao mesmo tempo`);
  const lista = (await req('GET', '/produtos')).body;
  const caminhos = ['/produtos', '/produtos?categoria=livros', '/produtos?categoria=roupas', '/categorias',
    ...lista.slice(0, 5).map((p) => `/produtos/${p.id}`)];
  const tempos = [];
  const status = {};
  const cache = {};
  const inicio = Date.now();
  await emParalelo(VITRINE_TOTAL, VITRINE_CONCORRENCIA, async (i) => {
    const t = performance.now();
    const r = await fetch(`http://localhost:8080${caminhos[i % caminhos.length]}`);
    await r.arrayBuffer();
    tempos.push(performance.now() - t);
    status[r.status] = (status[r.status] || 0) + 1;
    const x = r.headers.get('x-cache');
    cache[x] = (cache[x] || 0) + 1;
  });
  const segundos = (Date.now() - inicio) / 1000;
  console.log(`  ${Math.round(VITRINE_TOTAL / segundos)} req/s · p50 ${ms(percentil(tempos, 50))} · p95 ${ms(percentil(tempos, 95))} · p99 ${ms(percentil(tempos, 99))} · máx ${ms(Math.max(...tempos))}`);
  console.log(`  status: ${JSON.stringify(status)} · X-Cache: ${JSON.stringify(cache)}`);
  confere('nenhum erro', Object.keys(status).every((s) => s === '200'), JSON.stringify(status));
  confere('quase tudo do cache (HIT)', (cache.HIT || 0) / VITRINE_TOTAL > 0.95, `${cache.HIT || 0} HIT`);
  confere('p95 abaixo de 500 ms', percentil(tempos, 95) < 500, ms(percentil(tempos, 95)));
}

async function compras(admin, tokens) {
  const total = tokens.length * COMPRAS_POR_CLIENTE;
  console.log(`\n2) COMPRAS EM PARALELO: ${tokens.length} clientes × ${COMPRAS_POR_CLIENTE} compras = ${total} pedidos`);
  const p = await criarProduto(admin, { estoque: 10000, preco: 19.9, nome: 'Produto da carga' });
  const tempoCheckout = [];
  const tempoAtePago = [];
  const pedidos = [];
  const erros = [];
  const inicio = Date.now();
  await Promise.all(tokens.map(async (token) => {
    await esvaziar(token);
    for (let i = 0; i < COMPRAS_POR_CLIENTE; i++) {
      const t = performance.now();
      const r = await comprar(token, p.id, 1);
      tempoCheckout.push(performance.now() - t);
      if (r.status !== 202) { erros.push(r.status); continue; }
      pedidos.push({ token, id: r.body.id, t });
    }
  }));
  const finais = await Promise.all(pedidos.map(async ({ token, id, t }) => {
    const pedido = await esperarPedido(token, id, ['PAGO', 'CANCELADO'], 120000);
    tempoAtePago.push(performance.now() - t);
    return pedido.status;
  }));
  const segundos = (Date.now() - inicio) / 1000;
  const pagos = finais.filter((s) => s === 'PAGO').length;
  console.log(`  ${total} pedidos em ${segundos.toFixed(1)} s (${(total / segundos).toFixed(1)} pedidos/s)`);
  console.log(`  checkout (carrinho + POST /pedidos): p50 ${ms(percentil(tempoCheckout, 50))} · p95 ${ms(percentil(tempoCheckout, 95))} · p99 ${ms(percentil(tempoCheckout, 99))}`);
  console.log(`  do checkout até PAGO (saga inteira): p50 ${ms(percentil(tempoAtePago, 50))} · p95 ${ms(percentil(tempoAtePago, 95))} · máx ${ms(Math.max(...tempoAtePago))}`);
  confere('todo checkout respondeu 202', erros.length === 0, erros.length ? `erros: ${erros}` : '');
  confere('todos os pedidos chegaram a PAGO', pagos === total, `${pagos}/${total}`);

  const estoque = (await produto(p.id)).estoque;
  confere('estoque bate: vendeu exatamente o que foi pago', estoque.disponivel === 10000 - pagos && estoque.reservado === 0, JSON.stringify(estoque));

  const pagamentos = (await req('GET', '/pagamentos', { token: admin })).body.filter((x) => pedidos.some((pd) => pd.id === x.pedido_id));
  const codigos = new Set(pagamentos.map((x) => x.codigo_transacao));
  confere('um pagamento por pedido, todos APROVADO', pagamentos.length === total && pagamentos.every((x) => x.status === 'APROVADO'), `${pagamentos.length} pagamentos`);
  confere('nenhuma cobrança duplicada (códigos únicos)', codigos.size === pagamentos.length, `${codigos.size} códigos`);
  const somaPaga = pagamentos.reduce((s, x) => s + x.valor, 0);
  confere('valor cobrado = pedidos × preço', Math.abs(somaPaga - total * 19.9) < 0.01, `R$ ${somaPaga.toFixed(2)}`);
}

async function disputa(admin, tokens) {
  const unidades = 20;
  const porCliente = Math.ceil((unidades * 1.75) / tokens.length);
  const total = porCliente * tokens.length;
  console.log(`\n3) DISPUTA PELO ESTOQUE: ${unidades} unidades, ${total} pedidos de 1 unidade ao mesmo tempo`);
  const p = await criarProduto(admin, { estoque: unidades, preco: 5, nome: 'Último estoque' });
  const pedidos = [];
  await Promise.all(tokens.map(async (token) => {
    await esvaziar(token);
    for (let i = 0; i < porCliente; i++) {
      const r = await comprar(token, p.id, 1);
      if (r.status === 202) pedidos.push({ token, id: r.body.id });
    }
  }));
  const finais = await Promise.all(pedidos.map(({ token, id }) => esperarPedido(token, id, ['PAGO', 'CANCELADO'], 120000)));
  const pagos = finais.filter((x) => x.status === 'PAGO').length;
  const semEstoque = finais.filter((x) => x.status === 'CANCELADO' && /estoque insuficiente/.test(x.motivo)).length;
  const estoque = (await produto(p.id)).estoque;
  console.log(`  ${pagos} PAGO · ${semEstoque} CANCELADO (estoque insuficiente) · estoque final ${JSON.stringify(estoque)}`);
  confere('vendeu exatamente as unidades que existiam', pagos === unidades, `${pagos}/${unidades}`);
  confere('o resto foi cancelado por falta de estoque', pagos + semEstoque === pedidos.length, `${semEstoque}`);
  confere('estoque final zerado, nunca negativo', estoque.disponivel === 0 && estoque.reservado === 0, JSON.stringify(estoque));
}

(async () => {
  await configBanco({ latenciaMs: 0, falhaPercent: 0 });
  const admin = await loginAdmin();
  await vitrine();
  const tokens = await clientes(6);
  await compras(admin, tokens);
  await disputa(admin, tokens);

  console.log('\n4) DEPOIS DA CARGA');
  const lagZerou = await ate(async () => lagTotal() === 0, 30000);
  confere('lag do Kafka voltou a zero (todos os eventos processados)', Boolean(lagZerou));
  const saude = await Promise.all(['usuarios', 'catalogo', 'pedidos', 'pagamentos'].map(async (s) => (await req('GET', `/health/${s}`)).body.status));
  confere('todos os serviços continuam ok', saude.every((s) => s === 'ok'), saude.join(', '));

  console.log(falhas ? `\n${falhas} VERIFICAÇÃO(ÕES) FALHARAM` : '\nCARGA OK: tudo consistente');
  process.exit(falhas ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
