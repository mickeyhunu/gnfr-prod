// 하단 바 메뉴: 홈 / 실시간강남 / 광고(routes/ads.js) / 마이페이지  (숲(커뮤니티)은 routes/posts.js 의 /forest)
const express = require('express');
const db = require('../db');
const notify = require('../services/notify');
const config = require('../config');
const { requireLogin } = require('../middleware/auth');
const { resolveReferral, ensureReferralCode } = require('../services/referral');
const { boardFilter } = require('../services/boards');
const { withReadFlags } = require('../services/reads');
const rateLimit = require('express-rate-limit');
const { normalizePhone, hashPhone } = require('../services/phone');
const { hashPassword, verifyPassword, checkPasswordRule } = require('../services/password');
const { checkCode } = require('../services/verify');
const { getAuthorInfo, rankOf } = require('../services/ranks');
const { supportCounts } = require('./support');

const router = express.Router();

const HOT_DAYS = 7; // 홈 '요즘 인기': 최근 7일 글 중 추천 - 반대 가 높은 순
const CARD_COLUMNS = 'id, board, title, LEFT(body, 120) AS preview, up_count, down_count, comment_count, view_count, status, created_at';

// ── 홈: 요즘 핫한 글 + 방금 올라온 글 ─────────────────────────
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const f = boardFilter(req.user); // 볼 수 없는 성별 게시판 글은 뺌
    const [hot, latest] = await Promise.all([
      db.query(
        `SELECT ${CARD_COLUMNS} FROM posts
         WHERE status = 'visible' AND ${f.sql} AND created_at > UTC_TIMESTAMP() - INTERVAL ? DAY
         ORDER BY CAST(up_count AS SIGNED) - CAST(down_count AS SIGNED) DESC, id DESC LIMIT 3`,
        [...f.params, HOT_DAYS]
      ),
      db.query(`SELECT ${CARD_COLUMNS} FROM posts WHERE status = 'visible' AND ${f.sql} ORDER BY id DESC LIMIT 5`, f.params),
    ]);
    // 추천 - 반대 가 0 이하인 글은 '요즘 인기' 에서 뺌
    await withReadFlags(req.user.id, hot, latest);
    res.render('home', { title: '홈', nav: 'home', hot: hot.filter((p) => p.up_count - (p.down_count || 0) > 0), latest, hotDays: HOT_DAYS });
  } catch (err) {
    next(err);
  }
});

// ── 실시간강남: 가게 목록 / 가게 정보 ──────────────────────
const STORE_COLS = 'id, region, dong, name, category, address, lat, lng, emoji, hours, intro, phone';

router.get('/live', requireLogin, async (req, res, next) => {
  try {
    const all = await db.query(`SELECT ${STORE_COLS} FROM stores WHERE is_active = 1 ORDER BY id`);
    // 업종 칩: 먼저 등록된 업종부터 (id 가 작은 가게의 업종이 앞)
    const categories = [...new Set(all.map((s) => s.category))];
    const cat = categories.includes(req.query.cat) ? req.query.cat : null;
    const rank = new Map(categories.map((c, i) => [c, i]));
    const stores = all
      .filter((s) => !cat || s.category === cat)
      .sort((a, b) => rank.get(a.category) - rank.get(b.category) || a.name.localeCompare(b.name, 'ko'));
    const view = req.query.view === 'map' ? 'map' : 'card';
    // 지도에 넘길 최소 정보 (JSON 으로 data 속성에 넣음)
    const mapData = stores.map((s) => ({
      id: s.id, name: s.name, region: s.region, dong: s.dong, category: s.category, address: s.address,
      emoji: s.emoji, hours: s.hours, lat: s.lat === null ? null : Number(s.lat), lng: s.lng === null ? null : Number(s.lng),
    }));
    res.render('live', { title: '실시간강남', nav: 'live', stores, categories, cat, total: all.length, view, mapData, kakaoKey: config.kakaoJsKey });
  } catch (err) {
    next(err);
  }
});

router.get('/live/:id', requireLogin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const store = Number.isInteger(id) && id > 0 && (await db.one(`SELECT ${STORE_COLS} FROM stores WHERE id = ? AND is_active = 1`, [id]));
    if (!store) return res.redirect('/live');
    res.render('store', {
      title: store.name,
      nav: 'live',
      store,
      mapUrl: 'https://map.naver.com/p/search/' + encodeURIComponent(`서울 ${store.address}`),
    });
  } catch (err) {
    next(err);
  }
});

// 광고는 routes/ads.js

