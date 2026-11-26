const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const notify = require('../services/notify');
const config = require('../config');
const { requireLogin, requireActive } = require('../middleware/auth');
const { findFlagWords } = require('../services/helpers');
const { refreshCommentCount } = require('../services/moderation');
const { getAuthorInfo } = require('../services/ranks');
const { markRead, withReadFlags } = require('../services/reads');
const { genderBoardNames, isGenderBoard, canReadBoard, boardFilter, writableBoards } = require('../services/boards');

// 볼 수 없는 게시판의 글: 있는지 없는지도 알 수 없게 '글 없음' 과 같은 화면
function notFound(res) {
  return res.status(404).render('error', { title: '글 없음', message: '삭제됐거나 숨겨진 글이에요.' });
}

const router = express.Router();


const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `post:${req.user ? req.user.id : req.ip}`,
  handler: (req, res) =>
    res.status(429).render('error', { title: '잠시만요', message: '글을 너무 자주 올리고 있어요. 10분 뒤에 다시 시도해주세요.' }),
});

const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  keyGenerator: (req) => `comment:${req.user ? req.user.id : req.ip}`,
  handler: (req, res) =>
    res.status(429).render('error', { title: '잠시만요', message: '댓글을 너무 빨리 달고 있어요. 잠시 뒤에 다시 시도해주세요.' }),
});

