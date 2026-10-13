/* Mobile app — login, hash router, and shared V2 chrome. The persistent dock is
   Home / Work / Clock / Inbox / Profile for every employee. Role operations stay
   in Work and the movable Quick Orbit instead of replacing universal Clock. */
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
  function isEmployee() { return hasModule('hr') && !!(me && me.employee); }
  // The warehouse phone tools (stock moves, counts, picking, scan). Floor desks don't hold
  // inventory.mobile (src/shared/permissions.ts): their Work rows, Quick Orbit action and the
  // Production tab follow their own desk permission instead.
  function isWarehouse() { return can('inventory.mobile') && hasModule('inventory'); }
  // The Production tab: anyone with a production action to take — inventory.adjust or any
  // production.* desk permission (production.view alone is read-only, nothing to do here). A
  // releasing_clerk has none, so the tab stays hidden rather than opening on an empty queue (see
  // public/mobile/modules/manufacturing/production.js's own per-row permission filtering).
  function hasProductionAccess() {
    return hasModule('manufacturing') && !!(me && Array.isArray(me.permissions) &&
      me.permissions.some(function (p) { return p === 'inventory.adjust' || (p.indexOf('production.') === 0 && p !== 'production.view'); }));
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
  function go(name, params) { if(window.mPersonalDraft && !mPersonalDraft.allow()) return; location.hash = hashFor(name, params); }
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
  var TAB_ROOTS = { home: 1, work: 1, clock: 1, inbox: 1, settings: 1, notifications: 1 };
  // Which stable bottom destination owns each route.
  var TAB_OF = {
    home: 'home',
    work: 'work', 'stock-move': 'work', transfer: 'work', damage: 'work', 'new-item': 'work',
    batch: 'work', 'cycle-count': 'work', receive: 'work', pick: 'work',
    allocate: 'work', 'assign-qr': 'work', 'low-stock': 'work', location: 'work',
    'my-log': 'work', item: 'work', scan: 'work', deliveries: 'work', so: 'work',
    production: 'work', 'job-orders': 'work', 'kit-release': 'work', qc: 'work', repairs: 'work', record: 'work', receiving: 'work',
    inbox: 'inbox', directory: 'inbox',
    settings: 'profile', queue: 'profile',
    clock: 'clock', 'time-fix': 'home', requests: 'home', payslips: 'home', schedule: 'home', notifications: 'home',
    tasks: 'work', notes: 'work', guides: 'work', approvals: 'home', announcements: 'home', 'report-problem': 'home', 'anonymous-report': 'home',
    'confidential-reports': 'work',
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

  /** Clock is universal. Scanning belongs to Work and Quick Orbit. */
  function actionConfig() {
    return { route: 'clock', label: 'Clock',
      svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' };
  }

  function paintChrome(parsed) {
    var name = parsed.name;
    var isRoot = !!TAB_ROOTS[name];
    document.getElementById('m-back').classList.toggle('hidden', isRoot);

    // V2 uses one employee-first Home. Approvals, People and role work have
    // dedicated routes instead of a second navigation system inside Home.
    var segEl = document.getElementById('m-segments');
    if (segEl) segEl.classList.add('hidden');

    // active bottom tab
    var activeTab = name === 'home' ? 'home' : (TAB_OF[name] || 'home');
    
    document.querySelectorAll('#m-tabbar .m-tab').forEach(function (t) {
      t.classList.toggle('on', t.dataset.tab === activeTab);
    });

    // context line
    var role = me && me.role_label ? me.role_label : me && me.role ? me.role.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
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

  /** Screens that need more than the phone app itself, checked here so a screen opened from a link or
      a typed address says so up front instead of failing on its first save (the server enforces the
      same). Routes not listed are for everyone, or check their own desk permission (qc, repairs,
      receiving, so, job-orders, kit-release, scan …). tests/frontend-mobile.test.ts walks every route. */
  var ROUTE_NEEDS = {
    allocate: ['inventory.adjust'], batch: ['inventory.adjust'], 'cycle-count': ['inventory.adjust'],
    damage: ['inventory.adjust'], receive: ['inventory.adjust'], pick: ['inventory.adjust'],
    'stock-move': ['inventory.adjust'], transfer: ['inventory.adjust'], 'assign-qr': ['inventory.adjust'],
    'new-item': ['inventory.create'],
    item: ['inventory.view'], location: ['inventory.view'], 'low-stock': ['inventory.view'],
    // A unit's production record: the broad views, or any desk that handles the unit (src/shared/desk-access.ts).
    record: ['inventory.view', 'production.view', 'production.record', 'production.pause', 'production.manage',
      'production.approve', 'production.inspect_qc', 'production.inspect_qa', 'production.qa_review',
      'production.repairs', 'production.receive', 'orders.release'],
  };

  function render() {
    if(window.mPersonalDraft && !mPersonalDraft.allow()) return;
    window.GuideTour?.close();window.PersonalUX?.release();
    if (me && me.password_change_required) return;
    if (!me) return;
    if (!hasAccess()) { showBlocked(); return; }
    var parsed = parseHash();
    var fn = routes[parsed.name] || routes.home;
    paintChrome(parsed);
    var v = viewEl();
    v.innerHTML = '';
    v.scrollTop = 0;
    // Screens tag #m-view (data-figma-node, data-role-screen/-title/-subtitle); the element is
    // reused across routes, so clear every tag or the last screen's role title leaks onward.
    Array.prototype.slice.call(v.attributes).forEach(function (a) {
      if (a.name.indexOf('data-') === 0) v.removeAttribute(a.name);
    });
    v.dataset.route=parsed.name;
    document.documentElement.removeAttribute('data-role-accent'); // set again by role screens (role-ui.js)
    var needs = routes[parsed.name] && ROUTE_NEEDS[parsed.name];
    if (needs && !needs.some(function (p) { return can(p); })) {
      v.innerHTML = '<div class="m-error" data-no-permission>You don’t have permission for this screen. Ask an administrator if you need it.</div>';
      return;
    }
    try {
      fn(v, parsed.params);
    } catch (e) {
      v.innerHTML = '<div class="m-error">' + (e && e.message ? e.message : 'Something went wrong') + '</div>';
    }
  }

  /* ---------- auth ---------- */
  function showLogin() {
    window.mPersonalDraft?.clear();window.GuideTour?.close();window.PersonalUX?.release();
    me = null;
    API.clearToken();
    if (window.mQueue) mQueue.clearToken();
    paintSharedBanner();
    if (window.ChatWS) ChatWS.disconnect();
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    var pw = document.getElementById('m-password');
    if (pw) pw.value = '';
  }

  // mobile.access is in every role by default (src/shared/permissions.ts BASELINE), so a new
  // account can sign in here straight away. The phone warehouse tools and an employee link (Clock
  // is universal) also let a person in, as they did before mobile.access existed.
  function hasAccess() { return can('mobile.access') || can('inventory.mobile') || !!(me && me.employee); }

  function showBlocked() {
    appScreen().classList.remove('hidden');
    loginScreen().classList.add('hidden');
    document.getElementById('m-back').classList.add('hidden');
    document.getElementById('m-segments').classList.add('hidden');
    document.getElementById('m-tabbar').classList.add('hidden');
    setTitle('Otom');
    viewEl().innerHTML =
      '<div class="m-blocked">' +
      '<div class="m-blocked-icon">&#128683;</div>' +
      '<h2>Nothing here for you yet</h2>' +
      '<p>This account isn\'t set up for the phone app. Ask an administrator to turn on ' +
      '<b>Use the phone app</b> for your role or account, or ask HR to link your account to your employee record.</p>' +
      '<button class="m-btn m-btn-secondary" id="m-blocked-out">Sign out</button></div>';
    document.getElementById('m-blocked-out').onclick = signOut;
  }

  var ME_KEY = 'vds_m_me';

  /* ---------- one person's data on a shared phone ----------
     Device-level keys survive; every other vds_* key is one person's (cached profile, recent
     items, drafts — including the anonymous-report draft). OWNER_KEY records whose they are, so
     the next different person to sign in here gets them cleared before seeing anything. */
  var DEVICE_KEYS = { vds_theme: 1, vds_device_id: 1, vds_kiosk_token: 1, vds_token: 1, vds_m_seg: 1, vds_m_orbit_v2: 1 };
  var OWNER_KEY = 'vds_m_owner';

  function clearUserData() {
    try {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('vds_') === 0 && !DEVICE_KEYS[k]) drop.push(k);
      }
      drop.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* storage blocked */ }
    try { sessionStorage.removeItem(ME_KEY); } catch (e) { /* ignore */ }
  }

  /** Sign out of this phone: send (or knowingly leave) this person's queued actions, stop their
      notifications here, end the session, and — on a borrowed phone — leave none of their data. */
  function signOut() {
    var q = window.mQueue;
    var shared = API.isSharedSession();
    var flushed = q && navigator.onLine ? q.flush().catch(function () {}) : Promise.resolve();
    return flushed
      .then(function () { return q ? q.count() : 0; })
      .catch(function () { return 0; })
      .then(function (n) {
        if (n && !window.confirm(
          n + (n === 1 ? ' of your actions hasn’t' : ' of your actions haven’t') + ' been sent yet. ' +
          (shared
            ? 'This is a borrowed phone — they only send if you sign in on it again. Sign out anyway?'
            : 'They stay on this phone and send the next time you sign in here. Sign out anyway?'))) return false;
        var push = window.mPush && mPush.release ? mPush.release().catch(function () {}) : Promise.resolve();
        return push
          .then(function () { return API.post('/auth/logout').catch(function () {}); })
          .then(function () {
            if (shared) clearUserData();
            try { localStorage.removeItem(ME_KEY); sessionStorage.removeItem(ME_KEY); } catch (e) { /* ignore */ }
            if (q) q.clearToken();
            API.clearToken();
            if (window.ChatWS) ChatWS.disconnect();
            location.hash = '';
            location.reload();
            return true;
          });
      });
  }

  function paintSharedBanner() {
    var el = document.getElementById('m-shared-banner');
    if (!el) return;
    var on = !!me && API.isSharedSession();
    el.classList.toggle('hidden', !on);
    var out = el.querySelector('[data-shared-out]');
    if (out) out.onclick = signOut;
  }

  function temporaryPasswordScreen() {
    loginScreen().classList.add('hidden'); appScreen().classList.remove('hidden');
    ['m-back', 'm-segments', 'm-tabbar'].forEach(function (id) { var element = document.getElementById(id); if (element) element.classList.add('hidden'); });
    setTitle('Choose a new password');
    if (window.ChatWS) ChatWS.disconnect();
    viewEl().innerHTML = '<form id="m-new-password-form">' +
      '<p>Replace your temporary password before accessing the workspace.</p>' +
      '<label>Temporary password</label><input id="m-temp-password" type="password" autocomplete="current-password" required />' +
      '<label>New password</label><input id="m-new-password" type="password" autocomplete="new-password" minlength="8" required />' +
      '<label>Confirm new password</label><input id="m-confirm-password" type="password" autocomplete="new-password" required />' +
      '<p id="m-password-error" role="status"></p><button class="m-btn" type="submit">Save new password</button>' +
      '<button class="m-btn m-btn-secondary" id="m-password-out" type="button">Sign out</button></form>';
    document.getElementById('m-password-out').onclick = function () { API.post('/auth/logout').catch(function () {}).finally(showLogin); };
    document.getElementById('m-new-password-form').onsubmit = async function (e) {
      e.preventDefault();
      var err = document.getElementById('m-password-error'); var button = e.target.querySelector('[type="submit"]');
      var pw = document.getElementById('m-new-password').value;
      if (pw !== document.getElementById('m-confirm-password').value) { err.textContent = 'Passwords do not match.'; return; }
      button.disabled = true;
      try {
        await API.post('/auth/change-password', { current_password: document.getElementById('m-temp-password').value, new_password: pw });
        e.target.querySelectorAll('input').forEach(function (input) { input.value = ''; });
        enterApp((await API.get('/auth/me')).user);
      } catch (ex) { err.textContent = ex.message; }
      finally { button.disabled = false; }
    };
  }

  /* Two-step sign-in (server: src/shared/mfa.ts). A full-screen step like the temporary-password
     screen: hide the chrome, show one small form. */
  function bareScreen(title, html) {
    loginScreen().classList.add('hidden'); appScreen().classList.remove('hidden');
    ['m-back', 'm-segments', 'm-tabbar'].forEach(function (id) { var element = document.getElementById(id); if (element) element.classList.add('hidden'); });
    setTitle(title);
    if (window.ChatWS) ChatWS.disconnect();
    viewEl().innerHTML = html;
  }

  /** After a correct password: the authenticator code (or a recovery code). */
  function mfaCodeScreen(mfaToken, shared) {
    bareScreen('Two-step sign-in', '<form id="m-mfa-form">' +
      '<p>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>' +
      '<input id="m-mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required />' +
      '<p id="m-mfa-error" role="status"></p><button class="m-btn" type="submit">Sign in</button>' +
      '<button class="m-btn m-btn-secondary" id="m-mfa-back" type="button">Back</button></form>');
    document.getElementById('m-mfa-back').onclick = showLogin;
    document.getElementById('m-mfa-form').onsubmit = async function (e) {
      e.preventDefault();
      var err = document.getElementById('m-mfa-error'); var button = e.target.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        var res = await API.post('/auth/login/mfa', { mfa_token: mfaToken, code: document.getElementById('m-mfa-code').value.trim() });
        API.setToken(res.token, { shared: shared });
        enterApp((await API.get('/auth/me')).user);
      } catch (ex) { err.textContent = ex.message; button.disabled = false; }
    };
    setTimeout(function () { var c = document.getElementById('m-mfa-code'); if (c) c.focus(); }, 50);
  }

  /** The workspace requires two-step sign-in for this account: set it up before anything else. */
  function mfaSetupScreen() {
    var signOutBtn = '<button class="m-btn m-btn-secondary" data-mfa-out type="button">Sign out</button>';
    var wireOut = function () { var b = viewEl().querySelector('[data-mfa-out]'); if (b) b.onclick = function () { API.post('/auth/logout').catch(function () {}).finally(showLogin); }; };
    bareScreen('Set up two-step sign-in', '<form id="m-mfa-pw">' +
      '<p>Your workspace requires two-step sign-in for your account. You need an authenticator app ' +
      '(Google Authenticator, Microsoft Authenticator, Authy…).</p>' +
      '<label>Your password</label><input id="m-mfa-password" type="password" autocomplete="current-password" required />' +
      '<p id="m-mfa-error" role="status"></p><button class="m-btn" type="submit">Continue</button>' + signOutBtn + '</form>');
    wireOut();
    document.getElementById('m-mfa-pw').onsubmit = async function (e) {
      e.preventDefault();
      var err = document.getElementById('m-mfa-error');
      var s;
      try { s = await API.post('/auth/mfa/setup', { password: document.getElementById('m-mfa-password').value }); }
      catch (ex) { err.textContent = ex.message; return; }
      var key = String(s.secret).replace(/(.{4})/g, '$1 ').trim();
      viewEl().innerHTML = '<form id="m-mfa-enable">' +
        '<p><a class="m-btn" href="' + mEsc(s.otpauth_url) + '">Open in authenticator app</a></p>' +
        '<p>Or add an account in the app and type this key: <strong style="user-select:all">' + mEsc(key) + '</strong></p>' +
        '<label>Code the app shows</label><input id="m-mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />' +
        '<p id="m-mfa-error" role="status"></p><button class="m-btn" type="submit">Turn on</button>' + signOutBtn + '</form>';
      wireOut();
      document.getElementById('m-mfa-enable').onsubmit = async function (ev) {
        ev.preventDefault();
        var err2 = document.getElementById('m-mfa-error');
        var r;
        try { r = await API.post('/auth/mfa/enable', { code: document.getElementById('m-mfa-code').value.trim() }); }
        catch (ex) { err2.textContent = ex.message; return; }
        viewEl().innerHTML = '<p><strong>Two-step sign-in is on.</strong> Save these recovery codes somewhere safe — each signs you in once ' +
          'if you lose your phone. They won\'t be shown again.</p><pre style="user-select:all">' + r.recovery_codes.map(mEsc).join('\n') + '</pre>' +
          '<button class="m-btn" id="m-mfa-done" type="button">I saved them</button>';
        document.getElementById('m-mfa-done').onclick = async function () { enterApp((await API.get('/auth/me')).user); };
      };
    };
  }

  function enterApp(user) {
    me = user;
    if (user.password_change_required) {
      try { localStorage.removeItem(ME_KEY); sessionStorage.removeItem(ME_KEY); } catch (e) {}
      temporaryPasswordScreen(); return;
    }
    if (user.mfa_setup_required) { mfaSetupScreen(); return; }
    var cached = cachedMe();
    var prevOwner = null;
    try { prevOwner = localStorage.getItem(OWNER_KEY); } catch (e) { /* ignore */ }
    if (prevOwner == null && cached) prevOwner = String(cached.id);
    if (prevOwner !== String(user.id)) clearUserData(); // someone else's leftovers
    try {
      localStorage.setItem(OWNER_KEY, String(user.id));
      // A borrowed-phone sign-in keeps its profile cache with its token, in sessionStorage.
      (API.isSharedSession() ? sessionStorage : localStorage).setItem(ME_KEY, JSON.stringify(user));
    } catch (e) { /* ignore */ }
    if (window.mQueue) mQueue.setToken(API.getToken(), user);
    paintSharedBanner();
    if (!hasAccess()) { showBlocked(); return; }
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');
    document.getElementById('m-tabbar').classList.remove('hidden');

    if (window.mQuickOrbit) mQuickOrbit.refresh();

    refreshInboxBadge();
    if (window.ChatWS) {
      ChatWS.off('message:new', refreshInboxBadge);
      ChatWS.off('message:deleted', refreshInboxBadge);
      ChatWS.on('message:new', refreshInboxBadge);
      ChatWS.on('message:deleted', refreshInboxBadge);
      ChatWS.connect();
    }
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.hash = hashFor('home');
    } else {
      render();
    }
  }

  function cachedMe() {
    try { return JSON.parse(sessionStorage.getItem(ME_KEY) || localStorage.getItem(ME_KEY) || 'null'); } catch (e) { return null; }
  }

  /* ---------- badges ---------- */
  function refreshInboxBadge() {
    API.get('/messages/unread-count').then(function (r) {
      var n = (r && (r.count != null ? r.count : r.unread)) || 0;
      [document.getElementById('m-tab-inbox-badge')].forEach(function (el) {
        if (!el) return;
        el.textContent = n > 99 ? '99+' : n;
        el.classList.toggle('hidden', !n);
      });
    }).catch(function () {});
  }

  function boot() {
    // The installed phone app first needs to know which server to use (mobile/native.js, §29).
    if (window.VDS_NATIVE && window.VdsNative && !API.base()) { window.VdsNative.showConnect(boot); return; }
    document.getElementById('m-back').onclick = back;
    document.getElementById('m-notifications-top').onclick = function () { go('notifications'); };

    // bottom tab bar
    document.querySelectorAll('#m-tabbar .m-tab').forEach(function (t) {
      t.onclick = function () {
        var tab = t.dataset.tab;
        if (tab === 'home') go('home');
        else if (tab === 'work') go('work');
        else if (tab === 'clock') go('clock');
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
      var sharedBox = document.getElementById('m-shared');
      var shared = !!(sharedBox && sharedBox.checked);
      var body = {
        username: document.getElementById('m-username').value.trim(),
        password: document.getElementById('m-password').value,
      };
      if (shared) body.shared = true;
      API.post('/auth/login', body)
        .then(function (res) {
          if (res.mfa_required) { if (sharedBox) sharedBox.checked = false; mfaCodeScreen(res.mfa_token, shared); return; }
          API.setToken(res.token, { shared: shared });
          if (sharedBox) sharedBox.checked = false;
          return API.get('/auth/me').then(function (profile) { enterApp(profile.user); });
        })
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

  // The installed phone app serves its own bundled pages: no service worker there (§29).
  if ('serviceWorker' in navigator && !window.VDS_NATIVE) {
    var hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register((window.VDS_BASE_PATH || '') + '/mobile/sw.js', { scope: (window.VDS_BASE_PATH || '') + '/m' }).catch(function () {});
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
    seg: seg, setTitle: setTitle, render: render, currentLocation: parseHash, refreshInboxBadge: refreshInboxBadge,
    signOut: signOut, isSharedSession: function () { return API.isSharedSession(); },
    routes: function () { return Object.keys(routes); },
  };
})();
