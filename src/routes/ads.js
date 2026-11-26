// 광고: 19세 이상 강남 화류계 중심 커뮤니티에 맞는 업종(config.ads.categories)의 국세청 계속사업자만 등록 가능.
// 등록은 두 단계:
//   1단계 사업자: 상호·사업자번호(국세청 상태조회)·업종 + 서류(사업자등록증 필수, 영업허가증은 업종에 따라 필수, 기타)
//         → 작성 중(draft) 광고로 저장, 세션에 id
//   2단계 광고: 구인광고(기본) / 기타광고, 제목·에디터 본문·담당자·연락처·메신저, 구인이면 고용형태·급여·근무주소
//         → 심사 대기(pending) → 운영자 승인 뒤 /ads 에 노출
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const csrf = require('../middleware/csrf');
const { requireLogin, requireActive } = require('../middleware/auth');
const nts = require('../services/nts');
const ads = require('../services/ads');
const richtext = require('../services/richtext');

const router = express.Router();

const PAGE = 20;
const CATEGORIES = config.ads.categories;
const PAY_TYPES = config.ads.payTypes;
const EMP_TYPES = config.ads.employmentTypes;
const MAX_MB = Math.round(config.ads.licenseMaxBytes / 1024 / 1024);

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const bizNoOf = (v) => String(v || '').replace(/\D/g, '').slice(0, 10);

// 1단계 서류: 사업자등록증 1(필수) + 영업허가증·신고증 1 + 기타 서류 3까지, 파일마다 5MB
const ETC_MAX = 3;
const uploadDocs = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.ads.licenseMaxBytes, files: 2 + ETC_MAX, fields: 10, fieldSize: 2000 },
}).fields([
  { name: 'biz_cert', maxCount: 1 },
  { name: 'license', maxCount: 1 },
  { name: 'etc_files', maxCount: ETC_MAX },
]);
// 2단계 본문 이미지 (에디터에서 하나씩 올림)
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.ads.licenseMaxBytes, files: 1, fields: 2 },
}).single('image');

const NOTICES = {
  applied: '광고가 접수됐어요. 운영자가 확인한 뒤 올라가요.',
  ended: '광고를 내렸어요.',
};

function payText(a) {
  return a.pay_type ? `${PAY_TYPES[a.pay_type]} ${Number(a.pay_amount).toLocaleString('ko-KR')}원` : '';
}

