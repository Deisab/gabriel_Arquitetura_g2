// Utilidades dos testes automatizados. Tudo passa pelo gateway (http://localhost:8080), como um cliente de verdade.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const BANCO = process.env.BANCO_URL || 'http://localhost:9000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const RAIZ = path.join(__dirname, '..');

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function req(metodo, caminho, { corpo, token, headers = {}, base = BASE } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: {
      ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: corpo !== undefined ? (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) : undefined,
  });
  const texto = await r.text();
  let body = texto;
  try { body = texto ? JSON.parse(texto) : null; } catch { /* texto puro */ }
  return { status: r.status, body, headers: r.headers };
}

// O login aceita 10 tentativas por minuto por IP (rate limiting no Kong). Para a suíte não estourar o limite,
// os tokens (válidos por 2 h) ficam guardados num arquivo temporário e são reaproveitados entre os arquivos de teste.
const CACHE_TOKENS = path.join(os.tmpdir(), 'g2-testes-tokens.json');

function lerCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_TOKENS, 'utf8')); } catch { return {}; }
}

function expiraEm(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000; } catch { return 0; }
}

async function login(email, senha) {
  const cache = lerCache();
  const guardado = cache[email];
  if (guardado && expiraEm(guardado) - Date.now() > 10 * 60 * 1000) {
    // Confere que o token ainda vale neste sistema (o segredo pode ter mudado, ou o banco ter sido recriado).
    const r = await req('GET', '/usuarios/me', { token: guardado });
    if (r.status === 200) return guardado;
  }
  for (let tentativa = 1; ; tentativa++) {
    const r = await req('POST', '/auth/login', { corpo: { email, senha } });
    if (r.status === 200) {
      cache[email] = r.body.token;
      fs.writeFileSync(CACHE_TOKENS, JSON.stringify(cache));
      return r.body.token;
    }
    if (r.status !== 429 || tentativa > 7) throw new Error(`login de ${email} falhou: ${r.status} ${JSON.stringify(r.body)}`);
    await esperar(10000); // limite de login: espera a janela de 1 minuto passar
  }
}

const loginCliente = () => login('cliente@loja.com', 'cliente123');
const loginAdmin = () => login('admin@loja.com', 'admin123');

// Um usuário fixo da suíte (criado na primeira vez): serve para "pedido de outra pessoa" sem gastar logins.
async function loginOutro() {
  const email = 'outro.testes@loja.com';
  await req('POST', '/usuarios', { corpo: { nome: 'Outra Pessoa', email, senha: 'segredo123' } }); // 201 ou 409
  return login(email, 'segredo123');
}

// Produto próprio do teste, com estoque grande: os testes não dependem do estoque do seed nem o esgotam.
async function criarProduto(admin, { estoque = 1000, preco = 10, categoria = 'livros', nome } = {}) {
  const sku = `TESTE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await req('POST', '/produtos', {
    token: admin,
    corpo: { sku, nome: nome || `Produto de teste ${sku}`, categoria, preco, atributos: { teste: true }, estoque: { disponivel: estoque } },
  });
  if (r.status !== 201) throw new Error(`criar produto: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const ENDERECO = { cep: '97010-000', logradouro: 'Rua do Acampamento', numero: '100', cidade: 'Santa Maria', uf: 'RS' };

async function comprar(token, produtoId, quantidade = 1, pagamento = { formaPagamento: 'pix' }) {
  const c = await req('POST', '/carrinho/itens', { token, corpo: { produtoId, quantidade } });
  if (c.status !== 201) throw new Error(`carrinho: ${c.status} ${JSON.stringify(c.body)}`);
  return req('POST', '/pedidos', { token, corpo: { enderecoEntrega: ENDERECO, ...pagamento } });
}

// Consistência eventual: consulta até o pedido chegar a um dos status esperados.
async function esperarPedido(token, id, alvos = ['PAGO', 'CANCELADO'], ms = 30000) {
  const fim = Date.now() + ms;
  let pedido;
  while (Date.now() < fim) {
    pedido = (await req('GET', `/pedidos/${id}`, { token })).body;
    if (alvos.includes(pedido.status)) return pedido;
    await esperar(300);
  }
  return pedido;
}

async function esperarPagamento(token, pedidoId, alvos, ms = 30000) {
  const fim = Date.now() + ms;
  let pag;
  while (Date.now() < fim) {
    const r = await req('GET', `/pagamentos/${pedidoId}`, { token });
    pag = r.body;
    if (r.status === 200 && alvos.includes(pag.status)) return pag;
    await esperar(300);
  }
  return pag;
}

async function produto(id) {
  return (await req('GET', `/produtos/${id}`)).body;
}

// Espera uma condição ficar verdadeira (eventos levam alguns milissegundos para chegar).
async function ate(condicao, ms = 15000) {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await condicao();
    if (ultimo) return ultimo;
    await esperar(300);
  }
  return ultimo;
}

async function emails(pedidoId) {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(pedidoId.slice(0, 8))}`);
  const j = await r.json();
  return j.messages.map((m) => m.Subject);
}

const configBanco = (config) => req('POST', '/config', { base: BANCO, corpo: config });

function compose(args) {
  return execSync(`docker compose ${args}`, { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

module.exports = {
  BASE, BANCO, MAILPIT, ENDERECO, req, esperar, ate, login, loginCliente, loginAdmin, loginOutro,
  criarProduto, comprar, esperarPedido, esperarPagamento, produto, emails, configBanco, compose,
};
