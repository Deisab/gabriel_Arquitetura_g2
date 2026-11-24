// Cache da vitrine no Redis: cache-aside com versão.
//   catalogo:versao             7
//   catalogo:v7:produtos:...    a resposta inteira de uma listagem (cada filtro é uma chave)
//   catalogo:v7:produto:<id>    o detalhe de um produto
//   catalogo:v7:categorias      a lista de categorias
// Toda escrita faz INCR em catalogo:versao: as chaves antigas param de ser lidas e vencem pelo TTL.
// O cache acelera, não sustenta: com o Redis fora, tudo vai direto ao Mongo (X-Cache: OFF).
const Redis = require('ioredis');

const TTL_SEGUNDOS = Number(process.env.CACHE_TTL_SEGUNDOS) || 60;
const TTL_VERSAO = 24 * 60 * 60;
const CHAVE_VERSAO = 'catalogo:versao';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: false,
  enableOfflineQueue: false, // Redis fora: erro na hora, em vez de enfileirar e esperar
  maxRetriesPerRequest: 0,
  connectTimeout: 1000,
  commandTimeout: 500,
  retryStrategy: (vezes) => Math.min(vezes * 500, 5000), // continua tentando reconectar em segundo plano
});

let avisouQueda = false;
redis.on('ready', () => {
  avisouQueda = false;
  console.log('[catalogo] cache: Redis conectado');
});
redis.on('error', (err) => {
  if (!avisouQueda) console.warn(`[catalogo] cache: Redis indisponível (${err.message}); a vitrine segue direto no Mongo (X-Cache: OFF)`);
  avisouQueda = true;
});

const versao = async () => (await redis.get(CHAVE_VERSAO)) || '0';

// Procura no cache. Achou: HIT. Não achou: busca no banco e guarda com TTL (MISS). Redis fora: OFF.
async function lerOuBuscar(nome, buscar) {
  let chave;
  try {
    chave = `catalogo:v${await versao()}:${nome}`;
    const guardado = await redis.get(chave);
    if (guardado) return { valor: JSON.parse(guardado), cache: 'HIT' };
  } catch {
    return { valor: await buscar(), cache: 'OFF' };
  }

  const valor = await buscar();
  try {
    // Toda chave com TTL: se a invalidação falhar, o dado velho dura no máximo isso.
    await redis.set(chave, JSON.stringify(valor), 'EX', TTL_SEGUNDOS);
  } catch {
    return { valor, cache: 'OFF' };
  }
  return { valor, cache: 'MISS' };
}

// Invalidação: uma escrita (produto, categoria, estoque) muda a versão. Não apaga nada:
// muda o NOME que o código procura. Redis fora: sem problema, o TTL limita o estrago.
async function invalidar(motivo) {
  try {
    const nova = await redis.incr(CHAVE_VERSAO);
    await redis.expire(CHAVE_VERSAO, TTL_VERSAO);
    console.log(`[catalogo] cache invalidado (${motivo}): versão ${nova}`);
  } catch (err) {
    console.warn(`[catalogo] cache: não consegui invalidar (${motivo}): ${err.message}`);
  }
}

const redisOk = () => redis.ping().then(() => true, () => false);
const fechar = () => redis.quit().catch(() => redis.disconnect());

module.exports = { lerOuBuscar, invalidar, redisOk, fechar };
