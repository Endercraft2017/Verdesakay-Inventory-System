/* Profile & Settings — employee identity, preferences, documents, and account controls. */
MApp.route('settings', function (view) {
  var authMe = MApp.getMe() || {};
  var employee = authMe.employee || {};
  // preferredName comes from the account (GET /me → employee.preferred_name); it's only a
  // display name and never replaces the legal employee name.
  var profile = { preferredName: employee.preferred_name || '', employee: employee };
  var NICK_KEY = 'vds_profile_nickname'; // legacy device-only nickname, offered once for carry-over

  function esc(v) { return mEsc(v == null || v === '' ? 'Not available' : String(v)); }
  function initials(name) {
    return String(name || 'Employee').trim().split(/\s+/).slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || 'E';
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function titleBlock(title, subtitle, back) {
    MApp.setTitle(title);
    return '<div class="profile-titlebar">' +
      (back ? '<button class="profile-back" type="button" data-profile-back aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(title) + '</h1><p>' + mEsc(subtitle) + '</p></div></div>';
  }
  function row(icon, title, copy, action, extra) {
    return '<button class="profile-menu-row" type="button" data-profile-action="' + action + '">' +
      '<span class="profile-menu-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="profile-menu-copy"><b>' + mEsc(title) + '</b><small>' + mEsc(copy) + '</small></span>' +
      (extra || '<span class="profile-chevron" aria-hidden="true">›</span>') + '</button>';
  }
  function mount(html, nodeId) {
    view.innerHTML = '';
    view.setAttribute('data-figma-node', nodeId || '46:953');
    var page = mEl('<section class="profile-page">' + html + '</section>');
    view.appendChild(page);
    var back = page.querySelector('[data-profile-back]');
    if (back) back.onclick = renderHome;
    return page;
  }
  function identity() {
    var e = profile.employee || {};
    var legalName = e.name || authMe.full_name || authMe.username || 'Employee';
    var displayName = profile.preferredName || legalName;
    var position = e.position || authMe.role || 'Employee';
    var dept = e.department_name || authMe.department_name || '';
    return '<article class="profile-identity">' +
      '<div class="profile-avatar">' + mEsc(initials(displayName)) + '</div>' +
      '<div class="profile-identity-copy"><h2>' + mEsc(displayName) + '</h2>' +
      '<p>' + mEsc(position + (dept ? ' · ' + dept : '')) + '</p>' +
      '<span>Employee ID · ' + esc(e.employee_no) + '</span></div></article>';
  }
  function bindActions(page) {
    Array.prototype.forEach.call(page.querySelectorAll('[data-profile-action]'), function (button) {
      button.onclick = function () {
        var action = button.dataset.profileAction;
        if (action === 'personal') renderPersonal();
        else if (action === 'appearance') renderAppearance();
        else if (action === 'security') renderSecurity();
        else if (action === 'payslips') MApp.go('payslips');
        else if (action === 'requests') MApp.go('requests');
        else if (action === 'report') MApp.go('report-problem');
      };
    });
  }
  function renderHome() {
    var page = mount(
      titleBlock('Profile', 'Personal records and preferences') + identity() +
      '<div class="profile-menu">' +
      row('◉', 'Personal details', 'Preferred name, contact details and official record', 'personal') +
      row('▤', 'Pay & documents', 'Payslips and certificates', 'payslips') +
      row('✓', 'Requests', 'Approvals and information changes', 'requests') +
      row('◐', 'Appearance & accessibility', 'Theme, language and display', 'appearance') +
      row('?', 'Help & reporting', 'Identified and anonymous channels', 'report') +
      row('⌁', 'Account & security', 'Password, desktop access and sign out', 'security') +
      '</div>', '46:953');
    bindActions(page);
  }
  function record(label, value) {
    return '<div class="profile-record"><span>' + mEsc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function field(label, key, value, attrs) {
    return '<label class="m-field"><span class="m-label">' + mEsc(label) + '</span>' +
      '<input class="m-input" data-pf="' + key + '" value="' + mEsc(value || '') + '" ' + (attrs || '') + ' /></label>';
  }
  function renderPersonal() {
    var page = mount(
      titleBlock('Personal details', 'Your preferred name, contact details and official record', true) +
      '<div data-personal><div class="m-hint">Loading your details…</div></div>');
    var host = page.querySelector('[data-personal]');
    API.get('/me/profile').then(function (p) { paintPersonal(host, p); }).catch(function (e) {
      host.innerHTML = '';
      var box = mEl('<div class="m-error">' + mEsc(e.offline ? 'You’re offline — your details can’t be loaded right now.' : (e.message || 'Could not load your details')) +
        ' <button class="m-btn m-btn-sm" type="button">Try again</button></div>');
      box.querySelector('button').onclick = renderPersonal;
      host.appendChild(box);
    });
  }
  function paintPersonal(host, p) {
    var o = p.official || {};
    // One-time carry-over of the old device-only nickname: pre-filled, never saved silently.
    var localNick = '';
    try { localNick = localStorage.getItem(NICK_KEY) || ''; } catch (ignore) {}
    var verified = p.verified_at
      ? '<span class="profile-verify ok">Verified by HR' + (p.verified_by_name ? ' · ' + mEsc(p.verified_by_name) : '') + '</span>'
      : p.needs_verification ? '<span class="profile-verify wait">Waiting for HR to verify</span>' : '';
    host.innerHTML =
      '<form class="profile-section" data-profile-form novalidate>' +
        '<div class="profile-section-head"><div><h2>Contact & preferences</h2><p>You can change these yourself</p></div>' + verified + '</div>' +
        field('Preferred name', 'preferred_name', p.preferred_name || localNick, 'maxlength="60" placeholder="How the app greets you" autocomplete="nickname"') +
        (localNick && !p.preferred_name ? '<p class="profile-note">Filled in from the nickname saved on this phone — save to keep it on your account.</p>' : '') +
        field('Mobile number', 'mobile_phone', p.mobile_phone, 'inputmode="tel" autocomplete="tel" placeholder="0917 123 4567"') +
        field('Personal email', 'personal_email', p.personal_email, 'type="email" inputmode="email" autocomplete="email"') +
        '<label class="m-field"><span class="m-label">Home address</span><textarea class="m-input" data-pf="home_address" rows="2" maxlength="500" autocomplete="street-address">' + mEsc(p.home_address || '') + '</textarea></label>' +
        '<h3 class="profile-subhead">Emergency contact</h3>' +
        field('Name', 'emergency_contact_name', p.emergency_contact_name, 'maxlength="120"') +
        field('Relationship', 'emergency_contact_relation', p.emergency_contact_relation, 'maxlength="60" placeholder="e.g. Spouse, Parent"') +
        field('Phone', 'emergency_contact_phone', p.emergency_contact_phone, 'inputmode="tel" placeholder="0917 123 4567"') +
        '<label class="m-field"><span class="m-label">Current password *</span><input class="m-input" type="password" data-pw-confirm autocomplete="current-password" /></label>' +
        '<p class="profile-note">Your password confirms it’s you. Changed contact details go to HR to verify; your preferred name never replaces your legal name.</p>' +
        '<button class="m-v2-primary profile-full-button" type="submit">Save changes</button>' +
      '</form>' +
      '<section class="profile-section"><div class="profile-section-head"><div><h2>Official employee record</h2><p>HR-controlled information</p></div><span class="profile-lock">Read only</span></div>' +
        record('Legal name', o.name) + record('Employee ID', o.employee_no) + record('Position', o.position) +
        record('Department', o.department) + record('Employment status', o.status) +
        '<p class="profile-note">Your legal name, government ID numbers, position, department and other official fields change only after HR approves an information-change request.</p>' +
        '<button class="m-v2-secondary profile-full-button" type="button" data-request-change>Request an information change</button></section>';
    var form = host.querySelector('[data-profile-form]');
    form.onsubmit = function (event) {
      event.preventDefault();
      var pw = form.querySelector('[data-pw-confirm]');
      if (!pw.value) { mToast('Enter your current password to save', 'err'); pw.focus(); return; }
      if (navigator.onLine === false) { mToast('You’re offline — connect to save your details', 'err'); return; }
      var body = { current_password: pw.value };
      Array.prototype.forEach.call(form.querySelectorAll('[data-pf]'), function (input) { body[input.getAttribute('data-pf')] = input.value.trim(); });
      var button = form.querySelector('button[type=submit]');
      button.disabled = true; button.textContent = 'Saving…';
      API.put('/me/profile', body).then(function (res) {
        try { localStorage.removeItem(NICK_KEY); } catch (ignore) {}
        profile.preferredName = res.profile.preferred_name || '';
        mToast(!res.changed.length ? 'No changes to save'
          : res.changed.some(function (k) { return k !== 'preferred_name'; }) ? 'Saved — HR will verify your contact details' : 'Saved');
        paintPersonal(host, Object.assign({}, res.profile, { official: p.official }));
      }).catch(function (e) {
        mToast(e.message || 'Could not save', 'err');
        button.disabled = false; button.textContent = 'Save changes';
        if (/password/i.test(e.message || '')) { pw.value = ''; pw.focus(); }
      });
    };
    host.querySelector('[data-request-change]').onclick = function () {
      MApp.go('requests', { type: 'information_change' });
    };
  }
  function renderAppearance() {
    var page = mount(
      titleBlock('Appearance & accessibility', 'Make the app comfortable to use', true) +
      '<section class="profile-section profile-setting-list">' +
      '<div class="profile-setting"><div><b>Dark mode</b><small>Reduce glare in low-light spaces</small></div><button class="m-toggle" data-theme-btn aria-pressed="' + (currentTheme() === 'dark') + '">' + (currentTheme() === 'dark' ? 'On' : 'Off') + '</button></div>' +
      '<div class="profile-setting"><div><b>Notifications</b><small data-notif-hint>Loading notification status…</small></div><button class="m-toggle" data-notif disabled>…</button></div>' +
      '<div class="profile-setting"><div><b>Language</b><small>Application language</small></div><span class="profile-setting-value">English</span></div></section>' +
      (MApp.can('messages.view') ? '<section class="profile-section"><h2>Message attachment storage</h2><div data-storage><div class="m-hint">Loading…</div></div></section>' : ''));
    var themeBtn = page.querySelector('[data-theme-btn]');
    themeBtn.onclick = function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('vds_theme', next); } catch (ignore) {}
      themeBtn.textContent = next === 'dark' ? 'On' : 'Off';
      themeBtn.setAttribute('aria-pressed', next === 'dark');
    };
    var storageBox = page.querySelector('[data-storage]');
    if (storageBox) {
      API.get('/messages/quota').then(function (q) {
        var pct = q.cap_bytes > 0 ? Math.min(100, Math.round((q.used_bytes / q.cap_bytes) * 100)) : 0;
        var stage = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
        storageBox.innerHTML = '<div class="usage-bar"><div class="usage-fill ' + stage + '" style="width:' + pct + '%"></div></div>' +
          '<div class="m-hint">' + mFmtBytes(q.used_bytes) + ' / ' + mFmtBytes(q.cap_bytes) + ' used (' + pct + '%)' +
          (pct >= 100 ? ' — limit reached' : '') + '</div>';
      }).catch(function (e) { storageBox.innerHTML = '<div class="m-hint">' + mEsc(e.message) + '</div>'; });
    }
    setupNotifications(page);
  }
  function setupNotifications(page) {
    var button = page.querySelector('[data-notif]');
    var hint = page.querySelector('[data-notif-hint]');
    function paint(state) {
      var labels = { on: 'On', off: 'Off', denied: 'Blocked', unsupported: 'N/A', 'no-sw': 'Off', shared: 'Off' };
      button.textContent = labels[state] || 'Off';
      button.setAttribute('aria-pressed', state === 'on');
      button.disabled = state === 'unsupported' || state === 'denied' || state === 'shared';
      hint.textContent = state === 'denied' ? 'Blocked in browser settings' :
        state === 'unsupported' ? 'Not supported on this device' :
        state === 'shared' ? 'Off while you’re signed in on a borrowed phone' :
        state === 'on' ? 'Alerts for messages and important activity' : 'Alerts are off';
      button.dataset.state = state;
    }
    if (!window.mPush) { paint('unsupported'); return; }
    mPush.status().then(paint).catch(function () { paint('off'); });
    button.onclick = function () {
      var before = button.dataset.state;
      button.disabled = true;
      (before === 'on' ? mPush.disable() : mPush.enable()).then(function (state) {
        paint(state);
        if (state === 'on') { mPush.test().catch(function () {}); mToast('Notifications on'); }
      }).catch(function (e) { mToast(e.message || 'Could not change notifications', 'err'); paint(before); });
    };
  }
  function renderSecurity() {
    var page = mount(
      titleBlock('Account & security', 'Password and session controls', true) +
      '<section class="profile-section"><h2>Change password</h2><form data-pw>' +
      '<label class="m-field"><span class="m-label">Current password</span><input type="password" class="m-input" data-cur autocomplete="current-password" /></label>' +
      '<label class="m-field"><span class="m-label">New password</span><input type="password" class="m-input" data-new autocomplete="new-password" /></label>' +
      '<button class="m-btn" type="submit">Update password</button></form></section>' +
      '<section class="profile-section"><h2>Where you’re signed in</h2><div data-sessions><div class="m-hint">Loading…</div></div></section>' +
      '<section class="profile-section"><h2>Other access</h2><a class="m-btn m-btn-secondary profile-full-button" href="' + (window.VDS_BASE_PATH || '') + '/?view=desktop">Switch to the desktop system</a>' +
      '<button class="m-btn m-btn-danger profile-full-button" type="button" data-out>Sign out</button></section>');
    page.querySelector('[data-pw]').onsubmit = function (event) {
      event.preventDefault();
      var cur = page.querySelector('[data-cur]').value;
      var next = page.querySelector('[data-new]').value;
      if (next.length < 6) { mToast('New password must be at least 6 characters', 'err'); return; }
      var button = event.target.querySelector('button');
      button.disabled = true;
      API.post('/auth/change-password', { current_password: cur, new_password: next })
        .then(function () { mToast('Password updated'); event.target.reset(); })
        .catch(function (e) { mToast(e.message || 'Failed', 'err'); })
        .finally(function () { button.disabled = false; });
    };
    page.querySelector('[data-out]').onclick = function () { MApp.signOut(); };
    loadSessions(page.querySelector('[data-sessions]'));
  }
  // Server times are UTC "YYYY-MM-DD HH:MM:SS".
  function when(ts) {
    if (!ts) return '—';
    var d = new Date(ts.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? ts : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function loadSessions(box) {
    API.get('/auth/sessions').then(function (list) {
      var others = list.filter(function (x) { return !x.current; });
      box.innerHTML = list.map(function (x) {
        return '<div class="m-session-row"><div><b>' + mEsc(x.device) +
          (x.current ? '<span class="m-session-tag">This phone</span>' : '') +
          (x.shared ? '<span class="m-session-tag">Borrowed</span>' : '') + '</b>' +
          '<small>Signed in ' + mEsc(when(x.created_at)) + ' · last active ' + mEsc(when(x.last_seen_at)) +
          (x.last_ip || x.ip ? ' · IP ' + mEsc(x.last_ip || x.ip) : '') + '</small></div>' +
          (x.current ? '' : '<button class="m-btn m-btn-sm m-btn-secondary" type="button" data-end="' + mEsc(x.id) + '">Sign out</button>') +
          '</div>';
      }).join('') +
        (others.length ? '<button class="m-btn m-btn-secondary profile-full-button" type="button" data-end-others>Sign out everywhere else</button>' : '');
      Array.prototype.forEach.call(box.querySelectorAll('[data-end]'), function (b) {
        b.onclick = function () {
          b.disabled = true;
          API.post('/auth/sessions/' + encodeURIComponent(b.dataset.end) + '/revoke')
            .then(function () { mToast('Signed out of that device'); loadSessions(box); })
            .catch(function (e) { b.disabled = false; mToast(e.message || 'Failed', 'err'); });
        };
      });
      var all = box.querySelector('[data-end-others]');
      if (all) all.onclick = function () {
        if (!window.confirm('Sign out of every other phone and computer?')) return;
        all.disabled = true;
        API.post('/auth/sessions/revoke-others')
          .then(function (r) { mToast('Signed out of ' + r.ended + ' other session' + (r.ended === 1 ? '' : 's')); loadSessions(box); })
          .catch(function (e) { all.disabled = false; mToast(e.message || 'Failed', 'err'); });
      };
    }).catch(function (e) { box.innerHTML = '<div class="m-hint">' + mEsc(e.message || 'Could not load sessions') + '</div>'; });
  }

  renderHome();
  API.get('/me').then(function (data) {
    profile.employee = data && data.employee ? data.employee : (data || profile.employee);
    profile.preferredName = (profile.employee && profile.employee.preferred_name) || '';
    renderHome();
  }).catch(function () { /* auth identity remains available */ });
});
