/* Production → Products In: the Purchasing "Goods Receipt" pattern mirrored for finished
   goods. A unit that passes final QC (or, with no QC stages, a batch once production
   progress is recorded) sits "receivable" — produced, but not yet posted to stock — until
   this screen confirms/counts it into a chosen location. That location choice is also where
   a "warehouse transfer" away from the job order's default output location happens, if
   needed. See src/routes/job-orders.routes.ts GET /:id/receivable, POST /:id/products-in.
   filter.tab = 'queue' (default) | 'history' */
App.register('production-receiving', async (view, filter) => {
  const canReceive = App.hasPermission('inventory.adjust') || App.hasPermission('production.receive');
  const tab = filter && filter.tab === 'history' ? 'history' : 'queue';
  const LABEL = 'margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)';

  if (tab === 'history') { await renderHistory(); } else { await renderQueue(); }

  async function renderQueue() {
    view.innerHTML = `
      <div class="topbar">
        <h2>Products In <span class="muted" style="font-weight:400;font-size:14px">Ready to receive</span></h2>
      </div>
      <div class="panel"><div id="pi-table"><div class="empty">Loading…</div></div></div>`;
    const tableEl = view.querySelector('#pi-table');
    const rows = await API.get('/job-orders').catch(() => []);
    const need = (rows || []).filter((j) => ((j.units_passed || 0) > 0 || (j.batches_receivable || 0) > 0) && j.status !== 'cancelled');

    if (!need.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'inbox',
        title: 'Nothing waiting to be received',
        hint: 'Units queue here once they pass final QC — or, with no QC stages, once production progress is recorded.',
      });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Job order</th><th>Product</th><th>Team</th>
          <th class="right">Units ready</th><th class="right">Batches ready</th>
        </tr></thead>
        <tbody>${need.map((j) => `
          <tr class="${canReceive ? 'clickable' : ''}" data-open="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong></td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="muted">${UI.esc(j.team_name || '—')}</td>
            <td class="right">${j.units_passed || 0}</td>
            <td class="right">${j.batches_receivable || 0}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    if (canReceive) tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => openReceive(Number(tr.dataset.open)));
  }

  async function openReceive(joId) {
    let rec;
    try { rec = await API.get('/job-orders/' + joId + '/receivable'); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    if (!rec.units.length && !rec.batches.length) { UI.toast('Nothing left to receive on this job order', 'error'); return; }
    const locations = await API.get('/locations').catch(() => []);
    const def = locations.find((l) => String(l.id) === String(rec.output_location_id)) || locations.find((l) => l.is_default) || locations[0];

    const m = UI.modal({
      title: 'Record Products In',
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Received date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div style="flex:1"><label>Received into <span class="req">*</span></label>
            <select data-f="loc">${locations.map((l) => `<option value="${l.id}" ${def && l.id === def.id ? 'selected' : ''}>${UI.esc(l.name)}</option>`).join('')}</select></div>
        </div>
        <div><label>Note</label><input data-f="note" placeholder="Count discrepancy, condition…" /></div>
        ${rec.units.length ? `
          <h4 style="${LABEL}">Units</h4>
          <table><thead><tr>
            <th style="width:26px"><input type="checkbox" id="pi-all" checked /></th>
            <th>Identifier</th><th>Stage</th><th>Default location</th>
          </tr></thead><tbody>${rec.units.map((u) => `
            <tr><td><input type="checkbox" class="pi-u" value="${u.id}" checked /></td>
              <td class="mono">${UI.esc(u.identifier || '—')}</td>
              <td class="muted">${u.stage}</td>
              <td class="muted">${UI.esc(u.location_name || '—')}</td>
            </tr>`).join('')}</tbody></table>` : ''}
        ${rec.batches.length ? `
          <h4 style="${LABEL}">Batches</h4>
          <table><thead><tr><th>Batch</th><th class="right">Remaining</th><th style="width:120px">Receive</th></tr></thead>
            <tbody>${rec.batches.map((b) => `
              <tr data-batch="${b.id}" data-remaining="${b.remaining_qty}">
                <td class="mono">${UI.esc(b.number)}</td>
                <td class="right">${b.remaining_qty}</td>
                <td><input data-bq type="number" min="0" max="${b.remaining_qty}" step="1" value="${b.remaining_qty}" style="width:100px" /></td>
              </tr>`).join('')}</tbody></table>` : ''}`,
      confirmText: 'Post receipt',
      onConfirm: async (ov, showErr) => {
        const loc = ov.querySelector('[data-f="loc"]').value;
        if (!loc) { showErr('Pick a location'); return false; }
        const body = {
          location_id: Number(loc),
          received_date: ov.querySelector('[data-f="date"]').value || null,
          notes: ov.querySelector('[data-f="note"]').value.trim() || null,
        };
        const unitIds = Array.from(ov.querySelectorAll('.pi-u:checked')).map((c) => Number(c.value));
        const batchLines = Array.from(ov.querySelectorAll('tr[data-batch]'))
          .map((tr) => ({ batch_id: Number(tr.dataset.batch), quantity: parseFloat(tr.querySelector('[data-bq]').value) }))
          .filter((b) => b.quantity > 0);
        if (!unitIds.length && !batchLines.length) { showErr('Nothing selected to receive'); return false; }
        try {
          if (unitIds.length) {
            await API.post('/job-orders/' + joId + '/products-in', { ...body, unit_ids: unitIds });
          }
          for (const b of batchLines) {
            await API.post('/job-orders/' + joId + '/products-in', { ...body, batch_id: b.batch_id, quantity: b.quantity });
          }
          UI.toast('Received');
          renderQueue();
        } catch (e) { showErr(e.message); return false; }
      },
    });
    const all = m.overlay.querySelector('#pi-all');
    if (all) all.onchange = () => m.overlay.querySelectorAll('.pi-u').forEach((c) => c.checked = all.checked);
  }

  async function renderHistory() {
    view.innerHTML = `
      <div class="topbar">
        <h2>Products In <span class="muted" style="font-weight:400;font-size:14px">Receipt history</span></h2>
      </div>
      <div class="panel"><div id="pi-hist"></div></div>`;
    const tableEl = view.querySelector('#pi-hist');
    const rows = await API.get('/job-orders/production-receipts').catch(() => []);
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'sheet', title: 'No receipts yet', hint: 'Post a Products In receipt and it shows up here.' });
      return;
    }
    tableEl.innerHTML = `
      <table><thead><tr>
        <th>Receipt</th><th>Job order</th><th>Product</th><th>Received</th><th>Into</th><th class="right">Lines</th><th>By</th>
      </tr></thead><tbody>${rows.map((r) => `
        <tr class="clickable" data-r="${r.id}">
          <td><strong>${UI.esc(r.number)}</strong></td>
          <td>${UI.esc(r.job_order_number || '—')}</td>
          <td>${UI.esc(r.product_name || '—')}</td>
          <td>${UI.esc(r.received_date || UI.fmtDateShort(r.created_at))}</td>
          <td>${UI.esc(r.location_name || '—')}</td>
          <td class="right">${r.line_count}</td>
          <td>${UI.esc(r.received_by_name || '—')}</td>
        </tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('tr[data-r]').forEach((tr) => tr.onclick = () => receiptDrawer(Number(tr.dataset.r)));
  }

  async function receiptDrawer(id) {
    let r;
    try { r = await API.get('/job-orders/production-receipts/' + id); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    UI.modal({
      title: r.number + ' — ' + (r.job_order_number || ''),
      cancelText: 'Close',
      bodyHTML: `
        <div class="kv" style="margin-bottom:12px">
          <div><span class="muted">Product</span><div>${UI.esc(r.product_name || '—')}</div></div>
          <div><span class="muted">Into</span><div>${UI.esc(r.location_name || '—')}</div></div>
          <div><span class="muted">Received</span><div>${UI.esc(r.received_date || UI.fmtDateShort(r.created_at))}</div></div>
          <div><span class="muted">By</span><div>${UI.esc(r.received_by_name || '—')}</div></div>
        </div>
        ${r.notes ? `<p><span class="muted">Notes</span><br>${UI.esc(r.notes)}</p>` : ''}
        <table><thead><tr><th>Line</th><th class="right">Qty</th></tr></thead>
          <tbody>${(r.items || []).map((it) => `<tr>
            <td>${it.unit_id ? UI.esc(it.unit_identifier || ('Unit #' + it.unit_id)) : UI.esc(it.batch_number || ('Batch #' + it.batch_id))}</td>
            <td class="right">${it.quantity}</td>
          </tr>`).join('')}</tbody></table>`,
    });
  }
});
