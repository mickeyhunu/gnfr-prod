// 게시판 읽기·쓰기 권한
// 여성의숲은 성별이 F, 남성의숲은 M 으로 확인된 회원만 볼 수 있음 (운영자는 둘 다).
// 성별(users.gender)은 본인인증(PASS) 결과로 저장됨 → services/identity.js
const config = require('../config');

const genderBoardNames = Object.keys(config.genderBoards);

function isGenderBoard(board) {
  return genderBoardNames.includes(board);
}

function canReadBoard(user, board) {
  if (!isGenderBoard(board)) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.gender === config.genderBoards[board];
}

// 이 회원이 볼 수 없는 게시판 목록
function hiddenBoards(user) {
  return genderBoardNames.filter((b) => !canReadBoard(user, b));
}

// 목록·검색 SQL 에 붙일 조건. col: 게시판 컬럼 이름
function boardFilter(user, col = 'board') {
  const hidden = hiddenBoards(user);
  if (!hidden.length) return { sql: '1=1', params: [] };
  return { sql: `${col} NOT IN (${hidden.map(() => '?').join(', ')})`, params: hidden };
}

// 글을 쓸 수 있는 게시판: 볼 수 있는 성별 게시판(맨 앞) + 공용 게시판
function writableBoards(user) {
  return genderBoardNames.filter((b) => canReadBoard(user, b)).concat(config.boards);
}

module.exports = { genderBoardNames, isGenderBoard, canReadBoard, hiddenBoards, boardFilter, writableBoards };
