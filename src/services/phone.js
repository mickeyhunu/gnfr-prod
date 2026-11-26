const crypto = require('crypto');
const config = require('../config');

// 010-1234-5678, 01012345678, +82 10-1234-5678 → 01012345678
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  if (!/^01[016789]\d{7,8}$/.test(digits)) return null;
  return digits;
}

// 번호로 회원을 찾는 키 (users.phone_hash). 번호 원문은 users.phone 에 따로 저장
function hashPhone(phone) {
  return crypto.createHmac('sha256', config.phonePepper).update(phone).digest('hex');
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(phoneHash, code) {
  return crypto.createHmac('sha256', config.phonePepper).update(`${phoneHash}:${code}`).digest('hex');
}

module.exports = { normalizePhone, hashPhone, makeCode, hashCode };
