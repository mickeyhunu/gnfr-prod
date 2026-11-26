// 실시간강남 지도 보기: 카카오맵에 가게 위치를 이모지 핀으로 표시하고, 누르면 아래에 가게 카드를 띄움
(function () {
  var box = document.getElementById('store-map');
  if (!box) return;
  var status = document.querySelector('[data-map-status]');
  var card = document.querySelector('[data-map-card]');
  var stores = [];
  try { stores = JSON.parse(box.getAttribute('data-stores') || '[]'); } catch (e) { stores = []; }

  var say = function (text) {
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
  };

  if (!window.kakao || !window.kakao.maps) {
    say('지도를 불러오지 못했어요. 잠시 후 다시 열어주세요.');
    return;
  }

  // 주소로 찾은 위치는 이 브라우저에 잠깐 기억해서 다음에 바로 그림
  var CACHE_KEY = 'storeGeo:v1';
  var cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
  var saveCache = function () {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 저장 못 해도 지도는 그대로 */ }
  };

  kakao.maps.load(function () {
    var map = new kakao.maps.Map(box, { center: new kakao.maps.LatLng(37.4979, 127.0276), level: 6 });
    map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
    var geocoder = new kakao.maps.services.Geocoder();
    var places = new kakao.maps.services.Places();
    var bounds = new kakao.maps.LatLngBounds();
    var placed = 0;
    var missing = [];
    var pending = stores.length;
    var activePin = null;

    var fill = function (s) {
      var set = function (f, v) {
        var el = card.querySelector('[data-f="' + f + '"]');
        if (el) el.textContent = v;
      };
      set('emoji', s.emoji || '🏙️');
      set('place', s.dong || s.region);
      set('region', '[' + s.region + ']');
      set('name', s.name);
      set('category', s.category);
      set('address', s.address);
      set('hours', s.hours || '영업시간 정보 없음');
      card.href = '/live/' + s.id;
      card.hidden = false;
    };

    var addPin = function (s, lat, lng) {
      var pos = new kakao.maps.LatLng(lat, lng);
      var pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'map-pin';
      pin.setAttribute('aria-label', s.name + ' 가게 정보 보기');
      var emo = document.createElement('span');
      emo.className = 'map-pin-emoji';
      emo.textContent = s.emoji || '🏙️';
      var label = document.createElement('span');
      label.className = 'map-pin-name';
      label.textContent = s.name;
      pin.appendChild(emo);
      pin.appendChild(label);
      pin.addEventListener('click', function (e) {
        e.stopPropagation();
        if (activePin) activePin.classList.remove('on');
        pin.classList.add('on');
        activePin = pin;
        fill(s);
        map.panTo(pos);
      });
      new kakao.maps.CustomOverlay({ map: map, position: pos, content: pin, yAnchor: 1, clickable: true });
      bounds.extend(pos);
      placed += 1;
    };

    var done = function () {
      pending -= 1;
      if (pending > 0) return;
      saveCache();
      if (placed) map.setBounds(bounds, 40, 40, 40, 40);
      if (!placed) say('가게 위치를 찾지 못했어요.');
      else if (missing.length) say('위치를 찾지 못한 가게: ' + missing.join(', '));
      else say('');
    };

    // 1) DB 에 좌표가 있으면 그대로 2) 주소로 찾기 3) 안 되면 '지역 + 가게 이름'으로 장소 검색
    var locate = function (s) {
      if (s.lat && s.lng) { addPin(s, s.lat, s.lng); return done(); }
      var key = s.region + '|' + s.address + '|' + s.name;
      if (cache[key]) { addPin(s, cache[key][0], cache[key][1]); return done(); }
      geocoder.addressSearch('서울 ' + s.address, function (res, st) {
        if (st === kakao.maps.services.Status.OK && res[0]) {
          cache[key] = [Number(res[0].y), Number(res[0].x)];
          addPin(s, cache[key][0], cache[key][1]);
          return done();
        }
        places.keywordSearch(s.region + ' ' + s.name, function (r2, st2) {
          if (st2 === kakao.maps.services.Status.OK && r2[0]) {
            cache[key] = [Number(r2[0].y), Number(r2[0].x)];
            addPin(s, cache[key][0], cache[key][1]);
          } else {
            missing.push(s.name);
          }
          done();
        });
      });
    };

    if (!stores.length) { say(''); return; }
    stores.forEach(locate);

    // 빈 곳을 누르면 카드 닫기
    kakao.maps.event.addListener(map, 'click', function () {
      card.hidden = true;
      if (activePin) activePin.classList.remove('on');
      activePin = null;
    });
  });
})();
