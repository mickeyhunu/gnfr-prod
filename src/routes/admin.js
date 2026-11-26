// 관리자 화면: 대시보드 / 검토·신고 / 게시글 / 광고 / 문의 / 가게 / 회원 (탭마다 주소가 따로)
// 글·댓글은 기록으로 남겨야 해서 관리자는 지우지 않고 가리기만 함
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { refreshCommentCount, resolveReports } = require('../services/moderation');
const nts = require('../services/nts');
const adsSvc = require('../services/ads');
const notify = require('../services/notify');
const richtext = require('../services/richtext');
const { normalizePhone, hashPhone } = require('../services/phone');

const router = express.Router();
router.use(requireLogin, requireAdmin);

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// 01012345678 → 010-1234-5678
const formatPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
};

// 탭 옆에 붙는 처리 대기 숫자 (모든 관리자 화면에서 씀)
router.use(async (req, res, next) => {
  // 관리자 목록 공통: 글·댓글 상태 이름과 표시 색
  res.locals.modStatus = { visible: '공개', pending: '검토 대기', hidden: '가림', deleted: '작성자 삭제' };
  res.locals.modTag = { visible: 'muted', pending: 'warn', hidden: 'hot', deleted: 'muted' };
  if (req.method !== 'GET') return next();
  try {
    const [row] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE status = 'pending') +
         (SELECT COUNT(*) FROM comments WHERE status = 'pending') AS review,
         (SELECT COUNT(DISTINCT target_type, target_id) FROM reports WHERE status = 'open') AS reports,
         (SELECT COUNT(*) FROM ads WHERE status = 'pending') AS ads,
         (SELECT COUNT(*) FROM inquiries WHERE status = 'open') AS inquiries`
    );
    res.locals.pending = {
      review: Number(row.review) + Number(row.reports),
      ads: Number(row.ads),
      inquiries: Number(row.inquiries),
    };
    res.locals.adminTab = null;
    next();
  } catch (err) {
    next(err);
  }
});

// 처리 후 돌아갈 곳: 관리자 화면이나 글 화면만 허용
const backTo = (req, fallback) => {
  const back = String(req.body.back || '');
  return /^\/p\/\d+$/.test(back) || /^\/admin(\/[a-z]+)?(\?[\w=&%-]*)?$/.test(back) ? back : fallback;
};

// ── 대시보드 ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [s] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM users WHERE created_at >= CURDATE()) AS users_today,
         (SELECT COUNT(*) FROM users WHERE created_at >= CURDATE() - INTERVAL 6 DAY) AS users_week,
         (SELECT COUNT(*) FROM users WHERE status = 'banned') AS banned,
         (SELECT COUNT(*) FROM posts WHERE status <> 'deleted') AS posts,
         (SELECT COUNT(*) FROM posts WHERE created_at >= CURDATE()) AS posts_today,
         (SELECT COUNT(*) FROM comments WHERE created_at >= CURDATE()) AS comments_today,
         (SELECT COUNT(*) FROM ads WHERE status = 'approved') AS ads_live,
         (SELECT COUNT(*) FROM stores WHERE is_active = 1) AS stores`
    );
    const recentUsers = await db.query(
      `SELECT id, login_id, real_name, phone, gender, referrer_code, created_at FROM users ORDER BY id DESC LIMIT 5`
    );
    recentUsers.forEach((u) => { u.phoneText = formatPhone(u.phone); });
    const recentPosts = await db.query(
      `SELECT id, board, title, status, comment_count, created_at FROM posts ORDER BY id DESC LIMIT 5`
    );
    res.render('admin/dashboard', { title: '관리자', adminTab: 'home', s, recentUsers, recentPosts });
  } catch (err) {
    next(err);
  }
});

