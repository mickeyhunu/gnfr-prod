const db = require('../db');

// 공개 댓글 수 다시 계산
async function refreshCommentCount(postId, conn) {
  const q = conn ? conn.query.bind(conn) : db.pool.query.bind(db.pool);
  await q(
    `UPDATE posts SET comment_count =
       (SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'visible')
     WHERE id = ?`,
    [postId, postId]
  );
}

// 신고 처리 완료로 표시
async function resolveReports(targetType, targetId) {
  await db.query(
    `UPDATE reports SET status = 'resolved' WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    [targetType, targetId]
  );
}

module.exports = { refreshCommentCount, resolveReports };
