const { MongoClient } = require('mongodb');

const URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const NOME_BANCO = process.env.MONGO_DB || 'catalogo';

let cliente;
let db;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function conectar(tentativas = 30) {
  for (let i = 1; ; i++) {
    cliente = new MongoClient(URL, { serverSelectionTimeoutMS: 5000 });
    try {
      await cliente.connect();
      break;
    } catch (err) {
      await cliente.close().catch(() => {});
      if (i >= tentativas) throw err;
      console.log(`Aguardando o Mongo (${i}/${tentativas})...`);
      await esperar(2000);
    }
  }

  db = cliente.db(NOME_BANCO);
  await criarIndices();
}

// Sem schema no Mongo, as garantias ficam nos índices: SKU e slug não repetem.
async function criarIndices() {
  await db.collection('produtos').createIndexes([
    { key: { sku: 1 }, name: 'sku_unico', unique: true },
    { key: { categoria: 1 }, name: 'categoria' },
  ]);
  await db.collection('categorias').createIndex({ slug: 1 }, { name: 'slug_unico', unique: true });
}

const produtos = () => db.collection('produtos');
const categorias = () => db.collection('categorias');
const ping = () => db.command({ ping: 1 });
const fechar = () => cliente.close();

module.exports = { conectar, produtos, categorias, ping, fechar };
