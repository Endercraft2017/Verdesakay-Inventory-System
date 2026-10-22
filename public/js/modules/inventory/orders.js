/* Job & Sale Orders: list, create/edit (line items from inventory), print via template.
   One view serves both types; filter.type = 'sale' | 'job'. */
App.register('orders', async (view, filter) => {
  const type = filter && filter.type === 'job' ? 'job' : filter && filter.type === 'purchase' ? 'purchase' : 'sale';
  const tracking = filter && filter.mode === 'track' && type !== 'purchase';
  const noun = type === 'sale' ? 'Sale Order' : type === 'job' ? 'Customer Job Order' : 'Supplier Purchase Order';
  const state = { q: String(filter?.search || ''), backorder: false };
  const qbDoc = type === 'purchase' ? 'Bill' : 'Invoice';
  let qb = { connected: false };
  try { qb = await API.get('/quickbooks/status'); } catch { /* not configured */ }
  // Purchase orders are purchasing's (purchasing.manage), sale / job orders the orders module's —
  // the server checks the same per order (src/modules/inventory/order-access.ts).
  const canWrite = (action) => App.hasPermission(type === 'purchase' ? 'purchasing.manage' : 'orders.' + action);
  const canCreate = !tracking && canWrite('create');
  const canEdit = !tracking && canWrite('edit');
  const canDelete = !tracking && canWrite('delete');
  const canQbPush = qb.connected && App.hasPermission(type === 'purchase' ? 'purchasing.approve_bills' : 'orders.approve');

  let suppliers = [];
  if (type === 'purchase') { try { suppliers = await API.get('/suppliers'); } catch { /* optional */ } }
  let customers = [];
  let locations = [];
  const lookupWarnings = [];
  if (type === 'sale') {
    try { customers = await API.get('/customers'); } catch { lookupWarnings.push('Customer records could not be loaded. You can enter walk-in details manually.'); }
    try { locations = await API.get('/locations'); } catch { lookupWarnings.push('Stock locations could not be loaded. The existing or default ship-from location will be kept.'); }
  }
  let taxCodes = [];
  if (type !== 'job') { try { taxCodes = await API.get('/accounting/tax-codes?active=1'); } catch { /* needs accounting.view */ } }
  const partyLabel = type === 'purchase' ? 'Vendor' : 'Customer';

  view.innerHTML = `
    <div class="topbar">
      <h2>${tracking ? noun + 's · Fulfillment tracking' : noun + 's'}</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="ord-search" aria-label="Search orders by number or ${partyLabel.toLowerCase()}" placeholder="Search number, ${partyLabel.toLowerCase()}…" value="${UI.esc(state.q)}" /></div>
      ${type === 'sale' ? `<button class="btn secondary" id="ord-backorder" title="Show firm orders with stock lines still awaiting picking">${UI.icon('alert', 15)} Awaiting release</button>` : ''}
      ${App.hasPermission('workspace.manage') && qb.configured ? `<button class="btn secondary" id="ord-qb">${UI.icon('sheet')} QuickBooks${qb.connected ? ' ✓' : ''}</button>` : ''}
      ${canCreate ? `<button class="btn" id="ord-new">${UI.icon('plus')} New ${noun}</button>` : ''}
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
  let loadRequest = 0;

  async function load() {
    const current = ++loadRequest;
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const params = new URLSearchParams({ type });
    if (state.q) params.set('q', state.q);
    if (state.backorder) params.set('backorder', '1');
    try {
      const list = await API.get('/orders?' + params.toString());
      if (current === loadRequest && params.get('q') === (state.q || null) && params.has('backorder') === state.backorder) render(list);
    } catch (e) {
      if (current !== loadRequest) return;
      tableEl.innerHTML = `<div class="empty" role="alert">${UI.esc(e.message)}<p><button class="btn secondary" id="ord-retry">Try again</button></p></div>`;
      tableEl.querySelector('#ord-retry').onclick = load;
    }
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'forms',
        title: state.backorder ? 'No orders awaiting release' : state.q ? 'No matching orders' : `No ${noun.toLowerCase()}s yet`,
        hint: state.backorder ? 'Every approved order has its stock lines picked or shipped.'
          : state.q ? 'Try a different search.' : canCreate ? `Create your first ${noun.toLowerCase()} to start.` : 'No orders have been recorded yet.',
        action: (state.q || state.backorder || !canCreate) ? '' : `<button class="btn" id="ord-empty-new">${UI.icon('plus')} New ${noun}</button>`,
      });
      const en = tableEl.querySelector('#ord-empty-new');
      if (en) en.onclick = () => orderModal(null);
      return;
    }
    tableEl.innerHTML = `
      <div class="orders-table-scroll"><table>
        <thead><tr><th>Number</th><th>${partyLabel}</th><th>Date</th>${tracking ? '' : '<th class="right">Total</th>'}<th>Status</th><th></th></tr></thead>
        <tbody>${list.map((o) => `
          <tr class="clickable" data-open="${o.id}">
            <td><strong>${UI.esc(o.number)}</strong>${type === 'job' && o.job_order_number ? `<div class="muted" style="font-size:11px">${UI.esc(o.job_order_number)} · ${UI.esc((o.job_order_status || '').replace('_', ' '))}</div>` : ''}${type === 'sale' && o.fulfillment_modes ? `<div class="muted" style="font-size:11px">${o.fulfillment_modes.split(',').map((m) => UI.esc(({ assembled: 'Fully built', semi_built: 'Semi-built', ckd: 'CKD', part: 'Parts' })[m] || m)).join(' · ')}</div>` : ''}</td>
            <td>${UI.esc(o.customer_name || '—')}</td>
            <td>${UI.esc(o.order_date || UI.fmtDateShort(o.created_at))}</td>
            ${tracking ? '' : `<td class="right">${UI.esc(o.currency || '')} ${money(o.total)}</td>`}
            <td><span class="badge-pill status-${UI.esc(o.status)}">${UI.esc(o.status)}</span>${o.release_slip_number ? ` <span class="badge-pill" title="Goods left on release slip ${UI.esc(o.release_slip_number)}">Shipped · ${UI.esc(o.release_slip_number)}</span>` : ''}${o.backordered ? ' <span class="badge-pill low" title="Stock lines still await picking">⚠ awaiting pick</span>' : ''}</td>
            <td class="actions">
              ${type === 'job' && !tracking && App.hasPermission('production.plan')
                ? (o.job_order_id
                  ? `<button class="icon-btn" title="View in Production — ${UI.esc(o.job_order_number)}" data-view-jo="${o.job_order_id}">${UI.icon('eye')}</button>`
                  : `<button class="icon-btn" title="Start production" data-produce="${o.id}">${UI.icon('adjust')}</button>`)
                : ''}
              ${type === 'purchase' ? `<button class="icon-btn" title="Receiving & bills" data-purch="${o.id}">${UI.icon('inbox')}</button>` : ''}
              ${type === 'sale' && !tracking && ['approved', 'released'].includes(String(o.status).toLowerCase()) && App.hasPermission('orders.authorize') && window.ReleaseAuth
                ? `<button class="icon-btn" title="Release authorization (who may collect)" data-relauth="${o.id}" data-num="${UI.esc(o.number)}">${UI.icon('key')}</button>` : ''}
              ${canQbPush && ['approved','confirmed','released','completed','fulfilled','invoiced','paid'].includes(String(o.status).toLowerCase()) ? `<button class="icon-btn" title="Push to QuickBooks as a ${qbDoc}" data-qbpush="${o.id}">${UI.icon('sheet')}</button>` : ''}
              <button class="icon-btn" title="Print" data-print="${o.id}">${UI.icon('printer')}</button>
              ${type === 'sale' ? `<button class="icon-btn" title="Review stock & approval" aria-label="Review stock and approval for ${UI.esc(o.number)}" data-stock="${o.id}">${UI.icon('inventory')}</button>` : ''}
              ${canEdit ? `<button class="icon-btn" title="Edit" data-edit="${o.id}">${UI.icon('edit')}</button>` : ''}
              ${canDelete && !(type === 'sale' && o.release_slip_number) ? `<button class="icon-btn danger" title="Delete" data-del="${o.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
    tableEl.querySelectorAll('[data-stock]').forEach((b) => b.onclick = () => reviewStock(b.dataset.stock));
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
    try {
      const order = await API.get('/orders/' + id);
      if (type === 'sale' && order.customer_id && !customers.some((c) => c.id === order.customer_id)) {
        customers.push(await API.get('/customers/' + order.customer_id));
      }
      orderModal(order);
    }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  /* ---------- Stock review: approval is a decision after an open order is saved ---------- */
  async function reviewStock(id) {
    let snapshot;
    let order;
    let busy = false;
    let request = 0;
    const review = UI.modal({ title: '2. Review stock & approval', size: 'lg', confirmText: null, cancelText: 'Close',
      bodyHTML: '<div id="stock-review" aria-live="polite">Loading stock and commitments…</div>',
      onOpen: (ov) => { ov.classList.add('order-review'); },
    });
    const ov = review.overlay;
    const panel = ov.querySelector('#stock-review');
    function controls(disabled) {
      panel.querySelectorAll('button').forEach((b) => b.disabled = disabled);
      ov.__setSaving?.(disabled);
    }
    function restoreReviewFocus() {
      if (ov !== document.getElementById('modal-root').lastElementChild) return;
      const active = document.activeElement;
      if (!ov.contains(active) || active === ov.querySelector('.modal') || panel.contains(active)) {
        panel.querySelector('[data-refresh]')?.focus();
      }
    }
    async function refresh(message) {
      const current = ++request;
      panel.innerHTML = '<p class="muted">Checking stock and commitments…</p>';
      try {
        const detail = await API.get('/orders/' + id);
        const av = await API.get('/orders/' + id + '/availability');
        if (current !== request || !ov.isConnected) return;
        order = detail; snapshot = av;
        render(message);
        restoreReviewFocus();
      } catch (e) {
        if (current !== request || !ov.isConnected) return;
        panel.innerHTML = `<p role="alert">${UI.esc(e.message)}</p><button type="button" class="btn secondary" data-refresh>Try again</button>`;
        panel.querySelector('[data-refresh]').onclick = () => refresh();
        restoreReviewFocus();
      }
    }
    function render(message) {
      const av = snapshot;
      const status = av.order_status || order.status;
      const open = status === 'open';
      const plannable = !order.fulfilled_at && ['open', 'approved', 'released'].includes(status);
      const make = !tracking && plannable && App.hasPermission('production.plan') && (!App.hasModule || App.hasModule('manufacturing'));
      const buy = !tracking && plannable && App.hasPermission('purchasing.manage') && (!App.hasModule || App.hasModule('purchasing'));
      const short = av.lines.filter((l) => l.shortfall > 0);
      const toBuy = (av.purchase_requirements || []).filter((r) => r.to_purchase > 0);
      panel.innerHTML = `
        <div class="order-review-summary"><div><strong>${UI.esc(order.number)}</strong> · ${UI.esc(status)}
          <p>Ship from <strong>${UI.esc(av.location_name || 'No stock location')}</strong>${av.uses_default_location ? ' (default)' : ''}</p></div>
          <span class="badge-pill ${av.ok ? 'ok' : 'low'}">${av.ok ? 'Stock covers this order' : av.short_lines + ' stock line(s) short'}</span></div>
        <p class="muted">${av.lines.some((l) => l.elsewhere_on_hand > 0) ? 'Stock at other locations needs a transfer. ' : ''}Available RTS stock can be picked now; draft production covers only the remaining shortage and becomes stock after QC and Products In. A separate job order can also build RTS buffer stock without a sales order. ${av.non_stock_lines || 0} non-stock line(s) have no stock requirement.</p>
        <div class="order-review-lines">${av.lines.map((l) => `<article class="order-stock-line">
          <div><strong>${UI.esc(l.name)}</strong> <span class="muted">${l.fulfillment_mode === 'semi_built' ? 'Semi-built' : l.fulfillment_mode === 'ckd_component' ? 'CKD part' : l.is_finished_product ? 'Fully built' : 'Part'}</span><span class="badge-pill ${l.shortfall > 0 ? 'low' : 'ok'}">${l.shortfall > 0 ? 'Short ' + l.shortfall : 'Covered'}</span></div>
          ${l.is_finished_product && l.shortfall > 0 && l.available > l.covered_here ? `<p class="muted">Split fulfillment: pick up to ${Math.max(0, l.available - l.covered_here)} available RTS unit(s); plan ${l.shortfall} remaining unit(s) for production.</p>` : ''}
          <dl><div><dt>Ordered</dt><dd>${l.ordered}</dd></div><div><dt>On hand here</dt><dd>${l.on_hand}</dd></div><div><dt>Other orders</dt><dd>${l.committed_orders ?? l.committed_elsewhere}</dd></div><div><dt>Kit / repair holds</dt><dd>${l.kit_held || 0} / ${l.repair_held || 0}</dd></div><div><dt>Picked / shipped here</dt><dd>${l.covered_here}</dd></div><div><dt>Available to order</dt><dd>${l.available}</dd></div></dl>
          ${l.elsewhere_on_hand > 0 ? `<p class="muted">${l.elsewhere_on_hand} on hand at other locations.</p>` : ''}
          ${l.shortfall > 0 && l.is_finished_product ? `<p>${!l.has_bom ? 'No BOM for a new CKD-parts build. Define the recipe first; an existing complete semi-built package may still be finished.' : l.buildable ? 'Outstanding CKD production materials are covered; approval and kit release are still required.' : 'CKD materials short: ' + (l.component_shortfalls || []).map((c) => `${UI.esc(c.name)} (need ${c.need}, free ${c.have})`).join('; ')}</p>` : ''}
          ${l.shortfall > 0 && l.fulfillment_mode === 'assembled' && l.semi_built_available > 0 ? `<p class="order-notice" role="status">${l.semi_built_available} complete semi-built package(s) available here. A production manager can choose to finish one of these for this fully built order${l.component_shortfalls?.length ? ' even though CKD parts are short' : ' instead of starting from CKD parts'}. Its loose parts are already included; no BOM components are issued again.</p>${!tracking && plannable && (App.hasPermission('production.approve') || App.hasPermission('production.manage')) ? `<button type="button" class="btn secondary small" data-convert="${l.item_id}">Finish a semi-built RTS unit</button>` : ''}` : ''}
          ${(l.linked_job_orders || []).reduce((n, j) => n + j.remaining, 0) > l.shortfall ? '<p class="order-notice">Planned production exceeds this shortage. Review existing job quantities before buying more materials.</p>' : ''}
          ${(l.linked_job_orders || []).length ? `<p class="muted">Production planned: ${l.linked_job_orders.map((j) => `${UI.esc(j.number)} · ${UI.esc(j.status)} · ${j.remaining} not yet received`).join('; ')}</p>` : ''}
        </article>`).join('') || '<p class="muted">This order has only non-stock lines.</p>'}</div>
        ${(av.linked_purchase_orders || []).length ? `<div class="order-notice">Linked purchase supply: ${av.linked_purchase_orders.map((p) => `${UI.esc(p.number)} · ${p.outstanding} outstanding`).join('; ')}. Receipt is still required.</div>` : ''}
        ${toBuy.length ? `<p>Still to purchase: ${toBuy.map((p) => `${UI.esc(p.name)} × ${p.to_purchase}`).join('; ')}</p>` : ''}
        <div id="stock-review-result" role="status">${UI.esc(message || '')}</div>
        <div class="order-review-actions">
          <button type="button" class="btn secondary" data-refresh>Refresh stock</button>
          ${open && canEdit ? '<button type="button" class="btn secondary" data-edit-order>Edit quantities or ship-from</button>' : ''}
          ${make && short.some((l) => l.is_finished_product && l.has_bom) ? '<button type="button" class="btn secondary" data-make>Draft CKD-parts production</button>' : ''}
          ${buy && toBuy.length ? '<button type="button" class="btn secondary" data-buy>Draft missing purchases</button>' : ''}
          ${open && App.hasPermission('orders.approve') && (av.location_id != null || !av.lines.length) ? `<button type="button" class="btn${av.ok ? '' : ' secondary danger'}" data-approve>${av.ok ? 'Approve for warehouse' : 'Review backorder approval'}</button>` : ''}
        </div>
        ${open ? '<p class="muted">Approval locks quantities and prices and sends the order to warehouse acceptance. It does not pick or ship goods.</p>' : '<p class="muted">This review does not change an existing approval, release or delivery.</p>'}`;
      panel.querySelector('[data-refresh]').onclick = () => refresh();
      panel.querySelector('[data-edit-order]')?.addEventListener('click', async () => {
        if (busy) return; busy = true; controls(true);
        try { const latest = await API.get('/orders/' + id); review.close(); orderModal(latest); }
        catch (e) { await refresh(e.message); }
        finally { busy = false; controls(false); }
      });
      panel.querySelector('[data-make]')?.addEventListener('click', () => action('produce-shortfall'));
      panel.querySelectorAll('[data-convert]').forEach((button) => button.addEventListener('click', () => convertSemi(av.lines.find((l) => String(l.item_id) === button.dataset.convert))));
      panel.querySelector('[data-buy]')?.addEventListener('click', () => action('purchase-shortfall'));
      panel.querySelector('[data-approve]')?.addEventListener('click', approve);
    }
    async function convertSemi(line) {
      if (busy || !line) return;
      let options;
      try { options = await API.get(`/job-orders/convert-semi/options?product_item_id=${line.item_id}&location_id=${snapshot.location_id}`); }
      catch (e) { await refresh(e.message); return; }
      const choices = (options.units || []).map((u) => `<option value="unit:${u.id}">${UI.esc(u.identifier || 'Tracked unit #' + u.id)}</option>`).join('')
        + (options.batches || []).map((b) => `<option value="batch:${b.id}">QR batch ${UI.esc(b.number)} · ${b.available} free</option>`).join('');
      const bulk = options.bulk_available >= 1;
      if (!choices && !bulk) { await refresh('No eligible semi-built package remains. Refresh stock before planning.'); return; }
      let saveAttempt;
      UI.modal({ title: `Finish semi-built ${line.name}`, size: 'md',
        bodyHTML: `<p class="order-notice">This is one complete physical unit. Its unassembled parts are already packed with it. Starting removes one semi-built RTS unit and sends the same package through production inspection; only Products In makes it fully built RTS.</p>
          <div class="form-grid"><div class="form-field span2"><label>Source package</label><select data-f="source-unit">${choices}${bulk ? '<option value="">Untracked semi-built unit</option>' : ''}</select></div>
          <div class="form-field span2"><label>Unit identifier</label><input data-f="identifier" maxlength="120" placeholder="Keep the current serial, or label the untracked package" /></div>
          <div class="form-field"><label>Additional finishing cost per unit</label><input data-f="finishing-cost" type="number" min="0" step="0.01" value="0" /></div>
          <div class="form-field span2"><label>Package photo</label><input data-f="image" type="file" accept="image/jpeg,image/png,image/gif,image/webp" /></div>
          <div class="form-field span2"><label><input data-f="complete-kit" type="checkbox" /> I checked that all loose parts are included with this same unit.</label></div>
          <div class="form-field span2"><label>Work note</label><input data-f="notes" maxlength="500" placeholder="Finishing instructions" /></div></div>`,
        confirmText: 'Start finishing this unit',
        onOpen: (modal) => {
          const pick = modal.querySelector('[data-f="source-unit"]');
          const identifier = modal.querySelector('[data-f="identifier"]');
          const fill = () => { const unit = (options.units || []).find((u) => `unit:${u.id}` === pick.value); identifier.value = unit?.identifier || ''; identifier.readOnly = !!unit?.identifier; };
          pick.onchange = fill; fill();
        },
        onConfirm: async (modal, showErr) => {
          const field = (key) => modal.querySelector(`[data-f="${key}"]`).value.trim();
          if (!field('identifier')) { showErr('Enter or retain this unit’s physical identifier.'); return false; }
          const finishingCost = Number(field('finishing-cost'));
          if (!Number.isFinite(finishingCost) || finishingCost < 0) { showErr('Finishing cost must be zero or more.'); return false; }
          const photo = modal.querySelector('[data-f="image"]').files[0];
          if (!photo) { showErr('Take or choose a photo of this semi-built package.'); return false; }
          if (!modal.querySelector('[data-f="complete-kit"]').checked) { showErr('Check that the complete kit is still with this physical unit.'); return false; }
          try {
            const payload = new FormData();
            Object.entries({ product_item_id: line.item_id, order_id: id, source_location_id: snapshot.location_id,
              output_location_id: snapshot.location_id,
              source_unit_id: field('source-unit').startsWith('unit:') ? field('source-unit').slice(5) : '',
              source_batch_id: field('source-unit').startsWith('batch:') ? field('source-unit').slice(6) : '',
              identifier: field('identifier'), finishing_cost: finishingCost, notes: field('notes') || '',
              confirmed_complete_kit: 'true' })
              .forEach(([key, value]) => payload.append(key, String(value)));
            payload.append('image', photo);
            const signature = JSON.stringify([...payload.entries()].map(([key, value]) =>
              value instanceof File ? [key, value.name, value.size, value.lastModified] : [key, value]));
            if (!saveAttempt || saveAttempt.signature !== signature) saveAttempt = {
              signature, key: 'semi-finish:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
            };
            const result = await API.upload('/job-orders/convert-semi', payload, { idempotencyKey: saveAttempt.key });
            review.close(); UI.toast(`${result.job_order.number} started. Inspect its linked unit, then record Products In.`);
            App.navigate('job-orders');
          } catch (e) { showErr(e.message); return false; }
        },
      });
    }
    async function action(path) {
      if (busy) return;
      busy = true; controls(true);
      try {
        const result = await API.post(`/orders/${id}/${path}`, { expected_revision: snapshot.revision || order.revision });
        const created = result.created || [];
        const local = API.syncLocal ? API.syncLocal(result) : result.__syncCommand;
        const summary = (local ? 'Saved on this PC; sync confirmation pending. ' : '') + (created.length ? 'Drafts created: ' + created.map((c) => c.number).join(', ') + '. Review their approval and release/receiving steps.' : result.note || 'No additional production needed; linked jobs already cover the demand.');
        await refresh(summary + ((result.skipped || []).length ? ' ' + result.skipped.map((s) => s.line + ': ' + s.reason).join('; ') : ''));
      } catch (e) { await refresh(e.message + (e.data?.code === 'stale_order' ? ' Review the refreshed order before retrying.' : '')); }
      finally { busy = false; controls(false); }
    }
    async function approve() {
      if (busy) return;
      busy = true; controls(true);
      try {
        const force = !snapshot.ok;
        if (force && !(await UI.confirmDialog('Approve with ' + snapshot.short_lines + ' stock line(s) short? The warehouse must still accept, pick and release goods. Draft supply does not remove the shortage.', 'Approve backorder'))) return;
        const result = await API.post(`/orders/${id}/status`, { status: 'approved', force, expected_revision: snapshot.revision || order.revision });
        const local = API.syncLocal ? API.syncLocal(result) : result.__syncCommand;
        UI.toast(local ? 'Approval saved on this PC; sync confirmation pending' : force ? 'Approved with a stock shortage' : 'Approved for warehouse acceptance');
        review.close(); load();
      } catch (e) { await refresh(e.message + ' Review the refreshed stock before deciding.'); }
      finally { busy = false; controls(false); }
    }
    await refresh();
  }

  async function startProduction(orderId) {
    const [order, products, locations] = await Promise.all([
      API.get('/orders/' + orderId),
      API.get('/finished-products'),
      API.get('/locations'),
    ]);
    if (!products.length) { UI.toast('Define a finished product with a BOM first (Production → Finished Products)', 'error'); return; }
    // Prefill from a line item that maps to a finished product, if any.
    const match = (order.items || []).find((li) => products.some((p) => p.id === li.item_id));
    const locOpts = locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('');
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
    const readOnly = editing && !canEdit;
    const shipped = editing && type === 'sale' && !!order.release_slip_number;
    const lockLines = readOnly || (editing && type === 'sale' && !['open', 'cancelled'].includes(String(order.status).toLowerCase()));
    const partsByParent = new Map();
    if (editing) (order.items || []).filter((it) => it.parent_order_item_id).forEach((it) => {
      const list = partsByParent.get(it.parent_order_item_id) || [];
      list.push(it); partsByParent.set(it.parent_order_item_id, list);
    });
    const lines = editing ? (order.items || []).filter((it) => !it.parent_order_item_id)
      .map((it) => ({ ...it, ckd_parts: partsByParent.get(it.id) || [] })) : [];
    const priceSuggestions = new Map();
    const get = (k, d) => (editing && order[k] != null ? order[k] : d);
    let initialized = false;
    let saveAttempt;
    const preservedOption = (value, choices, label) => value && !choices.some((c) => String(c.id) === String(value))
      ? `<option value="${UI.esc(value)}" selected>${UI.esc(label)} (#${UI.esc(value)})</option>` : '';

    // Sale orders get the release lifecycle: open → approved (unlocks warehouse
    // release) → released (auto once fully picked) → confirmed/completed (stock out).
    const STATUS_VALUES = type === 'sale' && !App.hasPermission('orders.approve') ? [get('status','open')] : type === 'sale'
      ? (editing ? (shipped ? (order.fulfillment&&order.fulfillment.remaining>0?['approved','released']:['confirmed', 'completed', 'fulfilled', 'invoiced', 'paid']) : ['open', 'cancelled'].includes(String(order.status).toLowerCase()) ? ['open', 'approved', 'cancelled'] : ['open', 'approved', 'confirmed', 'completed', 'cancelled']) : ['open'])
      : ['open', 'confirmed', 'completed', 'cancelled'];
    const curStatus = get('status', 'open');
    const statusOpts = (STATUS_VALUES.includes(curStatus) ? STATUS_VALUES : STATUS_VALUES.concat(curStatus))
      .map((s) => `<option value="${s}" ${curStatus === s ? 'selected' : ''}>${s}</option>`).join('');

    const m = UI.modal({
      title: editing ? `${readOnly ? 'View' : 'Edit'} ${order.number}` : `New ${noun}`,
      size: 'lg',
      bodyHTML: `
        <div class="order-editor-intro"><strong>${editing ? 'Order details' : '1. Capture the order'}</strong>
          <p>${readOnly ? 'You have view access to this order.' : !editing && type === 'sale' ? 'Save an open order first. Approval checks stock and hands the order to the warehouse.' : 'Review the customer, stock links, quantities, and totals before saving.'}</p></div>
        ${lookupWarnings.length ? `<p class="order-notice" role="status">${lookupWarnings.map(UI.esc).join(' ')}</p>` : ''}
        ${editing&&type==='sale'&&order.fulfillment ? `<p class="order-notice">Shipped ${order.fulfillment.dispatched} · Customer delivered ${order.fulfillment.delivered} · Held ${order.fulfillment.held} · Still owed ${order.fulfillment.remaining}</p>${!readOnly&&App.hasPermission('orders.approve')&&order.fulfillment.remaining>0?'<button type="button" class="btn secondary" id="order-cancel-remainder">Cancel customer remainder</button>':''}`:''}
        ${shipped ? `<p class="order-notice" role="status">Goods left on release slip ${UI.esc(order.release_slip_number)}. Reopening, cancelling or deleting this sale cannot restore physical stock. Record a return or correction separately.</p>` : ''}
        <section class="order-section"><h4>${partyLabel} &amp; order details</h4>
        ${type === 'sale' ? `<div class="field-row">
          <div><label>Customer (on file)</label><select data-f="customer_id"><option value="">— none / walk-in —</option>
            ${customers.map((c) => `<option value="${c.id}" ${String(get('customer_id', '')) === String(c.id) ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('')}</select></div>
          ${taxCodes.length ? `<div><label>Tax code</label><select data-f="tax_code_id"><option value="">— unclassified —</option>
            ${preservedOption(get('tax_code_id', null), taxCodes, 'Existing tax code')}
            ${taxCodes.map((t) => `<option value="${t.id}" ${String(get('tax_code_id', '')) === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)} — ${UI.esc(t.name)}</option>`).join('')}</select></div>` : ''}
          ${locations.length ? `<div><label>Ship from</label><select data-f="location_id"><option value="">— default —</option>
            ${locations.map((l) => `<option value="${l.id}" ${String(get('location_id', '')) === String(l.id) ? 'selected' : ''}>${UI.esc(l.path || l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('')}</select></div>` : ''}
        </div>` : ''}
        <div class="field-row">
          <div><label>${partyLabel} name</label><input data-f="customer_name" value="${UI.esc(get('customer_name', ''))}" placeholder="${type === 'sale' ? 'auto-filled from the customer if left blank' : ''}" /></div>
          <div><label>${partyLabel} contact</label><input data-f="customer_contact" value="${UI.esc(get('customer_contact', ''))}" /></div>
        </div>
        ${type === 'purchase' ? `<div class="field-row">
          <div><label>Supplier (on file)</label><select data-f="supplier_id"><option value="">— none —</option>
            ${preservedOption(get('supplier_id', null), suppliers, get('customer_name', 'Existing supplier'))}
            ${suppliers.map((s) => `<option value="${s.id}" ${String(get('supplier_id', '')) === String(s.id) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('')}</select></div>
          <div><label>Expected delivery</label><input data-f="expected_date" type="date" value="${UI.esc(get('expected_date', ''))}" /></div>
        </div>` : ''}
        <div class="field-row">
          <div><label>Order date</label><input data-f="order_date" type="date" value="${UI.esc(get('order_date', ''))}" /></div>
          <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
          <div><label>Currency</label><input data-f="currency" maxlength="3" placeholder="PHP" value="${UI.esc(get('currency', 'PHP'))}" /></div>
        </div>
        </section><section class="order-section"><h4>Items to supply</h4>
        ${lockLines ? `<p class="order-notice">${readOnly ? 'Line items are read-only.' : shipped ? 'Line items and tax are locked after shipment. Use a separate return or correction for goods already handed off.' : 'Line items and tax are locked after approval. Reopen the order before changing them; reopening clears warehouse reservations.'}</p>` : `<p class="muted">Choose inventory for goods to supply. ${type === 'sale' ? 'The catalog price starts the line. A configured BOM markup can suggest another price; choose Use suggestion to apply it, or enter any negotiated unit price. Tax and fees are separate.' : 'Use a non-stock line for services or charges.'} Non-stock lines do not reserve, produce or deduct stock.</p>`}
        <div class="line-items"><table class="line-table"><thead><tr>
          <th>Item</th><th>SKU</th><th class="right">Qty</th><th>Unit</th><th class="right">Unit Price</th>${taxCodes.length ? '<th>Tax code</th>' : ''}<th class="right">Total</th><th></th>
        </tr></thead><tbody id="ord-lines"></tbody></table></div>
        <div class="line-actions">
          ${!lockLines ? `<button type="button" class="btn secondary small" id="ord-add-inv">${UI.icon('inventory', 15)} Add inventory item</button>
          <button type="button" class="btn secondary small" id="ord-add-blank">${UI.icon('plus', 15)} Add non-stock line</button>` : ''}
          ${type === 'sale' && !lockLines ? `<label class="muted" for="ord-fee-kind">Fee type</label><select id="ord-fee-kind" style="width:auto"><option value="Shipping fee">Shipping fee</option><option value="Admin fee">Admin fee</option><option value="Other fee">Other fee</option></select><button type="button" class="btn secondary small" id="ord-add-fee">${UI.icon('plus', 15)} Add fee</button>` : ''}

        </div>
        <div id="ord-line-summary" class="muted" aria-live="polite"></div></section>
        <section class="order-section"><h4>Charges &amp; notes</h4>
        <div class="order-totals">
          <div class="row"><span>Subtotal (including fees)</span><strong id="ord-subtotal">0.00</strong></div>
          ${type === 'sale' ? '<div class="row"><span>Additional fees within subtotal</span><span id="ord-fees">0.00</span></div>' : ''}
          <div class="row"><label for="ord-tax-percent">Tax %</label><input id="ord-tax-percent" data-f="tax_percent" type="number" min="0" max="100" step="0.01" value="${UI.esc(String(get('tax_percent', 0)))}" style="width:90px" /></div>
          <div class="row"><span>Tax amount</span><span id="ord-tax">0.00</span></div>
          <div class="row grand"><span>Total</span><strong id="ord-total">0.00</strong></div>
        </div>
        <label style="margin-top:6px">Notes</label>
        <textarea data-f="notes" placeholder="Customer requirements, delivery instructions, or internal notes">${UI.esc(get('notes', ''))}</textarea></section>`,
      confirmText: readOnly ? null : editing ? 'Save order' : type === 'sale' ? 'Save open order' : 'Create order',
      cancelText: readOnly ? 'Close' : 'Cancel',
      onOpen: (ov) => {
        const cancelRest=ov.querySelector('#order-cancel-remainder');
        if(cancelRest)cancelRest.onclick=()=>{const cancelKey='cancel-rest-'+crypto.randomUUID();UI.modal({title:'Cancel unshipped remainder — '+order.number,
          bodyHTML:`<p>Only the unshipped remainder will be cancelled. Goods already on a release slip stay shipped.</p><label>Customer cancellation reason<textarea data-cancel-reason maxlength="1000"></textarea></label>`,confirmText:'Cancel remainder',onConfirm:async(box,showErr)=>{const reason=box.querySelector('[data-cancel-reason]').value.trim();if(reason.length<3){showErr('Record the customer’s cancellation reason.');return false;}try{await API.post('/orders/'+order.id+'/cancel-remainder',{reason,expected_revision:order.revision},{idempotencyKey:cancelKey});m.close();UI.toast('Remainder cancelled; unsent goods released from hold');App.render();return true;}catch(e){showErr(e.message);return false;}}});};

        const body = ov.querySelector('#ord-lines');
        const taxEl = ov.querySelector('[data-f="tax_percent"]');
        ov.classList.add('order-editor');
        // Associate visible labels with their controls, including keyboard/screen-reader use.
        ov.querySelectorAll('[data-f]').forEach((el) => {
          el.id = el.id || 'ord-' + el.dataset.f;
          const label = el.parentElement.querySelector('label');
          if (label) label.htmlFor = el.id;
        });
        const notes = ov.querySelector('[data-f="notes"]');
        notes.previousElementSibling.htmlFor = notes.id;
        if (readOnly) ov.querySelectorAll('[data-f]').forEach((el) => el.disabled = true);
        taxEl.disabled = lockLines;
        if (lockLines) {
          ov.querySelector('[data-f="currency"]').disabled = true;
          const taxCode = ov.querySelector('[data-f="tax_code_id"]');
          if (taxCode) taxCode.disabled = true;
        }
        const shipFrom = ov.querySelector('[data-f="location_id"]');
        if (shipFrom && editing && (order.released_at || order.fulfilled_at)) shipFrom.disabled = true;
        const customerEl = ov.querySelector('[data-f="customer_id"]');
        if (customerEl && !readOnly) customerEl.onchange = () => {
          const customer = customers.find((c) => String(c.id) === customerEl.value);
          ov.querySelector('[data-f="customer_name"]').value = customer ? customer.name : '';
          ov.querySelector('[data-f="customer_contact"]').value = customer ? customer.contact_person || customer.phone || '' : '';
        };

        function recompute() {
          let subtotal = 0;
          lines.forEach((l, i) => {
            l.line_total = Math.round(((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) + Number.EPSILON) * 100) / 100;
            subtotal += l.line_total;
            const cell = body.querySelector(`[data-total="${i}"]`);
            if (cell) cell.textContent = money(l.line_total);
          });
          const taxPct = Number(taxEl.value) || 0;
          subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;
          const tax = Math.round((subtotal * taxPct / 100 + Number.EPSILON) * 100) / 100;
          ov.querySelector('#ord-subtotal').textContent = money(subtotal);
          const fees = lines.filter((l) => !l.item_id && l.description === 'Order fee')
            .reduce((sum, l) => sum + (Number(l.line_total) || 0), 0);
          const feesEl = ov.querySelector('#ord-fees');
          if (feesEl) feesEl.textContent = money(fees);
          ov.querySelector('#ord-tax').textContent = money(tax);
          ov.querySelector('#ord-total').textContent = money(subtotal + tax);
          const stockLines = lines.filter((l) => l.item_id).length;
          ov.querySelector('#ord-line-summary').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · ${stockLines} linked to inventory · ${lines.length - stockLines} non-stock`;
        }

        const taxCell = (l) => {
          if (!taxCodes.length) return '';
          const opts = ['<option value="">— doc default —</option>'].concat(
            preservedOption(l.tax_code_id, taxCodes, 'Existing tax code'),
            taxCodes.map((t) => `<option value="${t.id}" ${String(l.tax_code_id || '') === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)}</option>`)
          ).join('');
          return `<td data-label="Tax code"><select data-k="tax_code_id" style="width:120px">${opts}</select></td>`;
        };

        function renderLines() {
          if (initialized) ov.__markDirty?.();
          if (!lines.length) {
            body.innerHTML = `<tr><td colspan="${taxCodes.length ? 8 : 7}" class="muted" style="text-align:center;padding:14px">No line items yet — add one below.</td></tr>`;
            recompute();
            return;
          }
          body.innerHTML = lines.map((l, i) => `
            <tr data-row="${i}">
              <td data-label="Item"><input data-k="name" value="${UI.esc(l.name || '')}" placeholder="Item name" maxlength="200" /><div class="order-link-hint">${l.item_id ? `${UI.icon('inventory', 12)} Linked inventory item · #${l.item_id}` : 'Non-stock · service or charge'}</div>${!lockLines ? `<button type="button" class="order-link-btn" data-link="${i}">${l.item_id ? 'Change inventory item' : 'Link inventory item'}</button>${l.item_id ? ` <button type="button" class="order-link-btn" data-unlink="${i}">Make non-stock</button>` : ''}` : ''}
                ${type === 'sale' && l.item_id ? `<label class="muted" style="display:block;margin-top:8px">Fulfillment
                  <select data-mode="${i}" aria-label="Line ${i + 1} fulfillment mode" ${lockLines ? 'disabled' : ''}>
                    ${[['assembled','Fully built · RTS or production'],['semi_built','Semi-built · RTS or production'],['ckd','CKD · ship parts']].map(([value,label]) => `<option value="${value}" ${String(l.fulfillment_mode || 'assembled') === value ? 'selected' : ''}>${label}</option>`).join('')}
                  </select></label><div class="muted" data-ckd-preview="${i}" style="font-size:11px;margin-top:5px"></div>` : ''}${
                type === 'sale' && (l.allocated_qty || l.reserved_qty || l.released_qty)
                  ? `<div class="muted" style="font-size:11px">${
                      Math.max(Number(l.allocated_qty || 0) + Number(l.reserved_qty || 0), Number(l.released_qty || 0))
                    } / ${Number(l.quantity) || 0} released${Number(l.allocated_qty || 0) ? ` (${l.allocated_qty} shipped)` : ''}</div>` : ''}</td>
              <td data-label="SKU"><input data-k="sku" value="${UI.esc(l.sku || '')}" style="width:90px" /></td>
              <td data-label="Quantity"><input data-k="quantity" type="number" min="0" step="any" inputmode="decimal" value="${UI.esc(String(l.quantity ?? 1))}" class="right" style="width:70px" /></td>
              <td data-label="Unit"><input data-k="unit" value="${UI.esc(l.unit || '')}" maxlength="40" style="width:60px" /></td>
              <td data-label="Unit price"><input data-k="unit_price" type="number" min="0" step="0.01" inputmode="decimal" value="${UI.esc(String(l.unit_price ?? 0))}" class="right" style="width:90px" />${type === 'sale' && l.item_id && !lockLines ? `<div data-price-suggestion="${i}" class="muted" style="font-size:11px;margin-top:4px">Checking suggested price…</div>` : ''}</td>
              ${taxCell(l)}
              <td data-label="Line total" class="right" data-total="${i}">0.00</td>
              <td>${!lockLines ? `<button type="button" class="icon-btn danger" data-rm="${i}" title="Remove line ${i + 1}" aria-label="Remove line ${i + 1}">${UI.icon('trash', 15)}</button>` : ''}</td>
            </tr>`).join('');
          if (type === 'sale' && !lockLines) lines.forEach((line, i) => {
            if (!line.item_id) return;
            const holder = body.querySelector(`[data-price-suggestion="${i}"]`);
            const productId = Number(line.item_id);
            if (!priceSuggestions.has(productId)) priceSuggestions.set(productId,
              API.get('/finished-products/' + productId + '/price-suggestion').catch(() => ({ available: false, reason: 'Suggestion unavailable' })));
            priceSuggestions.get(productId).then((suggestion) => {
              if (!body.contains(holder) || Number(lines[i]?.item_id) !== productId) return;
              const orderCurrency = String(ov.querySelector('[data-f="currency"]').value || 'PHP').toUpperCase();
              if (!suggestion.available || suggestion.currency !== orderCurrency) {
                holder.textContent = suggestion.available ? `Suggestion uses ${suggestion.currency}; order uses ${orderCurrency}` : suggestion.reason;
                return;
              }
              holder.textContent = `${money(suggestion.suggested_unit_price)} suggested (${suggestion.markup_percent}% markup) `;
              const apply = document.createElement('button');
              apply.type = 'button'; apply.className = 'order-link-btn'; apply.textContent = 'Use suggestion';
              apply.setAttribute('aria-label', `Use suggested unit price for line ${i + 1}`);
              apply.onclick = () => {
                const input = body.querySelector(`[data-row="${i}"] [data-k="unit_price"]`);
                if (!input || Number(lines[i]?.item_id) !== productId) return;
                if (String(ov.querySelector('[data-f="currency"]').value || 'PHP').toUpperCase() !== suggestion.currency) {
                  UI.toast('Order currency changed. Review the suggestion again.', 'error'); return;
                }
                input.value = String(suggestion.suggested_unit_price);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
              };
              holder.appendChild(apply);
            });
          });
          function showCkdParts(i) {
            const target = body.querySelector(`[data-ckd-preview="${i}"]`);
            if (!target) return;
            const l = lines[i];
            target.textContent = l.fulfillment_mode === 'ckd'
              ? (l.ckd_parts?.length ? 'Ships: ' + l.ckd_parts.map((p) => `${p.name} ×${p.quantity}`).join(' · ') : 'Loading the product BOM…')
              : '';
          }
          lines.forEach((_, i) => showCkdParts(i));
          body.querySelectorAll('[data-mode]').forEach((select) => select.onchange = async () => {
            const i = Number(select.dataset.mode);
            lines[i].fulfillment_mode = select.value;
            if (select.value === 'ckd') {
              try {
                if (!lines[i].ckd_parts?.length) {
                  const product = await API.get('/finished-products/' + lines[i].item_id);
                  lines[i].ckd_parts = (product.bom || []).map((p) => ({ name: p.component_name, per_unit: p.quantity, quantity: p.quantity * Number(lines[i].quantity || 1) }));
                }
                if (!lines[i].ckd_parts.length) UI.toast('This product has no BOM for CKD; define its parts first.', 'error');
              } catch (e) { lines[i].ckd_parts = []; UI.toast(e.message || 'Unable to load CKD parts', 'error'); }
            }
            showCkdParts(i);
          });
          body.querySelectorAll('[data-k]').forEach((inp) => {
            const row = Number(inp.closest('[data-row]').dataset.row);
            inp.setAttribute('aria-label', `Line ${row + 1} ${inp.dataset.k.replace(/_/g, ' ')}`);
            inp.disabled = lockLines;
            const ev = inp.tagName === 'SELECT' ? 'change' : 'input';
            inp.addEventListener(ev, () => {
              const row = Number(inp.closest('[data-row]').dataset.row);
              lines[row][inp.dataset.k] = inp.value;
              if (inp.dataset.k === 'quantity' && lines[row].fulfillment_mode === 'ckd' && lines[row].ckd_parts?.length) {
                const base = lines[row].ckd_parts.map((p) => ({ ...p, per_unit: p.per_unit ?? p.quantity / Number(inp.defaultValue || 1) }));
                lines[row].ckd_parts = base.map((p) => ({ ...p, quantity: p.per_unit * Number(inp.value || 0) }));
                showCkdParts(row);
              }
              inp.removeAttribute('aria-invalid');
              inp.removeAttribute('aria-describedby');
              inp.parentElement.querySelector('.order-field-error')?.remove();
              recompute();
            });
          });
          body.querySelectorAll('[data-rm]').forEach((b) =>
            b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); renderLines(); });
          body.querySelectorAll('[data-link]').forEach((b) => b.onclick = () => pickInventory((it) => {
            const i = Number(b.dataset.link);
            Object.assign(lines[i], { item_id: it.id, name: it.name, sku: it.sku || '', unit: it.unit || '' });
            lines[i].fulfillment_mode = 'assembled'; lines[i].ckd_parts = [];
            renderLines();
            body.querySelector(`[data-row="${i}"] [data-k="quantity"]`).focus();
          }));
          body.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = () => {
            const i = Number(b.dataset.unlink);
            lines[i].item_id = null;
            lines[i].fulfillment_mode = 'assembled'; lines[i].ckd_parts = [];
            renderLines();
            body.querySelector(`[data-row="${i}"] [data-k="name"]`).focus();
          });
          recompute();
        }

        taxEl.addEventListener('input', recompute);
        if (type === 'sale') ov.querySelector('[data-f="currency"]').addEventListener('change', renderLines);
        const addBlank = ov.querySelector('#ord-add-blank');
        if (addBlank) addBlank.onclick = () => {
          lines.push({ name: '', sku: '', quantity: 1, unit: '', unit_price: 0 });
          renderLines();
          body.querySelector(`[data-row="${lines.length - 1}"] [data-k="name"]`).focus();
        };
        const addFee = ov.querySelector('#ord-add-fee');
        if (addFee) addFee.onclick = () => {
          lines.push({ item_id: null, name: ov.querySelector('#ord-fee-kind').value, description: 'Order fee',
            quantity: 1, unit: '', unit_price: 0 });
          renderLines();
          body.querySelector(`[data-row="${lines.length - 1}"] [data-k="unit_price"]`).focus();
        };
        const addInventory = ov.querySelector('#ord-add-inv');
        if (addInventory) addInventory.onclick = () => pickInventory((it) => {
          const sale = it.attributes && it.attributes.sale_price;
          lines.push({
            item_id: it.id, name: it.name, sku: it.sku || '', quantity: 1,
            unit: it.unit || '', unit_price: Number(sale) || 0, fulfillment_mode: 'assembled',
          });
          renderLines();
          body.querySelector(`[data-row="${lines.length - 1}"] [data-k="quantity"]`).focus();
        });
        renderLines();
        initialized = true;
        if (readOnly) ov.querySelector('[data-close]').focus();
      },
      onConfirm: async (ov, showErr) => {
        if (readOnly) return false;
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        ov.querySelectorAll('[aria-invalid]').forEach((el) => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
        ov.querySelectorAll('.order-field-error').forEach((el) => el.remove());
        function invalid(el, message) {
          el.setAttribute('aria-invalid', 'true');
          const hint = document.createElement('div');
          hint.className = 'order-field-error'; hint.textContent = message;
          hint.id = 'ord-field-error';
          el.setAttribute('aria-describedby', hint.id);
          el.parentElement.appendChild(hint);
          el.focus(); showErr(message); return false;
        }
        if (!lines.length) { showErr('Add at least one inventory item or non-stock line.'); ov.querySelector('#ord-add-inv')?.focus(); return false; }
        if (!lockLines) {
          for (const [i, l] of lines.entries()) {
            const field = (k) => ov.querySelector(`[data-row="${i}"] [data-k="${k}"]`);
            if (!String(l.name || '').trim()) return invalid(field('name'), `Line ${i + 1}: enter an item name.`);
            if (!Number.isFinite(Number(l.quantity)) || Number(l.quantity) <= 0) return invalid(field('quantity'), `Line ${i + 1}: quantity must be greater than zero.`);
            if (String(l.unit_price).trim() === '' || !Number.isFinite(Number(l.unit_price)) || Number(l.unit_price) < 0) return invalid(field('unit_price'), `Line ${i + 1}: enter a price of zero or more.`);
          }
        }
        if (!lockLines && (!Number.isFinite(Number(f('tax_percent'))) || Number(f('tax_percent')) < 0 || Number(f('tax_percent')) > 100)) {
          return invalid(ov.querySelector('[data-f="tax_percent"]'), 'Tax must be between 0 and 100%.');
        }
        if (!lockLines && !/^[A-Za-z]{3}$/.test(f('currency').trim())) return invalid(ov.querySelector('[data-f="currency"]'), 'Use a three-letter currency code, such as PHP.');
        const cleaned = lines
          .map((l) => ({
            item_id: l.item_id || null, name: (l.name || '').trim(), sku: l.sku || null,
            fulfillment_mode: l.fulfillment_mode || 'assembled',
            description: l.description || null, quantity: Number(l.quantity) || 0,
            unit: l.unit || null, unit_price: Number(l.unit_price) || 0,
            tax_code_id: l.tax_code_id ? Number(l.tax_code_id) : null,
          }));
        if (!cleaned.length) { showErr('Add at least one line item (with a name)'); return false; }

        const fOpt = (k) => { const el = ov.querySelector(`[data-f="${k}"]`); return el ? el.value : null; };
        const body = {
          customer_name: f('customer_name'), customer_contact: f('customer_contact'),
          order_date: f('order_date'), status: f('status'), currency: f('currency'),
          tax_percent: Number(f('tax_percent')) || 0, notes: f('notes'), items: cleaned,
        };
        if (editing && order.revision) body.expected_revision = order.revision;
        if (type === 'purchase') {
          body.supplier_id = fOpt('supplier_id') || null;
          body.expected_date = fOpt('expected_date') || null;
        }
        if (type === 'sale') {
          body.customer_id = fOpt('customer_id') || null;
          if (locations.length) body.location_id = fOpt('location_id') || null;
        }
        body.tax_code_id = taxCodes.length ? fOpt('tax_code_id') || null : get('tax_code_id', null);

        const needsApprovalReview = type === 'sale' && editing && ['open', 'cancelled'].includes(String(order.status).toLowerCase()) && body.status === 'approved';
        if (needsApprovalReview) body.status = 'open';
        const payload = editing ? body : { type, ...body };
        const signature = JSON.stringify(payload);
        if (!saveAttempt || saveAttempt.signature !== signature) saveAttempt = { signature, key: 'order:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) };
        const saveControls = [...ov.querySelectorAll('[data-f], [data-k], .line-actions button, [data-link], [data-unlink], [data-rm]')].filter((el) => !el.disabled);
        saveControls.forEach((el) => el.disabled = true);
        try {
          if (editing) await API.put('/orders/' + order.id, payload, { idempotencyKey: saveAttempt.key });
          else await API.post('/orders', payload, { idempotencyKey: saveAttempt.key });
        } catch (e) {
          if (e.status >= 400 && e.status < 500) saveAttempt = null;
          if (e.data?.code === 'stale_order') {
            showErr(e.message);
            const errBox = ov.querySelector('[data-modal-error]');
            const latest = document.createElement('button');
            latest.type = 'button'; latest.className = 'btn secondary small'; latest.textContent = 'Review latest order';
            latest.onclick = async () => {
              if (!(await UI.confirmDialog('Your unsaved changes will be discarded when you open the latest order. Continue?', 'Review latest order'))) return;
              try { const current = await API.get('/orders/' + order.id); m.close(); orderModal(current); }
              catch (error) { UI.toast(error.message, 'error'); }
            };
            errBox.appendChild(latest); return false;
          }
          if (e && e.status === 409 && e.data && e.data.availability) {
            showErr(e.message + ' Use Review stock & approval from the order list to plan missing supply.');
            return false;   // keep this modal open behind the shortfall prompt
          }
          throw e;
        } finally {
          saveControls.forEach((el) => el.disabled = false);
        }
        if (needsApprovalReview) { m.close(); await reviewStock(order.id); load(); return true; }
        UI.toast(editing ? 'Order saved' : 'Order created');
        load();
      },
    });
    return m;
  }

  function pickInventory(onPick) {
    const m = UI.modal({
      title: 'Add inventory item',
      bodyHTML: `<div class="search-box">${UI.icon('search', 16)}<input id="pick-q" aria-label="Search inventory by name or SKU" placeholder="Search name or SKU…" autofocus /></div>
        <p class="muted">Quantities shown are on hand across locations. Approval checks stock at the ship-from location, other orders and stock holds. Zero-stock items can be ordered for production or purchasing.</p>
        <div id="pick-results" style="margin-top:12px" aria-live="polite"></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        const q = ov.querySelector('#pick-q');
        const out = ov.querySelector('#pick-results');
        let timer;
        let request = 0;
        async function search() {
          const current = ++request;
          out.innerHTML = '<div class="empty">Searching inventory…</div>';
          let items;
          try { items = await API.get('/inventory?q=' + encodeURIComponent(q.value.trim())); }
          catch (e) {
            if (current !== request || !ov.isConnected) return;
            out.innerHTML = `<div class="empty" role="alert">${UI.esc(e.message)}<p><button type="button" class="btn secondary" data-retry>Try again</button></p></div>`;
            out.querySelector('[data-retry]').onclick = search; return;
          }
          if (current !== request || !ov.isConnected) return;
          if (!items.length) { out.innerHTML = '<div class="empty">No items found. Try a different name or SKU.</div>'; return; }
          out.innerHTML = items.slice(0, 20).map((it) => {
            const spec = it.attributes && typeof it.attributes === 'object' ? it.attributes.spec : null;
            const variant = [it.product_group, spec].filter(Boolean).map(String).join(' · ');
            return `
            <button type="button" class="pick-row order-pick-row" data-id="${it.id}">
              <span><strong>${UI.esc(it.name)}</strong> <span class="muted mono">${UI.esc(it.sku || '')}</span>${variant ? ` <span class="muted">${UI.esc(variant)}</span>` : ''}</span>
              <span class="muted">${it.quantity} ${UI.esc(it.unit || '')} on hand</span>
            </button>`;
          }).join('') + (items.length > 20 ? '<p class="muted">Showing the first 20 matches. Refine your search to find another item.</p>' : '');
          out.querySelectorAll('[data-id]').forEach((row) =>
            row.onclick = () => { m.close(); queueMicrotask(() => onPick(items.find((x) => x.id == row.dataset.id))); });
        }
        q.addEventListener('input', () => { ++request; clearTimeout(timer); timer = setTimeout(search, 250); });
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
               <p class="muted" style="font-size:12px;margin-top:10px">Sale &amp; job orders post as Invoices, supplier purchase orders as Bills. Internal purchase requests are budget approvals and are not sent to QuickBooks. Re-pushing an order updates it. If a line won't post, set a default income/expense account in QuickBooks.</p>`
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
  view.querySelector('#ord-new')?.addEventListener('click', () => orderModal(null));

  await load();
  if (filter && filter.new && canCreate) orderModal(null);
  if (filter && filter.review && type === 'sale') reviewStock(filter.review);
  // filter.id deep-links straight into one order's edit modal (used by the AI assistant's
  // created-record links) — openOrder() only needs the id, it fetches the rest itself.
  if (filter && filter.id) openOrder(filter.id);
});
