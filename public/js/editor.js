// 광고 작성(2단계): 본문 에디터 + 구인광고/기타광고 전환
// 에디터가 동작하지 않는 환경에서는 아래 textarea 에 그냥 글을 쓰면 됨 (서버가 문단으로 바꿔 저장)
(function () {
  'use strict';

  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  // ── 구인광고 / 기타광고 전환 ─────────────────────────
  var form = document.querySelector('[data-ad-write]');
  if (form) {
    // 기타광고면 구인 조건(고용형태·급여·근무 주소 등)을 숨김
    var jobFields = form.querySelector('[data-job-fields]');
    var syncKind = function () {
      var picked = form.querySelector('input[name="kind"]:checked');
      jobFields.hidden = picked && picked.value === 'ad';
    };
    form.addEventListener('change', function (e) { if (e.target.name === 'kind') syncKind(); });
    syncKind();
  }

  // ── 에디터 ───────────────────────────────────────────
  var root = document.querySelector('[data-editor]');
  if (!root || typeof document.execCommand !== 'function') return;
  var area = root.querySelector('.editor-area');
  var textarea = root.querySelector('textarea');
  var bar = root.querySelector('.editor-toolbar');
  var status = root.querySelector('[data-editor-status]');
  var imageInput = root.querySelector('[data-image-input]');
  var imageMax = Number(root.getAttribute('data-image-max') || 20);

  var escapeHtml = function (t) {
    return t.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };

  // textarea 에 태그 없는 글이 있으면 문단으로 옮겨옴
  if (!area.innerHTML.trim() && textarea.value.trim()) {
    area.innerHTML = /<[a-z][\s\S]*>/i.test(textarea.value)
      ? textarea.value
      : textarea.value.split(/\n/).map(function (l) { return l.trim() ? '<p>' + escapeHtml(l) + '</p>' : ''; }).join('');
  }
  area.hidden = false;
  bar.hidden = false;
  textarea.hidden = true;
  textarea.removeAttribute('id'); // label 은 에디터(aria-labelledby)가 받음
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 지원 안 하는 브라우저 */ }

  var sync = function () {
    textarea.value = area.innerHTML;
    area.classList.toggle('is-empty', !area.textContent.trim() && !area.querySelector('img'));
  };

  // 툴바를 눌러도 선택한 글자가 풀리지 않게 선택 범위를 기억
  var saved = null;
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (sel.rangeCount && area.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
  });
  var restore = function () {
    area.focus();
    if (!saved) return;
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(saved);
  };

  var updateState = function () {
    bar.querySelectorAll('[data-cmd]').forEach(function (b) {
      var cmd = b.getAttribute('data-cmd');
      if (cmd === 'insertHorizontalRule') return;
      var on = false;
      try { on = document.queryCommandState(cmd); } catch (e) { /* 무시 */ }
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var at = currentAlign();
    bar.querySelectorAll('[data-align]').forEach(function (b) {
      b.setAttribute('aria-pressed', at && b.getAttribute('data-align') === at ? 'true' : 'false');
    });
  };

  bar.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-image')) { imageInput.click(); return; }
    restore();
    if (b.hasAttribute('data-cmd')) {
      document.execCommand(b.getAttribute('data-cmd'), false, null);
    } else if (b.hasAttribute('data-block')) {
      document.execCommand('formatBlock', false, '<' + b.getAttribute('data-block') + '>');
    } else if (b.hasAttribute('data-align')) {
      align(b.getAttribute('data-align'));
    } else if (b.hasAttribute('data-palette')) {
      togglePalette(b.getAttribute('data-palette'));
      return;
    } else if (b.hasAttribute('data-color')) {
      paint(b.getAttribute('data-color'));
      closePalettes();
    }
    sync();
    updateState();
  });

  // ── 정렬 (왼쪽/가운데/오른쪽): 문단에 al-center / al-right class ──
  var BLOCKS = 'p,h2,h3,blockquote,li';
  var selectedBlocks = function () {
    var sel = window.getSelection();
    if (!sel.rangeCount) return [];
    var range = sel.getRangeAt(0);
    var start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
    // 문단 없이 에디터 바로 아래에 쓴 글이면 먼저 문단으로 감쌈
    if (start === area || !start.closest(BLOCKS)) {
      document.execCommand('formatBlock', false, '<p>');
      range = sel.getRangeAt(0);
    }
    var list = [];
    area.querySelectorAll(BLOCKS).forEach(function (el) {
      if (range.intersectsNode(el) && !el.querySelector(BLOCKS)) list.push(el);
    });
    if (!list.length) {
      var one = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode).closest(BLOCKS);
      if (one && area.contains(one)) list.push(one);
    }
    return list;
  };
  var align = function (where) {
    selectedBlocks().forEach(function (el) {
      el.classList.remove('al-center', 'al-right');
      if (where === 'center' || where === 'right') el.classList.add('al-' + where);
      if (!el.className) el.removeAttribute('class');
    });
  };
  var currentAlign = function () {
    var sel = window.getSelection();
    if (!sel.rangeCount || !area.contains(sel.anchorNode)) return '';
    var n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
    var el = n.closest(BLOCKS);
    if (!el || !area.contains(el)) return 'left';
    return el.classList.contains('al-center') ? 'center' : el.classList.contains('al-right') ? 'right' : 'left';
  };

  // ── 글씨 색 / 배경색: 고른 글자를 <span class="fc-…|bg-…"> 로 감쌈 ──
  // 브라우저 foreColor 로 임시 색(<font color>)을 칠한 뒤 그 자리를 우리 class 로 바꿈 (style 속성은 CSP 로 막혀 있음)
  var MARK = '#fe0102';
  var unwrap = function (el) {
    var parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  };
  var paint = function (cls) {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !area.contains(sel.anchorNode)) {
      say('색을 바꿀 글자를 먼저 드래그해서 골라주세요.', true);
      return;
    }
    var type = cls.slice(0, 3); // 'fc-' 또는 'bg-'
    var none = /-0$/.test(cls);
    try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* 무시 */ }
    document.execCommand('foreColor', false, MARK);
    var made = [];
    area.querySelectorAll('font').forEach(function (f) {
      if ((f.getAttribute('color') || '').toLowerCase() !== MARK) { unwrap(f); return; }
      var span = document.createElement('span');
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
      // 안쪽에 있던 같은 종류의 색은 새 색으로 바꿈
      span.querySelectorAll('span').forEach(function (s) {
        s.className = s.className.split(/\s+/).filter(function (c) { return c.indexOf(type) !== 0; }).join(' ');
      });
      // 바깥 색 span 을 통째로 고른 경우엔 바깥 색도 지움
      var up = span.parentNode;
      while (up && up !== area && up.tagName === 'SPAN' && up.textContent === span.textContent) {
        up.className = up.className.split(/\s+/).filter(function (c) { return c.indexOf(type) !== 0; }).join(' ');
        up = up.parentNode;
      }
      // 일부만 고른 경우 바깥 색을 덮으려면 '기본'도 class 로 남겨야 함
      var outer = span.parentNode && span.parentNode.closest && span.parentNode.closest('span[class*="' + type + '"]');
      if (!none || (outer && area.contains(outer))) span.className = cls;
      made.push(span);
    });
    // 빈 껍데기 span 정리
    area.querySelectorAll('span').forEach(function (s) {
      if (!s.className.trim()) unwrap(s);
    });
    // 바꾼 글자를 다시 선택해 둠 (이어서 다른 색·굵게를 누를 수 있게)
    var keep = made.filter(function (s) { return s.isConnected; });
    if (keep.length) {
      var r = document.createRange();
      r.setStartBefore(keep[0]);
      r.setEndAfter(keep[keep.length - 1]);
      sel.removeAllRanges();
      sel.addRange(r);
      saved = r.cloneRange();
    }
  };

  var closePalettes = function () {
    root.querySelectorAll('[data-palette-box]').forEach(function (p) { p.hidden = true; });
    bar.querySelectorAll('[data-palette]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  };
  var togglePalette = function (type) {
    var box = root.querySelector('[data-palette-box="' + type + '"]');
    var open = box.hidden;
    closePalettes();
    box.hidden = !open;
    bar.querySelector('[data-palette="' + type + '"]').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.addEventListener('click', function (e) { if (!root.contains(e.target)) closePalettes(); });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePalettes(); });

  area.addEventListener('input', sync);
  area.addEventListener('keyup', updateState);
  area.addEventListener('mouseup', updateState);

  // 붙여넣기는 글자만 (다른 사이트 서식·스크립트가 섞이지 않게)
  area.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && /^image\//.test(files[0].type)) {
      e.preventDefault();
      upload(files[0]);
      return;
    }
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  area.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) upload(f);
  });

  // ── 사진 올리기 ─────────────────────────────────────
  var say = function (msg, isError) {
    status.textContent = msg || '';
    status.classList.toggle('is-error', !!isError);
  };
  var upload = function (file) {
    if (area.querySelectorAll('img').length >= imageMax) { say('사진은 ' + imageMax + '장까지 넣을 수 있어요.', true); return; }
    var fd = new FormData();
    fd.append('image', file);
    say('사진을 올리는 중이에요…');
    fetch(root.getAttribute('data-upload-url') || '/ads/images', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j.ok) { say(j.message || '사진을 올리지 못했어요.', true); return; }
        restore();
        document.execCommand('insertHTML', false, '<p><img src="' + j.url + '" alt=""></p><p><br></p>');
        sync();
        say('사진을 넣었어요.');
      })
      .catch(function () { say('사진을 올리지 못했어요. 잠시 후 다시 해주세요.', true); });
  };
  imageInput.addEventListener('change', function () {
    if (imageInput.files[0]) upload(imageInput.files[0]);
    imageInput.value = '';
  });

  if (form) form.addEventListener('submit', sync);
  sync();
})();
