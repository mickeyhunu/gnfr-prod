const db = require('../db');
const config = require('../config');
const { makeReferralCode } = require('./password');

// 마스터 코드로 가입할 수 있는 기간인지 (MASTER_REFERRAL_CODE 를 비우면 끝)
function masterOpen() {
  return Boolean(config.referral.masterCode);
}

// 입력한 추천인 코드 확인 → { code, referrerId } (마스터 코드면 referrerId = null), 없는 코드면 null
async function resolveReferral(input) {
  const code = String(input || '').trim().toUpperCase();
  if (!code) return null;
  if (masterOpen() && code === config.referral.masterCode) return { code, referrerId: null };
  const row = await db.one(`SELECT id FROM users WHERE referral_code = ? AND status = 'active'`, [code]);
  return row ? { code, referrerId: row.id } : null;
}

// 겹치지 않는 새 추천인 코드
async function newReferralCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = makeReferralCode();
    if (code === config.referral.masterCode || code === 'MASTER') continue;
    const taken = await db.one('SELECT 1 AS x FROM users WHERE referral_code = ?', [code]);
    if (!taken) return code;
  }
  throw new Error('추천인 코드를 만들지 못했어요.');
}

// 내 추천인 코드가 아직 없으면(예전 회원) 지금 발급해서 돌려줌
async function ensureReferralCode(userId) {
  const row = await db.one('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (row && row.referral_code) return row.referral_code;
  for (let i = 0; i < 3; i += 1) {
    const code = await newReferralCode();
    try {
      const r = await db.query('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', [code, userId]);
      if (r.affectedRows) return code;
      return (await db.one('SELECT referral_code FROM users WHERE id = ?', [userId])).referral_code;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  throw new Error('추천인 코드를 만들지 못했어요.');
}

// 추천인 코드 없이 가입한 예전 회원인지 (등록 전까지 글·댓글·추천 제한, 운영자는 제외)
function needsReferral(user) {
  return Boolean(user && user.role !== 'admin' && !user.referrer_code);
}

module.exports = { resolveReferral, newReferralCode, ensureReferralCode, needsReferral, masterOpen };
