const jwt = require('jsonwebtoken');
const { ErroHttp } = require('./erros');

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, perfil: usuario.perfil },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
  );
}

// Por enquanto o próprio serviço valida o token; na próxima aula o gateway assume.
function autenticar(req, res, next) {
  const [tipo, token] = (req.get('authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !token) {
    return next(new ErroHttp(401, 'Token ausente. Envie o cabeçalho Authorization: Bearer <token>.'));
  }

  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    next(new ErroHttp(401, 'Token inválido ou expirado.'));
  }
}

function exigirAdmin(req, res, next) {
  if (req.usuario.perfil !== 'admin') {
    return next(new ErroHttp(403, 'Acesso restrito a administradores.'));
  }
  next();
}

module.exports = { gerarToken, autenticar, exigirAdmin };
