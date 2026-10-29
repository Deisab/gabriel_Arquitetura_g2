// Chamada síncrona ao catálogo: direto pela rede interna, sem passar pelo gateway (o gateway é a porta de fora).
const { ErroHttp } = require('./erros');

const CATALOGO_URL_PADRAO = 'http://catalogo:3002';
const TIMEOUT_MS = Number(process.env.CATALOGO_TIMEOUT_MS) || 3000;

// Acoplamento temporal: para vender, o catálogo precisa estar no ar naquele instante. Se não estiver: 503.
class CatalogoIndisponivel extends ErroHttp {
  constructor(causa) {
    super(503, 'Catálogo indisponível no momento. Tente de novo em instantes.');
    this.cause = causa;
  }
}

// Um pedido só para todos os produtos do carrinho (?ids=a,b,c), não um por produto.
// Timeout: sem ele, um catálogo travado trava o checkout junto.
// Devolve um Map produto_id -> produto. Produto que não existe fica de fora do Map.
async function buscarProdutos(ids, requestId) {
  if (ids.length === 0) return new Map();

  let lista;
  try {
    const url = `${process.env.CATALOGO_URL || CATALOGO_URL_PADRAO}/produtos?ids=${ids.map(encodeURIComponent).join(',')}`;
    const r = await fetch(url, {
      headers: requestId ? { 'x-request-id': requestId } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`catálogo respondeu ${r.status}`);
    lista = await r.json();
  } catch (err) {
    console.error(`Falha ao chamar o catálogo: ${err.message}`);
    throw new CatalogoIndisponivel(err); // vira 503
  }

  return new Map(lista.map((produto) => [produto.id, produto]));
}

module.exports = { buscarProdutos, CatalogoIndisponivel };
