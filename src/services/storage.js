// 이미지 저장소: AWS S3 공개 버킷 (로컬 gnfr-public-dev, 운영 gnfr-public-prod)
//   올리는 이미지는 image.js 에서 webp 로 바꾼 뒤 여기서 ad-images/<무작위>.webp 로 저장
//   사업자등록증 같은 서류는 공개 버킷에 넣지 않음 (services/ads.js 가 서버 디스크에 따로 보관)
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const config = require('../config');

const IMAGE_PREFIX = 'ad-images/';

let client = null;
function s3() {
  if (!client) client = new S3Client({ region: config.s3.region });
  return client;
}

function isReady() {
  return Boolean(config.s3.bucket);
}

// 이미지 주소 앞부분 (끝에 / 없음)
function publicBaseUrl() {
  if (config.s3.publicBaseUrl) return config.s3.publicBaseUrl;
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;
}

// CSP img-src 에 넣을 출처 (https://호스트)
function publicOrigin() {
  if (!isReady()) return null;
  try {
    return new URL(publicBaseUrl()).origin;
  } catch (_) {
    return null;
  }
}

function imageUrl(name) {
  return `${publicBaseUrl()}/${IMAGE_PREFIX}${name}`;
}

async function putImage(name, buf, mime) {
  await s3().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: IMAGE_PREFIX + name,
      Body: buf,
      ContentType: mime,
      // 파일 이름이 무작위라 내용이 바뀌지 않음 → 브라우저가 오래 저장해도 됨
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return imageUrl(name);
}

async function removeImage(name) {
  await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: IMAGE_PREFIX + name }));
}

// 버킷 연결 확인 (S3_AUTO_CREATE_BUCKET=true 이면 없을 때 만들고 이미지 읽기를 공개)
async function checkBucket() {
  const Bucket = config.s3.bucket;
  try {
    await s3().send(new HeadBucketCommand({ Bucket }));
    return `S3 버킷 ${Bucket} 연결됨`;
  } catch (err) {
    const status = err.$metadata && err.$metadata.httpStatusCode;
    if (status !== 404 || !config.s3.autoCreateBucket) {
      throw new Error(status === 404 ? `S3 버킷 ${Bucket} 이 없어요.` : status === 403 ? `S3 버킷 ${Bucket} 에 접근할 권한이 없어요.` : err.message);
    }
  }
  await s3().send(
    new CreateBucketCommand({
      Bucket,
      ...(config.s3.region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: config.s3.region } }),
    })
  );
  // ACL 로는 공개하지 않고, 버킷 정책으로 ad-images/ 읽기만 공개
  await s3().send(
    new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false },
    })
  );
  await s3().send(
    new PutBucketPolicyCommand({
      Bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Sid: 'PublicReadImages', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${Bucket}/${IMAGE_PREFIX}*` }],
      }),
    })
  );
  return `S3 버킷 ${Bucket} 을 새로 만들었어요`;
}

module.exports = { isReady, publicBaseUrl, publicOrigin, imageUrl, putImage, removeImage, checkBucket, IMAGE_PREFIX };
