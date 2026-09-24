/* Mobile app — login, hash router, and the app chrome (bottom tab bar, the
   Me/Approvals/People/Warehouse segmented control on Home, and a role-aware
   centre action button). Shares the desktop API client (/js/api.js) and its
   bearer token. Views register with MApp.route(name, render) at load;
   render(viewEl, params) draws into #m-view. */
window.MApp = (function () {
  var routes = {};
  var me = null;

  var loginScreen = function () { return document.getElementById('m-login'); };
  var appScreen = function () { return document.getElementById('m-app'); };
  var viewEl = function () { return document.getElementById('m-view'); };

  function getMe() { return me; }
  function can(perm) { return me && Array.isArray(me.permissions) && me.permissions.indexOf(perm) !== -1; }
  /** SaaS feature-module entitlement for this workspace (see src/modules.ts). Absent list
      (self-hosted, or pre-login) → treat every module as on. */
  function hasModule(m) { return !me || !Array.isArray(me.modules) || me.modules.indexOf(m) !== -1; }
  function isEmployee() { return !!(me && me.employee); }
  function isWarehouse() { return can('inventory.mobile') && hasModule('inventory'); }
  // Narrower than isWarehouse(): a releasing_clerk account also holds inventory.mobile (to
  // reach the app + the Work tab's "Release SOs" row) but has none of the production.*
  // permissions or inventory.adjust — the Production tab has nothing for it to do, so it
  // stays hidden rather than opening on an empty queue (see public/mobile/modules/
  // manufacturing/production.js's own per-row permission filtering).
  function hasProductionAccess() {
    return isWarehouse() && !!(me && Array.isArray(me.permissions) &&
      me.permissions.some(function (p) { return p === 'inventory.adjust' || p.indexOf('production.') === 0; }));
  }
  function canApprove() { return !!(me && me.can_approve); }

  /* ---------- routing ---------- */
  function route(name, render) { routes[name] = render; }

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

  function setTitle(t) { document.getElementById('m-title').textContent = t || 'Home'; }

  /* ---------- chrome: tabs + segments ---------- */
  var TAB_ROOTS = { home: 1, work: 1, production: 1, scan: 1, clock: 1, inbox: 1, settings: 1 };
  // which bottom tab lights up for a given route ('action' = the role Scan/Clock tab)
  var TAB_OF = {
    home: 'home',
    work: 'work', 'stock-move': 'work', transfer: 'work', damage: 'work', 'new-item': 'work',
    batch: 'work', 'cycle-count': 'work', receive: 'work', pick: 'work',
    allocate: 'work', 'assign-qr': 'work', 'low-stock': 'work', location: 'work',
    'my-log': 'work', item: 'work', scan: 'action', deliveries: 'work', so: 'work',
    production: 'production', 'job-orders': 'production', qc: 'production', repairs: 'production', record: 'production',
    inbox: 'inbox', directory: 'inbox',
    settings: 'profile', queue: 'profile',
    clock: 'action', 'time-fix': 'home', requests: 'home', payslips: 'home', schedule: 'home',
    tasks: 'work', approvals: 'home', announcements: 'home', 'report-problem': 'home',
  };
  var SEGMENTS = ['me', 'approvals', 'people', 'warehouse'];
  var SEG_KEY = 'vds_m_seg';

  function segAllowed(s) {
    if (s === 'me' || s === 'people') return true;
    if (s === 'approvals') return canApprove();
    if (s === 'warehouse') return isWarehouse();
    return false;
  }
  function defaultSeg() { return isWarehouse() ? 'warehouse' : 'me'; }
  function storedSeg() {
    try { var s = localStorage.getItem(SEG_KEY); return SEGMENTS.indexOf(s) !== -1 ? s : null; } catch (e) { return null; }
  }
  function currentSeg() {
    var p = parseHash();
    var s = (p.name === 'home' && SEGMENTS.indexOf(p.params.seg) !== -1) ? p.params.seg : (storedSeg() || defaultSeg());
    return segAllowed(s) ? s : defaultSeg();
  }
  function seg() { return currentSeg(); }

  /** The role action tab (left of the raised Home button): Scan for warehouse,
      Clock for other employees. */
  function actionConfig() {
    if (isWarehouse()) {
      return { route: 'scan', label: 'Scan',
        svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>' };
    }
    return { route: 'clock', label: 'Clock',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' };
  }

  function paintChrome(parsed) {
    var name = parsed.name;
    var isRoot = !!TAB_ROOTS[name] || name === actionConfig().route;
    document.getElementById('m-back').classList.toggle('hidden', isRoot);

    // segmented control only on Home; hide segments that don't apply to this user
    var segEl = document.getElementById('m-segments');
    var onHome = name === 'home';
    segEl.classList.toggle('hidden', !onHome);
    if (onHome) {
      var cur = currentSeg();
      segEl.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('hidden', !segAllowed(b.dataset.seg));
        b.classList.toggle('on', b.dataset.seg === cur);
      });
    }

    // active bottom tab
    var activeTab = name === 'home' ? 'home' : (TAB_OF[name] || 'home');
    if (name === actionConfig().route) activeTab = 'action';
    document.querySelectorAll('#m-tabbar .m-tab').forEach(function (t) {
      t.classList.toggle('on', t.dataset.tab === activeTab);
    });
    // the Production tab only applies to warehouse/shop-floor accounts
    var prodTab = document.getElementById('m-tab-production');
    if (prodTab) prodTab.classList.toggle('hidden', !hasProductionAccess());

    // context line
    var role = me && me.role ? me.role.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
    document.getElementById('m-ctx-role').textContent = role || (isWarehouse() ? 'Warehouse' : 'Employee');
    document.getElementById('m-ctx-place').textContent = (me && me.department_name) || 'Main';
    setOnline(navigator.onLine);
  }

  function setOnline(on) {
    var dot = document.getElementById('m-ctx-dot');
    var txt = document.getElementById('m-ctx-status');
    if (dot) dot.classList.toggle('off', !on);
    if (txt) txt.textContent = on ? 'Online' : 'Offline';
  }

  function render() {
    if (!me) return;
    if (!hasAccess()) { showBlocked(); return; }
    var parsed = parseHash();
    var fn = routes[parsed.name] || routes.home;
    paintChrome(parsed);
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
    if (window.ChatWS) ChatWS.disconnect();
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    var pw = document.getElementById('m-password');
    if (pw) pw.value = '';
  }

  function hasAccess() { return can('inventory.mobile') || !!(me && me.employee); }

  function showBlocked() {
    appScreen().classList.remove('hidden');
    loginScreen().classList.add('hidden');
    document.getElementById('m-back').classList.add('hidden');
    document.getElementById('m-segments').classList.add('hidden');
    document.getElementById('m-tabbar').classList.add('hidden');
    setTitle('Verdesakay');
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
    if (window.mQueue) mQueue.setToken(API.getToken());
    if (!hasAccess()) { showBlocked(); return; }
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');
    document.getElementById('m-tabbar').classList.remove('hidden');

    // paint the role-aware action tab (Scan / Clock) once we know the user
    var act = actionConfig();
    var ai = document.getElementById('m-action-icon');
    var al = document.getElementById('m-action-lbl');
    if (ai) ai.innerHTML = act.svg;
    if (al) al.textContent = act.label;

    refreshInboxBadge();
    if (window.ChatWS) {
      ChatWS.off('message:new', refreshInboxBadge);
      ChatWS.off('message:deleted', refreshInboxBadge);
      ChatWS.on('message:new', refreshInboxBadge);
      ChatWS.on('message:deleted', refreshInboxBadge);
      ChatWS.connect();
    }
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.hash = hashFor('home', { seg: currentSeg() });
    } else {
      render();
    }
  }

  function cachedMe() {
    try { return JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch (e) { return null; }
  }

  /* ---------- badges ---------- */
  function refreshInboxBadge() {
    API.get('/messages/unread-count').then(function (r) {
      var n = (r && (r.count != null ? r.count : r.unread)) || 0;
      [document.getElementById('m-inbox-badge'), document.getElementById('m-tab-inbox-badge')].forEach(function (el) {
        if (!el) return;
        el.textContent = n > 99 ? '99+' : n;
        el.classList.toggle('hidden', !n);
      });
    }).catch(function () {});
  }

  function boot() {
    document.getElementById('m-back').onclick = back;
    document.getElementById('m-inbox-top').onclick = function () { go('inbox'); };

    // bottom tab bar
    document.querySelectorAll('#m-tabbar .m-tab').forEach(function (t) {
      t.onclick = function () {
        var tab = t.dataset.tab;
        if (tab === 'home') go('home', { seg: currentSeg() });
        else if (tab === 'work') go('work');
        else if (tab === 'production') go('production');
        else if (tab === 'action') go(actionConfig().route);
        else if (tab === 'inbox') go('inbox');
        else if (tab === 'profile') go('settings');
      };
    });

    // segmented control
    document.querySelectorAll('#m-segments button').forEach(function (b) {
      b.onclick = function () {
        try { localStorage.setItem(SEG_KEY, b.dataset.seg); } catch (e) { /* ignore */ }
        go('home', { seg: b.dataset.seg });
      };
    });

    // offline-queue badge
    var qbadge = document.getElementById('m-qbadge');
    qbadge.onclick = function () { go('queue'); };
    function refreshQueueBadge() {
      if (!window.mQueue) return;
      mQueue.count().then(function (n) {
        qbadge.classList.toggle('active', !!n);
        qbadge.classList.toggle('offline', !navigator.onLine);
        var el = document.getElementById('m-qcount');
        el.textContent = navigator.onLine ? (n || 0) : (n || '·');
        el.classList.toggle('hidden', !n && navigator.onLine);
      }).catch(function () {});
    }
    if (window.mQueue) mQueue.onChange(refreshQueueBadge);
    window.addEventListener('online', function () { setOnline(true); refreshQueueBadge(); });
    window.addEventListener('offline', function () { setOnline(false); refreshQueueBadge(); });
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
        var m = cachedMe();
        if (ex && ex.offline && m) { enterApp(m); mToast && mToast('Offline — working from cache'); }
        else showLogin();
      });
    } else {
      showLogin();
    }
  }

  window.App = { showLogin: showLogin };

  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/mobile/sw.js', { scope: '/m' }).catch(function () {});
    });
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded || !hadController) return;
      reloaded = true;
      location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return {
    route: route, go: go, back: back, nav: hashFor,
    getMe: getMe, can: can, hasModule: hasModule, isEmployee: isEmployee, isWarehouse: isWarehouse,
    hasProductionAccess: hasProductionAccess, canApprove: canApprove,
    seg: seg, setTitle: setTitle, render: render, refreshInboxBadge: refreshInboxBadge,
    routes: function () { return Object.keys(routes); },
  };
})();
