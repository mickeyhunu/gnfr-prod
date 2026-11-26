# 강남의숲

강남에서 일하는 사람들을 위한 익명 커뮤니티입니다.
Node.js(Express) + MySQL + EJS로 만들었고, 모바일 화면 기준으로 디자인했습니다.

## 들어 있는 기능

| 기능 | 설명 |
|---|---|
| 19세 미만 이용 불가 | 시작 화면에 청소년 유해매체물 안내 + '만 19세 이상' 확인 체크 필수 (본인인증 연동은 아직) |
| 문자 인증 건너뛰기 (임시) | `.env` 의 `SKIP_PHONE_AUTH=true` 이면 문자 인증 없이 바로 입장(임시 익명 계정). 운영 전에 `false` 로 |
| 전화번호 인증 가입 | 인증번호 6자리, 3분 유효, 1분에 1번 / 하루 5번까지 요청, 5번 틀리면 다시 받기 |
| 회원 정보 | 휴대폰 번호(원문)와 본인인증 정보(이름·생년월일·성별·CI 등)는 `users` 에 보관만 하고 화면에는 표시하지 않음. 인증번호는 해시만 저장 |
| 폐쇄형 | 가입한 회원만 글을 볼 수 있음. 검색엔진 노출 차단(noindex) |
| 하단 바 | 홈(`/`) · 숲 커뮤니티(`/forest`) · 구인(`/ads`, 구인 메인 + 업장 광고) · 마이페이지(`/me`) |
| 게시판 | 일상 · 고민 · 정보 · 퇴근길 (`src/config.js` 의 `boards` 에서 변경) |
| 핫 게시판 | 최근 7일 안에 추천 40개 이상 받은 글을 추천순으로 (`.env` 의 `HOT_THRESHOLD`) |
| 익명 번호 댓글 | 글마다 글쓴이 / 익명1 / 익명2 … 번호가 따로 붙음 |
| 추천 · 반대 | 한 사람당 한 번, 다시 누르면 취소. 내 글에는 못 누름 |
| 자동 검토 | `FLAG_WORDS` 단어나 전화번호가 들어간 글·댓글은 바로 공개하지 않고 관리자 검토 대기 |
| 신고 | 사유를 골라 신고. 5건 이상 쌓이면 자동 숨김 (`REPORT_HIDE_THRESHOLD`) |
| 관리자 화면 | `/admin` 에서 검토 대기 글·댓글 승인, 신고 처리, 작성자 이용 제한 |
| 보안 | CSRF 토큰, 세션 재발급, 요청 횟수 제한, helmet 보안 헤더, 모든 출력 이스케이프 |

## 처음 실행하기 (내 컴퓨터)

필요한 것: Node.js 18 이상, MySQL 8.0 이상

```bash
# 1) 패키지 설치
npm install

# 2) DB 초기 세팅 (MySQL root 비밀번호를 물어봐요)
npm run setup-db

# 3) 실행
npm start
```

`npm run setup-db` 가 해주는 일 (여러 번 실행해도 기존 데이터는 그대로예요):

1. `.env` 가 없으면 `.env.example` 을 복사하고, 기본값인 `DB_PASSWORD`, `SESSION_SECRET`, `PHONE_PEPPER` 를 무작위 값으로 채움
2. DB(`DB_NAME`) 만들기 (utf8mb4)
3. 앱 전용 DB 사용자(`DB_USER`) 만들기, 비밀번호를 `.env` 의 `DB_PASSWORD` 로 맞추고 이 DB 권한만 주기
4. `sql/schema.sql` 의 테이블 만들기, 앱 계정으로 접속되는지 확인

- root 비밀번호를 매번 치기 싫으면 실행할 때만 넣어도 돼요: `DB_ROOT_PASSWORD=... npm run setup-db`
- 앱 서버와 DB 서버가 다른 컴퓨터면 `.env` 에 `DB_USER_HOST=%` (또는 앱 서버 IP)를 넣고 실행하세요.
- 서버가 켜질 때도 `sql/schema.sql` 을 실행해서 **없는 테이블은 자동으로 만들어요.** 테이블을 추가할 땐 이 파일에 `CREATE TABLE IF NOT EXISTS` 로 적으면 돼요. (이미 있는 테이블의 컬럼 변경은 자동으로 안 되니 따로 `ALTER TABLE` 하세요.)
- DB 접속이 안 되면 서버가 켜지지 않고 이유를 알려줘요.

