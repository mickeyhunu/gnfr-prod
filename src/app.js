const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');

const config = require('./config');
const db = require('./db');
const { applySchema } = require('./schema');
const csrf = require('./middleware/csrf');
const { loadUser } = require('./middleware/auth');
const helpers = require('./services/helpers');
const kcp = require('./services/kcp');
const storage = require('./services/storage');

const app = express();

if (config.isProd) app.set('trust proxy', 1); // nginx 등 프록시 뒤에서 실행할 때

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        // 카카오맵: SDK(dapi.kakao.com) → 본체 스크립트(t1.kakaocdn.net, 예전 t1.daumcdn.net), 지도 타일·마커 이미지(*.daumcdn.net, *.kakaocdn.net)
        // 카카오 SDK 는 페이지와 같은 프로토콜로 불러오므로 http/https 둘 다 맞도록 프로토콜 없이 적음
        // 광고 이미지: S3 버킷 주소 (storage.publicOrigin)
        imgSrc: ["'self'", 'data:', '*.daumcdn.net', '*.kakao.com', '*.kakaocdn.net', ...(storage.publicOrigin() ? [storage.publicOrigin()] : [])],
        scriptSrc: ["'self'", 'dapi.kakao.com', 't1.daumcdn.net', 't1.kakaocdn.net'],
        connectSrc: ["'self'", 'dapi.kakao.com'],
        // KCP 본인확인: 인증 화면(call_url)으로 폼 전송
        formAction: ["'self'", 'https://cert.kcp.co.kr', 'https://testcert.kcp.co.kr', ...(config.kcp.apiHost ? [new URL(config.kcp.apiHost).origin] : [])],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    // KCP 본인확인 팝업이 KCP 화면을 거쳐 돌아와도 원래 창(opener)과 연결이 유지되게
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
// 광고 본문 이미지: 보통은 화면에 S3 주소로 바로 나감. 서버 디스크에 남은 예전 이미지는 여기서, 없으면 S3 로 넘김
app.use('/ad-img', express.static(path.join(__dirname, '..', 'uploads', 'ad-images'), { maxAge: '30d', index: false }));
app.get('/ad-img/:name', (req, res, next) => {
  if (!storage.isReady() || !/^[0-9a-f]{32}\.webp$/.test(req.params.name)) return next();
  res.redirect(301, storage.imageUrl(req.params.name));
});
app.use(express.urlencoded({ extended: false, limit: '300kb' })); // 광고 본문(에디터 HTML) 때문에 넉넉히
app.use(express.json({ limit: '20kb' }));

app.use(
  session({
    name: 'forest.sid',
    secret: config.sessionSecret,
    store: new MySQLStore({ createDatabaseTable: false }, db.pool), // sessions 테이블은 sql/schema.sql 에서 만듦
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30일
    },
  })
);

// 검색엔진·AI 검색용 파일 (로그인·세션 없이 바로 응답)
const seo = require('./services/seo');
app.get('/robots.txt', (req, res) => res.type('text/plain').send(seo.robotsTxt()));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(seo.sitemapXml()));
app.get('/llms.txt', (req, res) => res.type('text/plain; charset=utf-8').send(seo.llmsTxt()));

// KCP 본인확인 결과 수신: KCP 서버·인증 화면에서 오는 요청이라 CSRF 토큰이 없음 (결과는 reg_cert_key 로 확인)
const kcpRoutes = require('./routes/kcp');
app.post('/kcp/callback', kcpRoutes.callback);
app.get('/kcp/callback', kcpRoutes.callback);

app.use(csrf);
app.use(loadUser);
app.use(seo.seoLocals);
app.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.boards = config.boards;
  res.locals.hotThreshold = config.hotThreshold;
  res.locals.path = req.path;
  res.locals.skipPhoneAuth = config.skipPhoneAuth;
  res.locals.kcpOn = kcp.isReady();
  next();
});

// 헤더 알림 배지: 안 읽은 알림 수 (화면 요청에만)
app.use(async (req, res, next) => {
  res.locals.notifCount = 0;
  if (!req.user || req.method !== 'GET' || req.path.startsWith('/css') || req.path.startsWith('/js')) return next();
  try {
    res.locals.notifCount = await require('./services/notify').unreadCount(req.user.id);
    next();
  } catch (err) {
    next(err);
  }
});

