// 광고 상세 '위치정보': 카카오맵에 업체 주소 핀 하나
//   주소 → 좌표는 카카오 지도 SDK 의 services.Geocoder (주소로 못 찾으면 키워드 검색으로 한 번 더)
(function () {
  'use strict';
  var box = document.querySelector('[data-ad-map]');
  if (!box || !window.kakao || !kakao.maps) return;
  var status = box.querySelector('[data-ad-map-status]');
  var address = box.getAttribute('data-address') || '';
  var fail = function () {
    box.classList.add('is-empty');
    if (status) status.textContent = '지도에서 주소를 찾지 못했어요.';
  };

  kakao.maps.load(function () {
    var show = function (lat, lng) {
      if (status) status.remove();
      var pos = new kakao.maps.LatLng(lat, lng);
      var map = new kakao.maps.Map(box, { center: pos, level: 3 });
      map.setZoomable(false); // 페이지를 스크롤하다 지도가 확대되지 않게 (확대 버튼도 두지 않음)
      new kakao.maps.Marker({ map: map, position: pos });
      // 화면 크기가 바뀌어도 핀이 가운데에
      window.addEventListener('resize', function () { map.relayout(); map.setCenter(pos); });
    };
    var geocoder = new kakao.maps.services.Geocoder();
    geocoder.addressSearch(address, function (res, st) {
      if (st === kakao.maps.services.Status.OK && res[0]) return show(Number(res[0].y), Number(res[0].x));
      new kakao.maps.services.Places().keywordSearch(address, function (r2, st2) {
        if (st2 === kakao.maps.services.Status.OK && r2[0]) return show(Number(r2[0].y), Number(r2[0].x));
        fail();
      });
    });
  });
})();
