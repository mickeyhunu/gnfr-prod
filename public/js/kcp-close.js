// KCP 본인확인 팝업 마무리: 원래 창(opener)을 결과 화면으로 옮기고 팝업을 닫음
//   opener 에 닿지 않으면 같은 사이트 채널(BroadcastChannel)로 알림. 둘 다 안 되면 이 창에서 결과 화면으로 이동
(function () {
  var el = document.querySelector('[data-kcp-close]');
  if (!el) return;
  var to = el.getAttribute('data-kcp-close');
  if (to.charAt(0) !== '/' || to.charAt(1) === '/') return;
  var sent = false;
  try {
    if (window.opener && !window.opener.closed && window.opener.location.origin === location.origin) {
      window.opener.location.href = to;
      window.opener.focus();
      sent = true;
    }
  } catch (_) { /* 다른 사이트이거나 연결이 끊김 */ }
  if (!sent && window.BroadcastChannel) {
    var ch = new BroadcastChannel('kcp-cert');
    ch.postMessage({ go: to });
    ch.close();
    sent = true;
  }
  if (sent) window.close();
  // 닫히지 않았으면(팝업이 아닌 창) 여기서 이동
  setTimeout(function () { location.replace(to); }, 400);
})();
