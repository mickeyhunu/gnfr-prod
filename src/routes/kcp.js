// KCP 휴대폰 본인확인 화면 흐름
//   GET  /kcp/start?purpose=…  거래등록 후 KCP 인증 화면으로 넘김
//   POST /kcp/callback         KCP 가 결과를 보내는 곳 (KCP_RETURN_URL). 다른 사이트에서 오는 요청이라 세션·CSRF 없이 받음 (app.js 에서 csrf 앞에 연결)
//   GET  /kcp/done?o=…         인증을 시작한 브라우저에서 결과를 꺼내 용도별로 처리
// 화면의 본인확인 버튼은 팝업(?popup=1)으로 /kcp/start 를 엶 (public/js/app.js). 팝업이 막히면 지금 창에서 진행
//   팝업 안에서 KCP 화면 → 콜백 → done 까지 진행하고, 끝나면 kcp-close 화면이 원래 창을 결과 화면으로 옮기고 닫힘
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const kcp = require('../services/kcp');
const { hashPhone } = require('../services/phone');
const { isAdult, findUserByCi, saveIdentity } = require('../services/identity');

const router = express.Router();

const startLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const ADULT_ERROR = '만 19세 이상만 이용할 수 있어요.';
const LOGIN_PURPOSES = ['phone', 'verify'];
const BACK = { signup: '/signup', reset: '/reset', phone: '/me', verify: '/me' };

const maskPhone = (p) => (p ? `${p.slice(0, 3)}-****-${p.slice(-4)}` : '');

// 결과 화면으로 이동. 팝업이면 원래 창을 옮기고 팝업은 닫음
function go(req, res, to) {
  if (req.session.kcpPopup) {
    delete req.session.kcpPopup;
    return res.render('kcp-close', { title: '휴대폰 본인확인', target: to });
  }
  res.redirect(to);
}

// 용도별로 오류를 보여줄 곳에 메시지를 남기고 돌아감
function backWithError(req, res, purpose, message) {
  if (LOGIN_PURPOSES.includes(purpose)) req.session.meNotice = message;
  else req.session.kcpError = message;
  go(req, res, BACK[purpose] || '/');
}

router.get('/kcp/start', startLimiter, async (req, res, next) => {
  const purpose = kcp.PURPOSES.includes(req.query.purpose) ? req.query.purpose : null;
  if (req.query.popup === '1') req.session.kcpPopup = true;
  else delete req.session.kcpPopup;
  if (!purpose) return go(req, res, '/');
  if (LOGIN_PURPOSES.includes(purpose) && !req.user) return go(req, res, '/start');
  if (!LOGIN_PURPOSES.includes(purpose) && req.user) return go(req, res, '/');
  if (!kcp.isReady()) return backWithError(req, res, purpose, '지금은 휴대폰 본인확인을 할 수 없어요. 잠시 후 다시 시도해주세요.');
  try {
    const r = await kcp.register(purpose, req.user ? req.user.id : null);
    req.session.kcpOrdr = r.ordr; // 결과는 이 브라우저(세션)에서만 꺼낼 수 있음
    res.render('kcp-go', { title: '휴대폰 본인확인', callUrl: r.callUrl, regCertKey: r.regCertKey });
  } catch (err) {
    console.error('[KCP] 거래등록 오류:', err.message);
    backWithError(req, res, purpose, '본인확인 화면을 열지 못했어요. 잠시 후 다시 시도해주세요.');
  }
});

// KCP → Ret_URL. 결과를 받아 저장한 뒤, 시작한 브라우저가 꺼내 가도록 /kcp/done 으로 보냄
async function callback(req, res, next) {
  try {
    const body = req.method === 'POST' ? req.body || {} : req.query;
    const r = await kcp.handleReturn(body);
    if (!r) {
      return res.status(400).render('error', { title: '본인확인', message: '본인확인 시간이 지났거나 이미 처리됐어요. 처음부터 다시 해주세요.' });
    }
    res.redirect(303, '/kcp/done?o=' + encodeURIComponent(r.ordr));
  } catch (err) {
    next(err);
  }
}

