/* Inventory → Production: manufacturing job orders. Build N units of a finished
   product by consuming its BOM; track progress, pause/cancel with returns. */
App.register('job-orders', async (view) => {
  const canWrite = App.hasPermission('inventory.adjust');
  const STATUS = ['', 'draft', 'released', 'in_progress', 'paused', 'completed', 'cancelled'];
  const state = { status: '' };
  let rows = [];
  let products = [];
  let locations = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Job Orders <span class="muted" style="font-weight:400;font-size:14px">(Production)</span></h2>
      <div class="grow"></div>
      <select id="jo-status" style="width:150px">
        ${STATUS.map((s) => `<option value="${s}">${s ? s.replace('_', ' ') : 'All statuses'}</option>`).join('')}
      </select>
      ${canWrite ? `<button class="btn" id="jo-new">${UI.icon('plus')} New job order</button>` : ''}
    </div>
    <div class="panel"><div id="jo-table"></div></div>`;

  const tableEl = view.querySelector('#jo-table');
  const badge = (s) => `<span class="badge-pill status-${s === 'completed' ? 'completed' : s === 'cancelled' ? 'cancelled' : s === 'paused' ? 'confirmed' : 'open'}">${s.replace('_', ' ')}</span>`;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    [rows, products, locations] = await Promise.all([
      API.get('/job-orders?' + p.toString()),
      API.get('/finished-products'),
      API.get('/locations'),
    ]);
    render();
  }

  function render() {
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'adjust',
        title: state.status ? 'No job orders with that status' : 'No job orders yet',
        hint: 'Create a job order to build finished products from their BOM.',
        action: (!state.status && canWrite) ? `<button class="btn" id="jo-empty-new">${UI.icon('plus')} New job order</button>` : '',
      });
      const en = tableEl.querySelector('#jo-empty-new');
      if (en) en.onclick = () => newModal();
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Number</th><th>Product</th><th class="right">Ordered</th><th class="right">Done</th>
          <th class="right">Scrapped</th><th class="right">Left</th><th>Status</th>
        </tr></thead>
        <tbody>${rows.map((j) => `
          <tr class="clickable" data-open="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong>${j.order_number ? `<div class="muted" style="font-size:11px">${UI.esc(j.order_number)}</div>` : ''}</td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="right">${j.qty_ordered}</td>
            <td class="right">${j.qty_done}</td>
            <td class="right">${j.qty_scrapped}</td>
            <td class="right">${j.remaining}</td>
            <td>${badge(j.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => trackModal(tr.dataset.open));
  }

  function locOptions(sel) {
    return locations.map((l) => `<option value="${l.id}" ${String(l.id) === String(sel) ? 'selected' : ''}>${UI.esc(l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
  }

  function newModal() {
    if (!products.length) { UI.toast('Define a finished product with a BOM first', 'error'); return; }
    UI.modal({
      title: 'New job order',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Product to build <span class="req">*</span></label></div>
          <select data-f="product">${products.map((p) => `<option value="${p.id}">${UI.esc(p.name)} — BOM: ${p.component_count} parts, ${p.max_buildable} buildable</option>`).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Quantity to build <span class="req">*</span></label></div>
          <input data-f="qty" type="number" min="1" value="1" /></div>
        <div class="form-field"><div class="field-label"><label>Pull components from</label></div>
          <select data-f="source">${locOptions()}</select></div>
        <div class="form-field"><div class="field-label"><label>Put finished units in</label></div>
          <select data-f="output">${locOptions()}</select></div>
        <div class="form-field span2"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes"></textarea></div>
      </div>`,
      confirmText: 'Create draft',
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const qty = parseInt(g('qty'), 10);
        if (!g('product')) { showErr('Pick a product'); return false; }
        if (!qty || qty < 1) { showErr('Quantity must be at least 1'); return false; }
        await API.post('/job-orders', {
          product_item_id: Number(g('product')), qty_ordered: qty,
          source_location_id: Number(g('source')) || null,
          output_location_id: Number(g('output')) || null,
          notes: g('notes').trim() || null,
        });
        UI.toast('Job order created (draft)');
        load();
      },
    });
  }

  async function trackModal(id) {
    let jo = await API.get('/job-orders/' + id);

    const m = UI.modal({ title: `Job order ${jo.number}`, size: 'lg', cancelText: 'Close', bodyHTML: '<div id="jo-body"></div>' });
    const host = () => m.overlay ? m.overlay.querySelector('#jo-body') : document.querySelector('#jo-body');

    const act = async (path, body) => {
      try {
        const r = await API.post('/job-orders/' + id + path, body || {});
        jo = r.job_order || (await API.get('/job-orders/' + id));
        UI.toast('Done');
        draw();
        load();
      } catch (e) { UI.toast(e.message, 'error'); }
    };

    function draw() {
      const el = host();
      if (!el) return;
      const isDraft = jo.status === 'draft';
      const running = jo.status === 'released' || jo.status === 'in_progress';
      const comps = jo.components || [];
      el.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${badge(jo.status)}
          <strong>${UI.esc(jo.product_name)}</strong>
          ${jo.order_number ? `<span class="muted">from ${UI.esc(jo.order_number)}</span>` : ''}
        </div>
        <div class="kv" style="margin:10px 0">
          <div><span class="muted">Ordered</span><div>${jo.qty_ordered}</div></div>
          <div><span class="muted">Done</span><div>${jo.qty_done}</div></div>
          <div><span class="muted">Scrapped</span><div>${jo.qty_scrapped}</div></div>
          <div><span class="muted">Remaining</span><div>${jo.qty_ordered - jo.qty_done - jo.qty_scrapped}</div></div>
          <div><span class="muted">Pull from</span><div>${UI.esc(jo.source_location_name || '—')}</div></div>
          <div><span class="muted">Output to</span><div>${UI.esc(jo.output_location_name || '—')}</div></div>
        </div>
        ${jo.notes ? `<p class="muted" style="white-space:pre-wrap">${UI.esc(jo.notes)}</p>` : ''}

        <h4 style="margin:14px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Components</h4>
        <table>
          <thead><tr><th>Component</th><th class="right">Per unit</th><th class="right">Planned</th><th class="right">Consumed</th><th class="right">On hand</th></tr></thead>
          <tbody>${comps.map((c) => `<tr>
            <td>${UI.esc(c.component_name)}</td>
            <td class="right">${c.qty_per_unit}</td>
            <td class="right">${isDraft
              ? `<input data-plan="${c.component_item_id}" type="number" min="0" value="${c.qty_planned}" style="width:80px" />`
              : c.qty_planned}</td>
            <td class="right">${c.qty_consumed}</td>
            <td class="right">${c.component_on_hand ?? '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${isDraft && canWrite ? `<button type="button" class="btn secondary small" id="jo-save-plan" style="margin-top:8px">Save planned quantities</button>` : ''}

        ${running && canWrite ? `
          <h4 style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Record progress</h4>
          <div class="field-row">
            <div><label>Finished now</label><input id="jo-done" type="number" min="0" value="0" /></div>
            <div><label>Scrapped now</label><input id="jo-scrap" type="number" min="0" value="0" /></div>
            <div style="display:flex;align-items:flex-end"><button type="button" class="btn" id="jo-progress">Apply</button></div>
          </div>` : ''}

        ${canWrite ? `<div class="jo-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
          ${isDraft ? `<button type="button" class="btn" data-do="release">Release</button>
                       <button type="button" class="btn secondary danger" data-do="_delete">Delete</button>` : ''}
          ${running ? `<button type="button" class="btn secondary" data-do="pause">Pause</button>` : ''}
          ${jo.status === 'paused' ? `<button type="button" class="btn secondary" data-do="resume">Resume</button>` : ''}
          ${(running || jo.status === 'paused') ? `<button type="button" class="btn secondary" data-do="close">Close (finish early)</button>
                       <button type="button" class="btn secondary danger" data-do="cancel">Cancel</button>` : ''}
        </div>` : ''}`;

      const sp = el.querySelector('#jo-save-plan');
      if (sp) sp.onclick = async () => {
        const components = [...el.querySelectorAll('[data-plan]')].map((i) => ({
          component_item_id: Number(i.dataset.plan), qty_planned: parseInt(i.value, 10) || 0,
        }));
        try {
          const r = await API.put('/job-orders/' + id + '/components', { components });
          jo = r.job_order; UI.toast('Planned quantities saved'); draw();
        } catch (e) { UI.toast(e.message, 'error'); }
      };
      const pg = el.querySelector('#jo-progress');
      if (pg) pg.onclick = () => {
        const done_delta = parseInt(el.querySelector('#jo-done').value, 10) || 0;
        const scrapped_delta = parseInt(el.querySelector('#jo-scrap').value, 10) || 0;
        if (done_delta + scrapped_delta <= 0) { UI.toast('Enter a finished or scrapped quantity', 'error'); return; }
        act('/progress', { done_delta, scrapped_delta });
      };
      el.querySelectorAll('[data-do]').forEach((b) => b.onclick = () => {
        const d = b.dataset.do;
        if (d === '_delete') {
          UI.confirmDialog(`Delete draft ${jo.number}?`, 'Delete').then((ok) => {
            if (!ok) return;
            API.del('/job-orders/' + id).then(() => { UI.toast('Deleted'); m.close && m.close(); load(); }).catch((e) => UI.toast(e.message, 'error'));
          });
        } else if (d === 'cancel') {
          UI.confirmDialog(`Cancel ${jo.number}? Unconsumed components are returned to ${UI.esc(jo.source_location_name || 'the source location')}.`, 'Cancel job order')
            .then((ok) => ok && act('/cancel'));
        } else {
          act('/' + d);
        }
      });
    }

    draw();
  }

  view.querySelector('#jo-status').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  const nb = view.querySelector('#jo-new');
  if (nb) nb.onclick = () => newModal();

  await load();
});
