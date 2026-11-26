// 알림 만들기·읽기
//   comment : 내 글에 다른 사람이 댓글을 담
//   reply   : 내 댓글에 다른 사람이 답글을 담 (내 글 안이어도 reply 하나만)
//   inquiry : 내 문의에 운영자가 답변함
//   ad      : 내 광고가 게시·반려·게시 중단됨
const db = require('../db');

const TYPES = {
  comment: '댓글',
  reply: '답글',
  inquiry: '문의 답변',
  ad: '광고',
};

// 가려지거나 지워진 글·댓글의 알림은 보이지 않게 (기록은 남김)
const VISIBLE = `(n.comment_id IS NULL OR (c.status = 'visible' AND p.status <> 'deleted'))`;
const JOINS = `LEFT JOIN comments c ON c.id = n.comment_id LEFT JOIN posts p ON p.id = n.post_id`;

// 댓글을 단 뒤. conn 은 mysql2/promise 의 connection 또는 pool (댓글 트랜잭션 안에서 부름)
async function onComment(conn, { postId, commentId, actorId, parentId, replyToId }) {
  const q = (sql, params) => conn.query(sql, params);
  const [[post]] = await q('SELECT user_id FROM posts WHERE id = ?', [postId]);
  let replyUser = null;
  const targetCommentId = replyToId || parentId;
  if (targetCommentId) {
    const [[t]] = await q('SELECT user_id FROM comments WHERE id = ?', [targetCommentId]);
    replyUser = t ? t.user_id : null;
  }
  const rows = [];
  if (replyUser && replyUser !== actorId) rows.push([replyUser, 'reply', postId, commentId]);
  if (post && post.user_id !== actorId && post.user_id !== replyUser) rows.push([post.user_id, 'comment', postId, commentId]);
  if (rows.length) await q('INSERT INTO notifications (user_id, type, post_id, comment_id) VALUES ?', [rows]);
}

async function inquiryAnswered(inquiryId) {
  const row = await db.one('SELECT user_id FROM inquiries WHERE id = ?', [inquiryId]);
  if (!row) return;
  // 답변을 고쳐 다시 저장해도 안 읽은 알림이 쌓이지 않게
  await db.query(`DELETE FROM notifications WHERE type = 'inquiry' AND ref_id = ? AND read_at IS NULL`, [inquiryId]);
  await db.query(`INSERT INTO notifications (user_id, type, ref_id) VALUES (?, 'inquiry', ?)`, [row.user_id, inquiryId]);
}

async function adStatus(adId, event, note) {
  const row = await db.one('SELECT user_id FROM ads WHERE id = ?', [adId]);
  if (!row) return;
  await db.query(`INSERT INTO notifications (user_id, type, ref_id, event, note) VALUES (?, 'ad', ?, ?, ?)`, [
    row.user_id,
    adId,
    event,
    note ? String(note).slice(0, 200) : null,
  ]);
}

async function unreadCount(userId) {
  const row = await db.one(`SELECT COUNT(*) AS n FROM notifications n ${JOINS} WHERE n.user_id = ? AND n.read_at IS NULL AND ${VISIBLE}`, [userId]);
  return Number(row.n);
}

// 목록 (type 을 주면 그 종류만) + 종류별 안 읽은 개수
async function list(userId, type, limit = 50) {
  const byType = TYPES[type] ? ' AND n.type = ?' : '';
  const items = await db.query(
    `SELECT n.id, n.type, n.post_id, n.comment_id, n.ref_id, n.event, n.note, n.read_at, n.created_at,
            c.anon_no, LEFT(c.body, 80) AS body, p.title AS post_title,
            i.title AS inquiry_title, a.title AS ad_title, a.business_name
     FROM notifications n ${JOINS}
     LEFT JOIN inquiries i ON n.type = 'inquiry' AND i.id = n.ref_id
     LEFT JOIN ads a ON n.type = 'ad' AND a.id = n.ref_id
     WHERE n.user_id = ? AND ${VISIBLE}${byType}
     ORDER BY n.id DESC LIMIT ?`,
    byType ? [userId, type, limit] : [userId, limit]
  );
  const counts = await db.query(
    `SELECT n.type, COUNT(*) AS n FROM notifications n ${JOINS} WHERE n.user_id = ? AND n.read_at IS NULL AND ${VISIBLE} GROUP BY n.type`,
    [userId]
  );
  return { items, unread: Object.fromEntries(counts.map((r) => [r.type, Number(r.n)])) };
}

// 알림을 누르면 갈 곳
function linkOf(n) {
  if (n.type === 'comment' || n.type === 'reply') return `/p/${n.post_id}#c${n.comment_id}`;
  if (n.type === 'inquiry') return `/me/inquiries/${n.ref_id}`;
  if (n.type === 'ad') return n.event === 'approved' ? `/ads/${n.ref_id}` : '/ads/mine';
  return '/notifications';
}

// 하나 읽음 → 갈 곳 (내 알림이 아니면 null)
async function open(userId, id) {
  const n = await db.one('SELECT id, type, post_id, comment_id, ref_id, event FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  if (!n) return null;
  await db.query('UPDATE notifications SET read_at = NOW() WHERE id = ? AND read_at IS NULL', [id]);
  return linkOf(n);
}

async function markAllRead(userId, type) {
  const byType = TYPES[type] ? ' AND type = ?' : '';
  const [r] = await db.pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL${byType}`, byType ? [userId, type] : [userId]);
  return r.affectedRows;
}

module.exports = { TYPES, onComment, inquiryAnswered, adStatus, unreadCount, list, open, markAllRead };