// ── 검토·신고 ─────────────────────────────────────────
router.get('/review', async (req, res, next) => {
  try {
    const pendingPosts = await db.query(
      `SELECT id, user_id, board, title, body, flag_words, created_at
       FROM posts WHERE status = 'pending' ORDER BY id ASC LIMIT 50`
    );
    const pendingComments = await db.query(
      `SELECT c.id, c.post_id, c.user_id, c.body, c.flag_words, c.created_at, p.title AS post_title
       FROM comments c JOIN posts p ON p.id = c.post_id
       WHERE c.status = 'pending' ORDER BY c.id ASC LIMIT 50`
    );
    const reported = await db.query(
      `SELECT r.target_type, r.target_id, COUNT(*) AS cnt,
              GROUP_CONCAT(DISTINCT r.reason) AS reasons, MAX(r.created_at) AS last_at,
              GROUP_CONCAT(NULLIF(r.detail, '') ORDER BY r.id DESC SEPARATOR '\n') AS details,
              COALESCE(p.title, LEFT(c.body, 80)) AS summary,
              COALESCE(p.status, c.status) AS status,
              COALESCE(p.user_id, c.user_id) AS user_id,
              COALESCE(p.id, c.post_id) AS post_id
       FROM reports r
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
       WHERE r.status = 'open'
       GROUP BY r.target_type, r.target_id, p.title, c.body, p.status, c.status, p.user_id, c.user_id, p.id, c.post_id
       ORDER BY cnt DESC, last_at DESC
       LIMIT 100`
    );
    res.render('admin/review', {
      title: '검토·신고 · 관리자',
      adminTab: 'review',
      pendingPosts,
      pendingComments,
      reported,
      reasons: config.reportReasons,
    });
  } catch (err) {
    next(err);
  }
});

// ── 게시글·댓글 ───────────────────────────────────────
const POST_PAGE = 30;
const POST_STATUS = ['visible', 'pending', 'hidden', 'deleted'];

router.get('/posts', async (req, res, next) => {
  try {
    const type = req.query.type === 'comment' ? 'comment' : 'post';
    const status = POST_STATUS.includes(req.query.status) ? req.query.status : '';
    const q = String(req.query.q || '').trim().slice(0, 50);
    const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
    const t = type === 'post' ? 'p' : 'c';
    const where = [];
    const params = [];
    if (status) {
      where.push(`${t}.status = ?`);
      params.push(status);
    }
    if (/^#\d{1,9}$/.test(q)) {
      // #12 = 회원 12의 글·댓글
      where.push(`${t}.user_id = ?`);
      params.push(Number(q.slice(1)));
    } else if (/^\d{1,9}$/.test(q)) {
      // 숫자만 = 글 번호 (댓글이면 그 글에 달린 댓글)
      where.push(type === 'post' ? 'p.id = ?' : 'c.post_id = ?');
      params.push(Number(q));
    } else if (q) {
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      if (type === 'post') {
        where.push('(p.title LIKE ? OR p.body LIKE ?)');
        params.push(like, like);
      } else {
        where.push('c.body LIKE ?');
        params.push(like);
      }
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = type === 'post'
      ? await db.query(
        `SELECT p.id, p.user_id, p.board, p.title, p.body, p.status, p.flag_words, p.up_count, p.down_count, p.comment_count, p.view_count, p.report_count, p.created_at,
                u.real_name, u.login_id
         FROM posts p JOIN users u ON u.id = p.user_id ${cond}
         ORDER BY p.id DESC LIMIT ? OFFSET ?`,
        [...params, POST_PAGE + 1, (page - 1) * POST_PAGE]
      )
      : await db.query(
        `SELECT c.id, c.post_id, c.user_id, c.anon_no, c.body, c.status, c.flag_words, c.up_count, c.down_count, c.report_count, c.created_at,
                p.title AS post_title, p.board, u.real_name, u.login_id
         FROM comments c JOIN posts p ON p.id = c.post_id JOIN users u ON u.id = c.user_id ${cond}
         ORDER BY c.id DESC LIMIT ? OFFSET ?`,
        [...params, POST_PAGE + 1, (page - 1) * POST_PAGE]
      );
    res.render('admin/posts', {
      title: '게시글 · 관리자',
      adminTab: 'posts',
      type,
      status,
      q,
      page,
      items: rows.slice(0, POST_PAGE),
      hasNext: rows.length > POST_PAGE,
    });
  } catch (err) {
    next(err);
  }
});

// 공개 / 가리기만 가능. 작성자가 지운 글·댓글은 기록으로만 남겨두고 바꾸지 않음
const ALLOWED = ['visible', 'hidden'];

router.post('/posts/:id/status', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const status = ALLOWED.includes(req.body.status) ? req.body.status : null;
    if (id && status) {
      await db.query(`UPDATE posts SET status = ? WHERE id = ? AND status <> 'deleted'`, [status, id]);
      await resolveReports('post', id);
    }
    res.redirect(backTo(req, '/admin/review'));
  } catch (err) {
    next(err);
  }
});

