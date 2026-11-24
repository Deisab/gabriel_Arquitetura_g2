const { ErroHttp } = require('./erros');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// pedidos não sabe o que é JWT: quem valida o token é o gateway, que injeta X-User-*.
// O serviço confia nesses cabeçalhos porque só o gateway alcança o serviço (nenhuma porta publicada).
function identificar(req, res, next) {
  const id = req.get('x-user-id');
  if (!id || !UUID.test(id)) {
    return next(new ErroHttp(401, 'Faça login. Envie o cabeçalho Authorization: Bearer <token>.'));
  }

  req.usuario = { id, email: req.get('x-user-email') || '', perfil: req.get('x-user-role') };
  next();
}

module.exports = { UUID, identificar };
