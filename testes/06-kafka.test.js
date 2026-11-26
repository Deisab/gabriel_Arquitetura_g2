// Kafka: envelope, chave, correlationId, idempotência na reentrega, eventos fora de ordem entre tópicos,
// logs correlacionados e o lag dos consumer groups. Usa "docker compose exec kafka": rode com o sistema no ar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  req, loginCliente, loginAdmin, criarProduto, comprar, esperarPedido, produto, ate, esperar, compose,
} = require('./util');

// Roda um script do Kafka dentro do container, sem shell no meio (o "|" do separador não vira pipe no Windows).
function kafka(args, input) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'kafka', ...args], {
    cwd: `${__dirname}/..`, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !r.stdout) throw new Error(r.stderr || `docker compose exec falhou (${r.status})`);
  return r.stdout;
}

const LOGS_SERVICOS = 'usuarios catalogo pedidos pagamentos notificacoes banco-falso';

function lerTopico(topico, pedidoId) {
  const saida = kafka(['/opt/kafka/bin/kafka-console-consumer.sh', '--bootstrap-server', 'localhost:9092', '--topic', topico,
    '--from-beginning', '--property', 'print.key=true', '--property', 'key.separator=|', '--timeout-ms', '5000']);
  return saida.split('\n').filter((l) => l.startsWith(`${pedidoId}|`)).map((l) => {
    const i = l.indexOf('|');
    return { chave: l.slice(0, i), evento: JSON.parse(l.slice(i + 1)) };
  });
}

function republicar(topico, chave, evento) {
  kafka(['/opt/kafka/bin/kafka-console-producer.sh', '--bootstrap-server', 'localhost:9092', '--topic', topico,
    '--property', 'parse.key=true', '--property', 'key.separator=|'], `${chave}|${JSON.stringify(evento)}\n`);
}

test('Kafka: envelope { id, tipo, pedidoId, ocorridoEm, correlationId, dados }, chave = id do pedido, mesmo correlationId em todos', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  const r = await comprar(cliente, p.id);
  const requestId = r.headers.get('x-request-id');
  await esperarPedido(cliente, r.body.id);
  await esperar(1000);

  const eventos = [...lerTopico('pedidos', r.body.id), ...lerTopico('estoque', r.body.id), ...lerTopico('pagamentos', r.body.id)];
  const tipos = eventos.map((e) => e.evento.tipo).sort();
  assert.deepEqual(tipos, ['estoque.reservado', 'pagamento.aprovado', 'pedido.criado']);
  for (const { chave, evento } of eventos) {
    assert.equal(chave, r.body.id, 'chave = id do pedido');
    assert.deepEqual(Object.keys(evento).sort(), ['correlationId', 'dados', 'id', 'ocorridoEm', 'pedidoId', 'tipo']);
    assert.equal(evento.pedidoId, r.body.id);
    assert.equal(evento.correlationId, requestId, 'correlationId = X-Request-Id do Kong');
    assert.ok(!Number.isNaN(Date.parse(evento.ocorridoEm)));
    assert.doesNotMatch(JSON.stringify(evento), /4111\s?1111/, 'o número do cartão nunca vai no evento');
  }
});

test('idempotência: o mesmo pedido.criado e o mesmo estoque.reservado entregues de novo não reservam nem cobram duas vezes', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin, { estoque: 10 });
  const r = await comprar(cliente, p.id, 2);
  await esperarPedido(cliente, r.body.id);
  await esperar(1000);
  const antes = (await produto(p.id)).estoque;
  const pagAntes = (await req('GET', `/pagamentos/${r.body.id}`, { token: cliente })).body;

  // reentrega (como num rebalanceamento ou num replay): os mesmos eventos, com o mesmo id
  for (const { evento } of lerTopico('pedidos', r.body.id).filter((e) => e.evento.tipo === 'pedido.criado')) republicar('pedidos', r.body.id, evento);
  for (const { evento } of lerTopico('estoque', r.body.id).filter((e) => e.evento.tipo === 'estoque.reservado')) republicar('estoque', r.body.id, evento);
  await esperar(3000);

  assert.deepEqual((await produto(p.id)).estoque, antes, 'estoque não mudou');
  const pagDepois = (await req('GET', `/pagamentos/${r.body.id}`, { token: cliente })).body;
  assert.equal(pagDepois.status, 'APROVADO');
  assert.equal(pagDepois.codigo_transacao, pagAntes.codigo_transacao, 'não cobrou de novo');
  assert.equal(pagDepois.id, pagAntes.id, 'uma linha só (pedido_id UNIQUE)');
  const logs = compose('logs --no-log-prefix catalogo pagamentos');
  assert.match(logs, new RegExp(`pedido.criado repetido.*pedido=${r.body.id}`));
  assert.match(logs, new RegExp(`estoque.reservado ignorado.*pedido=${r.body.id}`));
});

