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
  edited: '광고를 수정했어요. 운영자가 다시 확인한 뒤 올라가요.',
};

// 등록한 사람이 고칠 수 있는 상태. 고치면 다시 심사 대기(pending) → 승인 뒤 다시 게시 (내용 바꿔치기 방지)
const EDITABLE = ['pending', 'approved', 'suspended', 'rejected'];

// 세션의 수정 중 광고 (GET /ads/:id/edit 에서 시작). id 가 맞고 아직 고칠 수 있는 상태일 때만
async function currentEdit(req, id) {
  const e = req.session.adEdit;
  if (!e || !id || e.id !== id) return null;
  const ad = await db.one(`SELECT * FROM ads WHERE id = ? AND user_id = ? AND status IN (?)`, [id, req.user.id, EDITABLE]);
  if (!ad) delete req.session.adEdit;
  return ad;
}

// 이미지 올리기 대상: ?edit=<id> 면 수정 중 광고, 아니면 작성 중(draft) 광고
async function uploadTarget(req) {
  if (req.query.edit !== undefined) {
    const ad = await currentEdit(req, toId(req.query.edit));
    return ad ? { mode: 'edit', ad } : null;
  }
  const ad = await currentDraft(req);
  return ad ? { mode: 'draft', ad } : null;
}

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
      `SELECT id, kind, category, business_name, title, store_name, store_hours, address, dong, contact_name, cover_image, view_count,
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
      coverUrl: ads.coverUrl,
      dongOf: ads.dongOf,
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
// edit 를 주면 그 광고를 고치는 화면 (2단계 화면 그대로, 사업자 정보는 바꿀 수 없음)
async function renderForm(req, res, { draft = null, edit = null, bizForm = {}, form = {}, error = null, errorField = null }, status = 200) {
  if (edit) draft = edit;
  const docs = draft ? await db.query(`SELECT kind, COUNT(*) AS n FROM ad_files WHERE ad_id = ? GROUP BY kind`, [draft.id]) : [];
  // 수정 중 대표 이미지: 제출 전까지는 세션에만 (undefined 면 그대로, '' 면 뺌)
  let coverName = draft ? draft.cover_image : null;
  if (edit && req.session.adEdit && req.session.adEdit.cover !== undefined) coverName = req.session.adEdit.cover || null;
  // 2단계(광고 작성·수정)만: 카카오 우편번호 검색 창이 빈 iframe 안에 인라인 style 로 크기를 넣어서 이 화면에서만 허용
  if (draft) {
    const csp = res.getHeader('Content-Security-Policy');
    if (csp) res.setHeader('Content-Security-Policy', String(csp).replace(/style-src ([^;]*)/, (m, v) => `style-src ${v} 'unsafe-inline'`));
  }
  res.status(status).render('ad-new', {
    title: edit ? '광고 수정' : '광고 등록',
    nav: 'ads',
    step: draft ? 2 : 1,
    draft,
    edit,
    cover: draft ? { url: ads.coverUrl(coverName), set: !!coverName, def: ads.DEFAULT_COVER } : null,
    docs: Object.fromEntries(docs.map((d) => [d.kind, Number(d.n)])),
    bizForm,
    form: { kind: 'job', store_name: draft ? draft.store_name || draft.business_name : '', ...form, body_html: form.body_html ? richtext.withImageUrls(form.body_html) : form.body_html },
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
    hourTimes: ads.HOUR_TIMES,
    weekdays: ads.WEEKDAYS,
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
      if (!(await uploadTarget(req))) return res.status(400).json({ ok: false, message: '광고 작성 화면을 다시 열어주세요.' });
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

// 2단계 대표 이미지: 고르면 바로 올려서 작성 중 광고에 저장 (JSON, X-CSRF-Token 헤더)
router.post('/ads/cover', requireLogin, requireActive, (req, res, next) => {
  uploadImage(req, res, async (upErr) => {
    try {
      const target = await uploadTarget(req);
      if (!target) return res.status(400).json({ ok: false, message: '광고 작성 화면을 다시 열어주세요.' });
      if (upErr) return res.status(400).json({ ok: false, message: upErr.code === 'LIMIT_FILE_SIZE' ? `사진은 ${MAX_MB}MB 이하로 올려주세요.` : '사진을 올리지 못했어요.' });
      if (!req.file) return res.status(400).json({ ok: false, message: '사진을 골라주세요.' });
      const saved = await ads.saveImage(req.file.buffer);
      if (!saved) return res.status(400).json({ ok: false, message: '사진은 JPG, PNG, WEBP 만 넣을 수 있어요.' });
      if (target.mode === 'edit') req.session.adEdit.cover = saved.name; // 수정은 제출할 때 반영
      else await db.query(`UPDATE ads SET cover_image = ? WHERE id = ? AND user_id = ? AND status = 'draft'`, [saved.name, target.ad.id, req.user.id]);
      res.json({ ok: true, url: ads.coverUrl(saved.name) });
    } catch (e) {
      next(e);
    }
  });
});

// 대표 이미지 빼기 → 기본 이미지
router.post('/ads/cover/remove', requireLogin, requireActive, async (req, res, next) => {
  try {
    const target = await uploadTarget(req);
    if (!target) return res.status(400).json({ ok: false, message: '광고 작성 화면을 다시 열어주세요.' });
    if (target.mode === 'edit') req.session.adEdit.cover = '';
    else await db.query(`UPDATE ads SET cover_image = NULL WHERE id = ? AND user_id = ? AND status = 'draft'`, [target.ad.id, req.user.id]);
    res.json({ ok: true, url: ads.DEFAULT_COVER });
  } catch (e) {
    next(e);
  }
});

function readAdForm(body) {
  const kind = body.kind === 'ad' ? 'ad' : 'job';
  const job = kind === 'job';
  const html = richtext.clean(body.body_html);
  return {
    kind,
    title: str(body.title, 60),
    // 업체명 (손님이 아는 가게 이름, 사업자등록증의 상호와 다를 수 있음). 목록 제목 앞에 '역삼동 달리는토끼' 처럼
    store_name: str(body.store_name, 40),
    // 영업시간 (선택): 시각 고르기 + 휴무 요일 체크 → 보일 문구는 store_hours
    ...(() => {
      const h = ads.readHours(body);
      return { hours_open: h.open, hours_close: h.close, closed_days: h.days.join(','), hours_error: h.error, store_hours: ads.hoursText(h.open, h.close, h.days) };
    })(),
    body_html: html,
    body: richtext.toText(html).slice(0, 1000),
    contact_name: str(body.contact_name, 30),
    phone: str(body.phone, 20),
    kakao_id: str(body.kakao_id, 50),
    line_id: str(body.line_id, 50),
    wechat_id: str(body.wechat_id, 50),
    telegram_id: str(body.telegram_id, 50),
    // 주소: 카카오(다음) 주소 검색으로 고른 기본 주소 + 직접 적는 상세 주소. 구인·기타광고 모두 필수
    address: [str(body.address, 150), str(body.address_detail, 60)].filter(Boolean).join(' ').slice(0, 200),
    dong: ads.dongOf(body.dong, body.address),
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
  if (!f.store_name) return E('store_name', '업체명을 적어주세요.');
  if (f.hours_error) return E('hours', f.hours_error);
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
  }
  if (f.address.length < 2) return E('address', f.kind === 'job' ? '근무 주소를 검색해서 넣어주세요.' : '업장 주소를 검색해서 넣어주세요.');
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
      `UPDATE ads SET kind = ?, store_name = ?, store_hours = ?, hours_open = ?, hours_close = ?, closed_days = ?, title = ?, body = ?, body_html = ?, contact_name = ?, phone = ?,
              kakao_id = ?, line_id = ?, wechat_id = ?, telegram_id = ?, address = ?, dong = ?,
              employment_type = ?, job_role = ?, pay_type = ?, pay_amount = ?, work_hours = ?,
              status = 'pending', created_at = UTC_TIMESTAMP()
       WHERE id = ? AND user_id = ? AND status = 'draft'`,
      [form.kind, form.store_name, form.store_hours || null, form.hours_open || null, form.hours_close || null, form.closed_days || null, form.title, form.body, form.body_html, form.contact_name, form.phone,
        form.kakao_id || null, form.line_id || null, form.wechat_id || null, form.telegram_id || null, form.address, form.dong,
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

// ── 수정 (등록한 사람) ─────────────────────────────────
// 사업자 정보·서류는 그대로 두고 광고 내용만 고침. 제출하면 다시 심사 대기
router.get('/ads/:id/edit', requireLogin, requireActive, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const ad = id && (await db.one(`SELECT * FROM ads WHERE id = ? AND user_id = ? AND status IN (?)`, [id, req.user.id, EDITABLE]));
    if (!ad) return res.status(404).render('error', { title: '광고 없음', message: '고칠 수 있는 광고가 아니에요.' });
    // 화면을 새로 열 때마다 수정 상태를 처음부터 (대표 이미지 바꾼 것도 취소)
    req.session.adEdit = { id };
    req.session.adImages = richtext.imageCount(ad.body_html || '');
    const form = {
      kind: ad.kind,
      store_name: ad.store_name || ad.business_name,
      hours_open: ad.hours_open,
      hours_close: ad.hours_close,
      closed_days: ad.closed_days,
      title: ad.title,
      body_html: ad.body_html || richtext.clean(ad.body),
      contact_name: ad.contact_name,
      phone: ad.phone,
      kakao_id: ad.kakao_id,
      line_id: ad.line_id,
      wechat_id: ad.wechat_id,
      telegram_id: ad.telegram_id,
      address: ad.address,
      dong: ad.dong,
      employment_type: ad.employment_type,
      job_role: ad.job_role,
      pay_type: ad.pay_type,
      pay_amount: ad.pay_amount,
      work_hours: ad.work_hours,
    };
    await renderForm(req, res, { edit: ad, form });
  } catch (err) {
    next(err);
  }
});

router.post('/ads/:id/edit', requireLogin, requireActive, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const ad = await currentEdit(req, id);
    if (!ad) return res.status(400).render('error', { title: '광고 수정', message: '수정 화면이 만료됐어요. 내 광고에서 다시 열어주세요.' });
    const form = readAdForm(req.body || {});
    const err = checkAdForm(form);
    if (err) return renderForm(req, res, { edit: ad, form, error: err.msg, errorField: err.field }, 400);
    // 반려·중단된 광고를 다시 심사에 올릴 때는 개수 제한·같은 사업자 확인
    if (!['pending', 'approved'].includes(ad.status)) {
      const limit = await limitError(req.user.id, ad.b_no);
      if (limit) return renderForm(req, res, { edit: ad, form, error: limit.msg }, 400);
    }
    const cover = req.session.adEdit.cover === undefined ? ad.cover_image : req.session.adEdit.cover || null;
    const job = form.kind === 'job';
    await db.query(
      `UPDATE ads SET kind = ?, store_name = ?, store_hours = ?, hours_open = ?, hours_close = ?, closed_days = ?, title = ?, body = ?, body_html = ?, cover_image = ?, contact_name = ?, phone = ?,
              kakao_id = ?, line_id = ?, wechat_id = ?, telegram_id = ?, address = ?, dong = ?,
              employment_type = ?, job_role = ?, pay_type = ?, pay_amount = ?, work_hours = ?,
              status = 'pending', status_note = NULL
       WHERE id = ? AND user_id = ? AND status IN (?)`,
      [form.kind, form.store_name, form.store_hours || null, form.hours_open || null, form.hours_close || null, form.closed_days || null, form.title, form.body, form.body_html, cover, form.contact_name, form.phone,
        form.kakao_id || null, form.line_id || null, form.wechat_id || null, form.telegram_id || null, form.address, form.dong,
        job ? form.employment_type : null, job ? form.job_role || null : null, job ? form.pay_type : null,
        job ? form.pay_amount : null, job ? form.work_hours || null : null,
        id, req.user.id, EDITABLE]
    );
    delete req.session.adEdit;
    delete req.session.adImages;
    res.redirect('/ads/mine?notice=edited');
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
    if (ad.status === 'approved') { // 게시 중이면 등록한 본인이 봐도 셈
      await db.query(`UPDATE ads SET view_count = view_count + 1 WHERE id = ?`, [id]);
    }
    const cat = ads.CATEGORY.get(ad.category) || { name: '기타', license: null };
    ad.has_license = Boolean(await db.one(`SELECT 1 FROM ad_files WHERE ad_id = ? AND kind = 'license' LIMIT 1`, [id]));
    // 저장할 때 정리했지만 보여줄 때도 한 번 더
    const bodyHtml = richtext.view(ad.body_html || ad.body);
    res.render('ad', { title: ad.store_name || ad.business_name, nav: 'ads', ad, cat, isOwner, payText: payText(ad), empTypes: EMP_TYPES, bodyHtml, coverUrl: ads.coverUrl(ad.cover_image), coverSet: !!ad.cover_image, dongOf: ads.dongOf, kakaoKey: config.kakaoJsKey });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
