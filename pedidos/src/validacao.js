const { ErroHttp } = require('./erros');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const CEP = /^\d{5}-?\d{3}$/;
const UF = /^[A-Za-z]{2}$/;
const FORMAS_PAGAMENTO = ['cartao', 'pix', 'boleto'];

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function ehObjeto(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function falhar(detalhes) {
  if (detalhes.length > 0) throw new ErroHttp(400, 'Dados inválidos.', detalhes);
}

// POST /carrinho/itens: { produto_id, quantidade }
function validarItem(corpo) {
  const detalhes = [];
  const produtoId = texto(corpo.produto_id);
  const quantidade = corpo.quantidade ?? 1;

  if (!produtoId) detalhes.push('produto_id é obrigatório');
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 99) {
    detalhes.push('quantidade deve ser um inteiro entre 1 e 99');
  }

  falhar(detalhes);
  return { produtoId, quantidade };
}

// POST /pedidos: { endereco_entrega, forma_pagamento, cartao? }
// Do cartão, só os 4 últimos dígitos saem daqui. O número inteiro nunca é gravado.
function validarCheckout(corpo) {
  const detalhes = [];
  const endereco = corpo.endereco_entrega;
  const formaPagamento = texto(corpo.forma_pagamento).toLowerCase();
  let enderecoEntrega;
  let cartaoFinal = null;

  if (!ehObjeto(endereco)) {
    detalhes.push('endereco_entrega é obrigatório (cep, logradouro, numero, cidade, uf)');
  } else {
    const cep = texto(endereco.cep);
    const logradouro = texto(endereco.logradouro);
    const cidade = texto(endereco.cidade);
    const uf = texto(endereco.uf).toUpperCase();

    if (!cep) detalhes.push('endereco_entrega.cep é obrigatório');
    else if (!CEP.test(cep)) detalhes.push('endereco_entrega.cep deve ter 8 dígitos (ex.: 97010-000)');
    if (!logradouro) detalhes.push('endereco_entrega.logradouro é obrigatório');
    if (!cidade) detalhes.push('endereco_entrega.cidade é obrigatória');
    if (!uf) detalhes.push('endereco_entrega.uf é obrigatória');
    else if (!UF.test(uf)) detalhes.push('endereco_entrega.uf deve ter 2 letras (ex.: RS)');

    const digitos = cep.replace('-', '');
    enderecoEntrega = {
      cep: `${digitos.slice(0, 5)}-${digitos.slice(5)}`,
      logradouro,
      numero: texto(endereco.numero) || null,
      complemento: texto(endereco.complemento) || null,
      cidade,
      uf,
    };
  }

  if (!FORMAS_PAGAMENTO.includes(formaPagamento)) {
    detalhes.push(`forma_pagamento deve ser uma de: ${FORMAS_PAGAMENTO.join(', ')}`);
  } else if (formaPagamento === 'cartao') {
    const numero = texto(corpo.cartao?.numero).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(numero)) detalhes.push('cartao.numero deve ter de 13 a 19 dígitos');
    else cartaoFinal = numero.slice(-4);
  }

  falhar(detalhes);
  return { enderecoEntrega, formaPagamento, cartaoFinal };
}

module.exports = { OBJECT_ID, validarItem, validarCheckout };
