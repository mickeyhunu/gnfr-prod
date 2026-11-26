// NHN KCP 본인확인 V2 거래등록/결과조회 데이터 암복호화 (PBKDF2 + AES-256-CBC)
// 키(ENC_KEY)는 .env 로만 받음. 이 파일에는 비밀값이 없음.
// KCP 공식 배포 파일이 아니라 KCP 샘플 방식을 옮긴 구현이라, 운영에서 거래등록(res_cd 0000)과 실제 인증 1회로 확인함
// KCP 가 준 라이브러리로 바꾸려면 .env 의 KCP_CRYPTO_MODULE 에 그 파일 경로를 적으면 이 파일 대신 그걸 씀
const crypto = require('crypto');

const AES_BLOCK_SIZE = 16;
const PBKDF2_ITERATIONS = 10000;
const KEY_LENGTH_BYTES = 32;
const DIGEST = 'sha256';
const CIPHER = 'aes-256-cbc';

function deriveKey(source, salt) {
  return crypto.pbkdf2Sync(Buffer.from(String(source || ''), 'utf8'), salt, PBKDF2_ITERATIONS, KEY_LENGTH_BYTES, DIGEST);
}

function applyPkcs7Padding(source) {
  const remainder = source.length % AES_BLOCK_SIZE;
  const paddingLength = remainder === 0 ? AES_BLOCK_SIZE : AES_BLOCK_SIZE - remainder;
  return Buffer.concat([source, Buffer.alloc(paddingLength, paddingLength)]);
}

function stripPkcs7Padding(source) {
  if (!source.length) return source;
  const paddingLength = source[source.length - 1];
  if (paddingLength < 1 || paddingLength > AES_BLOCK_SIZE || paddingLength > source.length) {
    throw new Error('KCP 복호화 데이터의 패딩이 올바르지 않습니다.');
  }
  return source.subarray(0, source.length - paddingLength);
}

function createKeyMaterial(encKey, siteCode, randomValue) {
  const key = deriveKey(encKey, randomValue);
  const iv = deriveKey(siteCode, randomValue).subarray(0, AES_BLOCK_SIZE);
  return { key, iv };
}

function encryptJson(payload, encKey, siteCode) {
  const jsonText = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const randomValue = crypto.randomBytes(AES_BLOCK_SIZE);
  const { key, iv } = createKeyMaterial(encKey, siteCode, randomValue);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(applyPkcs7Padding(Buffer.from(jsonText, 'utf8'))), cipher.final()]);
  return { enc_data: encrypted.toString('base64'), rv: randomValue.toString('base64') };
}

function decryptJson(encCertData, rv, encKey, siteCode) {
  const randomValue = Buffer.from(String(rv || ''), 'base64');
  const { key, iv } = createKeyMaterial(encKey, siteCode, randomValue);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(String(encCertData || ''), 'base64')), decipher.final()]);
  return JSON.parse(stripPkcs7Padding(decrypted).toString('utf8'));
}

module.exports = { encryptJson, decryptJson };
