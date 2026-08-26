/* HR: module launcher. Employees and Time Keeping are real modules; Payroll jumps
   straight into the existing "HR Payroll" Data Form; Leave Management is still planned. */
App.register('hr', async (view) => {
  if (!App.hasPermission('hr.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  const MODULES = [
    { icon: 'sheet', title: 'Payroll', hint: 'Payslips, earnings & deductions per cutoff.', action: openPayroll },
    { icon: 'users', title: 'Employees', hint: 'Master list: department, position, daily rate.', action: () => App.navigate('hr-employees') },
    { icon: 'calendar', title: 'Time Keeping', hint: 'Per-cutoff roster with daily time-in/out.', action: () => App.navigate('hr-timekeeping') },
    { icon: 'note', title: 'Leave Management', hint: 'Leave credits, requests & approvals.', action: null },
  ];

  view.innerHTML = `
    <div class="topbar">
      <h2>Human Resources</h2>
    </div>
    <div class="panel" style="padding:24px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:14px">
        ${MODULES.map((m, i) => `
          <div class="${m.action ? 'clickable' : ''}" data-mod="${i}" style="border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:18px;background:var(--surface-2)">
            <div style="color:var(--text-faint);margin-bottom:10px">${UI.icon(m.icon, 26)}</div>
            <div style="font-weight:600;margin-bottom:4px">${UI.esc(m.title)}</div>
            <div class="muted" style="font-size:12.5px">${UI.esc(m.hint)}</div>
            ${!m.action ? '<span class="badge-pill muted" style="margin-top:8px;display:inline-block">Coming soon</span>' : ''}
          </div>`).join('')}
      </div>
    </div>`;

  async function openPayroll() {
    try {
      const forms = await API.get('/form-definitions');
      const hrPayroll = forms.find((f) => f.slug === 'hr_payroll');
      if (hrPayroll) App.navigate('form-records', { form_id: hrPayroll.id });
      else App.navigate('form-records');
    } catch {
      App.navigate('form-records');
    }
  }

  view.querySelectorAll('[data-mod]').forEach((card) => {
    const m = MODULES[Number(card.dataset.mod)];
    if (m.action) card.onclick = m.action;
  });
});
