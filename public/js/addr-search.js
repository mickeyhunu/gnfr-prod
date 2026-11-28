// 광고 작성: 카카오(다음) 우편번호 서비스로 주소 고르기
//   주소 검색을 처음 누를 때 SDK 를 불러와 화면 위 창(레이어) 안에 띄움
//   고르면 기본 주소(도로명 또는 지번) + 법정동 이름(dong, 목록 제목 앞 [논현동])을 채움
(function () {
  'use strict';
  var box = document.querySelector('[data-addr]');
  if (!box) return;
  var SDK = 'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
  var input = box.querySelector('[data-addr-input]');
  var dong = box.querySelector('[data-addr-dong]');
  var detail = box.querySelector('[data-addr-detail]');
  var openBtn = box.querySelector('[data-addr-open]');
  var layer = box.querySelector('[data-addr-layer]');
  var embed = box.querySelector('[data-addr-embed]');
  var closeBtn = box.querySelector('[data-addr-close]');
  var label = box.querySelector('[data-addr-label]');
  var loading = null;

  // 구인광고 = 근무 주소, 기타광고 = 업장 주소
  var form = box.closest('form');
  var syncLabel = function () {
    var k = form && form.querySelector('input[name="kind"]:checked');
    label.textContent = k && k.value === 'ad' ? '업장 주소' : '근무 주소';
  };
  if (form) form.addEventListener('change', function (e) { if (e.target.name === 'kind') syncLabel(); });

  var loadSdk = function () {
    if (window.daum && window.daum.Postcode) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SDK;
      s.onload = resolve;
      s.onerror = function () { loading = null; reject(new Error('sdk')); };
      document.head.appendChild(s);
    });
    return loading;
  };

  var close = function () {
    layer.hidden = true;
    document.body.classList.remove('addr-open');
    embed.innerHTML = '';
    openBtn.focus();
  };

  var open = function () {
    openBtn.disabled = true;
    loadSdk().then(function () {
      layer.hidden = false;
      document.body.classList.add('addr-open');
      new window.daum.Postcode({
        width: '100%',
        height: '100%',
        oncomplete: function (data) {
          var road = data.userSelectedType !== 'J';
          var addr = road ? data.roadAddress : data.jibunAddress || data.autoJibunAddress;
          // 도로명이면 (법정동, 아파트 이름)을 붙여서 알아보기 쉽게
          var extra = [];
          if (road && data.bname && /[동로가]$/.test(data.bname)) extra.push(data.bname);
          if (road && data.buildingName && data.apartment === 'Y') extra.push(data.buildingName);
          input.value = addr + (extra.length ? ' (' + extra.join(', ') + ')' : '');
          dong.value = data.bname || '';
          input.removeAttribute('aria-invalid');
          close();
          detail.focus();
        },
      }).embed(embed, { autoClose: false });
    }).catch(function () {
      alert('주소 검색을 불러오지 못했어요. 잠시 후 다시 해주세요.');
    }).then(function () { openBtn.disabled = false; });
  };

  openBtn.addEventListener('click', open);
  input.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  layer.addEventListener('click', function (e) { if (e.target === layer) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !layer.hidden) close(); });
})();
