const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

// 비밀번호는 scrypt 해시로만 저장: "scrypt$<salt hex>$<hash hex>"
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltHex, keyHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// 8~64자, 영문과 숫자를 모두 포함
function checkPasswordRule(password) {
  if (password.length < 8 || password.length > 64) return '비밀번호는 8~64자로 정해주세요.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '비밀번호에 영문과 숫자를 모두 넣어주세요.';
  return null;
}

// 추천인 코드: 헷갈리는 글자(0, O, 1, I) 뺀 6자리
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeReferralCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

module.exports = { hashPassword, verifyPassword, checkPasswordRule, makeReferralCode };
