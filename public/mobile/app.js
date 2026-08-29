/* Mobile warehouse app — login, hash router, and the `inventory.mobile` gate.
   Shares the desktop API client (/js/api.js) and its bearer token (same origin),
   so a session started here also works on the PC. Views register with
   MApp.route(name, render) at load; render(viewEl, params) draws into #m-view. */
window.MApp = (function () {
  var routes = {};
  var me = null;

  var loginScreen = function () { return document.getElementById('m-login'); };
  var appScreen = function () { return document.getElementById('m-app'); };
  var viewEl = function () { return document.getElementById('m-view'); };

  function getMe() { return me; }
  function can(perm) { return me && Array.isArray(me.permissions) && me.permissions.indexOf(perm) !== -1; }

  /* ---------- routing ---------- */
  function route(name, render) { routes[name] = render; }

  /** Build a hash from a route name + params object. */
  function hashFor(name, params) {
    var q = '';
    if (params) {
      var parts = [];
      for (var k in params) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
      }
      if (parts.length) q = '?' + parts.join('&');
    }
    return '#/' + name + q;
  }
  function go(name, params) { location.hash = hashFor(name, params); }
  function back() { if (history.length > 1) history.back(); else go('home'); }

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var qi = h.indexOf('?');
    var name = (qi === -1 ? h : h.slice(0, qi)) || 'home';
    var params = {};
    if (qi !== -1) {
      h.slice(qi + 1).split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    return { name: name, params: params };
  }

  function setTitle(t) { document.getElementById('m-title').textContent = t || 'Warehouse'; }

  function render() {
    if (!me) return;
    if (!hasAccess()) { showBlocked(); return; }
    var parsed = parseHash();
    var fn = routes[parsed.name] || routes.home;
    document.getElementById('m-back').classList.toggle('hidden', parsed.name === 'home');
    var v = viewEl();
    v.innerHTML = '';
    v.scrollTop = 0;
    try {
      fn(v, parsed.params);
    } catch (e) {
      v.innerHTML = '<div class="m-error">' + (e && e.message ? e.message : 'Something went wrong') + '</div>';
    }
  }

  /* ---------- auth ---------- */
  function showLogin() {
    me = null;
    API.clearToken();
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    var pw = document.getElementById('m-password');
    if (pw) pw.value = '';
  }

  /** Warehouse users, and anyone with a linked employee record (time clock, payslip…). */
  function hasAccess() {
    return can('inventory.mobile') || !!(me && me.employee);
  }
  function isEmployee() { return !!(me && me.employee); }

  function showBlocked() {
    appScreen().classList.remove('hidden');
    loginScreen().classList.add('hidden');
    document.getElementById('m-back').classList.add('hidden');
    setTitle('Warehouse');
    viewEl().innerHTML =
      '<div class="m-blocked">' +
      '<div class="m-blocked-icon">&#128683;</div>' +
      '<h2>Nothing here for you yet</h2>' +
      '<p>This account has no mobile features. Ask an administrator for the ' +
      '<b>inventory.mobile</b> permission, or ask HR to link your account to your employee record.</p>' +
      '<button class="m-btn m-btn-secondary" id="m-blocked-out">Sign out</button></div>';
    document.getElementById('m-blocked-out').onclick = function () {
      API.post('/auth/logout').catch(function () {}).finally(showLogin);
    };
  }

  var ME_KEY = 'vds_m_me';

  function enterApp(user) {
    me = user;
    try { localStorage.setItem(ME_KEY, JSON.stringify(user)); } catch (e) { /* ignore */ }
    if (window.mQueue) mQueue.setToken(API.getToken()); // let the SW replay the queue in the background
    if (!hasAccess()) { showBlocked(); return; }
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/home';
    else render();
  }

  function cachedMe() {
    try { return JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch (e) { return null; }
  }

  function boot() {
    // Wire chrome
    document.getElementById('m-back').onclick = back;
    document.getElementById('m-settings').onclick = function () { go('settings'); };

    // Offline-queue badge in the top bar.
    var qbadge = document.getElementById('m-qbadge');
    qbadge.onclick = function () { go('queue'); };
    function refreshQueueBadge() {
      if (!window.mQueue) return;
      mQueue.count().then(function (n) {
        qbadge.classList.toggle('hidden', !n && navigator.onLine);
        qbadge.classList.toggle('offline', !navigator.onLine);
        qbadge.querySelector('span').textContent = navigator.onLine ? n : (n || '·');
      }).catch(function () {});
    }
    if (window.mQueue) mQueue.onChange(refreshQueueBadge);
    window.addEventListener('online', refreshQueueBadge);
    window.addEventListener('offline', refreshQueueBadge);
    refreshQueueBadge();
    document.getElementById('m-login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('m-login-error');
      err.classList.add('hidden');
      var btn = e.target.querySelector('button');
      btn.disabled = true;
      API.post('/auth/login', {
        username: document.getElementById('m-username').value.trim(),
        password: document.getElementById('m-password').value,
      })
        .then(function (res) { API.setToken(res.token); enterApp(res.user); })
        .catch(function (ex) {
          err.textContent = ex.message || 'Sign in failed';
          err.classList.remove('hidden');
        })
        .finally(function () { btn.disabled = false; });
    });

    window.addEventListener('hashchange', render);

    if (API.getToken()) {
      API.get('/auth/me').then(function (res) { enterApp(res.user); }).catch(function (ex) {
        // Offline with a saved session + cached identity → stay in the app so queued
        // work can keep going. A real 401 (expired token) still falls through to login.
        var m = cachedMe();
        if (ex && ex.offline && m) { enterApp(m); mToast && mToast('Offline — working from cache'); }
        else showLogin();
      });
    } else {
      showLogin();
    }
  }

  // api.js calls window.App.showLogin() on a 401.
  window.App = { showLogin: showLogin };

  // Register the service worker (offline launch + background sync). Its scope is
  // broadened to /m via the Service-Worker-Allowed header on /mobile/sw.js.
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/mobile/sw.js', { scope: '/m' }).catch(function () {});
    });
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // Reload once when a NEW app version takes over (not on the very first install).
      if (reloaded || !hadController) return;
      reloaded = true;
      location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    route: route, go: go, back: back, nav: hashFor,
    getMe: getMe, can: can, isEmployee: isEmployee, setTitle: setTitle, render: render,
    routes: function () { return Object.keys(routes); },
  };
})();
