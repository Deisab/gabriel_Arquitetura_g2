// banco-falso: o banco do cartão, um sistema que NÃO é nosso. Fora do Kong, com porta própria (9000).
// Sem banco de dados: guarda as cobranças em memória (somem quando o container reinicia).
const crypto = require('node:crypto');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Ajustáveis ao vivo por POST /config, para provocar falhas de propósito.
const config = { latenciaMs: 0, falhaPercent: 0 };

// referencia (id do pedido) -> cobrança. É a chave de idempotência: a mesma referência não cobra duas vezes.
const cobrancas = new Map();

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reais = (valor) => `R$ ${Number(valor).toFixed(2)}`;
const log = (texto) => console.log(`[banco-falso] ${texto}`);

app.get('/health', (req, res) => res.json({ servico: 'banco-falso', status: 'ok', dependencias: {}, config }));

app.get('/config', (req, res) => res.json(config));

// POST /config { latenciaMs, falhaPercent } (os dois opcionais)
app.post('/config', (req, res) => {
  const { latenciaMs, falhaPercent } = req.body ?? {};
  const detalhes = [];
  if (latenciaMs !== undefined && (!Number.isInteger(latenciaMs) || latenciaMs < 0 || latenciaMs > 60000)) {
    detalhes.push('latenciaMs deve ser um inteiro entre 0 e 60000');
  }
  if (falhaPercent !== undefined && (!Number.isInteger(falhaPercent) || falhaPercent < 0 || falhaPercent > 100)) {
    detalhes.push('falhaPercent deve ser um inteiro entre 0 e 100');
  }
  if (detalhes.length > 0) return res.status(400).json({ erro: 'Dados inválidos.', detalhes });

  if (latenciaMs !== undefined) config.latenciaMs = latenciaMs;
  if (falhaPercent !== undefined) config.falhaPercent = falhaPercent;
  log(`config: latência ${config.latenciaMs} ms, falha ${config.falhaPercent}%`);
  res.json(config);
});

// POST /cobrancas { valor, cartaoFinal?, referencia, forma? }
// 201 { aprovado: true, codigo } · 402 { aprovado: false, motivo } (cartão final 0002) · 503 (falhaPercent)
app.post('/cobrancas', async (req, res) => {
  const { valor, cartaoFinal, referencia, forma } = req.body ?? {};
  if (typeof valor !== 'number' || valor <= 0 || typeof referencia !== 'string' || !referencia) {
    return res.status(400).json({ erro: 'Dados inválidos.', detalhes: ['valor (> 0) e referencia são obrigatórios'] });
  }

  // Falha passageira: o banco nem processou.
  if (Math.random() * 100 < config.falhaPercent) {
    await esperar(config.latenciaMs);
    log(`cobrança ${referencia}: 503 (falha simulada)`);
    return res.status(503).json({ erro: 'Banco indisponível. Tente de novo.' });
  }

  // Já vi essa referência? Devolve a mesma resposta, sem cobrar de novo.
  let cobranca = cobrancas.get(referencia);
  if (cobranca) {
    log(`cobrança ${referencia} REPETIDA: devolvendo a mesma (${cobranca.codigo || cobranca.motivo}), sem cobrar de novo`);
  } else if (cartaoFinal === '0002') {
    cobranca = { referencia, valor, aprovado: false, motivo: 'saldo insuficiente' };
    cobrancas.set(referencia, cobranca);
    log(`cobrança ${referencia} de ${reais(valor)}: RECUSADA (saldo insuficiente)`);
  } else {
    const codigo = `TX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    cobranca = { referencia, valor, forma: forma || 'cartao', aprovado: true, codigo, estornada: false };
    cobrancas.set(referencia, cobranca);
    log(`cobrança ${referencia} de ${reais(valor)}: aprovada (${codigo})`);
  }

  // A cobrança já foi feita (ou recusada) ANTES da espera: com latência acima do timeout de quem chama,
  // o banco cobra e só a resposta não chega a tempo. Timeout não quer dizer "não aconteceu".
  await esperar(config.latenciaMs);

  if (!cobranca.aprovado) return res.status(402).json({ aprovado: false, motivo: cobranca.motivo });
  res.status(201).json({ aprovado: true, codigo: cobranca.codigo });
});

// POST /estornos { codigo?, referencia } -> 201; 404 se não há cobrança aprovada com essa referência.
// Idempotente: estornar de novo devolve 201 sem estornar duas vezes.
app.post('/estornos', async (req, res) => {
  const { codigo, referencia } = req.body ?? {};
  const cobranca = cobrancas.get(referencia);
  if (!cobranca || !cobranca.aprovado || (codigo && cobranca.codigo !== codigo)) {
    log(`estorno ${referencia}: nenhuma cobrança aprovada (404)`);
    return res.status(404).json({ erro: 'Cobrança não encontrada.' });
  }
  if (cobranca.estornada) {
    log(`estorno ${referencia} REPETIDO (${cobranca.codigo}): já estava estornada`);
  } else {
    cobranca.estornada = true;
    log(`ESTORNO da cobrança ${cobranca.codigo} (pedido ${referencia}, ${reais(cobranca.valor)})`);
  }
  res.status(201).json({ estornado: true, codigo: cobranca.codigo });
});

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

const porta = Number(process.env.PORT) || 3000;
const servidor = app.listen(porta, () => log(`ouvindo na porta ${porta}`));
for (const sinal of ['SIGTERM', 'SIGINT']) process.once(sinal, () => servidor.close(() => process.exit(0)));
