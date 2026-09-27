/* Profile & Settings — employee identity, preferences, documents, and account controls. */
MApp.route('settings', function (view) {
  var authMe = MApp.getMe() || {};
  var employee = authMe.employee || {};
  var profile = { nickname: '', employee: employee };

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
    var displayName = profile.nickname || legalName;
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
      row('◉', 'Personal details', 'Nickname and approved contact details', 'personal') +
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
  function renderPersonal() {
    var e = profile.employee || {};
    var page = mount(
      titleBlock('Personal details', 'Your display preferences and official records', true) +
      '<section class="profile-section"><h2>Display preference</h2>' +
      '<label class="m-field"><span class="m-label">Nickname</span>' +
      '<input class="m-input" data-nickname maxlength="40" value="' + mEsc(profile.nickname) + '" placeholder="How the app addresses you" /></label>' +
      '<p class="profile-note">Nickname is saved on this device only and never replaces your legal employee name.</p>' +
      '<button class="m-btn" type="button" data-save-nickname>Save nickname</button></section>' +
      '<section class="profile-section"><div class="profile-section-head"><div><h2>Official employee record</h2><p>HR-controlled information</p></div><span class="profile-lock">Read only</span></div>' +
      record('Legal name', e.name || authMe.full_name) +
      record('Employee ID', e.employee_no) + record('Position', e.position || authMe.role) +
      record('Department', e.department_name || authMe.department_name) +
      '<p class="profile-note">Names, birth details, salary, position, department and other official fields require approval before changes are applied.</p>' +
      '<button class="m-btn m-btn-secondary" type="button" data-request-change>Request an information change</button></section>' +
      '<aside class="profile-info">Direct contact-detail editing is not enabled by the current employee API. Use a request so HR can verify and approve the change.</aside>');
    page.querySelector('[data-save-nickname]').onclick = function () {
      var value = page.querySelector('[data-nickname]').value.trim();
      profile.nickname = value;
      try { localStorage.setItem('vds_profile_nickname', value); } catch (ignore) {}
      mToast('Nickname saved on this device');
    };
    page.querySelector('[data-request-change]').onclick = function () {
      mToast('Choose the closest request type and describe the information to change');
      MApp.go('requests');
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
      var labels = { on: 'On', off: 'Off', denied: 'Blocked', unsupported: 'N/A', 'no-sw': 'Off' };
      button.textContent = labels[state] || 'Off';
      button.setAttribute('aria-pressed', state === 'on');
      button.disabled = state === 'unsupported' || state === 'denied';
      hint.textContent = state === 'denied' ? 'Blocked in browser settings' :
        state === 'unsupported' ? 'Not supported on this device' :
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
      '<section class="profile-section"><h2>Other access</h2><a class="m-btn m-btn-secondary profile-full-button" href="/?view=desktop">Switch to the desktop system</a>' +
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
    page.querySelector('[data-out]').onclick = function () {
      API.post('/auth/logout').catch(function () {}).finally(function () { MApp.go('home'); location.reload(); });
    };
  }

  try { profile.nickname = localStorage.getItem('vds_profile_nickname') || ''; } catch (ignore) {}
  renderHome();
  API.get('/me').then(function (data) {
    profile.employee = data && data.employee ? data.employee : (data || profile.employee);
    renderHome();
  }).catch(function () { /* auth identity remains available */ });
});
