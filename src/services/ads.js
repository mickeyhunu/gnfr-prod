// 광고: 첨부 서류(사업자등록증·영업허가증·기타) 저장, 사업자 상태 정기 재확인
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const nts = require('./nts');
const storage = require('./storage');
const image = require('./image');

// 공개 폴더(public) 밖. 운영자만 /admin/ads/files/:id 로 볼 수 있음
const LICENSE_DIR = path.join(__dirname, '..', '..', 'uploads', 'licenses');

// 광고 본문 이미지: S3 버킷에 저장. S3 설정(S3_BUCKET_NAME)이 없을 때만 여기 (공개: /ad-img/파일이름)
const IMAGE_DIR = path.join(__dirname, '..', '..', 'uploads', 'ad-images');

const CATEGORY = new Map(config.ads.categories.map((c) => [c.key, c]));

// 파일 앞부분으로 형식 확인 (확장자·브라우저가 보낸 형식은 믿지 않음)
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.toString('ascii', 0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

async function saveFile(buf) {
  const kind = sniff(buf);
  if (!kind) return null;
  await fs.promises.mkdir(LICENSE_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  await fs.promises.writeFile(path.join(LICENSE_DIR, name), buf, { flag: 'wx' });
  return { file: name, mime: kind.mime };
}

// 본문 이미지 저장 (사진만, webp 로 바꿔서) → { url } 또는 null
//   url 은 에디터가 바로 보여줄 주소 (S3). 저장할 때 richtext.clean 이 /ad-img/<이름> 으로 바꿔 둠
async function saveImage(buf) {
  const kind = sniff(buf);
  if (!kind || kind.ext === 'pdf') return null;
  const webp = await image.toWebp(buf);
  if (!webp) return null;
  const name = `${crypto.randomBytes(16).toString('hex')}.webp`;
  if (storage.isReady()) return { url: await storage.putImage(name, webp, 'image/webp') };
  await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(IMAGE_DIR, name), webp, { flag: 'wx' });
  return { url: `/ad-img/${name}` };
}

function filePath(file) {
  if (!/^[0-9a-f]{32}\.(jpg|png|webp|pdf)$/.test(file || '')) return null;
  return path.join(LICENSE_DIR, file);
}

async function removeFile(file) {
  const p = filePath(file);
  if (p) await fs.promises.unlink(p).catch(() => {});
}

// 국세청 상태를 광고에 기록
function saveStatus(conn, where, params, s) {
  return conn.query(
    `UPDATE ads SET nts_status = ?, nts_status_cd = ?, nts_tax_type = ?, nts_checked_at = UTC_TIMESTAMP() WHERE ${where}`,
    [s.name, s.code || null, s.taxType ? s.taxType.slice(0, 100) : null, ...params]
  );
}

// 게시 중인 광고의 사업자 상태 재확인 → 계속사업자가 아니면 게시 중단
async function recheckApproved() {
  if (!nts.isConfigured()) return { checked: 0, suspended: 0 };
  const rows = await db.query(`SELECT DISTINCT b_no FROM ads WHERE status = 'approved'`);
  if (!rows.length) return { checked: 0, suspended: 0 };
  const map = await nts.statusMany(rows.map((r) => r.b_no));
  let suspended = 0;
  for (const [bNo, s] of map) {
    await saveStatus(db.pool, `b_no = ? AND status = 'approved'`, [bNo], s);
    if (s.code !== nts.ACTIVE) {
      const note = `국세청 사업자 상태가 '${s.name || '확인 불가'}'(이)라 게시가 중단됐어요.`;
      const ids = (await db.query(`SELECT id FROM ads WHERE b_no = ? AND status = 'approved'`, [bNo])).map((x) => x.id);
      for (const id of ids) {
        const [r] = await db.pool.query(`UPDATE ads SET status = 'suspended', status_note = ? WHERE id = ? AND status = 'approved'`, [note, id]);
        if (r.affectedRows) {
          suspended++;
          await require('./notify').adStatus(id, 'suspended', note);
        }
      }
    }
  }
  return { checked: map.size, suspended };
}

// 1단계만 하고 하루 넘게 둔 작성 중 광고와 그 서류 지우기
async function cleanupDrafts() {
  const files = await db.query(
    `SELECT f.file FROM ad_files f JOIN ads a ON a.id = f.ad_id WHERE a.status = 'draft' AND a.created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY`
  );
  for (const f of files) await removeFile(f.file);
  const [r] = await db.pool.query(`DELETE FROM ads WHERE status = 'draft' AND created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY`);
  return r.affectedRows;
}

// 작성 중 광고 하나 지우기 (서류 파일 포함)
async function removeDraft(id, userId) {
  const files = await db.query(
    `SELECT f.file FROM ad_files f JOIN ads a ON a.id = f.ad_id WHERE a.id = ? AND a.user_id = ? AND a.status = 'draft'`,
    [id, userId]
  );
  for (const f of files) await removeFile(f.file);
  await db.query(`DELETE FROM ads WHERE id = ? AND user_id = ? AND status = 'draft'`, [id, userId]);
}

let timer = null;
const RETRY_MIN = 30; // 국세청 API 가 잠깐 안 될 때 다시 해보는 간격
const RETRY_MAX = 3;
function startRecheckJob() {
  if (timer || !(config.ads.recheckHours > 0)) return;
  // 재확인이 실패해도 광고는 그대로 둠 (게시 중단은 국세청이 계속사업자가 아니라고 답했을 때만)
  const recheck = (attempt) =>
    recheckApproved()
      .then((r) => r.suspended && console.log(`[광고] 사업자 상태 재확인: ${r.checked}건 확인, ${r.suspended}건 게시 중단`))
      .catch((err) => {
        const retry = attempt < RETRY_MAX;
        console.error(`[광고] 사업자 상태 재확인 실패${retry ? ` (${RETRY_MIN}분 뒤 다시 시도 ${attempt}/${RETRY_MAX})` : ''}: ${err.message}`);
        if (retry) setTimeout(() => recheck(attempt + 1), RETRY_MIN * 60 * 1000).unref();
      });
  const run = () =>
    cleanupDrafts()
      .catch((err) => console.error('[광고] 작성 중 광고 정리 실패:', err.message))
      .then(() => recheck(1));
  setTimeout(run, 60 * 1000).unref(); // 서버 켜고 1분 뒤 한 번
  timer = setInterval(run, config.ads.recheckHours * 3600 * 1000);
  timer.unref();
}

const DOC_LABEL = { biz_cert: '사업자등록증', license: '영업허가증·신고증', etc: '기타 서류' };

// 광고에 서류 기록 (files: [{ kind, buf }]) → 저장한 파일 이름들. 실패하면 저장한 파일을 지우고 오류
async function attachFiles(conn, adId, files) {
  const saved = [];
  try {
    for (const f of files) {
      const s = await saveFile(f.buf);
      if (!s) throw new Error('지원하지 않는 파일 형식');
      saved.push(s.file);
      await conn.query('INSERT INTO ad_files (ad_id, kind, file, mime) VALUES (?, ?, ?, ?)', [adId, f.kind, s.file, s.mime]);
    }
    return saved;
  } catch (e) {
    for (const name of saved) await removeFile(name);
    throw e;
  }
}

module.exports = { IMAGE_DIR, CATEGORY, DOC_LABEL, sniff, saveFile, saveImage, filePath, removeFile, attachFiles, removeDraft, cleanupDrafts, saveStatus, recheckApproved, startRecheckJob };
