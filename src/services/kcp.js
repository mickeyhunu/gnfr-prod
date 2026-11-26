// NHN KCP 휴대폰 본인확인 V2 (https://developer.kcp.co.kr/guide/cert)
//   1) 거래등록  : 요청 JSON 을 encryptJson 으로 암호화해 certDataReg.do 로 보냄 → call_url, reg_cert_key
//   2) 인증창    : call_url 로 reg_cert_key 를 폼 전송 (화면 전환 방식)
//   3) 결과 수신 : KCP 가 Ret_URL(KCP_RETURN_URL) 로 res_cd, reg_cert_key 를 보냄
//   4) 결과조회  : getCertData.do 로 reg_cert_key + ordr_idxx → enc_cert_data, rv → decryptJson 으로 복호화
// 암복호화(encryptJson / decryptJson)는 기본으로 kcp-crypto.js 를 씀.
// KCP 가 준 라이브러리로 바꾸려면 KCP_CRYPTO_MODULE 에 그 파일 경로를 적음. 아래 두 함수를 내보내야 함 (동기·비동기 모두 됨)
//   encryptJson(jsonText, encKey, siteCd) → { encData, rv }  (enc_data 나 [encData, rv] 로 돌려줘도 됨)
//   decryptJson(encCertData, rv, encKey, siteCd) → 복호화한 JSON 문자열 (또는 객체)
const crypto = require('crypto');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { normalizePhone } = require('./phone');

const TIMEOUT_MS = 10000;
const CERT_TTL_MIN = 15; // 거래등록부터 결과 사용까지 허용 시간
const PURPOSES = ['signup', 'reset', 'phone', 'verify'];

const host = () => config.kcp.apiHost || (config.kcp.production ? 'https://cert.kcp.co.kr' : 'https://testcert.kcp.co.kr');

let lib;
let libError = null;
function loadLib() {
  if (lib !== undefined) return lib;
  lib = null;
  // KCP_CRYPTO_MODULE 을 비워두면 함께 들어 있는 kcp-crypto.js 를 씀 (상대 경로는 프로젝트 폴더 기준)
  const file = config.kcp.cryptoModule
    ? path.resolve(path.join(__dirname, '..', '..'), config.kcp.cryptoModule)
    : path.join(__dirname, 'kcp-crypto.js');
  try {
    const m = require(file);
    const enc = m.encryptJson || (m.default && m.default.encryptJson);
    const dec = m.decryptJson || (m.default && m.default.decryptJson);
    if (typeof enc !== 'function' || typeof dec !== 'function') throw new Error('encryptJson / decryptJson 함수가 없어요.');
    lib = { enc, dec };
  } catch (e) {
    libError = `KCP 암복호화 라이브러리를 불러오지 못했어요: ${e.message}`;
  }
  return lib;
}

// 설정이 다 있고 라이브러리도 불러왔으면 true
function isReady() {
  const k = config.kcp;
  return Boolean(k.siteCd && k.encKey && k.returnUrl && loadLib());
}

// 켜지지 않은 이유 (서버 시작할 때 로그용). 다 갖춰졌으면 null
function notReadyReason() {
  const k = config.kcp;
  const missing = [['KCP_SITE_CODE', k.siteCd], ['KCP_ENC_KEY', k.encKey], ['KCP_RETURN_URL', k.returnUrl]].filter((x) => !x[1]).map((x) => x[0]);
  if (missing.length) return `${missing.join(', ')} 이 비어 있어요.`;
  if (!loadLib()) return libError;
  return null;
}

async function encryptJson(obj) {
  if (!loadLib()) throw new Error(libError);
  const out = await lib.enc(JSON.stringify(obj), config.kcp.encKey, config.kcp.siteCd);
  const encData = Array.isArray(out) ? out[0] : out && (out.encData || out.enc_data);
  const rv = Array.isArray(out) ? out[1] : out && out.rv;
  if (!encData || !rv) throw new Error('encryptJson 결과에 encData / rv 가 없어요.');
  return { encData: String(encData), rv: String(rv) };
}

async function decryptJson(encCertData, rv) {
  if (!loadLib()) throw new Error(libError);
  const out = await lib.dec(encCertData, rv, config.kcp.encKey, config.kcp.siteCd);
  return typeof out === 'string' ? JSON.parse(out) : out;
}

async function post(apiPath, headers, body) {
  const res = await fetch(host() + apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', site_cd: config.kcp.siteCd, ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error(`KCP 응답을 읽지 못했어요 (HTTP ${res.status})`);
  }
  return data;
}

// 주문번호: 가맹점이 정하는 거래 번호 (최대 50자)
function newOrderNo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `GF${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${crypto.randomBytes(6).toString('hex')}`;
}