router.post('/comments/:id/status', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const status = ALLOWED.includes(req.body.status) ? req.body.status : null;
    const c = id && (await db.one(`SELECT post_id FROM comments WHERE id = ?`, [id]));
    if (c && status) {
      await db.query(`UPDATE comments SET status = ? WHERE id = ? AND status <> 'deleted'`, [status, id]);
      await resolveReports('comment', id);
      await refreshCommentCount(c.post_id);
    }
    res.redirect(backTo(req, '/admin/review'));
  } catch (err) {
    next(err);
  }
});

// 신고만 정리하고 글은 그대로 두기
router.post('/reports/dismiss', async (req, res, next) => {
  try {
    const type = req.body.type === 'comment' ? 'comment' : 'post';
    const id = toId(req.body.id);
    if (id) await resolveReports(type, id);
    res.redirect('/admin/review');
  } catch (err) {
    next(err);
  }
});

// ── 1:1 문의 ─────────────────────────────────────────
router.get('/inquiries', async (req, res, next) => {
  try {
    const show = req.query.show === 'answered' ? 'answered' : 'open';
    const inquiries = await db.query(
      show === 'open'
        ? `SELECT * FROM inquiries WHERE status = 'open' ORDER BY id ASC LIMIT 100`
        : `SELECT * FROM inquiries WHERE status = 'answered' ORDER BY answered_at DESC LIMIT 50`
    );
    res.render('admin/inquiries', {
      title: '문의 · 관리자',
      adminTab: 'inquiries',
      show,
      inquiries,
      inquiryCats: config.inquiry.categories,
    });
  } catch (err) {
    next(err);
  }
});

// 답변 (다시 보내면 답변을 고침)
router.post('/inquiries/:id/answer', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const answer = String(req.body.answer || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    if (id && answer) {
      await db.query(
        `UPDATE inquiries SET answer = ?, status = 'answered', answered_by = ?, answered_at = NOW(), user_seen = 0 WHERE id = ?`,
        [answer, req.user.id, id]
      );
      await notify.inquiryAnswered(id);
    }
    res.redirect(backTo(req, '/admin/inquiries'));
  } catch (err) {
    next(err);
  }
});

// ── 회원 ─────────────────────────────────────────────
const USER_PAGE = 30;

