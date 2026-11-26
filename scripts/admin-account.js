// 아이디로 로그인하는 관리자 계정 만들기 (이미 있으면 비밀번호만 바꿈)
//   npm run admin-account -- MASTER
// 비밀번호는 실행하면 물어봄 (화면에 안 보임). 로그인은 /admin/login 에서
const crypto = require('crypto');
const readline = require('readline');
const db = require('../src/db');
const { applySchema } = require('../src/schema');
const { hashPassword, checkPasswordRule } = require('../src/services/password');
const { newReferralCode } = require('../src/services/referral');

// 입력한 글자를 화면에 찍지 않고 한 줄 받기
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
      else if (s.includes('\n') || s.includes('\r')) rl.output.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

(async () => {
  const loginId = String(process.argv[2] || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,29}$/.test(loginId)) {
    console.error('사용법: npm run admin-account -- 아이디   (영문으로 시작, 영문·숫자·_ 3~30자)');
    process.exit(1);
  }
  await applySchema(db.pool);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await askHidden('비밀번호: ');
    if (password !== (await askHidden('비밀번호 확인: '))) {
      console.error('비밀번호 확인이 일치하지 않아요.');
      process.exit(1);
    }
  }
  const ruleError = checkPasswordRule(password);
  if (ruleError) {
    console.error(ruleError);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await db.one('SELECT id FROM users WHERE login_id = ?', [loginId]);
  if (existing) {
    await db.query(`UPDATE users SET password_hash = ?, role = 'admin', status = 'active' WHERE id = ?`, [hash, existing.id]);
    console.log(`관리자 계정 ${loginId} 의 비밀번호를 바꿨어요.`);
  } else {
    // 번호가 없는 계정이라 phone_hash 는 아이디로 만든 값 (실제 번호의 값과 겹치지 않음)
    const phoneHash = crypto.createHash('sha256').update('admin-login:' + loginId.toLowerCase()).digest('hex');
    await db.query(
      `INSERT INTO users (phone_hash, login_id, password_hash, referral_code, role, privacy_agreed_at)
       VALUES (?, ?, ?, ?, 'admin', UTC_TIMESTAMP())`,
      [phoneHash, loginId, hash, await newReferralCode()]
    );
    console.log(`관리자 계정 ${loginId} 을 만들었어요. /admin/login 에서 로그인하세요.`);
  }
  await db.pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
