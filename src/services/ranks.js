// 계급: 활동 점수로 정함. 단계와 점수 기준은 config.ranks 에서 바꿀 수 있음
//   점수 = 공개 중인 글 × 글 점수 + 댓글 × 댓글 점수 + 받은 추천 × 추천 점수
// 게시글·댓글에 [계급] [성별] 익명 순서로 표시 (누가 썼는지는 드러나지 않음)
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

// 계급 아이콘: public/images/ranks/lv1.png … admin.png. 1분마다 다시 찾아서 파일을 넣으면 바로 반영
const ICON_DIR = path.join(__dirname, '..', '..', 'public', 'images', 'ranks');
const ICON_EXTS = ['webp', 'png', 'gif', 'svg', 'jpg'];
let iconCache = { at: 0, map: {} };
function icons() {
  if (Date.now() - iconCache.at < 60 * 1000) return iconCache.map;
  const map = {};
  let files = [];
  try { files = fs.readdirSync(ICON_DIR); } catch (e) { files = []; }
  for (const f of files) {
    const m = f.match(/^(lv\d+|admin)\.([a-z]+)$/i);
    if (!m || !ICON_EXTS.includes(m[2].toLowerCase())) continue;
    const key = m[1].toLowerCase();
    // 같은 이름이 여러 확장자로 있으면 ICON_EXTS 순서대로 우선
    if (!map[key] || ICON_EXTS.indexOf(m[2].toLowerCase()) < ICON_EXTS.indexOf(map[key].split('.').pop())) {
      map[key] = `/images/ranks/${f}`;
    }
  }
  iconCache = { at: Date.now(), map };
  return map;
}

function rankOf(score, role) {
  const map = icons();
  if (role === 'admin') return { name: config.ranks.adminName, level: 'admin', icon: map.admin || null };
  const tiers = config.ranks.tiers;
  let level = 0;
  for (let i = 0; i < tiers.length; i += 1) if (score >= tiers[i].min) level = i;
  return { name: tiers[level].name, level: level + 1, icon: map[`lv${level + 1}`] || null };
}

// 여러 회원의 계급·성별을 한 번에: Map(userId → { rank, gender })
async function getAuthorInfo(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const p = config.ranks.points;
  const rows = await db.query(
    `SELECT u.id, u.role, u.gender,
       (SELECT COUNT(*) FROM posts WHERE user_id = u.id AND status = 'visible') AS posts,
       (SELECT COUNT(*) FROM comments WHERE user_id = u.id AND status = 'visible') AS comments,
       (SELECT COALESCE(SUM(up_count), 0) FROM posts WHERE user_id = u.id AND status = 'visible')
     + (SELECT COALESCE(SUM(up_count), 0) FROM comments WHERE user_id = u.id AND status = 'visible') AS ups
     FROM users u WHERE u.id IN (?)`,
    [ids]
  );
  for (const r of rows) {
    const score = Number(r.posts) * p.post + Number(r.comments) * p.comment + Number(r.ups) * p.up;
    out.set(r.id, { rank: rankOf(score, r.role), gender: r.gender || null, score });
  }
  return out;
}

module.exports = { rankOf, getAuthorInfo };
