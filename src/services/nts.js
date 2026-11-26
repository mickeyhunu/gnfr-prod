// 국세청 사업자등록정보 진위확인·상태조회 (공공데이터포털 odcloud API)
//   validate: 사업자번호 + 대표자 성명 + 개업일자가 국세청 정보와 맞는지 + 지금 상태
//   status  : 사업자번호만으로 지금 상태 (계속사업자 01 / 휴업자 02 / 폐업자 03)
const config = require('../config');

const TIMEOUT_MS = 8000;

// 사업자등록번호 10자리 검증번호 확인
function isValidBizNo(bNo) {
  if (!/^\d{10}$/.test(bNo)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(bNo[i]) * w[i];
  sum += Math.floor((Number(bNo[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(bNo[9]);
}

function isConfigured() {
  return Boolean(config.ads.ntsServiceKey);
}

// 포털의 Encoding 키(%2B 등이 들어 있음)는 그대로, Decoding 키는 인코딩해서 붙임
function keyParam() {
  const k = config.ads.ntsServiceKey;
  return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k);
}

async function call(path, body) {
  if (!isConfigured()) {
    const e = new Error('NTS_BUSINESS_API_SERVICE_KEY 가 비어 있어요.');
    e.code = 'NTS_NO_KEY';
    throw e;
  }
  const res = await fetch(`${config.ads.ntsApiBase}/${path}?serviceKey=${keyParam()}&returnType=JSON`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 인증키 오류 등은 XML/텍스트로 옴 */
  }
  if (!res.ok || !json || json.status_code !== 'OK') {
    const e = new Error(`국세청 API 오류 (HTTP ${res.status}): ${text.slice(0, 200)}`);
    e.code = 'NTS_API';
    throw e;
  }
  return json;
}

function pickStatus(s) {
  if (!s) return { code: null, name: null, taxType: null, endDate: null };
  return {
    code: s.b_stt_cd || null, // '01' 계속, '02' 휴업, '03' 폐업, '' 등록 안 됨
    name: s.b_stt || null,
    taxType: s.tax_type || null,
    endDate: s.end_dt || null,
  };
}

// 진위확인. openDate 는 'YYYY-MM-DD'. → { valid: boolean, status: {code,name,taxType,endDate} }
async function validate({ bNo, ownerName, openDate, businessName }) {
  const json = await call('validate', {
    businesses: [
      {
        b_no: bNo,
        start_dt: openDate.replace(/-/g, ''),
        p_nm: ownerName,
        p_nm2: '',
        b_nm: businessName || '',
        corp_no: '',
        b_sector: '',
        b_type: '',
        b_adr: '',
      },
    ],
  });
  const d = (json.data || [])[0] || {};
  return { valid: d.valid === '01', status: pickStatus(d.status) };
}

// 상태조회 (한 번에 100개까지). → Map(bNo → status)
async function statusMany(bNos) {
  const out = new Map();
  for (let i = 0; i < bNos.length; i += 100) {
    const json = await call('status', { b_no: bNos.slice(i, i + 100) });
    for (const d of json.data || []) out.set(d.b_no, pickStatus(d));
  }
  return out;
}

const ACTIVE = '01';

module.exports = { isValidBizNo, isConfigured, validate, statusMany, ACTIVE };
