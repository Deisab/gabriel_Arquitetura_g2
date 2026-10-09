// Formato único de erro: { erro, detalhes? } (o mesmo do serviço de usuarios)
class ErroHttp extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

function rotaNaoEncontrada(req, res) {
  res.status(404).json({ erro: 'Rota não encontrada.' });
}

// Express reconhece o middleware de erro pelos 4 parâmetros.
// eslint-disable-next-line no-unused-vars
function tratarErros(err, req, res, next) {
  if (err instanceof ErroHttp) {
    const corpo = { erro: err.message };
    if (err.detalhes && err.detalhes.length > 0) corpo.detalhes = err.detalhes;
    return res.status(err.status).json(corpo);
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido no corpo da requisição.' });
  }

  // Última linha de defesa: índice único que escapou da validação.
  if (err.code === 11000) {
    return res.status(409).json({ erro: 'Registro já existe.' });
  }

  // Nunca devolver stack trace nem mensagem do banco para o cliente.
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { ErroHttp, rotaNaoEncontrada, tratarErros };
