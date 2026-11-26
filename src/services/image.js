// 올린 이미지를 webp 로 바꿈
//   - 휴대폰 사진의 회전 정보(EXIF)를 반영해 바로 세움
//   - 위치(GPS) 같은 사진 정보는 지움 (sharp 는 기본으로 메타데이터를 남기지 않음)
//   - 너무 큰 사진은 가로 MAX_WIDTH 로 줄임 (작은 사진은 키우지 않음)
const sharp = require('sharp');

const MAX_WIDTH = 1600;
const QUALITY = 82;
const MAX_INPUT_PIXELS = 50 * 1000 * 1000; // 이보다 큰 이미지는 거부 (압축 폭탄 방지)

// buf → webp Buffer. 이미지가 아니거나 읽을 수 없으면 null
async function toWebp(buf) {
  try {
    return await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
  } catch (_) {
    return null;
  }
}

module.exports = { toWebp, MAX_WIDTH };