router.get('/kcp/done', async (req, res, next) => {
  try {
    const ordr = String(req.query.o || '');
    if (!ordr || req.session.kcpOrdr !== ordr) {
      return res.status(400).render('error', { title: '본인확인', message: '본인확인을 시작한 브라우저에서 다시 해주세요.' });
    }
    delete req.session.kcpOrdr;
    const result = await kcp.takeResult(ordr);
    if (!result) return res.status(400).render('error', { title: '본인확인', message: '본인확인 시간이 지났어요. 처음부터 다시 해주세요.' });
    const { purpose, identity } = result;
    if (result.error) return backWithError(req, res, purpose, result.error);
    if (LOGIN_PURPOSES.includes(purpose) && (!req.user || req.user.id !== result.userId)) {
      return res.status(400).render('error', { title: '본인확인', message: '본인확인을 시작한 계정으로 로그인한 뒤 다시 해주세요.' });
    }
    const at = Date.now();

    if (purpose === 'signup') {
      if (!isAdult(identity.birthDate)) return backWithError(req, res, purpose, ADULT_ERROR);
      if (await findUserByCi(identity.ci)) return backWithError(req, res, purpose, '이미 가입한 회원이에요. 로그인하거나 비밀번호 찾기를 해주세요.');
      const byPhone = await db.one('SELECT id, password_hash FROM users WHERE phone_hash = ?', [hashPhone(identity.phone)]);
      if (byPhone && byPhone.password_hash) return backWithError(req, res, purpose, '이미 가입된 번호예요. 로그인하거나 비밀번호 찾기를 해주세요.');
      req.session.kcpSignup = { identity, at };
      return go(req, res, '/signup');
    }

    if (purpose === 'reset') {
      // 본인확인한 사람(CI)의 계정. 본인인증 전 예전 계정은 번호로 찾되, 다른 사람이 본인인증한 계정이면 안 됨 (번호가 다른 사람에게 넘어간 경우)
      const byCi = await db.one('SELECT id, phone FROM users WHERE ci = ?', [identity.ci]);
      const byPhone = byCi ? null : await db.one('SELECT id, phone, ci FROM users WHERE phone_hash = ?', [hashPhone(identity.phone)]);
      const user = byCi || (byPhone && !byPhone.ci ? byPhone : null);
      if (!user) return backWithError(req, res, purpose, '본인확인한 정보로 가입한 회원이 없어요. 회원가입을 해주세요.');
      // 본인인증 전 계정이면 이번 본인확인 정보를 저장 (번호는 이미 같음)
      if (!byCi && isAdult(identity.birthDate)) await saveIdentity(user.id, { ...identity, phone: null });
      req.session.kcpReset = { userId: user.id, phone: maskPhone(user.phone || identity.phone), at };
      return go(req, res, '/reset');
    }

    const me = await db.one('SELECT id, phone, ci FROM users WHERE id = ?', [req.user.id]);
    if (me.ci && me.ci !== identity.ci) return backWithError(req, res, purpose, '이 계정으로 본인확인한 사람과 다른 사람이에요.');
    const other = await findUserByCi(identity.ci);
    if (other && other.id !== me.id) return backWithError(req, res, purpose, '이미 다른 계정으로 본인확인한 사람이에요.');
    if (!isAdult(identity.birthDate)) return backWithError(req, res, purpose, ADULT_ERROR);

    if (purpose === 'phone') {
      if (me.phone === identity.phone) return backWithError(req, res, purpose, '본인확인한 번호가 지금 쓰는 번호와 같아요.');
      const phoneHash = hashPhone(identity.phone);
      if (await db.one('SELECT id FROM users WHERE phone_hash = ? AND id <> ?', [phoneHash, me.id])) {
        return backWithError(req, res, purpose, '본인확인한 번호가 이미 다른 계정에 등록돼 있어요.');
      }
      await db.query('UPDATE users SET phone_hash = ?, phone = ? WHERE id = ?', [phoneHash, identity.phone, me.id]);
      await saveIdentity(me.id, identity);
      req.session.meNotice = '휴대폰 번호를 바꿨어요. 다음 로그인부터 새 번호로 들어오세요.';
      return go(req, res, '/me');
    }

    // verify: 기존 회원 본인인증. 로그인 번호는 그대로 두고 본인확인 정보만 저장
    await saveIdentity(me.id, { ...identity, phone: null });
    req.session.meNotice = '본인인증을 마쳤어요. 성별이 확인되어 내 성별의 숲도 볼 수 있어요.';
    go(req, res, '/me');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return backWithError(req, res, 'verify', '이미 다른 계정으로 본인확인한 사람이에요.');
    next(err);
  }
});

module.exports = router;
module.exports.callback = callback;
