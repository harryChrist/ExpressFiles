// Autenticação do serviço de arquivos.
//
// Duas credenciais são aceitas em rotas de escrita/listagem:
//   1. Chave de serviço  (header x-internal-key)  -> projetos internos; pode tudo.
//   2. Token temporário  (Authorization: Bearer)  -> navegador de quem está logado
//      no site. Emitido pelo Mahou Reader (/api/cdn-token), assinado com
//      CDN_TOKEN_SECRET e válido por poucos minutos.
//
// Os segredos vêm do .env deste projeto (INTERNAL_SERVICE_KEY e CDN_TOKEN_SECRET).
// Sem eles configurados, toda escrita é recusada.
const crypto = require('crypto');

const STAFF_ROLES = ['UPLOADER', 'ADMIN', 'DONO'];
const ADMIN_ROLES = ['ADMIN', 'DONO'];

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// Token = base64url(JSON) + "." + base64url(HMAC-SHA256)
const verifyToken = (token, secret) => {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (!payload.username || !payload.role) return null;
    return payload;
  } catch {
    return null;
  }
};

// Preenche req.auth ou responde 401.
const requireAuth = (req, res, next) => {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  const sentKey = req.headers['x-internal-key'];
  if (serviceKey && sentKey && safeEqual(sentKey, serviceKey)) {
    req.auth = { service: true, staff: true, admin: true, username: null, role: 'SERVICE' };
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token, process.env.CDN_TOKEN_SECRET);
  if (payload) {
    req.auth = {
      service: false,
      staff: STAFF_ROLES.includes(payload.role),
      admin: ADMIN_ROLES.includes(payload.role),
      username: payload.username,
      role: payload.role,
    };
    return next();
  }

  return res.status(401).json({ error: 'Não autorizado.' });
};

const requireStaff = (req, res, next) =>
  requireAuth(req, res, () => {
    if (!req.auth.staff) return res.status(403).json({ error: 'Acesso negado.' });
    next();
  });

const requireAdmin = (req, res, next) =>
  requireAuth(req, res, () => {
    if (!req.auth.admin) return res.status(403).json({ error: 'Acesso negado.' });
    next();
  });

module.exports = { requireAuth, requireStaff, requireAdmin, verifyToken };
