/* Settings — theme, change password, switch to the desktop system. */
MApp.route('settings', function (view) {
  MApp.setTitle('Settings');
  var me = MApp.getMe();

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  var wrap = mEl(
    '<div class="m-form">' +
    '  <div class="m-set-who"><b>' + mEsc(me.full_name) + '</b><span>' + mEsc(me.username) +
    ' · ' + mEsc(me.role || '') + '</span></div>' +

    '  <div class="m-set-row"><span>Dark mode</span>' +
    '    <button class="m-toggle" data-theme-btn aria-pressed="' + (currentTheme() === 'dark') + '">' +
    (currentTheme() === 'dark' ? 'On' : 'Off') + '</button></div>' +

    '  <h3 class="m-h3">Change password</h3>' +
    '  <form data-pw>' +
    '    <label class="m-field"><span class="m-label">Current password</span>' +
    '      <input type="password" class="m-input" data-cur autocomplete="current-password" /></label>' +
    '    <label class="m-field"><span class="m-label">New password</span>' +
    '      <input type="password" class="m-input" data-new autocomplete="new-password" /></label>' +
    '    <div class="m-actions"><button class="m-btn" type="submit">Update password</button></div>' +
    '  </form>' +

    '  <h3 class="m-h3">Other</h3>' +
    '  <div class="m-actions">' +
    '    <a class="m-btn m-btn-secondary" href="/?view=desktop">Switch to the desktop system</a>' +
    '    <button class="m-btn m-btn-secondary" data-out>Sign out</button>' +
    '  </div>' +
    '</div>'
  );

  wrap.querySelector('[data-theme-btn]').onclick = function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('vds_theme', next); } catch (e) { /* ignore */ }
    this.textContent = next === 'dark' ? 'On' : 'Off';
    this.setAttribute('aria-pressed', next === 'dark');
  };

  wrap.querySelector('[data-pw]').onsubmit = function (e) {
    e.preventDefault();
    var cur = wrap.querySelector('[data-cur]').value;
    var nw = wrap.querySelector('[data-new]').value;
    if (nw.length < 6) { mToast('New password must be at least 6 characters', 'err'); return; }
    var btn = e.target.querySelector('button');
    btn.disabled = true;
    API.post('/auth/change-password', { current_password: cur, new_password: nw })
      .then(function () { mToast('Password updated'); wrap.querySelector('[data-cur]').value = ''; wrap.querySelector('[data-new]').value = ''; })
      .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); })
      .finally(function () { btn.disabled = false; });
  };

  wrap.querySelector('[data-out]').onclick = function () {
    API.post('/auth/logout').catch(function () {}).finally(function () { MApp.go('home'); location.reload(); });
  };

  view.appendChild(wrap);
});