// 1) 거래등록 → { ordr, callUrl, regCertKey }
async function register(purpose, userId) {
  if (!PURPOSES.includes(purpose)) throw new Error('알 수 없는 본인확인 용도예요.');
  const ordr = newOrderNo();
  const { encData, rv } = await encryptJson({
    site_cd: config.kcp.siteCd,
    ordr_idxx: ordr,
    Ret_URL: config.kcp.returnUrl,
    param_opt_1: purpose,
  });
  const r = await post('/api/reg/certDataReg.do', { rv }, encData);
  if (r.res_cd !== '0000' || !r.call_url || !r.reg_cert_key) {
    throw new Error(`KCP 거래등록 실패: ${r.res_cd || '?'} ${r.res_msg || ''}`.trim());
  }
  await db.query('INSERT INTO kcp_certs (ordr_idxx, reg_cert_key, purpose, user_id) VALUES (?, ?, ?, ?)', [ordr, r.reg_cert_key, purpose, userId || null]);
  // 오래된 진행 기록 정리 (결과에 개인정보가 들어 있을 수 있음)
  await db.query('DELETE FROM kcp_certs WHERE created_at < NOW() - INTERVAL 1 DAY');
  return { ordr, callUrl: r.call_url, regCertKey: r.reg_cert_key };
}

// KCP 결과(복호화 JSON) → identity.js 의 형식
function toIdentity(d) {
  const ci = d.CI || d.ci || (d.CI_URL ? decodeURIComponent(d.CI_URL) : null);
  const di = d.DI || d.di || (d.DI_URL ? decodeURIComponent(d.DI_URL) : null);
  const birth = String(d.birth_day || '').replace(/\D/g, '');
  let name = d.user_name ? String(d.user_name) : null;
  if (name && /%[0-9A-Fa-f]{2}/.test(name)) {
    try { name = decodeURIComponent(name); } catch (_) { /* 그대로 */ }
  }
  return {
    name: name ? name.trim().slice(0, 50) : null,
    birthDate: /^\d{8}$/.test(birth) ? `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}` : null,
    gender: d.sex_code === '01' ? 'M' : d.sex_code === '02' ? 'F' : null,
    isForeigner: d.local_code === '02' ? 1 : d.local_code === '01' ? 0 : null,
    carrier: d.comm_id ? String(d.comm_id).slice(0, 20) : null,
    phone: normalizePhone(d.phone_no),
    ci: ci ? String(ci) : null,
    di: di ? String(di) : null,
  };
}

// 3) + 4) Ret_URL 로 돌아온 결과 처리 → 처리한 진행 기록 { ordr, purpose } (없거나 만료면 null)
async function handleReturn(body) {
  const regCertKey = String(body.reg_cert_key || '').slice(0, 40);
  if (!regCertKey) return null;
  const row = await db.one(
    `SELECT ordr_idxx, purpose FROM kcp_certs
     WHERE reg_cert_key = ? AND status = 'requested' AND created_at > NOW() - INTERVAL ? MINUTE`,
    [regCertKey, CERT_TTL_MIN]
  );
  if (!row) return null;
  const fail = async (msg) => {
    await db.query(`UPDATE kcp_certs SET status = 'failed', fail_msg = ? WHERE ordr_idxx = ?`, [msg.slice(0, 200), row.ordr_idxx]);
    return { ordr: row.ordr_idxx, purpose: row.purpose };
  };
  if (body.res_cd !== '0000') return fail(body.res_cd === '9999' || /취소/.test(body.res_msg || '') ? '본인확인을 취소했어요.' : '본인확인이 완료되지 않았어요. 다시 시도해주세요.');
  try {
    const r = await post('/api/query/getCertData.do', {}, JSON.stringify({ reg_cert_key: regCertKey, ordr_idxx: row.ordr_idxx }));
    if (r.res_cd !== '0000' || !r.enc_cert_data || !r.rv) {
      console.error('[KCP] 결과조회 실패:', r.res_cd, r.res_msg);
      return fail('본인확인 결과를 받지 못했어요. 다시 시도해주세요.');
    }
    const d = await decryptJson(r.enc_cert_data, r.rv);
    if (!d || (d.res_cd && d.res_cd !== '0000')) return fail('본인확인 결과를 확인하지 못했어요. 다시 시도해주세요.');
    const identity = toIdentity(d);
    if (!identity.ci || !identity.phone || !identity.birthDate) return fail('본인확인 결과에 필요한 정보가 없어요. 다시 시도해주세요.');
    await db.query(`UPDATE kcp_certs SET status = 'done', result_json = ? WHERE ordr_idxx = ?`, [JSON.stringify(identity), row.ordr_idxx]);
    return { ordr: row.ordr_idxx, purpose: row.purpose };
  } catch (e) {
    console.error('[KCP] 결과 처리 오류:', e.message);
    return fail('본인확인 처리 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.');
  }
}

// 결과 꺼내기 (한 번만): { purpose, userId, identity } 또는 { purpose, error }. 꺼내면 기록을 지움
async function takeResult(ordr) {
  const row = ordr && (await db.one(
    `SELECT purpose, user_id, status, result_json, fail_msg FROM kcp_certs WHERE ordr_idxx = ? AND created_at > NOW() - INTERVAL ? MINUTE`,
    [String(ordr).slice(0, 50), CERT_TTL_MIN]
  ));
  if (!row || row.status === 'requested') return null;
  await db.query('DELETE FROM kcp_certs WHERE ordr_idxx = ?', [ordr]);
  if (row.status === 'failed') return { purpose: row.purpose, userId: row.user_id, error: row.fail_msg || '본인확인에 실패했어요.' };
  return { purpose: row.purpose, userId: row.user_id, identity: JSON.parse(row.result_json) };
}

module.exports = { isReady, notReadyReason, register, handleReturn, takeResult, toIdentity, PURPOSES, CERT_TTL_MIN };