router.get('/users', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 30);
    const filter = ['banned', 'admin', 'noref'].includes(req.query.filter) ? req.query.filter : '';
    const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
    const where = [];
    const params = [];
    if (q) {
      const phone = normalizePhone(q);
      if (phone) {
        where.push('u.phone_hash = ?');
        params.push(hashPhone(phone));
      } else if (/^#?\d{1,9}$/.test(q)) {
        where.push('u.id = ?');
        params.push(Number(q.replace('#', '')));
      } else if (/^[가-힣]{2,10}$/.test(q)) {
        // 이름 (본인인증으로 받은 이름)
        where.push('u.real_name = ?');
        params.push(q);
      } else {
        // 추천인 코드 (내 코드 또는 가입할 때 넣은 코드) 또는 관리자 아이디
        where.push('(u.referral_code = ? OR u.referrer_code = ? OR u.login_id = ?)');
        params.push(q.toUpperCase(), q.toUpperCase(), q);
      }
    }
    if (filter === 'banned') where.push(`u.status = 'banned'`);
    if (filter === 'admin') where.push(`u.role = 'admin'`);
    if (filter === 'noref') where.push(`u.referrer_code IS NULL AND u.role <> 'admin'`);
    const rows = await db.query(
      `SELECT u.id, u.login_id, u.phone, u.real_name, u.birth_date, u.carrier, u.is_foreigner, u.gender, u.role, u.status, u.referral_code, u.referrer_code,
              u.identity_verified_at, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.status <> 'deleted') AS posts,
              (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.status <> 'deleted') AS comments,
              (SELECT COUNT(*) FROM reports r JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id WHERE p.user_id = u.id) +
              (SELECT COUNT(*) FROM reports r JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id WHERE c.user_id = u.id) AS reported,
              (SELECT COUNT(*) FROM users x WHERE x.referrer_id = u.id) AS invited
       FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...params, USER_PAGE + 1, (page - 1) * USER_PAGE]
    );
    rows.forEach((u) => { u.phoneText = formatPhone(u.phone); });
    res.render('admin/users', {
      title: '회원 · 관리자',
      adminTab: 'users',
      users: rows.slice(0, USER_PAGE),
      hasNext: rows.length > USER_PAGE,
      page,
      q,
      filter,
    });
  } catch (err) {
    next(err);
  }
});

// 이용 제한 / 해제 (관리자 계정은 제한 안 됨)
router.post('/users/:id/ban', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const status = req.body.ban === '1' ? 'banned' : 'active';
    if (id) await db.query(`UPDATE users SET status = ? WHERE id = ? AND role <> 'admin'`, [status, id]);
    res.redirect(backTo(req, '/admin/users'));
  } catch (err) {
    next(err);
  }
});

// ── 가게 (실시간강남) ─────────────────────────────────
const STORE_NOTICES = { saved: '가게 정보를 저장했어요.', added: '가게를 추가했어요.', hidden: '가게를 목록에서 숨겼어요.', shown: '가게를 다시 보이게 했어요.' };
const EMPTY_STORE = { id: null, region: '강남', dong: '', name: '', category: '', address: '', emoji: '', hours: '', intro: '', phone: '', lat: '', lng: '', is_active: 1 };

router.get('/stores', async (req, res, next) => {
  try {
    const stores = await db.query(
      `SELECT id, region, dong, name, category, address, emoji, hours, lat, lng, is_active, updated_at
       FROM stores ORDER BY is_active DESC, category, name`
    );
    res.render('admin/stores', {
      title: '가게 · 관리자',
      adminTab: 'stores',
      stores,
      notice: STORE_NOTICES[req.query.notice] || null,
    });
  } catch (err) {
    next(err);
  }
});

async function renderStoreForm(res, status, store, error) {
  // 입력칸 자동완성용: 이미 쓰고 있는 지역·업종
  const regions = (await db.query('SELECT DISTINCT region AS v FROM stores ORDER BY region')).map((r) => r.v);
  const categories = (await db.query('SELECT DISTINCT category AS v FROM stores ORDER BY category')).map((r) => r.v);
  res.status(status).render('admin/store-form', {
    title: (store.id ? '가게 수정' : '가게 추가') + ' · 관리자',
    adminTab: 'stores',
    store,
    error,
    regions,
    categories,
  });
}

router.get('/stores/new', async (req, res, next) => {
  try {
    await renderStoreForm(res, 200, { ...EMPTY_STORE }, null);
  } catch (err) {
    next(err);
  }
});

router.get('/stores/:id', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const store = id && (await db.one('SELECT * FROM stores WHERE id = ?', [id]));
    if (!store) return res.redirect('/admin/stores');
    await renderStoreForm(res, 200, store, null);
  } catch (err) {
    next(err);
  }
});

const txt = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const coord = (v, min, max) => {
  const s = String(v || '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
};

// 추가(id 없음) / 수정(id 있음)
router.post('/stores/save', async (req, res, next) => {
  try {
    const id = toId(req.body.id);
    const f = {
      id,
      region: txt(req.body.region, 20),
      dong: txt(req.body.dong, 20),
      name: txt(req.body.name, 50),
      category: txt(req.body.category, 20),
      address: txt(req.body.address, 200),
      emoji: txt(req.body.emoji, 16),
      hours: txt(req.body.hours, 100),
      intro: txt(req.body.intro, 200),
      phone: txt(req.body.phone, 20),
      lat: coord(req.body.lat, 33, 39),
      lng: coord(req.body.lng, 124, 132),
      is_active: req.body.is_active === '1' ? 1 : 0,
    };
    const fail = (msg) => renderStoreForm(res, 400, { ...f, lat: req.body.lat || '', lng: req.body.lng || '' }, msg);
    if (!f.region || !f.name || !f.category || !f.address) return fail('지역, 가게 이름, 업종, 상세주소는 꼭 적어주세요.');
    if (Number.isNaN(f.lat) || Number.isNaN(f.lng)) return fail('위도는 33~39, 경도는 124~132 사이 숫자로 적어주세요. 모르면 비워두세요.');
    if ((f.lat === null) !== (f.lng === null)) return fail('위도와 경도는 둘 다 적거나 둘 다 비워주세요.');
    // 동을 비워두면 주소가 'OO동 123' 꼴일 때 자동으로 채움
    if (!f.dong) f.dong = (f.address.match(/^(\S+동)\s/) || [])[1] || '';

    const vals = [f.region, f.dong || null, f.name, f.category, f.address, f.emoji || null, f.hours || null, f.intro || null, f.phone || null, f.lat, f.lng, f.is_active];
    if (id) {
      await db.query(
        `UPDATE stores SET region = ?, dong = ?, name = ?, category = ?, address = ?, emoji = ?, hours = ?, intro = ?, phone = ?, lat = ?, lng = ?, is_active = ? WHERE id = ?`,
        [...vals, id]
      );
      return res.redirect('/admin/stores?notice=saved');
    }
    await db.query(
      `INSERT INTO stores (region, dong, name, category, address, emoji, hours, intro, phone, lat, lng, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vals
    );
    res.redirect('/admin/stores?notice=added');
  } catch (err) {
    next(err);
  }
});

