// 검색엔진(SEO)·생성형 AI 검색(GEO)용 메타 정보. 화면에는 보이지 않고 <head> 와 robots.txt·sitemap.xml·llms.txt 에만 들어감.
// 회원 전용 화면(글·댓글·마이페이지 등)은 익명 커뮤니티라 절대 색인되지 않게 noindex 로 막고,
// 로그인 없이 보이는 소개 화면만 색인을 허용함.
const config = require('../config');

const SITE = {
  name: '강남의숲',
  alternateName: ['Gangnam Forest', '강남의 숲'],
  tagline: '강남에서 일하는 사람들의 19세 이상 익명 커뮤니티',
  description:
    '강남의숲은 강남에서 일하는 사람들을 위한 19세 이상 익명 커뮤니티예요. 여성의숲·남성의숲과 자유·후기·썰·질문 게시판, 실시간 강남 가게 정보, 국세청 사업자 확인을 거친 구인·광고를 한곳에서 볼 수 있어요.',
  keywords: ['강남의숲', '강남 커뮤니티', '강남 익명 커뮤니티', '강남 구인', '강남 가게 정보', '역삼', '논현', '삼성동', '청담'],
  locale: 'ko_KR',
  // 서비스 지역: 서울 강남구 (강남역 좌표)
  geo: { region: 'KR-11', placename: '서울특별시 강남구', lat: 37.4979, lng: 127.0276 },
  logo: { path: '/images/brand/logo.webp', width: 1199, height: 1312 },
};

// 로그인 없이 볼 수 있고 색인을 허용하는 화면
const PUBLIC_PAGES = {
  '/start': {
    title: `${SITE.name} · ${SITE.tagline}`,
    description: SITE.description,
    priority: '1.0',
    changefreq: 'weekly',
  },
  '/rules': {
    title: `운영 규칙 · ${SITE.name}`,
    description: '강남의숲 운영 규칙: 특정인 저격·신상 노출 금지, 욕설·비하 금지, 광고·불법 내용 금지, 신고와 자동 숨김 기준, 이용 제한 기준을 안내해요.',
    priority: '0.5',
    changefreq: 'monthly',
  },
};

const baseUrl = () => config.baseUrl.replace(/\/+$/, '');
const abs = (p) => baseUrl() + p;

// <script type="application/ld+json"> 안에 넣어도 태그가 깨지지 않게
const jsonForScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

function organization() {
  return {
    '@type': 'Organization',
    '@id': abs('/#organization'),
    name: SITE.name,
    alternateName: SITE.alternateName,
    url: abs('/start'),
    logo: { '@type': 'ImageObject', url: abs(SITE.logo.path), width: SITE.logo.width, height: SITE.logo.height },
    areaServed: { '@type': 'AdministrativeArea', name: SITE.geo.placename },
  };
}

function website() {
  return {
    '@type': 'WebSite',
    '@id': abs('/#website'),
    name: SITE.name,
    alternateName: SITE.alternateName,
    url: abs('/start'),
    description: SITE.description,
    inLanguage: 'ko-KR',
    publisher: { '@id': abs('/#organization') },
    audience: { '@type': 'PeopleAudience', suggestedMinAge: 19 },
    isFamilyFriendly: false,
    keywords: SITE.keywords.join(', '),
  };
}

function jsonLdFor(pathname, page) {
  const graph = [organization(), website()];
  const webPage = {
    '@type': 'WebPage',
    '@id': abs(pathname) + '#webpage',
    url: abs(pathname),
    name: page.title,
    description: page.description,
    inLanguage: 'ko-KR',
    isPartOf: { '@id': abs('/#website') },
    about: { '@id': abs('/#organization') },
    contentLocation: {
      '@type': 'Place',
      name: SITE.geo.placename,
      geo: { '@type': 'GeoCoordinates', latitude: SITE.geo.lat, longitude: SITE.geo.lng },
    },
  };
  if (pathname === '/rules') {
    webPage.breadcrumb = {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE.name, item: abs('/start') },
        { '@type': 'ListItem', position: 2, name: '운영 규칙', item: abs('/rules') },
      ],
    };
  }
  graph.push(webPage);
  return jsonForScript({ '@context': 'https://schema.org', '@graph': graph });
}

// 모든 화면 요청에 res.locals.seo 를 채우고, 비공개 화면은 X-Robots-Tag 헤더로도 색인 차단
function seoLocals(req, res, next) {
  const page = req.method === 'GET' && !req.user ? PUBLIC_PAGES[req.path] : null;
  if (page) {
    res.locals.seo = {
      indexable: true,
      robots: 'index, follow, max-image-preview:large, max-snippet:-1',
      title: page.title,
      description: page.description,
      canonical: abs(req.path),
      jsonLd: jsonLdFor(req.path, page),
    };
  } else {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.locals.seo = { indexable: false, robots: 'noindex, nofollow, noarchive', description: SITE.tagline };
  }
  res.locals.site = SITE;
  res.locals.siteUrl = baseUrl();
  next();
}

// 회원 전용 경로: robots.txt 에서 크롤링 자체를 막음
const PRIVATE_PREFIXES = ['/p/', '/c/', '/forest', '/write', '/live', '/ads', '/ad-img/', '/me', '/admin', '/search', '/notifications', '/auth/', '/r/', '/signup', '/login', '/reset', '/vote', '/bookmark', '/report'];

function robotsTxt() {
  const lines = ['User-agent: *'];
  Object.keys(PUBLIC_PAGES).forEach((p) => lines.push(`Allow: ${p}$`));
  lines.push('Allow: /images/brand/');
  PRIVATE_PREFIXES.forEach((p) => lines.push(`Disallow: ${p}`));
  lines.push('', `Sitemap: ${abs('/sitemap.xml')}`, '');
  return lines.join('\n');
}

function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = Object.entries(PUBLIC_PAGES)
    .map(([p, v]) => `  <url><loc>${abs(p)}</loc><lastmod>${today}</lastmod><changefreq>${v.changefreq}</changefreq><priority>${v.priority}</priority></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// 생성형 AI 검색엔진용 요약 (llmstxt.org 형식). 공개된 사실만 적음
function llmsTxt() {
  return [
    `# ${SITE.name}`,
    '',
    `> ${SITE.description}`,
    '',
    '- 이용 대상: 19세 이상 (휴대폰 본인인증과 추천인 코드로 가입)',
    `- 서비스 지역: ${SITE.geo.placename} 일대 (역삼·논현·삼성·청담·신사·대치 등)`,
    '- 운영 형태: 익명 커뮤니티. 글과 댓글에는 이름·번호가 표시되지 않음',
    '- 회원 전용: 게시글, 댓글, 가게 정보, 구인·광고 내용은 로그인한 회원만 볼 수 있음',
    '',
    '## 주요 기능',
    '',
    '- 숲(게시판): 같은 성별끼리만 보는 여성의숲·남성의숲, 자유의숲·후기의숲·썰의숲·질문의숲, 인기글(핫)',
    '- 실시간강남: 강남 지역 가게의 지역·동·업종·영업시간·주소 정보와 지도 보기',
    '- 광고·구인구직: 국세청에서 계속사업자로 확인된 업체만 등록 가능한 광고와 구인 글',
    '- 고객센터: 1:1 문의와 신고 처리 내역 확인',
    '',
    '## 공개 페이지',
    '',
    ...Object.entries(PUBLIC_PAGES).map(([p, v]) => `- [${v.title}](${abs(p)}): ${v.description}`),
    '',
  ].join('\n');
}

module.exports = { SITE, PUBLIC_PAGES, seoLocals, robotsTxt, sitemapXml, llmsTxt };
