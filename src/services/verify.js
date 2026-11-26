// 문자 인증번호 확인 (회원가입·비밀번호 찾기·번호 변경에서 같이 씀)
const db = require('../db');
const { hashCode } = require('./phone');

const MAX_ATTEMPTS = 5;

// 맞으면 사용 처리하고 null, 틀리면 오류 문구
async function checkCode(phoneHash, code) {
  if (!/^\d{6}$/.test(code)) return '인증번호 6자리를 입력해주세요.';
  const v = await db.one(
    `SELECT id, code_hash, attempts FROM phone_verifications
     WHERE phone_hash = ? AND used = 0 AND expires_at > UTC_TIMESTAMP()
     ORDER BY id DESC LIMIT 1`,
    [phoneHash]
  );
  if (!v) return '인증번호가 만료됐어요. 다시 받아주세요.';
  if (v.attempts >= MAX_ATTEMPTS) return '입력 횟수를 넘었어요. 인증번호를 다시 받아주세요.';
  if (v.code_hash !== hashCode(phoneHash, code)) {
    await db.query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?', [v.id]);
    return '인증번호가 맞지 않아요.';
  }
  await db.query('UPDATE phone_verifications SET used = 1 WHERE id = ?', [v.id]);
  return null;
}

module.exports = { checkCode };
