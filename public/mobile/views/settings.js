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
    ' · <span class="m-role">' + mEsc(me.role || '') + '</span></span></div>' +

    '  <div class="m-set-row"><span>Dark mode</span>' +
    '    <button class="m-toggle" data-theme-btn aria-pressed="' + (currentTheme() === 'dark') + '">' +
    (currentTheme() === 'dark' ? 'On' : 'Off') + '</button></div>' +

    '  <div class="m-set-row"><span>Notifications</span>' +
    '    <button class="m-toggle" data-notif disabled>…</button></div>' +
    '  <div class="m-hint" data-notif-hint></div>' +

    (MApp.can('messages.view') ?
    '  <h3 class="m-h3">Message attachment storage</h3>' +
    '  <div data-storage><div class="m-hint">Loading…</div></div>' : '') +

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

  // Storage usage: attachments sent on internal messages count against a fixed 5 GB
  // per-user pool (see MESSAGE_STORAGE_CAP in src/routes/messages.routes.ts).
  var storageBox = wrap.querySelector('[data-storage]');
  if (storageBox) {
    API.get('/messages/quota').then(function (q) {
      var pct = q.cap_bytes > 0 ? Math.min(100, Math.round((q.used_bytes / q.cap_bytes) * 100)) : 0;
      var stage = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
      storageBox.innerHTML =
        '<div class="usage-bar"><div class="usage-fill ' + stage + '" style="width:' + pct + '%"></div></div>' +
        '<div class="m-hint">' + mFmtBytes(q.used_bytes) + ' / ' + mFmtBytes(q.cap_bytes) + ' used (' + pct + '%)' +
        (pct >= 100 ? ' — limit reached' : '') + '</div>';
    }).catch(function (e) { storageBox.innerHTML = '<div class="m-hint">' + mEsc(e.message) + '</div>'; });
  }

  // Notifications toggle
  var notifBtn = wrap.querySelector('[data-notif]');
  var notifHint = wrap.querySelector('[data-notif-hint]');
  function paintNotif(state) {
    var labels = { on: 'On', off: 'Off', denied: 'Blocked', unsupported: 'N/A', 'no-sw': 'Off' };
    notifBtn.textContent = labels[state] || 'Off';
    notifBtn.setAttribute('aria-pressed', state === 'on');
    notifBtn.disabled = state === 'unsupported' || state === 'denied';
    notifHint.textContent =
      state === 'denied' ? 'Notifications are blocked in your browser settings for this site.' :
      state === 'unsupported' ? 'This device can’t show push notifications.' :
      state === 'on' ? 'You’ll get alerts for low stock and new messages.' : '';
    notifBtn.dataset.state = state;
  }
  if (window.mPush) {
    mPush.status().then(paintNotif).catch(function () { paintNotif('off'); });
    notifBtn.onclick = function () {
      var cur = notifBtn.dataset.state;
      notifBtn.disabled = true;
      var op = cur === 'on' ? mPush.disable() : mPush.enable();
      op.then(function (s) {
        paintNotif(s);
        if (s === 'on') { mPush.test().catch(function () {}); mToast('Notifications on'); }
      }).catch(function (ex) { mToast(ex.message || 'Could not change notifications', 'err'); paintNotif(cur); });
    };
  } else {
    paintNotif('unsupported');
  }

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
