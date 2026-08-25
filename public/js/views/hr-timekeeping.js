/* HR: Time Keeping — cutoff periods with a roster of employees and a daily
   time-in/time-out grid per employee. "Generate Payslips" creates/updates one
   record per roster employee in the existing "HR Payroll" form (Documents >
   Data Forms), reusing that module's print-ready payslip flow.
   Route: hr-timekeeping. filter.period_id = <id> opens a specific cutoff. */
App.register('hr-timekeeping', async (view, filter) => {
  if (filter && filter.period_id) {
    await renderPeriod(view, Number(filter.period_id));
  } else {
    await renderList(view);
  }
});

/* ── Cutoff list ──────────────────────────────────────────────────────────── */
async function renderList(view) {
  view.innerHTML = `
    <div class="topbar">
      <h2>Time Keeping</h2>
      <div class="grow"></div>
      <button class="btn" id="tk-new">${UI.icon('plus')} New Cutoff</button>
    </div>
    <div class="panel"><div id="tk-table"></div></div>`;

  const tableEl = view.querySelector('#tk-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const list = await API.get('/hr/periods');
    render(list);
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'calendar',
        title: 'No cutoffs yet',
        hint: 'Create a pay cutoff to start logging daily time-in/out.',
        action: `<button class="btn" id="tk-empty-new">${UI.icon('plus')} New Cutoff</button>`,
      });
      const en = tableEl.querySelector('#tk-empty-new');
      if (en) en.onclick = () => periodModal(null, load);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Cutoff</th><th>Date range</th><th class="right">Employees</th><th></th></tr></thead>
        <tbody>${list.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><strong>${UI.esc(p.label)}</strong></td>
            <td>${UI.esc(p.start_date)} &ndash; ${UI.esc(p.end_date)}</td>
            <td class="right">${p.employee_count || 0}</td>
            <td class="actions"><button class="icon-btn danger" title="Delete" data-del="${p.id}">${UI.icon('trash')}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); del(b.dataset.del, list); });
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      App.navigate('hr-timekeeping', { period_id: tr.dataset.open });
    });
  }

  async function del(id, list) {
    const p = list.find((x) => String(x.id) === String(id));
    if (!await UI.confirmDialog(`Delete cutoff "${p.label}"? All logged time-in/out for it will be lost.`, 'Delete')) return;
    await API.del('/hr/periods/' + id);
    UI.toast('Cutoff deleted');
    load();
  }

  view.querySelector('#tk-new').addEventListener('click', () => periodModal(null, load));
  await load();
}

/* ── Cutoff create/edit modal ─────────────────────────────────────────────── */
function periodModal(existing, onSaved) {
  const editing = !!existing;
  UI.modal({
    title: editing ? `Edit ${existing.label}` : 'New Cutoff',
    bodyHTML: `
      <div><label>Label *</label><input data-f="label" placeholder="e.g. Aug 1-15, 2026" value="${UI.esc(editing ? existing.label : '')}" autofocus /></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Start date *</label><input data-f="start_date" type="date" value="${UI.esc(editing ? existing.start_date : '')}" /></div>
        <div><label>End date *</label><input data-f="end_date" type="date" value="${UI.esc(editing ? existing.end_date : '')}" /></div>
      </div>`,
    confirmText: editing ? 'Save' : 'Create',
    onConfirm: async (ov, showErr) => {
      const body = {
        label: ov.querySelector('[data-f="label"]').value.trim(),
        start_date: ov.querySelector('[data-f="start_date"]').value,
        end_date: ov.querySelector('[data-f="end_date"]').value,
      };
      if (!body.label) { showErr('Cutoff label is required'); return false; }
      if (!body.start_date || !body.end_date) { showErr('Start and end dates are required'); return false; }
      if (editing) await API.put('/hr/periods/' + existing.id, body);
      else await API.post('/hr/periods', body);
      UI.toast(editing ? 'Cutoff saved' : 'Cutoff created');
      if (onSaved) onSaved();
    },
  });
}

