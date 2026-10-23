/* Mobile app — login, hash router, and shared V2 chrome. The persistent dock is
   Home / Work / Clock / Inbox / Profile for every employee. Role operations stay
   in Work and the movable Quick Orbit instead of replacing universal Clock. */
window.MApp = (function () {
  var routes = {};
  var me = null;
  var authFlow = null; // Keep one-time auth screens stable until explicitly completed.

  var loginScreen = function () { return document.getElementById('m-login'); };
  var appScreen = function () { return document.getElementById('m-app'); };
  var viewEl = function () { return document.getElementById('m-view'); };

  function getMe() { return me; }
  function setMe(patch) {
    Object.assign(me, patch);
    try { (API.isSharedSession() ? sessionStorage : localStorage).setItem(ME_KEY, JSON.stringify(me)); } catch (e) { /* storage blocked */ }
  }
  function can(perm) { return me && Array.isArray(me.permissions) && me.permissions.indexOf(perm) !== -1; }
  /** SaaS feature-module entitlement for this workspace (see src/modules.ts). Absent list
      (self-hosted, or pre-login) → treat every module as on. */
  function hasModule(m) { return !me || !Array.isArray(me.modules) || me.modules.indexOf(m) !== -1; }
  function isEmployee() { return hasModule('hr') && !!(me && me.employee); }
  // The warehouse phone tools (stock moves, counts, picking, scan). Floor desks don't hold
  // inventory.mobile (src/shared/permissions.ts): their Work rows, Quick Orbit action and the
  // Production tab follow their own desk permission instead.
  function isWarehouse() { return can('inventory.mobile') && hasModule('inventory'); }
  // The Production tab: anyone with a production action to take — any
  // production.* desk permission (production.view alone is read-only, nothing to do here). A
  // releasing_clerk has none, so the tab stays hidden rather than opening on an empty queue (see
  // public/mobile/modules/manufacturing/production.js's own per-row permission filtering).
  function hasProductionAccess() {
    return hasModule('manufacturing') && !!(me && Array.isArray(me.permissions) &&
      me.permissions.some(function (p) { return p.indexOf('production.') === 0 && p !== 'production.view'; }));
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
  function go(name, params) { var destination = hashFor(name, params); if(window.mPersonalDraft && !mPersonalDraft.allow(destination)) return; location.hash = destination; }
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
    'stock-count-tasks':'work', 'stock-counts': 'work', work: 'work', 'stock-move': 'work', transfer: 'work', damage: 'work', 'new-item': 'work',
    sales:'work',customers:'work','order-tracking':'work','purchase-requests':'work', batch: 'work', 'cycle-count': 'work', receive: 'work', pick: 'work',
    allocate: 'work', 'assign-qr': 'work', 'low-stock': 'work', location: 'work',
    returns:'work','semi-finishing':'work','my-log': 'work', item: 'work', scan: 'work', deliveries: 'work', so: 'work',
    production: 'work', 'job-orders': 'work', 'kit-release': 'work', 'unit-issues': 'work', qc: 'work', repairs: 'work', record: 'work', receiving: 'work',
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
    sales:['orders.view'], 'order-tracking':['orders.view'], customers:['orders.view'],
    'purchase-requests':['purchasing.request','purchasing.manage','purchasing.approve_requests','purchasing.issue_cash','purchasing.settle_requests'],
    returns: ['returns.receive','returns.inspect','returns.dispose','inventory.view','orders.release','orders.view','production.inspect_qc','production.inspect_qa'], 'semi-finishing':['production.approve','production.manage'], allocate: ['inventory.transfer','orders.direct_sale'], batch: ['inventory.adjust'], 'cycle-count': ['inventory.count'], 'stock-counts': ['inventory.count'], 'stock-count-tasks':['inventory.count'],
    damage: ['inventory.adjust'], receive: ['inventory.receive'],
    'sales-service': ['orders.create','orders.edit'], 'sales-order': ['orders.create','orders.edit'], 'sales-new': ['orders.create'],
    'stock-move': ['inventory.adjust'], transfer: ['inventory.transfer'], 'assign-qr': ['inventory.adjust'],
    'new-item': ['inventory.create'],
    'my-log': ['inventory.view'], item: ['inventory.view'], location: ['inventory.view'], 'low-stock': ['inventory.view'],
    // A unit's production record: the broad views, or any desk that handles the unit (src/shared/desk-access.ts).
    record: ['inventory.view', 'production.view', 'production.record', 'production.pause', 'production.manage',
      'production.approve', 'production.inspect_qc', 'production.inspect_qa', 'production.qa_review',
      'production.repairs', 'production.receive', 'orders.release'],
  };

  var ROUTE_MODULES = {
    sales:['sales','inventory'], customers:['sales','inventory'], 'order-tracking':['inventory'],
    'purchase-requests':['purchasing'],
    'semi-finishing':['manufacturing'], returns:['sales'], allocate: ['manufacturing'], production: ['manufacturing'], 'job-orders': ['manufacturing'], 'kit-release': ['manufacturing'],
    'unit-issues': ['manufacturing'], qc: ['manufacturing'], repairs: ['manufacturing'], record: ['manufacturing'], receiving: ['manufacturing'],
    batch: ['inventory'], 'cycle-count': ['inventory'], 'stock-counts': ['inventory'], 'stock-count-tasks':['inventory'], damage: ['inventory'], receive: ['inventory', 'purchasing'],
    'stock-move': ['inventory'], transfer: ['inventory'], 'assign-qr': ['inventory'], 'new-item': ['inventory'],
    'my-log': ['inventory'], item: ['inventory'], location: ['inventory'], 'low-stock': ['inventory'], scan: ['inventory'],
    'sales-service': ['sales','inventory'], 'sales-order': ['sales','inventory'], 'sales-new': ['sales','inventory'], so: ['sales', 'inventory'], deliveries: ['sales']
  };
  var DESK_NEEDS = {
    production: ['production.record', 'production.pause', 'production.manage', 'production.approve', 'production.inspect_qc', 'production.inspect_qa', 'production.qa_review', 'production.repairs', 'production.receive'],
    'job-orders': ['production.record', 'production.pause', 'production.manage', 'production.approve'],
    'kit-release': ['production.kit_release'],
    'unit-issues': ['inventory.adjust', 'production.view', 'production.record', 'production.manage', 'production.inspect_qc', 'production.inspect_qa', 'production.qa_review', 'production.receive', 'production.repairs', 'orders.release'],
    qc: ['production.inspect_qc', 'production.inspect_qa', 'production.qa_review'],
    repairs: ['production.repairs', 'production.inspect_qc', 'production.inspect_qa', 'production.approve'], receiving: ['production.receive'],
    so: ['orders.release'], deliveries: ['delivery.run', 'delivery.manage'],
    scan: ['inventory.mobile', 'inventory.view', 'inventory.adjust', 'production.view', 'production.record', 'production.manage', 'production.approve', 'production.inspect_qc', 'production.inspect_qa', 'production.qa_review', 'production.repairs', 'production.receive', 'orders.release'],
    'confidential-reports': ['reports.confidential']
  };
  function routeEnabled(name) { return (ROUTE_MODULES[name] || []).every(hasModule); }
  function canOpen(name) {
    if(name==='sales'&&(!can('orders.view')||!(can('orders.create')||can('orders.edit'))))return false;
    var needs = ROUTE_NEEDS[name] || DESK_NEEDS[name];
    return routeEnabled(name) && (!needs || needs.some(can));
  }

  function render() {
    if (authFlow) return;
    if(window.mPersonalDraft && !mPersonalDraft.allow()) return;
    if (window.mChatNavigation && !mChatNavigation.allow()) return;
    window.mChatNavigation?.release();
    window.GuideTour?.close();window.PersonalUX?.release();
    window.mChatViewport?.release();
    if (me && me.password_change_required) return;
    if (!me) return;
    if (!hasAccess()) { showBlocked(); return; }
    var parsed = parseHash();
    var fn = routes[parsed.name] || routes.home;
    paintChrome(parsed);
    var v = viewEl();
    v.innerHTML = '';
    window.SlowLoading?.navigation();
    v.scrollTop = 0;
    // Screens tag #m-view (data-figma-node, data-role-screen/-title/-subtitle); the element is
    // reused across routes, so clear every tag or the last screen's role title leaks onward.
    Array.prototype.slice.call(v.attributes).forEach(function (a) {
      if (a.name.indexOf('data-') === 0) v.removeAttribute(a.name);
    });
    v.dataset.route=parsed.name;
    document.documentElement.removeAttribute('data-role-accent'); // set again by role screens (role-ui.js)
    if (!canOpen(parsed.name)) {
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
    window.SlowLoading?.ready();
    if (authFlow) viewEl().replaceChildren(); // Remove one-time codes and credentials on sign-out/back.
    authFlow = null;
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
      '<h2>Phone access isn’t enabled</h2><p class="auth-account">Signed in as <strong>' + mEsc(me.username || me.full_name) + '</strong></p>' +
      '<p>This account isn\'t set up for the phone app. Ask an administrator to turn on ' +
      '<b>Use the phone app</b> for your role or account, or ask HR to link your account to your employee record.</p>' +
      '<button class="m-btn" id="m-check-access">Check access again</button><p role="status" id="m-access-status"></p>' +
      '<button class="m-btn m-btn-secondary" id="m-blocked-out">Sign out / use another account</button></div>';
    document.getElementById('m-blocked-out').onclick = signOut;
    document.getElementById('m-check-access').onclick = async function () {
      if (this.disabled) return;
      var button = this, note = document.getElementById('m-access-status');
      button.disabled = true; button.textContent = 'Checking…'; note.textContent = 'Checking your current access…';
      try {
        var profile = await API.get('/auth/me', { background: true });
        // Use the normal entry path, including password/MFA and permission checks.
        if (profile.user.password_change_required || profile.user.mfa_setup_required ||
            (profile.user.permissions || []).some(function (p) { return p === 'mobile.access' || p === 'inventory.mobile'; }) || profile.user.employee) {
          enterApp(profile.user);
        } else {
          setMe(profile.user);
          note.textContent = 'Access is still not enabled. Ask your administrator to enable phone access or ask HR to link your employee record.';
        }
      } catch (error) { note.textContent = AuthControls.errorMessage(error); }
      finally { button.disabled = false; button.textContent = 'Check access again'; }
    };
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
  var signOutPending = null;
  function confirmUnsent(count, shared) {
    return new Promise(function (resolve) {
      var previousFocus = document.activeElement;
      var dialog = mEl('<dialog class="m-profile-dialog" aria-labelledby="m-unsent-title">' +
        '<h2 id="m-unsent-title">' + (count === null ? 'Couldn’t verify unsent actions' : 'Unsent actions on this phone') + '</h2><p>' +
        (count === null ? 'The queue could not be checked. Some actions may not have been sent.' : count + ' action' + (count === 1 ? ' hasn’t' : 's haven’t') + ' been sent yet.') + '</p><p>' +
        (shared ? 'This is a borrowed phone. These actions only send when you sign in on this phone again.' : 'Unsent actions stay on this phone and send when you sign in here again.') + '</p>' +
        '<div class="m-actions"><button type="button" class="m-btn m-btn-secondary" data-review>Review queue</button><button type="button" class="m-btn m-btn-danger" data-anyway>Sign out anyway</button><button type="button" class="m-btn m-btn-secondary" data-cancel>Cancel</button></div></dialog>');
      document.body.appendChild(dialog);
      var done = false;
      function finish(value) { if (done) return; done = true; dialog.close(); dialog.remove(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); resolve(value); }
      dialog.querySelector('[data-cancel]').onclick = function () { finish(false); };
      dialog.querySelector('[data-review]').onclick = function () { finish(false); go('queue'); };
      dialog.querySelector('[data-anyway]').onclick = function () { finish(true); };
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(false); });
      dialog.showModal();
      dialog.querySelector('[data-cancel]').focus();
    });
  }
  function signOut() {
    if (signOutPending) return signOutPending;
    var triggers = Array.prototype.map.call(document.querySelectorAll('[data-out], [data-shared-out], #m-blocked-out'), function (button) { var old = { button: button, text: button.textContent, disabled: button.disabled }; button.disabled = true; button.textContent = 'Signing out…'; return old; });
    // Lock before touching the queue: repeated taps during slow I/O share this operation.
    signOutPending = Promise.resolve().then(async function () {
      var q = window.mQueue, shared = API.isSharedSession(), count = null;
      if (q && navigator.onLine) { try { await q.flush(); } catch (ignore) {} }
      try { count = q ? await (q.unsentCount ? q.unsentCount() : q.count()) : 0; } catch (ignore) {}
      if ((count === null || count > 0) && !await confirmUnsent(count, shared)) return false;
      if (window.mPush && mPush.release) { try { await mPush.release(); } catch (ignore) {} }
      try { await API.post('/auth/logout'); } catch (ignore) {}
      if (shared) clearUserData();
      try { localStorage.removeItem(ME_KEY); sessionStorage.removeItem(ME_KEY); } catch (ignore) {}
      if (q) q.clearToken();
      API.clearToken();
      if (window.ChatWS) ChatWS.disconnect();
      location.hash = '';
      location.reload();
      return true;
    }).finally(function () {
      signOutPending = null;
      triggers.forEach(function (old) { if (old.button.isConnected) { old.button.disabled = old.disabled; old.button.textContent = old.text; } });
    });
    return signOutPending;
  }

  function paintSharedBanner() {
    var el = document.getElementById('m-shared-banner');
    if (!el) return;
    var on = !!me && API.isSharedSession();
    el.classList.toggle('hidden', !on);
    var out = el.querySelector('[data-shared-out]');
    if (out) out.onclick = signOut;
  }

  function authError(form, error, input) {
    var box = form.querySelector('[data-auth-error]');
    box.textContent = typeof error === 'string' ? error : AuthControls.errorMessage(error);
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    else box.focus();
  }

  function authBusy(form, busy, label) {
    form.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
    form.setAttribute('aria-busy', String(busy));
    var submit = form.querySelector('[type="submit"]');
    if (submit) submit.textContent = label;
  }

  function wireAuthForm(form) {
    AuthControls.passwords(form);
    form.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); });
    });
    var out = form.querySelector('[data-auth-out]');
    if (out) out.onclick = async function () {
      if (out.disabled) return;
      authBusy(form, true, form.querySelector('[type="submit"]')?.textContent);
      try { await API.post('/auth/logout'); } catch (error) { /* Always clear the local gate/session. */ }
      if (form.isConnected) showLogin();
    };
  }

  var authOutHTML = '<button class="m-btn m-btn-secondary" data-auth-out type="button">Sign out</button>';
  var authErrorHTML = '<p class="m-auth-error" data-auth-error role="alert" tabindex="-1"></p>';

  function temporaryPasswordScreen() {
    bareScreen('Choose a new password', '<form id="m-new-password-form" class="m-auth-form">' +
      '<p>Replace your temporary password before accessing the workspace.</p>' +
      '<label for="m-temp-password">Temporary password</label><input id="m-temp-password" data-label="temporary password" type="password" autocomplete="current-password" required />' +
      '<label for="m-new-password">New password</label><input id="m-new-password" data-label="new password" type="password" autocomplete="new-password" minlength="8" maxlength="128" aria-describedby="m-password-policy" required />' +
      '<label for="m-confirm-password">Confirm new password</label><input id="m-confirm-password" data-label="confirmation password" type="password" autocomplete="new-password" maxlength="128" required />' +
      '<p id="m-password-policy" class="m-hint">Use 8–128 characters. Common passwords are not accepted. Choose a password different from the temporary one.</p>' +
      authErrorHTML + '<p data-auth-status role="status"></p><button class="m-btn" type="submit">Save new password</button>' + authOutHTML + '</form>');
    var form = document.getElementById('m-new-password-form'), flow = authFlow, saved = false;
    wireAuthForm(form);
    form.onsubmit = async function (event) {
      event.preventDefault();
      var button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      form.querySelector('[data-auth-error]').textContent = '';
      if (!saved) {
        var current = form.querySelector('#m-temp-password'), next = form.querySelector('#m-new-password'), confirm = form.querySelector('#m-confirm-password');
        if (!current.value) { authError(form, 'Enter your temporary password.', current); return; }
        if (next.value.length < 8 || next.value.length > 128) { authError(form, 'Use 8–128 characters.', next); return; }
        if (next.value !== confirm.value) { authError(form, 'Passwords do not match.', confirm); return; }
        authBusy(form, true, 'Saving…');
        try {
          await API.post('/auth/change-password', { current_password: current.value, new_password: next.value });
          if (authFlow !== flow || !form.isConnected) return;
          saved = true;
          form.querySelectorAll('input').forEach(function (input) { input.value = ''; input.disabled = true; input.required = false; });
          form.querySelector('[data-auth-status]').textContent = 'Password saved. Reopening your workspace…';
        } catch (error) {
          if (form.isConnected) { authError(form, error); authBusy(form, false, 'Save new password'); }
          return;
        }
      } else authBusy(form, true, 'Opening…');
      try {
        var profile = await API.get('/auth/me');
        if (authFlow === flow && form.isConnected) enterApp(profile.user);
      } catch (error) {
        if (form.isConnected) {
          authError(form, 'Your password was saved, but the workspace could not be loaded. Retry access or sign out and use your new password.');
          authBusy(form, false, 'Retry access');
        }
      }
    };
  }

  // These full-screen auth steps retain their DOM until an explicit completion or sign-out.
  function bareScreen(title, html) {
    authFlow = {};
    loginScreen().classList.add('hidden'); appScreen().classList.remove('hidden');
    ['m-back', 'm-segments', 'm-tabbar'].forEach(function (id) { var element = document.getElementById(id); if (element) element.classList.add('hidden'); });
    setTitle(title);
    if (window.ChatWS) ChatWS.disconnect();
    viewEl().innerHTML = html;
  }

  function mfaCodeScreen(mfaToken, shared) {
    bareScreen('Two-step sign-in', '<form id="m-mfa-form" class="m-auth-form">' +
      '<p>Use the code from your authenticator app or a saved recovery code.</p>' +
      '<div class="m-auth-method" role="group" aria-label="Code type"><button class="m-btn m-btn-secondary" type="button" data-method="app" aria-pressed="true">Authenticator app</button><button class="m-btn m-btn-secondary" type="button" data-method="recovery" aria-pressed="false">Recovery code</button></div>' +
      '<label for="m-mfa-code" data-code-label>6-digit code</label><input id="m-mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-describedby="m-code-help" required />' +
      '<p id="m-code-help" class="m-hint">Use the newest code. You can paste it.</p>' + authErrorHTML +
      '<button class="m-btn" type="submit">Sign in</button><button class="m-btn m-btn-secondary" id="m-mfa-back" type="button">Back to password</button></form>');
    var form = document.getElementById('m-mfa-form'), flow = authFlow, signedIn = false;
    var input = form.querySelector('#m-mfa-code');
    wireAuthForm(form);
    form.querySelectorAll('[data-method]').forEach(function (button) {
      button.onclick = function () {
        var recovery = button.dataset.method === 'recovery';
        form.querySelectorAll('[data-method]').forEach(function (other) { other.setAttribute('aria-pressed', String(other === button)); });
        input.dataset.method = button.dataset.method; input.value = ''; input.removeAttribute('aria-invalid');
        input.inputMode = recovery ? 'text' : 'numeric'; input.maxLength = recovery ? 11 : 6;
        form.querySelector('[data-code-label]').textContent = recovery ? 'Recovery code' : '6-digit code';
        form.querySelector('#m-code-help').textContent = recovery ? 'Use one unused recovery code. Letters and numbers are allowed. It works once.' : 'Use the newest code. You can paste it.';
        input.focus();
      };
    });
    document.getElementById('m-mfa-back').onclick = async function () {
      if (signedIn) {
        authBusy(form, true, 'Returning…');
        try { await API.post('/auth/logout'); } catch (error) { /* Clear the local session even offline. */ }
      }
      if (form.isConnected) showLogin();
    };
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (form.querySelector('[type="submit"]').disabled) return;
      form.querySelector('[data-auth-error]').textContent = '';
      if (!signedIn) {
        var code = input.value.trim(), recovery = input.dataset.method === 'recovery';
        if (!(recovery ? /^[0-9a-f]{5}-?[0-9a-f]{5}$/i : /^[0-9]{6}$/).test(code)) {
          authError(form, recovery ? 'Enter a complete recovery code.' : 'Enter a 6-digit code.', input); return;
        }
      }
      authBusy(form, true, signedIn ? 'Opening…' : 'Verifying…');
      try {
        if (!signedIn) {
          var result = await API.post('/auth/login/mfa', { mfa_token: mfaToken, code: input.value.trim() });
          if (authFlow !== flow || !form.isConnected) return;
          API.setToken(result.token, { shared: shared }); signedIn = true;
          input.value = ''; input.required = false; input.disabled = true;
          form.querySelectorAll('[data-method]').forEach(function (button) { button.hidden = true; });
        }
        var profile = await API.get('/auth/me');
        if (authFlow === flow && form.isConnected) enterApp(profile.user);
      } catch (error) {
        if (!form.isConnected) return;
        authError(form, signedIn ? 'Your code was accepted, but the workspace could not be loaded. Retry access or return to your password.' : error);
        if (!signedIn && /sign-in has expired/i.test(error.message)) form.querySelector('#m-code-help').textContent = 'Use Back to password to start a new sign-in.';
        authBusy(form, false, signedIn ? 'Retry access' : 'Sign in');
      }
    };
    input.focus();
  }

  async function copyAuthText(text, button) {
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text); button.textContent = 'Copied';
    } catch (error) {
      var field = button.parentElement.querySelector('[data-copy-fallback]');
      if (!field) { field = document.createElement('textarea'); field.readOnly = true; field.dataset.copyFallback = ''; field.setAttribute('aria-label', 'Text to copy'); button.parentElement.appendChild(field); }
      field.value = text; field.focus(); field.select(); button.textContent = 'Select and copy below';
    } finally { button.disabled = false; }
  }

  function mfaSetupScreen() {
    bareScreen('Set up two-step sign-in', '<form id="m-mfa-pw" class="m-auth-form">' +
      '<p class="m-hint">Step 1 of 3 · Confirm your password</p><p>Your workspace requires two-step sign-in. You need an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.</p>' +
      '<label for="m-mfa-password">Your password</label><input id="m-mfa-password" type="password" autocomplete="current-password" required />' +
      '<p class="m-hint">Next: connect your authenticator, verify its code, then save recovery codes. Nothing is enabled until verification succeeds.</p>' +
      authErrorHTML + '<button class="m-btn" type="submit">Continue</button>' + authOutHTML + '</form>');
    var form = document.getElementById('m-mfa-pw'), flow = authFlow;
    wireAuthForm(form);
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (form.querySelector('[type="submit"]').disabled) return;
      form.querySelector('[data-auth-error]').textContent = '';
      authBusy(form, true, 'Checking…');
      try {
        var setup = await API.post('/auth/mfa/setup', { password: form.querySelector('#m-mfa-password').value });
        if (authFlow === flow && form.isConnected) mfaConnectScreen(setup);
      } catch (error) { if (form.isConnected) { authError(form, error); authBusy(form, false, 'Continue'); } }
    };
  }

  function mfaConnectScreen(setup) {
    bareScreen('Set up two-step sign-in', '<form id="m-mfa-enable" class="m-auth-form">' +
      '<p class="m-hint">Step 2 of 3 · Connect your authenticator</p>' +
      '<p><a class="m-btn" href="' + mEsc(setup.otpauth_url) + '">Open in authenticator app</a></p>' +
      '<p>Or add an account in the app and type this key: <strong style="user-select:all">' + mEsc(String(setup.secret).replace(/(.{4})/g, '$1 ').trim()) + '</strong></p>' +
      '<div class="m-auth-copy"><button class="m-btn m-btn-secondary" type="button" data-copy-key>Copy setup key</button></div>' +
      '<label for="m-mfa-code">Code the app shows</label><input id="m-mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />' +
      authErrorHTML + '<button class="m-btn" type="submit">Turn on</button>' + authOutHTML + '</form>');
    var form = document.getElementById('m-mfa-enable'), flow = authFlow;
    wireAuthForm(form);
    form.querySelector('[data-copy-key]').onclick = function (event) { copyAuthText(setup.secret, event.currentTarget); };
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (form.querySelector('[type="submit"]').disabled) return;
      var input = form.querySelector('#m-mfa-code');
      form.querySelector('[data-auth-error]').textContent = '';
      if (!/^[0-9]{6}$/.test(input.value.trim())) { authError(form, 'Enter a 6-digit code.', input); return; }
      authBusy(form, true, 'Verifying…');
      try {
        var result = await API.post('/auth/mfa/enable', { code: input.value.trim() });
        if (authFlow === flow && form.isConnected) mfaSaveCodesScreen(result.recovery_codes);
      } catch (error) { if (form.isConnected) { authError(form, error); authBusy(form, false, 'Turn on'); } }
    };
  }

  function mfaSaveCodesScreen(codes) {
    bareScreen('Save recovery codes', '<form id="m-mfa-codes" class="m-auth-form">' +
      '<p class="m-hint">Step 3 of 3 · Save recovery codes</p><p><strong>Two-step sign-in is on.</strong> Save these codes somewhere private. Each works once if you lose your phone. They will not be shown again.</p>' +
      '<pre class="m-auth-codes" style="user-select:all">' + codes.map(mEsc).join('\n') + '</pre>' +
      '<div class="m-auth-copy"><button class="m-btn m-btn-secondary" type="button" data-copy-codes>Copy codes</button><button class="m-btn m-btn-secondary" type="button" data-download-codes>Download .txt</button></div>' +
      '<label class="m-auth-saved"><input type="checkbox" data-saved-codes /><span>I saved these recovery codes somewhere safe.</span></label>' +
      '<p class="m-hint">This checkbox is a reminder, not proof that a backup exists. You can also sign out.</p>' + authErrorHTML +
      '<button class="m-btn" type="submit" id="m-mfa-done">Done</button>' + authOutHTML + '</form>');
    var form = document.getElementById('m-mfa-codes'), flow = authFlow;
    wireAuthForm(form);
    form.querySelector('[data-copy-codes]').onclick = function (event) { copyAuthText(codes.join('\n'), event.currentTarget); };
    form.querySelector('[data-download-codes]').onclick = function () {
      var url = URL.createObjectURL(new Blob(['Otom recovery codes — keep private\n' + codes.join('\n')], { type: 'text/plain;charset=utf-8' }));
      var link = document.createElement('a'); link.href = url; link.download = 'otom-recovery-codes.txt';
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (form.querySelector('[type="submit"]').disabled) return;
      form.querySelector('[data-auth-error]').textContent = '';
      if (!form.querySelector('[data-saved-codes]').checked) { authError(form, 'Save your recovery codes before finishing, or choose Sign out.'); return; }
      authBusy(form, true, 'Opening…');
      try {
        var profile = await API.get('/auth/me');
        if (authFlow === flow && form.isConnected) enterApp(profile.user);
      } catch (error) { if (form.isConnected) { authError(form, error); authBusy(form, false, 'Retry access'); } }
    };
  }

  var refreshingAccess = null;
  async function refreshAccess(options) {
    var required=options?.required;
    if (authFlow || !me || !API.getToken() || navigator.onLine === false || document.visibilityState === 'hidden') {
      if(required)throw new Error('Current access could not be checked. Reconnect and retry.');
      return;
    }
    var token=API.getToken(),server=API.base(),userId=me.id;
    function current(){return !authFlow&&token===API.getToken()&&server===API.base()&&me&&me.id===userId;}
    var job=refreshingAccess;
    if(!job||job.token!==token||job.server!==server||job.userId!==userId){
      job={token:token,server:server,userId:userId};refreshingAccess=job;
      job.promise=(async function(){
        var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},12000);
        try {
          var profile=await API.get('/auth/me',{signal:controller.signal,isCurrent:current});
          if(!current())return {error:new Error('The sign-in changed while access was checked.')};
          var next=profile?.user;
          if(!next||next.id!==userId)throw new Error('The current access response could not be verified.');
          if(JSON.stringify([me.role,me.department_id,me.permissions,me.modules,me.can_approve,me.employee,me.password_change_required,me.mfa_setup_required])!==
             JSON.stringify([next.role,next.department_id,next.permissions,next.modules,next.can_approve,next.employee,next.password_change_required,next.mfa_setup_required]))enterApp(next);
          return {ok:true};
        } catch(error){return {error:error};}
        finally{clearTimeout(timer);if(refreshingAccess===job)refreshingAccess=null;}
      })();
    }
    var result=await job.promise;
    // Ordinary background failures keep the scoped offline profile. Workflow openings
    // require a fresh check and show a retry instead of treating that failure as success.
    if(required&&result.error)throw result.error;
    return !!result.ok;
  }

  function enterApp(user) {
    window.SlowLoading?.ready();
    authFlow = null;
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
        else if (tab === 'work') { if(parseHash().name==='work')refreshAccess();else go('work'); }
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
    window.addEventListener('online', function () { setOnline(true); refreshQueueBadge(); refreshAccess(); });
    window.addEventListener('focus', refreshAccess);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState !== 'hidden') refreshAccess(); });
    window.addEventListener('offline', function () { setOnline(false); refreshQueueBadge(); });
    refreshQueueBadge();

    AuthControls.passwords(document.getElementById('m-login-form'));
    // Open the shared recovery flow with the workspace query preserved.
    var recoveryUrl = new URL((window.VDS_BASE_PATH || '') + '/index.html', location.origin);
    recoveryUrl.search = location.search;
    recoveryUrl.searchParams.set('recover', '1');
    document.getElementById('m-recovery').href = recoveryUrl.href;
    document.getElementById('m-login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('m-login-error');
      err.classList.add('hidden');
      var btn = e.target.querySelector('button[type=submit]');
      if (btn.disabled) return;
      btn.textContent = 'Signing in…';
      e.target.setAttribute('aria-busy', 'true');
      document.getElementById('m-login-status').textContent = 'Signing in. Please wait.';
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
          err.textContent = AuthControls.errorMessage(ex);
          err.classList.remove('hidden');
          err.focus();
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Sign in';
          document.getElementById('m-login-form').removeAttribute('aria-busy');
          document.getElementById('m-login-status').textContent = '';
        });
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
    getMe: getMe, setMe: setMe, can: can, hasModule: hasModule, isEmployee: isEmployee, isWarehouse: isWarehouse,
    hasProductionAccess: hasProductionAccess, canApprove: canApprove, canOpen: canOpen, routeEnabled: routeEnabled,
    seg: seg, setTitle: setTitle, render: render, currentLocation: parseHash, refreshInboxBadge: refreshInboxBadge,
    signOut: signOut, isSharedSession: function () { return API.isSharedSession(); },
    refreshAccess: refreshAccess,
    routes: function () { return Object.keys(routes); },
  };
})();
