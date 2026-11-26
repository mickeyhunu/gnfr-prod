// 고객센터: 1:1 문의하기 / 내 문의내역 / 내 신고 내역 (마이페이지 아래)
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
const CATS = config.inquiry.categories;
const LIST_MAX = 50;

const sendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const clip = (v, max) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, max);

// 마이페이지에 보여줄 숫자
async function supportCounts(userId) {
  const [q, r] = await Promise.all([
    db.one(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'open'), 0) AS open, COALESCE(SUM(status = 'answered' AND user_seen = 0), 0) AS fresh
       FROM inquiries WHERE user_id = ?`,
      [userId]
    ),
    db.one('SELECT COUNT(*) AS total FROM reports WHERE reporter_id = ?', [userId]),
  ]);
  return { inquiries: Number(q.total), open: Number(q.open), fresh: Number(q.fresh), reports: Number(r.total) };
}

// ── 1:1 문의하기 ──────────────────────────────────────
async function renderNew(req, res, status, extra = {}) {
  const open = await db.one(`SELECT COUNT(*) AS n FROM inquiries WHERE user_id = ? AND status = 'open'`, [req.user.id]);
  res.status(status).render('inquiry-new', {
    title: '1:1 문의',
    nav: 'me',
    cats: CATS,
    form: { category: CATS[req.query.cat] ? req.query.cat : '', title: '', body: '' },
    error: null,
    full: Number(open.n) >= config.inquiry.openLimit,
    openLimit: config.inquiry.openLimit,
    bodyMax: config.inquiry.bodyMax,
    ...extra,
  });
}

router.get('/me/inquiries/new', requireLogin, async (req, res, next) => {
  try {
    await renderNew(req, res, 200);
  } catch (err) {
    next(err);
  }
});

router.post('/me/inquiries/new', requireLogin, sendLimiter, async (req, res, next) => {
  try {
    const form = {
      category: CATS[req.body.category] ? req.body.category : '',
      title: clip(req.body.title, 100).replace(/\s+/g, ' '),
      body: clip(req.body.body, config.inquiry.bodyMax),
    };
    const fail = (error) => renderNew(req, res, 400, { form, error });
    if (!form.category) return fail('문의 종류를 골라주세요.');
    if (form.title.length < 2) return fail('제목을 2자 이상 적어주세요.');
    if (form.body.length < 5) return fail('내용을 5자 이상 적어주세요.');

    const id = await db.tx(async (conn) => {
      // 동시에 여러 번 보내도 개수 제한을 넘지 않게 회원 줄을 잠금
      await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM inquiries WHERE user_id = ? AND status = 'open'`, [req.user.id]);
      if (Number(n) >= config.inquiry.openLimit) return null;
      const [ins] = await conn.query(
        'INSERT INTO inquiries (user_id, category, title, body) VALUES (?, ?, ?, ?)',
        [req.user.id, form.category, form.title, form.body]
      );
      return ins.insertId;
    });
    if (!id) return fail(`답변을 기다리는 문의는 ${config.inquiry.openLimit}개까지예요. 답변을 받은 뒤 다시 문의해주세요.`);
    res.redirect(`/me/inquiries/${id}?sent=1`);
  } catch (err) {
    next(err);
  }
});

// ── 내 문의내역 ───────────────────────────────────────
router.get('/me/inquiries', requireLogin, async (req, res, next) => {
  try {
    const list = await db.query(
      `SELECT id, category, title, status, user_seen, created_at, answered_at
       FROM inquiries WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      [req.user.id, LIST_MAX]
    );
    res.render('inquiries', { title: '내 문의내역', nav: 'me', list, cats: CATS, tab: 'inquiries', counts: await supportCounts(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/me/inquiries/:id', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const q = id && (await db.one('SELECT * FROM inquiries WHERE id = ? AND user_id = ?', [id, req.user.id]));
    if (!q) return res.redirect('/me/inquiries');
    if (q.status === 'answered' && !q.user_seen) await db.query('UPDATE inquiries SET user_seen = 1 WHERE id = ?', [id]);
    res.render('inquiry', { title: '문의 내용', nav: 'me', q, cats: CATS, sent: req.query.sent === '1' });
  } catch (err) {
    next(err);
  }
});

// ── 내 신고 내역 ──────────────────────────────────────
router.get('/me/reports', requireLogin, async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.detail, r.status, r.created_at,
              COALESCE(p.title, LEFT(c.body, 80)) AS summary,
              COALESCE(p.status, c.status) AS target_status,
              COALESCE(p.id, c.post_id) AS post_id,
              COALESCE(p.status, cp.status) AS post_status
       FROM reports r
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
       LEFT JOIN posts cp ON cp.id = c.post_id
       WHERE r.reporter_id = ?
       ORDER BY r.id DESC LIMIT ?`,
      [req.user.id, LIST_MAX]
    );
    for (const r of rows) {
      const gone = r.target_status === 'hidden' || r.target_status === 'deleted' || !r.target_status;
      // 처리 결과: 검토 중 / 조치 완료(내려감) / 검토 완료(그대로 둠)
      r.result = r.status === 'open' ? 'open' : gone ? 'removed' : 'kept';
      r.canOpen = r.post_status === 'visible' && r.target_status === 'visible';
    }
    res.render('my-reports', {
      title: '신고 내역',
      nav: 'me',
      rows,
      reasons: config.reportReasons,
      tab: 'reports',
      counts: await supportCounts(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.supportCounts = supportCounts;
