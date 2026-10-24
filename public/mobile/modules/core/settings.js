/* Profile & Settings — employee identity, preferences, documents, and account controls. */
MApp.route('settings', function (view) {
  var authMe = MApp.getMe() || {};
  var employee = authMe.employee || {};
  // preferredName comes from the account (GET /me → employee.preferred_name); it's only a
  // display name and never replaces the legal employee name.
  var profile = { preferredName: employee.preferred_name || '', employee: employee };
  var currentSection = 'home', profileVersion = 0, activePage = null;
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
    activePage = page;
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
        else if (action === 'signout') MApp.signOut();
      };
    });
  }
  function renderHome() {
    currentSection = 'home';
    var page = mount(
      titleBlock('Profile', 'Personal records and preferences') + identity() +
      '<div class="profile-menu">' +
      row('◉', 'Personal details', 'Preferred name, contact details and official record', 'personal') +
      row('▤', 'Pay & documents', 'Payslips and certificates', 'payslips') +
      row('✓', 'Requests', 'Approvals and information changes', 'requests') +
      row('◐', 'Appearance & accessibility', 'Theme, language and display', 'appearance') +
      row('?', 'Help & reporting', 'Identified and anonymous channels', 'report') +
      row('⌁', 'Account & security', 'Password, desktop access and sign out', 'security') +
      '</div>' +
      '<button class="m-btn m-btn-secondary m-btn-danger profile-full-button profile-signout" type="button" data-profile-action="signout" data-profile-signout data-out>Sign out</button>', '46:953');
    bindActions(page);
    API.get('/tenant').then(function (tenant) {
      if (!page.isConnected || !tenant.company_id) return;
      var label = document.createElement('p');
      label.className = 'm-hint';
      label.textContent = 'Company ID: ' + tenant.company_id + ' · Log in at otom.afkcube.com';
      page.querySelector('.profile-identity').after(label);
    }).catch(function () {});
  }
  function record(label, value) {
    return '<div class="profile-record"><span>' + mEsc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function field(label, key, value, attrs) {
    return '<label class="m-field"><span class="m-label">' + mEsc(label) + '</span>' +
      '<input class="m-input" data-pf="' + key + '" value="' + mEsc(value || '') + '" ' + (attrs || '') + ' /></label>';
  }
  function renderPersonal() {
    currentSection = 'personal';
    var page = mount(
      titleBlock('Personal details', 'Your preferred name, contact details and official record', true) +
      '<div data-personal><div class="m-hint">Loading your details…</div></div>');
    var host = page.querySelector('[data-personal]');
    API.get('/me/profile').then(function (p) { paintPersonal(host, p); }).catch(function (e) {
      if (!host.isConnected) return;
      host.innerHTML = '';
      var box = mEl('<div class="m-error">' + mEsc(e.offline ? 'You’re offline — your details can’t be loaded right now.' : (e.message || 'Could not load your details')) +
        ' <button class="m-btn m-btn-sm" type="button">Try again</button></div>');
      box.querySelector('button').onclick = renderPersonal;
      host.appendChild(box);
    });
  }
  function paintPersonal(host, p) {
    if (!host.isConnected) return;
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
        '<p data-profile-error class="m-auth-error" role="alert" tabindex="-1"></p><p data-profile-status role="status"></p>' +
        '<button class="m-v2-primary profile-full-button" type="submit">Save changes</button>' +
      '</form>' +
      '<section class="profile-section"><div class="profile-section-head"><div><h2>Official employee record</h2><p>HR-controlled information</p></div><span class="profile-lock">Read only</span></div>' +
        record('Legal name', o.name) + record('Employee ID', o.employee_no) + record('Position', o.position) +
        record('Department', o.department) + record('Employment status', o.status) +
        '<p class="profile-note">Your legal name, government ID numbers, position, department and other official fields change only after HR approves an information-change request.</p>' +
        '<button class="m-v2-secondary profile-full-button" type="button" data-request-change>Request an information change</button></section>';
    var form = host.querySelector('[data-profile-form]');
    AuthControls.passwords(form);
    form.onsubmit = function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type=submit]');
      if (button.disabled) return;
      var error = form.querySelector('[data-profile-error]'), status = form.querySelector('[data-profile-status]');
      error.textContent = ''; status.textContent = '';
      var pw = form.querySelector('[data-pw-confirm]');
      function fail(message, input) {
        error.textContent = message;
        if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
        else error.focus();
      }
      if (!pw.value) { fail('Enter your current password to save.', pw); return; }
      var invalid = Array.prototype.find.call(form.querySelectorAll('[data-pf]'), function (input) { return !input.checkValidity(); });
      if (invalid) { fail(invalid.validationMessage, invalid); return; }
      if (navigator.onLine === false) { fail('You’re offline — connect to save your details.'); return; }
      var body = { current_password: pw.value };
      Array.prototype.forEach.call(form.querySelectorAll('[data-pf]'), function (input) { body[input.getAttribute('data-pf')] = input.value.trim(); });
      button.disabled = true; button.textContent = 'Saving…'; form.setAttribute('aria-busy', 'true');
      API.put('/me/profile', body).then(function (res) {
        try { localStorage.removeItem(NICK_KEY); } catch (ignore) {}
        profileVersion++;
        profile.preferredName = res.profile.preferred_name || '';
        profile.employee = Object.assign({}, profile.employee, { preferred_name: profile.preferredName });
        if (!form.isConnected) return;
        paintPersonal(host, Object.assign({}, res.profile, { official: p.official }));
        host.querySelector('[data-profile-status]').textContent = !res.changed.length ? 'No changes to save.'
          : res.changed.some(function (key) { return key !== 'preferred_name'; }) ? 'Saved — HR will verify your contact details.' : 'Preferred name saved. Your legal name is unchanged.';
      }).catch(function (e) {
        if (!form.isConnected) return;
        fail(AuthControls.errorMessage(e));
        if (/password/i.test(e.message || '')) { pw.value = ''; pw.focus(); }
      }).finally(function () {
        button.disabled = false; button.textContent = 'Save changes'; form.removeAttribute('aria-busy');
      });
    };
    form.querySelectorAll('input,textarea').forEach(function (input) { input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); }); });
    host.querySelector('[data-request-change]').onclick = function () {
      MApp.go('requests', { type: 'information_change' });
    };
  }
  function renderAppearance() {
    currentSection = 'appearance';
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
      function loadStorage() {
        if (storageBox.dataset.loading === 'true') return;
        storageBox.dataset.loading = 'true';
        storageBox.innerHTML = '<div class="m-hint">Loading…</div>';
        API.get('/messages/quota').then(function (q) {
          var pct = q.cap_bytes > 0 ? Math.min(100, Math.round((q.used_bytes / q.cap_bytes) * 100)) : 0;
          var stage = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
          storageBox.innerHTML = '<div class="usage-bar"><div class="usage-fill ' + stage + '" style="width:' + pct + '%"></div></div>' +
            '<div class="m-hint">' + mFmtBytes(q.used_bytes) + ' / ' + mFmtBytes(q.cap_bytes) + ' used (' + pct + '%)' +
            (pct >= 100 ? ' — limit reached' : '') + '</div>';
        }).catch(function (e) {
          storageBox.innerHTML = '<div class="m-error" role="alert">' + mEsc(e.message || 'Could not load storage') + '</div><button type="button" class="m-btn m-btn-sm m-btn-secondary">Retry</button>';
          storageBox.querySelector('button').onclick = loadStorage;
        }).finally(function () { storageBox.dataset.loading = 'false'; });
      }
      loadStorage();
    }
    setupNotifications(page);
  }
  function setupNotifications(page) {
    var button = page.querySelector('[data-notif]'), hint = page.querySelector('[data-notif-hint]');
    var state = 'unknown', busy = false;
    var feedback = mEl('<p class="profile-note" role="status"></p>');
    var retry = mEl('<button type="button" class="m-btn m-btn-sm m-btn-secondary">Check status</button>');
    hint.parentElement.appendChild(feedback); feedback.after(retry);
    function paint(value) {
      state = value;
      button.dataset.state = value;
      button.textContent = { on: 'On', off: 'Off', denied: 'Blocked', shared: 'Off', unsupported: 'N/A', 'no-sw': 'Retry setup', unknown: 'Retry' }[value] || 'Retry';
      button.setAttribute('aria-pressed', String(value === 'on'));
      button.disabled = busy || ['shared', 'denied', 'unsupported'].indexOf(value) !== -1;
      retry.disabled = busy;
      hint.textContent = { on: 'Notifications are on for this account and device.', off: 'Notifications are off. Turn on to allow browser notifications.', denied: 'Blocked in browser settings. Allow notifications there, then check status.', shared: 'Notifications stay off on a borrowed phone.', unsupported: 'Notifications are not supported on this device.', 'no-sw': 'Notification setup is not ready. Reopen the app or check status again.', unknown: 'Couldn’t verify notification status. Your setting has not been changed.' }[value];
    }
    async function check() { paint(window.mPush ? await mPush.status() : 'unsupported'); }
    async function run(change) {
      if (busy || (change && ['shared', 'denied', 'unsupported'].indexOf(state) !== -1)) return;
      busy = true; button.disabled = true; retry.disabled = true;
      feedback.textContent = change ? 'Updating notifications…' : 'Checking status…';
      try {
        if (!change || state === 'unknown' || state === 'no-sw') await check();
        else paint(await (state === 'on' ? mPush.disable() : mPush.enable()));
        feedback.textContent = 'Status checked.';
      } catch (error) {
        if (change) { try { await check(); } catch (ignore) { paint('unknown'); } }
        else paint('unknown');
        feedback.textContent = error.message || 'Could not verify status. Reconnect and retry.';
      } finally { busy = false; paint(state); }
    }
    retry.onclick = function () { run(false); };
    button.onclick = function () { run(true); };
    run(false);
  }
  function renderSecurity() {
    currentSection = 'security';
    var page = mount(
      titleBlock('Account & security', 'Username, password and session controls', true) +
      '<section class="profile-section"><h2>Change username</h2><p data-current-username>Current username: ' + mEsc(MApp.getMe().username) + '</p><form class="m-form profile-account-form" data-username>' +
      '<label class="m-field"><span class="m-label">New username</span><input class="m-input" data-next-username autocomplete="username" minlength="3" maxlength="30" pattern="(?:[A-Za-z0-9._]|-){3,30}" required /></label>' +
      '<p class="profile-note">3–30 letters, numbers, dots, underscores or hyphens. Your Company ID stays the same. Other sessions will be signed out.</p>' +
      '<label class="m-field"><span class="m-label">Current password</span><input type="password" class="m-input" data-username-password autocomplete="current-password" required /></label>' +
      '<button class="m-btn" type="submit">Update username</button></form></section>' +
      '<section class="profile-section"><h2>Change password</h2><form class="m-form profile-account-form" data-pw>' +
      '<label class="m-field"><span class="m-label">Current password</span><input type="password" class="m-input" data-cur data-label="current password" autocomplete="current-password" required /></label>' +
      '<label class="m-field"><span class="m-label">New password</span><input type="password" class="m-input" data-new data-label="new password" autocomplete="new-password" minlength="8" maxlength="128" aria-describedby="m-profile-password-policy" required /></label>' +
      '<label class="m-field"><span class="m-label">Confirm new password</span><input type="password" class="m-input" data-confirm data-label="confirmation password" autocomplete="new-password" maxlength="128" required /></label>' +
      '<p id="m-profile-password-policy" class="profile-note">Use 8–128 characters. Common passwords are not accepted. This phone stays signed in; other sessions end after the change.</p>' +
      '<p data-password-error class="m-auth-error" role="alert" tabindex="-1"></p><p data-password-status role="status"></p>' +
      '<button class="m-btn" type="submit">Update password</button></form></section>' +
      '<section class="profile-section"><h2>Where you’re signed in</h2><div data-sessions><div class="m-hint">Loading…</div></div></section>' +
      '<section class="profile-section"><h2>Other access</h2><a class="m-btn m-btn-secondary profile-full-button" href="' + (window.VDS_BASE_PATH || '') + '/?view=desktop">Switch to the desktop system</a>' +
      '<button class="m-btn m-btn-danger profile-full-button" type="button" data-out>Sign out</button></section>');
    page.querySelector('[data-username]').onsubmit = function (event) {
      event.preventDefault();
      var button = event.target.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      API.post('/auth/change-username', { new_username: page.querySelector('[data-next-username]').value.trim(), current_password: page.querySelector('[data-username-password]').value })
        .then(function (result) {
          MApp.setMe({ username: result.username });
          page.querySelector('[data-current-username]').textContent = 'Current username: ' + result.username;
          event.target.reset();
          mToast('Username updated. Use ' + result.username + ' next time you log in.');
        }).catch(function (error) { mToast(error.message || 'Could not update username', 'err'); })
        .finally(function () { button.disabled = false; });
    };
    var passwordForm = page.querySelector('[data-pw]');
    AuthControls.passwords(passwordForm);
    passwordForm.onsubmit = function (event) {
      event.preventDefault();
      var button = passwordForm.querySelector('[type=submit]');
      if (button.disabled) return;
      var error = passwordForm.querySelector('[data-password-error]'), status = passwordForm.querySelector('[data-password-status]');
      error.textContent = ''; status.textContent = '';
      var current = passwordForm.querySelector('[data-cur]'), next = passwordForm.querySelector('[data-new]'), confirm = passwordForm.querySelector('[data-confirm]');
      function fail(message, input) { error.textContent = message; if (input) input.focus(); else error.focus(); }
      if (!current.value) { fail('Enter your current password.', current); return; }
      if (next.value.length < 8 || next.value.length > 128) { fail('Use 8–128 characters.', next); return; }
      if (next.value !== confirm.value) { fail('New passwords do not match.', confirm); return; }
      button.disabled = true; button.textContent = 'Updating…'; passwordForm.setAttribute('aria-busy', 'true');
      API.post('/auth/change-password', { current_password: current.value, new_password: next.value })
        .then(function () {
          if (!passwordForm.isConnected) return;
          passwordForm.reset();
          status.textContent = 'Password updated. This phone stays signed in; other sessions have ended.';
          loadSessions(page.querySelector('[data-sessions]'));
        }).catch(function (e) { if (passwordForm.isConnected) fail(AuthControls.errorMessage(e)); })
        .finally(function () { button.disabled = false; button.textContent = 'Update password'; passwordForm.removeAttribute('aria-busy'); });
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
  function confirmOtherSessions(box, count, trigger) {
    if (trigger.disabled || box.querySelector('dialog')) return;
    trigger.disabled = true;
    var dialog = mEl('<dialog class="m-profile-dialog" aria-labelledby="profile-signout-title">' +
      '<h2 id="profile-signout-title">Sign out of other devices?</h2><p>End ' + count + ' other active sign-in session' + (count === 1 ? '' : 's') + '. This phone stays signed in.</p>' +
      '<p class="profile-note">Those devices must sign in again. Files already downloaded to them are not removed.</p>' +
      '<p data-error class="m-auth-error" role="alert" tabindex="-1"></p><p data-result role="status"></p>' +
      '<div class="m-actions"><button class="m-btn" type="button" data-confirm>Sign out other devices</button><button class="m-btn m-btn-secondary" type="button" data-close>Cancel</button></div></dialog>');
    box.appendChild(dialog);
    var busy = false;
    var close = dialog.querySelector('[data-close]'), confirm = dialog.querySelector('[data-confirm]');
    function dismiss() { if (!busy) dialog.close(); }
    close.onclick = dismiss;
    dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) { var r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss(); } });
    dialog.addEventListener('close', function () { dialog.remove(); if (trigger.isConnected) { trigger.disabled = false; trigger.focus(); } else if (box.isConnected) { box.tabIndex = -1; box.focus(); } });
    confirm.onclick = async function () {
      if (busy) return;
      busy = true; confirm.disabled = true; close.disabled = true; confirm.textContent = 'Signing out…';
      dialog.querySelector('[data-error]').textContent = '';
      var result;
      try { result = await API.post('/auth/sessions/revoke-others'); }
      catch (error) {
        dialog.querySelector('[data-error]').textContent = AuthControls.errorMessage(error);
        dialog.querySelector('[data-error]').focus();
        confirm.textContent = 'Sign out other devices';
      }
      if (result) {
        dialog.querySelector('[data-result]').textContent = result.ended + ' other session' + (result.ended === 1 ? '' : 's') + ' signed out. This phone stays signed in.';
        confirm.hidden = true; close.textContent = 'Close';
        // Keep this dialog mounted while refreshing the list behind it.
        await loadSessions(box, result.ended + ' other session' + (result.ended === 1 ? '' : 's') + ' signed out. This phone stays signed in.');
      }
      busy = false; confirm.disabled = false; close.disabled = false;
    };
    dialog.showModal();
  }

  async function loadSessions(box, message) {
    if (!box.isConnected || box.dataset.loading === 'true') return;
    box.dataset.loading = 'true'; box.setAttribute('aria-busy', 'true');
    var content = box.querySelector('[data-session-content]');
    if (!content) {
      content = mEl('<div data-session-content></div>');
      box.appendChild(content);
    }
    var feedback = box.querySelector('[data-session-feedback]');
    if (!feedback) { feedback = mEl('<div data-session-feedback role="status"></div>'); box.prepend(feedback); }
    if (message) box.dataset.result = message;
    feedback.textContent = 'Loading sessions…';
    try {
      var list = await API.get('/auth/sessions');
      if (!box.isConnected) return;
      var others = list.filter(function (x) { return !x.current; });
      content.innerHTML = list.length ? list.map(function (x) {
        return '<div class="m-session-row"><div><b>' + mEsc(x.device) +
          (x.current ? '<span class="m-session-tag">This phone</span>' : '') +
          (x.shared ? '<span class="m-session-tag">Borrowed</span>' : '') + '</b>' +
          '<small>Signed in ' + mEsc(when(x.created_at)) + ' · last active ' + mEsc(when(x.last_seen_at || x.created_at)) +
          (x.last_ip || x.ip ? ' · IP ' + mEsc(x.last_ip || x.ip) : '') + '</small></div>' +
          (x.current ? '' : '<button class="m-btn m-btn-sm m-btn-secondary" type="button" data-end="' + mEsc(x.id) + '">Sign out</button>') + '</div>';
      }).join('') : '<p class="m-hint">No active sign-in sessions found.</p>';
      if (others.length) content.insertAdjacentHTML('beforeend', '<button class="m-btn m-btn-secondary profile-full-button" type="button" data-end-others>Sign out everywhere else</button>');
      feedback.textContent = box.dataset.result || '';
      content.querySelectorAll('[data-end]').forEach(function (button) {
        button.onclick = async function () {
          if (button.disabled) return;
          button.disabled = true; button.textContent = 'Signing out…';
          try { await API.post('/auth/sessions/' + encodeURIComponent(button.dataset.end) + '/revoke'); await loadSessions(box, 'Signed out of that device.'); }
          catch (error) { if (box.isConnected) { feedback.textContent = AuthControls.errorMessage(error); button.disabled = false; button.textContent = 'Sign out'; } }
        };
      });
      var all = content.querySelector('[data-end-others]');
      if (all) all.onclick = function () { if (!all.disabled) confirmOtherSessions(box, others.length, all); };
    } catch (error) {
      if (box.isConnected) {
        feedback.textContent = (box.dataset.result ? box.dataset.result + ' ' : '') + AuthControls.errorMessage(error);
        var retry = mEl('<button class="m-btn m-btn-sm m-btn-secondary" type="button" data-session-retry>Retry</button>');
        retry.onclick = function () { loadSessions(box); }; feedback.appendChild(retry);
      }
    } finally {
      box.dataset.loading = 'false'; box.removeAttribute('aria-busy');
      // Remove the initial placeholder once the explicit load state owns this section.
      var placeholder = Array.prototype.find.call(box.children, function (node) { return node.classList.contains('m-hint'); });
      if (placeholder) placeholder.remove();
    }
  }

  renderHome();
  API.get('/me').then(function (data) {
    if (!activePage || !activePage.isConnected || profileVersion) return;
    profile.employee = data && data.employee ? data.employee : (data || profile.employee);
    profile.preferredName = (profile.employee && profile.employee.preferred_name) || '';
    var card = view.querySelector('.profile-identity');
    if (currentSection === 'home' && card) card.outerHTML = identity();
  }).catch(function () { /* auth identity remains available */ });
});