app.use(kcpRoutes);
app.use(require('./routes/auth'));
app.use(require('./routes/ads'));
app.use(require('./routes/support'));
app.use(require('./routes/pages'));
app.use(require('./routes/posts'));
app.use('/admin', require('./routes/admin'));

app.get('/rules', (req, res) => res.render('rules', { title: '운영 규칙', reportHide: config.reportHideThreshold }));

app.use((req, res) => {
  res.status(404).render('error', { title: '페이지 없음', message: '페이지를 찾을 수 없어요.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.get('X-CSRF-Token') !== undefined) {
    return res.status(500).json({ ok: false, message: '잠시 후 다시 시도해주세요.' });
  }
  res.status(500).render('error', { title: '오류', message: '잠시 후 다시 시도해주세요.' });
});

// DB 접속 확인 + 없는 테이블 만들기 → 성공하면 서버 시작
const DB_HELP = {
  ER_ACCESS_DENIED_ERROR: `DB 사용자 '${config.db.user}' 로 접속할 수 없어요 (사용자가 없거나 .env 의 DB_PASSWORD 가 달라요).`,
  ER_BAD_DB_ERROR: `DB '${config.db.database}' 가 없어요.`,
  ER_DBACCESS_DENIED_ERROR: `DB 사용자 '${config.db.user}' 에게 '${config.db.database}' 사용 권한이 없어요.`,
  ECONNREFUSED: `MySQL 서버(${config.db.host}:${config.db.port})에 연결할 수 없어요. MySQL 이 켜져 있는지 확인하세요.`,
};

applySchema(db.pool)
  .then(() => {
    app.listen(config.port, () => {
      console.log(`강남의숲 실행 중: ${config.baseUrl} (포트 ${config.port})`);
      if (config.isProd && /\/\/(localhost|127\.0\.0\.1)/.test(config.baseUrl)) {
        console.warn('[경고] BASE_URL 이 localhost 예요. .env 에 실제 주소(https://도메인)를 적으세요. (사이트맵·대표 주소가 localhost 로 나가요)');
      }
      require('./services/ads').startRecheckJob();
      if (!config.ads.ntsServiceKey) console.warn('[경고] NTS_BUSINESS_API_SERVICE_KEY 가 비어 있어 광고 신청을 받을 수 없어요.');
      const kcpWhy = kcp.notReadyReason();
      if (kcpWhy) console.warn('[KCP] 휴대폰 본인확인 꺼짐 (문자 인증 방식 사용): ' + kcpWhy);
      else console.log('[KCP] 휴대폰 본인확인 켜짐 (' + (config.kcp.production ? '운영' : '테스트') + ')');
      if (!storage.isReady()) console.warn('[S3] S3_BUCKET_NAME 이 비어 있어 이미지를 서버 디스크(uploads/ad-images)에 저장해요.');
      else storage.checkBucket().then((m) => console.log('[S3] ' + m), (e) => console.error('[S3] 버킷 확인 실패: ' + e.message));
      if (config.usingLocalEnv) console.log('[설정] .env.local 값을 함께 쓰는 중 (로컬)');
      console.log(`[DB] ${/\.rds\.amazonaws\.com$/i.test(config.db.host) ? 'RDS' : '로컬/기타'} ${config.db.host}:${config.db.port}/${config.db.database}${config.db.ssl ? ' (TLS)' : ''}`);
      if (config.skipPhoneAuth) console.warn('[경고] SKIP_PHONE_AUTH=true: 문자 인증 없이 가입할 수 있어요. 운영 전에 꺼주세요.');
    });
  })
  .catch((err) => {
    const help = DB_HELP[err.code];
    if (!help) console.error(err);
    console.error(`
[DB 오류] ${help || 'DB 준비 중 오류가 났어요.'}`);
    if (help && err.code !== 'ECONNREFUSED') console.error('→ 처음이라면 DB 초기 세팅을 먼저 실행하세요:  npm run setup-db');
    process.exit(1);
  });
