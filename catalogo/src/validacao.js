const { ObjectId } = require('mongodb');
const { ErroHttp } = require('./erros');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function ehObjeto(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function falhar(detalhes) {
  if (detalhes.length > 0) throw new ErroHttp(400, 'Dados inválidos.', detalhes);
}

// id que não é ObjectId válido não pode existir: 404, e não 500.
function idDoProduto(id) {
  if (!OBJECT_ID.test(id)) throw new ErroHttp(404, 'Produto não encontrado.');
  return new ObjectId(id);
}

// "Livros Técnicos" -> "livros-tecnicos"
function gerarSlug(valor) {
  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// POST cria com estoque; PUT substitui o produto mas não mexe no estoque (isso é do PATCH).
function validarProduto(corpo, { criando }) {
  const detalhes = [];
  const sku = texto(corpo.sku).toUpperCase();
  const nome = texto(corpo.nome);
  const categoria = texto(corpo.categoria).toLowerCase();
  const { preco, ativo = true, atributos = {} } = corpo;

  if (!sku) detalhes.push('sku é obrigatório');
  if (!nome) detalhes.push('nome é obrigatório');
  if (!categoria) detalhes.push('categoria é obrigatória');
  if (typeof preco !== 'number' || !Number.isFinite(preco)) detalhes.push('preco é obrigatório e deve ser um número');
  else if (preco <= 0) detalhes.push('preco deve ser maior que zero');
  if (typeof ativo !== 'boolean') detalhes.push('ativo deve ser true ou false');
  if (!ehObjeto(atributos)) {
    detalhes.push('atributos deve ser um objeto (ex.: { "cor": "preto" })');
  } else if (Object.keys(atributos).some((chave) => chave.startsWith('$') || chave.includes('.'))) {
    detalhes.push('nomes de atributos não podem começar com $ nem conter ponto');
  }

  let estoque;
  if (criando) {
    const disponivel = corpo.estoque?.disponivel ?? 0;
    if (!Number.isInteger(disponivel) || disponivel < 0) {
      detalhes.push('estoque.disponivel deve ser um inteiro maior ou igual a zero');
    }
    estoque = { disponivel, reservado: 0 };
  }

  falhar(detalhes);

  const produto = { sku, nome, categoria, preco: Math.round(preco * 100) / 100, ativo, atributos };
  if (criando) produto.estoque = estoque;
  return produto;
}

function validarCategoria(corpo) {
  const detalhes = [];
  const nome = texto(corpo.nome);
  const slug = texto(corpo.slug) || gerarSlug(nome);

  if (!nome) detalhes.push('nome é obrigatório');
  else if (!SLUG.test(slug)) detalhes.push('slug deve ter só letras minúsculas, números e hífens (ex.: livros-tecnicos)');

  falhar(detalhes);
  return { nome, slug };
}

module.exports = { idDoProduto, validarProduto, validarCategoria };
