// 광고 등록 2단계: 대표 이미지 고르기 → 바로 올려서 작성 중 광고에 저장, 미리보기 바꿈
(function () {
  var box = document.querySelector('[data-ad-cover]');
  if (!box) return;
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var img = box.querySelector('[data-cover-img]');
  var input = box.querySelector('[data-cover-input]');
  var pick = box.querySelector('[data-cover-pick]');
  var remove = box.querySelector('[data-cover-remove]');
  var status = box.querySelector('[data-cover-status]');
  var busy = false;
  // 광고 수정 화면이면 ?edit=<id> (바꾼 사진은 수정 제출할 때 반영)
  var q = box.getAttribute('data-edit') ? '?edit=' + encodeURIComponent(box.getAttribute('data-edit')) : '';

  var say = function (msg, isError) {
    status.textContent = msg || '';
    status.classList.toggle('is-error', !!isError);
  };
  var setCover = function (url, isSet) {
    img.src = url;
    box.classList.toggle('is-default', !isSet);
    remove.hidden = !isSet;
    pick.textContent = isSet ? '사진 바꾸기' : '사진 고르기';
  };
  var send = function (path, body, doneMsg, isSet) {
    if (busy) return;
    busy = true;
    pick.disabled = remove.disabled = true;
    fetch(path, { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j.ok) { say(j.message || '사진을 올리지 못했어요.', true); return; }
        setCover(j.url, isSet);
        say(doneMsg);
      })
      .catch(function () { say('사진을 올리지 못했어요. 잠시 후 다시 해주세요.', true); })
      .then(function () { busy = false; pick.disabled = remove.disabled = false; });
  };

  pick.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    var file = input.files[0];
    input.value = '';
    if (!file) return;
    var fd = new FormData();
    fd.append('image', file);
    say('사진을 올리는 중이에요…');
    send('/ads/cover' + q, fd, '대표 이미지를 넣었어요.', true);
  });
  remove.addEventListener('click', function () {
    send('/ads/cover/remove' + q, null, '기본 이미지로 바꿨어요.', false);
  });
})();
