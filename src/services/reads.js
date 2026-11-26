// 읽은 글 표시: 글을 열면 post_reads 에 남기고, 목록에서는 읽은 글을 흐리게 보여줌
const db = require('../db');

async function markRead(userId, postId) {
  await db.query(
    'INSERT INTO post_reads (user_id, post_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP',
    [userId, postId]
  );
}

// 글 목록(여러 개 배열도 가능)에 is_read 를 채움. 쿼리 한 번
async function withReadFlags(userId, ...lists) {
  const all = lists.flat();
  const ids = [...new Set(all.map((p) => p.id))];
  if (!ids.length) return;
  const rows = await db.query('SELECT post_id FROM post_reads WHERE user_id = ? AND post_id IN (?)', [userId, ids]);
  const read = new Set(rows.map((r) => r.post_id));
  for (const p of all) p.is_read = read.has(p.id);
}

module.exports = { markRead, withReadFlags };
