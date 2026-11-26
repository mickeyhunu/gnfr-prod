// DB 초기 세팅: DB 만들기 → DB 사용자 만들기/비밀번호 맞추기 → 테이블 만들기 → 접속 확인
//   npm run setup-db
// MySQL 관리자(root) 비밀번호를 물어봅니다. 매번 입력하기 싫으면 실행할 때만 환경변수로:
//   DB_ROOT_USER=root DB_ROOT_PASSWORD=... npm run setup-db
// 여러 번 실행해도 괜찮아요. 기존 데이터는 지우지 않습니다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ENV_FILE = path.join(__dirname, '..', '.env');
const ENV_EXAMPLE = path.join(__dirname, '..', '.env.example');
// 내 컴퓨터: .env.local 의 DB_ 값(로컬 MySQL)이 우선. 운영: .env 의 RDS 값
const ENV_LOCAL = path.join(__dirname, '..', '.env.local');
const localHasDb = () => fs.existsSync(ENV_LOCAL) && /^DB_HOST=/m.test(fs.readFileSync(ENV_LOCAL, 'utf8'));

const isPlaceholder = (v) => !v || v.startsWith('change-me');
const randomHex = (n) => crypto.randomBytes(n).toString('hex');

// 1) .env 준비: 없으면 .env.example 을 복사하고, 기본값(change-me...)인 비밀값은 무작위로 채움
function prepareEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    console.log('· .env 가 없어서 .env.example 을 복사했어요.');
  }
  let text = fs.readFileSync(ENV_FILE, 'utf8');
  const get = (k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
  const set = (k, v) => {
    text = new RegExp(`^${k}=`, 'm').test(text)
      ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
      : `${text.trimEnd()}\n${k}=${v}\n`;
  };

  const filled = [];
  if (!localHasDb() && isPlaceholder(get('DB_PASSWORD'))) { set('DB_PASSWORD', crypto.randomBytes(18).toString('base64url')); filled.push('DB_PASSWORD'); }
  if (isPlaceholder(get('SESSION_SECRET'))) { set('SESSION_SECRET', randomHex(32)); filled.push('SESSION_SECRET'); }
  if (isPlaceholder(get('PHONE_PEPPER'))) { set('PHONE_PEPPER', randomHex(32)); filled.push('PHONE_PEPPER'); }
  if (filled.length) {
    fs.writeFileSync(ENV_FILE, text);
    console.log(`· .env 에 무작위 값을 채웠어요: ${filled.join(', ')}`);
    if (filled.includes('PHONE_PEPPER')) console.log('  PHONE_PEPPER 는 앞으로 절대 바꾸지 말고 따로 보관하세요.');
  }
}

// 화면에 안 보이게 비밀번호 입력받기
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    let muted = false; // 질문은 보여주고, 그 뒤 입력하는 글자는 숨김
    rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const q = (name) => '`' + String(name).replace(/`/g, '``') + '`';

async function main() {
  prepareEnv();
  require('dotenv').config({ path: ENV_FILE, override: true });
  if (fs.existsSync(ENV_LOCAL)) require('dotenv').config({ path: ENV_LOCAL, override: true });
  const { ssl } = require('../src/config').db; // RDS 면 TLS
  const mysql = require('mysql2/promise');
  const { applySchema } = require('../src/schema');

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);
  const dbName = process.env.DB_NAME || 'gangnam_forest';
  const appUser = process.env.DB_USER || 'forest';
  const appPass = process.env.DB_PASSWORD;
  // 앱이 같은 컴퓨터의 DB에 붙으면 localhost, 다른 서버에서 붙으면(RDS 등) %
  const appUserHost = process.env.DB_USER_HOST || (/.rds.amazonaws.com$/i.test(host) ? '%' : 'localhost');

  // 앱이 root 로 접속하도록 설정한 경우: 사용자 만들기는 건너뛰고 DB·테이블만 만듦
  const appIsRoot = appUser === 'root';
  if (appIsRoot) {
    console.log('· [주의] DB_USER=root 예요. 내 컴퓨터 개발용으로는 괜찮지만, 운영 서버에서는 전용 사용자(예: forest)를 쓰세요.');
  }

  // RDS 는 관리자 이름이 보통 admin (RDS 만들 때 정한 마스터 사용자)
  const rootUser = appIsRoot ? 'root' : process.env.DB_ROOT_USER || 'root';
  const rootPass = appIsRoot
    ? appPass
    : process.env.DB_ROOT_PASSWORD ?? (await askHidden(`MySQL ${rootUser} 비밀번호: `));

  // 2) 관리자 계정으로 DB와 사용자 만들기
  let admin;
  try {
    admin = await mysql.createConnection({ host, port, user: rootUser, password: rootPass, charset: 'utf8mb4', ...(ssl ? { ssl } : {}) });
  } catch (err) {
    if (err.code === 'ER_ACCESS_DENIED_ERROR') throw new Error(`${rootUser} 비밀번호가 맞지 않아요.`);
    if (err.code === 'ECONNREFUSED') throw new Error(`MySQL 서버(${host}:${port})에 연결할 수 없어요. MySQL 이 켜져 있는지 확인하세요.`);
    throw err;
  }

  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${q(dbName)} DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`);
    console.log(`· DB ${dbName} 준비 완료`);

    if (!appIsRoot) {
      await admin.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [appUser, appUserHost, appPass]);
      await admin.query('ALTER USER ?@? IDENTIFIED BY ?', [appUser, appUserHost, appPass]);
      await admin.query(`GRANT ALL PRIVILEGES ON ${q(dbName)}.* TO ?@?`, [appUser, appUserHost]);
      await admin.query('FLUSH PRIVILEGES');
      console.log(`· 사용자 '${appUser}'@'${appUserHost}' 준비 완료 (비밀번호는 .env 의 DB_PASSWORD)`);
    }
  } finally {
    await admin.end();
  }

  // 3) 앱 계정으로 접속해서 테이블 만들기 (= 앱이 실제로 접속되는지 확인도 겸함)
  const app = await mysql.createConnection({ host, port, user: appUser, password: appPass, database: dbName, charset: 'utf8mb4', ...(ssl ? { ssl } : {}) });
  try {
    await applySchema(app);
    const [rows] = await app.query('SHOW TABLES');
    console.log(`· 테이블 ${rows.length}개: ${rows.map((r) => Object.values(r)[0]).join(', ')}`);
  } finally {
    await app.end();
  }

  console.log('\n완료! 이제 서버를 (다시) 켜세요:  npm start');
}

main().catch((err) => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
