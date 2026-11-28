const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, '..', 'sql', 'schema.sql');

// sql/schema.sql 을 문장 단위로 나눔 (-- 주석 줄은 버림)
function loadStatements() {
  return fs
    .readFileSync(SCHEMA_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 이미 만들어진 테이블에 나중에 추가된 칸 (CREATE TABLE IF NOT EXISTS 는 기존 테이블을 바꾸지 않으므로 따로 추가)
const ADDED_COLUMNS = [
  ['users', 'phone', 'VARCHAR(20) NULL AFTER phone_hash'],
  ['users', 'login_id', 'VARCHAR(30) NULL AFTER phone_hash'],
  ['users', 'password_hash', 'VARCHAR(255) NULL AFTER phone'],
  ['users', 'referral_code', 'VARCHAR(20) NULL AFTER password_hash'],
  ['users', 'referrer_code', 'VARCHAR(20) NULL AFTER referral_code'],
  ['users', 'referrer_id', 'INT UNSIGNED NULL AFTER referrer_code'],
  // 본인인증(PASS 등) 정보
  ['users', 'real_name', 'VARCHAR(50) NULL AFTER referrer_id'],
  ['users', 'birth_date', 'DATE NULL AFTER real_name'],
  ['users', 'gender', "ENUM('M','F') NULL AFTER birth_date"],
  ['users', 'is_foreigner', 'TINYINT(1) NULL AFTER gender'],
  ['users', 'carrier', 'VARCHAR(20) NULL AFTER is_foreigner'],
  ['users', 'ci', 'VARCHAR(255) NULL AFTER carrier'],
  ['users', 'di', 'VARCHAR(255) NULL AFTER ci'],
  ['users', 'identity_verified_at', 'DATETIME NULL AFTER di'],
  ['users', 'privacy_agreed_at', 'DATETIME NULL AFTER identity_verified_at'],
  ['posts', 'view_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER comment_count'],
  ['comments', 'parent_id', 'INT UNSIGNED NULL AFTER post_id'],
  ['comments', 'reply_to_id', 'INT UNSIGNED NULL AFTER parent_id'],
  ['comments', 'down_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER up_count'],
  ['reports', 'detail', 'VARCHAR(500) NULL AFTER reason'],
  // 구인 광고
  ['ads', 'kind', "ENUM('ad','job') NOT NULL DEFAULT 'ad' AFTER user_id"],
  ['ads', 'job_role', 'VARCHAR(40) NULL AFTER link_url'],
  ['ads', 'pay_type', "ENUM('hour','day','month','case') NULL AFTER job_role"],
  ['ads', 'pay_amount', 'INT UNSIGNED NULL AFTER pay_type'],
  ['ads', 'work_hours', 'VARCHAR(60) NULL AFTER pay_amount'],
  // 광고 2단계: 에디터 본문, 담당자·메신저, 고용형태
  ['ads', 'body_html', 'MEDIUMTEXT NULL AFTER body'],
  ['ads', 'cover_image', 'VARCHAR(40) NULL AFTER body_html'],
  ['ads', 'dong', 'VARCHAR(20) NULL AFTER address'],
  ['ads', 'store_name', 'VARCHAR(40) NULL AFTER business_name'],
  ['ads', 'store_hours', 'VARCHAR(60) NULL AFTER store_name'],
  ['ads', 'hours_open', 'CHAR(5) NULL AFTER store_hours'],
  ['ads', 'hours_close', 'CHAR(5) NULL AFTER hours_open'],
  ['ads', 'closed_days', 'VARCHAR(30) NULL AFTER hours_close'],
  ['ads', 'contact_name', 'VARCHAR(30) NULL AFTER link_url'],
  ['ads', 'kakao_id', 'VARCHAR(50) NULL AFTER contact_name'],
  ['ads', 'line_id', 'VARCHAR(50) NULL AFTER kakao_id'],
  ['ads', 'wechat_id', 'VARCHAR(50) NULL AFTER line_id'],
  ['ads', 'telegram_id', 'VARCHAR(50) NULL AFTER wechat_id'],
  ['ads', 'employment_type', "ENUM('employ','dispatch','contract','delegate') NULL AFTER telegram_id"],
  // 가게 지도 위치 (비워두면 지도에서 주소로 위치를 찾음)
  ['stores', 'lat', 'DECIMAL(10,7) NULL AFTER address'],
  ['stores', 'lng', 'DECIMAL(10,7) NULL AFTER lat'],
];
const ADDED_INDEXES = [
  ['users', 'uq_users_login', 'UNIQUE KEY uq_users_login (login_id)'],
  ['users', 'uq_users_referral', 'UNIQUE KEY uq_users_referral (referral_code)'],
  ['users', 'uq_users_ci', 'UNIQUE KEY uq_users_ci (ci)'],
  ['comments', 'idx_comments_parent', 'KEY idx_comments_parent (parent_id)'],
  ['ads', 'idx_ads_kind', 'KEY idx_ads_kind (kind, status, approved_at)'],
];

// 나중에 정의가 바뀐 칸: [테이블, 칸, 새 정의, 이미 바뀌었는지 COLUMN_TYPE 으로 판단할 글자]
const CHANGED_COLUMNS = [
  // 광고 1단계(사업자·서류)만 마친 작성 중 상태
  ['ads', 'status', "ENUM('draft','pending','approved','rejected','suspended','ended') NOT NULL DEFAULT 'pending'", "'draft'"],
];

// 나중에 NULL 허용으로 바뀐 칸: [테이블, 칸, 새 정의]
const NULLABLE_COLUMNS = [
  // 광고: 1단계가 사업자번호 상태조회만 하도록 바뀌어 대표자·개업일자는 안 받음
  ['ads', 'owner_name', 'VARCHAR(30) NULL'],
  ['ads', 'open_date', 'DATE NULL'],
];

async function addMissing(conn) {
  for (const [table, column, def] of ADDED_COLUMNS) {
    const [rows] = await conn.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
  }
  for (const [table, column, def] of NULLABLE_COLUMNS) {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND IS_NULLABLE = 'NO'",
      [table, column]
    );
    if (rows.length) await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${def}`);
  }
  for (const [table, column, def, mark] of CHANGED_COLUMNS) {
    const [rows] = await conn.query(
      'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    if (rows.length && !String(rows[0].t).includes(mark)) await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${def}`);
  }
  for (const [table, index, def] of ADDED_INDEXES) {
    const [rows] = await conn.query(
      'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [table, index]
    );
    if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD ${def}`);
  }
}

// 없는 테이블·칸만 만듦 (기존 데이터는 그대로). conn 은 mysql2/promise 의 connection 또는 pool
async function applySchema(conn) {
  for (const sql of loadStatements()) {
    await conn.query(sql);
  }
  await addMissing(conn);
  await backfillNotifications(conn);
}

// 알림 테이블을 처음 만들었을 때: 예전 방식(내 글에 달린 댓글)의 최근 30일 알림을 읽은 상태로 옮겨 둠
async function backfillNotifications(conn) {
  const [[has]] = await conn.query('SELECT EXISTS(SELECT 1 FROM notifications) AS e');
  if (has.e) return;
  await conn.query(
    `INSERT INTO notifications (user_id, type, post_id, comment_id, read_at, created_at)
     SELECT p.user_id, 'comment', c.post_id, c.id, NOW(), c.created_at
     FROM comments c JOIN posts p ON p.id = c.post_id
     WHERE c.user_id <> p.user_id AND c.status = 'visible' AND p.status <> 'deleted' AND c.created_at > NOW() - INTERVAL 30 DAY`
  );
}

module.exports = { applySchema, loadStatements };
