/* HR: Employees master list — the 201 file. Identity, department/position, daily rate,
   employment status, statutory numbers, a photo, and uploaded documents. Picked from here
   into Time Keeping cutoffs; identity/rate feed generated payslips. "Generate ID" prints a
   virtual ID card from the editable "Employee ID Card" document template (Documents >
   Templates), the same way payslips print from the "HR Payroll Slip" template.
   Route: hr-employees. */
App.register('hr-employees', async (view, filter) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  const canManage = App.hasPermission('hr.manage');
  // Pay is its own permission (src/modules/payroll/pay-access.ts): without payroll.view the server
  // leaves the rates out, so the Rate column and the pay fields are hidden; without
  // payroll.manage the server keeps the stored pay whatever this form sends.
  const canSeePay = App.hasPermission('payroll.view');
  const canChangePay = App.hasPermission('payroll.manage');
  const PAY_HIDDEN_NOTE = '<p class="muted" style="font-size:12px;margin:0 0 12px">Pay is shown only to people with the payroll permission.</p>';
  const state = { q: '', department_id: '', status: '' };
  let depts = [];

  const STATUS_LABELS = { probationary: 'Probationary', regular: 'Regular', suspended: 'Suspended', resigned: 'Resigned', terminated: 'Terminated' };
  // Suspended: still employed, but blocked from clocking in until HR sets them back.
  const STATUS_CLASS = { probationary: 'status-confirmed', regular: 'status-completed', suspended: 'status-cancelled', resigned: 'muted', terminated: 'status-cancelled' };
  const ASSET_STATUS_LABELS = { issued: 'Issued', returned: 'Returned', lost: 'Lost', damaged: 'Damaged' };
  const ASSET_STATUS_CLASS = { issued: 'status-confirmed', returned: 'status-completed', lost: 'status-cancelled', damaged: 'status-cancelled' };
  const PLACEHOLDER_PHOTO = UI.PLACEHOLDER_PHOTO;

  view.innerHTML = `
    <div class="topbar">
      <div><h2>Employees</h2><div class="sub">Employee records, department assignments, pay and schedules.</div></div>
      <div class="grow"></div>
      ${canManage ? `<button class="btn secondary" id="emp-no-settings" title="Employee numbering format" aria-label="Employee numbering format">${UI.icon('settings', 15)}</button>` : ''}
      ${canManage ? `<button class="btn secondary" id="emp-import" title="Create or update employees from a CSV file">${UI.icon('upload')} Import</button>` : ''}
      ${canManage ? `<button class="btn" id="emp-new">${UI.icon('plus')} New Employee</button>` : ''}
    </div>
    <div class="hr-filters hr-employee-filters">
      <div class="search-box search"><label class="hr-sr-only" for="emp-search">Search employees</label>${UI.icon('search', 16)}<input id="emp-search" placeholder="Search name…" /></div>
      <div class="fld"><label for="emp-dept-filter">Department</label><select id="emp-dept-filter"><option value="">All departments</option></select></div>
      <div class="fld"><label for="emp-status-filter">Status</label><select id="emp-status-filter">
        <option value="">All statuses</option>
        ${Object.keys(STATUS_LABELS).map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('')}
      </select></div>
      ${canManage ? `<button class="btn danger small" id="emp-remove-selected" hidden>${UI.icon('trash')} Remove selected</button>` : ''}
    </div>
    <div class="panel"><div id="emp-table"></div></div>`;

  const tableEl = view.querySelector('#emp-table');
  const money = UI.money;
  let monthlyRateDivisor = 26;

  async function ensurePolicyDivisor() {
    try { monthlyRateDivisor = (await API.get('/hr/payroll-policy')).monthly_rate_divisor || 26; } catch { /* keep default */ }
    return monthlyRateDivisor;
  }

  /** Fetches a recommended employee_no for the given hire date (blank = today) — a pure
      suggestion, never reserved server-side, so it's safe to call as often as needed. */
  async function suggestEmployeeNo(startDate) {
    try {
      const qs = startDate ? `?start_date=${encodeURIComponent(startDate)}` : '';
      const res = await API.get(`/hr/employees/suggest-number${qs}`);
      return res.employee_no || '';
    } catch { return ''; }
  }

  /** User accounts (for the "Linked Account" picker) and a fresh, unfiltered employee list (so
      already-linked accounts can be flagged/disabled in the picker) — fetched fresh each time
      the modal opens rather than cached, since links can change between opens. */
  async function loadLinkPickerData() {
    const [users, allEmployees] = await Promise.all([
      API.get('/users').catch(() => []),
      API.get('/hr/employees').catch(() => []),
    ]);
    return { users, allEmployees };
  }

  async function ensureDepts() {
    if (depts.length) return depts;
    try { depts = await API.get('/users/departments/list'); } catch { depts = []; }
    return depts;
  }

  /* Quick-add/remove a department without leaving the employee form. Renaming still lives in
     Admin > Accounts > Departments (users.manage only). Removing here only succeeds if the
     department isn't used outside HR (accounts/items/files) — the server enforces that; a
     department only assigned to employees (or unused) deletes fine. */
  function addDepartmentInline(targetSelect) {
    UI.modal({
      title: 'New department',
      bodyHTML: `<div><label>Department name *</label><input id="nd-name" autofocus /></div>`,
      confirmText: 'Add',
      onConfirm: async (ov, showErr) => {
        const name = ov.querySelector('#nd-name').value.trim();
        if (!name) { showErr('Department name is required'); return false; }
        let created;
        try {
          created = await API.post('/users/departments', { name });
        } catch (e) {
          showErr(e.message);
          return false;
        }
        depts.push({ id: created.id, name });
        depts.sort((a, b) => a.name.localeCompare(b.name));
        const optsHTML = depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
        if (targetSelect) targetSelect.innerHTML = '<option value="">— none —</option>' + optsHTML;
        if (targetSelect) targetSelect.value = String(created.id);
        const deptFilter = view.querySelector('#emp-dept-filter');
        if (deptFilter) deptFilter.innerHTML = '<option value="">All departments</option>' + optsHTML;
        UI.toast('Department added');
      },
    });
  }

  /* Create a login account without leaving the employee form, then link it. The role list is
     whatever the server says this caller may assign (catalog.assignableRoles — staff roles only
     for HR, per HR_ASSIGNABLE_ROLES in src/shared/permissions.ts); POST /users enforces it too. */
  /** "Christian Dave Enola" -> "christian.enola" (first + last word, username-safe). */
  function suggestUsername(fullName) {
    const words = fullName.toLowerCase().normalize('NFD').replace(/[^\w\s.-]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const base = words.length > 1 ? `${words[0]}.${words[words.length - 1]}` : words[0];
    return base.replace(/[^a-z0-9._-]/g, '').slice(0, 30);
  }

  function tempPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => chars[b % chars.length]).join('');
  }

  async function createLinkedAccount(empOv, typedName, onCreated) {
    if (!empOv.dataset.employeeId) { UI.toast('Save this employee first, then open it to create and link an account.','info'); return; }
    const fullName = typedName || empOv.querySelector('[data-f="name"]').value.trim();
    const deptId = empOv.querySelector('[data-f="department_id"]').value;
    let catalog;
    try { catalog = await AccessEditor.getCatalog(); } catch (e) { UI.toast(e.message, 'error'); return; }
    const roleOpts = '<option value="">— choose role —</option>'
      + catalog.assignableRoles.map((v) => `<option value="${v}">${UI.esc(AccessEditor.ROLE_LABELS[v] || v)}</option>`).join('');
    const deptOpts = '<option value="">— none —</option>'
      + depts.map((d) => `<option value="${d.id}" ${String(d.id) === deptId ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('');
    UI.modal({
      title: 'Create new account',
      bodyHTML: `
        <div class="field-row">
          <div><label>Full name *</label><input id="na-name" value="${UI.esc(fullName)}" /></div>
          <div><label>Username *</label><input id="na-user" class="mono" value="${UI.esc(suggestUsername(fullName))}" placeholder="letters, numbers, . _ -" /></div>
        </div>
        <div class="field-row" style="margin-top:10px">
          <div><label>Base role *</label><select id="na-role">${roleOpts}</select></div>
          <div><label>Department</label><select id="na-dept">${deptOpts}</select></div>
        </div>
        <div style="margin-top:10px"><label>Email <span class="muted">(for password resets)</span></label>
          <input id="na-email" type="email" placeholder="name@company.com" /></div>
        <div style="margin-top:10px"><label>Temporary password *</label><input id="na-pw" class="mono" value="${tempPassword()}" /></div>
        <p class="muted" style="font-size:12px">Share this with the employee; they can change it under My Account. The account is created and linked to the saved employee immediately. Cancel does not undo account creation. Need more access than one role gives? Add it afterwards with the <strong>Access</strong> button next to the linked account.</p>`,
      confirmText: 'Create account',
      onConfirm: async (ov, showErr) => {
        const val = (id) => ov.querySelector(id).value.trim();
        const body = {
          full_name: val('#na-name'), username: val('#na-user'), password: ov.querySelector('#na-pw').value,
          email: val('#na-email'), role: val('#na-role'), department_id: val('#na-dept') || null, employee_id: Number(empOv.dataset.employeeId),
        };
        if (!body.full_name || !body.username || !body.password) { showErr('Full name, username and password are required'); return false; }
        if (!body.role) { showErr('Choose a role for the account'); return false; }
        let created;
        try {
          created = await API.post('/users', body);
        } catch (e) {
          showErr(e.message);
          return false;
        }
        onCreated({ id: Number(created.id), full_name: body.full_name, username: body.username.toLowerCase() });
        UI.toast(`Account @${body.username.toLowerCase()} created — temp password: ${body.password}`);
      },
    });
  }

  async function removeDepartmentInline(targetSelect) {
    const id = targetSelect.value;
    if (!id) { UI.toast('Select a department first', 'error'); return; }
    const dept = depts.find((d) => String(d.id) === id);
    if (!dept) return;
    if (!await UI.confirmDialog(`Delete department "${dept.name}"? Only allowed if nothing outside HR uses it.`, 'Delete')) return;
    try {
      await API.del('/users/departments/' + id);
    } catch (e) {
      UI.toast(e.message, 'error');
      return;
    }
    depts = depts.filter((d) => String(d.id) !== id);
    const optsHTML = depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
    targetSelect.innerHTML = '<option value="">— none —</option>' + optsHTML;
    const deptFilter = view.querySelector('#emp-dept-filter');
    if (deptFilter) deptFilter.innerHTML = '<option value="">All departments</option>' + optsHTML;
    UI.toast('Department deleted');
  }

  let displayedEmployees = [];
  let loadVersion = 0;
  async function load() {
    const version = ++loadVersion;
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    await ensureDepts();
    const deptFilter = view.querySelector('#emp-dept-filter');
    if (deptFilter.options.length <= 1) {
      deptFilter.innerHTML = '<option value="">All departments</option>' +
        depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
    }
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.department_id) params.set('department_id', state.department_id);
    if (state.status) params.set('status', state.status);
    try {
      const list = await API.get('/hr/employees?' + params.toString());
      if (version === loadVersion) render(list);
    } catch (e) {
      if (version !== loadVersion) return;
      tableEl.innerHTML = UI.emptyState({icon:'alert',title:'Couldn’t load employees',hint:e.message,action:'<button class="btn secondary" id="emp-retry">Try again</button>'});
      tableEl.querySelector('#emp-retry').onclick=load;
    }
  }

  function render(list) {
    displayedEmployees = list;
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'users',
        title: state.q || state.department_id || state.status ? 'No matching employees' : 'No employees yet',
        hint: state.q || state.department_id || state.status ? 'Try a different search or filter.' : 'Add your first employee to start building cutoffs.',
        action: (state.q || state.department_id || state.status || !canManage) ? '' : `<button class="btn" id="emp-empty-new">${UI.icon('plus')} New Employee</button>`,
      });
      const en = tableEl.querySelector('#emp-empty-new');
      if (en) en.onclick = () => employeeModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>${canManage ? '<th></th>' : ''}<th></th><th>Name</th><th>Employee No.</th><th>Department</th><th>Position</th>${canSeePay ? '<th class="right">Rate</th>' : ''}<th>Status</th><th></th></tr></thead>
        <tbody>${list.map((e) => `
          <tr class="clickable" data-open="${e.id}">
            ${canManage ? `<td><input type="checkbox" class="emp-chk" data-emp="${e.id}" data-name="${UI.esc(e.name)}" /></td>` : ''}
            <td><img src="${UI.esc(e.photo || PLACEHOLDER_PHOTO)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;vertical-align:middle" /></td>
            <td><strong>${UI.esc(e.name)}</strong>${e.user_id ? ` <span class="muted" title="Linked to account: ${UI.esc(e.linked_username || '')}" style="vertical-align:middle">${UI.icon('key', 13)}</span>` : ''}</td>
            <td class="mono muted">${UI.esc(e.employee_no || '—')}</td>
            <td>${UI.esc(e.department_name || '—')}</td>
            <td>${UI.esc(e.position || '—')}</td>
            ${canSeePay ? `<td class="right">${e.rate_type === 'monthly'
              ? `${money(e.monthly_rate)}<span class="muted">/mo</span>`
              : `${money(e.daily_rate)}<span class="muted">/day</span>`}</td>` : ''}
            <td><span class="badge-pill ${STATUS_CLASS[e.status] || 'muted'}">${STATUS_LABELS[e.status] || e.status}</span></td>
            <td class="actions">
              <button class="icon-btn" title="Generate ID" data-id-card="${e.id}">${UI.icon('idcard')}</button>
              <button class="icon-btn" title="${canManage ? 'Edit' : 'View employee'}" data-edit="${e.id}">${UI.icon(canManage ? 'edit' : 'users')}</button>
              ${canManage ? `<button class="icon-btn danger" title="Delete" data-del="${e.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openEmployee(b.dataset.edit, list); });
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); del(b.dataset.del, list); });
    tableEl.querySelectorAll('[data-id-card]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const emp = list.find((x) => String(x.id) === String(b.dataset.idCard));
      if (emp) generateId(emp);
    });
    tableEl.querySelectorAll('tr[data-open]').forEach(tr => { tr.tabIndex=0; tr.onkeydown=e=>{if(e.target===tr && (e.key==='Enter' || e.key===' ')){e.preventDefault();openEmployee(tr.dataset.open,list);}}; });
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions') || e.target.closest('.emp-chk')) return;
      openEmployee(tr.dataset.open, list);
    });
    tableEl.querySelectorAll('.emp-chk').forEach((c) => {
      c.addEventListener('click', (e) => e.stopPropagation());
      c.addEventListener('change', updateRemoveSelectedBtn);
    });
    updateRemoveSelectedBtn();
  }

  const removeSelectedBtn = view.querySelector('#emp-remove-selected');
  function selectedEmployees() {
    if (!tableEl.querySelectorAll) return [];
    return Array.from(tableEl.querySelectorAll('.emp-chk:checked')).map((c) => ({ id: c.dataset.emp, name: c.dataset.name }));
  }
  function updateRemoveSelectedBtn() {
    if (!removeSelectedBtn) return;
    const n = selectedEmployees().length;
    removeSelectedBtn.hidden = n === 0;
    removeSelectedBtn.innerHTML = `${UI.icon('trash')} Remove selected (${n})`;
  }
  // Item 4: one "are you sure" per employee, not a single combined confirm — deleting an
  // employee is irreversible and each is its own decision, so a rushed single "yes" can't
  // remove more than intended. Cancelling one skips just that employee and moves to the next.
  if (removeSelectedBtn) {
    removeSelectedBtn.onclick = async () => {
      const targets = selectedEmployees();
      let removed = 0, skipped = 0;
      for (const t of targets) {
        const ok = await UI.confirmDialog(`Delete ${t.name}? This cannot be undone.`, 'Delete');
        if (!ok) { skipped++; continue; }
        try { await API.del('/hr/employees/' + t.id); removed++; }
        catch (e) { UI.toast(`${t.name}: ${e.message}`, 'error'); }
      }
      if (removed) UI.toast(`${removed} employee(s) deleted${skipped ? `, ${skipped} skipped` : ''}`);
      else if (skipped) UI.toast('Nothing deleted');
      load();
    };
  }

  function openEmployee(id, list) {
    const emp = list.find((x) => String(x.id) === String(id));
    if (!emp) return;
    if (canManage) { employeeModal(emp); return; }
    const fields = [['Employee number',emp.employee_no],['Department',emp.department_name],['Position',emp.position],['Status',emp.status],['Start date',emp.start_date],['Available leave',(emp.leave_days_per_year ?? 5)-(emp.leave_days_used ?? 0)],['SSS',emp.sss_no],['PhilHealth',emp.philhealth_no],['Pag-IBIG',emp.pagibig_no],['TIN',emp.tin_no]];
    if (canSeePay) fields.push(['Daily rate',money(emp.daily_rate)],['Monthly rate',money(emp.monthly_rate)]);
    UI.modal({title:emp.name,cancelText:'Close',bodyHTML:`<p class="muted">Read-only employee record. An HR manager can make changes.</p>${fields.map(([label,value])=>`<div class="tool-row"><strong>${UI.esc(label)}</strong><span>${UI.esc(String(value ?? '—'))}</span></div>`).join('')}<h4>Documents</h4><div id="emp-read-docs">Loading…</div><h4>Assets</h4><div id="emp-read-assets">Loading…</div>`,onOpen:async ov=>{
      try {const docs=await API.get(`/hr/employees/${emp.id}/documents`);ov.querySelector('#emp-read-docs').innerHTML=docs.length?docs.map((d,i)=>`<button class="btn secondary small" data-download="${i}">${UI.esc(d.title)}</button>`).join(' '):'<p class="muted">No documents.</p>';ov.querySelectorAll('[data-download]').forEach(b=>b.onclick=()=>downloadDoc(emp.id,docs[Number(b.dataset.download)].id,docs));}catch(e){ov.querySelector('#emp-read-docs').textContent='Couldn’t load documents: '+e.message;}
      try {const assets=await API.get(`/hr/employees/${emp.id}/assets`);ov.querySelector('#emp-read-assets').innerHTML=assets.length?assets.map(a=>`<p>${UI.esc(a.form_number || '')} — ${(a.items || []).map(i=>`${UI.esc(i.asset_name)} (${UI.esc(i.status)})`).join(', ')}</p>`).join(''):'<p class="muted">No assets.</p>';}catch(e){ov.querySelector('#emp-read-assets').textContent='Couldn’t load assets: '+e.message;}
    }});
  }

  /* ---------- Photo: resize client-side to a small JPEG data URI before storing ---------- */
  function resizeImageToDataUrl(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Could not load image'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
            else { width = Math.round((width * maxDim) / height); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Create / edit modal ---------- */
  // Four tabs (Basic Info / Pay & Schedule / Payroll Rules / Leave & Records) keep this from
  // being one long scroll of ~25 fields — same .form-tabs/.form-tab/.form-panel shell
  // inventory.js's item form already uses, so the interaction is familiar rather than a new
  // pattern. Shared by the tab-bar's own click handler and onConfirm (which jumps to whichever
  // tab holds the field that failed validation, so an error banner never points at a hidden field).
  function activateEmpTab(overlay, id) {
    overlay.querySelectorAll('[data-formtab]').forEach((b) => b.classList.toggle('active', b.dataset.formtab === id));
    overlay.querySelectorAll('[data-formpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.formpanel !== id));
  }

  function employeeModal(existing) {
    const editing = !!existing;
    let photoData = editing ? (existing.photo || '') : '';

    Promise.all([
      ensureDepts(),
      ensurePolicyDivisor(),
      editing ? Promise.resolve(existing.employee_no || '') : suggestEmployeeNo(''),
      loadLinkPickerData(),
      API.get('/hr/shifts').catch(() => []),
    ]).then(([deptList, , suggestedNo, { users, allEmployees }, shifts]) => {
      const deptOpts = ['<option value="">— none —</option>']
        .concat(deptList.map((d) => `<option value="${d.id}" ${editing && existing.department_id === d.id ? 'selected' : ''}>${UI.esc(d.name)}</option>`))
        .join('');
      const shiftOpts = ['<option value="">— company default —</option>']
        .concat(shifts.map((s) => `<option value="${s.id}" ${editing && existing.default_shift_id === s.id ? 'selected' : ''}>${UI.esc(s.name)} (${UI.esc(s.start_time)}-${UI.esc(s.end_time)})</option>`))
        .join('');
      const statusOpts = Object.keys(STATUS_LABELS)
        .map((s) => `<option value="${s}" ${(editing ? existing.status : 'probationary') === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)
        .join('');
      const rateType = editing ? (existing.rate_type || 'daily') : 'daily';
      const rateAmount = editing ? (rateType === 'monthly' ? existing.monthly_rate : existing.daily_rate) : 0;

      const currentUserId = editing ? existing.user_id : null;
      const linkedElsewhere = new Map(); // user_id -> employee name, excluding this employee
      allEmployees.forEach((e) => {
        if (e.user_id != null && (!editing || e.id !== existing.id)) linkedElsewhere.set(e.user_id, e.name);
      });
      // Options for the searchable "Linked user account" combo — accounts already tied to a
      // different employee stay listed (so a search for them explains why) but can't be picked.
      const userComboOptions = () => [{ value: '', label: '— none —' }]
        .concat(users.map((u) => {
          const taken = linkedElsewhere.get(u.id);
          return {
            value: u.id,
            label: `${u.full_name} (${u.username})${taken ? ` — linked to ${taken}` : ''}`,
            disabled: !!taken && currentUserId !== u.id,
          };
        }));
      let userCombo; // built in onOpen

      UI.modal({
        title: editing ? `Edit ${existing.name}` : 'New Employee',
        size: 'lg',
        headActionHTML: editing ? `<button type="button" class="btn secondary small" id="emp-gen-id">${UI.icon('idcard', 15)} Generate ID</button>` : '',
        bodyHTML: `
          <div class="form-tabs">
            <button type="button" class="form-tab active" data-formtab="basic">Basic Info</button>
            <button type="button" class="form-tab" data-formtab="pay">Pay &amp; Schedule</button>
            <button type="button" class="form-tab" data-formtab="rules">Payroll Rules</button>
            <button type="button" class="form-tab" data-formtab="leave">Leave &amp; Records</button>
          </div>

          <div data-formpanel="basic" class="form-panel">
            <div class="hr-employee-identity">
              <div style="text-align:center">
                <img id="emp-photo-preview" src="${UI.esc(photoData || PLACEHOLDER_PHOTO)}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:1px solid var(--border-strong)" />
                <div style="margin-top:6px">
                  <input type="file" accept="image/*" id="emp-photo-file" style="display:none" />
                  <button type="button" class="btn secondary small" id="emp-photo-pick">Choose photo</button>
                  <button type="button" class="btn secondary small" id="emp-photo-clear" style="margin-top:4px">Remove</button>
                </div>
              </div>
              <div style="flex:1">
                <div class="field-row">
                  <div><label>Employee No. *</label>
                    <div style="display:flex;gap:6px">
                      <input data-f="employee_no" class="mono" style="flex:1" value="${UI.esc(suggestedNo)}" autofocus />
                      <button type="button" class="icon-btn" id="emp-no-suggest" title="Suggest a number">${UI.icon('sparkles', 15)}</button>
                    </div>
                  </div>
                  <div><label>Full name *</label><input data-f="name" value="${UI.esc(editing ? existing.name : '')}" /></div>
                </div>
                <div class="field-row" style="margin-top:10px">
                  <div><label>Department</label>
                    <div style="display:flex;gap:6px">
                      <select data-f="department_id" style="flex:1">${deptOpts}</select>
                      <button type="button" class="icon-btn" id="emp-dept-new" title="Add new department">${UI.icon('plus', 15)}</button>
                      <button type="button" class="icon-btn danger" id="emp-dept-del" title="Delete selected department">${UI.icon('trash', 15)}</button>
                    </div>
                  </div>
                  <div><label>Position</label><input data-f="position" value="${UI.esc(editing ? (existing.position || '') : '')}" /></div>
                </div>
              </div>
            </div>
            <div class="field-row">
              <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
              <div><label>Start date</label><input data-f="start_date" type="date" value="${UI.esc(editing ? (existing.start_date || '') : '')}" /></div>
            </div>
            <div class="field-row" style="margin-top:8px">
              <div><label>Birth date</label><input data-f="birth_date" type="date" value="${UI.esc(editing ? (existing.birth_date || '') : '')}" /></div>
              <div><label>Civil status</label><select data-f="civil_status">
                <option value="">—</option>
                ${/* Same list as CIVIL_STATUSES in src/shared/validation.ts */ ['Single', 'Married', 'Widowed', 'Legally separated', 'Annulled', 'Divorced']
                  .map((s) => `<option${editing && existing.civil_status === s ? ' selected' : ''}>${s}</option>`).join('')}
              </select></div>
            </div>
            <div class="field-row" style="margin-top:10px">
              <div><label>Linked user account</label>
                <div style="display:flex;gap:6px">
                  <div id="emp-user-combo" style="flex:1"></div>
                  <button type="button" class="btn secondary small" id="emp-user-access" title="Roles &amp; access for the linked account">${UI.icon('key', 15)} Access</button>
                </div>
                <div class="muted" style="font-size:12px;margin-top:3px">Ties this employee's 201-file record to their login account (optional). Type a name to search, or create a new account. Use Access to give it more than its base role.</div>
              </div>
            </div>
          </div>

          <div data-formpanel="pay" class="form-panel hidden">
            ${canSeePay ? '' : PAY_HIDDEN_NOTE}
            <div class="${canSeePay ? '' : 'hidden'}">
            <div class="field-row">
              <div><label>Rate type</label><select data-f="rate_type" ${editing ? 'disabled' : ''}>
                <option value="daily" ${rateType === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="monthly" ${rateType === 'monthly' ? 'selected' : ''}>Monthly</option>
              </select></div>
              <div><label id="emp-rate-label">${rateType === 'monthly' ? 'Monthly rate' : 'Daily rate'}</label>
                <input data-f="rate_amount" type="number" step="0.01" min="0" value="${UI.esc(String(rateAmount || 0))}" ${editing ? 'readonly' : ''} />
                <div class="muted" id="emp-rate-hint" style="font-size:12px;margin-top:3px"></div>
              </div>
            </div>
            ${editing ? `
            <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
              ${canChangePay ? `<button type="button" class="btn secondary small" id="emp-rate-change">${UI.icon('edit', 15)} Change rate</button>` : ''}
              <button type="button" class="btn secondary small" id="emp-rate-history-toggle">${UI.icon('history', 15)} Rate history</button>
            </div>
            <div id="emp-rate-history" style="display:none;margin-top:8px"></div>` : ''}
            </div>
            <label style="margin-top:18px;display:block">Default shift</label>
            <select data-f="default_shift_id">${shiftOpts}</select>
            <p class="muted" style="font-size:12px;margin:4px 0 0">Pre-fills new Daily Time rows in Time Keeping — a
              rotating employee can still be set to a different shift, or none, on any single day there. Without a
              shift, late/OT/undertime can't be judged (nothing to compare the clock-in against), though holiday and
              rest-day pay still compute fine either way.</p>
            <label style="margin-top:18px;display:block">Rest days</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
              <input type="checkbox" id="emp-rd-custom" style="width:auto" ${existing && existing.rest_days ? 'checked' : ''} />
              Custom for this employee (otherwise uses the company-wide default from HR &rarr; Time Keeping &rarr; Policy Settings)
            </label>
            <div id="emp-rest-days" style="display:${existing && existing.rest_days ? 'flex' : 'none'};gap:12px;flex-wrap:wrap;margin-top:6px">
              ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `
                <label style="display:flex;align-items:center;gap:4px;font-weight:normal">
                  <input type="checkbox" data-rd="${i}" style="width:auto" ${existing && existing.rest_days && existing.rest_days.includes(i) ? 'checked' : ''} />${n}</label>`).join('')}
            </div>
            <p class="muted" style="font-size:12px;margin:4px 0 0">Worked on a rest day pays +30% automatically (more
              if it also lands on a holiday) — nothing else to fill in on the daily grid.</p>
          </div>

          <div data-formpanel="rules" class="form-panel hidden">
            <label style="display:block;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Exemptions</label>
            <label style="margin-top:10px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" data-f="late_exempt" style="width:auto" ${existing && existing.late_exempt ? 'checked' : ''} />
              Exempt from late deductions
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">For someone whose actual clock-in time shouldn't be
              penalized (e.g. the company president). Late minutes still show on the payslip detail for the record —
              this only zeroes the peso deduction.</p>
            <label style="margin-top:14px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" data-f="ot_exempt" style="width:auto" ${existing && existing.ot_exempt ? 'checked' : ''} />
              Exempt from overtime pay
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">For salaried staff never entitled to overtime (e.g.
              a supervisor). OT hours still show on the payslip detail for the record — this only zeroes the peso pay.</p>
            <label style="margin-top:14px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" data-f="always_whole_day" style="width:auto" ${existing && existing.always_whole_day ? 'checked' : ''} />
              Always paid a whole day
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">Any day with both a time in and a time out earns the
              full daily rate, whatever the times — never a half day, and no late or undertime deduction. Overtime,
              night differential and holiday pay still follow the usual rules; a day missing a punch is handled as usual.</p>
            <label style="margin-top:14px;display:flex;align-items:center;gap:6px">
              <input type="checkbox" data-f="clock_anywhere" style="width:auto" ${existing && existing.clock_anywhere ? 'checked' : ''} />
              Can time in outside the office
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">For field staff (drivers, sales, site crews). They
              skip the office location lock and get a "Clock in here" button on their phone that works without the
              office QR. Their location is still saved with every punch.</p>

            <div class="${canSeePay ? '' : 'hidden'}">
            <label style="margin-top:24px;display:block;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Statutory Deductions</label>
            <p class="muted" style="font-size:12px;margin:4px 0 12px">Also editable in bulk from Accounting &rarr;
              Statutory Deductions. Unchecking one zeroes that contribution on this employee's next generated
              payslip and drops them from that fund's remittance schedule. An override replaces the computed
              amount with a fixed peso figure whenever its checkbox stays on (SSS/PhilHealth/Pag-IBIG still
              split across cutoffs the normal way; leave blank to keep using the computed table amount).</p>
            <div class="hr-deduction-grid">
              <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase">Fund</div>
              <div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase">Override amount</div>
              ${[
                { key: 'sss', label: 'SSS' },
                { key: 'philhealth', label: 'PhilHealth' },
                { key: 'pagibig', label: 'Pag-IBIG' },
                { key: 'withholding_tax', label: 'Withholding Tax' },
              ].map((d) => `
                <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
                  <input type="checkbox" data-f="deduct_${d.key}" style="width:auto" ${!existing || existing['deduct_' + d.key] ? 'checked' : ''} /> ${d.label}
                </label>
                <input type="number" step="0.01" min="0" data-f="${d.key}_override" placeholder="Computed amount"
                  value="${existing && existing[d.key + '_override'] != null ? existing[d.key + '_override'] : ''}" />`).join('')}
            </div>
            <label style="display:flex;align-items:center;gap:6px;margin-top:14px;font-weight:normal">
              <input type="checkbox" data-f="contribution_basis_fixed" style="width:auto" ${existing && existing.contribution_basis === 'fixed' ? 'checked' : ''} />
              Fixed contribution basis (employee agreed in writing)
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">Off (default): SSS and Pag-IBIG follow the law —
              computed on what the employee actually earned that month. On: computed on the fixed monthly rate (monthly
              rate, or daily rate &times; the monthly rate divisor) every month, whatever the attendance. PhilHealth is
              always on the fixed monthly rate.</p>
            </div>
          </div>

          <div data-formpanel="leave" class="form-panel hidden"><p class="muted">Document uploads, asset changes, leave adjustments and rate changes save immediately. Save applies the employee fields; Cancel does not undo those separate actions.</p>
            <label style="display:block">Employee leave bank</label><p class="muted">Approved paid leave consumes scheduled working days. Use Adjust balance to add or deduct days with a recorded reason; ordinary employee edits preserve the bank.</p>
            ${editing ? '<button class="btn secondary small" type="button" id="emp-leave-adjust">Adjust balance</button> <button class="btn secondary small" type="button" id="emp-leave-history">Adjustment history</button>' : ''}
            <div class="field-row">
              <div><label>Individual entitlement (days)</label><input data-f="leave_days_per_year" type="number" step="0.5" min="0" ${editing ? 'readonly' : ''} value="${UI.esc(String(editing ? (existing.leave_days_per_year ?? 5) : 5))}" /></div>
              <div><label>Days consumed</label><input data-f="leave_days_used" type="number" step="0.5" min="0" ${editing ? 'readonly' : ''} value="${UI.esc(String(editing ? (existing.leave_days_used ?? 0) : 0))}" />
                ${editing ? `<div class="muted" style="font-size:12px;margin-top:3px">${UI.esc(String((existing.leave_days_per_year ?? 5) - (existing.leave_days_used ?? 0)))} remaining</div>` : ''}
              </div>
            </div>
            <label style="margin-top:18px;display:block">Statutory numbers</label>
            <div class="field-row">
              <div><label>SSS No.</label><input data-f="sss_no" value="${UI.esc(editing ? (existing.sss_no || '') : '')}" /></div>
              <div><label>PhilHealth No.</label><input data-f="philhealth_no" value="${UI.esc(editing ? (existing.philhealth_no || '') : '')}" /></div>
            </div>
            <div class="field-row" style="margin-top:8px">
              <div><label>Pag-IBIG No.</label><input data-f="pagibig_no" value="${UI.esc(editing ? (existing.pagibig_no || '') : '')}" /></div>
              <div><label>TIN</label><input data-f="tin_no" value="${UI.esc(editing ? (existing.tin_no || '') : '')}" /></div>
            </div>
            ${editing ? `
            <label style="margin-top:18px;display:block">201 documents</label>
            <div id="emp-docs"><div class="empty">Loading…</div></div>
            <div class="line-actions">
              <input type="file" id="emp-doc-file" style="display:none" />
              <button type="button" class="btn secondary small" id="emp-doc-add">${UI.icon('upload', 15)} Upload document</button>
            </div>
            <label style="margin-top:18px;display:block">Assets issued</label>
            <div id="emp-assets"><div class="empty">Loading…</div></div>
            <div class="line-actions">
              <button type="button" class="btn secondary small" id="emp-asset-issue">${UI.icon('archive', 15)} Issue asset</button>
            </div>` : ''}
          </div>`,
        confirmText: editing ? 'Save' : 'Create',
        onOpen: (ov) => {
          ov.querySelectorAll('[data-formtab]').forEach((btn) => {
            btn.onclick = () => activateEmpTab(ov, btn.dataset.formtab);
          });

          const genBtn = ov.querySelector('#emp-gen-id');
          if (genBtn) genBtn.onclick = () => generateId(existing);

          ov.querySelector('#emp-rd-custom').addEventListener('change', (e) => {
            ov.querySelector('#emp-rest-days').style.display = e.target.checked ? 'flex' : 'none';
          });

          const empNoInp = ov.querySelector('[data-f="employee_no"]');
          ov.querySelector('#emp-no-suggest').onclick = async () => {
            empNoInp.value = await suggestEmployeeNo(ov.querySelector('[data-f="start_date"]').value);
            userEditedEmpNo = false;
          };
          let userEditedEmpNo = editing; // don't auto-refresh over a real, already-assigned number
          empNoInp.addEventListener('input', () => { userEditedEmpNo = true; });
          if (!editing) {
            ov.querySelector('[data-f="start_date"]').addEventListener('change', async (e) => {
              if (userEditedEmpNo) return;
              empNoInp.value = await suggestEmployeeNo(e.target.value);
            });
          }

          const rateTypeSel = ov.querySelector('[data-f="rate_type"]');
          const rateLabel = ov.querySelector('#emp-rate-label');
          const rateHint = ov.querySelector('#emp-rate-hint');
          const rateAmountInp = ov.querySelector('[data-f="rate_amount"]');
          function updateRateUI() {
            if (rateTypeSel.value === 'monthly') {
              rateLabel.textContent = 'Monthly rate';
              const amt = Number(rateAmountInp.value) || 0;
              rateHint.textContent = amt
                ? `≈ ${money(amt / monthlyRateDivisor)} / day (monthly ÷ ${monthlyRateDivisor})`
                : `Divided by ${monthlyRateDivisor} to get the daily rate used in payroll.`;
            } else {
              rateLabel.textContent = 'Daily rate';
              rateHint.textContent = '';
            }
          }
          rateTypeSel.addEventListener('change', updateRateUI);
          rateAmountInp.addEventListener('input', updateRateUI);
          updateRateUI();

          const rateHistoryToggle = ov.querySelector('#emp-rate-history-toggle');
          if (rateHistoryToggle) {
            const historyEl = ov.querySelector('#emp-rate-history');
            let historyLoaded = false;
            rateHistoryToggle.onclick = () => {
              const opening = historyEl.style.display === 'none';
              historyEl.style.display = opening ? 'block' : 'none';
              if (opening && !historyLoaded) loadRateHistory();
            };
            // The rate fields are read-only while editing: a rate change goes through its own
            // dialog, which logs it and recomputes the affected payslips straight away. The
            // fields then show the rate in force today, so Save here never re-sends an old rate.
            const rateChangeBtn = ov.querySelector('#emp-rate-change');
            if (rateChangeBtn) rateChangeBtn.onclick = () => rateChangeModal(existing, (r) => {
              existing.rate_type = r.rate_type;
              existing.daily_rate = r.daily_rate;
              existing.monthly_rate = r.monthly_rate;
              rateTypeSel.value = r.rate_type;
              rateAmountInp.value = String(r.rate_type === 'monthly' ? r.monthly_rate : r.daily_rate);
              updateRateUI();
              if (historyEl.style.display !== 'none') loadRateHistory(); else historyLoaded = false;
              load();
            });
            async function loadRateHistory() {
              historyLoaded = true;
              historyEl.innerHTML = '<div class="muted" style="padding:6px 0">Loading…</div>';
              try {
                const rows = await API.get(`/hr/employees/${existing.id}/rate-history`);
                historyEl.innerHTML = rows.length
                  ? rows.map((r) => `
                    <div class="tool-row">
                      <div class="tool-row-main">
                        <div class="tool-row-title">${r.rate_type === 'monthly'
                          ? `${money(r.monthly_rate)}/mo <span class="muted" style="font-weight:normal">(${money(r.daily_rate)}/day)</span>`
                          : `${money(r.daily_rate)}/day`}</div>
                        <div class="tool-row-sub">Since ${UI.fmtDateShort(r.effective_from)}${r.note ? ' · ' + UI.esc(r.note) : ''}</div>
                      </div>
                    </div>`).join('')
                  : '<div class="muted" style="padding:6px 0">No rate changes logged yet.</div>';
              } catch (e) {
                historyEl.innerHTML = `<div class="muted" style="padding:6px 0">${UI.esc(e.message || 'Failed to load')}</div>`;
              }
            }
          }

          const accessBtn = ov.querySelector('#emp-user-access');
          const syncAccessBtn = () => { accessBtn.disabled = !userCombo.getValue(); };
          accessBtn.onclick = () => { if (userCombo.getValue()) AccessEditor.open(Number(userCombo.getValue())); };
          userCombo = UI.combo(ov.querySelector('#emp-user-combo'), userComboOptions(), {
            selected: currentUserId != null ? currentUserId : '',
            placeholder: 'Type a name or username…',
            emptyText: 'No matching account',
            onSelect: () => { syncAccessBtn(); if(ov.__markDirty) ov.__markDirty(); },
            action: {
              label: '+ Create new account',
              onClick: (typed) => createLinkedAccount(ov, typed, (u) => {
                users.push(u);
                users.sort((a, b) => a.full_name.localeCompare(b.full_name));
                userCombo.setOptions(userComboOptions());
                userCombo.setSelected(u.id);
                existing.user_id = u.id;
                syncAccessBtn();
              }),
            },
          });
          syncAccessBtn();

          ov.querySelector('#emp-dept-new').onclick = () => addDepartmentInline(ov.querySelector('[data-f="department_id"]'));
          ov.querySelector('#emp-dept-del').onclick = () => removeDepartmentInline(ov.querySelector('[data-f="department_id"]'));

          const fileInp = ov.querySelector('#emp-photo-file');
          const preview = ov.querySelector('#emp-photo-preview');
          ov.querySelector('#emp-photo-pick').onclick = () => fileInp.click();
          fileInp.addEventListener('change', async () => {
            if (!fileInp.files.length) return;
            try {
              photoData = await resizeImageToDataUrl(fileInp.files[0], 320, 0.82);
              preview.src = photoData;
            } catch (e) {
              UI.toast(e.message, 'error');
            }
          });
          ov.querySelector('#emp-photo-clear').onclick = () => { photoData = ''; preview.src = PLACEHOLDER_PHOTO; };

          if (!editing) return;
          ov.dataset.employeeId = existing.id;
          ov.querySelector('#emp-leave-adjust').onclick=()=>{
            if(Number(ov.querySelector('[data-f="leave_days_per_year"]').value)!==(existing.leave_days_per_year ?? 5) || Number(ov.querySelector('[data-f="leave_days_used"]').value)!==(existing.leave_days_used ?? 0)) { UI.toast('Save your leave field changes before adjusting the balance.','info');return; }
            UI.modal({title:`Adjust leave — ${existing.name}`,bodyHTML:'<p class="muted">This adjustment saves immediately. Use positive days to add leave or negative days to deduct it.</p><label for="leave-days">Days to add / deduct</label><input id="leave-days" type="number" step="0.5"><label for="leave-reason">Reason *</label><textarea id="leave-reason" maxlength="1000"></textarea>',confirmText:'Save adjustment',onConfirm:async(ad,showErr)=>{
              const days=Number(ad.querySelector('#leave-days').value), reason=ad.querySelector('#leave-reason').value.trim();if(!days || reason.length<3){showErr('Enter a non-zero number of days and a short reason.');return false;}
              const res=await API.post(`/hr/employees/${existing.id}/leave-adjustments`,{days,reason});existing.leave_days_per_year=res.entitlement;ov.querySelector('[data-f="leave_days_per_year"]').value=res.entitlement;UI.toast(`Leave adjusted — ${res.remaining} days remaining`);load();
            }});
          };
          ov.querySelector('#emp-leave-history').onclick=async()=>{try{const history=await API.get(`/hr/employees/${existing.id}/leave-adjustments`);UI.modal({title:'Leave adjustment history',cancelText:'Close',bodyHTML:history.length?history.map(h=>`<div class="tool-row"><span>${UI.esc(h.created_at)} · ${UI.esc(h.user_name || '')}</span><span>${UI.esc(h.summary)}</span></div>`).join(''):'<p class="muted">No recorded adjustments.</p>'});}catch(e){UI.toast(e.message,'error');}};
          const docsEl = ov.querySelector('#emp-docs');
          async function loadDocs() {
            let docs; try { docs = await API.get(`/hr/employees/${existing.id}/documents`); } catch(e) { docsEl.innerHTML = `<p>${UI.esc(e.message)}</p><button type="button" class="btn secondary small" id="emp-doc-retry">Retry documents</button>`; docsEl.querySelector('#emp-doc-retry').onclick=loadDocs; return; }
            if (!docs.length) { docsEl.innerHTML = '<div class="muted" style="padding:6px 0">No documents uploaded yet.</div>'; return; }
            docsEl.innerHTML = docs.map((d) => `
              <div class="tool-row" data-doc="${d.id}">
                <div class="tool-row-main">
                  <div class="tool-row-title">${UI.esc(d.title)}</div>
                  <div class="tool-row-sub">${UI.esc(d.original_name)} · ${UI.fmtDateShort(d.created_at)}</div>
                </div>
                <button type="button" class="icon-btn" data-doc-dl="${d.id}" title="Download">${UI.icon('download')}</button>
                <button type="button" class="icon-btn danger" data-doc-del="${d.id}" title="Delete">${UI.icon('trash')}</button>
              </div>`).join('');
            docsEl.querySelectorAll('[data-doc-dl]').forEach((b) => b.onclick = () => downloadDoc(existing.id, b.dataset.docDl, docs));
            docsEl.querySelectorAll('[data-doc-del]').forEach((b) => b.onclick = async () => {
              if (!await UI.confirmDialog('Delete this document?', 'Delete')) return;
              try { await API.del(`/hr/employees/${existing.id}/documents/${b.dataset.docDel}`); loadDocs(); } catch(e) { UI.toast(e.message,'error'); }
            });
          }
          const docFileInp = ov.querySelector('#emp-doc-file');
          ov.querySelector('#emp-doc-add').onclick = () => docFileInp.click();
          docFileInp.addEventListener('change', async () => {
            if (!docFileInp.files.length) return;
            const fd = new FormData();
            fd.append('file', docFileInp.files[0]);
            fd.append('title', docFileInp.files[0].name);
            try {
              await API.upload(`/hr/employees/${existing.id}/documents`, fd);
              UI.toast('Document uploaded');
              docFileInp.value = '';
              loadDocs();
            } catch (e) {
              UI.toast(e.message, 'error');
            }
          });
          loadDocs();

          const assetsEl = ov.querySelector('#emp-assets');
          async function loadAssets() {
            let issuances; try { issuances = await API.get(`/hr/employees/${existing.id}/assets`); } catch(e) { assetsEl.innerHTML = `<p>${UI.esc(e.message)}</p><button type="button" class="btn secondary small" id="emp-assets-retry">Retry assets</button>`; assetsEl.querySelector('#emp-assets-retry').onclick=loadAssets; return; }
            if (!issuances.length) { assetsEl.innerHTML = '<div class="muted" style="padding:6px 0">No assets issued yet.</div>'; return; }
            assetsEl.innerHTML = issuances.map((f) => `
              <div class="tool-row" data-issuance="${f.id}" style="align-items:flex-start">
                <div class="tool-row-main">
                  <div class="tool-row-title">${UI.esc(f.number)} <span class="muted" style="font-weight:normal">· ${UI.fmtDateShort(f.issued_date)}${f.issued_by_name ? ' · by ' + UI.esc(f.issued_by_name) : ''}</span></div>
                  <div style="margin-top:4px">
                    ${(f.items || []).map((it) => `
                      <div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12.5px">
                        <span class="badge-pill ${ASSET_STATUS_CLASS[it.status] || 'muted'}" style="min-width:64px;text-align:center">${ASSET_STATUS_LABELS[it.status] || it.status}</span>
                        <span>${UI.esc(it.asset_name)}${it.asset_tag ? ' · ' + UI.esc(it.asset_tag) : ''}${it.quantity > 1 ? ' ×' + it.quantity : ''}</span>
                        ${it.status === 'issued' ? `<button type="button" class="icon-btn" data-asset-return="${it.id}" data-issuance-id="${f.id}" title="Mark returned">${UI.icon('check', 14)}</button>` : ''}
                      </div>`).join('')}
                  </div>
                  ${f.notes ? `<div class="tool-row-sub" style="margin-top:4px">${UI.esc(f.notes)}</div>` : ''}
                </div>
                <button type="button" class="icon-btn" data-asset-print="${f.id}" title="Print form">${UI.icon('printer')}</button>
                <button type="button" class="icon-btn danger" data-asset-del="${f.id}" title="Delete">${UI.icon('trash')}</button>
              </div>`).join('');
            assetsEl.querySelectorAll('[data-asset-return]').forEach((b) => b.onclick = () =>
              returnAssetModal(Number(b.dataset.issuanceId), Number(b.dataset.assetReturn), loadAssets));
            assetsEl.querySelectorAll('[data-asset-print]').forEach((b) => b.onclick = () => {
              const full = issuances.find((x) => String(x.id) === b.dataset.assetPrint);
              if (full) printAssetIssuance(existing, full);
            });
            assetsEl.querySelectorAll('[data-asset-del]').forEach((b) => b.onclick = async () => {
              if (!await UI.confirmDialog('Delete this asset issuance record?', 'Delete')) return;
              try { await API.del(`/hr/assets/${b.dataset.assetDel}`); loadAssets(); } catch(e) { UI.toast(e.message,'error'); }
            });
          }
          ov.querySelector('#emp-asset-issue').onclick = () => assetIssuanceModal(existing, loadAssets);
          loadAssets();
        },
        onConfirm: async (ov, showErr) => {
          const name = ov.querySelector('[data-f="name"]').value.trim();
          if (!name) { activateEmpTab(ov, 'basic'); showErr('Employee name is required'); return false; }
          const employeeNo = ov.querySelector('[data-f="employee_no"]').value.trim();
          if (!employeeNo) { activateEmpTab(ov, 'basic'); showErr('Employee number is required'); return false; }
          const rateTypeVal = ov.querySelector('[data-f="rate_type"]').value;
          const rateAmountVal = Number(ov.querySelector('[data-f="rate_amount"]').value) || 0;
          if (rateTypeVal === 'monthly' && rateAmountVal <= 0) { activateEmpTab(ov, 'pay'); showErr('Monthly rate is required'); return false; }
          const body = {
            employee_no: employeeNo,
            name,
            department_id: ov.querySelector('[data-f="department_id"]').value || null,
            position: ov.querySelector('[data-f="position"]').value.trim(),
            user_id: userCombo.getValue() || null,
            default_shift_id: ov.querySelector('[data-f="default_shift_id"]').value || null,
            rate_type: rateTypeVal,
            daily_rate: rateTypeVal === 'daily' ? rateAmountVal : 0,
            monthly_rate: rateTypeVal === 'monthly' ? rateAmountVal : null,
            status: ov.querySelector('[data-f="status"]').value,
            start_date: ov.querySelector('[data-f="start_date"]').value,
            birth_date: ov.querySelector('[data-f="birth_date"]').value,
            civil_status: ov.querySelector('[data-f="civil_status"]').value,
            sss_no: ov.querySelector('[data-f="sss_no"]').value.trim(),
            philhealth_no: ov.querySelector('[data-f="philhealth_no"]').value.trim(),
            pagibig_no: ov.querySelector('[data-f="pagibig_no"]').value.trim(),
            tin_no: ov.querySelector('[data-f="tin_no"]').value.trim(),
            leave_days_per_year: Number(ov.querySelector('[data-f="leave_days_per_year"]').value) || 0,
            leave_days_used: Number(ov.querySelector('[data-f="leave_days_used"]').value) || 0,
            rest_days: ov.querySelector('#emp-rd-custom').checked
              ? [...ov.querySelectorAll('[data-rd]:checked')].map((cb) => Number(cb.dataset.rd))
              : null,
            late_exempt: ov.querySelector('[data-f="late_exempt"]').checked,
            ot_exempt: ov.querySelector('[data-f="ot_exempt"]').checked,
            always_whole_day: ov.querySelector('[data-f="always_whole_day"]').checked,
            clock_anywhere: ov.querySelector('[data-f="clock_anywhere"]').checked,
            deduct_sss: ov.querySelector('[data-f="deduct_sss"]').checked,
            deduct_philhealth: ov.querySelector('[data-f="deduct_philhealth"]').checked,
            deduct_pagibig: ov.querySelector('[data-f="deduct_pagibig"]').checked,
            deduct_withholding_tax: ov.querySelector('[data-f="deduct_withholding_tax"]').checked,
            withholding_tax_override: ov.querySelector('[data-f="withholding_tax_override"]').value.trim() || null,
            sss_override: ov.querySelector('[data-f="sss_override"]').value.trim() || null,
            philhealth_override: ov.querySelector('[data-f="philhealth_override"]').value.trim() || null,
            pagibig_override: ov.querySelector('[data-f="pagibig_override"]').value.trim() || null,
            contribution_basis: ov.querySelector('[data-f="contribution_basis_fixed"]').checked ? 'fixed' : 'actual',
            photo: photoData,
          };
          if (editing) await API.put('/hr/employees/' + existing.id, body);
          else await API.post('/hr/employees', body);
          UI.toast(editing ? 'Employee saved' : 'Employee created');
          load();
        },
      });
    });
  }

  /* ---------- Change rate (logs it, then recomputes the payslips it reaches) ---------- */
  function rateLabelText(r) {
    return r.rate_type === 'monthly' ? `${money(r.monthly_rate)}/mo (${money(r.daily_rate)}/day)` : `${money(r.daily_rate)}/day`;
  }

  function rateChangeModal(emp, onDone) {
    // Same UTC "today" the server checks a future date against.
    const today = new Date().toISOString().slice(0, 10);
    const type = emp.rate_type || 'daily';
    UI.modal({
      title: `Change rate — ${emp.name}`,
      bodyHTML: `
        <p class="muted" style="font-size:13px;margin-top:0">Current rate: <strong>${UI.esc(rateLabelText(emp))}</strong></p>
        <div class="field-row">
          <div><label>Rate type</label><select data-r="rate_type">
            <option value="daily" ${type === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="monthly" ${type === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select></div>
          <div><label data-r="amount_label">${type === 'monthly' ? 'New monthly rate' : 'New daily rate'}</label>
            <input data-r="amount" type="number" step="0.01" min="0" />
            <div class="muted" data-r="amount_hint" style="font-size:12px;margin-top:3px"></div>
          </div>
        </div>
        <div class="field-row" style="margin-top:8px">
          <div><label>Effective date</label><input data-r="effective_date" type="date" max="${today}" value="${today}" /></div>
          <div><label>Note (optional)</label><input data-r="note" maxlength="200" placeholder="e.g. Annual raise" /></div>
        </div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Days before the effective date keep the old rate. Every
          unpaid payslip for a cutoff ending on or after it is recomputed now. Payslips already marked paid are not
          changed — you'll see how much each one is short. Can be backdated; a future date isn't supported yet.</p>`,
      confirmText: 'Change rate',
      onOpen: (ov) => {
        const typeSel = ov.querySelector('[data-r="rate_type"]');
        const amountInp = ov.querySelector('[data-r="amount"]');
        const sync = () => {
          const monthly = typeSel.value === 'monthly';
          ov.querySelector('[data-r="amount_label"]').textContent = monthly ? 'New monthly rate' : 'New daily rate';
          const amt = Number(amountInp.value) || 0;
          ov.querySelector('[data-r="amount_hint"]').textContent = monthly && amt
            ? `≈ ${money(amt / monthlyRateDivisor)} / day (monthly ÷ ${monthlyRateDivisor})` : '';
        };
        typeSel.addEventListener('change', sync);
        amountInp.addEventListener('input', sync);
        setTimeout(() => amountInp.focus(), 0);
      },
      onConfirm: async (ov, showErr) => {
        const rateType = ov.querySelector('[data-r="rate_type"]').value;
        const amount = Number(ov.querySelector('[data-r="amount"]').value) || 0;
        const effectiveDate = ov.querySelector('[data-r="effective_date"]').value;
        if (amount <= 0) { showErr('Enter the new rate'); return false; }
        if (!effectiveDate) { showErr('Pick the date the new rate takes effect'); return false; }
        if (effectiveDate > today) { showErr('The effective date can\'t be in the future yet'); return false; }
        const result = await API.post(`/hr/employees/${emp.id}/rate-change`, {
          rate_type: rateType,
          daily_rate: rateType === 'daily' ? amount : 0,
          monthly_rate: rateType === 'monthly' ? amount : null,
          effective_date: effectiveDate,
          note: ov.querySelector('[data-r="note"]').value.trim() || null,
        });
        onDone(result);
        rateChangeResultModal(emp, { rate_type: rateType, daily_rate: rateType === 'monthly' ? amount / monthlyRateDivisor : amount, monthly_rate: amount }, effectiveDate, result);
      },
    });
  }

  function rateChangeResultModal(emp, newRate, effectiveDate, result) {
    const recomputed = result.recomputed || [];
    const paid = result.paid || [];
    const glPosted = recomputed.filter((r) => r.gl_posted);
    const owed = paid.reduce((s, p) => s + (Number(p.difference) || 0), 0);
    const row = (title, sub) => `
      <div class="tool-row"><div class="tool-row-main">
        <div class="tool-row-title">${title}</div><div class="tool-row-sub">${sub}</div>
      </div></div>`;
    UI.modal({
      title: 'Rate changed',
      cancelText: 'Close',
      bodyHTML: `
        <p style="margin-top:0">${UI.esc(emp.name)} is now on <strong>${UI.esc(rateLabelText(newRate))}</strong>
          from ${UI.esc(UI.fmtDateShort(effectiveDate))}.</p>
        ${!recomputed.length && !paid.length ? `<p class="muted" style="font-size:13px">No payslips were affected —
          cutoffs generated from now on use the new rate.</p>` : ''}
        ${recomputed.length ? `
          <label style="display:block;margin-top:14px">Payslips recomputed (${recomputed.length})</label>
          ${recomputed.map((r) => row(
            `${UI.esc(r.period)} <span class="muted" style="font-weight:normal">· ${UI.esc(r.number)}</span>`,
            `Gross ${money(r.earnings_before)} → ${money(r.earnings_after)} · Net ${money(r.net_before)} → ${money(r.net_after)}`
          )).join('')}` : ''}
        ${glPosted.length ? `<p class="form-error" style="margin-top:8px">Already posted to the General Ledger:
          ${glPosted.map((r) => UI.esc(r.period)).join(', ')}. Open each cutoff and post its payroll to the GL again.</p>` : ''}
        ${paid.length ? `
          <label style="display:block;margin-top:14px">Already paid — not changed (${paid.length})</label>
          ${paid.map((p) => row(
            `${UI.esc(p.period)} <span class="muted" style="font-weight:normal">· ${UI.esc(p.number)}</span>`,
            `Paid ${money(p.earnings_paid)} gross · at the new rate ${money(p.earnings_at_new_rate)} · `
              + `<strong>${p.difference >= 0 ? 'short' : 'over'} ${money(Math.abs(p.difference))}</strong>`
          )).join('')}
          <p class="muted" style="font-size:12px;margin:6px 0 0">Total ${owed >= 0 ? 'owed' : 'overpaid'}:
            <strong>${money(Math.abs(owed))}</strong> gross. Settle it by hand, or unmark a payslip as paid and
            regenerate its cutoff to recompute it.</p>` : ''}`,
    });
  }

  /* ---------- Employee-number format settings (admin-configured, purely a suggestion) ---------- */
  async function numberSettingsModal() {
    const policy = await API.get('/hr/employee-number-policy').catch(() => null);

    UI.modal({
      title: 'Employee Numbering Format',
      bodyHTML: `
        <p class="muted" style="font-size:13px;margin-top:0">
          Shapes the RECOMMENDED number offered when adding a new employee — the field itself
          always stays editable, so the company can still type its own number instead.
        </p>
        <div class="field-row">
          <div><label>Prefix</label><input data-p="prefix" maxlength="20" placeholder="e.g. EMP (optional)" /></div>
          <div><label>Numbering</label><select data-p="mode">
            <option value="sequential">Increasing number</option>
            <option value="hire_date">Based on hire date</option>
          </select></div>
        </div>
        <div class="field-row" style="margin-top:10px">
          <div><label>Digits (zero-padded)</label><input data-p="pad" type="number" min="1" max="8" /></div>
          <div data-date-fmt-row><label>Hire date format</label><select data-p="date_format">
            <option value="YYYYMMDD">YYYYMMDD (e.g. 20260827)</option>
            <option value="YYMMDD">YYMMDD (e.g. 260827)</option>
          </select></div>
        </div>
        <p class="muted" style="font-size:12px" id="emp-no-preview"></p>
        <button type="button" class="btn" id="emp-no-save" style="margin-top:6px">${UI.icon('sheet', 14)} Save</button>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const p = (k) => ov.querySelector(`[data-p="${k}"]`);
        if (policy) {
          p('prefix').value = policy.prefix;
          p('mode').value = policy.mode;
          p('pad').value = policy.pad;
          p('date_format').value = policy.date_format;
        }
        const dateFmtRow = ov.querySelector('[data-date-fmt-row]');
        const preview = ov.querySelector('#emp-no-preview');
        function currentPolicy() {
          return {
            prefix: p('prefix').value.trim(),
            mode: p('mode').value,
            pad: Number(p('pad').value) || 5,
            date_format: p('date_format').value,
          };
        }
        function updatePreview() {
          const pol = currentPolicy();
          dateFmtRow.style.display = pol.mode === 'hire_date' ? '' : 'none';
          const padded = String(1).padStart(pol.pad, '0');
          preview.textContent = pol.mode === 'hire_date'
            ? `Example: ${pol.prefix}20260827-${padded} (second same-day hire becomes -${String(2).padStart(pol.pad, '0')})`
            : `Example: ${pol.prefix ? pol.prefix + '-' : ''}${padded}`;
        }
        ['prefix', 'mode', 'pad', 'date_format'].forEach((k) => p(k).addEventListener('input', updatePreview));
        updatePreview();

        ov.querySelector('#emp-no-save').onclick = async () => {
          try {
            await API.put('/hr/employee-number-policy', currentPolicy());
            UI.toast('Numbering format saved');
          } catch (e) {
            UI.toast(e.message, 'error');
          }
        };
      },
    });
  }

  async function downloadDoc(employeeId, docId, docs) {
    const doc = docs.find((x) => String(x.id) === String(docId));
    try {
      const res = await fetch(API.base() + `/api/hr/employees/${employeeId}/documents/${docId}/download`, {
        headers: { Authorization: 'Bearer ' + API.getToken() },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (doc && doc.original_name) || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  /* ---------- Assets issued: an "Asset Issuance Form" per submission, one or more asset
     lines per form, each independently returnable ---------- */

  function assetLineRow(l) {
    l = l || {};
    return `<tr>
      <td><input data-name value="${UI.esc(l.asset_name || '')}" placeholder="e.g. Laptop - Dell XPS 13" style="width:100%" /></td>
      <td><input data-cat value="${UI.esc(l.category || '')}" placeholder="Laptop, Tool, Uniform…" style="width:100%" /></td>
      <td><input data-tag value="${UI.esc(l.asset_tag || '')}" placeholder="Serial / tag" style="width:100%" /></td>
      <td><input data-qty type="number" min="1" step="1" value="${l.quantity || 1}" style="width:64px" /></td>
      <td><input data-cond value="${UI.esc(l.condition_on_issue || '')}" placeholder="New, Good…" style="width:100%" /></td>
      <td><button type="button" class="icon-btn danger" data-rm title="Remove">${UI.icon('trash')}</button></td>
    </tr>`;
  }

  function assetIssuanceModal(emp, after) {
    UI.modal({
      title: 'Issue asset — ' + emp.name,
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Issue date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div style="flex:1"><label>Notes</label><input data-f="note" placeholder="Optional" /></div>
        </div>
        <h4 style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Assets</h4>
        <table><thead><tr><th>Asset</th><th>Category</th><th>Tag / Serial</th><th style="width:64px">Qty</th><th>Condition</th><th></th></tr></thead>
          <tbody id="asset-rows">${assetLineRow()}</tbody></table>
        <button type="button" class="btn secondary small" id="asset-add-row" style="margin-top:8px">${UI.icon('plus')} Add asset</button>`,
      confirmText: 'Issue',
      onOpen: (ov) => {
        ov.querySelector('#asset-add-row').onclick = () =>
          ov.querySelector('#asset-rows').insertAdjacentHTML('beforeend', assetLineRow());
        ov.querySelector('#asset-rows').addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rm]');
          if (rm) rm.closest('tr').remove();
        });
      },
      onConfirm: async (ov, showErr) => {
        const items = [];
        ov.querySelectorAll('#asset-rows tr').forEach((tr) => {
          const asset_name = tr.querySelector('[data-name]').value.trim();
          if (!asset_name) return;
          items.push({
            asset_name,
            category: tr.querySelector('[data-cat]').value.trim() || null,
            asset_tag: tr.querySelector('[data-tag]').value.trim() || null,
            quantity: Number(tr.querySelector('[data-qty]').value) || 1,
            condition_on_issue: tr.querySelector('[data-cond]').value.trim() || null,
          });
        });
        if (!items.length) { showErr('Add at least one asset'); return false; }
        const issueDate = ov.querySelector('[data-f="date"]').value;
        if (!issueDate) { showErr('Issue date is required'); return false; }
        let created;
        try {
          created = await API.post(`/hr/employees/${emp.id}/assets`, {
            issued_date: issueDate,
            notes: ov.querySelector('[data-f="note"]').value.trim() || null,
            items,
          });
        } catch (e) { showErr(e.message); return false; }
        UI.toast('Asset(s) issued');
        if (after) after();
        const full = await API.get(`/hr/assets/${created.id}`).catch(() => null);
        if (full) printAssetIssuance(emp, full);
      },
    });
  }

  // Shared with the company-wide register (hr-assets.js).
  const returnAssetModal = (issuanceId, itemId, after) => HRAssets.returnModal(issuanceId, itemId, after);

  /* Default body used only if the editable "Asset Issuance Form" document template (Documents >
     Templates) is somehow missing — normal installs always have the seeded one. */
  const FALLBACK_ASSET_FORM_TEMPLATE = `<div style="font-family:Arial,sans-serif;font-size:12px;max-width:680px;margin:0 auto">
    <h2 style="text-align:center;margin:0 0 4px">ASSET ISSUANCE FORM</h2>
    <div style="text-align:center;color:#555;font-size:11px;margin-bottom:14px">{{company.name}} · Form {{issuance.number}} · Issued {{issuance.issued_date}}</div>
    <p><strong>Employee:</strong> {{employee.name}} ({{employee.employee_no}})</p>
    <table style="width:100%;border-collapse:collapse;margin-top:6px">
      <thead><tr><th style="border:1px solid #ccc;padding:4px">Asset</th><th style="border:1px solid #ccc;padding:4px">Tag</th><th style="border:1px solid #ccc;padding:4px">Qty</th><th style="border:1px solid #ccc;padding:4px">Condition</th></tr></thead>
      <tbody>{{#items}}<tr><td style="border:1px solid #ccc;padding:4px">{{asset_name}}</td><td style="border:1px solid #ccc;padding:4px">{{asset_tag}}</td><td style="border:1px solid #ccc;padding:4px">{{quantity}}</td><td style="border:1px solid #ccc;padding:4px">{{condition_on_issue}}</td></tr>{{/items}}</tbody>
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:40px;font-size:10px">
      <div style="width:46%;border-top:1px solid #666;padding-top:3px;text-align:center">{{employee.name}}<br/>Employee signature</div>
      <div style="width:46%;border-top:1px solid #666;padding-top:3px;text-align:center">{{issuance.issued_by_name}}<br/>Issued by</div>
    </div>
  </div>`;

  // Same preview-modal + iframe pattern as generateId() below — avoids window.open() popup blocking.
  async function printAssetIssuance(emp, issuance) {
    try {
      const [templateList, company] = await Promise.all([
        API.get('/templates'),
        API.get('/templates/company'),
      ]);
      const meta = templateList.find((t) => t.name === 'Asset Issuance Form');
      const tpl = meta ? await API.get('/templates/' + meta.id) : null;
      const tplBody = tpl ? tpl.body : FALLBACK_ASSET_FORM_TEMPLATE;
      const ctx = {
        company,
        employee: {
          name: emp.name, employee_no: emp.employee_no || '', position: emp.position || '',
          department: emp.department_name || '',
        },
        issuance: {
          number: issuance.number, issued_date: UI.fmtDateShort(issuance.issued_date),
          notes: issuance.notes || '', issued_by_name: issuance.issued_by_name || '',
        },
        items: (issuance.items || []).map((it) => ({
          asset_name: it.asset_name, category: it.category || '', asset_tag: it.asset_tag || '',
          quantity: it.quantity, condition_on_issue: it.condition_on_issue || '',
        })),
        today: new Date().toLocaleDateString(),
      };
      const full = UI.printableHtml(renderTemplate(tplBody, ctx), 'Asset Issuance - ' + emp.name);

      UI.modal({
        title: 'Asset Issuance Form Preview',
        size: 'lg',
        bodyHTML: `<iframe id="asset-form-frame" style="width:100%;height:60vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => { ov.querySelector('#asset-form-frame').srcdoc = full; },
        onConfirm: (ov) => {
          const ifr = ov.querySelector('#asset-form-frame');
          ifr.contentWindow.focus();
          ifr.contentWindow.print();
          return false; // keep the preview open — printing shouldn't close it
        },
      });
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  /* ---------- Virtual ID: reuses the same template+print pipeline as payslips ---------- */
  const FALLBACK_ID_TEMPLATE = `<div style="width:85.6mm;height:54mm;border:1px solid #222;border-radius:3mm;padding:4mm;box-sizing:border-box;text-align:center;font-family:Arial,sans-serif">
    <div style="font-weight:700;font-size:10px;text-transform:uppercase">{{company.name}}</div>
    <img src="{{employee.photo}}" style="width:22mm;height:22mm;border-radius:50%;object-fit:cover;margin:2mm 0" />
    <div style="font-weight:700;font-size:13px">{{employee.name}}</div>
    <div style="font-size:10.5px;color:#444">{{employee.position}}</div>
    <div style="font-size:9.5px;color:#666;margin-top:6px">{{employee.employee_no}}</div>
  </div>`;

  // Preview-modal + iframe (same pattern as printSlips() in form-records.js) instead of
  // window.open() — a new browser window/tab can be popup-blocked outright (some browsers/
  // extensions block window.open() unconditionally, not just when it happens late relative
  // to the click); an iframe inside a modal that's already part of the page never opens a
  // new window, so there's nothing for a popup blocker to block.
  async function generateId(emp) {
    try {
      const [templateList, company] = await Promise.all([
        API.get('/templates'),
        API.get('/templates/company'),
      ]);
      const meta = templateList.find((t) => t.name === 'Employee ID Card');
      const tpl = meta ? await API.get('/templates/' + meta.id) : null;
      const tplBody = tpl ? tpl.body : FALLBACK_ID_TEMPLATE;
      const ctx = {
        company,
        employee: {
          name: emp.name, employee_no: emp.employee_no || '', position: emp.position || '',
          department: emp.department_name || '', photo: emp.photo || PLACEHOLDER_PHOTO,
        },
        today: new Date().toLocaleDateString(),
      };
      // Same opt-in Print Grid tiling as form-linked templates (public/js/print-tiling.js) —
      // e.g. a sheet of several ID card blanks (grid > 1x1), or 2 copies of the same card.
      const tiled = tpl && typeof buildTiledPagesHtml === 'function'
        ? buildTiledPagesHtml([emp], () => renderTemplate(tplBody, ctx), {
          copiesPerRecord: tpl.copies_per_record, recordsPerPage: tpl.records_per_page, tileFill: tpl.tile_fill,
          continuous: !!tpl.tile_continuous, repeatCount: tpl.repeat_count,
          pageContentHeightMm: typeof pageContentHeightMm === 'function' ? pageContentHeightMm(tplBody) : undefined,
        })
        : '';
      const full = UI.printableHtml(tiled || renderTemplate(tplBody, ctx), 'ID - ' + emp.name);

      UI.modal({
        title: 'ID Card Preview',
        size: 'lg',
        bodyHTML: `<iframe id="idcard-preview-frame" style="width:100%;height:50vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => {
          const ifr = ov.querySelector('#idcard-preview-frame');
          if (tiled) ifr.onload = () => { if (typeof fitTiledCells === 'function') fitTiledCells(ifr.contentDocument); };
          ifr.srcdoc = full;
        },
        onConfirm: (ov) => {
          const ifr = ov.querySelector('#idcard-preview-frame');
          ifr.contentWindow.focus();
          ifr.contentWindow.print();
          return false; // keep the preview open — printing shouldn't close it
        },
      });
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  async function del(id, list) {
    const e = list.find((x) => String(x.id) === String(id));
    if (!await UI.confirmDialog(`Delete ${e.name}? This cannot be undone.`, 'Delete')) return;
    try {
      await API.del('/hr/employees/' + id);
      UI.toast('Employee deleted');
      load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  let searchTimer;
  view.querySelector('#emp-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.q = e.target.value.trim();
    searchTimer = setTimeout(load, 250);
  });
  view.querySelector('#emp-dept-filter').addEventListener('change', (e) => { state.department_id = e.target.value; load(); });
  view.querySelector('#emp-status-filter').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  const newBtn = view.querySelector('#emp-new');
  if (newBtn) newBtn.addEventListener('click', () => employeeModal(null));
  const noSettingsBtn = view.querySelector('#emp-no-settings');
  if (noSettingsBtn) noSettingsBtn.addEventListener('click', () => numberSettingsModal());
  const importBtn = view.querySelector('#emp-import');
  if (importBtn) importBtn.addEventListener('click', () => UI.csvImportModal({
    title: 'Import employees',
    importPath: '/hr/employees/import',
    exportPath: '/hr/employees/export',
    columnsHtml:
      'Columns: <code>employee_no</code> and <code>name</code> (required), plus <code>department</code> ' +
      '(must already exist), <code>position</code>, <code>rate_type</code> (daily / monthly), ' +
      '<code>daily_rate</code> or <code>monthly_rate</code>, <code>status</code>, <code>start_date</code>, ' +
      '<code>sss_no</code>, <code>philhealth_no</code>, <code>pagibig_no</code>, <code>tin_no</code>. ' +
      'Matched to existing staff by <strong>employee_no</strong>. Never changes the linked login or photo, ' +
      'and does not touch payroll history.',
    templateHeaders: ['employee_no', 'name', 'department', 'position', 'rate_type', 'daily_rate', 'monthly_rate', 'status', 'start_date', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin_no'],
    templateRows: [
      ['EMP-0001', 'Maria Santos', 'Operations', 'Machinist', 'daily', '850', '', 'regular', '2024-03-01', '34-1234567-8', '12-345678901-2', '1234-5678-9012', '123-456-789-000'],
      ['EMP-0002', 'Ben Reyes', 'Finance', 'Accounting Clerk', 'monthly', '', '25000', 'regular', '2023-11-15', '34-7654321-0', '11-223344556-7', '9876-5432-1098', '456-789-123-000'],
      ['EMP-0003', 'Ana Dela Cruz', 'Operations', 'Helper', 'daily', '610', '', 'probationary', '2026-06-01', '', '', '', ''],
    ],
    onDone: () => load(),
  }));

  await load();
  if (filter && filter.id && view.isConnected) openEmployee(filter.id, displayedEmployees);
});
