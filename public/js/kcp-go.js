// KCP 본인확인 화면으로 바로 넘김 (화면 전환 방식)
(function () {
  var form = document.querySelector('form[data-kcp-auto]');
  if (form) form.submit();
})();
