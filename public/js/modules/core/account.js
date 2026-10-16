/* My Account: profile (with editable name) + change own password + where you're signed in. */
App.register('account', async (view) => {
  const me = App.getMe();
  view.innerHTML = `
    <div class="topbar"><h2>My Account</h2></div>
    <p id="acc-company-id" class="muted" hidden></p>

    <div class="panel" style="max-width:760px;margin-bottom:18px">
      <div class="panel-body" style="display:flex;align-items:center;gap:16px">
        <div class="acc-avatar" title="Default profile image">${UI.icon('user', 30)}</div>
        <div>
          <div style="font-size:18px;font-weight:700" id="acc-name">${UI.esc(me.full_name)}</div>
          <div class="muted"><span id="acc-header-username">@${UI.esc(me.username)}</span> · <span class="badge-pill role-${me.role}">${me.role}</span> · ${UI.esc(me.department_name || 'No department')}</div>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:760px;">
      <div class="panel">
        <div class="panel-head"><h3>Profile details</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pf-err"></div>
          <label>Display name</label><input id="pf-name" value="${UI.esc(me.full_name)}" />
          <label>Username</label><input id="pf-username" value="@${UI.esc(me.username)}" disabled />
          <label>Department</label><input value="${UI.esc(me.department_name || '—')}" disabled />
          <p class="muted" style="font-size:12px">Role and department are managed by an administrator. Use Change username below to update your login name.</p>
          <button class="btn" id="pf-save" style="margin-top:8px">Save profile</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Change password</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pw-err"></div>
          <label>Current password</label><input id="cur-pw" type="password" />
          <label>New password</label><input id="new-pw" type="password" placeholder="min 8 characters" />
          <label>Confirm new password</label><input id="con-pw" type="password" />
          <button class="btn" id="pw-save" style="margin-top:16px">Update password</button>
        </div>
      </div>
    </div>

    <div class="panel" style="max-width:760px;margin-top:18px">
      <div class="panel-head"><h3>Change username</h3></div>
      <div class="panel-body">
        <p class="muted">Your current username is <b id="acc-current-username">${UI.esc(me.username)}</b>. Your Company ID stays the same.</p>
        <form id="un-form"><div class="form-error hidden" id="un-err" role="alert"></div>
          <label for="un-next">New username</label><input id="un-next" autocomplete="username" minlength="3" maxlength="30" pattern="(?:[A-Za-z0-9._]|-){3,30}" required />
          <p class="muted">3–30 letters, numbers, dots, underscores or hyphens. Other sessions will be signed out.</p>
          <label for="un-current">Current password</label><input id="un-current" type="password" autocomplete="current-password" required />
          <button class="btn" type="submit" style="margin-top:16px">Update username</button>
        </form>
      </div>
    </div>
    <div class="panel" style="max-width:760px;margin-top:18px">
      <div class="panel-head"><h3>Two-step sign-in</h3></div>
      <div class="panel-body" id="acc-mfa"><div class="muted">Loading…</div></div>
    </div>

    <div class="panel" style="max-width:760px;margin-top:18px">
      <div class="panel-head"><h3>Where you're signed in</h3></div>
      <div class="panel-body" id="acc-sessions"></div>
    </div>

    ${App.hasPermission('messages.view') ? `
    <div class="panel" style="max-width:760px;margin-top:18px">
      <div class="panel-head"><h3>Message attachment storage</h3></div>
      <div class="panel-body" id="acc-storage">
        <div class="muted">Loading…</div>
      </div>
    </div>` : ''}`;
  API.get('/tenant').then((tenant) => {
    const label = view.querySelector('#acc-company-id');
    if (label && tenant.company_id) { label.textContent = `Company ID: ${tenant.company_id} · Use this ID to log in at otom.afkcube.com`; label.hidden = false; }
  }).catch(() => {});

  view.querySelector('#un-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    const error = view.querySelector('#un-err');
    error.classList.add('hidden'); button.disabled = true;
    try {
      const result = await API.post('/auth/change-username', { new_username: view.querySelector('#un-next').value.trim(), current_password: view.querySelector('#un-current').value });
      App.setMe({ username: result.username });
      view.querySelector('#pf-username').value = '@' + result.username;
      view.querySelector('#acc-current-username').textContent = result.username;
      view.querySelector('#acc-header-username').textContent = '@' + result.username;
      event.target.reset();
      UI.toast('Username updated. Use ' + result.username + ' next time you log in.', 'success');
    } catch (err) { error.textContent = err.message; error.classList.remove('hidden'); }
    finally { button.disabled = false; }
  });


  // Update display name.
  const pfErr = view.querySelector('#pf-err');
  view.querySelector('#pf-save').addEventListener('click', async () => {
    pfErr.classList.add('hidden');
    const full_name = view.querySelector('#pf-name').value.trim();
    if (!full_name) { pfErr.textContent = 'Name cannot be empty'; pfErr.classList.remove('hidden'); return; }
    try {
      await API.put('/auth/profile', { full_name });
      App.setMe({ full_name });
      view.querySelector('#acc-name').textContent = full_name;
      UI.toast('Profile updated');
    } catch (e) {
      pfErr.textContent = e.message; pfErr.classList.remove('hidden');
    }
  });

  // Storage usage: attachments sent on internal messages count against a fixed 5 GB
  // per-user pool (see MESSAGE_STORAGE_CAP in src/routes/messages.routes.ts).
  const storageBox = view.querySelector('#acc-storage');
  if (storageBox) {
    (async () => {
      let q;
      try { q = await API.get('/messages/quota'); }
      catch (e) { storageBox.innerHTML = `<div class="muted">${UI.esc(e.message)}</div>`; return; }
      const pct = q.cap_bytes > 0 ? Math.min(100, Math.round((q.used_bytes / q.cap_bytes) * 100)) : 0;
      const stage = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
      storageBox.innerHTML = `
        <div class="usage-bar"><div class="usage-fill ${stage}" style="width:${pct}%"></div></div>
        <div class="muted" style="font-size:12px;margin-top:6px">
          ${UI.fmtBytes(q.used_bytes)} / ${UI.fmtBytes(q.cap_bytes)} used (${pct}%)${pct >= 100 ? ' — limit reached, delete some old messages to free up space' : ''}
        </div>`;
    })();
  }

  // Two-step sign-in (lib/mfa.js): an authenticator-app code after the password.
  async function renderMfa() {
    const box = view.querySelector('#acc-mfa');
    let st;
    try { st = await API.get('/auth/mfa'); } catch (e) { box.innerHTML = `<div class="muted">${UI.esc(e.message)}</div>`; return; }
    if (!st.available) { box.innerHTML = '<div class="muted">Not used on this installed PC — it applies when you sign in online.</div>'; return; }
    const left = st.recovery_codes_left;
    box.innerHTML = st.enabled
      ? `<p style="margin-top:0"><strong>On.</strong> After your password, you enter a code from your authenticator app.
          <span class="muted">${left} recovery code${left === 1 ? '' : 's'} left.</span></p>
         <div style="display:flex;gap:8px;flex-wrap:wrap">
           <button class="btn secondary" id="mfa-codes">New recovery codes</button>
           ${st.required ? '<span class="muted" style="align-self:center">Required by your workspace.</span>' : '<button class="btn secondary" id="mfa-off">Turn off</button>'}
         </div>`
      : `<p style="margin-top:0"><strong>Off.</strong> Add a code from an authenticator app on your phone, so a stolen
          password alone can't open your account.</p><button class="btn" id="mfa-on">Turn on</button>`;
    const on = box.querySelector('#mfa-on');
    if (on) on.onclick = async () => { if (await Mfa.setup()) { UI.toast('Two-step sign-in is on', 'success'); renderMfa(); } };
    const off = box.querySelector('#mfa-off');
    if (off) off.onclick = async () => { if (await Mfa.disable()) { UI.toast('Two-step sign-in is off'); renderMfa(); } };
    const codes = box.querySelector('#mfa-codes');
    if (codes) codes.onclick = async () => { await Mfa.newRecoveryCodes(); renderMfa(); };
  }
  renderMfa();

  // Sessions: live ones (sign out any but this one) + recent history.
  SessionList.render(view.querySelector('#acc-sessions'), {
    load: () => API.get('/auth/sessions?history=1'),
    revoke: (id) => API.post('/auth/sessions/' + encodeURIComponent(id) + '/revoke'),
    revokeAll: () => API.post('/auth/sessions/revoke-others'),
  });

  // Change password.
  const err = view.querySelector('#pw-err');
  view.querySelector('#pw-save').addEventListener('click', async () => {
    if (view.querySelector('#pw-save').disabled) return;
    err.classList.add('hidden');
    const cur = view.querySelector('#cur-pw').value;
    const nw = view.querySelector('#new-pw').value;
    const con = view.querySelector('#con-pw').value;
    if (nw.length < 8) { err.textContent = 'New password must be at least 8 characters'; err.classList.remove('hidden'); return; }
    if (nw !== con) { err.textContent = 'New passwords do not match'; err.classList.remove('hidden'); return; }
    view.querySelector('#pw-save').disabled = true;
    try {
      await API.post('/auth/change-password', { current_password: cur, new_password: nw });
      UI.toast('Password updated. Sign in again.');
      API.clearToken(); App.showLogin();
      view.querySelector('#cur-pw').value = view.querySelector('#new-pw').value = view.querySelector('#con-pw').value = '';
    } catch (e) {
      err.textContent = e.message; err.classList.remove('hidden');
    } finally { view.querySelector('#pw-save').disabled = false; }
  });
});
