/* Job & Sale Orders: list, create/edit (line items from inventory), print via template.
   One view serves both types; filter.type = 'sale' | 'job'. */
App.register('orders', async (view, filter) => {
  const type = filter && filter.type === 'job' ? 'job' : filter && filter.type === 'purchase' ? 'purchase' : 'sale';
  const noun = type === 'sale' ? 'Sale Order' : type === 'job' ? 'Job Order' : 'Purchase Request';
  const state = { q: '', backorder: false };
  const qbDoc = type === 'purchase' ? 'Bill' : 'Invoice';
  let qb = { connected: false };
  try { qb = await API.get('/quickbooks/status'); } catch { /* not configured */ }
  // Purchase orders are purchasing's (purchasing.manage), sale / job orders the orders module's —
  // the server checks the same per order (src/modules/inventory/order-access.ts).
  const canWrite = (action) => App.hasPermission(type === 'purchase' ? 'purchasing.manage' : 'orders.' + action);
  const canQbPush = qb.connected && canWrite('edit');

  let suppliers = [];
  if (type === 'purchase') { try { suppliers = await API.get('/suppliers'); } catch { /* optional */ } }
  let customers = [];
  let locations = [];
  let finishedProducts = [];
  if (type === 'sale') {
    try { customers = await API.get('/customers'); } catch { /* optional */ }
    try { locations = await API.get('/locations'); } catch { /* optional */ }
    try { finishedProducts = await API.get('/finished-products'); } catch { /* optional */ }
  }
  const fpIds = new Set(finishedProducts.map((p) => p.id));
  let taxCodes = [];
  if (type !== 'job') { try { taxCodes = await API.get('/accounting/tax-codes?active=1'); } catch { /* needs accounting.view */ } }
  const partyLabel = type === 'purchase' ? 'Vendor' : 'Customer';

  view.innerHTML = `
    <div class="topbar">
      <h2>${noun}s</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="ord-search" placeholder="Search number, customer…" /></div>
      ${type === 'sale' ? `<button class="btn secondary" id="ord-backorder" title="Show only approved/released orders with an unfulfilled line">${UI.icon('alert', 15)} Backorders</button>` : ''}
      ${App.hasPermission('users.manage') && qb.configured ? `<button class="btn secondary" id="ord-qb">${UI.icon('sheet')} QuickBooks${qb.connected ? ' ✓' : ''}</button>` : ''}
      ${canWrite('create') ? `<button class="btn" id="ord-new">${UI.icon('plus')} New ${noun}</button>` : ''}
    </div>
    <div class="panel"><div id="ord-table"></div></div>`;

  const backorderBtn = view.querySelector('#ord-backorder');
  if (backorderBtn) backorderBtn.onclick = () => {
    state.backorder = !state.backorder;
    backorderBtn.classList.toggle('active', state.backorder);
    load();
  };

  const qbBtn = view.querySelector('#ord-qb');
  if (qbBtn) qbBtn.onclick = () => quickbooksModal(() => App.navigate('orders', filter));

  const tableEl = view.querySelector('#ord-table');
  const money = UI.money;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const params = new URLSearchParams({ type });
    if (state.q) params.set('q', state.q);
    if (state.backorder) params.set('backorder', '1');
    const list = await API.get('/orders?' + params.toString());
    render(list);
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'forms',
        title: state.backorder ? 'No backorders' : state.q ? 'No matching orders' : `No ${noun.toLowerCase()}s yet`,
        hint: state.backorder ? 'Every approved order is fully covered by stock or released units.'
          : state.q ? 'Try a different search.' : `Create your first ${noun.toLowerCase()} to start.`,
        action: (state.q || state.backorder) ? '' : `<button class="btn" id="ord-empty-new">${UI.icon('plus')} New ${noun}</button>`,
      });
      const en = tableEl.querySelector('#ord-empty-new');
      if (en) en.onclick = () => orderModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Number</th><th>Customer</th><th>Date</th><th class="right">Total</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((o) => `
          <tr class="clickable" data-open="${o.id}">
            <td><strong>${UI.esc(o.number)}</strong>${type === 'job' && o.job_order_number ? `<div class="muted" style="font-size:11px">${UI.esc(o.job_order_number)} · ${UI.esc((o.job_order_status || '').replace('_', ' '))}</div>` : ''}</td>
            <td>${UI.esc(o.customer_name || '—')}</td>
            <td>${UI.esc(o.order_date || UI.fmtDateShort(o.created_at))}</td>
            <td class="right">${UI.esc(o.currency || '')} ${money(o.total)}</td>
            <td><span class="badge-pill status-${UI.esc(o.status)}">${UI.esc(o.status)}</span>${o.backordered ? ' <span class="badge-pill low" title="A line is not yet fully released from stock">⚠ backorder</span>' : ''}</td>
            <td class="actions">
              ${type === 'job' && App.hasPermission('inventory.adjust')
                ? (o.job_order_id
                  ? `<button class="icon-btn" title="View in Production — ${UI.esc(o.job_order_number)}" data-view-jo="${o.job_order_id}">${UI.icon('eye')}</button>`
                  : `<button class="icon-btn" title="Start production" data-produce="${o.id}">${UI.icon('adjust')}</button>`)
                : ''}
              ${type === 'purchase' ? `<button class="icon-btn" title="Receiving & bills" data-purch="${o.id}">${UI.icon('inbox')}</button>` : ''}
              ${type === 'sale' && ['approved', 'released'].includes(String(o.status).toLowerCase()) && App.hasPermission('orders.edit') && window.ReleaseAuth
                ? `<button class="icon-btn" title="Release authorization (who may collect)" data-relauth="${o.id}" data-num="${UI.esc(o.number)}">${UI.icon('key')}</button>` : ''}
              ${canQbPush ? `<button class="icon-btn" title="Push to QuickBooks as a ${qbDoc}" data-qbpush="${o.id}">${UI.icon('sheet')}</button>` : ''}
              <button class="icon-btn" title="Print" data-print="${o.id}">${UI.icon('printer')}</button>
              <button class="icon-btn" title="Edit" data-edit="${o.id}">${UI.icon('edit')}</button>
              ${canWrite('delete') ? `<button class="icon-btn danger" title="Delete" data-del="${o.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openOrder(b.dataset.edit));
    tableEl.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => printOrder(b.dataset.print));
    tableEl.querySelectorAll('[data-qbpush]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await API.post(`/quickbooks/push/order/${b.dataset.qbpush}`);
        UI.toast(`${r.updated ? 'Updated' : 'Created'} in QuickBooks (${r.qbo_type}${r.doc_number ? ' ' + r.doc_number : ''})`, 'success');
      } catch (e) { UI.toast(e.message, 'error'); }
      finally { b.disabled = false; }
    });
    tableEl.querySelectorAll('[data-produce]').forEach((b) => b.onclick = () => startProduction(b.dataset.produce));
    tableEl.querySelectorAll('[data-view-jo]').forEach((b) => b.onclick = () => App.navigate('job-orders', { id: b.dataset.viewJo }));
    tableEl.querySelectorAll('[data-purch]').forEach((b) => b.onclick = () => App.navigate('purchasing', { order: b.dataset.purch }));
    tableEl.querySelectorAll('[data-relauth]').forEach((b) => b.onclick = () => window.ReleaseAuth.open(b.dataset.relauth, b.dataset.num));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(b.dataset.del, list));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      openOrder(tr.dataset.open);
    });
  }

  async function openOrder(id) {
    const order = await API.get('/orders/' + id);
    orderModal(order);
  }

  /* ---------- Stock shortfall on approve/confirm: trim, produce, or backorder ---------- */
  function shortfallModal(opts) {
    const av = opts.availability || { lines: [] };
    const short = (av.lines || []).filter((l) => l.shortfall > 0);
    const finishUp = () => { try { sfm.close(); } catch (e) {} try { opts.closeParent && opts.closeParent(); } catch (e) {} load(); };

    async function ensureOrder() {
      if (opts.orderId) return opts.orderId;
      const r = await API.post('/orders', { type, ...opts.body, status: 'open' });
      opts.orderId = r.id;
      return r.id;
    }
    async function resave(extra) {
      const oid = await ensureOrder();
      await API.put('/orders/' + oid, Object.assign({}, opts.body, extra || {}));
    }

    const sfm = UI.modal({
      title: 'Not enough stock',
      size: 'lg',
      bodyHTML: `
        <p class="muted" style="margin-top:0">${short.length} line${short.length === 1 ? '' : 's'} can't be met from stock. Choose how to proceed.</p>
        <table>
          <thead><tr><th>Line</th><th class="right">Ordered</th><th class="right">Available</th><th class="right">Short</th><th>Make it?</th></tr></thead>
          <tbody>${short.map((l) => `<tr>
            <td>${UI.esc(l.name)}</td>
            <td class="right">${l.ordered}</td>
            <td class="right">${l.available}</td>
            <td class="right danger">${l.shortfall}</td>
            <td>${!l.is_finished_product ? '<span class="muted">not built here</span>'
              : !l.has_bom ? '<span class="muted">no BOM</span>'
              : l.buildable ? '<span class="badge-pill ok">components on hand</span>'
              : `<span class="badge-pill low">short: ${l.component_shortfalls.map((c) => `${UI.esc(c.name)} (need ${c.need}, have ${c.have})`).join('; ')}</span>`}${
              l.linked_job_orders.length ? `<div class="muted" style="font-size:11px">MO: ${l.linked_job_orders.map((j) => UI.esc(j.number) + ' (' + j.remaining + ' left)').join(', ')}</div>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div id="sf-result" class="muted" style="font-size:12px;margin-top:8px"></div>`,
      confirmText: null,
      cancelText: 'Back',
      onOpen: (ov) => {
        const result = ov.querySelector('#sf-result');
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px';
        actions.innerHTML = `
          <button type="button" class="btn secondary" id="sf-trim">Trim order to available</button>
          <button type="button" class="btn secondary" id="sf-produce">Create job orders for the shortfall</button>
          <button type="button" class="btn secondary" id="sf-purchase">Draft purchase orders for the shortfall</button>
          <button type="button" class="btn secondary danger" id="sf-force">Approve as a backorder</button>`;
        ov.querySelector('#sf-result').before(actions);

        ov.querySelector('#sf-trim').onclick = async () => {
          opts.cleaned.forEach((c) => {
            const s = short.find((x) => x.name === c.name && x.item_id === (c.item_id || null));
            if (s) c.quantity = Math.max(0, c.quantity - s.shortfall);
          });
          const trimmed = opts.cleaned.filter((c) => c.quantity > 0);
          if (!trimmed.length) { result.textContent = 'Every short line would drop to zero — adjust manually.'; return; }
          try {
            const oid = await ensureOrder();
            await API.put('/orders/' + oid, Object.assign({}, opts.body, { items: trimmed }));
            UI.toast('Order trimmed to available stock'); finishUp();
          } catch (e) { result.textContent = e.message; }
        };

        ov.querySelector('#sf-produce').onclick = async (ev) => {
          ev.target.disabled = true;
          try {
            const oid = await ensureOrder();
            const r = await API.post('/orders/' + oid + '/produce-shortfall', {});
            const made = (r.created || []).map((c) => `${c.number} — ${c.line} ×${c.qty}${c.buildable ? '' : ' ⚠ components short'}`);
            const skip = (r.skipped || []).map((s) => `${s.line}: ${s.reason}`);
            result.innerHTML = (made.length ? '<b>Created:</b> ' + made.map(UI.esc).join('<br>') : 'No job orders created.')
              + (skip.length ? '<br><b>Skipped:</b> ' + skip.map(UI.esc).join('<br>') : '')
              + '<br>The shortfall is now on the production line. Approve as a backorder to lock the order.';
          } catch (e) { result.textContent = e.message; ev.target.disabled = false; }
        };

        ov.querySelector('#sf-purchase').onclick = async (ev) => {
          ev.target.disabled = true;
          try {
            const oid = await ensureOrder();
            const r = await API.post('/orders/' + oid + '/purchase-shortfall', {});
            const made = (r.created || []).map((c) =>
              `${UI.esc(c.number)} → ${UI.esc(c.supplier_name || 'no supplier on the items')} (${c.lines} line${c.lines === 1 ? '' : 's'})`);
            result.innerHTML = made.length
              ? '<b>Draft POs:</b><br>' + made.join('<br>') + '<br>Review &amp; send them from Purchasing, then approve this order as a backorder.'
              : UI.esc(r.note || 'Nothing to buy — the shortfall is all built here, not purchased.');
          } catch (e) { result.textContent = e.message; ev.target.disabled = false; }
        };

        ov.querySelector('#sf-force').onclick = async (ev) => {
          if (!(await UI.confirmDialog('Approve this order even though stock is short? It becomes a backorder — stock may go negative when it ships.', 'Approve backorder'))) return;
          ev.target.disabled = true;
          try {
            await resave({ force: true });
            UI.toast('Approved (backorder)'); finishUp();
          } catch (e) { result.textContent = e.message; ev.target.disabled = false; }
        };
      },
    });
  }

  /* ---------- Allocate finished (built) units to this sale order ---------- */
  async function allocateUnitsModal(order) {
    const fpLines = (order.items || []).filter((li) => fpIds.has(li.item_id));
    if (!fpLines.length) { UI.toast('No finished-product lines on this order', 'error'); return; }
    // For each finished-product line, load its units once.
    const perLine = await Promise.all(fpLines.map(async (li) => {
      const units = await API.get(`/finished-products/${li.item_id}/units?status=all`).catch(() => []);
      const inStock = units.filter((u) => u.status === 'in_stock');
      const serial = inStock.filter((u) => u.identifier && u.identifier.trim());
      const bulk = inStock.length - serial.length;
      const allocated = units.filter((u) => u.status === 'sold' && String(u.order_id) === String(order.id)).length;
      return { li, serial, bulk, allocated, ordered: Number(li.quantity) || 0 };
    }));

    UI.modal({
      title: `Allocate finished units — ${order.number}`,
      size: 'lg',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Reserve built units for this order. Allocating removes them from finished-goods stock and stamps this order.</p>
        ${perLine.map((row, i) => `
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px" data-row="${i}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
              <strong>${UI.esc(row.li.name)}</strong>
              <span class="muted">ordered ${row.ordered} · allocated ${row.allocated} · in stock ${row.serial.length + row.bulk}</span>
            </div>
            ${row.serial.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
              ${row.serial.map((u) => `<label class="check"><input type="checkbox" class="al-u" data-line="${i}" value="${u.id}" /> <span class="mono">${UI.esc(u.identifier)}</span></label>`).join('')}
            </div>` : ''}
            ${row.bulk ? `<div class="field-row" style="margin-top:6px"><div><label>Bulk / untracked units</label>
              <input class="al-q" data-line="${i}" type="number" min="0" max="${row.bulk}" value="0" style="width:90px" /></div></div>` : ''}
            ${!row.serial.length && !row.bulk ? '<div class="muted" style="margin-top:4px">No units in stock — build some first.</div>' : ''}
          </div>`).join('')}`,
      confirmText: 'Allocate',
      onConfirm: async (ov, showErr) => {
        let done = 0;
        for (let i = 0; i < perLine.length; i++) {
          const itemId = perLine[i].li.item_id;
          const unit_ids = [...ov.querySelectorAll(`.al-u[data-line="${i}"]:checked`)].map((c) => Number(c.value));
          const qEl = ov.querySelector(`.al-q[data-line="${i}"]`);
          const qty = qEl ? (parseInt(qEl.value, 10) || 0) : 0;
          if (unit_ids.length) {
            await API.post(`/finished-products/${itemId}/units/allocate`, { action: 'sell', order_id: order.id, unit_ids });
            done += unit_ids.length;
          }
          if (qty > 0) {
            await API.post(`/finished-products/${itemId}/units/allocate`, { action: 'sell', order_id: order.id, quantity: qty });
            done += qty;
          }
        }
        if (!done) { showErr('Pick units or enter a quantity on at least one line'); return false; }
        UI.toast(`${done} unit${done === 1 ? '' : 's'} allocated to ${order.number}`);
      },
    });
  }

  /* ---------- Start a production run linked to this job order ---------- */
  async function startProduction(orderId) {
    const [order, products, locations] = await Promise.all([
      API.get('/orders/' + orderId),
      API.get('/finished-products'),
      API.get('/locations'),
    ]);
    if (!products.length) { UI.toast('Define a finished product with a BOM first (Production → Finished Products)', 'error'); return; }
    // Prefill from a line item that maps to a finished product, if any.
    const match = (order.items || []).find((li) => products.some((p) => p.id === li.item_id));
    const locOpts = locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.name)}</option>`).join('');
    UI.modal({
      title: `Start production — ${order.number}`,
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Product to build <span class="req">*</span></label></div>
          <select data-f="product">${products.map((p) => {
            const spec = p.attributes && typeof p.attributes === 'object' ? p.attributes.spec : null;
            const variant = [p.product_group, spec].filter(Boolean).join(' · ');
            return `<option value="${p.id}" ${match && match.item_id === p.id ? 'selected' : ''}>${UI.esc(p.name)}${variant ? ` (${UI.esc(variant)})` : ''} — ${p.max_buildable} buildable</option>`;
          }).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Quantity <span class="req">*</span></label></div>
          <input data-f="qty" type="number" min="1" value="${match ? Math.max(1, Math.round(match.quantity)) : 1}" /></div>
        <div class="form-field"><div class="field-label"><label>Pull components from</label></div><select data-f="source">${locOpts}</select></div>
        <div class="form-field"><div class="field-label"><label>Put finished units in</label></div><select data-f="output">${locOpts}</select></div>
      </div>`,
      confirmText: 'Create job order',
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const qty = parseInt(g('qty'), 10);
        if (!g('product')) { showErr('Pick a product'); return false; }
        if (!qty || qty < 1) { showErr('Quantity must be at least 1'); return false; }
        const r = await API.post('/job-orders', {
          product_item_id: Number(g('product')), qty_ordered: qty, order_id: Number(orderId),
          source_location_id: Number(g('source')) || null, output_location_id: Number(g('output')) || null,
        });
        UI.toast(`Job order ${r.number} created`);
        App.navigate('job-orders');
      },
    });
  }

  /* ---------- Create / edit ---------- */
  function orderModal(order) {
    const editing = !!order;
    const lines = editing ? (order.items || []).map((it) => ({ ...it })) : [];
    const get = (k, d) => (editing && order[k] != null ? order[k] : d);

    // Sale orders get the release lifecycle: open → approved (unlocks warehouse
    // release) → released (auto once fully picked) → confirmed/completed (stock out).
    const STATUS_VALUES = type === 'sale'
      ? ['open', 'approved', 'released', 'confirmed', 'completed', 'cancelled']
      : ['open', 'confirmed', 'completed', 'cancelled'];
    const curStatus = get('status', 'open');
    const statusOpts = (STATUS_VALUES.includes(curStatus) ? STATUS_VALUES : STATUS_VALUES.concat(curStatus))
      .map((s) => `<option value="${s}" ${curStatus === s ? 'selected' : ''}>${s}</option>`).join('');

    const m = UI.modal({
      title: editing ? `Edit ${order.number}` : `New ${noun}`,
      size: 'lg',
      bodyHTML: `
        ${type === 'sale' ? `<div class="field-row">
          <div><label>Customer (on file)</label><select data-f="customer_id"><option value="">— none / walk-in —</option>
            ${customers.map((c) => `<option value="${c.id}" ${String(get('customer_id', '')) === String(c.id) ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('')}</select></div>
          ${taxCodes.length ? `<div><label>Tax code</label><select data-f="tax_code_id"><option value="">— unclassified —</option>
            ${taxCodes.map((t) => `<option value="${t.id}" ${String(get('tax_code_id', '')) === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)} — ${UI.esc(t.name)}</option>`).join('')}</select></div>` : ''}
          ${locations.length ? `<div><label>Ship from</label><select data-f="location_id"><option value="">— default —</option>
            ${locations.map((l) => `<option value="${l.id}" ${String(get('location_id', '')) === String(l.id) ? 'selected' : ''}>${UI.esc(l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('')}</select></div>` : ''}
        </div>` : ''}
        <div class="field-row">
          <div><label>${partyLabel} name</label><input data-f="customer_name" value="${UI.esc(get('customer_name', ''))}" placeholder="${type === 'sale' ? 'auto-filled from the customer if left blank' : ''}" /></div>
          <div><label>${partyLabel} contact</label><input data-f="customer_contact" value="${UI.esc(get('customer_contact', ''))}" /></div>
        </div>
        ${type === 'purchase' ? `<div class="field-row">
          <div><label>Supplier (on file)</label><select data-f="supplier_id"><option value="">— none —</option>
            ${suppliers.map((s) => `<option value="${s.id}" ${String(get('supplier_id', '')) === String(s.id) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('')}</select></div>
          <div><label>Expected delivery</label><input data-f="expected_date" type="date" value="${UI.esc(get('expected_date', ''))}" /></div>
        </div>` : ''}
        <div class="field-row">
          <div><label>Order date</label><input data-f="order_date" type="date" value="${UI.esc(get('order_date', ''))}" /></div>
          <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
          <div><label>Currency</label><input data-f="currency" value="${UI.esc(get('currency', 'PHP'))}" /></div>
        </div>
        <label style="margin-top:14px">Line items</label>
        <div class="line-items"><table class="line-table"><thead><tr>
          <th>Item</th><th>SKU</th><th class="right">Qty</th><th>Unit</th><th class="right">Unit Price</th>${taxCodes.length ? '<th>Tax code</th>' : ''}<th class="right">Total</th><th></th>
        </tr></thead><tbody id="ord-lines"></tbody></table></div>
        <div class="line-actions">
          <button type="button" class="btn secondary small" id="ord-add-inv">${UI.icon('inventory', 15)} Add inventory item</button>
          <button type="button" class="btn secondary small" id="ord-add-blank">${UI.icon('plus', 15)} Add blank line</button>
          ${editing && type === 'sale' && (order.items || []).some((li) => fpIds.has(li.item_id))
            ? `<button type="button" class="btn secondary small" id="ord-allocate">${UI.icon('sparkles', 15)} Allocate finished units</button>` : ''}
        </div>
        <div class="order-totals">
          <div class="row"><span>Subtotal</span><strong id="ord-subtotal">0.00</strong></div>
          <div class="row"><span>Tax %</span><input data-f="tax_percent" type="number" step="0.01" value="${UI.esc(String(get('tax_percent', 0)))}" style="width:90px" /></div>
          <div class="row"><span>Tax amount</span><span id="ord-tax">0.00</span></div>
          <div class="row grand"><span>Total</span><strong id="ord-total">0.00</strong></div>
        </div>
        <label style="margin-top:6px">Notes</label>
        <textarea data-f="notes">${UI.esc(get('notes', ''))}</textarea>`,
      confirmText: editing ? 'Save order' : 'Create order',
      onOpen: (ov) => {
        const body = ov.querySelector('#ord-lines');
        const taxEl = ov.querySelector('[data-f="tax_percent"]');

        function recompute() {
          let subtotal = 0;
          lines.forEach((l, i) => {
            l.line_total = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
            subtotal += l.line_total;
            const cell = body.querySelector(`[data-total="${i}"]`);
            if (cell) cell.textContent = money(l.line_total);
          });
          const taxPct = Number(taxEl.value) || 0;
          const tax = subtotal * taxPct / 100;
          ov.querySelector('#ord-subtotal').textContent = money(subtotal);
          ov.querySelector('#ord-tax').textContent = money(tax);
          ov.querySelector('#ord-total').textContent = money(subtotal + tax);
        }

        const taxCell = (l) => {
          if (!taxCodes.length) return '';
          const opts = ['<option value="">— doc default —</option>'].concat(
            taxCodes.map((t) => `<option value="${t.id}" ${String(l.tax_code_id || '') === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)}</option>`)
          ).join('');
          return `<td><select data-k="tax_code_id" style="width:120px">${opts}</select></td>`;
        };

        function renderLines() {
          if (!lines.length) {
            body.innerHTML = `<tr><td colspan="${taxCodes.length ? 8 : 7}" class="muted" style="text-align:center;padding:14px">No line items yet — add one below.</td></tr>`;
            recompute();
            return;
          }
          body.innerHTML = lines.map((l, i) => `
            <tr data-row="${i}">
              <td><input data-k="name" value="${UI.esc(l.name || '')}" placeholder="Item name" />${
                type === 'sale' && (l.allocated_qty || l.reserved_qty || l.released_qty)
                  ? `<div class="muted" style="font-size:11px">${
                      Math.max(Number(l.allocated_qty || 0) + Number(l.reserved_qty || 0), Number(l.released_qty || 0))
                    } / ${Number(l.quantity) || 0} released${Number(l.allocated_qty || 0) ? ` (${l.allocated_qty} shipped)` : ''}</div>` : ''}</td>
              <td><input data-k="sku" value="${UI.esc(l.sku || '')}" style="width:90px" /></td>
              <td><input data-k="quantity" type="number" step="any" value="${UI.esc(String(l.quantity ?? 1))}" class="right" style="width:70px" /></td>
              <td><input data-k="unit" value="${UI.esc(l.unit || '')}" style="width:60px" /></td>
              <td><input data-k="unit_price" type="number" step="0.01" value="${UI.esc(String(l.unit_price ?? 0))}" class="right" style="width:90px" /></td>
              ${taxCell(l)}
              <td class="right" data-total="${i}">0.00</td>
              <td><button type="button" class="icon-btn danger" data-rm="${i}" title="Remove">${UI.icon('trash', 15)}</button></td>
            </tr>`).join('');
          body.querySelectorAll('[data-k]').forEach((inp) => {
            const ev = inp.tagName === 'SELECT' ? 'change' : 'input';
            inp.addEventListener(ev, () => {
              const row = Number(inp.closest('[data-row]').dataset.row);
              lines[row][inp.dataset.k] = inp.value;
              recompute();
            });
          });
          body.querySelectorAll('[data-rm]').forEach((b) =>
            b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); renderLines(); });
          recompute();
        }

        taxEl.addEventListener('input', recompute);
        ov.querySelector('#ord-add-blank').onclick = () => {
          lines.push({ name: '', sku: '', quantity: 1, unit: '', unit_price: 0 });
          renderLines();
        };
        ov.querySelector('#ord-add-inv').onclick = () => pickInventory((it) => {
          const sale = it.attributes && it.attributes.sale_price;
          lines.push({
            item_id: it.id, name: it.name, sku: it.sku || '', quantity: 1,
            unit: it.unit || '', unit_price: Number(sale) || 0,
          });
          renderLines();
        });
        const allocBtn = ov.querySelector('#ord-allocate');
        if (allocBtn) allocBtn.onclick = () => allocateUnitsModal(order);
        renderLines();
      },
      onConfirm: async (ov, showErr) => {
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const cleaned = lines
          .map((l) => ({
            item_id: l.item_id || null, name: (l.name || '').trim(), sku: l.sku || null,
            description: l.description || null, quantity: Number(l.quantity) || 0,
            unit: l.unit || null, unit_price: Number(l.unit_price) || 0,
            tax_code_id: l.tax_code_id ? Number(l.tax_code_id) : null,
          }))
          .filter((l) => l.name);
        if (!cleaned.length) { showErr('Add at least one line item (with a name)'); return false; }

        // Any line item typed by hand (not picked via "Add from Inventory") that doesn't
        // match a real item by name gets offered for creation — one at a time, in order,
        // before the order itself is saved. Matching by name is confirmed on the next line
        // item; a matched one gets silently linked (item_id) rather than prompted again.
        for (const line of cleaned) {
          if (line.item_id) continue;
          let existing = [];
          try { existing = await API.get('/inventory?q=' + encodeURIComponent(line.name)); } catch { /* search optional */ }
          const exact = existing.find((it) => it.name.trim().toLowerCase() === line.name.toLowerCase());
          if (exact) { line.item_id = exact.id; continue; }
          const wantsCreate = await UI.confirmDialog(
            `"${line.name}" isn't in inventory yet. Create it now, so this line links to real stock?`,
            'Create item'
          );
          if (!wantsCreate) continue; // keep it as a plain text line, no inventory link
          const created = await quickCreateItemModal(line.name);
          if (created) line.item_id = created.id;
        }

        const fOpt = (k) => { const el = ov.querySelector(`[data-f="${k}"]`); return el ? el.value : null; };
        const body = {
          customer_name: f('customer_name'), customer_contact: f('customer_contact'),
          order_date: f('order_date'), status: f('status'), currency: f('currency'),
          tax_percent: Number(f('tax_percent')) || 0, notes: f('notes'), items: cleaned,
        };
        if (type === 'purchase') {
          body.supplier_id = fOpt('supplier_id') || null;
          body.expected_date = fOpt('expected_date') || null;
        }
        if (type === 'sale') {
          body.customer_id = fOpt('customer_id') || null;
          if (locations.length) body.location_id = fOpt('location_id') || null;
        }
        if (taxCodes.length) body.tax_code_id = fOpt('tax_code_id') || null;

        try {
          if (editing) await API.put('/orders/' + order.id, body);
          else await API.post('/orders', { type, ...body });
        } catch (e) {
          if (e && e.status === 409 && e.data && e.data.availability) {
            shortfallModal({
              orderId: editing ? order.id : null, body, lines, cleaned,
              availability: e.data.availability, closeParent: () => m.close && m.close(),
            });
            return false;   // keep this modal open behind the shortfall prompt
          }
          throw e;
        }
        UI.toast(editing ? 'Order saved' : 'Order created');
        load();
      },
    });
    return m;
  }

  /* ---------- Quick "this line item isn't in inventory yet" create ---------- */
  // A lean standalone form (name/SKU/category/unit/starting qty — the same minimal set the
  // AI assistant's create_inventory_item tool accepts) rather than reusing inventory.js's
  // full itemModal(), which is closure-scoped to that view's own App.register callback and
  // not reachable from here. Resolves the created item (or null if the user closes without
  // saving) so orderModal()'s save flow can link it and move on to the next missing line.
  function quickCreateItemModal(name) {
    return new Promise((resolve) => {
      let groups = [];
      API.get('/inventory/product-groups').then((g) => {
        groups = g;
        const dl = document.getElementById('qi-groups-dl');
        if (dl) dl.innerHTML = groups.map((x) => `<option value="${UI.esc(x)}"></option>`).join('');
      }).catch(() => { /* suggestions optional */ });
      const m = UI.modal({
        title: 'New inventory item',
        bodyHTML: `
          <div class="field-row">
            <div style="flex:1"><label>Name <span class="req">*</span></label><input data-f="qi-name" value="${UI.esc(name)}" /></div>
            <div><label>SKU</label><input data-f="qi-sku" style="width:130px" /></div>
          </div>
          <div class="field-row">
            <div><label>Category</label><input data-f="qi-category" /></div>
            <div><label>Unit</label><input data-f="qi-unit" placeholder="pcs" style="width:100px" /></div>
            <div><label>Starting quantity</label><input data-f="qi-qty" type="number" min="0" value="0" style="width:130px" /></div>
          </div>
          <div class="field-row">
            <div style="flex:1"><label>Product group <span class="muted">(same model, different variant?)</span></label>
              <input data-f="qi-group" list="qi-groups-dl" placeholder="e.g. Office Chair" />
              <datalist id="qi-groups-dl"></datalist></div>
            <div style="flex:1"><label>Spec / variant</label><input data-f="qi-spec" placeholder="e.g. Red / Large" /></div>
          </div>
          <p class="muted" style="font-size:12px;margin:10px 0 0">Everything else (photo, supplier, location, min stock…)
            can be filled in later from Inventory.</p>`,
        confirmText: 'Create item',
        onConfirm: async (ov, showErr) => {
          const g = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
          const itemName = g('qi-name');
          if (!itemName) { showErr('Name is required'); return false; }
          const spec = g('qi-spec');
          const created = await API.post('/inventory', {
            name: itemName,
            sku: g('qi-sku') || undefined,
            category: g('qi-category') || undefined,
            unit: g('qi-unit') || undefined,
            quantity: Number(g('qi-qty')) || 0,
            product_group: g('qi-group') || undefined,
            attributes: spec ? { spec } : undefined,
          });
          resolve({ id: created.id, name: itemName });
        },
      });
      m.overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(null)));
    });
  }

  /* ---------- Inventory picker ---------- */
  function pickInventory(onPick) {
    const m = UI.modal({
      title: 'Add inventory item',
      bodyHTML: `<div class="search-box">${UI.icon('search', 16)}<input id="pick-q" placeholder="Search items…" autofocus /></div>
        <div id="pick-results" style="margin-top:12px"><div class="empty">Type to search…</div></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const q = ov.querySelector('#pick-q');
        const out = ov.querySelector('#pick-results');
        let timer;
        async function search() {
          const items = await API.get('/inventory?q=' + encodeURIComponent(q.value.trim()));
          if (!items.length) { out.innerHTML = '<div class="empty">No items found</div>'; return; }
          out.innerHTML = items.slice(0, 20).map((it) => {
            const spec = it.attributes && typeof it.attributes === 'object' ? it.attributes.spec : null;
            const variant = [it.product_group, spec].filter(Boolean).map(String).join(' · ');
            return `
            <div class="pick-row" data-id="${it.id}">
              <div><strong>${UI.esc(it.name)}</strong> <span class="muted mono">${UI.esc(it.sku || '')}</span>${variant ? ` <span class="muted">${UI.esc(variant)}</span>` : ''}</div>
              <div class="muted">${it.quantity} ${UI.esc(it.unit || '')}</div>
            </div>`;
          }).join('');
          out.querySelectorAll('[data-id]').forEach((row) =>
            row.onclick = () => { onPick(items.find((x) => x.id == row.dataset.id)); m.close(); });
        }
        q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        search();
      },
    });
  }

  /* ---------- Print ---------- */
  // Preview-modal + iframe, not window.open() — a new browser window/tab can be popup-blocked
  // outright by some browsers/extensions regardless of gesture timing; an iframe inside a
  // modal that's already part of the page never opens a new window.
  async function printOrder(id) {
    try {
      const order = await API.get('/orders/' + id);
      const [assigned, company] = await Promise.all([
        API.get('/templates/defaults/'+({sale:'sale_order',job:'job_order',purchase:'purchase_request'}[order.type])),
        API.get('/templates/company'),
      ]);
      // List returns metadata only; fetch the full row (body + Print Grid settings) for the
      // first matching template.
      const tplMeta = assigned;
      const [tpl, variables] = await Promise.all([
        Promise.resolve(assigned),
        // Global variables always apply; template-scoped ones only when a real template matched.
        API.get('/templates/variables' + (tplMeta ? `?template_id=${tplMeta.id}` : '')).catch(() => []),
      ]);
      const tplBody = tpl ? tpl.body : FALLBACK_TEMPLATE;
      const ctx = buildDocContext({ order, company, user: App.getMe(), variables });
      // Same opt-in Print Grid tiling as form-linked templates (public/js/print-tiling.js) —
      // e.g. printing 2 copies of one order side by side, or a Continuous run of several.
      const tiled = tpl && typeof buildTiledPagesHtml === 'function'
        ? buildTiledPagesHtml([order], () => renderTemplate(tplBody, ctx), {
          copiesPerRecord: tpl.copies_per_record, recordsPerPage: tpl.records_per_page, tileFill: tpl.tile_fill,
          continuous: !!tpl.tile_continuous, repeatCount: tpl.repeat_count, gapXmm:tpl.grid_gap_x_mm,gapYmm:tpl.grid_gap_y_mm,
          pageContentHeightMm: typeof pageContentHeightMm === 'function' ? pageContentHeightMm(tplBody) : undefined,
        })
        : '';
      const full = UI.printableHtml(tiled || renderTemplate(tplBody, ctx), order.number);

      UI.modal({
        title: order.number + ' — Preview',
        size: 'lg',
        bodyHTML: `<iframe id="ord-preview-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => {
          const ifr = ov.querySelector('#ord-preview-frame');
          UI.loadPrintFrame(ifr, full, tiled && typeof fitTiledCells === 'function' ? fitTiledCells : undefined);
        },
        onConfirm: async (ov) => {
          const ifr = ov.querySelector('#ord-preview-frame');
          await UI.printFrame(ifr);
          return false; // keep the preview open — printing shouldn't close it
        },
      });
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  async function del(id, list) {
    const o = list.find((x) => x.id == id);
    if (!await UI.confirmDialog(`Delete order ${o.number}? This cannot be undone.`, 'Delete')) return;
    await API.del('/orders/' + id);
    UI.toast('Order deleted');
    load();
  }

  const FALLBACK_TEMPLATE = `<div class="doc"><header class="doc-head"><div class="doc-company"><h1>{{company.name}}</h1></div>
    <div class="doc-meta"><h2>{{order.type}}</h2><div>No: {{order.no}}</div><div>{{order.date}}</div></div></header>
    <table class="doc-table"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}</td><td class="r">{{quantity}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-totals"><div class="grand">TOTAL: {{order.currency}} {{order.total}}</div></div></div>`;

  async function quickbooksModal(onChange) {
    let s;
    try { s = await API.get('/quickbooks/status'); } catch (e) { UI.toast(e.message, 'error'); return; }
    const m = UI.modal({
      title: 'QuickBooks Online',
      bodyHTML: `<div id="qb-body"></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        function render() {
          ov.querySelector('#qb-body').innerHTML = s.connected
            ? `<p>Connected to <strong>${UI.esc(s.company_name || 'your company')}</strong>${s.sandbox ? ' <span class="muted">(sandbox)</span>' : ''}.</p>
               <label class="check-opt" style="display:flex;align-items:center;gap:6px;margin:8px 0">
                 <input type="checkbox" id="qb-auto" ${s.auto_push ? 'checked' : ''}> Auto-push orders to QuickBooks when saved</label>
               <button type="button" class="btn secondary" id="qb-disc" style="margin-top:8px">Disconnect</button>
               <p class="muted" style="font-size:12px;margin-top:10px">Sale &amp; job orders post as Invoices, purchase requests as Bills. Re-pushing an order updates it. If a line won't post, set a default income/expense account in QuickBooks.</p>`
            : `<p>Link this workspace to a QuickBooks Online company to push orders as invoices and bills.</p>
               <button type="button" class="btn" id="qb-conn">${UI.icon('sheet', 15)} Connect QuickBooks</button>`;
          const conn = ov.querySelector('#qb-conn');
          if (conn) conn.onclick = async () => {
            try {
              const { url } = await API.get('/quickbooks/connect');
              const w = window.open(url, 'qbo', 'width=620,height=760');
              const onMsg = async (ev) => {
                if (typeof ev.data !== 'string' || !ev.data.startsWith('qbo:')) return;
                window.removeEventListener('message', onMsg);
                try { w && w.close(); } catch (e) {}
                s = await API.get('/quickbooks/status');
                render();
                if (s.connected) { UI.toast('Connected to QuickBooks', 'success'); if (onChange) onChange(); }
              };
              window.addEventListener('message', onMsg);
            } catch (e) { UI.toast(e.message, 'error'); }
          };
          const disc = ov.querySelector('#qb-disc');
          if (disc) disc.onclick = async () => {
            await API.post('/quickbooks/disconnect'); s = await API.get('/quickbooks/status'); render();
            UI.toast('Disconnected'); if (onChange) onChange();
          };
          const auto = ov.querySelector('#qb-auto');
          if (auto) auto.onchange = () => API.put('/quickbooks/auto-push', { enabled: auto.checked }).catch((e) => UI.toast(e.message, 'error'));
        }
        render();
      },
    });
    return m;
  }

  let searchTimer;
  view.querySelector('#ord-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.q = e.target.value.trim();
    searchTimer = setTimeout(load, 250);
  });
  const newBtn = view.querySelector('#ord-new'); // hidden without create permission for this type
  if (newBtn) newBtn.addEventListener('click', () => orderModal(null));

  await load();
  // filter.id deep-links straight into one order's edit modal (used by the AI assistant's
  // created-record links) — openOrder() only needs the id, it fetches the rest itself.
  if (filter && filter.id) openOrder(filter.id);
});
