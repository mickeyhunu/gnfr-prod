// 광고 본문(에디터 HTML) 정리: 허용한 태그만 남기고, 이미지는 우리가 올린 것만
// 색·정렬은 style 속성 대신 정해 둔 class 로만 받음 (CSP 가 인라인 style 을 막고, 아무 색이나 넣지 못하게)
// 이미지 주소: DB 에는 버킷과 상관없는 /ad-img/<이름>.webp 로 저장하고, 보여줄 때(view) S3 주소로 바꿈
//   → 개발(gnfr-public-dev)·운영(gnfr-public-prod) 버킷이 달라도, 나중에 CloudFront 를 붙여도 저장된 글은 그대로
const sanitizeHtml = require('sanitize-html');
const storage = require('./storage');

const IMG_SRC = /^\/ad-img\/[0-9a-f]{32}\.(jpg|png|webp)$/;
const S3_NAME = /\/ad-images\/([0-9a-f]{32}\.webp)$/;

// 에디터가 보낸 S3 주소 → /ad-img/<이름> (지금 설정한 버킷 주소일 때만)
function toStoredSrc(src) {
  src = String(src || '');
  if (storage.isReady() && src.startsWith(storage.publicBaseUrl() + '/')) {
    const m = src.match(S3_NAME);
    if (m && src === storage.imageUrl(m[1])) return '/ad-img/' + m[1];
  }
  return src;
}

// 에디터에서 고를 수 있는 색 (key 는 css 의 .fc-<key> / .bg-<key>)
const TEXT_COLORS = [
  { key: '0', name: '기본' },
  { key: 'red', name: '빨강' },
  { key: 'orange', name: '주황' },
  { key: 'green', name: '초록' },
  { key: 'blue', name: '파랑' },
  { key: 'purple', name: '보라' },
  { key: 'gray', name: '회색' },
];
const BG_COLORS = [
  { key: '0', name: '배경 없음' },
  { key: 'yellow', name: '노랑' },
  { key: 'pink', name: '분홍' },
  { key: 'green', name: '연두' },
  { key: 'blue', name: '하늘' },
  { key: 'gray', name: '회색' },
];
const SPAN_CLASSES = [...TEXT_COLORS.map((c) => 'fc-' + c.key), ...BG_COLORS.map((c) => 'bg-' + c.key)];
const ALIGN_CLASSES = ['al-center', 'al-right'];

const OPTIONS = {
  allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'ul', 'ol', 'li', 'img', 'hr', 'div', 'span'],
  allowedAttributes: { img: ['src', 'alt'] },
  allowedClasses: {
    span: SPAN_CLASSES,
    p: ALIGN_CLASSES,
    div: ALIGN_CLASSES,
    h2: ALIGN_CLASSES,
    h3: ALIGN_CLASSES,
    blockquote: ALIGN_CLASSES,
    li: ALIGN_CLASSES,
  },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  // div 는 브라우저 에디터가 줄마다 만드는 것이라 p 로 바꿈. 링크(a)는 받지 않음(글자만 남음)
  transformTags: {
    div: 'p',
    b: 'strong',
    i: 'em',
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: toStoredSrc(attribs.src) } }),
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !IMG_SRC.test(frame.attribs.src || ''),
};

function escapeText(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 태그가 없는 글(에디터 없이 보낸 경우)은 줄마다 문단으로
function clean(input) {
  let html = String(input || '').slice(0, 200000);
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    html = html
      .replace(/\r\n/g, '\n')
      .split(/\n/)
      .map((line) => (line.trim() ? `<p>${escapeText(line)}</p>` : ''))
      .join('');
  }
  let out = sanitizeHtml(html, OPTIONS);
  // class 가 다 빠진 span 은 껍데기만 남으니 벗김 (안쪽부터 여러 번)
  for (let i = 0; i < 5 && /<span>/.test(out); i++) out = out.replace(/<span>((?:(?!<\/?span\b)[\s\S])*)<\/span>/g, '$1');
  return out
    .replace(/<p( class="[^"]*")?>(\s|&nbsp;|<br \/>)*<\/p>/g, '')
    .trim();
}

// 저장된 HTML(/ad-img/…webp) → 화면용 S3 주소. 예전 jpg·png 는 서버의 /ad-img 그대로
function withImageUrls(html) {
  if (!storage.isReady()) return html;
  return String(html || '').replace(/(<img\b[^>]*?\bsrc=")\/ad-img\/([0-9a-f]{32}\.webp)"/g, (_, pre, name) => `${pre}${storage.imageUrl(name)}"`);
}

// 화면에 보여줄 HTML (정리 + 이미지 S3 주소)
function view(html) {
  return withImageUrls(clean(html));
}

// 목록 미리보기·금지어 검사용 글자만
function toText(html) {
  return sanitizeHtml(String(html || '').replace(/<\/(p|h2|h3|li|blockquote)>|<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function imageCount(html) {
  return (String(html || '').match(/<img\b/g) || []).length;
}

module.exports = { clean, view, withImageUrls, toText, imageCount, IMG_SRC, TEXT_COLORS, BG_COLORS };
