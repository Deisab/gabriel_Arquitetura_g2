// Roda os arquivos de teste um por vez, em ordem (01, 02, ...): os de infraestrutura param e religam containers,
// e o de rate limit gasta o limite de login. Uso: node rodar.js            (todos)
//                                              node rodar.js 04 05      (só os que começam com 04 e 05)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const filtros = process.argv.slice(2);
const arquivos = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => filtros.length === 0 || filtros.some((x) => f.startsWith(x)))
  .sort();

// Antes de tudo: espera o sistema ficar pronto (gateway respondendo e os 4 /health ok), até 3 minutos.
// Logo depois de um "docker compose up -d", o Kong e o Kafka ainda podem estar subindo.
function sistemaPronto() {
  const r = spawnSync(process.execPath, ['-e', `
    Promise.all(['usuarios','catalogo','pedidos','pagamentos'].map((s) =>
      fetch('http://localhost:8080/health/' + s).then((r) => r.json()).then((b) => b.status === 'ok')))
      .then((l) => process.exit(l.every(Boolean) ? 0 : 1), () => process.exit(1));`]);
  return r.status === 0;
}
const prazo = Date.now() + 180000;
process.stdout.write('Esperando o sistema ficar pronto (http://localhost:8080/health/*)');
while (!sistemaPronto()) {
  if (Date.now() > prazo) {
    console.log('\nO sistema não ficou pronto em 3 minutos. Rode "docker compose up -d --build" e confira "docker compose ps".');
    process.exit(1);
  }
  process.stdout.write('.');
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
}
console.log(' pronto.');

const resultados = [];
const inicio = Date.now();
for (const arquivo of arquivos) {
  console.log(`\n========== ${arquivo} ==========`);
  const t = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(__dirname, arquivo)], { stdio: 'inherit' });
  resultados.push({ arquivo, ok: r.status === 0, segundos: Math.round((Date.now() - t) / 1000) });
}

console.log('\n========== RESUMO ==========');
for (const { arquivo, ok, segundos } of resultados) console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${arquivo}  (${segundos} s)`);
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} arquivos passaram em ${Math.round((Date.now() - inicio) / 1000)} s`);
process.exit(falhas ? 1 : 0);
