-- 강남의숲 테이블 (MySQL 8.0+)
-- DB와 DB 사용자까지 한 번에 만들려면:  npm run setup-db
-- 서버가 켜질 때도 이 파일을 실행해서 없는 테이블을 만듭니다 (CREATE TABLE IF NOT EXISTS 라 기존 데이터는 그대로).
-- 주의: 문장은 ; 로 나눠서 실행하므로, 주석이나 문자열 안에 ; 를 쓰지 마세요.

-- 회원: 로그인은 전화번호 + 비밀번호. phone_hash 는 번호로 회원을 찾는 키(HMAC-SHA256), phone 은 번호 원문
-- real_name ~ identity_verified_at: 본인인증(PASS 등)으로 받은 정보. 화면에는 표시하지 않고 보관만 함
-- referral_code = 이 회원이 남에게 주는 추천인 코드, referrer_code = 가입할 때 입력한 추천인 코드
-- login_id: 번호 없이 아이디로 들어오는 관리자 계정만 씀 (npm run admin-account). 이때 phone_hash 는 아이디로 만든 값
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone_hash    CHAR(64)     NOT NULL,
  login_id      VARCHAR(30)  NULL,
  phone         VARCHAR(20)  NULL,
  password_hash VARCHAR(255) NULL,
  referral_code VARCHAR(20)  NULL,
  referrer_code VARCHAR(20)  NULL,
  referrer_id   INT UNSIGNED NULL,
  real_name     VARCHAR(50)  NULL,
  birth_date    DATE         NULL,
  gender        ENUM('M','F') NULL,
  is_foreigner  TINYINT(1)   NULL,
  carrier       VARCHAR(20)  NULL,
  ci            VARCHAR(255) NULL,
  di            VARCHAR(255) NULL,
  identity_verified_at DATETIME NULL,
  privacy_agreed_at DATETIME NULL,
  role          ENUM('user','admin')     NOT NULL DEFAULT 'user',
  status        ENUM('active','banned')  NOT NULL DEFAULT 'active',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME     NULL,
  UNIQUE KEY uq_users_phone (phone_hash),
  UNIQUE KEY uq_users_login (login_id),
  UNIQUE KEY uq_users_referral (referral_code),
  UNIQUE KEY uq_users_ci (ci)
) ENGINE=InnoDB;

-- 인증번호: 번호 원문, 인증번호 원문 모두 저장하지 않음
CREATE TABLE IF NOT EXISTS phone_verifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone_hash  CHAR(64)  NOT NULL,
  code_hash   CHAR(64)  NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used        TINYINT(1) NOT NULL DEFAULT 0,
  ip          VARCHAR(45) NULL,
  expires_at  DATETIME  NOT NULL,
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pv_phone (phone_hash, created_at),
  KEY idx_pv_ip (ip, created_at)
) ENGINE=InnoDB;

