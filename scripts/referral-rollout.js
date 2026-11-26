// 추천인 코드 의무화 전환용 (한 번만 실행)
//   1) 추천인 코드 없이 가입한 기존 회원 → 추천인을 master 코드로 일괄 지정
//   2) 추천인 코드가 없는 모든 회원에게 각자의 추천인 코드 발급
// MASTER_REFERRAL_CODE 가 비어 있어도 기존 회원은 'MASTER' 로 지정
//   npm run referral-rollout
const db = require('../src/db');
const config = require('../src/config');
const { applySchema } = require('../src/schema');
const { newReferralCode } = require('../src/services/referral');

(async () => {
  try {
    await applySchema(db.pool);

    const master = config.referral.masterCode || 'MASTER';
    const assigned = await db.query("UPDATE users SET referrer_code = ? WHERE referrer_code IS NULL AND role <> 'admin'", [master]);
    console.log(`추천인을 ${master} 로 지정한 회원: ${assigned.affectedRows}명`);

    const users = await db.query('SELECT id FROM users WHERE referral_code IS NULL');
    for (const u of users) {
      await db.query('UPDATE users SET referral_code = ? WHERE id = ?', [await newReferralCode(), u.id]);
    }
    console.log(`추천인 코드를 새로 발급한 회원: ${users.length}명`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
