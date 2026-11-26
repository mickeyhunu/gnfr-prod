// 본인인증(PASS 등) 결과를 users 에 저장. 화면에는 표시하지 않고 보관만 함.
// PASS 연동 시: 인증 결과를 받는 콜백에서 normalizeIdentity() 로 정리한 뒤 saveIdentity() 호출.
//   예) const identity = normalizeIdentity(passResult);
//       if (!isAdult(identity.birthDate)) → 가입 거부
//       const dup = await findUserByCi(identity.ci); → 이미 가입한 사람이면 거부 (번호를 바꿔도 같은 사람)
//       await saveIdentity(userId, identity);
const db = require('../db');
const { normalizePhone } = require('./phone');

// 업체마다 다른 값 형식을 한 가지로 정리
//   birthDate: 'YYYYMMDD' 또는 'YYYY-MM-DD' → 'YYYY-MM-DD'
//   gender: 'M'/'F', '1'/'0'(NICE: 1=남), '남'/'여', 'male'/'female' → 'M'/'F'
//   isForeigner: '1'/'Y'/true/'foreigner' → 1, 그 외 값 → 0
function normalizeIdentity(raw = {}) {
  const birth = String(raw.birthDate || raw.birthdate || raw.birth || '').replace(/\D/g, '');
  const g = String(raw.gender ?? raw.sex ?? '').trim().toLowerCase();
  let gender = null;
  if (['m', '1', '남', '남자', 'male'].includes(g)) gender = 'M';
  else if (['f', '0', '2', '여', '여자', 'female'].includes(g)) gender = 'F';
  const foreign = raw.isForeigner ?? raw.nationalInfo ?? raw.foreigner;
  return {
    name: raw.name ? String(raw.name).trim().slice(0, 50) : null,
    birthDate: /^\d{8}$/.test(birth) ? `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}` : null,
    gender,
    isForeigner: foreign == null || foreign === '' ? null : (['1', 'y', 'true', 'foreigner'].includes(String(foreign).toLowerCase()) ? 1 : 0),
    carrier: raw.carrier || raw.telecom || raw.mobileCo ? String(raw.carrier || raw.telecom || raw.mobileCo).slice(0, 20) : null,
    phone: normalizePhone(raw.phone || raw.mobileNo || raw.phoneNumber),
    ci: raw.ci ? String(raw.ci) : null,
    di: raw.di ? String(raw.di) : null,
  };
}

// 만 나이 19세 이상인지 (birthDate: 'YYYY-MM-DD')
function isAdult(birthDate, now = new Date()) {
  if (!birthDate) return false;
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age >= 19;
}

// 같은 사람(CI)으로 이미 가입한 회원
async function findUserByCi(ci) {
  if (!ci) return null;
  return db.one('SELECT id, status FROM users WHERE ci = ?', [ci]);
}

// 본인인증 정보 저장 (빈 값은 기존 값을 지우지 않음)
async function saveIdentity(userId, identity) {
  const i = identity;
  await db.query(
    `UPDATE users SET
       real_name = COALESCE(?, real_name),
       birth_date = COALESCE(?, birth_date),
       gender = COALESCE(?, gender),
       is_foreigner = COALESCE(?, is_foreigner),
       carrier = COALESCE(?, carrier),
       phone = COALESCE(?, phone),
       ci = COALESCE(?, ci),
       di = COALESCE(?, di),
       identity_verified_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [i.name, i.birthDate, i.gender, i.isForeigner, i.carrier, i.phone, i.ci, i.di, userId]
  );
}

module.exports = { normalizeIdentity, isAdult, findUserByCi, saveIdentity };
