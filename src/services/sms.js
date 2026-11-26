const crypto = require('crypto');
const config = require('../config');

// 개발용: 문자를 보내지 않고 서버 로그에 인증번호를 출력
async function sendConsole(to, text) {
  console.log(`[SMS 개발모드] ${to.slice(0, 3)}****${to.slice(-4)} → ${text}`);
}

// 솔라피(SOLAPI) 문자 발송
// 문서: https://developers.solapi.com  (실제 운영 전 최신 문서와 한 번 대조해주세요)
async function sendSolapi(to, text) {
  const { solapiKey, solapiSecret, from } = config.sms;
  if (!solapiKey || !solapiSecret || !from) {
    throw new Error('SOLAPI_API_KEY, SOLAPI_API_SECRET, SMS_FROM 을 .env 에 설정하세요.');
  }
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', solapiSecret).update(date + salt).digest('hex');

  const res = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${solapiKey}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ message: { to, from, text } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`문자 발송 실패 (${res.status}): ${body.slice(0, 200)}`);
  }
}

async function sendSms(to, text) {
  if (config.sms.provider === 'solapi') return sendSolapi(to, text);
  return sendConsole(to, text);
}

module.exports = { sendSms };
