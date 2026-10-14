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
    let rows;
    try { rows = await API.get('/job-orders'); }
    catch (e) {
      tableEl.innerHTML = `<div class="empty"><strong>Unable to load Products In</strong><p>${UI.esc(e.message || 'Please try again.')}</p><button class="btn" id="pi-retry">Retry</button></div>`;
      tableEl.querySelector('#pi-retry').onclick = renderQueue;
      return;
    }
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
    let locations;
    try { locations = await API.get('/locations'); }
    catch (e) { UI.toast(e.message || 'Unable to load storage locations', 'error'); return; }
    const storage = locations.filter((l) => l.type !== 'truck');
    const def = storage.find((l) => String(l.id) === String(rec.output_location_id)) || storage.find((l) => l.is_default) || storage[0];
    let attempt = null;

    const m = UI.modal({
      title: 'Record Products In',
      helpTopic: 'products-in',
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Received date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div style="flex:1"><label>Received into <span class="req">*</span></label>
            <select data-f="loc"><option value="">Choose storage location</option>${storage.map((l) => `<option value="${l.id}" ${def && l.id === def.id ? 'selected' : ''}>${UI.esc(l.path || l.name)}${l.capacity == null ? '' : ` · ${Math.max(0, l.capacity - l.total_units)} free`}</option>`).join('')}</select></div>
        </div>
        <p class="muted" style="margin:0 0 12px">One receipt will post every selected unit and batch quantity into this exact location. Storage capacity is checked again when you post.</p>
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
        const batchLines = [];
        for (const tr of ov.querySelectorAll('tr[data-batch]')) {
          const raw = tr.querySelector('[data-bq]').value.trim();
          if (raw === '') { showErr('Enter a quantity for each batch, or 0 to skip it'); return false; }
          const qty = Number(raw);
          if (!Number.isSafeInteger(qty) || qty < 0 || qty > Number(tr.dataset.remaining)) {
            showErr('Batch quantity must be a whole number from 0 to the remaining amount'); return false;
          }
          if (qty) batchLines.push({ batch_id: Number(tr.dataset.batch), quantity: qty });
        }
        if (!unitIds.length && !batchLines.length) { showErr('Nothing selected to receive'); return false; }
        const payload = { ...body, unit_ids: unitIds, batches: batchLines };
        const signature = JSON.stringify(payload);
        if (!attempt || attempt.signature !== signature) {
          attempt = { signature, key: 'products-in-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2)) };
        }
        try {
          const result = await API.post('/job-orders/' + joId + '/products-in', payload, { idempotencyKey: attempt.key });
          UI.toast(API.syncLocal(result) ? 'Saved on this PC; awaiting site confirmation' : 'Products In receipt ' + result.number + ' posted');
          await renderQueue();
        } catch (e) {
          if (!e.offline) attempt = null;
          showErr(e.offline ? 'Connection lost. Retry this unchanged receipt to confirm the result, or close and reopen to refresh the queue.' : e.message);
          return false;
        }
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
    let rows;
    try { rows = await API.get('/job-orders/production-receipts'); }
    catch (e) {
      tableEl.innerHTML = `<div class="empty"><strong>Unable to load receipt history</strong><p>${UI.esc(e.message || 'Please try again.')}</p><button class="btn" id="pi-history-retry">Retry</button></div>`;
      tableEl.querySelector('#pi-history-retry').onclick = renderHistory;
      return;
    }
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
