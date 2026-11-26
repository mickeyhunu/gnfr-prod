// 실시간강남 가게 기본 데이터 넣기 (여러 번 실행해도 됨)
//   npm run seed-stores
// 같은 id 가 이미 있으면 지역·이름·주소·이모지·업종만 이 목록대로 덮어쓰고,
// 관리자가 따로 채운 영업시간·소개·전화번호는 건드리지 않음
const db = require('../src/db');
const { applySchema } = require('../src/schema');

// [id, 지역, 이름, 주소, 이모지, 업종]
const STORES = [
  [21, '잠실', '갤럭시', '석촌호수로 216', '🌊', '가라오케'],
  [101, '강남', '공공칠', '논현로 645', '🕶️', '쩜오'],
  [102, '강남', '구구단', '언주로 640', '🔢', '쩜오'],
  [103, '강남', '블렌딩', '테헤란로 111', '🍸', '쩜오'],
  [104, '강남', '세이렌', '삼성동 142-36', '🧜‍♀️', '쩜오'],
  [105, '강남', '인트로', '도산대로 205', '🎬', '쩜오'],
  [106, '강남', '어나더', '강남대로 354', '🪐', '쩜오'],
  [107, '강남', '타이밍', '삼성동 143-35', '⏰', '쩜오'],
  [108, '강남', '도깨비', '역삼동 824-7', '👹', '쩜오'],
  [109, '강남', '임팩트', '역삼동 736-17', '💥', '쩜오'],
  [110, '강남', '피카소', '역삼동 677-22', '🎨', '쩜오'],
  [7, '강남', '쎄미', '역삼동 677-20', '✨', '퍼블릭'],
  [1, '강남', '달토', '역삼동 604-11', '🐰', '하이퍼블릭'],
  [2, '강남', '엘리트', '대치동 890-38', '🎆', '하이퍼블릭'],
  [3, '강남', '시그넷', '강남대로 588', '💠', '하이퍼블릭'],
  [4, '강남', '유앤미', '잠원동 23-8', '💟', '하이퍼블릭'],
  [5, '강남', '도파민', '삼성동 142-29', '🌌', '하이퍼블릭'],
  [6, '강남', '제우스', '역삼동 736-35', '🔱', '하이퍼블릭'],
];

// 주소가 'OO동 123-4' 꼴이면 동 이름을 뽑아둠 (도로명 주소면 비워둠)
const dongOf = (address) => (address.match(/^(\S+동)\s/) || [])[1] || null;

(async () => {
  try {
    await applySchema(db.pool);
    for (const [id, region, name, address, emoji, category] of STORES) {
      const addr = address.trim();
      await db.query(
        `INSERT INTO stores (id, region, dong, name, address, emoji, category) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE region = VALUES(region), dong = COALESCE(dong, VALUES(dong)), name = VALUES(name),
           address = VALUES(address), emoji = VALUES(emoji), category = VALUES(category)`,
        [id, region, dongOf(addr), name, addr, emoji, category]
      );
    }
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM stores');
    console.log(`가게 ${STORES.length}곳을 넣었어요. 지금 stores 테이블: ${n}곳`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
