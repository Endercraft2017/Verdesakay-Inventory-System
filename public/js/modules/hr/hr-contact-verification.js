/* Contact Verification — HR's worklist of employees whose self-service contact / emergency
   details changed since HR last confirmed them (employee_profiles.verified_at is cleared on
   every contact edit — src/modules/hr/employee-profile.ts). HR > Employees. Reading needs
   hr.view; the Verify button needs hr.manage (the server enforces both). */
App.register('hr-contact-verification', async (view) => {
  const canVerify = App.hasPermission('hr.manage');
  const FIELD_LABELS = {
    preferred_name: 'Preferred name', mobile_phone: 'Mobile number', personal_email: 'Personal email',
    home_address: 'Home address', emergency_contact_name: 'Emergency contact',
    emergency_contact_relation: 'Emergency contact relationship', emergency_contact_phone: 'Emergency contact phone',
    name: 'Legal name', sss_no: 'SSS number', philhealth_no: 'PhilHealth number', pagibig_no: 'Pag-IBIG number',
    tin_no: 'TIN', verified: 'Verified by HR',
  };
  const SOURCE_LABELS = { self: 'Employee', hr_verify: 'HR verification', info_change: 'Approved request', hr_edit: 'HR edit' };

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Contact Verification</h2>
        <div class="sub">Contact and emergency details employees changed themselves, waiting for HR to confirm</div>
      </div>
      <div class="grow"></div>
      <button type="button" class="btn secondary" id="cv-refresh">${UI.icon('history', 15)} Refresh</button>
    </div>
    <div class="panel"><div id="cv-body"><div class="empty">Loading…</div></div></div>`;
  const body = view.querySelector('#cv-body');

  async function load() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    let rows;
    try { rows = await API.get('/hr/employee-profiles'); }
    catch (e) { body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load', hint: e.message }); return; }
    if (!rows.length) {
      body.innerHTML = UI.emptyState({ icon: 'users', title: 'Everything is verified', hint: 'New self-service contact changes will appear here.' });
      return;
    }
    body.innerHTML = `<table>
      <thead><tr><th>Employee</th><th>Employee No.</th><th>Last changed</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${UI.esc(r.name)}</td>
        <td>${UI.esc(r.employee_no || '—')}</td>
        <td>${UI.esc(r.updated_at ? UI.fmtDate(r.updated_at) : '—')}</td>
        <td class="right"><button type="button" class="btn secondary small" data-open="${r.employee_id}">Review</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openProfile(Number(b.dataset.open)); });
  }

  async function openProfile(employeeId) {
    let d;
    try { d = await API.get(`/hr/employee-profiles/${employeeId}`); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const p = d.profile;
    const row = (label, value) => `
      <div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border-strong)">
        <span class="muted" style="font-size:12.5px">${UI.esc(label)}</span>
        <span style="font-weight:600;text-align:right">${UI.esc(value || '—')}</span>
      </div>`;
    const history = d.history.length
      ? `<table><thead><tr><th>When</th><th>What</th><th>From → To</th><th>By</th></tr></thead><tbody>${d.history.map((h) => `<tr>
          <td>${UI.esc(UI.fmtDate(h.created_at))}</td>
          <td>${UI.esc(FIELD_LABELS[h.field] || h.field)}</td>
          <td>${h.field === 'verified' ? '' : `${UI.esc(h.old_value || '—')} → ${UI.esc(h.new_value || '—')}`}</td>
          <td>${UI.esc(h.changed_by_name || '—')} <span class="muted">(${UI.esc(SOURCE_LABELS[h.source] || h.source)})</span></td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="muted">No changes recorded.</p>';
    const m = UI.modal({
      title: `${d.employee.name} — contact details`,
      size: 'lg',
      cancelText: 'Close',
      headActionHTML: canVerify && p.needs_verification
        ? '<button type="button" class="btn small" id="cv-verify">Mark verified</button>' : '',
      bodyHTML: `
        <p class="muted" style="margin-top:0">${p.verified_at
          ? `Verified ${UI.esc(UI.fmtDate(p.verified_at))}${p.verified_by_name ? ' by ' + UI.esc(p.verified_by_name) : ''}.`
          : 'Not verified yet — confirm the details (e.g. call the number) before marking them verified.'}</p>
        ${row('Preferred name', p.preferred_name)}${row('Mobile number', p.mobile_phone)}${row('Personal email', p.personal_email)}
        ${row('Home address', p.home_address)}
        ${row('Emergency contact', [p.emergency_contact_name, p.emergency_contact_relation].filter(Boolean).join(' · '))}
        ${row('Emergency contact phone', p.emergency_contact_phone)}
        <h4 style="margin:20px 0 8px">Change history</h4>${history}`,
      onOpen: (ov) => {
        const btn = ov.querySelector('#cv-verify');
        if (btn) btn.onclick = async () => {
          btn.disabled = true;
          try {
            await API.post(`/hr/employee-profiles/${employeeId}/verify`, {});
            UI.toast('Contact details verified', 'success');
            m.close();
            load();
          } catch (e) { UI.toast(e.message, 'error'); btn.disabled = false; }
        };
      },
    });
  }

  view.querySelector('#cv-refresh').onclick = load;
  load();
});