/* ── Cutoff detail: roster + daily grid ──────────────────────────────────── */
async function renderPeriod(view, periodId) {
  let period = null;
  try { period = await API.get('/hr/periods/' + periodId); }
  catch { view.innerHTML = '<div class="empty">Cutoff not found.</div>'; return; }

  view.innerHTML = `
    <div class="topbar">
      <button class="btn secondary small" id="tk-back">&larr; All Cutoffs</button>
      <h2 style="margin-left:10px">${UI.esc(period.label)}</h2>
      <span class="muted" style="margin-left:6px">${UI.esc(period.start_date)} &ndash; ${UI.esc(period.end_date)}</span>
      <div class="grow"></div>
      <button class="btn secondary" id="tk-edit-period">${UI.icon('edit')} Edit Cutoff</button>
      <button class="btn" id="tk-generate" style="margin-left:8px">${UI.icon('sheet')} Generate Payslips</button>
    </div>
    <div class="panel">
      <div class="topbar" style="padding:0 0 14px;background:none;border:none">
        <div class="grow"></div>
        <button class="btn secondary" id="tk-add-emp">${UI.icon('plus')} Add Employee</button>
      </div>
      <div id="tk-roster"></div>
    </div>`;

  view.querySelector('#tk-back').onclick = () => App.navigate('hr-timekeeping');
  view.querySelector('#tk-edit-period').onclick = () => periodModal(period, async () => {
    period = await API.get('/hr/periods/' + periodId);
    renderRoster();
  });
  view.querySelector('#tk-generate').onclick = () => generateModal();
  view.querySelector('#tk-add-emp').onclick = () => addEmployeeModal();

  const rosterEl = view.querySelector('#tk-roster');

  function renderRoster() {
    const roster = period.roster || [];
    if (!roster.length) {
      rosterEl.innerHTML = UI.emptyState({
        icon: 'users',
        title: 'No employees on this cutoff yet',
        hint: 'Add employees to start logging their daily time-in/out.',
      });
      return;
    }
    rosterEl.innerHTML = `
      <table>
        <thead><tr><th>Employee</th><th>Department</th><th class="right">Daily Rate</th><th class="right">Days Logged</th><th></th></tr></thead>
        <tbody>${roster.map((r) => `
          <tr class="clickable" data-open="${r.employee_id}">
            <td><strong>${UI.esc(r.name)}</strong></td>
            <td>${UI.esc(r.department_name || '—')}</td>
            <td class="right">${Number(r.daily_rate || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td class="right">${r.days_logged || 0} / ${r.days_total || 0}</td>
            <td class="actions"><button class="icon-btn danger" title="Remove from cutoff" data-rm="${r.employee_id}">${UI.icon('trash')}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    rosterEl.querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeEmployee(b.dataset.rm, roster); });
    rosterEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      const r = roster.find((x) => String(x.employee_id) === tr.dataset.open);
      if (r) dailyGridModal(r);
    });
  }

  async function reload() {
    period = await API.get('/hr/periods/' + periodId);
    renderRoster();
  }

  async function removeEmployee(employeeId, roster) {
    const r = roster.find((x) => String(x.employee_id) === String(employeeId));
    if (!await UI.confirmDialog(`Remove ${r.name} from this cutoff? Their logged time for it will be lost.`, 'Remove')) return;
    await API.del(`/hr/periods/${periodId}/employees/${employeeId}`);
    UI.toast('Employee removed from cutoff');
    reload();
  }

  /* ---- Add employee (search existing master list, filter by department/status) ---- */
  const STATUS_LABELS = { probationary: 'Probationary', regular: 'Regular', resigned: 'Resigned', terminated: 'Terminated' };

  async function addEmployeeModal() {
    const onRoster = new Set((period.roster || []).map((r) => r.employee_id));
    const depts = await API.get('/users/departments/list').catch(() => []);
    const deptOpts = '<option value="">All departments</option>' +
      depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
    const statusOpts = '<option value="">All statuses</option>' +
      Object.keys(STATUS_LABELS).map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');

    const m = UI.modal({
      title: 'Add employee to cutoff',
      bodyHTML: `<div class="search-box">${UI.icon('search', 16)}<input id="tk-pick-q" placeholder="Search employees…" autofocus /></div>
        <div class="field-row" style="margin-top:8px">
          <div><select id="tk-pick-dept">${deptOpts}</select></div>
          <div><select id="tk-pick-status">${statusOpts}</select></div>
        </div>
        <div id="tk-pick-results" style="margin-top:12px"><div class="empty">Loading…</div></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const q = ov.querySelector('#tk-pick-q');
        const deptSel = ov.querySelector('#tk-pick-dept');
        const statusSel = ov.querySelector('#tk-pick-status');
        const out = ov.querySelector('#tk-pick-results');
        let timer;
        async function search() {
          const params = new URLSearchParams();
          if (q.value.trim()) params.set('q', q.value.trim());
          if (deptSel.value) params.set('department_id', deptSel.value);
          if (statusSel.value) params.set('status', statusSel.value);
          const items = (await API.get('/hr/employees?' + params.toString()))
            .filter((it) => !onRoster.has(it.id));
          if (!items.length) { out.innerHTML = '<div class="empty">No matching employees</div>'; return; }
          out.innerHTML = items.map((it) => `
            <div class="pick-row" data-id="${it.id}">
              <div><strong>${UI.esc(it.name)}</strong> <span class="muted">${UI.esc(it.department_name || '')}</span></div>
              <div class="muted">${UI.esc(it.position || '')} &middot; ${UI.esc(STATUS_LABELS[it.status] || it.status)}</div>
            </div>`).join('');
          out.querySelectorAll('[data-id]').forEach((row) => row.onclick = async () => {
            await API.post(`/hr/periods/${periodId}/employees`, { employee_id: Number(row.dataset.id) });
            UI.toast('Employee added to cutoff');
            m.close();
            reload();
          });
        }
        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        deptSel.addEventListener('change', search);
        statusSel.addEventListener('change', search);
        search();
      },
    });
  }

  /* ---- Daily time-in/out grid for one roster employee ---- */
  async function dailyGridModal(rosterRow) {
    const employeeId = rosterRow.employee_id;
    const days = await API.get(`/hr/periods/${periodId}/attendance?employee_id=${employeeId}`);

    UI.modal({
      title: `Daily time — ${rosterRow.name}`,
      size: 'lg',
      bodyHTML: `<div class="line-items"><table class="line-table"><thead><tr>
          <th>Date</th><th>Time In</th><th>Time Out</th><th>Notes</th>
        </tr></thead><tbody id="tk-days"></tbody></table></div>`,
      confirmText: 'Save',
      onOpen: (ov) => {
        const body = ov.querySelector('#tk-days');
        body.innerHTML = days.map((d, i) => `
          <tr data-row="${i}">
            <td>${UI.esc(d.work_date)}</td>
            <td><input data-k="time_in" type="time" value="${UI.esc(d.time_in || '')}" /></td>
            <td><input data-k="time_out" type="time" value="${UI.esc(d.time_out || '')}" /></td>
            <td><input data-k="notes" value="${UI.esc(d.notes || '')}" placeholder="optional" /></td>
          </tr>`).join('');
        body.querySelectorAll('input[data-k]').forEach((inp) => {
          inp.addEventListener('input', () => {
            const row = Number(inp.closest('[data-row]').dataset.row);
            days[row][inp.dataset.k] = inp.value;
          });
        });
      },
      onConfirm: async () => {
        await API.put(`/hr/periods/${periodId}/attendance`, {
          employee_id: employeeId,
          days: days.map((d) => ({ work_date: d.work_date, time_in: d.time_in || '', time_out: d.time_out || '', notes: d.notes || '' })),
        });
        UI.toast('Attendance saved');
        reload();
      },
    });
  }

  /* ---- Generate payslips ---- */
  function generateModal() {
    UI.modal({
      title: 'Generate payslips',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Creates or updates one HR Payroll record per employee on this cutoff, pre-filled
          with name, department/position, and daily rate. Hours, earnings and deductions are left for you to fill in by hand —
          use the daily log above as reference.</p>
        <div><label>Payroll period label</label><input data-f="payroll_period" value="${UI.esc(period.label)}" /></div>
        <div style="margin-top:10px"><label>Pay date</label><input data-f="pay_date" type="date" /></div>`,
      confirmText: 'Generate',
      onConfirm: async (ov, showErr) => {
        const payroll_period = ov.querySelector('[data-f="payroll_period"]').value.trim();
        if (!payroll_period) { showErr('Payroll period label is required'); return false; }
        const pay_date = ov.querySelector('[data-f="pay_date"]').value;
        const res = await API.post(`/hr/periods/${periodId}/generate-payslips`, { payroll_period, pay_date });
        UI.toast(`Payslips ready: ${res.created} created, ${res.updated} updated`);
        UI.modal({
          title: 'Payslips ready',
          bodyHTML: `<p>${res.created} created, ${res.updated} updated for "${UI.esc(res.period)}".</p>
            <p class="muted">Fill in hours/earnings/deductions there, then use the existing Print flow.</p>`,
          confirmText: 'Open Payroll',
          onConfirm: () => { App.navigate('form-records', { form_id: res.form_id, period: res.period }); },
        });
      },
    });
  }

  renderRoster();
}
