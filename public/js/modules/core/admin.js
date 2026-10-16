/* Accounts (users.manage permission): accounts, roles (named permission bundles — see
   src/shared/roles.ts) and departments. */
App.register('admin', async (view, filter) => {
  if (!App.hasPermission('users.manage')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Accounts &amp; Roles</h2>
      <div class="seg-switch" id="acct-tabs">
        <button type="button" data-tab="accounts">Accounts</button>
        <button type="button" data-tab="roles">Roles</button>
      </div>
      <div class="grow"></div>
      <div class="search-box search" id="user-search-box">${UI.icon('search', 16)}<input id="user-search" placeholder="Search staff…" /></div>
      <button class="btn secondary" id="manage-depts">${UI.icon('building')} Departments</button>
      <button class="btn secondary" id="sign-in-security">${UI.icon('key')} Sign-in security</button>
      <button class="btn" id="add-user">${UI.icon('plus')} New account</button>
      <button class="btn hidden" id="add-role">${UI.icon('plus')} New role</button>
    </div>
    <div class="panel"><div id="users-table"></div></div>`;

  const tableEl = view.querySelector('#users-table');
  let allUsers = [];
  let userQuery = '';
  let tab = filter && filter.tab === 'roles' ? 'roles' : 'accounts';
  let catalog = await AccessEditor.getCatalog(true);
  const { roleLabel } = AccessEditor;

  // Role picker for the account modals, with a live line saying what the chosen role covers.
  function roleSelect(field, selected) {
    return `<select data-f="${field}">${
      catalog.roles.map((r) =>
        `<option value="${UI.esc(r.key)}" ${r.key === selected ? 'selected' : ''}>${UI.esc(r.label)}</option>`).join('')
    }</select>`;
  }
  function wireRoleHint(overlay) {
    const sel = overlay.querySelector('[data-f="role"]');
    const hint = overlay.querySelector('[data-role-hint]');
    const paint = () => {
      const r = catalog.roles.find((x) => x.key === sel.value);
      hint.textContent = r ? `${r.description ? r.description + ' — ' : ''}${AccessEditor.roleSummary(catalog, r.key)}` : '';
    };
    sel.addEventListener('change', paint);
    paint();
  }
  const ROLE_HINT = '<p class="muted role-hint" data-role-hint></p>';
  function overrideCount(u) {
    try { return Object.keys(JSON.parse(u.permission_overrides || '{}')).length; } catch { return 0; }
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
    if (tab === 'roles') renderRoles(); else renderUsers();
  }

  function setTab(next) {
    tab = next;
    view.querySelectorAll('#acct-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    view.querySelector('#user-search-box').classList.toggle('hidden', tab !== 'accounts');
    view.querySelector('#manage-depts').classList.toggle('hidden', tab !== 'accounts');
    view.querySelector('#sign-in-security').classList.toggle('hidden', tab !== 'accounts');
    view.querySelector('#add-user').classList.toggle('hidden', tab !== 'accounts');
    view.querySelector('#add-role').classList.toggle('hidden', tab !== 'roles');
    if (tab === 'roles') renderRoles(); else renderUsers();
  }

  /* ---------- Roles: named permission bundles ---------- */
  async function reloadRoles() {
    catalog = await AccessEditor.getCatalog(true);
    if (tab === 'roles') renderRoles(); else renderUsers();
  }

  function renderRoles() {
    tableEl.innerHTML = `
      <p class="muted" style="margin:0 0 12px">A role is a set of permissions. Everyone with the role gets them;
        you can still add or remove single permissions for one person from their account's <b>Access</b>.</p>
      <table>
        <thead><tr><th>Role</th><th>Covers</th><th class="right">Accounts</th><th>HR can assign</th><th></th></tr></thead>
        <tbody>${catalog.roles.map((r) => `
          <tr class="clickable" data-role="${UI.esc(r.key)}">
            <td><strong>${UI.esc(r.label)}</strong>${r.fixed ? ' <span class="badge-pill">Fixed</span>' : ''}
              ${r.description ? `<div class="muted" style="font-size:12px">${UI.esc(r.description)}</div>` : ''}</td>
            <td class="muted" style="font-size:12px;max-width:420px">${UI.esc(AccessEditor.roleSummary(catalog, r.key))}</td>
            <td class="right">${r.user_count}</td>
            <td>${r.staff ? '<span class="badge-pill ok">Yes</span>' : '<span class="muted">Admin only</span>'}</td>
            <td class="actions">
              ${r.fixed ? '' : `<button class="icon-btn" title="Edit" data-role-edit="${UI.esc(r.key)}">${UI.icon('edit')}</button>`}
              <button class="icon-btn" title="Duplicate as a new role" data-role-copy="${UI.esc(r.key)}">${UI.icon('file')}</button>
              ${r.fixed ? '' : `<button class="icon-btn danger" title="Delete" data-role-del="${UI.esc(r.key)}">${UI.icon('trash')}</button>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    const byKey = (k) => catalog.roles.find((r) => r.key === k);
    tableEl.querySelectorAll('tr[data-role]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      const r = byKey(tr.dataset.role);
      if (r.fixed) UI.toast('The Administrator role always has every permission');
      else AccessEditor.editRole(r, { onSaved: reloadRoles });
    });
    tableEl.querySelectorAll('[data-role-edit]').forEach((b) => b.onclick = () =>
      AccessEditor.editRole(byKey(b.dataset.roleEdit), { onSaved: reloadRoles }));
    tableEl.querySelectorAll('[data-role-copy]').forEach((b) => b.onclick = () =>
      AccessEditor.editRole(null, { copyFrom: byKey(b.dataset.roleCopy), onSaved: reloadRoles }));
    tableEl.querySelectorAll('[data-role-del]').forEach((b) => b.onclick = () => deleteRole(byKey(b.dataset.roleDel)));
  }

  async function deleteRole(r) {
    if (r.user_count) {
      UI.toast(`${r.user_count} account${r.user_count === 1 ? ' has' : 's have'} this role — move them to another role first`, 'error');
      return;
    }
    if (!(await UI.confirmDialog(`Delete the "${r.label}" role?`, 'Delete'))) return;
    try { await API.del('/roles/' + encodeURIComponent(r.key)); } catch (e) { UI.toast(e.message, 'error'); return; }
    UI.toast('Role deleted');
    reloadRoles();
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
            <td><span class="badge-pill role-${UI.esc(u.role)}">${UI.esc(roleLabel(u.role))}</span>${overrideCount(u)
              ? ' <span class="muted" style="font-size:11.5px" data-tip="Has access added or removed just for this person">+ custom</span>' : ''}</td>
            <td>${UI.esc(u.department_name || '—')}</td>
            <td>${u.active ? '<span class="badge-pill ok">Active</span>' : '<span class="badge-pill low">Disabled</span>'}${u.mfa_enabled
              ? ' <span class="badge-pill" title="Two-step sign-in is on">2-step</span>' : ''}</td>
            <td class="actions">
              <button class="icon-btn" title="Edit" data-edit="${u.id}">${UI.icon('edit')}</button>
              <button class="icon-btn" title="Reset password" data-pw="${u.id}">${UI.icon('key')}</button>
              ${u.mfa_enabled ? `<button class="btn secondary small" title="Verify identity and send a controlled recovery link to the existing account email" data-mfa-reset="${u.id}">Recover 2-step</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editUser(allUsers.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => resetPw(allUsers.find((x) => x.id == b.dataset.pw)));
    tableEl.querySelectorAll('[data-mfa-reset]').forEach((b) => b.onclick = async () => {
      const u = allUsers.find((x) => x.id == b.dataset.mfaReset);
      UI.modal({
        title: 'Recover authenticator — ' + u.full_name,
        bodyHTML: '<p>Independently verify the requester using established company contacts. A single-use link goes only to the existing account email. MFA stays enabled until redemption; the owner must choose a new password and enroll again.</p>' +
          '<label>Your password</label><input data-f="current" type="password" autocomplete="current-password">' +
          '<label>Your authenticator or recovery code</label><input data-f="code" autocomplete="one-time-code">' +
          '<label>Reason (at least 20 characters)</label><textarea data-f="reason"></textarea>' +
          '<label>Verification ticket/reference (no identity documents or secrets)</label><input data-f="reference">',
        confirmText: 'Send recovery link',
        onConfirm: async (overlay) => {
          const value = key => overlay.querySelector('[data-f="' + key + '"]').value;
          await API.post(`/users/${u.id}/mfa/reset`, { current_password: value('current'), code: value('code'), reason: value('reason'), verification_reference: value('reference') });
          UI.toast('Recovery link sent to the existing account email');
        },
      });
    });
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      editUser(allUsers.find((x) => x.id == tr.dataset.open));
    });
  }

  /** Workspace sign-in rules (PUT /users/security-policy): require two-step sign-in for
      privileged accounts. The server refuses to switch it on until you use it yourself. */
  async function signInSecurity() {
    let p;
    try { p = await API.get('/users/security-policy'); } catch (e) { UI.toast(e.message, 'error'); return; }
    UI.modal({
      title: 'Sign-in security',
      bodyHTML: `
        <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400">
          <input type="checkbox" data-f="req" style="width:auto;margin-top:3px" ${p.require_mfa_privileged ? 'checked' : ''} />
          <span><strong>Require two-step sign-in</strong> for administrators and anyone who manages accounts,
          payroll or accounting. Until they set it up, they can only reach the set-up screen.</span>
        </label>
        ${p.you_have_mfa ? '' : '<p class="muted" style="font-size:12.5px">Turn it on for your own account first (Account → Two-step sign-in).</p>'}
        ${p.available ? '' : '<p class="muted" style="font-size:12.5px">This installed PC signs in with passwords only; the rule applies online.</p>'}`,
      confirmText: 'Save',
      onConfirm: async (ov) => {
        await API.put('/users/security-policy', { require_mfa_privileged: ov.querySelector('[data-f="req"]').checked });
        UI.toast('Sign-in security saved');
      },
    });
  }

  // Preselect Admin Staff when the workspace still has it, else the first non-admin role.
  function defaultRoleKey() {
    if (catalog.roles.some((r) => r.key === 'admin_staff')) return 'admin_staff';
    const r = catalog.roles.find((x) => !x.fixed) || catalog.roles[0];
    return r ? r.key : '';
  }

  function addUser() {
    UI.modal({
      title: 'Create new account',
      bodyHTML: `
        <div class="field-row">
          <div><label>Full name *</label><input data-f="full_name" /></div>
          <div><label>Username *</label><input data-f="username" placeholder="letters, numbers, . _ -" /></div>
        </div>
        <div><label>Email <span class="muted">(for password resets)</span></label>
          <input data-f="email" type="email" placeholder="name@company.com" /></div>
        <div class="field-row">
          <div><label>Role</label>${roleSelect('role', defaultRoleKey())}</div>
          <div><label>Department</label>${deptSelect('department_id', null)}</div>
        </div>
        ${ROLE_HINT}
        <div><label>Temporary password *</label><input data-f="password" type="text" placeholder="min 8 characters" /></div>
        <p class="muted" style="font-size:12px">Share this with the employee; they can change it under My Account.</p>`,
      confirmText: 'Create account',
      onOpen: wireRoleHint,
      onConfirm: async (overlay, showErr) => {
        const get = (f) => overlay.querySelector(`[data-f="${f}"]`).value;
        if (!get('full_name').trim() || !get('username').trim() || !get('password')) {
          showErr('Full name, username and password are required'); return false;
        }
        await API.post('/users', {
          full_name: get('full_name'), username: get('username'), password: get('password'),
          email: get('email').trim(), role: get('role'), department_id: get('department_id') || null,
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
        <div><label>Email <span class="muted">(for password resets)</span></label>
          <input data-f="email" type="email" value="${UI.esc(u.email || '')}" placeholder="name@company.com" /></div>
        <div class="field-row">
          <div><label>Role</label>${roleSelect('role', u.role)}</div>
          <div><label>Department</label>${deptSelect('department_id', u.department_id)}</div>
        </div>
        ${ROLE_HINT}
        <div><label>Status</label><select data-f="active">
          <option value="1" ${u.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.active ? 'selected' : ''}>Disabled</option></select></div>
        <hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">
        <button type="button" class="btn secondary" id="edit-perm-btn" style="width:100%">
          ${UI.icon('key')} Access for this person${overrideCount(u) ? ` (${overrideCount(u)} custom)` : ''}
        </button>
        <button type="button" class="btn secondary" id="edit-sessions-btn" style="width:100%;margin-top:8px">
          ${UI.icon('history')} Sign-ins &amp; devices
        </button>`,
      confirmText: 'Save',
      onOpen: (overlay) => {
        wireRoleHint(overlay);
        overlay.querySelector('#edit-perm-btn').onclick = () => openPermEditor(u);
        overlay.querySelector('#edit-sessions-btn').onclick = () => openSessions(u);
      },
      onConfirm: async (overlay) => {
        const get = (f) => overlay.querySelector(`[data-f="${f}"]`).value;
        await API.put('/users/' + u.id, {
          full_name: get('full_name'), email: get('email').trim(), role: get('role'),
          department_id: get('department_id') || null, active: get('active') === '1',
        });
        UI.toast('Account updated');
        load();
      },
    });
  }

  function openPermEditor(u) {
    AccessEditor.open(u, {
      onSaved: (overridesJson) => {
        // Refresh the user in allUsers to reflect new overrides.
        const idx = allUsers.findIndex((x) => x.id === u.id);
        if (idx >= 0) allUsers[idx] = { ...allUsers[idx], permission_overrides: overridesJson };
        renderUsers();
      },
    });
  }

  // Where this account is / was signed in; sign it out of one device or all of them.
  function openSessions(u) {
    const m = UI.modal({
      title: 'Sign-ins & devices — ' + u.full_name,
      bodyHTML: '<div id="us-sessions"></div>',
      cancelText: 'Close',
    });
    const el = (m && m.overlay ? m.overlay : document).querySelector('#us-sessions');
    SessionList.render(el, {
      load: () => API.get(`/users/${u.id}/sessions`),
      revoke: (sid) => API.post(`/users/${u.id}/sessions/${encodeURIComponent(sid)}/revoke`),
      revokeAll: () => API.post(`/users/${u.id}/sessions/revoke-all`),
      revokeAllLabel: 'Sign out of all devices',
    });
  }

  function resetPw(u) {
    UI.modal({
      title: 'Reset password — ' + u.full_name,
      bodyHTML: `<div><label>New password *</label><input data-f="pw" type="text" placeholder="min 8 characters" /></div>
        <label>Your password</label><input data-f="current" type="password" autocomplete="current-password" />
        <label>Your authenticator/recovery code (if enrolled)</label><input data-f="code" autocomplete="one-time-code" />
        <label>Reason (at least 20 characters)</label><textarea data-f="reason"></textarea>
        <p class="muted" style="font-size:12px">This signs the user out of all sessions. Their authenticator stays enabled.</p>`,
      confirmText: 'Set password',
      onConfirm: async (overlay, showErr) => {
        const pw = overlay.querySelector('[data-f="pw"]').value;
        if (!pw || pw.length < 8) { showErr('Password must be at least 8 characters'); return false; }
        await API.post(`/users/${u.id}/reset-password`, { new_password: pw, current_password: overlay.querySelector('[data-f="current"]').value, code: overlay.querySelector('[data-f="code"]').value, reason: overlay.querySelector('[data-f="reason"]').value });
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
          <thead><tr><th>Name</th><th>Head (approves requests)</th><th class="right">Members</th><th class="right">Items</th><th class="right">Files</th><th></th></tr></thead>
          <tbody>${depts.map((d) => `
            <tr>
              <td><strong>${UI.esc(d.name)}</strong></td>
              <td>${d.head_name ? UI.esc(d.head_name) : '<span class="muted">—</span>'}</td>
              <td class="right">${d.user_count}</td>
              <td class="right">${d.item_count}</td>
              <td class="right">${d.form_count}</td>
              <td class="actions">
                <button class="icon-btn" title="Edit" data-rn="${d.id}" data-name="${UI.esc(d.name)}" data-head="${d.head_user_id || ''}">${UI.icon('edit')}</button>
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
        b.onclick = () => renameDept(b.dataset.rn, b.dataset.name, b.dataset.head, renderList));
      box.querySelectorAll('[data-dd]').forEach((b) =>
        b.onclick = () => deleteDept(b.dataset.dd, b.dataset.name, renderList));
    }
    renderList();
  }

  function renameDept(id, current, currentHead, after) {
    const headOpts = '<option value="">— None (HR approves) —</option>' +
      (allUsers || []).filter((u) => u.active)
        .map((u) => `<option value="${u.id}" ${String(u.id) === String(currentHead || '') ? 'selected' : ''}>${UI.esc(u.full_name)}</option>`).join('');
    UI.modal({
      title: 'Edit department',
      bodyHTML: `<label>Name</label><input data-f="name" value="${UI.esc(current)}" />
        <label style="margin-top:12px">Department head</label>
        <select data-f="head_user_id">${headOpts}</select>
        <p class="muted" style="margin-top:6px">The head approves this department's mobile requests and attendance corrections.</p>`,
      confirmText: 'Save',
      onConfirm: async (overlay, showErr) => {
        const name = overlay.querySelector('[data-f="name"]').value.trim();
        if (!name) { showErr('Name is required'); return false; }
        const head = overlay.querySelector('[data-f="head_user_id"]').value;
        await API.put('/users/departments/' + id, { name, head_user_id: head || null });
        UI.toast('Department saved');
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
  view.querySelector('#add-role').addEventListener('click', () => AccessEditor.editRole(null, { onSaved: reloadRoles }));
  // Through the router, so the left tree's User Accounts / Roles highlight follows the tab.
  view.querySelectorAll('#acct-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tab !== tab) App.navigate('admin', b.dataset.tab === 'roles' ? { tab: 'roles' } : undefined);
  }));
  view.querySelector('#manage-depts').addEventListener('click', manageDepartments);
  view.querySelector('#sign-in-security').addEventListener('click', signInSecurity);
  view.querySelector('#user-search').addEventListener('input', (e) => {
    userQuery = e.target.value.trim();
    renderUsers();
  });
  await load();
  setTab(tab);

  // Deep-link: the "Departments" tree leaf opens the manager directly.
  if (filter && filter.tab === 'departments') manageDepartments();
  // filter.id deep-links into one account's edit modal (used by the AI assistant's
  // created-record links) — editUser() needs the full row, load() above already has it.
  if (filter && filter.id) {
    const u = allUsers.find((x) => String(x.id) === String(filter.id));
    if (u) editUser(u);
  }
});