브라우저에서 http://localhost:3000 을 열면 됩니다.
개발 모드(`SMS_PROVIDER=console`)에서는 문자가 가지 않고, **인증번호가 서버 터미널에 찍힙니다.**

## 관리자 지정

사이트에서 관리자로 쓸 번호로 먼저 가입한 뒤:

```bash
npm run make-admin -- 010-1234-5678
```

번호 없이 아이디로 들어오는 관리자 계정은 아래처럼 만들고(비밀번호는 실행하면 물어봄), `/admin/login` 에서 로그인합니다.

```bash
npm run admin-account -- MASTER
```

목록 화면 오른쪽 위에 `관리` 링크가 생기고, `/admin` 에 들어갈 수 있습니다.

## 실제 문자 보내기 (솔라피)

1. [솔라피](https://solapi.com) 가입 → 발신번호 등록 → API Key 발급
2. `.env` 수정
   ```
   SMS_PROVIDER=solapi
   SOLAPI_API_KEY=발급받은키
   SOLAPI_API_SECRET=발급받은시크릿
   SMS_FROM=등록한발신번호
   ```
3. 운영 전에 `src/services/sms.js` 의 요청 형식을 솔라피 최신 문서와 한 번 대조해주세요.

다른 문자 업체를 쓰려면 `src/services/sms.js` 에 함수 하나만 추가하면 됩니다.

## 서버에 올리기 (요약)

```bash
# 서버(Ubuntu 등)에서
npm install --omit=dev
npm install -g pm2
NODE_ENV=production pm2 start src/app.js --name gangnam-forest
pm2 save && pm2 startup
```

- 앞단에 nginx를 두고 3000번 포트로 프록시, **https 필수**(Let's Encrypt 무료 인증서)
- `.env` 에 `NODE_ENV=production`, `BASE_URL=https://내도메인` 설정
- 운영 모드에서는 `SESSION_SECRET`, `PHONE_PEPPER` 가 기본값이면 서버가 켜지지 않습니다.
- **`PHONE_PEPPER` 는 절대 바꾸거나 잃어버리면 안 됩니다.** 바뀌면 기존 회원 전원이 새 회원으로 인식돼요. 따로 안전하게 보관하세요.
- 서버에서도 처음 한 번 `npm run setup-db` 를 실행하세요.
- DB는 매일 백업하세요 (`mysqldump gangnam_forest > backup.sql`).

## 폴더 구조

```
sql/schema.sql            DB 테이블 (서버 시작 때 없는 테이블 자동 생성)
src/app.js                서버 시작점
src/config.js             설정 (게시판, 핫 기준, 신고 기준 등)
src/db.js                 MySQL 연결
src/schema.js             schema.sql 실행
src/middleware/           로그인 확인, CSRF
src/services/             전화번호·비밀번호·본인인증 정보, 문자 발송, 검토 단어, 시간 표시
src/routes/auth.js        가입·로그인
src/routes/pages.js       홈, 광고, 마이페이지
src/routes/posts.js       숲(/forest) 목록, 글, 댓글, 추천, 신고
src/routes/admin.js       관리자
views/                    화면(EJS)
public/                   CSS, 브라우저 스크립트
public/images/brand/      logo.webp(상단 로고·시작 화면), favicon.webp(파비콘 전용)
scripts/setup-db.js       DB 초기 세팅 (npm run setup-db)
scripts/make-admin.js     관리자 지정
scripts/admin-account.js  아이디 관리자 계정 만들기·비밀번호 바꾸기
```

## 아직 없는 기능 (다음 단계 후보)

- 사진 첨부 (시안에는 버튼이 있었지만 이번 버전에서는 뺐어요. 사진 속 얼굴·간판으로 특정인이 드러날 위험이 커서, 넣는다면 검토 후 공개로 하는 걸 추천해요)
- 다크 모드
- 검색
- 텔레그램 제보봇 연동
- 답글(대댓글)
