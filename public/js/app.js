(function () {
  // 상단 바 고정: 바 높이만큼 본문을 내려서 내용이 가려지지 않게
  var app = document.querySelector('.app');
  var topBar = app && app.querySelector('header.site');
  if (topBar) {
    var syncTop = function () { app.style.setProperty('--top-h', topBar.offsetHeight + 'px'); };
    syncTop();
    app.classList.add('fixed-top');
    if (window.ResizeObserver) new ResizeObserver(syncTop).observe(topBar);
    else window.addEventListener('resize', syncTop);
  }

  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = tokenMeta ? tokenMeta.content : '';

  function postJSON(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false }; }).then(function (body) {
        body.status = res.status;
        return body;
      });
    });
  }

  // 인증번호 받기
  var sendBtn = document.getElementById('send-code');
  if (sendBtn) {
    var msg = document.getElementById('send-msg');
    var timer = null;
    sendBtn.addEventListener('click', function () {
      var phone = document.getElementById('phone').value;
      sendBtn.disabled = true;
      msg.textContent = '보내는 중...';
      postJSON('/auth/send-code', { phone: phone }).then(function (r) {
        msg.textContent = r.message || (r.ok ? '인증번호를 보냈어요.' : '잠시 후 다시 시도해주세요.');
        if (!r.ok) { sendBtn.disabled = false; return; }
        document.getElementById('code').focus();
        var left = 60;
        sendBtn.textContent = '재전송 ' + left + '초';
        timer = setInterval(function () {
          left -= 1;
          if (left <= 0) {
            clearInterval(timer);
            sendBtn.disabled = false;
            sendBtn.textContent = '다시 받기';
          } else {
            sendBtn.textContent = '재전송 ' + left + '초';
          }
        }, 1000);
      }).catch(function () {
        msg.textContent = '연결이 불안정해요. 다시 시도해주세요.';
        sendBtn.disabled = false;
      });
    });
  }

  // 추천 / 반대
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-vote]');
    if (!btn || btn.disabled) return;
    var type = btn.getAttribute('data-vote');
    var id = btn.getAttribute('data-id');
    var value = Number(btn.getAttribute('data-value'));
    btn.disabled = true;
    postJSON('/vote', { type: type, id: id, value: value }).then(function (r) {
      btn.disabled = false;
      var msgEl = document.querySelector('[data-vote-msg]');
      if (!r.ok) {
        if (msgEl && type === 'post') msgEl.textContent = r.message || '잠시 후 다시 시도해주세요.';
        return;
      }
      if (msgEl) msgEl.textContent = '';
      var group = document.querySelectorAll('[data-vote="' + type + '"][data-id="' + id + '"]');
      group.forEach(function (b) {
        var v = Number(b.getAttribute('data-value'));
        var on = r.mine === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        var up = b.querySelector('[data-count="up"]');
        var down = b.querySelector('[data-count="down"]');
        if (up) up.textContent = r.up;
        if (down) down.textContent = r.down;
      });
    }).catch(function () { btn.disabled = false; });
  });

  // 저장(북마크)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-bookmark]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    postJSON('/bookmark', { id: btn.getAttribute('data-bookmark') }).then(function (r) {
      btn.disabled = false;
      var msgEl = document.querySelector('[data-vote-msg]');
      if (!r.ok) { if (msgEl) msgEl.textContent = r.message || '잠시 후 다시 시도해주세요.'; return; }
      if (msgEl) msgEl.textContent = r.saved ? '저장했어요. 마이페이지에서 다시 볼 수 있어요.' : '';
      btn.classList.toggle('on', r.saved);
      btn.setAttribute('aria-pressed', r.saved ? 'true' : 'false');
      btn.querySelector('[data-bookmark-label]').textContent = r.saved ? '저장됨' : '저장';
    }).catch(function () { btn.disabled = false; });
  });

  // 답글: 댓글의 '답글'을 누르면 아래 입력창이 그 댓글에 답하는 모드로 바뀜
  var replyForm = document.querySelector('[data-reply-form]');
  if (replyForm) {
    var replyInput = replyForm.querySelector('input[name="body"]');
    var replyParent = replyForm.querySelector('[data-reply-parent]');
    var replyTo = replyForm.querySelector('[data-reply-to]');
    var replyName = replyForm.querySelector('[data-reply-to-name]');
    var basePlaceholder = replyInput.placeholder;
    var marked = null;
    var setReply = function (id, name) {
      if (marked) marked.classList.remove('replying');
      marked = id ? document.getElementById('c' + id) : null;
      if (marked) marked.classList.add('replying');
      replyParent.value = id || '';
      replyTo.hidden = !id;
      replyName.textContent = name || '';
      replyInput.placeholder = id ? name + '에게 답글 달기' : basePlaceholder;
    };
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-reply]');
      if (btn) {
        setReply(btn.getAttribute('data-reply'), btn.getAttribute('data-reply-name'));
        replyInput.focus();
        return;
      }
      if (e.target.closest('[data-reply-cancel]')) { setReply(null); replyInput.focus(); }
    });
  }

  // @익명N 을 누르면 그 댓글로 이동하고 잠깐 강조
  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-jump]');
    if (!link) return;
    var target = document.getElementById(link.getAttribute('data-jump'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });

  // 삭제·제한 같은 작업은 한 번 더 확인
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var question = form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) e.preventDefault();
  });

  // 글 더보기 메뉴: 공유하기
  document.addEventListener('click', function (e) {
    var share = e.target.closest('[data-share]');
    if (share) {
      var url = location.origin + location.pathname;
      var title = share.getAttribute('data-share-title') || document.title;
      var menu = share.closest('details');
      var done = function (text) {
        var label = share.lastChild;
        var old = label.textContent;
        label.textContent = ' ' + text;
        setTimeout(function () { label.textContent = old; if (menu) menu.removeAttribute('open'); }, 1400);
      };
      if (navigator.share) {
        navigator.share({ title: title, url: url }).then(function () { if (menu) menu.removeAttribute('open'); }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { done('링크를 복사했어요'); }, function () { window.prompt('링크를 복사하세요', url); });
      } else {
        window.prompt('링크를 복사하세요', url);
      }
      return;
    }
  });

  // 신고 카드: 글 메뉴의 '신고하기', 댓글의 '신고'를 누르면 열림
  var sheet = document.getElementById('report-sheet');
  if (sheet && sheet.showModal) {
    var sheetForm = sheet.querySelector('form');
    var submitBtn = sheet.querySelector('[data-report-submit]');
    document.addEventListener('click', function (e) {
      var open = e.target.closest('[data-report-open]');
      if (!open) return;
      var type = open.getAttribute('data-type');
      sheetForm.reset();
      syncSheet();
      sheet.querySelector('[data-report-type]').value = type;
      sheet.querySelector('[data-report-id]').value = open.getAttribute('data-id');
      sheet.querySelector('[data-report-title]').textContent = type === 'comment' ? '이 댓글을 신고할까요?' : '이 글을 신고할까요?';
      var menu = open.closest('details');
      if (menu) menu.removeAttribute('open');
      sheet.showModal();
    });
    var detail = sheet.querySelector('[data-detail]');
    var detailCount = sheet.querySelector('[data-detail-count]');
    var detailOpt = sheet.querySelector('[data-detail-label] .opt');
    // '기타'를 고르면 내용이 필수 (5자 이상)
    var syncSheet = function () {
      var picked = sheetForm.querySelector('input[name="reason"]:checked');
      var needText = picked && picked.value === 'etc';
      var len = detail.value.trim().length;
      detailCount.textContent = detail.value.length;
      detailOpt.textContent = needText ? '(필수, 5자 이상)' : '(선택)';
      detailOpt.classList.toggle('req', !!needText);
      detail.required = !!needText;
      submitBtn.disabled = !picked || (needText && len < 5);
    };
    sheetForm.addEventListener('change', syncSheet);
    detail.addEventListener('input', syncSheet);
    sheet.querySelector('[data-report-close]').addEventListener('click', function () { sheet.close(); });
    // 카드 바깥(어두운 부분)을 누르면 닫기
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
  }

  // 사업자등록번호: 입력하는 대로 000-00-00000 형태로
  document.querySelectorAll('[data-bizno]').forEach(function (input) {
    var format = function () {
      var d = input.value.replace(/[^0-9]/g, '').slice(0, 10);
      var out = d.length > 5 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5)
        : d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d;
      if (out !== input.value) input.value = out;
    };
    input.addEventListener('input', format);
    format();
  });

  // 광고 등록 1단계: [조회] 버튼으로 국세청 상태를 미리 확인 (서류를 다시 고르는 일이 없게)
  var checkBtn = document.querySelector('[data-bizno-check]');
  if (checkBtn) {
    var bizInput = document.querySelector('[data-bizno]');
    var bizResult = document.querySelector('[data-bizno-result]');
    var setResult = function (msg, ok) {
      bizResult.textContent = msg || '';
      bizResult.className = 'bizno-result' + (msg ? (ok ? ' ok' : ' bad') : '');
    };
    bizInput.addEventListener('input', function () { setResult(''); });
    checkBtn.addEventListener('click', function () {
      var digits = bizInput.value.replace(/[^0-9]/g, '');
      if (digits.length !== 10) { setResult('사업자등록번호 10자리를 적어주세요.', false); bizInput.focus(); return; }
      checkBtn.disabled = true;
      setResult('국세청에 확인하는 중이에요…', true);
      fetch('/ads/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ b_no: digits }),
        credentials: 'same-origin',
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.ok) setResult('✓ 국세청 ' + (j.name || '계속사업자') + ' 확인' + (j.taxType ? ' · ' + j.taxType : ''), true);
          else setResult(j.msg || j.message || '확인하지 못했어요.', false);
        })
        .catch(function () { setResult('확인하지 못했어요. 잠시 후 다시 해주세요.', false); })
        .then(function () { checkBtn.disabled = false; });
    });
  }

  // 광고 등록: 허가증이 필요한 업종을 고르면 영업허가증 칸을 필수로
  var adForm = document.querySelector('[data-ad-form]');
  if (adForm) {
    var licBox = adForm.querySelector('[data-license-box]');
    var licName = adForm.querySelector('[data-license-name]');
    var licInput = licBox.querySelector('input[type="file"]');
    var licReq = licBox.querySelector('[data-license-req]');
    var licOpt = licBox.querySelector('[data-license-opt]');
    var syncLicense = function () {
      var picked = adForm.querySelector('input[name="category"]:checked');
      var need = picked ? picked.getAttribute('data-license') : '';
      licInput.required = !!need;
      licReq.hidden = !need;
      licOpt.hidden = !!need;
      licName.textContent = need ? need + '을(를) 올려주세요.' : '허가·신고가 필요한 업종이면 올려주세요.';
    };
    adForm.addEventListener('change', function (e) {
      if (e.target.name === 'category') syncLicense();
      // 기타 서류 개수 제한
      var max = Number(e.target.getAttribute('data-max-files') || 0);
      if (max && e.target.files && e.target.files.length > max) {
        alert('기타 서류는 ' + max + '개까지 올릴 수 있어요.');
        e.target.value = '';
      }
      if (e.target.type === 'file') showDoc(e.target);
    });
    // 서류 칸: 고른 파일을 미리 보여줌 (사진은 썸네일, PDF 는 파일 이름)
    var showDoc = function (input) {
      var tile = input.closest('[data-doc-tile]');
      if (!tile) return;
      var box = tile.querySelector('[data-doc-preview]');
      var files = input.files || [];
      box.textContent = '';
      tile.classList.toggle('has-file', files.length > 0);
      box.hidden = !files.length;
      if (!files.length) return;
      var f = files[0];
      if (/^image\//.test(f.type)) {
        var img = document.createElement('img');
        img.alt = '';
        box.appendChild(img);
        var reader = new FileReader();
        reader.onload = function () { img.src = reader.result; };
        reader.readAsDataURL(f);
      } else {
        var kind = document.createElement('span');
        kind.className = 'doc-kind';
        kind.textContent = 'PDF';
        var name = document.createElement('span');
        name.textContent = f.name;
        box.appendChild(kind);
        box.appendChild(name);
      }
      if (files.length > 1) {
        var n = document.createElement('span');
        n.className = 'doc-count';
        n.textContent = files.length + '개';
        box.appendChild(n);
      }
    };
    syncLicense();
  }

  // 복사 버튼 (마이페이지 추천인 코드·초대 링크): data-copy 값을 클립보드로
  var copyStatus = document.querySelector('[data-copy-status]');
  var copyText = function (text) {
    // clipboard API 가 없거나(http) 거절되면 예전 방식(execCommand)으로 한 번 더
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return copyLegacy(text); });
    }
    return copyLegacy(text);
  };
  var copyLegacy = function (text) {
    return new Promise(function (resolve, reject) {
      var t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.className = 'sr-only';
      document.body.appendChild(t);
      t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(t);
      if (ok) resolve(); else reject();
    });
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var text = b.getAttribute('data-copy');
    var old = b.getAttribute('data-label') || b.textContent;
    b.setAttribute('data-label', old);
    copyText(text).then(function () {
      b.textContent = '복사됨';
      if (copyStatus) copyStatus.textContent = b.getAttribute('data-copy-done') || '복사했어요';
      setTimeout(function () { b.textContent = old; if (copyStatus) copyStatus.textContent = ''; }, 1600);
    }, function () {
      window.prompt('아래 내용을 길게 눌러 복사하세요', text);
    });
  });
  // 초대 링크 입력칸을 누르면 전체 선택
  var inviteInput = document.getElementById('invite-url');
  if (inviteInput) inviteInput.addEventListener('focus', function () { inviteInput.select(); });
  // 휴대폰처럼 공유 기능이 있으면 '다른 앱으로 공유하기' 보이기
  var inviteShare = document.querySelector('[data-invite-share]');
  if (inviteShare && navigator.share) {
    inviteShare.hidden = false;
    inviteShare.addEventListener('click', function () {
      navigator.share({ title: '강남의숲 초대', text: '강남의숲에 초대해요. 이 링크로 가입하면 추천인 코드가 자동으로 입력돼요.', url: inviteShare.getAttribute('data-invite-share') }).catch(function () {});
    });
  }

  // 열린 메뉴 바깥을 누르면 닫기
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // KCP 휴대폰 본인확인: 지금 화면은 그대로 두고 팝업으로 염. 팝업이 막히면 링크대로 이 창에서 진행
  //   본인확인이 끝나면 팝업(kcp-close.js)이 이 창을 결과 화면으로 옮기고 스스로 닫힘
  var goFromKcp = function (to) {
    if (typeof to === 'string' && to.charAt(0) === '/' && to.charAt(1) !== '/') location.href = to;
  };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-kcp-popup]');
    if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var w = 440;
    var h = 720;
    var left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || w) - w) / 2);
    var top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || h) - h) / 2);
    var url = a.getAttribute('href') + (a.getAttribute('href').indexOf('?') < 0 ? '?' : '&') + 'popup=1';
    var pop = window.open(url, 'kcp_cert', 'width=' + w + ',height=' + h + ',left=' + Math.round(left) + ',top=' + Math.round(top) + ',scrollbars=yes,resizable=yes');
    if (!pop) return; // 팝업 차단 → 그냥 이동
    e.preventDefault();
    pop.focus();
  });
  // 팝업이 opener 로 못 옮길 때(브라우저가 연결을 끊은 경우) 같은 사이트 채널로 받음
  if (window.BroadcastChannel && document.querySelector('a[data-kcp-popup]')) {
    new BroadcastChannel('kcp-cert').onmessage = function (e) { goFromKcp(e.data && e.data.go); };
  }
  // 가로로 넘치는 칩 바(.chips): 컴퓨터에서도 마우스로 끌거나 휠로 좌우 이동
  //   터치는 브라우저 기본 스크롤 그대로. 끌다가 놓을 때는 칩이 눌리지 않게 클릭을 막음
  Array.prototype.forEach.call(document.querySelectorAll('.chips:not(.wrap)'), function (bar) {
    var startX = 0, startLeft = 0, dragging = false, moved = false;
    var canScroll = function () { return bar.scrollWidth > bar.clientWidth + 1; };
    var mark = function () { bar.classList.toggle('draggable', canScroll()); };
    mark();
    window.addEventListener('resize', mark);
    bar.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !canScroll()) return;
      dragging = true; moved = false; startX = e.clientX; startLeft = bar.scrollLeft;
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 5) return; // 살짝 흔들린 건 클릭으로
      if (!moved) { moved = true; bar.classList.add('dragging'); }
      bar.scrollLeft = startLeft - dx;
      e.preventDefault();
    });
    window.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
    });
    bar.addEventListener('click', function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
    bar.addEventListener('dragstart', function (e) { e.preventDefault(); }); // 링크 끌기(브라우저 기본) 막기
    // 세로 휠 → 가로 이동 (끝에 닿으면 페이지 스크롤로 넘김)
    bar.addEventListener('wheel', function (e) {
      if (!canScroll() || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      var max = bar.scrollWidth - bar.clientWidth;
      if ((e.deltaY < 0 && bar.scrollLeft <= 0) || (e.deltaY > 0 && bar.scrollLeft >= max - 1)) return;
      bar.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  });
})();