// ── 목록 ─────────────────────────────────────────────
router.get('/ads', requireLogin, async (req, res, next) => {
  try {
    // 한 목록: 구인광고(kind='job')가 먼저, 그다음 기타광고 (각각 최근 승인 순)
    // cat=job 은 업종이 아니라 '구인구직' 묶음: 구인광고(kind='job')만 모아 보기
    const cat = req.query.cat === 'job' || ads.CATEGORY.has(req.query.cat) ? req.query.cat : null;
    const where = cat === 'job' ? "AND kind = 'job'" : cat ? 'AND category = ?' : '';
    const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
    const rows = await db.query(
      `SELECT id, kind, category, business_name, title, LEFT(body, 140) AS preview, address,
              EXISTS (SELECT 1 FROM ad_files f WHERE f.ad_id = ads.id AND f.kind = 'license') AS has_license,
              employment_type, job_role, pay_type, pay_amount, work_hours, approved_at
       FROM ads WHERE status = 'approved' ${where}
       ORDER BY kind = 'job' DESC, approved_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...(cat && cat !== 'job' ? [cat] : []), PAGE + 1, (page - 1) * PAGE]
    );
    const mine = await db.one(`SELECT COUNT(*) AS n FROM ads WHERE user_id = ? AND status NOT IN ('ended','draft')`, [req.user.id]);
    res.render('ads', {
      title: '광고',
      nav: 'ads',
      payText,
      empTypes: EMP_TYPES,
      list: rows.slice(0, PAGE),
      hasNext: rows.length > PAGE,
      page,
      cat,
      categories: CATEGORIES,
      banned: config.ads.banned,
      catName: (k) => (ads.CATEGORY.get(k) || {}).name || '기타',
      myCount: Number(mine.n),
      notice: NOTICES[req.query.notice] || null,
    });
  } catch (err) {
    next(err);
  }
});

// ── 등록 공통 ─────────────────────────────────────────
const NO_KEY = '지금은 사업자 확인 기능이 준비되지 않아 등록할 수 없어요.';
const STATUS_MSG = {
  '02': '국세청에 휴업 상태로 나와서 광고를 등록할 수 없어요.',
  '03': '국세청에 폐업 상태로 나와서 광고를 등록할 수 없어요.',
};

// 세션에 있는 내 작성 중 광고 (1단계 완료)
async function currentDraft(req) {
  const id = toId(req.session.adDraft);
  if (!id) return null;
  const d = await db.one(`SELECT * FROM ads WHERE id = ? AND user_id = ? AND status = 'draft'`, [id, req.user.id]);
  if (!d) delete req.session.adDraft;
  return d;
}

// error: 화면 위 문구. errorField 를 주면 그 입력칸 바로 아래에 보임
async function renderForm(req, res, { draft = null, bizForm = {}, form = {}, error = null, errorField = null }, status = 200) {
  const docs = draft ? await db.query(`SELECT kind, COUNT(*) AS n FROM ad_files WHERE ad_id = ? GROUP BY kind`, [draft.id]) : [];
  res.status(status).render('ad-new', {
    title: '광고 등록',
    nav: 'ads',
    step: draft ? 2 : 1,
    draft,
    docs: Object.fromEntries(docs.map((d) => [d.kind, Number(d.n)])),
    bizForm,
    form: { kind: 'job', ...form, body_html: form.body_html ? richtext.withImageUrls(form.body_html) : form.body_html },
    payTypes: PAY_TYPES,
    empTypes: EMP_TYPES,
    minWage: config.ads.minWageHourly,
    error,
    errorField,
    categories: CATEGORIES,
    catName: (k) => (ads.CATEGORY.get(k) || {}).name || '기타',
    docLabel: ads.DOC_LABEL,
    banned: config.ads.banned,
    ntsReady: nts.isConfigured(),
    maxMb: MAX_MB,
    etcMax: ETC_MAX,
    imageMax: config.ads.bodyImageMax,
    textColors: richtext.TEXT_COLORS,
    bgColors: richtext.BG_COLORS,
  });
}

// 심사 중 + 게시 중 광고 수, 다른 회원의 같은 사업자 광고 확인
async function limitError(userId, bNo) {
  const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ads WHERE user_id = ? AND status IN ('pending','approved')`, [userId]);
  if (Number(n) >= config.ads.perUserLimit) {
    return { msg: `심사 중이거나 게시 중인 광고는 ${config.ads.perUserLimit}개까지예요. 내 광고에서 정리한 뒤 등록해주세요.`, field: null };
  }
  const dup = await db.one(`SELECT 1 FROM ads WHERE b_no = ? AND user_id <> ? AND status IN ('pending','approved') LIMIT 1`, [bNo, userId]);
  if (dup) return { msg: '이 사업자등록번호로 다른 회원이 등록한 광고가 있어요. 운영자에게 문의해주세요.', field: 'b_no' };
  return null;
}

// 국세청 상태조회 → { ok, status, msg }
async function checkBizNo(bNo) {
  if (!/^\d{10}$/.test(bNo)) return { ok: false, msg: '사업자등록번호 10자리를 적어주세요.' };
  let s;
  try {
    s = (await nts.statusMany([bNo])).get(bNo);
  } catch (e) {
    console.error('[광고] 국세청 상태조회 실패:', e.message);
    return { ok: false, error: true, msg: '국세청 사업자 확인이 잠시 안 돼요. 잠시 후 다시 시도해주세요.' };
  }
  if (!s || !s.code) return { ok: false, msg: '국세청에 등록되지 않은 사업자등록번호예요.' };
  if (s.code !== nts.ACTIVE) return { ok: false, status: s, msg: STATUS_MSG[s.code] || '국세청에서 계속사업자로 확인되지 않아 등록할 수 없어요.' };
  return { ok: true, status: s };
}

router.get('/ads/new', requireLogin, requireActive, async (req, res, next) => {
  try {
    if (req.query.reset === '1') {
      const d = await currentDraft(req);
      if (d) await ads.removeDraft(d.id, req.user.id);
      delete req.session.adDraft;
      return res.redirect('/ads/new');
    }
    const draft = await currentDraft(req);
    await renderForm(req, res, { draft, error: nts.isConfigured() ? null : NO_KEY });
  } catch (err) {
    next(err);
  }
});

// 1단계 화면의 [조회] 버튼 (JSON). 세션당 시간마다 30번까지
router.post('/ads/check', requireLogin, requireActive, async (req, res, next) => {
  try {
    if (!nts.isConfigured()) return res.status(503).json({ ok: false, msg: NO_KEY });
    const now = Date.now();
    const t = (req.session.adCheck || []).filter((x) => now - x < 3600 * 1000);
    if (t.length >= 30) return res.status(429).json({ ok: false, msg: '조회를 너무 많이 했어요. 잠시 후 다시 해주세요.' });
    req.session.adCheck = t.concat(now);
    const bNo = bizNoOf((req.body || {}).b_no);
    const limit = /^\d{10}$/.test(bNo) ? await limitError(req.user.id, bNo) : null;
    if (limit && limit.field) return res.json({ ok: false, msg: limit.msg });
    const r = await checkBizNo(bNo);
    res.json({ ok: r.ok, msg: r.msg || null, name: r.status ? r.status.name : null, taxType: r.status ? r.status.taxType : null });
  } catch (err) {
    next(err);
  }
});

const UPLOAD_ERR = {
  LIMIT_FILE_SIZE: `파일은 하나에 ${MAX_MB}MB 이하로 올려주세요.`,
  LIMIT_FILE_COUNT: `기타 서류는 ${ETC_MAX}개까지 올릴 수 있어요.`,
  LIMIT_UNEXPECTED_FILE: `기타 서류는 ${ETC_MAX}개까지 올릴 수 있어요.`,
};

// 1단계 제출: 사업자 확인 + 서류 → 작성 중 광고
router.post('/ads/new/biz', requireLogin, requireActive, (req, res, next) => {
  uploadDocs(req, res, async (upErr) => {
    try {
      if (!csrf.verify(req)) {
        return res.status(403).render('error', { title: '요청 만료', message: '페이지를 새로고침한 뒤 다시 시도해주세요.' });
      }
      const b = req.body || {};
      const f = { business_name: str(b.business_name, 60), b_no: bizNoOf(b.b_no), category: ads.CATEGORY.has(b.category) ? b.category : '' };
      const fail = (error, errorField = null, status = 400) => renderForm(req, res, { bizForm: f, error, errorField }, status);
      if (!nts.isConfigured()) return fail(NO_KEY, null, 503);
      if (upErr) {
        const field = upErr.field === 'biz_cert' || upErr.field === 'license' ? upErr.field : 'etc_files';
        return fail(UPLOAD_ERR[upErr.code] || '파일을 올리지 못했어요. 다시 시도해주세요.', field);
      }
      if (!f.business_name) return fail('상호를 적어주세요.', 'business_name');
      if (!/^\d{10}$/.test(f.b_no)) return fail('사업자등록번호 10자리를 적어주세요.', 'b_no');
      const cat = ads.CATEGORY.get(f.category);
      if (!cat) return fail('업종을 골라주세요.', 'category');
      const up = req.files || {};
      const files = { biz_cert: (up.biz_cert || [])[0], license: (up.license || [])[0], etc: up.etc_files || [] };
      const BAD = '서류는 JPG, PNG, WEBP 사진이나 PDF 파일로 올려주세요.';
      if (!files.biz_cert) return fail('사업자등록증을 첨부해주세요.', 'biz_cert');
      if (!ads.sniff(files.biz_cert.buffer)) return fail(BAD, 'biz_cert');
      if (cat.license && !files.license) return fail(`${cat.name} 업종은 ${cat.license}을(를) 첨부해야 해요.`, 'license');
      if (files.license && !ads.sniff(files.license.buffer)) return fail(BAD, 'license');
      if (files.etc.some((x) => !ads.sniff(x.buffer))) return fail(BAD, 'etc_files');
      const limit = await limitError(req.user.id, f.b_no);
      if (limit) return fail(limit.msg, limit.field);
      const r = await checkBizNo(f.b_no);
      if (!r.ok) return fail(r.msg, r.error ? null : 'b_no', r.error ? 503 : 400);

      // 예전 작성 중 광고가 있으면 지우고 새로
      const old = await currentDraft(req);
      if (old) await ads.removeDraft(old.id, req.user.id);
      const s = r.status;
      const docs = [{ kind: 'biz_cert', buf: files.biz_cert.buffer }]
        .concat(files.license ? [{ kind: 'license', buf: files.license.buffer }] : [])
        .concat(files.etc.map((x) => ({ kind: 'etc', buf: x.buffer })));
      const id = await db.tx(async (conn) => {
        const [ins] = await conn.query(
          `INSERT INTO ads (user_id, kind, category, business_name, b_no, title, body, address, phone, status,
                            nts_status, nts_status_cd, nts_tax_type, nts_checked_at)
           VALUES (?, 'job', ?, ?, ?, '', '', '', '', 'draft', ?, ?, ?, UTC_TIMESTAMP())`,
          [req.user.id, f.category, f.business_name, f.b_no, s.name || null, s.code || null, s.taxType ? s.taxType.slice(0, 100) : null]
        );
        await ads.attachFiles(conn, ins.insertId, docs);
        return ins.insertId;
      });
      req.session.adDraft = id;
      req.session.adImages = 0;
      res.redirect('/ads/new');
    } catch (e) {
      next(e);
    }
  });
});

// 2단계 에디터 이미지 올리기 (JSON, X-CSRF-Token 헤더)
router.post('/ads/images', requireLogin, requireActive, (req, res, next) => {
  uploadImage(req, res, async (upErr) => {
    try {
      if (!(await currentDraft(req))) return res.status(400).json({ ok: false, message: '사업자 확인부터 해주세요.' });
      if (upErr) return res.status(400).json({ ok: false, message: upErr.code === 'LIMIT_FILE_SIZE' ? `사진은 ${MAX_MB}MB 이하로 올려주세요.` : '사진을 올리지 못했어요.' });
      if (!req.file) return res.status(400).json({ ok: false, message: '사진을 골라주세요.' });
      if ((req.session.adImages || 0) >= config.ads.bodyImageMax) {
        return res.status(400).json({ ok: false, message: `사진은 ${config.ads.bodyImageMax}장까지 넣을 수 있어요.` });
      }
      const saved = await ads.saveImage(req.file.buffer);
      if (!saved) return res.status(400).json({ ok: false, message: '사진은 JPG, PNG, WEBP 만 넣을 수 있어요.' });
      req.session.adImages = (req.session.adImages || 0) + 1;
      res.json({ ok: true, url: saved.url });
    } catch (e) {
      next(e);
    }
  });
});

function readAdForm(body) {
  const kind = body.kind === 'ad' ? 'ad' : 'job';
  const job = kind === 'job';
  const html = richtext.clean(body.body_html);
  return {
    kind,
    title: str(body.title, 60),
    body_html: html,
    body: richtext.toText(html).slice(0, 1000),
    contact_name: str(body.contact_name, 30),
    phone: str(body.phone, 20),
    kakao_id: str(body.kakao_id, 50),
    line_id: str(body.line_id, 50),
    wechat_id: str(body.wechat_id, 50),
    telegram_id: str(body.telegram_id, 50),
    address: job ? str(body.address, 200) : '', // 기타광고는 주소 안 받음
    employment_type: job && EMP_TYPES[body.employment_type] ? body.employment_type : '',
    job_role: job ? str(body.job_role, 40) : '',
    pay_type: job && PAY_TYPES[body.pay_type] ? body.pay_type : '',
    pay_amount: job ? Number(String(body.pay_amount || '').replace(/[^0-9]/g, '').slice(0, 9)) || 0 : 0,
    work_hours: job ? str(body.work_hours, 60) : '',
    agree: body.agree === '1',
  };
}

// → null 또는 { field, msg }
function checkAdForm(f) {
  const E = (field, msg) => ({ field, msg });
  if (f.title.length < 2) return E('title', '제목을 2자 이상 적어주세요.');
  if (f.body.replace(/\s/g, '').length < 10) return E('body_html', '내용을 10자 이상 적어주세요.');
  if (f.body_html.length > 100000) return E('body_html', '내용이 너무 길어요.');
  if (richtext.imageCount(f.body_html) > config.ads.bodyImageMax) return E('body_html', `사진은 ${config.ads.bodyImageMax}장까지 넣을 수 있어요.`);
  if (f.kind === 'job') {
    if (!f.employment_type) return E('employment_type', '고용형태를 골라주세요.');
    if (!f.pay_type) return E('pay', '급여 방식을 골라주세요.');
    if (!f.pay_amount) return E('pay', '급여를 숫자로 적어주세요.');
    if (f.pay_type === 'hour' && f.pay_amount < config.ads.minWageHourly) {
      return E('pay', `시급은 최저임금(${config.ads.minWageHourly.toLocaleString('ko-KR')}원) 이상이어야 해요.`);
    }
    if (f.address.length < 2) return E('address', '근무 주소를 적어주세요.');
  }
  if (!f.contact_name) return E('contact_name', '담당자를 적어주세요.');
  if (!/^0\d{1,3}-?\d{3,4}-?\d{4}$/.test(f.phone)) return E('phone', '담당자 연락처를 010-1234-5678 처럼 적어주세요.');
  const text = [f.title, f.body, f.job_role, f.work_hours, f.contact_name].join(' ').replace(/\s+/g, '');
  const hit = config.ads.blockedWords.find((w) => text.includes(w));
  if (hit) return E(null, `'${hit}' 같은 표현이 들어간 광고는 받지 않아요. 받지 않는 광고를 확인해주세요.`);
  if (!f.agree) return E('agree', '광고 내용 확인에 동의해주세요.');
  return null;
}

// 2단계 제출: 광고 내용 → 심사 대기
router.post('/ads/new', requireLogin, requireActive, async (req, res, next) => {
  try {
    const draft = await currentDraft(req);
    if (!draft) return renderForm(req, res, { error: '사업자 확인이 만료됐어요. 사업자 정보부터 다시 입력해주세요.' }, 400);
    const form = readAdForm(req.body || {});
    const err = checkAdForm(form);
    if (err) return renderForm(req, res, { draft, form, error: err.msg, errorField: err.field }, 400);
    const limit = await limitError(req.user.id, draft.b_no);
    if (limit) return renderForm(req, res, { draft, form, error: limit.msg }, 400);
    const job = form.kind === 'job';
    await db.query(
      `UPDATE ads SET kind = ?, title = ?, body = ?, body_html = ?, contact_name = ?, phone = ?,
              kakao_id = ?, line_id = ?, wechat_id = ?, telegram_id = ?, address = ?,
              employment_type = ?, job_role = ?, pay_type = ?, pay_amount = ?, work_hours = ?,
              status = 'pending', created_at = UTC_TIMESTAMP()
       WHERE id = ? AND user_id = ? AND status = 'draft'`,
      [form.kind, form.title, form.body, form.body_html, form.contact_name, form.phone,
        form.kakao_id || null, form.line_id || null, form.wechat_id || null, form.telegram_id || null, form.address,
        job ? form.employment_type : null, job ? form.job_role || null : null, job ? form.pay_type : null,
        job ? form.pay_amount : null, job ? form.work_hours || null : null,
        draft.id, req.user.id]
    );
    delete req.session.adDraft;
    delete req.session.adImages;
    res.redirect('/ads/mine?notice=applied');
  } catch (err) {
    next(err);
  }
});

// ── 내 광고 ───────────────────────────────────────────
router.get('/ads/mine', requireLogin, async (req, res, next) => {
  try {
    const list = await db.query(
      `SELECT id, kind, category, business_name, title, status, status_note, nts_status, nts_checked_at, view_count, created_at, approved_at
       FROM ads WHERE user_id = ? AND status <> 'draft' ORDER BY id DESC LIMIT 50`,
      [req.user.id]
    );
    res.render('ad-mine', {
      title: '내 광고',
      nav: 'ads',
      list,
      catName: (k) => (ads.CATEGORY.get(k) || {}).name || '기타',
      notice: NOTICES[req.query.notice] || null,
      limit: config.ads.perUserLimit,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ads/:id/end', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    if (id) {
      await db.query(
        `UPDATE ads SET status = 'ended', status_note = NULL WHERE id = ? AND user_id = ? AND status IN ('pending','approved','suspended')`,
        [id, req.user.id]
      );
    }
    res.redirect('/ads/mine?notice=ended');
  } catch (err) {
    next(err);
  }
});

// ── 상세 ─────────────────────────────────────────────
router.get('/ads/:id', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const ad = id && (await db.one(`SELECT * FROM ads WHERE id = ? AND status <> 'draft'`, [id]));
    const isOwner = ad && ad.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!ad || (ad.status !== 'approved' && !isOwner && !isAdmin)) {
      return res.status(404).render('error', { title: '광고 없음', message: '내려갔거나 없는 광고예요.' });
    }
    if (ad.status === 'approved' && !isOwner) {
      await db.query(`UPDATE ads SET view_count = view_count + 1 WHERE id = ?`, [id]);
    }
    const cat = ads.CATEGORY.get(ad.category) || { name: '기타', license: null };
    ad.has_license = Boolean(await db.one(`SELECT 1 FROM ad_files WHERE ad_id = ? AND kind = 'license' LIMIT 1`, [id]));
    // 저장할 때 정리했지만 보여줄 때도 한 번 더
    const bodyHtml = richtext.view(ad.body_html || ad.body);
    res.render('ad', { title: ad.business_name, nav: 'ads', ad, cat, isOwner, payText: payText(ad), empTypes: EMP_TYPES, bodyHtml });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
