const crypto = require('crypto');

const MULTIPART_PATHS = new Set(['/ads/new/biz']);

// 세션 기반 CSRF 토큰. 폼에는 <input name="_csrf">, fetch에는 X-CSRF-Token 헤더로 보냄
function csrf(req, res, next) {
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrf;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // 파일 첨부 폼(multipart)은 본문을 아직 못 읽었으므로, 그 라우트가 파일을 받은 뒤 csrf.verify 로 확인.
  // 허용한 경로만 넘김 (다른 경로에 multipart 로 보내 확인을 건너뛰는 것을 막음)
  if (req.is('multipart/form-data') && MULTIPART_PATHS.has(req.path)) return next();

  if (!verify(req)) {
    if (req.is('application/json') || req.get('X-CSRF-Token') !== undefined) {
      return res.status(403).json({ ok: false, message: '페이지를 새로고침한 뒤 다시 시도해주세요.' });
    }
    return res.status(403).render('error', { title: '요청 만료', message: '페이지를 새로고침한 뒤 다시 시도해주세요.' });
  }
  next();
}

function verify(req) {
  const sent = (req.body && req.body._csrf) || req.get('X-CSRF-Token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf || '');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = csrf;
module.exports.verify = verify;
