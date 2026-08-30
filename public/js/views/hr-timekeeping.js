/* HR: Time Keeping — cutoff periods with a roster of employees and a daily
   time-in/time-out grid per employee. "Generate Payslips" creates/updates one
   record per roster employee in the existing "HR Payroll" form (Documents >
   Data Forms), reusing that module's print-ready payslip flow.
   Route: hr-timekeeping. filter.period_id = <id> opens a specific cutoff. */
App.register('hr-timekeeping', async (view, filter) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
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
      <button class="btn secondary" id="tk-govforms">${UI.icon('sheet')} Payroll Worksheets ▾</button>
      <button class="btn secondary" id="tk-policy" style="margin-left:8px">${UI.icon('settings')} Policy Settings</button>
      <button class="btn" id="tk-new" style="margin-left:8px">${UI.icon('plus')} New Cutoff</button>
    </div>
    <div class="panel"><div id="tk-table"></div></div>`;

  view.querySelector('#tk-policy').addEventListener('click', () => policySettingsModal());
  view.querySelector('#tk-govforms').addEventListener('click', () => govFormsModal());

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

/* ── Shift create/edit modal ──────────────────────────────────────────────── */
function shiftModal(existing, onSaved) {
  const editing = !!existing;
  UI.modal({
    title: editing ? `Edit ${existing.name}` : 'New Shift',
    bodyHTML: `
      <div><label>Name *</label><input data-f="name" value="${UI.esc(editing ? existing.name : '')}" placeholder="e.g. Morning" autofocus /></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Start time *</label><input data-f="start_time" type="time" value="${UI.esc(editing ? existing.start_time : '')}" /></div>
        <div><label>End time *</label><input data-f="end_time" type="time" value="${UI.esc(editing ? existing.end_time : '')}" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">An end time earlier than the start time is treated as an overnight shift (e.g. 22:00 &rarr; 06:00).</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-f="is_default" style="width:auto" ${editing && existing.is_default ? 'checked' : ''} /> Default shift
      </label></div>`,
    confirmText: editing ? 'Save' : 'Create',
    onConfirm: async (ov, showErr) => {
      const name = ov.querySelector('[data-f="name"]').value.trim();
      const start_time = ov.querySelector('[data-f="start_time"]').value;
      const end_time = ov.querySelector('[data-f="end_time"]').value;
      const is_default = ov.querySelector('[data-f="is_default"]').checked;
      if (!name) { showErr('Shift name is required'); return false; }
      if (!start_time || !end_time) { showErr('Start and end time are required'); return false; }
      if (editing) await API.put('/hr/shifts/' + existing.id, { name, start_time, end_time, is_default });
      else await API.post('/hr/shifts', { name, start_time, end_time, is_default });
      UI.toast(editing ? 'Shift saved' : 'Shift created');
      if (onSaved) onSaved();
    },
  });
}

/* ── Policy Settings: shifts list (add/edit/delete/default) + company-wide payroll rules ──── */
async function policySettingsModal() {
  const [shiftsInit, policy] = await Promise.all([
    API.get('/hr/shifts').catch(() => []),
    API.get('/hr/payroll-policy').catch(() => null),
  ]);
  let shifts = shiftsInit;

  UI.modal({
    title: 'Policy Settings',
    size: 'lg',
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <strong>Shifts</strong>
        <button type="button" class="btn secondary small" id="tk-shift-add">${UI.icon('plus', 14)} Add Shift</button>
      </div>
      <div id="tk-shifts-list"></div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Each attendance day can be assigned one of these shifts —
        a rotating employee just gets a different shift on different days.</p>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Payroll Rules</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">Applies uniformly across every shift — grace period,
        rounding and OT/night-differential rules aren't set per shift.</p>
      <div class="field-row" style="margin-top:8px">
        <div><label>Grace period (minutes)</label><input data-p="grace_minutes" type="number" min="0" /></div>
        <div><label>Late deduction block</label>
          <select data-p="late_unit"><option value="minute">Per minute</option><option value="hour">Per hour</option></select></div>
      </div>
      <div class="field-row" style="margin-top:10px">
        <div><label>OT credit block</label>
          <select data-p="ot_unit"><option value="minute">Per minute</option><option value="30min">Per 30 minutes</option><option value="hour">Per hour</option></select></div>
        <div><label>OT rate (% of hourly)</label><input data-p="ot_rate_percent" type="number" min="0" /></div>
        <div><label>Monthly rate divisor</label><input data-p="monthly_rate_divisor" type="number" min="1" max="31" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">For employees paid a monthly rate, their effective
        daily rate used in payroll is monthly rate ÷ this number (e.g. 26 working days/month).</p>
      <div class="field-row" style="margin-top:10px">
        <div><label>Pay frequency</label>
          <select data-p="pay_frequency">
            <option value="monthly">Monthly</option>
            <option value="semi_monthly">Semi-monthly (twice a month)</option>
            <option value="weekly">Weekly</option>
            <option value="daily">Daily</option>
          </select></div>
        <div style="align-self:end"><label style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <input type="checkbox" data-p="auto_statutory" style="width:auto" /> Auto-compute SSS / PhilHealth / Pag-IBIG / withholding tax
        </label></div>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 0">When on, "Generate Payslips" fills the statutory deduction
        and withholding-tax lines from the current rate tables (the monthly contribution is split across the cutoffs
        per the pay frequency). Turn off to keep entering those by hand.</p>
      <div style="margin-top:10px"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-p="night_diff_enabled" style="width:auto" /> Enable night differential
      </label></div>
      <div class="field-row" style="margin-top:10px">
        <div><label>Night diff (%)</label><input data-p="night_diff_percent" type="number" min="0" /></div>
        <div><label>Night start</label><input data-p="night_start" type="time" /></div>
        <div><label>Night end</label><input data-p="night_end" type="time" /></div>
      </div>
      <button type="button" class="btn" id="tk-policy-save" style="margin-top:14px">${UI.icon('sheet', 14)} Save Rules</button>
      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
      <strong>Statutory Rate Tables</strong>
      <p class="muted" style="font-size:12px;margin-top:2px">The SSS / PhilHealth / Pag-IBIG / BIR-withholding
        figures the payslip computation uses. The 2026 schedule is built in; add a new dated version each January
        if the government changes the rates.</p>
      <button type="button" class="btn secondary small" id="tk-rate-tables" style="margin-top:8px">${UI.icon('sheet', 14)} Open rate tables</button>`,
    cancelText: 'Close',
    onOpen: (ov) => {
      const p = (k) => ov.querySelector(`[data-p="${k}"]`);
      ov.querySelector('#tk-rate-tables').onclick = () => rateTablesModal();
      if (policy) {
        p('grace_minutes').value = policy.grace_minutes;
        p('late_unit').value = policy.late_unit;
        p('ot_unit').value = policy.ot_unit;
        p('ot_rate_percent').value = policy.ot_rate_percent;
        p('monthly_rate_divisor').value = policy.monthly_rate_divisor;
        p('pay_frequency').value = policy.pay_frequency || 'semi_monthly';
        p('auto_statutory').checked = policy.auto_statutory !== false;
        p('night_diff_enabled').checked = policy.night_diff_enabled;
        p('night_diff_percent').value = policy.night_diff_percent;
        p('night_start').value = policy.night_start;
        p('night_end').value = policy.night_end;
      }

      function renderShifts() {
        const listEl = ov.querySelector('#tk-shifts-list');
        if (!shifts.length) {
          listEl.innerHTML = '<p class="muted" style="font-size:13px">No shifts defined yet.</p>';
          return;
        }
        listEl.innerHTML = `<table class="line-table"><thead><tr>
            <th>Name</th><th>Start</th><th>End</th><th>Default</th><th></th>
          </tr></thead><tbody>${shifts.map((s) => `
            <tr>
              <td>${UI.esc(s.name)}</td><td>${UI.esc(s.start_time)}</td><td>${UI.esc(s.end_time)}</td>
              <td>${s.is_default ? '✓' : ''}</td>
              <td class="actions">
                <button type="button" class="icon-btn" data-shift-edit="${s.id}" title="Edit">${UI.icon('edit')}</button>
                <button type="button" class="icon-btn danger" data-shift-del="${s.id}" title="Delete">${UI.icon('trash')}</button>
              </td>
            </tr>`).join('')}</tbody></table>`;
        listEl.querySelectorAll('[data-shift-edit]').forEach((b) => b.onclick = () => {
          const s = shifts.find((x) => String(x.id) === b.dataset.shiftEdit);
          shiftModal(s, refreshShifts);
        });
        listEl.querySelectorAll('[data-shift-del]').forEach((b) => b.onclick = async () => {
          if (!await UI.confirmDialog('Delete this shift? Any attendance days using it just become unassigned.', 'Delete')) return;
          await API.del('/hr/shifts/' + b.dataset.shiftDel);
          UI.toast('Shift deleted');
          refreshShifts();
        });
      }
      async function refreshShifts() {
        shifts = await API.get('/hr/shifts').catch(() => []);
        renderShifts();
      }
      renderShifts();

      ov.querySelector('#tk-shift-add').onclick = () => shiftModal(null, refreshShifts);
      ov.querySelector('#tk-policy-save').onclick = async () => {
        const body = {
          grace_minutes: Number(p('grace_minutes').value) || 0,
          late_unit: p('late_unit').value,
          ot_unit: p('ot_unit').value,
          ot_rate_percent: Number(p('ot_rate_percent').value) || 0,
          monthly_rate_divisor: Number(p('monthly_rate_divisor').value) || 26,
          pay_frequency: p('pay_frequency').value,
          auto_statutory: p('auto_statutory').checked,
          night_diff_enabled: p('night_diff_enabled').checked,
          night_diff_percent: Number(p('night_diff_percent').value) || 0,
          night_start: p('night_start').value,
          night_end: p('night_end').value,
        };
        await API.put('/hr/payroll-policy', body);
        UI.toast('Payroll rules saved');
      };
    },
  });
}

