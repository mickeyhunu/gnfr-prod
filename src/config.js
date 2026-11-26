const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// .env 를 읽고, 내 컴퓨터(로컬)에 .env.local 이 있으면 그 값이 우선 (운영 서버에는 .env.local 을 두지 않음)
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const LOCAL_ENV = path.join(ROOT, '.env.local');
const usingLocalEnv = fs.existsSync(LOCAL_ENV);
if (usingLocalEnv) dotenv.config({ path: LOCAL_ENV, override: true });

function required(name) {
  const v = process.env[name];
  if (!v || v.startsWith('change-me')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`.env 의 ${name} 값을 설정하세요.`);
    }
    console.warn(`[경고] .env 의 ${name} 값이 기본값입니다. 운영 전에 꼭 바꾸세요.`);
  }
  return v || 'dev-only-insecure-value';
}

const isProd = process.env.NODE_ENV === 'production';

const env = (name) => (process.env[name] || '').trim();

function dbConfig() {
  const host = env('DB_HOST');
  // 운영(.env.local 없이 .env 만)인데 DB_HOST 가 비면 로컬 DB 로 몰래 붙지 않게 멈춤
  if (!host && !usingLocalEnv && isProd) throw new Error('.env 의 DB_HOST 에 RDS 엔드포인트를 적으세요.');
  const isRds = /\.rds\.amazonaws\.com$/i.test(host);
  const sslFlag = env('DB_SSL').toLowerCase();
  const ssl = sslFlag === 'false' ? false : sslFlag === 'true' || isRds;
  return {
    host: host || '127.0.0.1',
    port: Number(env('DB_PORT') || 3306),
    user: env('DB_USER') || 'root',
    password: process.env.DB_PASSWORD || '',
    database: env('DB_NAME') || 'gangnam_forest',
    // RDS: AWS RDS 인증서 묶음(mysql2 내장 'Amazon RDS' 프로필)으로 TLS 접속
    ...(ssl ? { ssl: 'Amazon RDS' } : {}),
  };
}

