/* My Account: profile (with editable name) + change own password. */
App.register('account', async (view) => {
  const me = App.getMe();
  view.innerHTML = `
    <div class="topbar"><h2>My Account</h2></div>

    <div class="panel" style="max-width:760px;margin-bottom:18px">
      <div class="panel-body" style="display:flex;align-items:center;gap:16px">
        <div class="acc-avatar" title="Default profile image">${UI.icon('user', 30)}</div>
        <div>
          <div style="font-size:18px;font-weight:700" id="acc-name">${UI.esc(me.full_name)}</div>
          <div class="muted">@${UI.esc(me.username)} · <span class="badge-pill role-${me.role}">${me.role}</span> · ${UI.esc(me.department_name || 'No department')}</div>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:760px;">
      <div class="panel">
        <div class="panel-head"><h3>Profile details</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pf-err"></div>
          <label>Display name</label><input id="pf-name" value="${UI.esc(me.full_name)}" />
          <label>Username</label><input value="@${UI.esc(me.username)}" disabled />
          <label>Department</label><input value="${UI.esc(me.department_name || '—')}" disabled />
          <p class="muted" style="font-size:12px">Role and department are managed by an administrator.</p>
          <button class="btn" id="pf-save" style="margin-top:8px">Save profile</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Change password</h3></div>
        <div class="panel-body">
          <div class="form-error hidden" id="pw-err"></div>
          <label>Current password</label><input id="cur-pw" type="password" />
          <label>New password</label><input id="new-pw" type="password" placeholder="min 6 characters" />
          <label>Confirm new password</label><input id="con-pw" type="password" />
          <button class="btn" id="pw-save" style="margin-top:16px">Update password</button>
        </div>
      </div>
    </div>`;

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

  // Change password.
  const err = view.querySelector('#pw-err');
  view.querySelector('#pw-save').addEventListener('click', async () => {
    err.classList.add('hidden');
    const cur = view.querySelector('#cur-pw').value;
    const nw = view.querySelector('#new-pw').value;
    const con = view.querySelector('#con-pw').value;
    if (nw.length < 6) { err.textContent = 'New password must be at least 6 characters'; err.classList.remove('hidden'); return; }
    if (nw !== con) { err.textContent = 'New passwords do not match'; err.classList.remove('hidden'); return; }
    try {
      await API.post('/auth/change-password', { current_password: cur, new_password: nw });
      UI.toast('Password updated');
      view.querySelector('#cur-pw').value = view.querySelector('#new-pw').value = view.querySelector('#con-pw').value = '';
    } catch (e) {
      err.textContent = e.message; err.classList.remove('hidden');
    }
  });
});