// 목록에서 숨기기 / 다시 보이기 (지우지 않음)
router.post('/stores/:id/active', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const on = req.body.active === '1' ? 1 : 0;
    if (id) await db.query('UPDATE stores SET is_active = ? WHERE id = ?', [on, id]);
    res.redirect(`/admin/stores?notice=${on ? 'shown' : 'hidden'}`);
  } catch (err) {
    next(err);
  }
});

// ── 광고 심사 ─────────────────────────────────────────
const AD_NOTICES = {
  ad_approved: '광고를 승인했어요.',
  ad_rejected: '광고를 반려했어요.',
  ad_suspended: '광고 게시를 중단했어요.',
  ad_not_active: '국세청에서 계속사업자로 확인되지 않아 승인하지 않았어요. 상태를 확인해주세요.',
  ad_no_key: 'NTS_BUSINESS_API_SERVICE_KEY 가 없어 사업자 상태를 확인할 수 없어요.',
  ad_nts_error: '국세청 확인이 잠시 안 돼요. 잠시 후 다시 해주세요.',
  ad_need_license: '이 업종은 영업허가증·신고증이 있어야 승인할 수 있어요.',
  ad_need_cert: '사업자등록증이 첨부되지 않아 승인할 수 없어요.',
  ad_need_reason: '반려·중단 사유를 적어주세요.',
};

router.get('/ads', async (req, res, next) => {
  try {
    const pendingAds = await db.query(`SELECT * FROM ads WHERE status = 'pending' ORDER BY id ASC LIMIT 50`);
    // 심사할 광고의 첨부 서류
    const adFiles = pendingAds.length
      ? await db.query(`SELECT id, ad_id, kind, mime FROM ad_files WHERE ad_id IN (?) ORDER BY FIELD(kind, 'biz_cert', 'license', 'etc'), id`, [pendingAds.map((a) => a.id)])
      : [];
    for (const a of pendingAds) {
      a.files = adFiles.filter((f) => f.ad_id === a.id);
      a.bodyHtml = richtext.view(a.body_html || a.body);
    }
    const liveAds = await db.query(
      `SELECT id, user_id, kind, category, business_name, b_no, title, status, status_note, nts_status, nts_status_cd, nts_checked_at, view_count, approved_at
       FROM ads WHERE status IN ('approved','suspended') ORDER BY status = 'suspended' DESC, approved_at DESC LIMIT 50`
    );
    res.render('admin/ads', {
      title: '광고 · 관리자',
      adminTab: 'ads',
      pendingAds,
      liveAds,
      adCategory: (k) => adsSvc.CATEGORY.get(k) || { name: k, license: null },
      docLabel: adsSvc.DOC_LABEL,
      payTypes: config.ads.payTypes,
      empTypes: config.ads.employmentTypes,
      ntsReady: nts.isConfigured(),
      notice: AD_NOTICES[req.query.notice] || null,
    });
  } catch (err) {
    next(err);
  }
});

