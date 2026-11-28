// 광고 작성: '24시간 영업'을 체크하면 여는·닫는 시간 고르기를 끔
(function () {
  'use strict';
  var box = document.querySelector('[data-hours]');
  var all = document.querySelector('[data-hours-24]');
  if (!box || !all) return;
  var sync = function () {
    box.querySelectorAll('select').forEach(function (s) { s.disabled = all.checked; });
  };
  all.addEventListener('change', sync);
  sync();
})();
