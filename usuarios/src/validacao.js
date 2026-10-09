const { ErroHttp } = require('./erros');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CEP = /^\d{5}-?\d{3}$/;
const UF = /^[A-Za-z]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function falhar(detalhes) {
  if (detalhes.length > 0) throw new ErroHttp(400, 'Dados inválidos.', detalhes);
}

// Cadastro (senha obrigatória) e PUT /usuarios/me (senha opcional: só troca se vier).
function validarUsuario(corpo, { senhaObrigatoria }) {
  const detalhes = [];
  const nome = texto(corpo.nome);
  const email = texto(corpo.email).toLowerCase();
  const senha = corpo.senha ?? undefined;

  if (!nome) detalhes.push('nome é obrigatório');
  if (!email) detalhes.push('email é obrigatório');
  else if (!EMAIL.test(email)) detalhes.push('email inválido');

  if (senha === undefined) {
    if (senhaObrigatoria) detalhes.push('senha é obrigatória');
  } else if (typeof senha !== 'string' || senha.length < 6) {
    detalhes.push('senha deve ter pelo menos 6 caracteres');
  }

  falhar(detalhes);
  return { nome, email, senha };
}

function validarEndereco(corpo) {
  const detalhes = [];
  const cep = texto(corpo.cep);
  const logradouro = texto(corpo.logradouro);
  const cidade = texto(corpo.cidade);
  const uf = texto(corpo.uf).toUpperCase();
  const principal = corpo.principal ?? false;

  if (!cep) detalhes.push('cep é obrigatório');
  else if (!CEP.test(cep)) detalhes.push('cep deve ter 8 dígitos (ex.: 97010-000)');
  if (!logradouro) detalhes.push('logradouro é obrigatório');
  if (!cidade) detalhes.push('cidade é obrigatória');
  if (!uf) detalhes.push('uf é obrigatória');
  else if (!UF.test(uf)) detalhes.push('uf deve ter 2 letras (ex.: RS)');
  if (typeof principal !== 'boolean') detalhes.push('principal deve ser true ou false');

  falhar(detalhes);

  const digitos = cep.replace('-', '');
  return {
    apelido: texto(corpo.apelido) || null,
    cep: `${digitos.slice(0, 5)}-${digitos.slice(5)}`,
    logradouro,
    numero: texto(corpo.numero) || null,
    complemento: texto(corpo.complemento) || null,
    cidade,
    uf,
    principal,
  };
}

module.exports = { UUID, validarUsuario, validarEndereco };
