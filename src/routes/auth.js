const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { normalizePhone, hashPhone, makeCode, hashCode } = require('../services/phone');
const { checkCode } = require('../services/verify');
const { sendSms } = require('../services/sms');
const { hashPassword, verifyPassword, checkPasswordRule } = require('../services/password');
const { resolveReferral, newReferralCode } = require('../services/referral');
const config = require('../config');
const kcp = require('../services/kcp');
const { isAdult, findUserByCi, saveIdentity } = require('../services/identity');

const router = express.Router();

const CODE_TTL_MIN = 3;
const RESEND_WAIT_SEC = 60;
const DAILY_LIMIT_PER_PHONE = 5;

const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: '요청이 너무 많아요. 10분 뒤에 다시 시도해주세요.' },
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const ADULT_ERROR = '만 19세 이상인지 확인해주세요. 19세 미만은 이용할 수 없어요.';

// 로그인: 세션 고정 공격 방지를 위해 세션 ID 새로 발급
// remember = false 이면 브라우저를 닫으면 로그아웃되는 세션 쿠키로 (자동 로그인 끔)
function logIn(req, res, next, userId, remember = true, to = '/') {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    if (!remember) req.session.cookie.expires = false;
    req.session.save((err2) => (err2 ? next(err2) : res.redirect(to)));
  });
}

// KCP 본인확인 결과 중 아직 유효한 것 (세션에 잠깐 보관)
function freshKcp(req, key) {
  const v = req.session[key];
  if (!v) return null;
  if (Date.now() - v.at > kcp.CERT_TTL_MIN * 60 * 1000) {
    delete req.session[key];
    return null;
  }
  return v;
}
const maskPhone = (p) => (p ? `${p.slice(0, 3)}-****-${p.slice(-4)}` : '');

// KCP 를 쓰면 화면에 '본인확인 완료' 상태를 보여줌. 본인확인 단계에서 생긴 오류(kcpError)는 한 번만 보여줌
function renderSignup(req, res, status, error, form) {
  const kcpOn = kcp.isReady();
  const v = kcpOn && freshKcp(req, 'kcpSignup');
  if (!error && req.session.kcpError) error = req.session.kcpError;
  delete req.session.kcpError;
  res.status(status).render('signup', {
    title: '회원가입',
    error,
    form: { phone: '', referral: '', invited: false, ...form },
    verified: v ? { name: v.identity.name, phone: maskPhone(v.identity.phone) } : null,
  });
}

function renderLogin(res, status, error, phone, remember = true, idMode = false) {
  res.status(status).render('login', { title: idMode ? '관리자 로그인' : '로그인', error, phone: phone || '', remember, idMode });
}

function renderReset(req, res, status, error, phone) {
  const v = kcp.isReady() && freshKcp(req, 'kcpReset');
  if (!error && req.session.kcpError) error = req.session.kcpError;
  delete req.session.kcpError;
  res.status(status).render('reset', { title: '비밀번호 찾기', error, phone: phone || '', verified: v ? { phone: v.phone } : null });
}

router.get('/start', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('start', { title: '시작하기' });
});

// 초대 링크: /r/추천인코드 → 그 코드가 입력된 회원가입 화면
// 시작 화면을 거쳐 가입해도 코드가 남도록 세션에도 기억
router.get('/r/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (req.user) return res.redirect('/');
  if (!/^[A-Z0-9]{4,20}$/.test(code)) return res.redirect('/signup');
  req.session.inviteRef = code;
  res.redirect('/signup?ref=' + encodeURIComponent(code));
});

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  const ref = String(req.query.ref || req.session.inviteRef || '').trim().slice(0, 20);
  renderSignup(req, res, 200, null, { referral: ref, invited: !!ref });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  renderLogin(res, 200, null, '');
});

