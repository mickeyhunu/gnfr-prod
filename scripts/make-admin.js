// 관리자 지정: 먼저 사이트에서 그 번호로 가입한 뒤 실행
//   npm run make-admin -- 010-1234-5678
const db = require('../src/db');
const { normalizePhone, hashPhone } = require('../src/services/phone');

(async () => {
  const phone = normalizePhone(process.argv[2]);
  if (!phone) {
    console.error('사용법: npm run make-admin -- 010-1234-5678');
    process.exit(1);
  }
  const r = await db.query(`UPDATE users SET role = 'admin' WHERE phone_hash = ?`, [hashPhone(phone)]);
  if (r.affectedRows) console.log('관리자로 지정했어요.');
  else console.log('이 번호로 가입한 회원이 없어요. 사이트에서 먼저 가입해주세요.');
  await db.pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
