/* Company Assets — the company-wide register of property issued to employees (laptops, tools,
   uniforms, IDs…). One row per asset line across every Asset Issuance Form; issuing still
   happens on the employee's record (HR > Employees > employee > Assets issued). HR > Employees.
   Reading needs hr.view; Return needs hr.manage (the server enforces both). */
const HRAssets = (() => {
  /** Check in one asset line (returned / lost / damaged). Also used by hr-employees.js. */
  function returnModal(issuanceId, itemId, after) {
    UI.modal({
      title: 'Mark asset returned',
      bodyHTML: `
        <div class="field-row">
          <div><label>Return date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div><label>Status</label><select data-f="status">
            <option value="returned">Returned</option>
            <option value="lost">Lost</option>
            <option value="damaged">Damaged</option>
          </select></div>
        </div>
        <div style="margin-top:8px"><label>Condition</label><input data-f="cond" placeholder="Good, worn, scratched…" /></div>
        <div style="margin-top:8px"><label>Notes</label><textarea data-f="notes" rows="2"></textarea></div>`,
      confirmText: 'Save',
      onConfirm: async (ov, showErr) => {
        const returnDate = ov.querySelector('[data-f="date"]').value;
        if (!returnDate) { showErr('Return date is required'); return false; }
        try {
          await API.post(`/hr/assets/${issuanceId}/items/${itemId}/return`, {
            returned_date: returnDate,
            status: ov.querySelector('[data-f="status"]').value,
            condition_on_return: ov.querySelector('[data-f="cond"]').value.trim() || null,
            return_notes: ov.querySelector('[data-f="notes"]').value.trim() || null,
          });
          UI.toast('Asset updated');
          if (after) after();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }
  return { returnModal };
})();

App.register('hr-assets', async (view) => {
  const canManage = App.hasPermission('hr.manage');
  const STATUS_LABELS = { issued: 'Issued', returned: 'Returned', lost: 'Lost', damaged: 'Damaged' };
  const STATUS_CLASS = { issued: 'status-confirmed', returned: 'status-completed', lost: 'status-cancelled', damaged: 'status-cancelled' };
  const SEPARATED = new Set(['resigned', 'terminated']);
  const state = { status: 'issued', q: '', separated: false };

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Company Assets</h2>
        <div class="sub">Every item issued to employees — issue new items from the employee's record</div>
      </div>
      <div class="grow"></div>
      <button type="button" class="btn secondary" id="as-csv">${UI.icon('download', 15)} Export CSV</button>
    </div>
    <div id="as-cards"></div>
    <div class="panel">
      <div class="field-row hr-asset-filters" style="align-items:flex-end;margin-bottom:10px">
        <div><label>Status</label><select id="as-status">
          <option value="issued">Still out</option>
          <option value="lost">Lost</option>
          <option value="damaged">Damaged</option>
          <option value="returned">Returned</option>
          <option value="all">All</option>
        </select></div>
        <div><label>Search</label><input id="as-q" placeholder="Asset, tag / serial, category, employee, form no." /></div>
        <label style="display:flex;gap:6px;align-items:center;white-space:nowrap;padding-bottom:8px">
          <input type="checkbox" id="as-sep" /> Only people who have left
        </label>
      </div>
      <div id="as-body"><div class="empty">Loading…</div></div>
    </div>`;
  const cardsEl = view.querySelector('#as-cards');
  const body = view.querySelector('#as-body');

  function query() {
    const p = new URLSearchParams({ status: state.status });
    if (state.q) p.set('q', state.q);
    if (state.separated) p.set('separated', '1');
    return p.toString();
  }

  function cardsHTML(d) {
    const card = (key, cls, icon, value, label) => `
      <div class="stat-card ${cls}" data-card="${key}" role="button" tabindex="0" aria-label="${UI.esc(label)}: ${value}">
        <div class="stat-ic">${UI.icon(icon, 20)}</div>
        <div><div class="value">${value}</div><div class="label">${UI.esc(label)}</div></div>
      </div>`;
    return `<div class="cards">
      ${card('issued', '', 'archive', d.counts.issued, 'Still out')}
      ${card('separated', d.held_by_separated ? 'alert' : 'good', 'users', d.held_by_separated, 'Held by people who left')}
      ${card('lost', d.counts.lost ? 'warn' : '', 'alert', d.counts.lost, 'Lost')}
      ${card('damaged', d.counts.damaged ? 'warn' : '', 'alert', d.counts.damaged, 'Damaged')}
    </div>`;
  }

  async function load() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    let d;
    try { d = await API.get(`/hr/assets?${query()}`); }
    catch (e) { body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load', hint: e.message }); return; }
    cardsEl.innerHTML = cardsHTML(d);
    cardsEl.querySelectorAll('[data-card]').forEach((c) => {
      const pick = () => {
        const k = c.dataset.card;
        state.separated = k === 'separated';
        state.status = k === 'separated' ? 'issued' : k;
        view.querySelector('#as-status').value = state.status;
        view.querySelector('#as-sep').checked = state.separated;
        load();
      };
      c.onclick = pick;
      c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    });
    if (!d.rows.length) {
      body.innerHTML = UI.emptyState({
        icon: 'archive',
        title: state.q || state.separated || state.status !== 'issued' ? 'Nothing matches' : 'No assets are out',
        hint: 'Issue company property from an employee\'s record under Employees.',
      });
      return;
    }
    body.innerHTML = `<table>
      <thead><tr><th>Asset</th><th>Tag / Serial</th><th>Employee</th><th>Department</th><th>Form</th><th>Issued</th><th>Status</th><th></th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr>
        <td>${UI.esc(r.asset_name)}${r.quantity > 1 ? ' ×' + r.quantity : ''}${r.category ? `<div class="muted" style="font-size:12px">${UI.esc(r.category)}</div>` : ''}</td>
        <td>${UI.esc(r.asset_tag || '—')}</td>
        <td>${UI.esc(r.employee_name)}${r.employee_no ? ` <span class="muted">(${UI.esc(r.employee_no)})</span>` : ''}
          ${SEPARATED.has(r.employee_status) ? `<span class="badge-pill status-cancelled" style="margin-left:4px">${UI.esc(r.employee_status)}</span>` : ''}</td>
        <td>${UI.esc(r.department_name || '—')}</td>
        <td>${UI.esc(r.issuance_number)}</td>
        <td>${UI.esc(r.issued_date)}</td>
        <td><span class="badge-pill ${STATUS_CLASS[r.status] || 'muted'}">${STATUS_LABELS[r.status] || UI.esc(r.status)}</span>
          ${r.returned_date ? `<div class="muted" style="font-size:12px">${UI.esc(r.returned_date)}${r.condition_on_return ? ' · ' + UI.esc(r.condition_on_return) : ''}</div>` : ''}</td>
        <td class="right">${canManage && r.status === 'issued'
          ? `<button type="button" class="btn secondary small" data-return="${r.id}" data-issuance="${r.issuance_id}">Return</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table>`;
    body.querySelectorAll('[data-return]').forEach((b) => {
      b.onclick = () => HRAssets.returnModal(Number(b.dataset.issuance), Number(b.dataset.return), load);
    });
  }

  view.querySelector('#as-status').onchange = (e) => { state.status = e.target.value; load(); };
  view.querySelector('#as-sep').onchange = (e) => { state.separated = e.target.checked; load(); };
  let t;
  view.querySelector('#as-q').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
  };
  view.querySelector('#as-csv').onclick = () =>
    API.download(`/hr/assets?${query()}&format=csv`, `assets-${state.status}.csv`).catch((e) => UI.toast(e.message, 'error'));

  load();
});