test('eventos fora de ordem entre tópicos: pagamento.aprovado antes de estoque.reservado ainda termina em PAGO', async () => {
  // Um pedido "parado" em AGUARDANDO_ESTOQUE, direto no banco do pedidos (ninguém mais conhece este id).
  const cliente = await loginCliente();
  const { body: me } = await req('GET', '/usuarios/me', { token: cliente });
  const sql = `INSERT INTO pedidos (usuario_id, cliente_email, valor_total, endereco_entrega, forma_pagamento)
               VALUES ('${me.id}', 'cliente@loja.com', 10, '{}', 'pix') RETURNING id`;
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'pedidos-db', 'psql', '-U', 'pedidos', '-tA', '-c', sql], { cwd: `${__dirname}/..`, encoding: 'utf8' });
  const pedidoId = r.stdout.trim().split('\n')[0];
  assert.match(pedidoId, /^[0-9a-f-]{36}$/, r.stderr);

  const envelope = (tipo, topicoDados) => ({
    id: crypto.randomUUID(), tipo, pedidoId, ocorridoEm: new Date().toISOString(), correlationId: crypto.randomUUID(), dados: topicoDados,
  });
  // a ordem "errada": primeiro o pagamento, depois a reserva
  republicar('pagamentos', pedidoId, envelope('pagamento.aprovado', { usuarioId: me.id, valor: 10, codigoTransacao: 'TX-ORDEM' }));
  await ate(async () => (await req('GET', `/pedidos/${pedidoId}`, { token: cliente })).body.status === 'PAGO', 10000);
  republicar('estoque', pedidoId, envelope('estoque.reservado', { usuarioId: me.id, itens: [], valorTotal: 10, formaPagamento: 'pix' }));
  await esperar(2000);
  assert.equal((await req('GET', `/pedidos/${pedidoId}`, { token: cliente })).body.status, 'PAGO', 'o estoque.reservado atrasado não leva o pedido para trás');
});

test('logs: um grep pelo X-Request-Id mostra a compra passando por 4 serviços; nada de senha, token ou cartão', async () => {
  const cliente = await loginCliente();
  const admin = await loginAdmin();
  const p = await criarProduto(admin);
  const r = await comprar(cliente, p.id, 1, { formaPagamento: 'cartao', cartao: { numero: '4111 1111 1111 1111' } });
  const id = r.headers.get('x-request-id');
  await esperarPedido(cliente, r.body.id);
  await esperar(1500);
  const logs = compose(`logs --no-log-prefix ${LOGS_SERVICOS}`);
  const daCompra = logs.split('\n').filter((l) => l.includes(id));
  const servicos = new Set(daCompra.map((l) => (l.match(/^\[(\w+)\]/) || [])[1]).filter(Boolean));
  for (const s of ['pedidos', 'catalogo', 'pagamentos', 'notificacoes']) assert.ok(servicos.has(s), `${s} no grep: ${[...servicos]}`);
  assert.ok(daCompra.every((l) => l.includes(`pedido=${r.body.id}`) || /^\[\w+\] (GET|POST|PUT|PATCH|DELETE) /.test(l)), 'linhas de evento trazem o pedidoId');
  const nossos = logs.split('\n').filter((l) => /^\[(usuarios|catalogo|pedidos|pagamentos|notificacoes|banco-falso)\]/.test(l));
  assert.ok(!nossos.some((l) => /@loja\.com|cliente123|admin123|eyJhbGci|4111\s?1111\s?1111/.test(l)), 'nada sensível nos logs');
  assert.ok(!nossos.some((l) => /GET \/health/.test(l)), 'o /health fica fora do log');
});

test('Kafka: depois de tudo processado, o lag de todos os grupos é zero', async () => {
  const ok = await ate(async () => {
    const saida = kafka(['/opt/kafka/bin/kafka-consumer-groups.sh', '--bootstrap-server', 'localhost:9092', '--describe', '--all-groups']);
    const linhas = saida.split('\n').filter((l) => /^(pedidos|catalogo|pagamentos|notificacoes)\s/.test(l));
    const grupos = new Set(linhas.map((l) => l.split(/\s+/)[0]));
    const lag = linhas.reduce((soma, l) => soma + (Number(l.split(/\s+/)[5]) || 0), 0);
    return grupos.size === 4 && lag === 0;
  }, 20000);
  assert.ok(ok, 'os 4 consumer groups existem e não há mensagem esperando');
});
