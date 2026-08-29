/* Job & Sale Orders: list, create/edit (line items from inventory), print via template.
   One view serves both types; filter.type = 'sale' | 'job'. */
App.register('orders', async (view, filter) => {
  const type = filter && filter.type === 'job' ? 'job' : filter && filter.type === 'purchase' ? 'purchase' : 'sale';
  const noun = type === 'sale' ? 'Sale Order' : type === 'job' ? 'Job Order' : 'Purchase Request';
  const state = { q: '' };
  const qbDoc = type === 'purchase' ? 'Bill' : 'Invoice';
  let qb = { connected: false };
  try { qb = await API.get('/quickbooks/status'); } catch { /* not configured */ }
  const canQbPush = qb.connected && App.hasPermission('orders.edit');

  view.innerHTML = `
    <div class="topbar">
      <h2>${noun}s</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="ord-search" placeholder="Search number, customer…" /></div>
      ${App.hasPermission('users.manage') && qb.configured ? `<button class="btn secondary" id="ord-qb">${UI.icon('sheet')} QuickBooks${qb.connected ? ' ✓' : ''}</button>` : ''}
      <button class="btn" id="ord-new">${UI.icon('plus')} New ${noun}</button>
    </div>
    <div class="panel"><div id="ord-table"></div></div>`;

  const qbBtn = view.querySelector('#ord-qb');
  if (qbBtn) qbBtn.onclick = () => quickbooksModal(() => App.navigate('orders', filter));

  const tableEl = view.querySelector('#ord-table');
  const money = UI.money;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const params = new URLSearchParams({ type });
    if (state.q) params.set('q', state.q);
    const list = await API.get('/orders?' + params.toString());
    render(list);
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'forms',
        title: state.q ? 'No matching orders' : `No ${noun.toLowerCase()}s yet`,
        hint: state.q ? 'Try a different search.' : `Create your first ${noun.toLowerCase()} to start.`,
        action: state.q ? '' : `<button class="btn" id="ord-empty-new">${UI.icon('plus')} New ${noun}</button>`,
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
            <td><strong>${UI.esc(o.number)}</strong></td>
            <td>${UI.esc(o.customer_name || '—')}</td>
            <td>${UI.esc(o.order_date || UI.fmtDateShort(o.created_at))}</td>
            <td class="right">${UI.esc(o.currency || '')} ${money(o.total)}</td>
            <td><span class="badge-pill status-${UI.esc(o.status)}">${UI.esc(o.status)}</span></td>
            <td class="actions">
              ${type === 'job' && App.hasPermission('inventory.adjust') ? `<button class="icon-btn" title="Start production" data-produce="${o.id}">${UI.icon('adjust')}</button>` : ''}
              ${canQbPush ? `<button class="icon-btn" title="Push to QuickBooks as a ${qbDoc}" data-qbpush="${o.id}">${UI.icon('sheet')}</button>` : ''}
              <button class="icon-btn" title="Print" data-print="${o.id}">${UI.icon('printer')}</button>
              <button class="icon-btn" title="Edit" data-edit="${o.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${o.id}">${UI.icon('trash')}</button>
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

  /* ---------- Start a production run linked to this job order ---------- */
  async function startProduction(orderId) {
    const [order, products, locations] = await Promise.all([
      API.get('/orders/' + orderId),
      API.get('/finished-products'),
      API.get('/locations'),
    ]);
    if (!products.length) { UI.toast('Define a finished product with a BOM first (Inventory → Finished Products)', 'error'); return; }
    // Prefill from a line item that maps to a finished product, if any.
    const match = (order.items || []).find((li) => products.some((p) => p.id === li.item_id));
    const locOpts = locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.name)}</option>`).join('');
    UI.modal({
      title: `Start production — ${order.number}`,
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Product to build <span class="req">*</span></label></div>
          <select data-f="product">${products.map((p) => `<option value="${p.id}" ${match && match.item_id === p.id ? 'selected' : ''}>${UI.esc(p.name)} — ${p.max_buildable} buildable</option>`).join('')}</select></div>
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

    const statusOpts = ['open', 'confirmed', 'completed', 'cancelled']
      .map((s) => `<option value="${s}" ${get('status', 'open') === s ? 'selected' : ''}>${s}</option>`).join('');

    const m = UI.modal({
      title: editing ? `Edit ${order.number}` : `New ${noun}`,
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Customer name</label><input data-f="customer_name" value="${UI.esc(get('customer_name', ''))}" /></div>
          <div><label>Customer contact</label><input data-f="customer_contact" value="${UI.esc(get('customer_contact', ''))}" /></div>
        </div>
        <div class="field-row">
          <div><label>Order date</label><input data-f="order_date" type="date" value="${UI.esc(get('order_date', ''))}" /></div>
          <div><label>Status</label><select data-f="status">${statusOpts}</select></div>
          <div><label>Currency</label><input data-f="currency" value="${UI.esc(get('currency', 'PHP'))}" /></div>
        </div>
        <label style="margin-top:14px">Line items</label>
        <div class="line-items"><table class="line-table"><thead><tr>
          <th>Item</th><th>SKU</th><th class="right">Qty</th><th>Unit</th><th class="right">Unit Price</th><th class="right">Total</th><th></th>
        </tr></thead><tbody id="ord-lines"></tbody></table></div>
        <div class="line-actions">
          <button type="button" class="btn secondary small" id="ord-add-inv">${UI.icon('inventory', 15)} Add inventory item</button>
          <button type="button" class="btn secondary small" id="ord-add-blank">${UI.icon('plus', 15)} Add blank line</button>
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

        function renderLines() {
          if (!lines.length) {
            body.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:14px">No line items yet — add one below.</td></tr>`;
            recompute();
            return;
          }
          body.innerHTML = lines.map((l, i) => `
            <tr data-row="${i}">
              <td><input data-k="name" value="${UI.esc(l.name || '')}" placeholder="Item name" /></td>
              <td><input data-k="sku" value="${UI.esc(l.sku || '')}" style="width:90px" /></td>
              <td><input data-k="quantity" type="number" step="any" value="${UI.esc(String(l.quantity ?? 1))}" class="right" style="width:70px" /></td>
              <td><input data-k="unit" value="${UI.esc(l.unit || '')}" style="width:60px" /></td>
              <td><input data-k="unit_price" type="number" step="0.01" value="${UI.esc(String(l.unit_price ?? 0))}" class="right" style="width:90px" /></td>
              <td class="right" data-total="${i}">0.00</td>
              <td><button type="button" class="icon-btn danger" data-rm="${i}" title="Remove">${UI.icon('trash', 15)}</button></td>
            </tr>`).join('');
          body.querySelectorAll('input[data-k]').forEach((inp) => {
            inp.addEventListener('input', () => {
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
        renderLines();
      },
      onConfirm: async (ov, showErr) => {
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const cleaned = lines
          .map((l) => ({
            item_id: l.item_id || null, name: (l.name || '').trim(), sku: l.sku || null,
            description: l.description || null, quantity: Number(l.quantity) || 0,
            unit: l.unit || null, unit_price: Number(l.unit_price) || 0,
          }))
          .filter((l) => l.name);
        if (!cleaned.length) { showErr('Add at least one line item (with a name)'); return false; }
        const body = {
          customer_name: f('customer_name'), customer_contact: f('customer_contact'),
          order_date: f('order_date'), status: f('status'), currency: f('currency'),
          tax_percent: Number(f('tax_percent')) || 0, notes: f('notes'), items: cleaned,
        };
        if (editing) await API.put('/orders/' + order.id, body);
        else await API.post('/orders', { type, ...body });
        UI.toast(editing ? 'Order saved' : 'Order created');
        load();
      },
    });
    return m;
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
          out.innerHTML = items.slice(0, 20).map((it) => `
            <div class="pick-row" data-id="${it.id}">
              <div><strong>${UI.esc(it.name)}</strong> <span class="muted mono">${UI.esc(it.sku || '')}</span></div>
              <div class="muted">${it.quantity} ${UI.esc(it.unit || '')}</div>
            </div>`).join('');
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
      const [templateList, company] = await Promise.all([
        API.get('/templates?type=' + order.type),
        API.get('/templates/company'),
      ]);
      // List returns metadata only; fetch full body for the first matching template.
      const tpl = templateList[0];
      const [tplBody, variables] = await Promise.all([
        tpl ? API.get('/templates/' + tpl.id).then((t) => t.body) : Promise.resolve(FALLBACK_TEMPLATE),
        // Global variables always apply; template-scoped ones only when a real template matched.
        API.get('/templates/variables' + (tpl ? `?template_id=${tpl.id}` : '')).catch(() => []),
      ]);
      const ctx = buildDocContext({ order, company, user: App.getMe(), variables });
      const full = UI.printableHtml(renderTemplate(tplBody, ctx), order.number);

      UI.modal({
        title: order.number + ' — Preview',
        size: 'lg',
        bodyHTML: `<iframe id="ord-preview-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => { ov.querySelector('#ord-preview-frame').srcdoc = full; },
        onConfirm: (ov) => {
          const ifr = ov.querySelector('#ord-preview-frame');
          ifr.contentWindow.focus();
          ifr.contentWindow.print();
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
  view.querySelector('#ord-new').addEventListener('click', () => orderModal(null));

  await load();
});