-- 글: status = visible(공개) / pending(검토 대기) / hidden(숨김) / deleted(삭제)
CREATE TABLE IF NOT EXISTS posts (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        INT UNSIGNED NOT NULL,
  board          VARCHAR(20)  NOT NULL,
  title          VARCHAR(100) NOT NULL,
  body           TEXT         NOT NULL,
  up_count       INT UNSIGNED NOT NULL DEFAULT 0,
  down_count     INT UNSIGNED NOT NULL DEFAULT 0,
  comment_count  INT UNSIGNED NOT NULL DEFAULT 0,
  view_count     INT UNSIGNED NOT NULL DEFAULT 0,
  report_count   INT UNSIGNED NOT NULL DEFAULT 0,
  next_anon_no   INT UNSIGNED NOT NULL DEFAULT 1,
  status         ENUM('visible','pending','hidden','deleted') NOT NULL DEFAULT 'visible',
  flag_words     VARCHAR(255) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_posts_list (status, created_at),
  KEY idx_posts_board (board, status, created_at),
  KEY idx_posts_hot (status, up_count),
  CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 글별 익명 번호: 글쓴이는 0, 댓글 단 순서대로 1, 2, 3...
CREATE TABLE IF NOT EXISTS post_participants (
  post_id  INT UNSIGNED NOT NULL,
  user_id  INT UNSIGNED NOT NULL,
  anon_no  INT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, user_id),
  UNIQUE KEY uq_pp_no (post_id, anon_no),
  CONSTRAINT fk_pp_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comments (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id      INT UNSIGNED NOT NULL,
  parent_id    INT UNSIGNED NULL,          -- 답글이면 원래 댓글 id (답글의 답글도 원래 댓글 아래로)
  reply_to_id  INT UNSIGNED NULL,          -- 답글에 단 답글이면 그 답글 id (화면에 '@익명N' 으로 표시)
  user_id      INT UNSIGNED NOT NULL,
  anon_no      INT UNSIGNED NOT NULL,
  body         VARCHAR(1000) NOT NULL,
  up_count     INT UNSIGNED NOT NULL DEFAULT 0,
  down_count   INT UNSIGNED NOT NULL DEFAULT 0,
  report_count INT UNSIGNED NOT NULL DEFAULT 0,
  status       ENUM('visible','pending','hidden','deleted') NOT NULL DEFAULT 'visible',
  flag_words   VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_comments_parent (parent_id),
  KEY idx_comments_post (post_id, created_at),
  KEY idx_comments_status (status, created_at),
  CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 추천(+1) / 반대(-1): 한 사람이 한 대상에 한 번
CREATE TABLE IF NOT EXISTS votes (
  user_id     INT UNSIGNED NOT NULL,
  target_type ENUM('post','comment') NOT NULL,
  target_id   INT UNSIGNED NOT NULL,
  value       TINYINT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id),
  CONSTRAINT fk_votes_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 읽은 글: 목록에서 읽은 글/안 읽은 글을 구분하는 데 씀 (회원마다, 처음 읽은 때와 마지막으로 읽은 때)
CREATE TABLE IF NOT EXISTS post_reads (
  user_id    INT UNSIGNED NOT NULL,
  post_id    INT UNSIGNED NOT NULL,
  read_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id),
  KEY idx_post_reads_post (post_id),
  CONSTRAINT fk_post_reads_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_post_reads_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 저장한 글 (북마크)
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    INT UNSIGNED NOT NULL,
  post_id    INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id),
  KEY idx_bookmarks_post (post_id),
  CONSTRAINT fk_bookmarks_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_bookmarks_post FOREIGN KEY (post_id) REFERENCES posts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reports (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reporter_id INT UNSIGNED NOT NULL,
  target_type ENUM('post','comment') NOT NULL,
  target_id   INT UNSIGNED NOT NULL,
  reason      VARCHAR(30)  NOT NULL,
  detail      VARCHAR(500) NULL,           -- 신고하는 사람이 직접 쓴 내용 (기타는 필수)
  status      ENUM('open','resolved') NOT NULL DEFAULT 'open',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_report_once (reporter_id, target_type, target_id),
  KEY idx_reports_open (status, created_at),
  CONSTRAINT fk_reports_user FOREIGN KEY (reporter_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 로그인 세션 (express-mysql-session 기본 형식)
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires    INT(11) UNSIGNED NOT NULL,
  data       MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;

-- 광고: 1단계 사업자(상태조회 + 서류) → draft, 2단계 광고 내용 → pending → 운영자 승인. kind: job 구인광고 / ad 기타광고 사업자등록 진위확인(계속사업자)을 통과해야 신청되고, 운영자가 승인하면 /ads 에 노출
-- 첨부 서류는 ad_files (사업자등록증 필수, 영업허가증은 업종에 따라 필수, 기타 서류 선택)
CREATE TABLE IF NOT EXISTS ads (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  kind           ENUM('ad','job') NOT NULL DEFAULT 'ad',
  category       VARCHAR(20) NOT NULL,
  business_name  VARCHAR(60) NOT NULL,
  store_name     VARCHAR(40) NULL,
  store_hours    VARCHAR(60) NULL,
  hours_open     CHAR(5) NULL,
  hours_close    CHAR(5) NULL,
  closed_days    VARCHAR(30) NULL,
  b_no           CHAR(10) NOT NULL,
  owner_name     VARCHAR(30) NULL,
  open_date      DATE NULL,
  title          VARCHAR(60) NOT NULL,
  body           VARCHAR(1000) NOT NULL,
  body_html      MEDIUMTEXT NULL,
  cover_image    VARCHAR(40) NULL,
  address        VARCHAR(200) NOT NULL,
  dong           VARCHAR(20) NULL,
  phone          VARCHAR(20) NOT NULL,
  link_url       VARCHAR(300) NULL,
  contact_name   VARCHAR(30) NULL,
  kakao_id       VARCHAR(50) NULL,
  line_id        VARCHAR(50) NULL,
  wechat_id      VARCHAR(50) NULL,
  telegram_id    VARCHAR(50) NULL,
  employment_type ENUM('employ','dispatch','contract','delegate') NULL,
  job_role       VARCHAR(40) NULL,
  pay_type       ENUM('hour','day','month','case') NULL,
  pay_amount     INT UNSIGNED NULL,
  work_hours     VARCHAR(60) NULL,
  status         ENUM('draft','pending','approved','rejected','suspended','ended') NOT NULL DEFAULT 'pending',
  status_note    VARCHAR(200) NULL,
  nts_status     VARCHAR(30) NULL,
  nts_status_cd  CHAR(2) NULL,
  nts_tax_type   VARCHAR(100) NULL,
  nts_checked_at DATETIME NULL,
  view_count     INT UNSIGNED NOT NULL DEFAULT 0,
  approved_at    DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ads_status (status, approved_at),
  KEY idx_ads_kind (kind, status, approved_at),
  KEY idx_ads_user (user_id),
  KEY idx_ads_bno (b_no),
  CONSTRAINT fk_ads_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 광고 첨부 서류: 파일은 uploads/licenses/ (공개 폴더 아님), 운영자만 /admin/ads/files/:id 로 열람
CREATE TABLE IF NOT EXISTS ad_files (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ad_id      INT UNSIGNED NOT NULL,
  kind       ENUM('biz_cert','license','etc') NOT NULL,
  file       VARCHAR(80) NOT NULL,
  mime       VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ad_files_ad (ad_id, kind),
  CONSTRAINT fk_ad_files_ad FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 1:1 문의 (고객센터). 운영자가 답변하면 user_seen = 0 → 회원이 읽으면 1
CREATE TABLE IF NOT EXISTS inquiries (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  category    VARCHAR(20)  NOT NULL,
  title       VARCHAR(100) NOT NULL,
  body        TEXT         NOT NULL,
  status      ENUM('open','answered') NOT NULL DEFAULT 'open',
  answer      TEXT         NULL,
  answered_by INT UNSIGNED NULL,
  answered_at DATETIME     NULL,
  user_seen   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inquiries_user (user_id, id),
  KEY idx_inquiries_open (status, id),
  CONSTRAINT fk_inquiries_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 실시간강남 가게 정보. region = 지역(강남·잠실 등), dong = 동(주소에서 알 수 있으면), emoji = 사진 대신 쓰는 대표 이모지
-- hours ~ phone 은 비워둬도 됨 (화면에는 '정보 없음'으로 표시). is_active = 0 이면 목록에서 숨김
CREATE TABLE IF NOT EXISTS stores (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  region      VARCHAR(20)  NOT NULL,
  dong        VARCHAR(20)  NULL,
  name        VARCHAR(50)  NOT NULL,
  category    VARCHAR(20)  NOT NULL,
  address     VARCHAR(200) NOT NULL,
  emoji       VARCHAR(16)  NULL,
  hours       VARCHAR(100) NULL,
  intro       VARCHAR(200) NULL,
  phone       VARCHAR(20)  NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_stores_list (is_active, region, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- KCP 본인확인 진행 기록: 거래등록 때 만들고, KCP 가 결과를 돌려주면 결과를 잠깐 담았다가 사용하면 지움
-- purpose: signup(가입) / reset(비밀번호 찾기) / phone(번호 변경) / verify(기존 회원 본인인증)
-- result_json 은 복호화한 본인확인 결과 (이름·생년월일·CI 등). 사용 즉시 지우고, 오래된 행도 지움
CREATE TABLE IF NOT EXISTS kcp_certs (
  ordr_idxx     VARCHAR(50)  NOT NULL PRIMARY KEY,
  reg_cert_key  VARCHAR(40)  NULL,
  purpose       VARCHAR(10)  NOT NULL,
  user_id       INT UNSIGNED NULL,
  status        ENUM('requested','done','failed') NOT NULL DEFAULT 'requested',
  result_json   TEXT         NULL,
  fail_msg      VARCHAR(200) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kcp_reg (reg_cert_key),
  KEY idx_kcp_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 알림: comment(내 글에 댓글) · reply(내 댓글에 답글) · inquiry(문의 답변) · ad(광고 심사 결과)
--   읽음은 read_at. 글·댓글이 가려지거나 지워지면 목록에서 빠짐 (기록은 남김)
CREATE TABLE IF NOT EXISTS notifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  type        VARCHAR(20)  NOT NULL,
  post_id     INT UNSIGNED NULL,
  comment_id  INT UNSIGNED NULL,
  ref_id      INT UNSIGNED NULL,          -- 문의 id 또는 광고 id
  event       VARCHAR(20)  NULL,          -- 광고: approved / rejected / suspended
  note        VARCHAR(200) NULL,          -- 광고 반려·중단 사유
  read_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, id),
  KEY idx_notif_unread (user_id, read_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
