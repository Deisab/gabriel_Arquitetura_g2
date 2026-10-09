const { produtos, categorias } = require('../src/db');

const CATEGORIAS = [
  { nome: 'Celulares', slug: 'celulares' },
  { nome: 'Roupas', slug: 'roupas' },
  { nome: 'Livros', slug: 'livros' },
];

// Mesmo formato, atributos diferentes por categoria: é por isso que o catálogo está no Mongo.
const PRODUTOS = [
  { sku: 'CEL-001', nome: 'Smartphone X', categoria: 'celulares', preco: 2499.9, ativo: true,
    atributos: { memoria: '128GB', cor: 'preto' }, estoque: { disponivel: 10, reservado: 0 } },
  { sku: 'CEL-002', nome: 'Smartphone X Pro', categoria: 'celulares', preco: 3999.9, ativo: true,
    atributos: { memoria: '256GB', cor: 'azul' }, estoque: { disponivel: 5, reservado: 0 } },
  { sku: 'CEL-003', nome: 'Smartphone Lite', categoria: 'celulares', preco: 1299.0, ativo: true,
    atributos: { memoria: '64GB', cor: 'branco' }, estoque: { disponivel: 25, reservado: 0 } },
  { sku: 'CEL-004', nome: 'Smartphone Fold', categoria: 'celulares', preco: 7999.0, ativo: true,
    atributos: { memoria: '512GB', cor: 'grafite', telaDobravel: true }, estoque: { disponivel: 2, reservado: 0 } },
  { sku: 'CEL-005', nome: 'Smartphone Antigo', categoria: 'celulares', preco: 499.0, ativo: false,
    atributos: { memoria: '32GB', cor: 'prata' }, estoque: { disponivel: 0, reservado: 0 } },

  { sku: 'CAM-010', nome: 'Camiseta básica', categoria: 'roupas', preco: 59.9, ativo: true,
    atributos: { tamanho: 'M', tecido: 'algodão' }, estoque: { disponivel: 40, reservado: 0 } },
  { sku: 'CAM-011', nome: 'Camiseta polo', categoria: 'roupas', preco: 89.9, ativo: true,
    atributos: { tamanho: 'G', tecido: 'piquet' }, estoque: { disponivel: 30, reservado: 0 } },
  { sku: 'CAL-020', nome: 'Calça jeans', categoria: 'roupas', preco: 149.9, ativo: true,
    atributos: { tamanho: '42', tecido: 'jeans', modelagem: 'reta' }, estoque: { disponivel: 20, reservado: 0 } },
  { sku: 'JAQ-030', nome: 'Jaqueta corta-vento', categoria: 'roupas', preco: 199.9, ativo: true,
    atributos: { tamanho: 'M', tecido: 'poliéster', impermeavel: true }, estoque: { disponivel: 12, reservado: 0 } },

  { sku: 'LIV-100', nome: 'Java: Como Programar', categoria: 'livros', preco: 289.0, ativo: true,
    atributos: { autor: 'Paul Deitel', paginas: 968 }, estoque: { disponivel: 8, reservado: 0 } },
  { sku: 'LIV-101', nome: 'Arquitetura Limpa', categoria: 'livros', preco: 99.9, ativo: true,
    atributos: { autor: 'Robert C. Martin', paginas: 432 }, estoque: { disponivel: 15, reservado: 0 } },
  { sku: 'LIV-102', nome: 'Código Limpo', categoria: 'livros', preco: 94.9, ativo: true,
    atributos: { autor: 'Robert C. Martin', paginas: 425 }, estoque: { disponivel: 15, reservado: 0 } },
  { sku: 'LIV-103', nome: 'Domain-Driven Design', categoria: 'livros', preco: 159.0, ativo: true,
    atributos: { autor: 'Eric Evans', paginas: 528 }, estoque: { disponivel: 6, reservado: 0 } },
  { sku: 'LIV-104', nome: 'Microsserviços Prontos para a Produção', categoria: 'livros', preco: 79.9, ativo: true,
    atributos: { autor: 'Susan J. Fowler', paginas: 224 }, estoque: { disponivel: 10, reservado: 0 } },
];

// Idempotente: upsert com $setOnInsert só insere o que ainda não existe e
// não sobrescreve preço ou estoque que alguém já alterou pela API.
async function seed() {
  for (const { slug, ...resto } of CATEGORIAS) {
    await categorias().updateOne({ slug }, { $setOnInsert: resto }, { upsert: true });
  }
  for (const { sku, ...resto } of PRODUTOS) {
    await produtos().updateOne({ sku }, { $setOnInsert: resto }, { upsert: true });
  }
  console.log('Seed de catalogo aplicado.');
}

module.exports = { seed };

// Permite rodar sozinho: npm run seed
if (require.main === module) {
  const { conectar, fechar } = require('../src/db');
  conectar()
    .then(seed)
    .then(fechar)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
