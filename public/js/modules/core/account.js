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

    <div class="account-details-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:760px;">
      <div class="panel">
        <div class="panel-head"><h3>Profile details</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pf-err" tabindex="-1" role="alert"></div>
          <label for="pf-name">Display name</label><input id="pf-name" autocomplete="name" value="${UI.esc(me.full_name)}" />
          <label for="pf-username">Username</label><input id="pf-username" value="@${UI.esc(me.username)}" disabled />
          <label for="pf-department">Department</label><input id="pf-department" value="${UI.esc(me.department_name || '—')}" disabled />
          <p class="muted" style="font-size:12px">Role and department are managed by an administrator. Use Change username below to update your login name.</p>
          <button class="btn" id="pf-save" style="margin-top:8px">Save profile</button>
          <p class="auth-status" id="pf-status" role="status"></p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Change password</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pw-err" tabindex="-1" role="alert"></div>
          <label for="cur-pw">Current password</label><input id="cur-pw" data-label="current password" type="password" autocomplete="current-password" />
          <label for="new-pw">New password</label><input id="new-pw" data-label="new password" type="password" autocomplete="new-password" maxlength="128" aria-describedby="account-password-policy" />
          <label for="con-pw">Confirm new password</label><input id="con-pw" data-label="confirmation password" type="password" autocomplete="new-password" maxlength="128" />
          <p class="muted auth-help" id="account-password-policy">Use 8–128 characters. Common passwords are not accepted. Updating your password ends other sessions; this one stays signed in.</p>
          <button class="btn" id="pw-save" style="margin-top:16px">Update password</button>
          <p class="auth-status" id="pw-status" role="status"></p>
        </div>
      </div>
    </div>

    <div class="panel" style="max-width:760px;margin-top:18px">
      <div class="panel-head"><h3>Change username</h3></div>
      <div class="panel-body">
        <p class="muted">Your current username is <b id="acc-current-username">${UI.esc(me.username)}</b>. Your Company ID stays the same.</p>
        <form id="un-form"><div class="form-error hidden" id="un-err" tabindex="-1" role="alert"></div>
          <label for="un-next">New username</label><input id="un-next" autocomplete="username" minlength="3" maxlength="30" pattern="(?:[A-Za-z0-9._]|-){3,30}" required />
          <p class="muted">3–30 letters, numbers, dots, underscores or hyphens. Other sessions will be signed out.</p>
          <label for="un-current">Current password</label><input id="un-current" data-label="username confirmation password" type="password" autocomplete="current-password" required />
          <button class="btn" type="submit" style="margin-top:16px">Update username</button>
          <p class="auth-status" id="un-status" role="status"></p>
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

  AuthControls.passwords(view);
  function feedback(id, message) {
    view.querySelector('#' + id + '-status').textContent = message;
  }
  function showError(id, message, input) {
    const error = view.querySelector('#' + id + '-err');
    error.textContent = message;
    error.classList.remove('hidden');
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    else error.focus();
  }
  view.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    const status = input.closest('.panel-body')?.querySelector('[role="status"]');
    if (status) status.textContent = '';
  }));

  view.querySelector('#un-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    if (button.disabled) return;
    view.querySelector('#un-err').classList.add('hidden');
    button.disabled = true;
    button.textContent = 'Updating…';
    event.target.setAttribute('aria-busy', 'true');
    feedback('un', 'Updating username…');
    try {
      const result = await API.post('/auth/change-username', {
        new_username: view.querySelector('#un-next').value.trim(),
        current_password: view.querySelector('#un-current').value,
      });
      App.setMe({ username: result.username });
      view.querySelector('#pf-username').value = '@' + result.username;
      view.querySelector('#acc-current-username').textContent = result.username;
      view.querySelector('#acc-header-username').textContent = '@' + result.username;
      event.target.reset();
      feedback('un', 'Username updated. Use ' + result.username + ' next time you sign in. Other sessions have ended.');
      UI.toast('Username updated. Use ' + result.username + ' next time you log in.', 'success');
    } catch (error) {
      feedback('un', '');
      showError('un', AuthControls.errorMessage(error));
    } finally {
      button.disabled = false;
      button.textContent = 'Update username';
      event.target.removeAttribute('aria-busy');
    }
  });

  // Update display name once per request, retaining edits after an error.
  view.querySelector('#pf-save').addEventListener('click', async () => {
    const button = view.querySelector('#pf-save');
    if (button.disabled) return;
    view.querySelector('#pf-err').classList.add('hidden');
    feedback('pf', '');
    const input = view.querySelector('#pf-name');
    const full_name = input.value.trim();
    if (!full_name) { showError('pf', 'Name cannot be empty', input); return; }
    button.disabled = true;
    button.textContent = 'Saving…';
    feedback('pf', 'Saving profile…');
    try {
      await API.put('/auth/profile', { full_name });
      App.setMe({ full_name });
      view.querySelector('#acc-name').textContent = full_name;
      feedback('pf', 'Profile saved.');
      UI.toast('Profile updated');
    } catch (error) {
      feedback('pf', '');
      showError('pf', AuthControls.errorMessage(error));
    } finally {
      button.disabled = false;
      button.textContent = 'Save profile';
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
    try { st = await API.get('/auth/mfa'); } catch (e) {
      box.innerHTML = `<div role="alert">${UI.esc(AuthControls.errorMessage(e))}</div><button class="btn secondary small" data-mfa-retry>Retry</button>`;
      box.querySelector('[data-mfa-retry]').onclick = renderMfa;
      return;
    }
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
    revokeAllPreservesCurrent: true,
  });

  // Keep the current session; the server ends every other session after success.
  view.querySelector('#pw-save').addEventListener('click', async () => {
    const button = view.querySelector('#pw-save');
    if (button.disabled) return;
    view.querySelector('#pw-err').classList.add('hidden');
    feedback('pw', '');
    const current = view.querySelector('#cur-pw');
    const next = view.querySelector('#new-pw');
    const confirm = view.querySelector('#con-pw');
    if (!current.value) { showError('pw', 'Enter your current password.', current); return; }
    if (next.value.length < 8 || next.value.length > 128) {
      showError('pw', 'New password must be 8–128 characters', next); return;
    }
    if (next.value !== confirm.value) { showError('pw', 'New passwords do not match', confirm); return; }
    button.disabled = true;
    button.textContent = 'Updating…';
    feedback('pw', 'Updating password…');
    try {
      await API.post('/auth/change-password', { current_password: current.value, new_password: next.value });
      current.value = next.value = confirm.value = '';
      feedback('pw', 'Password updated. This session stays signed in; other sessions have ended.');
      UI.toast('Password updated');
    } catch (error) {
      feedback('pw', '');
      showError('pw', AuthControls.errorMessage(error));
    } finally {
      button.disabled = false;
      button.textContent = 'Update password';
    }
  });
});
