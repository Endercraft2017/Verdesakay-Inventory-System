/* My Account: profile summary + change own password. */
App.register('account', async (view) => {
  const me = App.getMe();
  view.innerHTML = `
    <div class="topbar"><h2>My Account</h2></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:760px;">
      <div class="panel">
        <div class="panel-head"><h3>Profile</h3></div>
        <div class="panel-body">
          <p><span class="muted">Name:</span> <strong>${UI.esc(me.full_name)}</strong></p>
          <p><span class="muted">Username:</span> <span class="mono">@${UI.esc(me.username)}</span></p>
          <p><span class="muted">Role:</span> <span class="badge-pill role-${me.role}">${me.role}</span></p>
          <p><span class="muted">Department:</span> ${UI.esc(me.department_name || '—')}</p>
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
