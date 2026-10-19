/* Early startup and foreground-read feedback. This never retries requests automatically. */
(function () {
  var delay = 10000;
  var tasks = new Map();
  var sequence = 0, timer = null, panel = null, muted = false, writes = 0, edited = false;
  var startup;
  var background = /^\/(?:messages\/unread-count|notifications\/unread-count|bug-reports\/open-count)(?:\?|$)/;

  function hide() { if (panel) panel.hidden = true; }
  function render() {
    if (!panel) {
      var style = document.createElement('style');
      style.textContent = '.app-slow-notice{position:fixed;top:76px;right:18px;z-index:500;width:min(390px,calc(100vw - 24px));box-sizing:border-box;padding:18px;border:1px solid var(--border,#4a4559);border-radius:14px;background:var(--surface,#211f30);color:var(--text,#f4f1ff);box-shadow:0 16px 44px #0003;font:14px/1.5 system-ui,sans-serif}.app-slow-notice[hidden]{display:none}.app-slow-notice h2{font-size:16px;margin:0 24px 7px 0}.app-slow-notice p{margin:0 0 14px;color:var(--text-muted,#b8b2c7)}.app-slow-notice button{font:inherit;cursor:pointer;border:1px solid var(--border,#5a536e);border-radius:8px;padding:7px 11px;background:var(--surface-2,#302b43);color:inherit}.app-slow-notice button:focus-visible{outline:3px solid var(--accent,#ab9eff);outline-offset:2px}.app-slow-notice button:disabled{opacity:.55;cursor:wait}.app-slow-notice [data-dismiss]{position:absolute;right:10px;top:10px;padding:2px 8px;border:0;background:transparent}.app-slow-actions{display:flex;gap:8px;flex-wrap:wrap}.app-slow-light{height:3px;margin-top:15px;overflow:hidden;border-radius:3px;background:var(--surface-2,#302b43)}.app-slow-light:after{content:"";display:block;width:35%;height:100%;background:var(--accent,#aa9aff);animation:app-slow-sweep 2.4s ease-in-out infinite}@keyframes app-slow-sweep{from{transform:translateX(-100%)}to{transform:translateX(390%)}}@media(prefers-reduced-motion:reduce){.app-slow-light:after{animation:none}}@media(max-width:600px){.app-slow-notice{top:max(68px,env(safe-area-inset-top));right:12px}}';
      (document.head || document.documentElement).appendChild(style);
      panel = document.createElement('aside');
      panel.className = 'app-slow-notice';
      panel.setAttribute('aria-label', 'Loading status');
      panel.innerHTML = '<button type="button" data-dismiss aria-label="Dismiss loading notice">×</button><div role="status" aria-live="polite"><h2>◷ App loading slowly</h2><p data-message></p></div><div class="app-slow-actions"><button type="button" data-wait>Keep waiting</button><button type="button" data-retry>Retry</button></div><div class="app-slow-light" aria-hidden="true"></div>';
      (document.body || document.documentElement).appendChild(panel);
      function wait() { muted = true; hide(); }
      panel.querySelector('[data-dismiss]').onclick = wait;
      panel.querySelector('[data-wait]').onclick = wait;
      panel.querySelector('[data-retry]').onclick = function () {
        if (writes) return;
        if (edited && !window.confirm('Reload this page? Unsaved changes may be lost.')) return;
        // Existing beforeunload draft guards still get the final say.
        window.location.reload();
      };
    }
    panel.hidden = false;
    panel.querySelector('[data-retry]').disabled = writes > 0;
    var message = writes
      ? 'Loading is taking longer than expected. A save or upload is still running; please wait for it to finish before retrying.'
      : 'The app is taking longer than expected to load. Keep waiting, or retry to reload this page.';
    var copy = panel.querySelector('[data-message]');
    if (copy.textContent !== message) copy.textContent = message;
  }
  function refresh() {
    clearTimeout(timer); timer = null;
    if (!tasks.size) { muted = false; hide(); return; }
    if (muted) { hide(); return; }
    var oldest = Math.min.apply(null, Array.from(tasks.values()));
    var remaining = delay - (Date.now() - oldest);
    if (remaining <= 0) render();
    else { hide(); timer = setTimeout(refresh, remaining); }
  }
  function begin() {
    var id = ++sequence, done = false;
    tasks.set(id, Date.now()); refresh();
    return function () { if (done) return; done = true; tasks.delete(id); refresh(); };
  }
  startup = begin();
  document.addEventListener('input', function (event) {
    if (event.target.matches && (event.target.matches('input:not([type="search"]),textarea,select') || event.target.isContentEditable)) edited = true;
  }, true);
  document.addEventListener('change', function (event) {
    if (event.target.matches && event.target.matches('input,textarea,select')) edited = true;
  }, true);
  window.SlowLoading = {
    ready: function () { startup(); },
    navigation: function () { edited = false; tasks.clear(); muted = false; refresh(); },
    request: function (method, path, opts) {
      if (method === 'GET') return ((opts && opts.background) || background.test(path)) ? function () {} : begin();
      writes++; refresh();
      var done = false;
      return function () { if (done) return; done = true; writes--; refresh(); };
    },
  };
})();
