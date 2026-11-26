// 서버 디스크(uploads/ad-images)에 있는 예전 광고 이미지를 webp 로 바꿔 S3 버킷에 올리고,
// 광고 본문의 /ad-img/<이름>.jpg|png 를 /ad-img/<이름>.webp 로 고침
//   npm run migrate-images            → 실제로 옮김
//   npm run migrate-images -- --dry   → 무엇을 할지 보기만
// 올린 뒤에도 디스크 파일은 지우지 않음 (확인한 뒤 직접 지우세요)
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const storage = require('../src/services/storage');
const image = require('../src/services/image');
const { IMAGE_DIR } = require('../src/services/ads');

const DRY = process.argv.includes('--dry');
const NAME = /^([0-9a-f]{32})\.(jpg|png|webp)$/;

async function main() {
  if (!storage.isReady()) throw new Error('S3_BUCKET_NAME 이 비어 있어요. .env(로컬은 .env.local)를 확인하세요.');
  console.log(`버킷: ${config.s3.bucket} (${config.s3.region})${DRY ? ' · 보기만' : ''}`);
  if (!DRY) console.log(await storage.checkBucket());

  const files = fs.existsSync(IMAGE_DIR) ? fs.readdirSync(IMAGE_DIR).filter((f) => NAME.test(f)) : [];
  let uploaded = 0;
  for (const f of files) {
    const id = f.match(NAME)[1];
    if (DRY) {
      console.log(`  ${f} → ${storage.imageUrl(id + '.webp')}`);
      continue;
    }
    const webp = await image.toWebp(await fs.promises.readFile(path.join(IMAGE_DIR, f)));
    if (!webp) {
      console.warn(`  건너뜀 (이미지를 읽지 못함): ${f}`);
      continue;
    }
    await storage.putImage(id + '.webp', webp, 'image/webp');
    uploaded++;
    console.log(`  올림: ${f} → ${id}.webp`);
  }

  const rows = await db.query(`SELECT id, body_html FROM ads WHERE body_html REGEXP '/ad-img/[0-9a-f]{32}\\\\.(jpg|png)'`);
  for (const r of rows) {
    const html = r.body_html.replace(/\/ad-img\/([0-9a-f]{32})\.(jpg|png)/g, '/ad-img/$1.webp');
    if (!DRY) await db.query('UPDATE ads SET body_html = ? WHERE id = ?', [html, r.id]);
  }
  console.log(`이미지 ${DRY ? files.length + '개 올릴 예정' : uploaded + '개 올림'}, 광고 본문 ${rows.length}개 ${DRY ? '고칠 예정' : '고침'}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
  });