// 오늘(한국 시간 0시부터) 이 회원이 한 신고 수. DB 시간은 UTC
const TODAY_KST = `DATE(UTC_TIMESTAMP() + INTERVAL 9 HOUR) - INTERVAL 9 HOUR`;
async function reportsToday(q, userId) {
  const [[row]] = await q(`SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ${TODAY_KST}`, [userId]);
  return Number(row.n);
}
function reportsLeft(user, used) {
  if (user.role === 'admin') return null; // 제한 없음
  return Math.max(0, config.reportDailyLimit - used);
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 모든 화면은 가입한 회원만 볼 수 있음 (폐쇄형 커뮤니티) → 각 라우트에 requireLogin

// ── 숲(커뮤니티) 글 목록 ────────────────────────────────────────────
router.get('/forest', requireLogin, async (req, res, next) => {
  try {
    const tab = req.query.tab === 'hot' ? 'hot' : 'all';
    const board = config.boards.includes(req.query.board) || isGenderBoard(req.query.board) ? req.query.board : null;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    // 보기 방식: 카드형(기본) / 리스트형. 한 번 고르면 로그인 동안 기억
    if (req.query.view === 'list' || req.query.view === 'card') req.session.feedView = req.query.view;
    const feedView = req.session.feedView === 'list' ? 'list' : 'card';
    // 성별 게시판 칩: 성별이 확인된 회원은 자기 성별 게시판만, 확인 전이면 둘 다(누르면 안내), 운영자는 둘 다
    const genderChips = genderBoardNames
      .map((name) => ({ name, readable: canReadBoard(req.user, name) }))
      .filter((c) => c.readable || !req.user.gender);
    const listView = { nav: 'forest', tab, board, page, genderChips, feedView };

    // 다른 성별 게시판(또는 성별 확인 전): 글 대신 안내만
    if (board && !canReadBoard(req.user, board)) {
      return res.render('list', { ...listView, title: board, posts: [], hasNext: false, locked: true });
    }

    // 핫 게시판은 모든 게시판의 글을 보여주고, 볼 수 없는 성별 게시판 글은 제목만 가림 (아래)
    const filter = tab === 'hot' && !board ? { sql: '1=1', params: [] } : boardFilter(req.user);
    const where = [`status = 'visible'`, filter.sql];
    const params = [...filter.params];
    if (board) {
      where.push('board = ?');
      params.push(board);
    }
    if (tab === 'hot') {
      // 핫: 기간 제한 없이 추천 - 반대 가 기준 이상인 글
      where.push('CAST(up_count AS SIGNED) - CAST(down_count AS SIGNED) >= ?');
      params.push(config.hotThreshold);
    }
    const order = tab === 'hot' ? 'CAST(up_count AS SIGNED) - CAST(down_count AS SIGNED) DESC, id DESC' : 'id DESC';

    const posts = await db.query(
      `SELECT id, board, title, LEFT(body, 120) AS preview, up_count, down_count, comment_count, view_count, created_at
       FROM posts WHERE ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...params, config.pageSize + 1, (page - 1) * config.pageSize]
    );
    const hasNext = posts.length > config.pageSize;
    if (hasNext) posts.pop();

    // 볼 수 없는 성별 게시판 글: 제목·내용은 화면에 보내지 않고 안내 문구로 바꿈 (눌러도 열리지 않음)
    for (const p of posts) {
      if (!canReadBoard(req.user, p.board)) {
        p.locked = true;
        p.title = `${p.board} 글은 확인할 수 없어요`;
        p.preview = null;
      }
    }
    await withReadFlags(req.user.id, posts);
    res.render('list', { ...listView, title: board || (tab === 'hot' ? '핫 게시판' : '숲'), posts, hasNext, locked: false });
  } catch (err) {
    next(err);
  }
});

// ── 글쓰기 ────────────────────────────────────────────
router.get('/write', requireLogin, requireActive, (req, res) => {
  const boards = writableBoards(req.user);
  // 성별 게시판 목록에서 글쓰기를 누르면 그 게시판이 골라진 채로 열림
  const board = boards.includes(req.query.board) ? req.query.board : config.boards[0];
  res.render('write', { title: '글쓰기', error: null, boards, form: { board, title: '', body: '' } });
});

router.post('/write', requireLogin, requireActive, writeLimiter, async (req, res, next) => {
  const form = {
    board: String(req.body.board || ''),
    title: String(req.body.title || '').trim(),
    body: String(req.body.body || '').trim(),
  };
  const boards = writableBoards(req.user);
  const fail = (error) => res.status(400).render('write', { title: '글쓰기', error, boards, form });

  try {
    if (!boards.includes(form.board)) return fail('게시판을 골라주세요.');
    if (form.title.length < 2 || form.title.length > 100) return fail('제목은 2~100자로 써주세요.');
    if (form.body.length < 5 || form.body.length > 5000) return fail('내용은 5~5000자로 써주세요.');

    const flags = findFlagWords(form.title, form.body);
    const status = flags.length ? 'pending' : 'visible';

    const postId = await db.tx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO posts (user_id, board, title, body, status, flag_words) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, form.board, form.title, form.body, status, flags.join(',') || null]
      );
      await conn.query(`INSERT INTO post_participants (post_id, user_id, anon_no) VALUES (?, ?, 0)`, [r.insertId, req.user.id]);
      return r.insertId;
    });

    res.redirect(`/p/${postId}`);
  } catch (err) {
    next(err);
  }
});

// ── 글 보기 ────────────────────────────────────────────
router.get('/p/:id', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(404).render('error', { title: '글 없음', message: '글을 찾을 수 없어요.' });

    const post = await db.one(
      `SELECT id, user_id, board, title, body, up_count, down_count, comment_count, view_count, status, created_at
       FROM posts WHERE id = ? AND status <> 'deleted'`,
      [id]
    );
    const isAdmin = req.user.role === 'admin';
    const isMine = post && post.user_id === req.user.id;
    if (!post || (post.status !== 'visible' && !isMine && !isAdmin) || !canReadBoard(req.user, post.board)) {
      return notFound(res);
    }

    // 조회수: 공개된 글을 열 때마다 1 올림 (새로고침·내 글 포함)
    if (post.status === 'visible') {
      await db.query('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [id]);
      post.view_count += 1;
    }
    await markRead(req.user.id, id);

    // reply_to_anon: 답글에 단 답글이면 받는 사람의 익명 번호 (그 답글이 지워졌어도 번호는 보여줌)
    const comments = await db.query(
      `SELECT c.id, c.parent_id, c.reply_to_id, t.anon_no AS reply_to_anon,
              c.user_id, c.anon_no, c.body, c.up_count, c.down_count, c.status, c.created_at
       FROM comments c
       LEFT JOIN comments t ON t.id = c.reply_to_id
       WHERE c.post_id = ? AND (c.status = 'visible' OR (c.status = 'pending' AND c.user_id = ?))
       ORDER BY c.id ASC`,
      [id, req.user.id]
    );

    const myVotes = await db.query(
      `SELECT target_type, target_id, value FROM votes
       WHERE user_id = ? AND ((target_type = 'post' AND target_id = ?)
          OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)))`,
      [req.user.id, id, id]
    );
    const saved = await db.one('SELECT 1 AS yes FROM bookmarks WHERE user_id = ? AND post_id = ?', [req.user.id, id]);
    const reportLeft = reportsLeft(req.user, await reportsToday(db.pool.query.bind(db.pool), req.user.id));
    const voteMap = {};
    for (const v of myVotes) voteMap[`${v.target_type}:${v.target_id}`] = v.value;

    // 글쓴이·댓글 단 사람의 계급과 성별 (user_id 는 화면에 넘기지 않음)
    const info = await getAuthorInfo([post.user_id, ...comments.map((c) => c.user_id)]);
    const badge = (uid) => info.get(uid) || { rank: null, gender: null };

    // 화면에는 user_id를 내보내지 않고 '내 글/내 댓글' 여부만 넘김
    const shownIds = new Set(comments.map((c) => c.id));
    const toView = (c) => ({
      author: badge(c.user_id),
      id: c.id,
      anon_no: c.anon_no,
      body: c.body,
      up_count: c.up_count,
      down_count: c.down_count,
      status: c.status,
      created_at: c.created_at,
      mine: c.user_id === req.user.id,
      myVote: voteMap[`comment:${c.id}`] || 0,
      replyTo: c.reply_to_id && c.reply_to_anon !== null
        ? { id: c.reply_to_id, anon_no: c.reply_to_anon, onPage: shownIds.has(c.reply_to_id) }
        : null,
      replies: [],
    });

    // 댓글 아래에 답글을 묶음. 원래 댓글이 지워졌어도 답글이 남아 있으면 '삭제된 댓글' 자리를 남김
    const top = [];
    const byId = new Map();
    for (const c of comments) if (!c.parent_id) { const v = toView(c); byId.set(c.id, v); top.push(v); }
    for (const c of comments) {
      if (!c.parent_id) continue;
      let parent = byId.get(c.parent_id);
      if (!parent) {
        parent = { id: c.parent_id, removed: true, replies: [] };
        byId.set(c.parent_id, parent);
        top.push(parent);
      }
      parent.replies.push(toView(c));
    }
    top.sort((a, b) => a.id - b.id);
    const safeComments = top;
    const commentTotal = comments.filter((c) => c.status === 'visible').length;

    res.render('post', {
      title: post.title,
      post: { ...post, user_id: undefined },
      postAuthor: badge(post.user_id),
      isMine,
      isAdmin,
      authorId: isAdmin ? post.user_id : null,
      comments: safeComments,
      commentTotal,
      myPostVote: voteMap[`post:${id}`] || 0,
      saved: !!saved,
      reportLeft,
      reportLimit: config.reportDailyLimit,
      reasons: config.reportReasons,
      notice: req.query.notice || null,
    });
  } catch (err) {
    next(err);
  }
});

// ── 댓글 쓰기 (글마다 익명 번호 부여) ─────────────────────
router.post('/p/:id/comments', requireLogin, requireActive, commentLimiter, async (req, res, next) => {
  try {
    const postId = toId(req.params.id);
    const body = String(req.body.body || '').trim();
    const replyTo = toId(req.body.parent_id);
    if (!postId) return res.redirect('/');
    if (body.length < 1 || body.length > 1000) return res.redirect(`/p/${postId}?notice=comment_length`);

    const flags = findFlagWords(body);
    const status = flags.length ? 'pending' : 'visible';

    const ok = await db.tx(async (conn) => {
      const [[post]] = await conn.query(
        `SELECT id, board, next_anon_no FROM posts WHERE id = ? AND status = 'visible' FOR UPDATE`,
        [postId]
      );
      if (!post || !canReadBoard(req.user, post.board)) return false;

      // 답글: 같은 글의 공개 댓글에만. 답글에 답글을 달면 원래 댓글 아래로 (한 단계만)
      let parentId = null;
      let replyToId = null;
      if (replyTo) {
        const [[parent]] = await conn.query(
          `SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ? AND status = 'visible'`,
          [replyTo, postId]
        );
        if (!parent) return 'gone';
        parentId = parent.parent_id || parent.id;
        if (parent.parent_id) replyToId = parent.id; // 답글에 단 답글: 누구에게 답했는지 남김
      }

      const [[existing]] = await conn.query(
        `SELECT anon_no FROM post_participants WHERE post_id = ? AND user_id = ?`,
        [postId, req.user.id]
      );
      let anonNo;
      if (existing) {
        anonNo = existing.anon_no;
      } else {
        anonNo = post.next_anon_no;
        await conn.query(`INSERT INTO post_participants (post_id, user_id, anon_no) VALUES (?, ?, ?)`, [postId, req.user.id, anonNo]);
        await conn.query(`UPDATE posts SET next_anon_no = next_anon_no + 1 WHERE id = ?`, [postId]);
      }

      const [r] = await conn.query(
        `INSERT INTO comments (post_id, parent_id, reply_to_id, user_id, anon_no, body, status, flag_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [postId, parentId, replyToId, req.user.id, anonNo, body, status, flags.join(',') || null]
      );
      // 글쓴이·답글 받은 사람에게 알림 (검토 중인 댓글은 공개될 때까지 알림 목록에 안 보임)
      await notify.onComment(conn, { postId, commentId: r.insertId, actorId: req.user.id, parentId, replyToId });
      await refreshCommentCount(postId, conn);
      return r.insertId;
    });

    if (ok === 'gone') return res.redirect(`/p/${postId}?notice=reply_gone#comments`);
    if (!ok) return res.status(404).render('error', { title: '글 없음', message: '댓글을 달 수 없는 글이에요.' });
    res.redirect(`/p/${postId}${status === 'pending' ? '?notice=comment_pending' : ''}#c${ok}`);
  } catch (err) {
    next(err);
  }
});