// 회원가입: 본인인증(문자) + 비밀번호 + 추천인 코드(필수: 마스터 코드 또는 회원 추천인 코드)
router.post('/auth/signup', verifyLimiter, async (req, res, next) => {
  const form = { phone: String(req.body.phone || ''), referral: String(req.body.referral || '').trim() };
  const fail = (message) => renderSignup(req, res, 400, message, form);

  try {
    // KCP 를 쓰면 번호와 본인정보는 본인확인 결과에서 가져옴
    const kcpOn = kcp.isReady();
    const cert = kcpOn ? freshKcp(req, 'kcpSignup') : null;
    if (kcpOn && !cert) return fail('휴대폰 본인확인을 먼저 해주세요.');
    const identity = cert ? cert.identity : null;
    const phone = identity ? identity.phone : normalizePhone(form.phone);
    const password = String(req.body.password || '');
    if (!phone) return fail('휴대폰 번호를 정확히 입력해주세요.');
    const ruleError = checkPasswordRule(password);
    if (ruleError) return fail(ruleError);
    if (password !== String(req.body.password2 || '')) return fail('비밀번호 확인이 일치하지 않아요.');
    if (req.body.adult !== 'yes') return fail(ADULT_ERROR);
    if (req.body.privacy !== 'yes') return fail('개인정보 수집·이용에 동의해야 가입할 수 있어요.');

    if (!form.referral) return fail('추천인 코드를 입력해주세요. 추천인 코드가 있어야 가입할 수 있어요.');
    const referral = await resolveReferral(form.referral);
    if (!referral) return fail('없는 추천인 코드예요. 다시 확인해주세요.');

    const phoneHash = hashPhone(phone);
    const existing = await db.one('SELECT id, password_hash FROM users WHERE phone_hash = ?', [phoneHash]);
    if (existing && (existing.password_hash || config.skipPhoneAuth)) {
      return fail('이미 가입된 번호예요. 로그인해주세요.');
    }

    if (identity) {
      if (!isAdult(identity.birthDate)) return fail('만 19세 이상만 가입할 수 있어요.');
      if (await findUserByCi(identity.ci)) return fail('이미 가입한 회원이에요. 로그인하거나 비밀번호 찾기를 해주세요.');
    } else if (!config.skipPhoneAuth) {
      const codeError = await checkCode(phoneHash, String(req.body.code || '').trim());
      if (codeError) return fail(codeError);
    }

    const passwordHash = await hashPassword(password);
    const myCode = await newReferralCode(); // 가입하면 누구나 자기 추천인 코드를 받음
    let userId;
    if (existing) {
      // 예전 문자 인증 방식으로 가입한 회원: 본인인증을 마쳤으니 비밀번호만 새로 정함
      await db.query(
        `UPDATE users SET phone = ?, password_hash = ?, privacy_agreed_at = UTC_TIMESTAMP(), referrer_code = COALESCE(referrer_code, ?), referrer_id = COALESCE(referrer_id, ?),
           referral_code = COALESCE(referral_code, ?), last_login_at = UTC_TIMESTAMP() WHERE id = ?`,
        [phone, passwordHash, referral.code, referral.referrerId, myCode, existing.id]
      );
      userId = existing.id;
    } else {
      const result = await db.query(
        `INSERT INTO users (phone_hash, phone, password_hash, referral_code, referrer_code, referrer_id, privacy_agreed_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [phoneHash, phone, passwordHash, myCode, referral.code, referral.referrerId]
      );
      userId = result.insertId;
    }
    if (identity) {
      await saveIdentity(userId, identity);
      delete req.session.kcpSignup;
    }
    logIn(req, res, next, userId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return fail('이미 가입된 번호예요. 로그인해주세요.');
    next(err);
  }
});

// 관리자 로그인: 아이디 + 비밀번호 (아이디는 npm run admin-account 로 만든 관리자 계정만 있음)
router.get('/admin/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  renderLogin(res, 200, null, '', false, true);
});

// 로그인: 전화번호 + 비밀번호 (관리자 로그인 화면에서는 아이디 + 비밀번호)
router.post('/auth/login', loginLimiter, async (req, res, next) => {
  const remember = req.body.remember === 'yes';
  if (req.body.login_id !== undefined) {
    const loginId = String(req.body.login_id || '').trim().slice(0, 30);
    const fail = () => renderLogin(res, 400, '아이디 또는 비밀번호가 맞지 않아요.', loginId, remember, true);
    try {
      const password = String(req.body.password || '');
      if (!loginId || !password) return fail();
      const user = await db.one(`SELECT id, password_hash FROM users WHERE login_id = ? AND role = 'admin'`, [loginId]);
      if (!user || !(await verifyPassword(password, user.password_hash))) return fail();
      await db.query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
      return logIn(req, res, next, user.id, remember, '/admin');
    } catch (err) {
      return next(err);
    }
  }
  const fail = () => renderLogin(res, 400, '번호 또는 비밀번호가 맞지 않아요.', req.body.phone, remember);
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (!phone || !password) return fail();
    const user = await db.one('SELECT id, password_hash FROM users WHERE phone_hash = ?', [hashPhone(phone)]);
    if (!user || !(await verifyPassword(password, user.password_hash))) return fail();
    // 번호 원문이 없는 예전 회원은 로그인할 때 채움
    await db.query('UPDATE users SET phone = COALESCE(phone, ?), last_login_at = UTC_TIMESTAMP() WHERE id = ?', [phone, user.id]);
    logIn(req, res, next, user.id, remember);
  } catch (err) {
    next(err);
  }
});

router.get('/reset', (req, res) => {
  if (req.user) return res.redirect('/');
  renderReset(req, res, 200, null, '');
});

// 비밀번호 찾기: 본인확인(KCP, 없으면 문자) 후 새 비밀번호. 둘 다 꺼져 있으면 막음 (누구나 남의 비밀번호를 바꿀 수 있게 되므로)
router.post('/auth/reset', verifyLimiter, async (req, res, next) => {
  const fail = (message) => renderReset(req, res, 400, message, req.body.phone);
  if (kcp.isReady()) {
    try {
      const cert = freshKcp(req, 'kcpReset');
      if (!cert) return fail('휴대폰 본인확인을 먼저 해주세요.');
      const password = String(req.body.password || '');
      const ruleError = checkPasswordRule(password);
      if (ruleError) return fail(ruleError);
      if (password !== String(req.body.password2 || '')) return fail('비밀번호 확인이 일치하지 않아요.');
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), cert.userId]);
      // 다른 기기에 남아 있는 로그인은 끊음
      await db.query('DELETE FROM sessions WHERE data REGEXP ?', [`"userId":${Number(cert.userId)}[,}]`]);
      delete req.session.kcpReset;
      return logIn(req, res, next, cert.userId);
    } catch (err) {
      return next(err);
    }
  }
  if (config.skipPhoneAuth) return fail('지금은 문자 인증이 꺼져 있어서 비밀번호를 찾을 수 없어요.');
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (!phone) return fail('휴대폰 번호를 정확히 입력해주세요.');
    const ruleError = checkPasswordRule(password);
    if (ruleError) return fail(ruleError);
    if (password !== String(req.body.password2 || '')) return fail('비밀번호 확인이 일치하지 않아요.');

    const phoneHash = hashPhone(phone);
    const user = await db.one('SELECT id FROM users WHERE phone_hash = ?', [phoneHash]);
    const codeError = await checkCode(phoneHash, String(req.body.code || '').trim());
    if (codeError) return fail(codeError);
    if (!user) return fail('가입되지 않은 번호예요. 회원가입을 해주세요.');

    await db.query('UPDATE users SET password_hash = ?, phone = COALESCE(phone, ?) WHERE id = ?', [
      await hashPassword(password), phone, user.id,
    ]);
    logIn(req, res, next, user.id);
  } catch (err) {
    next(err);
  }
});

// 인증번호 보내기 (fetch로 호출, JSON 응답)
router.post('/auth/send-code', sendLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ ok: false, message: '휴대폰 번호를 정확히 입력해주세요.' });
    const phoneHash = hashPhone(phone);

    const recent = await db.one(
      `SELECT
         SUM(created_at > UTC_TIMESTAMP() - INTERVAL ? SECOND) AS lastMinute,
         COUNT(*) AS today
       FROM phone_verifications
       WHERE phone_hash = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY`,
      [RESEND_WAIT_SEC, phoneHash]
    );
    if (Number(recent.lastMinute) > 0) {
      return res.status(429).json({ ok: false, message: '1분 뒤에 다시 요청해주세요.' });
    }
    if (Number(recent.today) >= DAILY_LIMIT_PER_PHONE) {
      return res.status(429).json({ ok: false, message: '오늘 인증 요청 횟수를 넘었어요. 내일 다시 시도해주세요.' });
    }

    const code = makeCode();
    await db.query(
      `INSERT INTO phone_verifications (phone_hash, code_hash, ip, expires_at)
       VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)`,
      [phoneHash, hashCode(phoneHash, code), req.ip, CODE_TTL_MIN]
    );
    await sendSms(phone, `[강남의숲] 인증번호 ${code} (${CODE_TTL_MIN}분 안에 입력해주세요)`);

    res.json({ ok: true, message: '인증번호를 보냈어요.' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('forest.sid');
    res.redirect('/start');
  });
});

module.exports = router;