// 첨부 서류 보기 (운영자만)
router.get('/ads/files/:id', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const doc = id && (await db.one(`SELECT file, mime FROM ad_files WHERE id = ?`, [id]));
    const file = doc && adsSvc.filePath(doc.file);
    if (!file) return res.status(404).render('error', { title: '파일 없음', message: '첨부한 서류가 없어요.' });
    res.set('Cache-Control', 'private, no-store');
    res.type(doc.mime);
    res.sendFile(file, { headers: { 'Content-Disposition': 'inline' } }, (err) => {
      if (err && !res.headersSent) res.status(404).render('error', { title: '파일 없음', message: '서류 파일을 찾을 수 없어요.' });
    });
  } catch (err) {
    next(err);
  }
});

// 승인: 승인 직전에 국세청 상태를 한 번 더 확인
router.post('/ads/:id/approve', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const ad = id && (await db.one(`SELECT id, b_no, category FROM ads WHERE id = ? AND status IN ('pending','suspended')`, [id]));
    if (!ad) return res.redirect('/admin/ads');
    const kinds = (await db.query(`SELECT DISTINCT kind FROM ad_files WHERE ad_id = ?`, [id])).map((r) => r.kind);
    if (!kinds.includes('biz_cert')) return res.redirect('/admin/ads?notice=ad_need_cert');
    const cat = adsSvc.CATEGORY.get(ad.category);
    if (cat && cat.license && !kinds.includes('license')) return res.redirect('/admin/ads?notice=ad_need_license');
    if (!nts.isConfigured()) return res.redirect('/admin/ads?notice=ad_no_key');
    let s;
    try {
      s = (await nts.statusMany([ad.b_no])).get(ad.b_no);
    } catch (e) {
      console.error('[광고] 승인 중 국세청 확인 실패:', e.message);
      return res.redirect('/admin/ads?notice=ad_nts_error');
    }
    if (s) await adsSvc.saveStatus(db.pool, 'id = ?', [id], s);
    if (!s || s.code !== nts.ACTIVE) return res.redirect('/admin/ads?notice=ad_not_active');
    await db.query(`UPDATE ads SET status = 'approved', status_note = NULL, approved_at = COALESCE(approved_at, UTC_TIMESTAMP()) WHERE id = ?`, [id]);
    await notify.adStatus(id, 'approved');
    res.redirect('/admin/ads?notice=ad_approved');
  } catch (err) {
    next(err);
  }
});

// 반려(심사 중) / 게시 중단(게시 중): 사유는 신청한 회원에게 보임
router.post('/ads/:id/reject', async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!note) return res.redirect('/admin/ads?notice=ad_need_reason');
    const ad = id && (await db.one(`SELECT status FROM ads WHERE id = ?`, [id]));
    if (ad && ad.status === 'pending') {
      await db.query(`UPDATE ads SET status = 'rejected', status_note = ? WHERE id = ?`, [note, id]);
      await notify.adStatus(id, 'rejected', note);
      return res.redirect('/admin/ads?notice=ad_rejected');
    }
    if (ad && ad.status === 'approved') {
      await db.query(`UPDATE ads SET status = 'suspended', status_note = ? WHERE id = ?`, [note, id]);
      await notify.adStatus(id, 'suspended', note);
      return res.redirect('/admin/ads?notice=ad_suspended');
    }
    res.redirect('/admin/ads');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