module.exports = {
  isProd,
  usingLocalEnv,
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  // 카카오맵 JavaScript 키 (실시간강남 지도 보기). 비어 있으면 지도 대신 안내 문구
  kakaoJsKey: (process.env.KAKAO_JAVASCRIPT_KEY || '').trim(),
  // DB: 내 컴퓨터는 .env.local 의 로컬 MySQL, 운영(.env.local 없음)은 .env 의 AWS RDS
  db: dbConfig(),
  sessionSecret: required('SESSION_SECRET'),
  phonePepper: required('PHONE_PEPPER'),
  // true 이면 회원가입 때 인증번호 확인을 건너뜀 (임시). 실제 운영 전에는 false 로
  skipPhoneAuth: process.env.SKIP_PHONE_AUTH === 'true',
  // NHN KCP 휴대폰 본인확인 (V2). 다섯 값이 모두 있어야 켜짐 → 켜지면 가입·비밀번호 찾기·번호 변경을 KCP 본인확인으로 함
  kcp: {
    siteCd: (process.env.KCP_SITE_CODE || '').trim(),
    encKey: (process.env.KCP_ENC_KEY || '').trim(),
    returnUrl: (process.env.KCP_RETURN_URL || '').trim(),
    production: (process.env.KCP_CERT_ENV || '').trim().toLowerCase() === 'production',
    // 암복호화 라이브러리 경로. 비우면 src/services/kcp-crypto.js 를 씀 (KCP 가 준 파일로 바꿀 때만 적음)
    cryptoModule: (process.env.KCP_CRYPTO_MODULE || '').trim(),
    // 보통 비워둠 (KCP_CERT_ENV 로 운영/테스트 서버를 고름). 연동 시험용 가짜 서버 주소를 넣을 때만 씀
    apiHost: (process.env.KCP_API_HOST || '').trim().replace(/\/+$/, ''),
  },
  // 이미지 저장소 (AWS S3 공개 버킷). 로컬은 .env.local 의 gnfr-public-dev, 운영은 .env 의 gnfr-public-prod
  //   올린 이미지는 모두 webp 로 바꿔 ad-images/ 아래에 저장하고, 화면에서도 S3 주소로 보여줌
  //   접근 키는 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (EC2 에 IAM 역할을 붙였으면 비워둠)
  s3: {
    region: env('AWS_REGION') || 'ap-northeast-2',
    bucket: env('S3_BUCKET_NAME'),
    // 이미지 주소 앞부분. 비우면 https://<버킷>.s3.<리전>.amazonaws.com (CloudFront 를 붙이면 그 주소로)
    publicBaseUrl: env('S3_PUBLIC_BASE_URL').replace(/\/+$/, ''),
    // true 이면 서버 시작할 때 버킷이 없으면 만들고 이미지 읽기를 공개함 (IAM 에 버킷 만들기·정책 권한이 있어야 함)
    autoCreateBucket: env('S3_AUTO_CREATE_BUCKET').toLowerCase() === 'true',
  },
  // 추천인 코드: 가입할 때 꼭 넣어야 함. 회원마다 자기 추천인 코드를 받음
  // 추천인 코드가 없는 예전 회원은 마이페이지에서 등록하기 전까지 읽기만 가능
  referral: {
    // 마스터 코드: 오픈 초기에 누구나 가입할 수 있게 쓰는 공용 코드
    //   MASTER_REFERRAL_CODE 를 비워두면(MASTER_REFERRAL_CODE=) 마스터 코드로는 가입할 수 없고 회원 추천인 코드로만 가입
    //   줄 자체가 없으면 'MASTER'. 이미 마스터 코드로 가입한 회원은 그대로 유지
    masterCode: process.env.MASTER_REFERRAL_CODE === undefined ? 'MASTER' : process.env.MASTER_REFERRAL_CODE.trim().toUpperCase(),
  },
  sms: {
    provider: process.env.SMS_PROVIDER || 'console',
    solapiKey: process.env.SOLAPI_API_KEY || '',
    solapiSecret: process.env.SOLAPI_API_SECRET || '',
    from: process.env.SMS_FROM || '',
  },
  boards: ['자유의숲', '후기의숲', '썰의숲', '질문의숲'],
  // 같은 성별만 볼 수 있는 게시판: 게시판 이름 → users.gender 값
  genderBoards: { '여성의숲': 'F', '남성의숲': 'M' },
  // 계급도: 활동 점수가 min 이상이면 그 계급 (위에서부터 낮은 계급). 관리자는 항상 adminName
  // 계급 아이콘: public/images/ranks/ 에 lv1.png ~ lv9.png, admin.png 를 넣으면 자동으로 표시
  //   (png·webp·gif·svg 아무거나. 파일이 없으면 글자만 나옴, 서버 재시작 필요 없음)
  ranks: {
    points: { post: 5, comment: 1, up: 2 }, // 글 1개 5점, 댓글 1개 1점, 받은 추천 1개 2점
    tiers: [
      { name: '씨앗', min: 0 },
      { name: '새싹', min: 30 },
      { name: '떡잎', min: 100 },
      { name: '잎사귀', min: 250 },
      { name: '묘목', min: 500 },
      { name: '어린나무', min: 1000 },
      { name: '큰나무', min: 2000 },
      { name: '공원', min: 4000 },
      { name: '숲', min: 8000 },
    ],
    adminName: '숲지기',
  },
  hotThreshold: Number(process.env.HOT_THRESHOLD || 5), // 추천 - 반대 가 이 값 이상이면 핫
  // 올라온 지 이 시간(시간 단위) 안의 글은 목록에 N 표시
  newHours: Number(process.env.NEW_HOURS || 24),
  reportHideThreshold: Number(process.env.REPORT_HIDE_THRESHOLD || 5),
  // 한 사람이 하루(한국 시간 0시 기준)에 할 수 있는 신고 횟수. 글·댓글 신고 합산, 운영자는 제한 없음
  reportDailyLimit: Number(process.env.REPORT_DAILY_LIMIT || 5),
  flagWords: (process.env.FLAG_WORDS || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),
  // 사업자 광고
  ads: {
    // 공공데이터포털 '국세청_사업자등록정보 진위확인 및 상태조회 서비스' 인증키 (Encoding/Decoding 키 둘 다 됨)
    ntsServiceKey: (process.env.NTS_BUSINESS_API_SERVICE_KEY || '').trim(),
    ntsApiBase: process.env.NTS_API_BASE || 'https://api.odcloud.kr/api/nts-businessman/v1',
    recheckHours: Number(process.env.AD_RECHECK_HOURS || 24), // 게시 중인 광고의 사업자 상태를 다시 확인하는 간격
    perUserLimit: 3, // 한 회원이 동시에 걸 수 있는 광고 수 (심사 중 + 게시 중)
    licenseMaxBytes: 5 * 1024 * 1024,
    // 업종: license 가 있으면 그 서류(영업허가증·신고증 등)를 첨부해야 신청 가능
    // 19세 이상 강남 화류계 중심 커뮤니티에 맞는 업종만 받음.
    // 성매매 알선 업소, 대부·선불금, 구인·직업소개 광고는 받지 않음 (adBanned 참고)
    categories: [
      { key: 'room', name: '룸·유흥주점', license: '유흥주점 영업허가증' },
      { key: 'bar', name: '바·클럽·라운지', license: '유흥주점 영업허가증 또는 영업신고증(일반음식점)' },
      { key: 'hair', name: '헤어·메이크업', license: '미용업 영업신고증' },
      { key: 'clinic', name: '성형·시술', license: '의료기관 개설신고증(허가증) 또는 미용업 영업신고증' },
      { key: 'fashion', name: '홀복·패션', license: null },
      { key: 'food', name: '포차·술집·식당', license: '영업신고증(일반·휴게음식점)' },
      { key: 'house', name: '원룸·숙소·부동산', license: '중개사무소 등록증 또는 숙박업 신고증' },
      { key: 'driver', name: '대리운전', license: null },
      { key: 'consult', name: '세무·노무·법률', license: '세무사·노무사·변호사 등록증' },
      { key: 'etc', name: '기타', license: null },
    ],
    // 신청 화면과 목록에 보여주는 받지 않는 광고
    banned: [
      '성매매를 알선하거나 암시하는 업소·구인',
      '대출·사채, 선불금(마이킹)을 조건으로 거는 구인',
      '직업소개소·스카우트를 통한 구인 (업체가 직접 뽑는 구인만 받아요)',
      '19세 미만을 뽑거나 급여를 적지 않은 구인',
      '불법 촬영물·약물 등 불법 상품',
    ],
    // 광고·구인 글에 들어가면 신청을 막는 말 (성매매 암시, 선불금, 미성년 등)
    blockedWords: ['선불', '마이킹', '미성년', '고딩', '조건만남', '스폰', '페이백', '대출', '사채'],
    // 구인: 시급으로 적을 때 이 금액 이상이어야 함 (2026년 최저임금, 해마다 바꿔주세요)
    minWageHourly: Number(process.env.MIN_WAGE_HOURLY || 10320),
    payTypes: { hour: '시급', day: '일급', month: '월급', case: '건당' },
    employmentTypes: { employ: '고용', dispatch: '파견', contract: '도급', delegate: '위임' },
    // 광고 본문 이미지: 한 광고에 몇 장까지
    bodyImageMax: 20,
  },
  pageSize: 20,
  // 고객센터 1:1 문의
  inquiry: {
    categories: {
      account: '계정·로그인',
      referral: '추천인 코드',
      ad: '광고·구인',
      report: '신고·게시물',
      bug: '오류 제보',
      suggest: '건의',
      etc: '기타',
    },
    openLimit: 5, // 답변을 기다리는 문의는 한 사람당 이 개수까지
    bodyMax: 2000,
  },
  reportReasons: {
    target: '특정인 저격·신상 노출',
    abuse: '욕설·비하',
    ad: '광고·홍보',
    illegal: '불법 내용',
    etc: '기타',
  },
};
