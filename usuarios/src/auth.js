const jwt = require('jsonwebtoken');
const { ErroHttp } = require('./erros');

// usuarios é o único serviço que emite JWT. O perfil vem do banco, no login.
// O Kong usa o campo perfil para achar o consumer (cliente ou admin) e decidir as rotas de admin.
function gerarToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, email: usuario.email, perfil: usuario.perfil },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '2h', issuer: 'usuarios' },
  );
}

// Quem valida o token é o gateway. O serviço confia nos X-User-* que o Kong injeta,
// porque só o gateway alcança o serviço (nenhuma porta publicada).
// Se o cabeçalho não veio, a requisição não passou pelo jwt do gateway: 401.
function autenticar(req, res, next) {
  const id = req.get('x-user-id');
  if (!id) {
    return next(new ErroHttp(401, 'Faça login. Envie o cabeçalho Authorization: Bearer <token>.'));
  }

  req.usuario = { id, email: req.get('x-user-email'), perfil: req.get('x-user-role') };
  next();
}

// O 403 de verdade é do acl no Kong; aqui é só a segunda linha de defesa.
function exigirAdmin(req, res, next) {
  if (req.usuario.perfil !== 'admin') {
    return next(new ErroHttp(403, 'Acesso restrito a administradores.'));
  }
  next();
}

module.exports = { gerarToken, autenticar, exigirAdmin };