// ── 마이페이지: 내 정보 + 활동내역 바로가기 ─────────────────────────
const ACTIVITY_TABS = [
  { key: 'posts', label: '내가 쓴 글' },
  { key: 'comments', label: '내가 쓴 댓글' },
  { key: 'liked', label: '추천한 글' },
  { key: 'saved', label: '저장한 글' },
];
const ACTIVITY_PAGE = 20;

// 01012345678 → 010-****-5678
function maskPhone(phone) {
  const d = String(phone || '');
  if (!/^\d{10,11}$/.test(d)) return null;
  return `${d.slice(0, 3)}-****-${d.slice(-4)}`;
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// 활동내역 개수 (추천한 글·저장한 글은 지금 볼 수 있는 글만)
async function activityCounts(user) {
  const uid = user.id;
  const f = boardFilter(user, 'p.board');
  const row = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM posts    WHERE user_id = ? AND status <> 'deleted') AS posts,
       (SELECT COUNT(*) FROM comments WHERE user_id = ? AND status <> 'deleted') AS comments,
       (SELECT COUNT(*) FROM votes v JOIN posts p ON p.id = v.target_id
         WHERE v.user_id = ? AND v.target_type = 'post' AND v.value > 0 AND p.status = 'visible' AND ${f.sql}) AS liked,
       (SELECT COUNT(*) FROM bookmarks b JOIN posts p ON p.id = b.post_id
         WHERE b.user_id = ? AND p.status = 'visible' AND ${f.sql}) AS saved,
       (SELECT COALESCE(SUM(up_count), 0) FROM posts    WHERE user_id = ? AND status <> 'deleted')
     + (SELECT COALESCE(SUM(up_count), 0) FROM comments WHERE user_id = ? AND status <> 'deleted') AS ups`,
    [uid, uid, uid, ...f.params, uid, ...f.params, uid, uid]
  );
  const out = {};
  Object.keys(row).forEach((k) => { out[k] = Number(row[k]); });
  return out;
}

router.get('/me', requireLogin, async (req, res, next) => {
  try {
    const [counts, account, authors, myCode, adRow, support] = await Promise.all([
      activityCounts(req.user),
      db.one('SELECT phone, gender, identity_verified_at, created_at FROM users WHERE id = ?', [req.user.id]),
      getAuthorInfo([req.user.id]),
      ensureReferralCode(req.user.id), // 예전 회원은 여기서 처음 발급
      db.one(
        `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'approved'), 0) AS live, COALESCE(SUM(status = 'pending'), 0) AS pending
         FROM ads WHERE user_id = ? AND status NOT IN ('ended','draft')`,
        [req.user.id]
      ),
      supportCounts(req.user.id),
    ]);
    // 내 등급 + 다음 등급까지 남은 점수 + 등급 기준표
    const me = authors.get(req.user.id) || { rank: rankOf(0, req.user.role), score: 0 };
    const tiers = config.ranks.tiers;
    const lv = typeof me.rank.level === 'number' ? me.rank.level : null; // 운영자는 'admin'
    const nextTier = lv && lv < tiers.length ? tiers[lv] : null;
    const grade = {
      rank: me.rank,
      score: me.score,
      next: nextTier ? { name: nextTier.name, level: lv + 1, left: nextTier.min - me.score } : null,
      // 진행 막대: 지금 등급 시작 점수 ~ 다음 등급 점수 사이 어디쯤인지
      from: lv ? tiers[lv - 1].min : 0,
      to: nextTier ? nextTier.min : null,
      tiers: tiers.map((t, i) => ({ level: i + 1, name: t.name, icon: rankOf(t.min, 'user').icon, min: t.min, max: i + 1 < tiers.length ? tiers[i + 1].min - 1 : null })),
      points: config.ranks.points,
      adminName: config.ranks.adminName,
    };
    res.render('me', {
      title: '마이페이지',
      nav: 'me',
      counts,
      grade,
      tabs: ACTIVITY_TABS,
      support,
      adCounts: { total: Number(adRow.total), live: Number(adRow.live), pending: Number(adRow.pending) },
      info: {
        phone: maskPhone(account.phone),
        gender: account.gender === 'M' ? '남성' : account.gender === 'F' ? '여성' : null,
        verified: !!account.identity_verified_at,
        joined: formatDate(account.created_at),
      },
      notice: req.session.meNotice || null,
      myCode,
      inviteUrl: `${require('../services/seo').siteOrigin(req)}/r/${myCode}`,
      viaMaster: !!req.user.referrer_code && req.user.referrer_code === config.referral.masterCode,
      referralError: req.session.referralError || null,
    });
    delete req.session.referralError;
    delete req.session.meNotice;
  } catch (err) {
    next(err);
  }
});

// ── 활동내역: 내가 쓴 글 / 내가 쓴 댓글 / 추천한 글 / 저장한 글 ─────────────
router.get('/me/activity', requireLogin, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const tab = ACTIVITY_TABS.some((t) => t.key === req.query.tab) ? req.query.tab : 'posts';
    const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
    const limit = ACTIVITY_PAGE + 1;
    const offset = (page - 1) * ACTIVITY_PAGE;
    const f = boardFilter(req.user, 'p.board');
    const P = 'p.id, p.board, p.title, LEFT(p.body, 120) AS preview, p.up_count, p.down_count, p.comment_count, p.view_count, p.status, p.created_at';
    let rows;
    if (tab === 'posts') {
      rows = await db.query(`SELECT ${P} FROM posts p WHERE p.user_id = ? AND p.status <> 'deleted' ORDER BY p.id DESC LIMIT ? OFFSET ?`, [uid, limit, offset]);
    } else if (tab === 'comments') {
      rows = await db.query(
        `SELECT c.id, c.post_id, LEFT(c.body, 200) AS body, c.up_count, c.down_count, c.status, c.created_at,
                p.title AS post_title, p.status AS post_status
         FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE c.user_id = ? AND c.status <> 'deleted'
         ORDER BY c.id DESC LIMIT ? OFFSET ?`,
        [uid, limit, offset]
      );
    } else if (tab === 'liked') {
      rows = await db.query(
        `SELECT ${P} FROM votes v JOIN posts p ON p.id = v.target_id
         WHERE v.user_id = ? AND v.target_type = 'post' AND v.value > 0 AND p.status = 'visible' AND ${f.sql}
         ORDER BY v.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [uid, ...f.params, limit, offset]
      );
    } else {
      rows = await db.query(
        `SELECT ${P} FROM bookmarks b JOIN posts p ON p.id = b.post_id
         WHERE b.user_id = ? AND p.status = 'visible' AND ${f.sql}
         ORDER BY b.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [uid, ...f.params, limit, offset]
      );
    }
    const hasNext = rows.length > ACTIVITY_PAGE;
    rows = rows.slice(0, ACTIVITY_PAGE);
    if (tab !== 'comments') await withReadFlags(uid, rows);
    res.render('me-activity', {
      title: '활동내역',
      nav: 'me',
      tab,
      tabs: ACTIVITY_TABS,
      counts: await activityCounts(req.user),
      rows,
      page,
      hasNext,
    });
  } catch (err) {
    next(err);
  }
});

// ── 정보 수정: 비밀번호 바꾸기 / 휴대폰 번호 바꾸기 ─────────────────────
const editLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

async function renderEdit(req, res, status, extra = {}) {
  const account = await db.one('SELECT phone FROM users WHERE id = ?', [req.user.id]);
  res.status(status).render('me-edit', {
    title: '정보 수정',
    nav: 'me',
    phone: maskPhone(account.phone),
    pwError: null,
    phoneError: null,
    newPhone: '',
    ...extra,
  });
}

router.get('/me/edit', requireLogin, async (req, res, next) => {
  try {
    await renderEdit(req, res, 200);
  } catch (err) {
    next(err);
  }
});

router.post('/me/password', requireLogin, editLimiter, async (req, res, next) => {
  try {
    const fail = (msg) => renderEdit(req, res, 400, { pwError: msg });
    const user = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const current = String(req.body.current || '');
    const password = String(req.body.password || '');
    // 비밀번호 없이 만든 예전 계정은 지금 비밀번호 없이 새로 정함
    if (user.password_hash && !(await verifyPassword(current, user.password_hash))) return fail('지금 비밀번호가 맞지 않아요.');
    const ruleError = checkPasswordRule(password);
    if (ruleError) return fail(ruleError);
    if (password !== String(req.body.password2 || '')) return fail('새 비밀번호 확인이 일치하지 않아요.');
    if (user.password_hash && current === password) return fail('지금과 다른 비밀번호로 정해주세요.');
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), req.user.id]);
    // 다른 기기에 남아 있는 로그인은 끊음 (지금 기기만 유지)
    await db.query('DELETE FROM sessions WHERE session_id <> ? AND data REGEXP ?', [req.sessionID, `"userId":${Number(req.user.id)}[,}]`]);
    req.session.meNotice = '비밀번호를 바꿨어요. 다른 기기에서는 로그아웃됐어요.';
    res.redirect('/me');
  } catch (err) {
    next(err);
  }
});

router.post('/me/phone', requireLogin, editLimiter, async (req, res, next) => {
  const newPhone = String(req.body.phone || '').slice(0, 20);
  const fail = (msg) => renderEdit(req, res, 400, { phoneError: msg, newPhone });
  // KCP 본인확인을 쓰면 번호 변경은 /kcp/start?purpose=phone 으로만
  if (require('../services/kcp').isReady()) return fail('새 번호로 휴대폰 본인확인을 해주세요.').catch(next);
  try {
    const phone = normalizePhone(newPhone);
    if (!phone) return fail('휴대폰 번호를 정확히 입력해주세요.');
    const user = await db.one('SELECT phone, password_hash FROM users WHERE id = ?', [req.user.id]);
    if (user.phone === phone) return fail('지금 쓰는 번호와 같아요.');
    if (user.password_hash && !(await verifyPassword(String(req.body.current || ''), user.password_hash))) return fail('지금 비밀번호가 맞지 않아요.');
    const phoneHash = hashPhone(phone);
    if (await db.one('SELECT id FROM users WHERE phone_hash = ? AND id <> ?', [phoneHash, req.user.id])) return fail('이미 다른 계정에 등록된 번호예요.');
    if (!config.skipPhoneAuth) {
      const codeError = await checkCode(phoneHash, String(req.body.code || '').trim());
      if (codeError) return fail(codeError);
    }
    await db.query('UPDATE users SET phone_hash = ?, phone = ? WHERE id = ?', [phoneHash, phone, req.user.id]);
    req.session.meNotice = '휴대폰 번호를 바꿨어요. 다음 로그인부터 새 번호로 들어오세요.';
    res.redirect('/me');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return fail('이미 다른 계정에 등록된 번호예요.').catch(next);
    next(err);
  }
});

// ── 추천인 코드 나중에 등록 (가입할 때 안 넣은 회원) ──────────────
router.post('/me/referral', requireLogin, async (req, res, next) => {
  try {
    if (req.user.referrer_code) return res.redirect('/me');
    const referral = await resolveReferral(req.body.referral);
    if (!referral || referral.referrerId === req.user.id) {
      req.session.referralError = '없는 추천인 코드예요. 다시 확인해주세요.';
      return res.redirect('/me#referral');
    }
    await db.query('UPDATE users SET referrer_code = ?, referrer_id = ? WHERE id = ? AND referrer_code IS NULL', [
      referral.code, referral.referrerId, req.user.id,
    ]);
    res.redirect('/me#referral');
  } catch (err) {
    next(err);
  }
});

// ── 검색: 공개 글의 제목·본문에서 찾기 (볼 수 없는 성별 게시판 제외) ─────────────────────────
router.get('/search', requireLogin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 50);
    let posts = [];
    if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const f = boardFilter(req.user);
      posts = await db.query(
        `SELECT ${CARD_COLUMNS} FROM posts
         WHERE status = 'visible' AND ${f.sql} AND (title LIKE ? OR body LIKE ?)
         ORDER BY id DESC LIMIT 50`,
        [...f.params, like, like]
      );
    }
    await withReadFlags(req.user.id, posts);
    res.render('search', { title: q ? `"${q}" 검색` : '검색', q, posts });
  } catch (err) {
    next(err);
  }
});

// ── 알림: 댓글 · 답글 · 문의 답변 · 광고 (services/notify) ──────────
// 알림은 눌러서 열거나 '모두 읽음'을 눌러야 읽음 처리
router.get('/notifications', requireLogin, async (req, res, next) => {
  try {
    const type = notify.TYPES[req.query.type] ? req.query.type : '';
    const { items, unread } = await notify.list(req.user.id, type);
    const unreadAll = Object.values(unread).reduce((a, b) => a + b, 0);
    res.render('notifications', { title: '알림', items, type, types: notify.TYPES, unread, unreadAll, done: req.query.done === '1' });
  } catch (err) {
    next(err);
  }
});

router.post('/notifications/read-all', requireLogin, async (req, res, next) => {
  try {
    const type = notify.TYPES[req.body.type] ? req.body.type : '';
    await notify.markAllRead(req.user.id, type);
    res.redirect('/notifications?' + (type ? `type=${type}&` : '') + 'done=1');
  } catch (err) {
    next(err);
  }
});

// 알림 하나 열기: 읽음 처리 후 해당 화면으로
router.get('/notifications/:id', requireLogin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const to = Number.isInteger(id) && id > 0 ? await notify.open(req.user.id, id) : null;
    res.redirect(to || '/notifications');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