// ── 내 글 / 내 댓글 삭제 ─────────────────────────────────
router.post('/p/:id/delete', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const cond = req.user.role === 'admin' ? '' : ' AND user_id = ?';
    const params = req.user.role === 'admin' ? [id] : [id, req.user.id];
    await db.query(`UPDATE posts SET status = 'deleted' WHERE id = ?${cond}`, params);
    res.redirect('/forest');
  } catch (err) {
    next(err);
  }
});

router.post('/c/:id/delete', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.params.id);
    const c = await db.one('SELECT post_id, user_id FROM comments WHERE id = ?', [id]);
    if (!c || (c.user_id !== req.user.id && req.user.role !== 'admin')) return res.redirect('/');
    await db.query(`UPDATE comments SET status = 'deleted' WHERE id = ?`, [id]);
    await refreshCommentCount(c.post_id);
    res.redirect(`/p/${c.post_id}#comments`);
  } catch (err) {
    next(err);
  }
});

// ── 추천 / 반대 (fetch, JSON) ───────────────────────────
// 글·댓글 모두 추천/반대. 같은 버튼을 다시 누르면 취소, 반대쪽을 누르면 바뀜. 자기 글·댓글에는 못 누름
router.post('/vote', requireLogin, requireActive, async (req, res, next) => {
  try {
    const type = req.body.type === 'comment' ? 'comment' : req.body.type === 'post' ? 'post' : null;
    const id = toId(req.body.id);
    const value = Number(req.body.value);
    if (!type || !id || ![1, -1].includes(value)) return res.status(400).json({ ok: false });

    const table = type === 'post' ? 'posts' : 'comments';
    const result = await db.tx(async (conn) => {
      const boardCol = type === 'post' ? 't.board' : '(SELECT board FROM posts WHERE id = t.post_id)';
      const [[target]] = await conn.query(
        `SELECT t.id, t.user_id, ${boardCol} AS board FROM ${table} t WHERE t.id = ? AND t.status = 'visible' FOR UPDATE`,
        [id]
      );
      if (!target || !canReadBoard(req.user, target.board)) return { error: '없는 글이에요.' };
      if (target.user_id === req.user.id) return { error: '내 글에는 누를 수 없어요.' };

      const [[prev]] = await conn.query(
        `SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?`,
        [req.user.id, type, id]
      );
      let mine = value;
      if (prev && prev.value === value) {
        await conn.query(`DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?`, [req.user.id, type, id]);
        mine = 0;
      } else if (prev) {
        await conn.query(`UPDATE votes SET value = ? WHERE user_id = ? AND target_type = ? AND target_id = ?`, [value, req.user.id, type, id]);
      } else {
        await conn.query(`INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)`, [req.user.id, type, id, value]);
      }

      // 숫자는 votes 테이블에서 다시 세서 항상 정확하게 유지
      const [[counts]] = await conn.query(
        `SELECT COALESCE(SUM(value = 1), 0) AS up, COALESCE(SUM(value = -1), 0) AS down
         FROM votes WHERE target_type = ? AND target_id = ?`,
        [type, id]
      );
      if (type === 'post') {
        await conn.query(`UPDATE posts SET up_count = ?, down_count = ? WHERE id = ?`, [counts.up, counts.down, id]);
      } else {
        await conn.query(`UPDATE comments SET up_count = ?, down_count = ? WHERE id = ?`, [counts.up, counts.down, id]);
      }
      return { up: Number(counts.up), down: Number(counts.down), mine };
    });

    if (result.error) return res.status(400).json({ ok: false, message: result.error });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── 저장(북마크) 토글 (fetch, JSON) ──────────────────────
// 저장은 활동 제한과 관계없이 누구나 (읽기 기능)
router.post('/bookmark', requireLogin, async (req, res, next) => {
  try {
    const id = toId(req.body.id);
    const post = id && (await db.one(`SELECT id, board FROM posts WHERE id = ? AND status = 'visible'`, [id]));
    if (!post || !canReadBoard(req.user, post.board)) return res.status(400).json({ ok: false, message: '없는 글이에요.' });
    const r = await db.query('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?', [req.user.id, id]);
    if (r.affectedRows) return res.json({ ok: true, saved: false });
    await db.query('INSERT IGNORE INTO bookmarks (user_id, post_id) VALUES (?, ?)', [req.user.id, id]);
    res.json({ ok: true, saved: true });
  } catch (err) {
    next(err);
  }
});

// ── 신고 ───────────────────────────────────────────────
router.post('/report', requireLogin, async (req, res, next) => {
  try {
    const type = req.body.type === 'comment' ? 'comment' : 'post';
    const id = toId(req.body.id);
    const reason = Object.keys(config.reportReasons).includes(req.body.reason) ? req.body.reason : 'etc';
    // 신고 내용: 줄바꿈은 공백으로, 최대 500자. '기타'는 내용을 꼭 써야 함
    const detail = String(req.body.detail || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const table = type === 'post' ? 'posts' : 'comments';

    const target = id && (await db.one(
      `SELECT t.id, p.id AS post_id, p.board FROM ${table} t
       JOIN posts p ON p.id = ${type === 'post' ? 't.id' : 't.post_id'} WHERE t.id = ?`,
      [id]
    ));
    if (!target || !canReadBoard(req.user, target.board)) return res.redirect('/');
    if (reason === 'etc' && detail.length < 5) return res.redirect(`/p/${target.post_id}?notice=report_detail`);

    // 하루 신고 횟수 제한: 회원 줄을 잠가서 동시에 여러 번 보내도 넘지 않게
    const r = await db.tx(async (conn) => {
      await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      const [[dup]] = await conn.query(
        'SELECT 1 AS yes FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?',
        [req.user.id, type, id]
      );
      if (dup) return { affectedRows: 0 }; // 이미 신고한 대상: 횟수 차감 없이 접수된 것으로 안내
      const left = reportsLeft(req.user, await reportsToday(conn.query.bind(conn), req.user.id));
      if (left === 0) return { limited: true };
      const [ins] = await conn.query(
        `INSERT IGNORE INTO reports (reporter_id, target_type, target_id, reason, detail) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, type, id, reason, detail || null]
      );
      return ins;
    });
    if (r.limited) return res.redirect(`/p/${target.post_id}?notice=report_limit`);
    if (r.affectedRows) {
      await db.query(`UPDATE ${table} SET report_count = report_count + 1 WHERE id = ?`, [id]);
      // 신고가 기준 이상 쌓이면 관리자 확인 전까지 자동으로 숨김
      await db.query(
        `UPDATE ${table} SET status = 'hidden' WHERE id = ? AND status = 'visible' AND report_count >= ?`,
        [id, config.reportHideThreshold]
      );
      if (type === 'comment') await refreshCommentCount(target.post_id);
    }
    res.redirect(`/p/${target.post_id}?notice=reported`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