/* ── 13th-month pay worksheet ────────────────────────────────────────────── */
async function thirteenthMonthModal() {
  const thisYear = new Date().getFullYear();
  const m = UI.modal({
    title: '13th-Month Pay',
    size: 'lg',
    cancelText: 'Close',
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="tm-year">${[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="tm-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Mandatory 13th-month pay = total <b>basic salary</b>
        actually earned in the calendar year ÷ 12. Computed from the payslips generated for that year
        (dated by pay date). Deductions and allowances don't affect it.</p>
      <div id="tm-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#tm-year');
      let last = { rows: [], total: 0, year: '' };
      async function load() {
        ov.querySelector('#tm-body').innerHTML = '<div class="empty">Loading…</div>';
        last = await API.get('/hr/thirteenth-month?year=' + yearSel.value).catch(() => ({ rows: [], total: 0, year: yearSel.value }));
        const b = ov.querySelector('#tm-body');
        if (!last.rows.length) { b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return; }
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>Employee</th><th class="right">Payslips</th><th class="right">Total basic salary</th><th class="right">13th-month</th>
          </tr></thead><tbody>${last.rows.map((r) => `
            <tr><td>${UI.esc(r.employee_name)}</td>
              <td class="right">${r.payslip_count}</td>
              <td class="right">${UI.money ? UI.money(r.basic_total) : r.basic_total.toFixed(2)}</td>
              <td class="right"><strong>${UI.money ? UI.money(r.amount) : r.amount.toFixed(2)}</strong></td></tr>`).join('')}
          </tbody><tfoot><tr><th colspan="3" class="right">Total</th>
            <th class="right">${UI.money ? UI.money(last.total) : last.total.toFixed(2)}</th></tr></tfoot></table>`;
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#tm-csv').onclick = () => {
        if (!last.rows.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`13th-month-${last.year}.csv`,
          ['Employee', 'Payslips', 'Total basic salary', '13th-month pay'],
          last.rows.map((r) => [r.employee_name, r.payslip_count, r.basic_total, r.amount]));
      };
      load();
    },
  });
  return m;
}


/* ── Payroll worksheets menu ────────────────────────────────────────────── */
// BIR returns, Alphalist and the agency contribution schedules moved to
// Accounting → Tax & Compliance (they're the finance team's to file). What
// stays here is payroll processing: 13th-month and the final-pay worksheet.
function govFormsModal() {
  const items = [
    ['13th-month pay', 'Per-employee 13th-month computation', thirteenthMonthModal],
    ['Final pay worksheet', 'Back-pay for a separated employee (unpaid salary, pro-rated 13th, tax true-up)', finalPayModal],
  ];
  const m = UI.modal({
    title: 'Payroll worksheets',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `<div class="gov-menu">${items.map((it, i) => `
      <button type="button" class="gov-menu-item" data-i="${i}">
        <strong>${UI.esc(it[0])}</strong><span>${UI.esc(it[1])}</span>
      </button>`).join('')}</div>
      <style>.gov-menu{display:flex;flex-direction:column;gap:6px}
        .gov-menu-item{text-align:left;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer}
        .gov-menu-item:hover{border-color:var(--accent);background:var(--accent-weak)}
        .gov-menu-item strong{display:block;font-size:13px}
        .gov-menu-item span{display:block;font-size:11px;color:var(--text-muted);margin-top:2px}</style>`,
  });
  m.overlay.querySelectorAll('.gov-menu-item').forEach((b) => b.onclick = () => {
    if (m.close) m.close();
    items[Number(b.dataset.i)][2]();
  });
}


/* ── Final-pay / back-pay worksheet ──────────────────────────────────────── */
async function finalPayModal() {
  const peso = (n) => (UI.money ? UI.money(n) : Number(n || 0).toFixed(2));
  let employees = [];
  try { employees = await API.get('/hr/employees'); } catch { /* leave empty */ }
  const separated = employees.filter((e) => e.status === 'resigned' || e.status === 'terminated');
  const pool = separated.length ? separated : employees;

  UI.modal({
    title: 'Final-pay / back-pay worksheet',
    size: 'lg',
    cancelText: 'Close',
    confirmText: null,
    bodyHTML: `
      <div class="field-row">
        <div style="flex:1"><label>Employee</label>
          <select id="fp-emp"><option value="">— pick —</option>
            ${pool.map((e) => `<option value="${e.id}">${UI.esc(e.name)}${e.status && e.status !== 'regular' && e.status !== 'probationary' ? ' · ' + UI.esc(e.status) : ''}</option>`).join('')}</select></div>
        <div><label>Separation date</label><input id="fp-sep" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      </div>
      <div class="field-row">
        <div><label>Unpaid days worked</label><input id="fp-days" type="number" min="0" step="0.5" value="0" /></div>
        <div><label>Unused leave (days)</label><input id="fp-leave" type="number" min="0" step="0.5" value="0" /></div>
        <div><label>Other earnings</label><input id="fp-other" type="number" min="0" step="0.01" value="0" /></div>
      </div>
      <div class="field-row">
        <div><label>Outstanding advance / loan</label><input id="fp-adv" type="number" min="0" step="0.01" placeholder="from payslips" /></div>
        <div><label>Other deductions</label><input id="fp-ded" type="number" min="0" step="0.01" value="0" /></div>
        <div><label>13th-month already paid</label><input id="fp-13th" type="number" min="0" step="0.01" value="0" /></div>
      </div>
      <button type="button" class="btn" id="fp-run" style="margin-top:8px">Compute worksheet</button>
      <div id="fp-out" style="margin-top:14px"></div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#fp-out');
      ov.querySelector('#fp-run').onclick = async () => {
        const id = ov.querySelector('#fp-emp').value;
        if (!id) { UI.toast('Pick an employee', 'error'); return; }
        const q = new URLSearchParams({
          separation_date: ov.querySelector('#fp-sep').value,
          unpaid_days: ov.querySelector('#fp-days').value || 0,
          unused_leave_days: ov.querySelector('#fp-leave').value || 0,
          other_earnings: ov.querySelector('#fp-other').value || 0,
          other_deductions: ov.querySelector('#fp-ded').value || 0,
          thirteenth_month_paid: ov.querySelector('#fp-13th').value || 0,
        });
        const adv = ov.querySelector('#fp-adv').value;
        if (adv !== '') q.set('outstanding_advance', adv);
        out.innerHTML = '<div class="empty">Computing…</div>';
        let r;
        try { r = await API.get('/hr/final-pay/' + id + '?' + q.toString()); }
        catch (e) { out.innerHTML = `<div class="m-error">${UI.esc(e.message)}</div>`; return; }
        const w = r.worksheet;
        const e2 = w.earnings, d2 = w.deductions, t2 = w.tax_annualisation;
        out.innerHTML = `
          <h4 style="margin:0 0 6px">${UI.esc(r.employee.name)} — final pay as of ${UI.esc(w.separation_date)}</h4>
          <table class="line-table"><tbody>
            <tr><td>Unpaid salary</td><td class="right">${peso(e2.unpaid_salary)}</td></tr>
            <tr><td>Pro-rated 13th-month pay</td><td class="right">${peso(e2.prorated_13th_month)}</td></tr>
            <tr><td>Unused leave conversion</td><td class="right">${peso(e2.leave_conversion)}</td></tr>
            <tr><td>Other earnings</td><td class="right">${peso(e2.other_earnings)}</td></tr>
            <tr><th>Gross final pay</th><th class="right">${peso(e2.gross)}</th></tr>
            <tr><td colspan="2" style="padding-top:8px"><b>Year-end tax annualisation</b></td></tr>
            <tr><td>Taxable income (YTD)</td><td class="right">${peso(t2.taxable_income)}</td></tr>
            <tr><td>Annual tax due</td><td class="right">${peso(t2.annual_tax_due)}</td></tr>
            <tr><td>Tax already withheld</td><td class="right">${peso(t2.tax_already_withheld)}</td></tr>
            <tr><td>Adjustment ${t2.adjustment >= 0 ? '(collect)' : '(refund)'}</td><td class="right">${peso(Math.abs(t2.adjustment))}</td></tr>
            <tr><td colspan="2" style="padding-top:8px"><b>Less deductions</b></td></tr>
            <tr><td>Outstanding advance / loan</td><td class="right">${peso(d2.outstanding_advance)}</td></tr>
            <tr><td>Other deductions</td><td class="right">${peso(d2.other_deductions)}</td></tr>
            <tr><td>Tax still due</td><td class="right">${peso(d2.tax_still_due)}</td></tr>
            <tr><td>Add: tax refund</td><td class="right">${peso(w.additions.tax_refund)}</td></tr>
            <tr><th>Net final pay</th><th class="right">${peso(w.net_final_pay)}</th></tr>
          </tbody></table>
          ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:10px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}
          <p class="muted" style="font-size:11px;margin-top:10px">Worksheet only — review against the 201 file and company policy before releasing. Final pay is due within 30 days of separation (DOLE LA 06-20).</p>`;
      };
    },
  });
}



/* ── Statutory rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding) ──── */
const RATE_KIND_LABEL = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', rwt: 'BIR withholding tax' };

async function rateTablesModal() {
  async function load() {
    return API.get('/hr/payroll-tables').catch(() => ({ rows: [], effective: {}, as_of: '' }));
  }
  let state = await load();

  const m = UI.modal({
    title: 'Statutory rate tables',
    size: 'lg',
    cancelText: 'Close',
    bodyHTML: `
      <p class="muted" style="margin-top:0">These feed the payslip computation. Each table is stored with an
        <b>effective date</b> — payroll uses the newest one on or before the pay date. To apply a new government
        schedule, paste the updated figures and save with next year's <code>YYYY-01-01</code> date. Never edit a
        past year in place. Cross-check the first run against the agency's own calculator.</p>
      <div id="rt-body"></div>`,
    onOpen: (ov) => render(ov),
  });

  function render(ov) {
    const box = ov.querySelector('#rt-body');
    box.innerHTML = ['sss', 'philhealth', 'pagibig', 'rwt'].map((kind) => {
      const versions = state.rows.filter((r) => r.kind === kind);
      const eff = state.effective[kind];
      return `
        <div class="panel" style="padding:12px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <strong>${RATE_KIND_LABEL[kind]}</strong>
            <span class="muted" style="font-size:12px">in force as of ${UI.esc(state.as_of || 'today')}</span>
          </div>
          <div style="font-size:12px;margin:6px 0">
            ${versions.map((v) => `
              <span class="chip" style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border,#dce6f2);border-radius:12px;padding:1px 8px;margin:2px 4px 2px 0">
                ${UI.esc(v.effective_from)}${v.note ? ` · ${UI.esc(v.note)}` : ''}
                <button type="button" class="icon-btn" data-del-ver="${v.id}" title="Delete this version" style="padding:0">${UI.icon('trash', 12)}</button>
              </span>`).join('') || '<span class="muted">no stored versions — using the built-in 2026 seed</span>'}
          </div>
          <label style="font-size:12px">Effective figures (JSON)</label>
          <textarea data-json="${kind}" rows="7" style="width:100%;font-family:monospace;font-size:12px">${UI.esc(JSON.stringify(eff, null, 2))}</textarea>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input type="date" data-date="${kind}" value="${new Date().getFullYear() + 1}-01-01" style="width:150px" />
            <input type="text" data-note="${kind}" placeholder="Note (e.g. 'per SSS Circular 2027-001')" style="flex:1" />
            <button type="button" class="btn secondary small" data-save="${kind}">Save as new version</button>
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('[data-save]').forEach((b) => b.onclick = async () => {
      const kind = b.dataset.save;
      let data;
      try { data = JSON.parse(box.querySelector(`[data-json="${kind}"]`).value); }
      catch { UI.toast('That JSON is not valid', 'error'); return; }
      const effective_from = box.querySelector(`[data-date="${kind}"]`).value;
      const note = box.querySelector(`[data-note="${kind}"]`).value.trim();
      try {
        await API.post('/hr/payroll-tables', { kind, effective_from, data, note: note || undefined });
        UI.toast(`${RATE_KIND_LABEL[kind]} version saved`);
        state = await load();
        render(ov);
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    box.querySelectorAll('[data-del-ver]').forEach((b) => b.onclick = async () => {
      if (!await UI.confirmDialog('Delete this rate-table version?', 'Delete')) return;
      try {
        await API.del('/hr/payroll-tables/' + b.dataset.delVer);
        state = await load();
        render(ov);
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  return m;
}

/* ── Cutoff detail: roster + daily grid ──────────────────────────────────── */
async function renderPeriod(view, periodId) {
  let period = null;
  try { period = await API.get('/hr/periods/' + periodId); }
  catch { view.innerHTML = '<div class="empty">Cutoff not found.</div>'; return; }

  view.innerHTML = `
    <div class="topbar">
      <button class="btn secondary small" id="tk-back">${UI.icon('arrow-left', 14)} All Cutoffs</button>
      <h2 style="margin-left:10px">${UI.esc(period.label)}</h2>
      <span class="muted" style="margin-left:6px">${UI.esc(period.start_date)} &ndash; ${UI.esc(period.end_date)}</span>
      <div class="grow"></div>
      <button class="btn secondary" id="tk-edit-period">${UI.icon('edit')} Edit Cutoff</button>
      <button class="btn secondary" id="tk-import-punches" style="margin-left:8px" title="Fill time-in/out from time-clock punches">${UI.icon('calendar')} Import Punches</button>
      <button class="btn" id="tk-generate" style="margin-left:8px">${UI.icon('sheet')} Generate Payslips</button>
    </div>
    <div class="panel">
      <div class="topbar" style="padding:0 0 14px;background:none;border:none">
        <label class="muted" style="font-size:12.5px;margin-right:4px">Group by</label>
        <select id="tk-roster-group">
          <option value="none">None</option>
          <option value="department">Department</option>
          <option value="status">Status</option>
        </select>
        <label class="muted" style="font-size:12.5px;margin:0 4px 0 12px">Sort by</label>
        <select id="tk-roster-sort">
          <option value="name">Name</option>
          <option value="department">Department</option>
          <option value="status">Status</option>
          <option value="daily_rate">Daily Rate</option>
          <option value="days_logged">Days Logged</option>
        </select>
        <button type="button" class="icon-btn" id="tk-roster-sort-dir" title="Reverse sort order">${UI.icon('adjust', 15)}</button>
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
  view.querySelector('#tk-import-punches').onclick = async (e) => {
    if (!App.hasPermission('hr.manage')) { UI.toast('Needs HR manage', 'error'); return; }
    const ok = await UI.confirmDialog(
      'Fill each roster day’s time-in / time-out from the employee’s clock punches for that date. Days you’ve already set by hand are left untouched.',
      'Import'
    );
    if (!ok) return;
    e.target.disabled = true;
    try {
      const r = await API.post(`/hr/clock/import/${periodId}`);
      UI.toast(`Filled ${r.filled} day(s) across ${r.dates} date(s)`, 'success');
      period = await API.get('/hr/periods/' + periodId);
      renderRoster();
    } catch (ex) {
      UI.toast(ex.message || 'Import failed', 'error');
    } finally {
      e.target.disabled = false;
    }
  };
  view.querySelector('#tk-add-emp').onclick = () => addEmployeeModal();

  const rosterEl = view.querySelector('#tk-roster');
  const groupSel = view.querySelector('#tk-roster-group');
  const sortSel = view.querySelector('#tk-roster-sort');
  const sortDirBtn = view.querySelector('#tk-roster-sort-dir');
  const rosterView = { groupBy: 'none', sortBy: 'name', sortDir: 'asc' };

  const STATUS_LABELS = { probationary: 'Probationary', regular: 'Regular', resigned: 'Resigned', terminated: 'Terminated' };
  const SORTERS = {
    name: (r) => (r.name || '').toLowerCase(),
    department: (r) => (r.department_name || '').toLowerCase(),
    status: (r) => (r.status || ''),
    daily_rate: (r) => r.daily_rate || 0,
    days_logged: (r) => r.days_logged || 0,
  };

  function sortRoster(list) {
    const key = SORTERS[rosterView.sortBy] || SORTERS.name;
    const dir = rosterView.sortDir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const va = key(a), vb = key(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (a.name || '').localeCompare(b.name || '') * dir;
    });
  }

  function rosterTableHtml(list) {
    return `
      <table>
        <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th class="right">Daily Rate</th><th class="right">Days Logged</th><th></th></tr></thead>
        <tbody>${list.map((r) => `
          <tr class="clickable" data-open="${r.employee_id}">
            <td><strong>${UI.esc(r.name)}</strong></td>
            <td>${UI.esc(r.department_name || '—')}</td>
            <td>${UI.esc(STATUS_LABELS[r.status] || r.status || '—')}</td>
            <td class="right">${UI.money(r.daily_rate)}</td>
            <td class="right">${r.days_logged || 0} / ${r.days_total || 0}</td>
            <td class="actions"><button class="icon-btn danger" title="Remove from cutoff" data-rm="${r.employee_id}">${UI.icon('trash')}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

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

    if (rosterView.groupBy === 'none') {
      rosterEl.innerHTML = rosterTableHtml(sortRoster(roster));
    } else {
      const groupLabel = (r) => rosterView.groupBy === 'department'
        ? (r.department_name || 'No Department')
        : (STATUS_LABELS[r.status] || r.status || 'Unknown');
      const groups = new Map();
      roster.forEach((r) => {
        const key = groupLabel(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
      rosterEl.innerHTML = groupNames.map((name) => `
        <div class="muted" style="font-weight:600;margin:14px 0 6px;text-transform:uppercase;font-size:12px">
          ${UI.esc(name)} <span style="font-weight:400">(${groups.get(name).length})</span>
        </div>
        ${rosterTableHtml(sortRoster(groups.get(name)))}`).join('');
    }

    rosterEl.querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeEmployee(b.dataset.rm, roster); });
    rosterEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      const r = roster.find((x) => String(x.employee_id) === tr.dataset.open);
      if (r) dailyGridModal(r);
    });
  }

  groupSel.addEventListener('change', () => { rosterView.groupBy = groupSel.value; renderRoster(); });
  sortSel.addEventListener('change', () => { rosterView.sortBy = sortSel.value; renderRoster(); });
  sortDirBtn.addEventListener('click', () => {
    rosterView.sortDir = rosterView.sortDir === 'asc' ? 'desc' : 'asc';
    renderRoster();
  });

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
  async function addEmployeeModal() {
    const onRoster = new Set((period.roster || []).map((r) => r.employee_id));
    const depts = await API.get('/users/departments/list').catch(() => []);
    const deptOpts = '<option value="">All departments</option>' +
      depts.map((d) => `<option value="${d.id}">${UI.esc(d.name)}</option>`).join('');
    const statusOpts = '<option value="">All statuses</option>' +
      Object.keys(STATUS_LABELS).map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');
    const checked = new Set();

    const m = UI.modal({
      title: 'Add employees to cutoff',
      size: 'lg',
      bodyHTML: `<div class="search-box">${UI.icon('search', 16)}<input id="tk-pick-q" placeholder="Search employees…" autofocus /></div>
        <div class="field-row" style="margin-top:8px">
          <div><select id="tk-pick-dept">${deptOpts}</select></div>
          <div><select id="tk-pick-status">${statusOpts}</select></div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
          <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
            <input type="checkbox" id="tk-pick-all" style="width:auto" /> Select all shown
          </label>
          <div class="grow"></div>
          <button type="button" class="btn secondary small" id="tk-pick-add-selected" disabled>Add Selected (0)</button>
          <button type="button" class="btn small" id="tk-pick-add-all">Add All Matching</button>
        </div>
        <div id="tk-pick-results" style="margin-top:12px"><div class="empty">Loading…</div></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const q = ov.querySelector('#tk-pick-q');
        const deptSel = ov.querySelector('#tk-pick-dept');
        const statusSel = ov.querySelector('#tk-pick-status');
        const out = ov.querySelector('#tk-pick-results');
        const selectAll = ov.querySelector('#tk-pick-all');
        const addSelectedBtn = ov.querySelector('#tk-pick-add-selected');
        const addAllBtn = ov.querySelector('#tk-pick-add-all');
        let timer;
        let shownIds = [];

        function refreshSelectionUi() {
          addSelectedBtn.textContent = `Add Selected (${checked.size})`;
          addSelectedBtn.disabled = checked.size === 0;
          selectAll.checked = shownIds.length > 0 && shownIds.every((id) => checked.has(id));
        }

        async function search() {
          const params = new URLSearchParams();
          if (q.value.trim()) params.set('q', q.value.trim());
          if (deptSel.value) params.set('department_id', deptSel.value);
          if (statusSel.value) params.set('status', statusSel.value);
          const items = (await API.get('/hr/employees?' + params.toString()))
            .filter((it) => !onRoster.has(it.id));
          shownIds = items.map((it) => it.id);
          if (!items.length) {
            out.innerHTML = '<div class="empty">No matching employees</div>';
            addAllBtn.textContent = 'Add All Matching';
            addAllBtn.disabled = true;
            refreshSelectionUi();
            return;
          }
          addAllBtn.disabled = false;
          addAllBtn.textContent = `Add All Matching (${items.length})`;
          out.innerHTML = items.map((it) => `
            <label class="pick-row" data-id="${it.id}" style="display:flex;justify-content:flex-start;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" data-check="${it.id}" style="width:auto" ${checked.has(it.id) ? 'checked' : ''} />
              <div>
                <div><strong>${UI.esc(it.name)}</strong> <span class="muted">${UI.esc(it.department_name || '')}</span></div>
                <div class="muted">${UI.esc(it.position || '')} &middot; ${UI.esc(STATUS_LABELS[it.status] || it.status)}</div>
              </div>
            </label>`).join('');
          out.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', () => {
            const id = Number(cb.dataset.check);
            if (cb.checked) checked.add(id); else checked.delete(id);
            refreshSelectionUi();
          }));
          refreshSelectionUi();
        }

        async function addBulk(body) {
          const res = await API.post(`/hr/periods/${periodId}/employees/bulk`, body);
          const skipped = res.matched - res.added;
          UI.toast(
            `Added ${res.added} employee${res.added === 1 ? '' : 's'} to the cutoff` +
            (skipped > 0 ? ` (${skipped} already on it)` : '')
          );
          m.close();
          reload();
        }

        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        deptSel.addEventListener('change', search);
        statusSel.addEventListener('change', search);
        selectAll.addEventListener('change', () => {
          if (selectAll.checked) shownIds.forEach((id) => checked.add(id));
          else shownIds.forEach((id) => checked.delete(id));
          search();
        });
        addSelectedBtn.onclick = () => addBulk({ employee_ids: Array.from(checked) });
        addAllBtn.onclick = () => addBulk({
          q: q.value.trim() || undefined, department_id: deptSel.value || undefined, status: statusSel.value || undefined,
        });
        search();
      },
    });
  }

  /* ---- Daily time-in/out grid for one roster employee ----
     Each day can also be assigned a Shift (covers rotating shifts — a day just points at
     whichever shift applied) and optionally linked to an OT/Half Day/Leave/Undertime/Offset
     form record, both purely optional — Generate Payslips picks these up automatically, but
     nothing here is required to just log plain time-in/out like before. */
  async function dailyGridModal(rosterRow) {
    const employeeId = rosterRow.employee_id;
    const FORM_LINK_SLUGS = ['overtime_request', 'halfday_request', 'leave_request', 'undertime_request', 'offset_form'];
    const [days, shifts] = await Promise.all([
      API.get(`/hr/periods/${periodId}/attendance?employee_id=${employeeId}`),
      API.get('/hr/shifts').catch(() => []),
    ]);
    const defaultShift = shifts.find((s) => s.is_default) || null;
    days.forEach((d) => {
      if (d.shift_id == null) d.shift_id = rosterRow.default_shift_id || (defaultShift ? defaultShift.id : null);
    });

    const shiftOptions = (selectedId) => '<option value="">— No shift —</option>' +
      shifts.map((s) => `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${UI.esc(s.name)} (${UI.esc(s.start_time)}-${UI.esc(s.end_time)})</option>`).join('');

    UI.modal({
      title: `Daily time — ${rosterRow.name}`,
      size: 'xl',
      bodyHTML: `<div class="line-items"><table class="line-table"><thead><tr>
          <th>Date</th><th>Shift</th><th>Time In</th><th>Time Out</th><th>Notes</th><th>Linked Form</th>
        </tr></thead><tbody id="tk-days"></tbody></table></div>`,
      confirmText: 'Save',
      onOpen: (ov) => {
        const body = ov.querySelector('#tk-days');

        function renderRows() {
          body.innerHTML = days.map((d, i) => `
            <tr data-row="${i}">
              <td>${UI.esc(d.work_date)}</td>
              <td><select data-k="shift_id">${shiftOptions(d.shift_id)}</select></td>
              <td><input data-k="time_in" type="time" value="${UI.esc(d.time_in || '')}" /></td>
              <td><input data-k="time_out" type="time" value="${UI.esc(d.time_out || '')}" /></td>
              <td><input data-k="notes" value="${UI.esc(d.notes || '')}" placeholder="optional" /></td>
              <td>${d._linkLabel
                ? `<span class="badge-pill" data-unlink="${i}" title="Click to unlink" style="cursor:pointer">${UI.esc(d._linkLabel)} ✕</span>`
                : `<button type="button" class="icon-btn" data-link="${i}" title="Link an OT/Half Day/Leave/Undertime/Offset form (optional)">${UI.icon('edit', 14)}</button>`}
              </td>
            </tr>`).join('');
          body.querySelectorAll('input[data-k], select[data-k]').forEach((inp) => {
            const evt = inp.tagName === 'SELECT' ? 'change' : 'input';
            inp.addEventListener(evt, () => {
              const row = Number(inp.closest('[data-row]').dataset.row);
              days[row][inp.dataset.k] = inp.value;
            });
          });
          body.querySelectorAll('[data-link]').forEach((b) => b.onclick = () => linkFormModal(Number(b.dataset.link)));
          body.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = () => {
            const i = Number(b.dataset.unlink);
            days[i].form_record_id = null;
            days[i]._linkLabel = null;
            renderRows();
          });
        }

        async function linkFormModal(rowIndex) {
          const forms = await API.get('/form-definitions').catch(() => []);
          const relevant = forms.filter((f) => FORM_LINK_SLUGS.includes(f.slug));
          const lists = await Promise.all(relevant.map((f) => API.get(`/form-definitions/${f.id}/records`).catch(() => [])));
          const options = [];
          relevant.forEach((f, fi) => {
            (lists[fi] || []).forEach((r) => {
              const name = (r.data && r.data.employee_name) || '';
              if (String(name).trim() === String(rosterRow.name).trim()) options.push({ form: f, record: r });
            });
          });
          const m2 = UI.modal({
            title: `Link a form — ${rosterRow.name}`,
            headActionHTML: `<button type="button" class="btn secondary small" id="tk-link-goto">${UI.icon('forms', 14)} Data Forms</button>`,
            bodyHTML: options.length
              ? `<div class="var-pick-list">${options.map((o, i) => `
                  <button type="button" class="var-pick" data-pick="${i}">
                    <span>${UI.esc(o.form.name)} — ${UI.esc(o.record.number)}</span>
                    <span class="muted">${UI.esc(o.record.status)}</span>
                  </button>`).join('')}</div>`
              : `<p class="muted">No OT/Half Day/Leave/Undertime/Offset records found for ${UI.esc(rosterRow.name)} yet — create one in Data Forms first.</p>`,
            cancelText: 'Close',
            onOpen: (ov2) => {
              ov2.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
                const o = options[Number(b.dataset.pick)];
                days[rowIndex].form_record_id = o.record.id;
                days[rowIndex]._linkLabel = `${o.form.name} ${o.record.number}`;
                m2.close();
                renderRows();
              });
              ov2.querySelector('#tk-link-goto').onclick = () => App.navigate('form-records');
            },
          });
        }

        // Resolve a readable label for whatever's already linked (form_record_id came back from
        // GET as a bare id — fetch each once to show "Overtime Request OT-00003" etc.).
        Promise.all(days.map(async (d) => {
          if (d.form_record_id) {
            try {
              const r = await API.get('/form-records/' + d.form_record_id);
              d._linkLabel = `${r.form_name || 'Form'} ${r.number || ''}`.trim();
            } catch { d._linkLabel = 'Linked'; }
          }
        })).then(renderRows);
        renderRows();
      },
      onConfirm: async () => {
        await API.put(`/hr/periods/${periodId}/attendance`, {
          employee_id: employeeId,
          days: days.map((d) => ({
            work_date: d.work_date, time_in: d.time_in || '', time_out: d.time_out || '', notes: d.notes || '',
            shift_id: d.shift_id || null, form_record_id: d.form_record_id || null,
          })),
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
        <p class="muted" style="margin-top:0">Creates or updates one HR Payroll record per employee on this cutoff — days worked,
          late deductions, and OT/Holiday pay are computed automatically from the daily log and any linked forms (per the
          Policy Settings rules). Statutory deductions (SSS/PhilHealth/Pag-IBIG), cash advances, and net pay still need your review —
          re-running this after editing attendance safely refreshes the computed fields without touching those.</p>
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
