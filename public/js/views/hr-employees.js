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
      ${canManage ? `<button class="btn" id="emp-new" style="margin-left:8px">${UI.icon('plus')} New Employee</button>` : ''}
    </div>
    <div class="panel"><div id="emp-table"></div></div>`;

  const tableEl = view.querySelector('#emp-table');
  const money = UI.money;

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
        <thead><tr><th></th><th>Name</th><th>Employee No.</th><th>Department</th><th>Position</th><th class="right">Daily Rate</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((e) => `
          <tr class="clickable" data-open="${e.id}">
            <td><img src="${UI.esc(e.photo || PLACEHOLDER_PHOTO)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;vertical-align:middle" /></td>
            <td><strong>${UI.esc(e.name)}</strong></td>
            <td class="mono muted">${UI.esc(e.employee_no || '—')}</td>
            <td>${UI.esc(e.department_name || '—')}</td>
            <td>${UI.esc(e.position || '—')}</td>
            <td class="right">${money(e.daily_rate)}</td>
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
      if (e.target.closest('.actions')) return;
      openEmployee(tr.dataset.open, list);
    });
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

    ensureDepts().then((deptList) => {
      const deptOpts = ['<option value="">— none —</option>']
        .concat(deptList.map((d) => `<option value="${d.id}" ${editing && existing.department_id === d.id ? 'selected' : ''}>${UI.esc(d.name)}</option>`))
        .join('');
      const statusOpts = Object.keys(STATUS_LABELS)
        .map((s) => `<option value="${s}" ${(editing ? existing.status : 'probationary') === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)
        .join('');

      UI.modal({
        title: editing ? `Edit ${existing.name}` : 'New Employee',
        size: 'lg',
        headActionHTML: editing ? `<button type="button" class="btn secondary small" id="emp-gen-id">${UI.icon('idcard', 15)} Generate ID</button>` : '',
        bodyHTML: `
          ${editing ? `<div class="muted mono" style="margin-bottom:10px">${UI.esc(existing.employee_no || '')}</div>` : ''}
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
              <label>Full name *</label><input data-f="name" value="${UI.esc(editing ? existing.name : '')}" autofocus />
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
            <div><label>Daily rate</label><input data-f="daily_rate" type="number" step="0.01" min="0" value="${editing ? UI.esc(String(existing.daily_rate)) : '0'}" /></div>
            <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
            <div><label>Start date</label><input data-f="start_date" type="date" value="${UI.esc(editing ? (existing.start_date || '') : '')}" /></div>
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
          const body = {
            name,
            department_id: ov.querySelector('[data-f="department_id"]').value || null,
            position: ov.querySelector('[data-f="position"]').value.trim(),
            daily_rate: Number(ov.querySelector('[data-f="daily_rate"]').value) || 0,
            status: ov.querySelector('[data-f="status"]').value,
            start_date: ov.querySelector('[data-f="start_date"]').value,
            sss_no: ov.querySelector('[data-f="sss_no"]').value.trim(),
            philhealth_no: ov.querySelector('[data-f="philhealth_no"]').value.trim(),
            pagibig_no: ov.querySelector('[data-f="pagibig_no"]').value.trim(),
            tin_no: ov.querySelector('[data-f="tin_no"]').value.trim(),
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

  await load();
});
