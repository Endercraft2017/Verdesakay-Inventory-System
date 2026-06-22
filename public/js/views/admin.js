/* Accounts (admin only): manage users + departments. */
App.register('admin', async (view) => {
  if (!App.isAdmin()) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Accounts &amp; Departments</h2>
      <div class="grow"></div>
      <button class="btn secondary" id="add-dept">${UI.icon('building')} Department</button>
      <button class="btn" id="add-user">${UI.icon('plus')} New account</button>
    </div>
    <div class="panel"><div id="users-table"></div></div>`;

  const tableEl = view.querySelector('#users-table');

  function deptSelect(field, selected) {
    return `<select data-f="${field}"><option value="">— None —</option>` +
      App.getDepartments().map((d) =>
        `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('') +
      '</select>';
  }

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const users = await API.get('/users');
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td><strong>${UI.esc(u.full_name)}</strong></td>
            <td class="mono">@${UI.esc(u.username)}</td>
            <td><span class="badge-pill role-${u.role}">${u.role}</span></td>
            <td>${UI.esc(u.department_name || '—')}</td>
            <td>${u.active ? '<span class="badge-pill ok">Active</span>' : '<span class="badge-pill low">Disabled</span>'}</td>
            <td class="actions">
              <button class="icon-btn" title="Edit" data-edit="${u.id}">${UI.icon('edit')}</button>
              <button class="icon-btn" title="Reset password" data-pw="${u.id}">${UI.icon('key')}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editUser(users.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => resetPw(users.find((x) => x.id == b.dataset.pw)));
  }

  function addUser() {
    UI.modal({
      title: 'Create new account',
      bodyHTML: `
        <div class="field-row">
          <div><label>Full name *</label><input data-f="full_name" /></div>
          <div><label>Username *</label><input data-f="username" placeholder="letters, numbers, . _ -" /></div>
        </div>
        <div class="field-row">
          <div><label>Role</label><select data-f="role"><option value="employee">Employee</option><option value="admin">Administrator</option></select></div>
          <div><label>Department</label>${deptSelect('department_id', null)}</div>
        </div>
        <div><label>Temporary password *</label><input data-f="password" type="text" placeholder="min 6 characters" /></div>
        <p class="muted" style="font-size:12px">Share this with the employee; they can change it under My Account.</p>`,
      confirmText: 'Create account',
      onConfirm: async (overlay, showErr) => {
        const get = (f) => overlay.querySelector(`[data-f="${f}"]`).value;
        if (!get('full_name').trim() || !get('username').trim() || !get('password')) {
          showErr('Full name, username and password are required'); return false;
        }
        await API.post('/users', {
          full_name: get('full_name'), username: get('username'), password: get('password'),
          role: get('role'), department_id: get('department_id') || null,
        });
        UI.toast('Account created');
        load();
      },
    });
  }

  function editUser(u) {
    UI.modal({
      title: 'Edit ' + u.full_name,
      bodyHTML: `
        <div><label>Full name</label><input data-f="full_name" value="${UI.esc(u.full_name)}" /></div>
        <div class="field-row">
          <div><label>Role</label><select data-f="role">
            <option value="employee" ${u.role === 'employee' ? 'selected' : ''}>Employee</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option></select></div>
          <div><label>Department</label>${deptSelect('department_id', u.department_id)}</div>
        </div>
        <div><label>Status</label><select data-f="active">
          <option value="1" ${u.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.active ? 'selected' : ''}>Disabled</option></select></div>`,
      confirmText: 'Save',
      onConfirm: async (overlay) => {
        const get = (f) => overlay.querySelector(`[data-f="${f}"]`).value;
        await API.put('/users/' + u.id, {
          full_name: get('full_name'), role: get('role'),
          department_id: get('department_id') || null, active: get('active') === '1',
        });
        UI.toast('Account updated');
        load();
      },
    });
  }

  function resetPw(u) {
    UI.modal({
      title: 'Reset password — ' + u.full_name,
      bodyHTML: `<div><label>New password *</label><input data-f="pw" type="text" placeholder="min 6 characters" /></div>
        <p class="muted" style="font-size:12px">This signs the user out of all sessions.</p>`,
      confirmText: 'Set password',
      onConfirm: async (overlay, showErr) => {
        const pw = overlay.querySelector('[data-f="pw"]').value;
        if (!pw || pw.length < 6) { showErr('Password must be at least 6 characters'); return false; }
        await API.post(`/users/${u.id}/reset-password`, { new_password: pw });
        UI.toast('Password reset');
      },
    });
  }

  function addDept() {
    UI.modal({
      title: 'New department',
      bodyHTML: `<div><label>Department name *</label><input data-f="name" /></div>`,
      confirmText: 'Add',
      onConfirm: async (overlay, showErr) => {
        const name = overlay.querySelector('[data-f="name"]').value.trim();
        if (!name) { showErr('Name is required'); return false; }
        const d = await API.post('/users/departments', { name });
        App.getDepartments().push(d);
        App.getDepartments().sort((a, b) => a.name.localeCompare(b.name));
        UI.toast('Department added');
      },
    });
  }

  view.querySelector('#add-user').addEventListener('click', addUser);
  view.querySelector('#add-dept').addEventListener('click', addDept);
  await load();
});
