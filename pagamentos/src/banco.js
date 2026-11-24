// Cliente do banco do cartão (banco-falso): um sistema que não é nosso, que demora, cai e recusa.
// Três padrões, um em volta do outro: timeout por chamada, retry por cima, circuit breaker em volta.
const CircuitBreaker = require('opossum');

const BANCO_URL = process.env.BANCO_URL || 'http://banco-falso:3000';
const TIMEOUT_MS = Number(process.env.BANCO_TIMEOUT_MS) || 2000;
const TENTATIVAS = 3;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ctxLog = (ctx) => `pedido=${ctx.pedidoId} req=${ctx.correlationId}`;

// Falha passageira: timeout, erro de rede ou 5xx. Pode dar certo daqui a pouco.
class FalhaPassageira extends Error {
  constructor(mensagem, { timeout = false } = {}) {
    super(mensagem);
    this.timeout = timeout;
  }
}

async function post(caminho, corpo) {
  try {
    const r = await fetch(`${BANCO_URL}${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS), // não esperar para sempre
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  } catch (err) {
    if (err.name === 'TimeoutError') throw new FalhaPassageira(`sem resposta em ${TIMEOUT_MS} ms (timeout)`, { timeout: true });
    throw new FalhaPassageira(`erro de rede (${err.cause?.code || err.message})`);
  }
}

// Uma chamada ao banco. 201 e 402 são RESPOSTAS (sucesso para o circuito); só falha passageira lança.
// A referência (id do pedido) é a chave de idempotência: o banco não cobra duas vezes a mesma.
async function chamarBanco({ valor, cartaoFinal, referencia, forma }) {
  const { status, json } = await post('/cobrancas', { valor, cartaoFinal, referencia, forma });
  if (status === 201) return { aprovado: true, codigo: json.codigo };
  if (status >= 500) throw new FalhaPassageira(`banco respondeu ${status}`);
  // 402 (saldo insuficiente), 400...: é um "não". Insistir não muda a resposta.
  return { aprovado: false, motivo: json.motivo || `cobrança recusada (${status})` };
}

// Circuit breaker (opossum): abre com 50% de falha em pelo menos 5 chamadas numa janela de 10 s,
// espera 15 s e deixa uma chamada testar (meio-aberto).
const disjuntor = new CircuitBreaker(chamarBanco, {
  timeout: TIMEOUT_MS + 500, // o opossum também corta, um pouco depois do fetch
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 15000,
  rollingCountTimeout: 10000, // janela curta: falhas antigas não reabrem o circuito depois que ele fecha
});
disjuntor.on('open', () => console.warn('[pagamentos] CIRCUITO ABERTO: o banco do cartão está falhando; chamadas recusadas na hora por 15 s'));
disjuntor.on('halfOpen', () => console.warn('[pagamentos] circuito MEIO-ABERTO: deixando uma chamada testar o banco'));
disjuntor.on('close', () => console.log('[pagamentos] circuito FECHADO: o banco voltou'));

function estadoCircuito() {
  if (disjuntor.opened) return 'aberto';
  if (disjuntor.halfOpen) return 'meio-aberto';
  return 'fechado';
}

// Retry: até 3 tentativas, esperando 500 ms e 1 s (com um pouco de jitter), só para falha passageira.
// Com o circuito aberto, nem tenta: não adianta insistir.
// Devolve { aprovado, codigo } | { aprovado: false, motivo } | { erro: true, motivo, timeout }, sempre com tentativas.
async function cobrar(dados, ctx) {
  let ultima;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      const r = await disjuntor.fire(dados);
      console.log(`[pagamentos] tentativa ${tentativa}/${TENTATIVAS}: banco ${r.aprovado ? `aprovou (${r.codigo})` : `recusou (${r.motivo})`} ${ctxLog(ctx)}`);
      return { ...r, tentativas: tentativa };
    } catch (err) {
      if (err.code === 'EOPENBREAKER') {
        console.warn(`[pagamentos] tentativa ${tentativa}/${TENTATIVAS}: circuito aberto, nem chamou o banco ${ctxLog(ctx)}`);
        const motivo = ultima ? `banco indisponível (${ultima.message}; circuito aberto)` : 'banco indisponível (circuito aberto)';
        return { erro: true, motivo, tentativas: tentativa, timeout: ultima?.timeout ?? false };
      }
      ultima = err;
      console.warn(`[pagamentos] tentativa ${tentativa}/${TENTATIVAS} falhou: ${err.message} ${ctxLog(ctx)}`);
      if (tentativa < TENTATIVAS) await esperar(500 * 2 ** (tentativa - 1) + Math.floor(Math.random() * 100));
    }
  }
  return { erro: true, motivo: `banco indisponível (${ultima.message})`, tentativas: TENTATIVAS, timeout: Boolean(ultima.timeout) };
}

// Estorno: sem circuit breaker (devolver dinheiro é importante demais para ser barrado), com retry.
// Idempotente pela referência. 404 = não havia cobrança aprovada: nada a devolver, e tudo bem.
async function estornar({ codigo, referencia }, ctx) {
  let ultima;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      const { status } = await post('/estornos', { codigo, referencia });
      if (status === 201) return 'estornado';
      if (status === 404) return 'nada a estornar';
      throw new FalhaPassageira(`banco respondeu ${status}`);
    } catch (err) {
      ultima = err;
      console.warn(`[pagamentos] estorno tentativa ${tentativa}/${TENTATIVAS} falhou: ${err.message} ${ctxLog(ctx)}`);
      if (tentativa < TENTATIVAS) await esperar(500 * 2 ** (tentativa - 1));
    }
  }
  throw ultima;
}

module.exports = { cobrar, estornar, estadoCircuito };
