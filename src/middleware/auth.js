const db = require('../db');
const { needsReferral } = require('../services/referral');

// 매 요청마다 세션의 회원 정보를 불러옴
async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session.userId) return next();
  try {
    const user = await db.one('SELECT id, role, status, gender, referral_code, referrer_code, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session.userId = null;
    } else {
      req.user = user;
      res.locals.user = user;
      res.locals.needsReferral = needsReferral(user);
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(401).json({ ok: false, message: '로그인이 필요해요.' });
    }
    return res.redirect('/start');
  }
  next();
}

// 글·댓글·추천 같은 활동: 이용 제한 계정, 추천인 코드가 필요한 계정은 막음
function requireActive(req, res, next) {
  let message = null;
  if (req.user && req.user.status === 'banned') message = '운영 규칙 위반으로 글과 댓글 작성이 제한된 계정이에요.';
  else if (needsReferral(req.user)) message = '추천인 코드를 등록하면 글, 댓글, 추천을 할 수 있어요. 마이페이지에서 등록해주세요.';
  if (!message) return next();
  if (req.accepts(['html', 'json']) === 'json') return res.status(403).json({ ok: false, message });
  return res.status(403).render('error', { title: '이용 제한', message });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(404).render('error', { title: '페이지 없음', message: '페이지를 찾을 수 없어요.' });
  }
  next();
}

module.exports = { loadUser, requireLogin, requireActive, requireAdmin };
