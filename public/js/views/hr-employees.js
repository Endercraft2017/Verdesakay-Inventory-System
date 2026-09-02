/* HR: Employees master list — the 201 file. Identity, department/position, daily rate,
   employment status, statutory numbers, a photo, and uploaded documents. Picked from here
   into Time Keeping cutoffs; identity/rate feed generated payslips. "Generate ID" prints a
   virtual ID card from the editable "Employee ID Card" document template (Documents >
   Templates), the same way payslips print from the "HR Payroll Slip" template.
   Route: hr-employees. */
App.register('hr-employees', async (view) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  const canManage = App.hasPermission('hr.manage');
  const state = { q: '', department_id: '', status: '' };
  let depts = [];

  const STATUS_LABELS = { probationary: 'Probationary', regular: 'Regular', resigned: 'Resigned', terminated: 'Terminated' };
  const STATUS_CLASS = { probationary: 'status-confirmed', regular: 'status-completed', resigned: 'muted', terminated: 'status-cancelled' };
  const PLACEHOLDER_PHOTO = UI.PLACEHOLDER_PHOTO;

  view.innerHTML = `
    <div class="topbar">
      <h2>Employees</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="emp-search" placeholder="Search name…" /></div>
      <select id="emp-dept-filter" style="margin-left:8px"><option value="">All departments</option></select>
      <select id="emp-status-filter" style="margin-left:8px">
        <option value="">All statuses</option>
        ${Object.keys(STATUS_LABELS).map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('')}
      </select>
      ${canManage ? `<button class="btn secondary" id="emp-no-settings" style="margin-left:8px" title="Employee numbering format">${UI.icon('settings', 15)}</button>` : ''}
      ${canManage ? `<button class="btn secondary" id="emp-import" style="margin-left:8px" title="Create or update employees from a CSV file">${UI.icon('upload')} Import</button>` : ''}
      ${canManage ? `<button class="btn danger small" id="emp-remove-selected" style="margin-left:8px" hidden>${UI.icon('trash')} Remove selected</button>` : ''}
      ${canManage ? `<button class="btn" id="emp-new" style="margin-left:8px">${UI.icon('plus')} New Employee</button>` : ''}
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

  async function load() {
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
    const list = await API.get('/hr/employees?' + params.toString());
    render(list);
  }

  function render(list) {
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
        <thead><tr>${canManage ? '<th></th>' : ''}<th></th><th>Name</th><th>Employee No.</th><th>Department</th><th>Position</th><th class="right">Rate</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((e) => `
          <tr class="clickable" data-open="${e.id}">
            ${canManage ? `<td><input type="checkbox" class="emp-chk" data-emp="${e.id}" data-name="${UI.esc(e.name)}" /></td>` : ''}
            <td><img src="${UI.esc(e.photo || PLACEHOLDER_PHOTO)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;vertical-align:middle" /></td>
            <td><strong>${UI.esc(e.name)}</strong>${e.user_id ? ` <span class="muted" title="Linked to account: ${UI.esc(e.linked_username || '')}" style="vertical-align:middle">${UI.icon('key', 13)}</span>` : ''}</td>
            <td class="mono muted">${UI.esc(e.employee_no || '—')}</td>
            <td>${UI.esc(e.department_name || '—')}</td>
            <td>${UI.esc(e.position || '—')}</td>
            <td class="right">${e.rate_type === 'monthly'
              ? `${money(e.monthly_rate)}<span class="muted">/mo</span>`
              : `${money(e.daily_rate)}<span class="muted">/day</span>`}</td>
            <td><span class="badge-pill ${STATUS_CLASS[e.status] || 'muted'}">${STATUS_LABELS[e.status] || e.status}</span></td>
            <td class="actions">
              <button class="icon-btn" title="Generate ID" data-id-card="${e.id}">${UI.icon('idcard')}</button>
              <button class="icon-btn" title="Edit" data-edit="${e.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${e.id}">${UI.icon('trash')}</button>
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
    if (emp) employeeModal(emp);
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
      const userOpts = ['<option value="">— none —</option>']
        .concat(users.map((u) => {
          const taken = linkedElsewhere.get(u.id);
          const label = `${u.full_name} (${u.username})${taken ? ` — linked to ${taken}` : ''}`;
          const selected = currentUserId === u.id ? 'selected' : '';
          const disabled = taken && currentUserId !== u.id ? 'disabled' : '';
          return `<option value="${u.id}" ${selected} ${disabled}>${UI.esc(label)}</option>`;
        }))
        .join('');

      UI.modal({
        title: editing ? `Edit ${existing.name}` : 'New Employee',
        size: 'lg',
        headActionHTML: editing ? `<button type="button" class="btn secondary small" id="emp-gen-id">${UI.icon('idcard', 15)} Generate ID</button>` : '',
        bodyHTML: `
          <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:14px">
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
            <div><label>Rate type</label><select data-f="rate_type">
              <option value="daily" ${rateType === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="monthly" ${rateType === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select></div>
            <div><label id="emp-rate-label">${rateType === 'monthly' ? 'Monthly rate' : 'Daily rate'}</label>
              <input data-f="rate_amount" type="number" step="0.01" min="0" value="${UI.esc(String(rateAmount || 0))}" />
              <div class="muted" id="emp-rate-hint" style="font-size:12px;margin-top:3px"></div>
            </div>
          </div>
          <div class="field-row">
            <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
            <div><label>Start date</label><input data-f="start_date" type="date" value="${UI.esc(editing ? (existing.start_date || '') : '')}" /></div>
          </div>
          <div class="field-row" style="margin-top:10px">
            <div><label>Linked user account</label><select data-f="user_id">${userOpts}</select>
              <div class="muted" style="font-size:12px;margin-top:3px">Ties this employee's 201-file record to their login account (optional).</div>
            </div>
          </div>
          <label style="margin-top:12px;display:block">Statutory numbers</label>
          <div class="field-row">
            <div><label>SSS No.</label><input data-f="sss_no" value="${UI.esc(editing ? (existing.sss_no || '') : '')}" /></div>
            <div><label>PhilHealth No.</label><input data-f="philhealth_no" value="${UI.esc(editing ? (existing.philhealth_no || '') : '')}" /></div>
          </div>
          <div class="field-row">
            <div><label>Pag-IBIG No.</label><input data-f="pagibig_no" value="${UI.esc(editing ? (existing.pagibig_no || '') : '')}" /></div>
            <div><label>TIN</label><input data-f="tin_no" value="${UI.esc(editing ? (existing.tin_no || '') : '')}" /></div>
          </div>
          <label style="margin-top:12px;display:block">Paid leave (simple fixed bank — not accrual-based)</label>
          <div class="field-row">
            <div><label>Days / year</label><input data-f="leave_days_per_year" type="number" step="0.5" min="0" value="${UI.esc(String(editing ? (existing.leave_days_per_year ?? 5) : 5))}" /></div>
            <div><label>Days used (this year)</label><input data-f="leave_days_used" type="number" step="0.5" min="0" value="${UI.esc(String(editing ? (existing.leave_days_used ?? 0) : 0))}" />
              ${editing ? `<div class="muted" style="font-size:12px;margin-top:3px">${UI.esc(String((existing.leave_days_per_year ?? 5) - (existing.leave_days_used ?? 0)))} remaining</div>` : ''}
            </div>
          </div>
          <label style="margin-top:12px;display:block">Default shift</label>
          <select data-f="default_shift_id">${shiftOpts}</select>
          <p class="muted" style="font-size:12px;margin:4px 0 0">Pre-fills new Daily Time rows in Time Keeping — a
            rotating employee can still be set to a different shift, or none, on any single day there. Without a
            shift, late/OT/undertime can't be judged (nothing to compare the clock-in against), though holiday and
            rest-day pay still compute fine either way.</p>
          <label style="margin-top:12px;display:block">Rest days</label>
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
          ${editing ? `
          <label style="margin-top:14px;display:block">201 documents</label>
          <div id="emp-docs"><div class="empty">Loading…</div></div>
          <div class="line-actions">
            <input type="file" id="emp-doc-file" style="display:none" />
            <button type="button" class="btn secondary small" id="emp-doc-add">${UI.icon('upload', 15)} Upload document</button>
          </div>` : ''}`,
        confirmText: editing ? 'Save' : 'Create',
        onOpen: (ov) => {
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
          const docsEl = ov.querySelector('#emp-docs');
          async function loadDocs() {
            const docs = await API.get(`/hr/employees/${existing.id}/documents`).catch(() => []);
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
              await API.del(`/hr/employees/${existing.id}/documents/${b.dataset.docDel}`);
              loadDocs();
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
        },
        onConfirm: async (ov, showErr) => {
          const name = ov.querySelector('[data-f="name"]').value.trim();
          if (!name) { showErr('Employee name is required'); return false; }
          const employeeNo = ov.querySelector('[data-f="employee_no"]').value.trim();
          if (!employeeNo) { showErr('Employee number is required'); return false; }
          const rateTypeVal = ov.querySelector('[data-f="rate_type"]').value;
          const rateAmountVal = Number(ov.querySelector('[data-f="rate_amount"]').value) || 0;
          if (rateTypeVal === 'monthly' && rateAmountVal <= 0) { showErr('Monthly rate is required'); return false; }
          const body = {
            employee_no: employeeNo,
            name,
            department_id: ov.querySelector('[data-f="department_id"]').value || null,
            position: ov.querySelector('[data-f="position"]').value.trim(),
            user_id: ov.querySelector('[data-f="user_id"]').value || null,
            default_shift_id: ov.querySelector('[data-f="default_shift_id"]').value || null,
            rate_type: rateTypeVal,
            daily_rate: rateTypeVal === 'daily' ? rateAmountVal : 0,
            monthly_rate: rateTypeVal === 'monthly' ? rateAmountVal : null,
            status: ov.querySelector('[data-f="status"]').value,
            start_date: ov.querySelector('[data-f="start_date"]').value,
            sss_no: ov.querySelector('[data-f="sss_no"]').value.trim(),
            philhealth_no: ov.querySelector('[data-f="philhealth_no"]').value.trim(),
            pagibig_no: ov.querySelector('[data-f="pagibig_no"]').value.trim(),
            tin_no: ov.querySelector('[data-f="tin_no"]').value.trim(),
            leave_days_per_year: Number(ov.querySelector('[data-f="leave_days_per_year"]').value) || 0,
            leave_days_used: Number(ov.querySelector('[data-f="leave_days_used"]').value) || 0,
            rest_days: ov.querySelector('#emp-rd-custom').checked
              ? [...ov.querySelectorAll('[data-rd]:checked')].map((cb) => Number(cb.dataset.rd))
              : null,
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
      const res = await fetch(`/api/hr/employees/${employeeId}/documents/${docId}/download`, {
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
      const tplBody = meta ? (await API.get('/templates/' + meta.id)).body : FALLBACK_ID_TEMPLATE;
      const ctx = {
        company,
        employee: {
          name: emp.name, employee_no: emp.employee_no || '', position: emp.position || '',
          department: emp.department_name || '', photo: emp.photo || PLACEHOLDER_PHOTO,
        },
        today: new Date().toLocaleDateString(),
      };
      const full = UI.printableHtml(renderTemplate(tplBody, ctx), 'ID - ' + emp.name);

      UI.modal({
        title: 'ID Card Preview',
        size: 'lg',
        bodyHTML: `<iframe id="idcard-preview-frame" style="width:100%;height:50vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => { ov.querySelector('#idcard-preview-frame').srcdoc = full; },
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
});
