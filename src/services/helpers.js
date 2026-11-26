const config = require('../config');

function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function anonName(anonNo) {
  return anonNo === 0 ? '글쓴이' : `익명${anonNo}`;
}

function isNew(post) {
  return Date.now() - new Date(post.created_at).getTime() < config.newHours * 3600 * 1000;
}

// 핫: 추천 수 - 반대 수 가 기준(기본 5) 이상
function isHot(post) {
  return post.up_count - (post.down_count || 0) >= config.hotThreshold;
}

// 검토가 필요한 단어 찾기 (공백 제거 후 비교해서 '마 약' 같은 우회도 잡음)
function findFlagWords(...texts) {
  const joined = texts.join(' ').replace(/\s+/g, '');
  const found = config.flagWords.filter((w) => joined.includes(w.replace(/\s+/g, '')));
  // 전화번호 패턴
  if (/01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/.test(texts.join(' '))) found.push('전화번호');
  return [...new Set(found)];
}

module.exports = { timeAgo, anonName, isHot, isNew, findFlagWords };
