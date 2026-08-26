/* Accounts (users.manage permission): manage users + departments. */
App.register('admin', async (view, filter) => {
  if (!App.hasPermission('users.manage')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Accounts &amp; Departments</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="user-search" placeholder="Search staff…" /></div>
      <button class="btn secondary" id="manage-depts">${UI.icon('building')} Departments</button>
      <button class="btn" id="add-user">${UI.icon('plus')} New account</button>
    </div>
    <div class="panel"><div id="users-table"></div></div>`;

  const tableEl = view.querySelector('#users-table');
  let allUsers = [];
  let userQuery = '';

  const ROLE_LABELS = {
    admin: 'Administrator',
    admin_staff: 'Admin Staff',
    accounting: 'Accounting',
    warehouse: 'Warehouse',
    releasing: 'Releasing',
    csr: 'Customer Service',
    hr: 'HR',
    marketing: 'Marketing',
  };

  // Grouping/labels are a frontend-only presentation concern. The actual permission keys and
  // per-role defaults are NOT duplicated here — they're fetched from GET /users/permissions/catalog
  // (backed by src/permissions.ts) so this view can never drift from the backend's role defaults
  // the way its old hand-copied ROLE_DEFAULTS did (it was missing the hr.view/hr.manage permissions
  // entirely, so admins couldn't grant/revoke them here even though HR accounts had them).
  const PERMISSION_GROUPS = [
    { label: 'Inventory', keys: ['inventory.view','inventory.create','inventory.edit','inventory.delete','inventory.adjust','inventory.configure'] },
    { label: 'Orders', keys: ['orders.view','orders.create','orders.edit','orders.delete'] },
    { label: 'Files', keys: ['forms.view','forms.upload','forms.delete','forms.manage'] },
    { label: 'Messages', keys: ['messages.view','messages.send'] },
    { label: 'Templates', keys: ['templates.view','templates.edit','templates.company'] },
    { label: 'HR', keys: ['hr.view','hr.manage'] },
    { label: 'Admin', keys: ['users.manage'] },
  ];

  let permCatalog = null;
  async function getPermCatalog() {
    if (!permCatalog) permCatalog = await API.get('/users/permissions/catalog');
    // Any backend permission key not covered by a group above still needs to be editable —
    // surface it under "Other" rather than silently dropping it from the UI.
    const known = new Set(PERMISSION_GROUPS.flatMap((g) => g.keys));
    const extra = (permCatalog.permissions || []).filter((p) => !known.has(p));
    permCatalog.groups = extra.length
      ? [...PERMISSION_GROUPS, { label: 'Other', keys: extra }]
      : PERMISSION_GROUPS;
    return permCatalog;
  }

  function roleSelect(field, selected) {
    return `<select data-f="${field}">${
      Object.entries(ROLE_LABELS).map(([v, l]) =>
        `<option value="${v}" ${v === selected ? 'selected' : ''}>${UI.esc(l)}</option>`).join('')
    }</select>`;
  }

  function deptSelect(field, selected) {
    return `<select data-f="${field}"><option value="">— None —</option>` +
      App.getDepartments().map((d) =>
        `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('') +
      '</select>';
  }

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    allUsers = await API.get('/users');
    renderUsers();
  }

  function renderUsers() {
    const q = userQuery.toLowerCase();
    const users = !q ? allUsers : allUsers.filter((u) =>
      (u.full_name + ' ' + u.username + ' ' + (u.department_name || '') + ' ' + u.role).toLowerCase().includes(q));
    if (!users.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'users', title: 'No matching staff', hint: 'Try a different search.' });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr class="clickable" data-open="${u.id}">
            <td><strong>${UI.esc(u.full_name)}</strong></td>
            <td class="mono">@${UI.esc(u.username)}</td>
            <td><span class="badge-pill role-${u.role}">${UI.esc(ROLE_LABELS[u.role] || u.role)}</span></td>
            <td>${UI.esc(u.department_name || '—')}</td>
            <td>${u.active ? '<span class="badge-pill ok">Active</span>' : '<span class="badge-pill low">Disabled</span>'}</td>
            <td class="actions">
              <button class="icon-btn" title="Edit" data-edit="${u.id}">${UI.icon('edit')}</button>
              <button class="icon-btn" title="Reset password" data-pw="${u.id}">${UI.icon('key')}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editUser(allUsers.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => resetPw(allUsers.find((x) => x.id == b.dataset.pw)));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      editUser(allUsers.find((x) => x.id == tr.dataset.open));
    });
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
          <div><label>Role</label>${roleSelect('role', 'admin_staff')}</div>
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
          <div><label>Role</label>${roleSelect('role', u.role)}</div>
          <div><label>Department</label>${deptSelect('department_id', u.department_id)}</div>
        </div>
        <div><label>Status</label><select data-f="active">
          <option value="1" ${u.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.active ? 'selected' : ''}>Disabled</option></select></div>
        <hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">
        <button type="button" class="btn secondary" id="edit-perm-btn" style="width:100%">
          ${UI.icon('key')} Customize permissions
        </button>`,
      confirmText: 'Save',
      onOpen: (overlay) => {
        overlay.querySelector('#edit-perm-btn').onclick = () => openPermEditor(u);
      },
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

  async function openPermEditor(u) {
    const catalog = await getPermCatalog();
    const allPermissions = catalog.groups.flatMap((g) => g.keys);
    let overrides = {};
    try { overrides = JSON.parse(u.permission_overrides || '{}'); } catch { /* ignore */ }
    const roleDefaults = new Set(catalog.roleDefaults[u.role] || []);

    function effectivePerms() {
      const result = new Set();
      for (const p of allPermissions) {
        const ov = overrides[p];
        if (ov === true) result.add(p);
        else if (ov === false) { /* revoked */ }
        else if (roleDefaults.has(p)) result.add(p);
      }
      return result;
    }

    function renderEditor(container) {
      const effective = effectivePerms();
      container.innerHTML = catalog.groups.map((g) => `
        <div style="margin-bottom:12px">
          <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;color:var(--text-muted)">${UI.esc(g.label)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${g.keys.map((k) => {
              const checked = effective.has(k);
              const isOverride = k in overrides;
              const shortKey = k.split('.')[1];
              return `<label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer;padding:3px 8px;border-radius:4px;background:var(--surface-raised)">
                <input type="checkbox" data-perm="${k}" ${checked ? 'checked' : ''} />
                ${UI.esc(shortKey)}${isOverride ? ` <span style="color:var(--accent)">${UI.icon('star', 11)}</span>` : ''}
              </label>`;
            }).join('')}
          </div>
        </div>`).join('');

      container.querySelectorAll('[data-perm]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.perm;
          const isDefault = roleDefaults.has(key);
          const checked = cb.checked;
          if (checked === isDefault) {
            delete overrides[key]; // back to default, no override needed
          } else {
            overrides[key] = checked;
          }
          renderEditor(container); // re-render to update ★ markers
        });
      });
    }

    const editorId = 'perm-editor-' + u.id;
    UI.drawer({
      title: `Permissions — ${UI.esc(u.full_name)}`,
      bodyHTML: `
        <p class="muted" style="font-size:12px;margin-top:0">
          Role: <strong>${UI.esc(ROLE_LABELS[u.role] || u.role)}</strong> · ★ = overridden from role default
        </p>
        <div id="${editorId}"></div>`,
      footHTML: `
        <button class="btn secondary" id="perm-reset">Reset to defaults</button>
        <button class="btn" id="perm-save">Save permissions</button>`,
      onOpen: (el) => {
        renderEditor(el.querySelector(`#${editorId}`));
        el.querySelector('#perm-reset').onclick = () => {
          overrides = {};
          renderEditor(el.querySelector(`#${editorId}`));
          UI.toast('Reset to role defaults (not yet saved)');
        };
        el.querySelector('#perm-save').onclick = async () => {
          await API.put(`/users/${u.id}/permissions`, { overrides });
          // Refresh the user in allUsers to reflect new overrides.
          const idx = allUsers.findIndex((x) => x.id === u.id);
          if (idx >= 0) allUsers[idx] = { ...allUsers[idx], permission_overrides: JSON.stringify(overrides) };
          UI.toast('Permissions saved');
        };
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

  function manageDepartments() {
    const m = UI.modal({
      title: 'Manage departments',
      bodyHTML: '<div id="dept-mgr"><div class="empty">Loading…</div></div>',
      cancelText: 'Close',
    });
    const box = m.overlay.querySelector('#dept-mgr');

    async function renderList() {
      const depts = await API.get('/users/departments');
      box.innerHTML = `
        <div class="field-row" style="align-items:flex-end">
          <div style="flex:1;margin:0"><label>Add department</label><input id="nd-name" placeholder="Department name" /></div>
          <button class="btn" id="nd-add">${UI.icon('plus')} Add</button>
        </div>
        <table style="margin-top:16px">
          <thead><tr><th>Name</th><th class="right">Members</th><th class="right">Items</th><th class="right">Files</th><th></th></tr></thead>
          <tbody>${depts.map((d) => `
            <tr>
              <td><strong>${UI.esc(d.name)}</strong></td>
              <td class="right">${d.user_count}</td>
              <td class="right">${d.item_count}</td>
              <td class="right">${d.form_count}</td>
              <td class="actions">
                <button class="icon-btn" title="Rename" data-rn="${d.id}" data-name="${UI.esc(d.name)}">${UI.icon('edit')}</button>
                <button class="icon-btn danger" title="Delete" data-dd="${d.id}" data-name="${UI.esc(d.name)}">${UI.icon('trash')}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`;

      box.querySelector('#nd-add').onclick = async () => {
        const name = box.querySelector('#nd-name').value.trim();
        if (!name) return;
        try {
          await API.post('/users/departments', { name });
          UI.toast('Department added');
          await App.reloadDepartments();
          await renderList();
          load();
        } catch (e) { UI.toast(e.message, 'error'); }
      };
      box.querySelectorAll('[data-rn]').forEach((b) =>
        b.onclick = () => renameDept(b.dataset.rn, b.dataset.name, renderList));
      box.querySelectorAll('[data-dd]').forEach((b) =>
        b.onclick = () => deleteDept(b.dataset.dd, b.dataset.name, renderList));
    }
    renderList();
  }

  function renameDept(id, current, after) {
    UI.modal({
      title: 'Rename department',
      bodyHTML: `<label>Name</label><input data-f="name" value="${UI.esc(current)}" />`,
      confirmText: 'Save',
      onConfirm: async (overlay, showErr) => {
        const name = overlay.querySelector('[data-f="name"]').value.trim();
        if (!name) { showErr('Name is required'); return false; }
        await API.put('/users/departments/' + id, { name });
        UI.toast('Department renamed');
        await App.reloadDepartments();
        await after();
        load();
      },
    });
  }

  async function deleteDept(id, name, after) {
    const ok = await UI.confirmDialog(
      `Delete "${name}"? Its members, items and files stay but become unassigned (no department).`,
      'Delete'
    );
    if (!ok) return;
    await API.del('/users/departments/' + id);
    UI.toast('Department deleted');
    await App.reloadDepartments();
    await after();
    load();
  }

  view.querySelector('#add-user').addEventListener('click', addUser);
  view.querySelector('#manage-depts').addEventListener('click', manageDepartments);
  view.querySelector('#user-search').addEventListener('input', (e) => {
    userQuery = e.target.value.trim();
    renderUsers();
  });
  await load();

  // Deep-link: the "Departments" tree leaf opens the manager directly.
  if (filter && filter.tab === 'departments') manageDepartments();
});
