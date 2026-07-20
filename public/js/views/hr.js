/* HR: placeholder shell for the upcoming Human Resources module.
   Purely UI for now — no data wiring yet. Payroll records already live under
   Documents > Data Forms (the "HR Payroll" form) until this module is built out. */
App.register('hr', async (view) => {
  const MODULES = [
    { icon: 'sheet', title: 'Payroll', hint: 'Payslips, earnings & deductions per cutoff.' },
    { icon: 'users', title: 'Employees', hint: '201 files, employment status, contacts.' },
    { icon: 'calendar', title: 'Attendance', hint: 'Time-in/out, tardiness, overtime logs.' },
    { icon: 'note', title: 'Leave Management', hint: 'Leave credits, requests & approvals.' },
  ];

  view.innerHTML = `
    <div class="topbar">
      <h2>Human Resources</h2>
      <div class="grow"></div>
      <span class="badge-pill muted">Coming soon</span>
    </div>
    <div class="panel" style="padding:24px">
      <p class="muted" style="margin-top:0">
        This module is being planned. Payroll data can already be captured today via
        <strong>Documents &rarr; Data Forms &rarr; HR Payroll</strong>.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:14px;margin-top:18px">
        ${MODULES.map((m) => `
          <div style="border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:18px;background:var(--surface-2)">
            <div style="color:var(--text-faint);margin-bottom:10px">${UI.icon(m.icon, 26)}</div>
            <div style="font-weight:600;margin-bottom:4px">${UI.esc(m.title)}</div>
            <div class="muted" style="font-size:12.5px">${UI.esc(m.hint)}</div>
          </div>`).join('')}
      </div>
    </div>`;
});
