const { ErroHttp } = require('./erros');

// Quem valida o token e o perfil é o gateway (jwt + acl): cliente recebe 403 lá e nem chega aqui.
// O catálogo só lê o X-User-Role que o Kong injetou. Esta checagem é a segunda linha de defesa.
function exigirAdmin(req, res, next) {
  if (!req.get('x-user-id')) {
    return next(new ErroHttp(401, 'Faça login. Envie o cabeçalho Authorization: Bearer <token>.'));
  }
  if (req.get('x-user-role') !== 'admin') {
    return next(new ErroHttp(403, 'Acesso restrito a administradores.'));
  }
  next();
}

module.exports = { exigirAdmin };
