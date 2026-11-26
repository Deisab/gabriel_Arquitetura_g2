// Por último: gasta o limite de login do minuto (os outros arquivos reaproveitam tokens guardados).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { req } = require('./util');

test('rate limiting no login: 10 por minuto por IP; depois, 429 do Kong', async () => {
  // O Kong conta por minuto do relógio (janela fixa). 22 tentativas garantem pelo menos 11 dentro do mesmo minuto,
  // mesmo que a sequência atravesse a virada de um minuto para o outro.
  const respostas = [];
  for (let i = 0; i < 22; i++) {
    respostas.push(await req('POST', '/auth/login', { corpo: { email: 'cliente@loja.com', senha: 'senha-errada' } }));
  }
  const status = respostas.map((r) => r.status);
  assert.ok(status.includes(429), `esperado 429 em algum momento: ${status}`);
  assert.ok(status.every((s) => s === 401 || s === 429), 'só 401 (senha errada) ou 429 (limite)');
  const bloqueada = respostas.find((r) => r.status === 429);
  assert.equal(bloqueada.body.message, 'API rate limit exceeded');
  assert.equal(bloqueada.headers.get('x-ratelimit-remaining-minute'), '0');
  assert.equal(respostas[0].headers.get('x-ratelimit-limit-minute'), '10');
  // o limite é só do login: as outras rotas seguem
  assert.equal((await req('GET', '/produtos')).status, 200);
});
