/* Production → Repairs & Parts Requests: the warehouse queue for parts a
   rework unit needs. Accepting a request issues the replacement from storage and (for a
   'replace') books the removed part into its damage record. Nothing moves until accepted. */
App.register('repairs', async (view, filter) => {
  const canWrite = App.hasPermission('inventory.adjust') || App.hasPermission('production.repairs');
  const STATUS = ['requested', 'accepted', 'rejected', 'cancelled', ''];
  const state = { status: (filter && filter.status) || 'requested' };
  let rows = [];
  let locations = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Repairs &amp; Parts Requests</h2>
      <div class="grow"></div>
      <select id="rp-status" style="width:160px">
        ${STATUS.map((s) => `<option value="${s}" ${s === state.status ? 'selected' : ''}>${s ? s[0].toUpperCase() + s.slice(1) : 'All statuses'}</option>`).join('')}
      </select>
    </div>
    <div class="panel"><div id="rp-table"></div></div>`;

  const tableEl = view.querySelector('#rp-table');
  const badge = (s) => `<span class="badge-pill status-${s === 'accepted' ? 'completed' : (s === 'rejected' || s === 'cancelled') ? 'cancelled' : 'open'}">${s}</span>`;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    [rows, locations] = await Promise.all([
      API.get('/production/repairs?' + p.toString()),
      API.get('/locations').catch(() => []),
    ]);
    render();
  }

  function render() {
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'inbox',
        title: state.status ? `No ${state.status} requests` : 'No parts requests',
        hint: 'Requests appear here when a QA/QC inspector sends a unit to repair and asks for parts.',
      });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Ref</th><th>Job order</th><th>Unit</th><th>Kind</th><th>Component</th>
          <th class="right">Qty</th><th>Fault</th><th>Requested by</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td class="mono">${UI.esc(r.number)}</td>
            <td>${UI.esc(r.job_order_number || '—')}<div class="muted" style="font-size:11px">${UI.esc(r.product_name || '')}</div></td>
            <td>#${r.unit_id}${r.unit_identifier ? `<div class="muted mono" style="font-size:11px">${UI.esc(r.unit_identifier)}</div>` : ''}</td>
            <td>${r.kind === 'replace' ? 'Replace' : 'Add'}${r.kind === 'replace' ? `<div class="muted" style="font-size:11px">${r.return_to_damage ? 'old → damage' : 'old discarded'}</div>` : ''}</td>
            <td>${UI.esc(r.component_name)}</td>
            <td class="right">${r.quantity}</td>
            <td class="muted">${UI.esc(r.fault || '—')}</td>
            <td class="muted">${UI.esc(r.requested_by_name || '—')}</td>
            <td>${badge(r.status)}${r.warehouse_remarks ? `<div class="muted" style="font-size:11px">${UI.esc(r.warehouse_remarks)}</div>` : ''}</td>
            <td class="actions">${canWrite && r.status === 'requested'
              ? `<button class="btn small" data-accept="${r.id}">Accept</button>
                 <button class="btn secondary small danger" data-reject="${r.id}">Reject</button>`
              : (r.decided_by_name ? `<span class="muted" style="font-size:11px">by ${UI.esc(r.decided_by_name)}</span>` : '')}</td>
          </tr>${r.notes ? `<tr><td></td><td colspan="9" class="muted" style="font-size:12px;padding-top:0">Note: ${UI.esc(r.notes)}</td></tr>` : ''}`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-accept]').forEach((b) => b.onclick = () => acceptModal(rows.find((x) => String(x.id) === b.dataset.accept)));
    tableEl.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => rejectModal(rows.find((x) => String(x.id) === b.dataset.reject)));
  }

  function acceptModal(r) {
    if (!r) return;
    const locOpts = locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
    UI.modal({
      title: `Accept ${r.number}`,
      bodyHTML: `
        <p class="muted" style="margin-top:0">Issue <strong>${r.quantity} × ${UI.esc(r.component_name)}</strong> for unit #${r.unit_id}.${r.kind === 'replace' && r.return_to_damage ? ' The removed part is booked into its damage record.' : ''}</p>
        <div class="form-field"><div class="field-label"><label>Pull from</label></div>
          <select data-f="loc"><option value="">Job order's source location</option>${locOpts}</select></div>
        <div class="form-field"><div class="field-label"><label>Remarks</label></div>
          <input data-f="remarks" placeholder="e.g. handed 3 pcs to the line" /></div>`,
      confirmText: 'Accept & issue',
      onConfirm: async (ov) => {
        const loc = ov.querySelector('[data-f="loc"]').value;
        await API.post('/production/repairs/' + r.id + '/accept', {
          from_location_id: loc ? Number(loc) : null,
          warehouse_remarks: ov.querySelector('[data-f="remarks"]').value.trim() || null,
        });
        UI.toast('Part issued');
        load();
      },
    });
  }

  function rejectModal(r) {
    if (!r) return;
    UI.modal({
      title: `Reject ${r.number}`,
      bodyHTML: `<div class="form-field"><div class="field-label"><label>Reason <span class="req">*</span></label></div>
        <textarea data-f="remarks" placeholder="Why is this request rejected?"></textarea></div>`,
      confirmText: 'Reject',
      onConfirm: async (ov, showErr) => {
        const remarks = ov.querySelector('[data-f="remarks"]').value.trim();
        if (!remarks) { showErr('A reason is required'); return false; }
        await API.post('/production/repairs/' + r.id + '/reject', { warehouse_remarks: remarks });
        UI.toast('Request rejected');
        load();
      },
    });
  }

  view.querySelector('#rp-status').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  await load();
});
