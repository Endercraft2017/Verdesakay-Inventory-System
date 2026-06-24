/* Inventory: list, search, filter, create/edit, stock in/out, history, delete. */
App.register('inventory', async (view, filter) => {
  const state = { q: '', department_id: '', category: '', low: !!(filter && filter.low) };
  let lastItems = [];

  function deptOptions(selected) {
    return '<option value="">— Department —</option>' +
      App.getDepartments().map((d) =>
        `<option value="${d.id}" ${String(d.id) === String(selected) ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('');
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Inventory</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="inv-search" placeholder="Search name, SKU, location…" /></div>
      <select id="inv-cat" style="width:150px"><option value="">— Category —</option></select>
      <select id="inv-dept" style="width:160px">${deptOptions('')}</select>
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:500;white-space:nowrap;">
        <input type="checkbox" id="inv-low" style="width:auto" ${state.low ? 'checked' : ''} /> Low stock</label>
      <button class="btn secondary" id="inv-export" title="Export current list to CSV">${UI.icon('download')} Export</button>
      <button class="btn" id="inv-add">${UI.icon('plus')} New item</button>
    </div>
    <div class="panel"><div id="inv-table"></div></div>`;

  const tableEl = view.querySelector('#inv-table');

  async function loadCategories() {
    try {
      const cats = await API.get('/inventory/categories');
      const sel = view.querySelector('#inv-cat');
      const current = state.category;
      sel.innerHTML = '<option value="">— Category —</option>' +
        cats.map((c) => `<option value="${UI.esc(c)}" ${c === current ? 'selected' : ''}>${UI.esc(c)}</option>`).join('');
    } catch { /* ignore */ }
  }

  async function load() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.department_id) params.set('department_id', state.department_id);
    if (state.category) params.set('category', state.category);
    if (state.low) params.set('low', '1');
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const items = await API.get('/inventory?' + params.toString());
    lastItems = items;
    render(items);
  }

  function exportCsv() {
    if (!lastItems.length) { UI.toast('Nothing to export', 'error'); return; }
    const headers = ['Name', 'SKU', 'Category', 'Department', 'Quantity', 'Unit', 'Min', 'Location'];
    const rows = lastItems.map((i) => [
      i.name, i.sku || '', i.category || '', i.department_name || '',
      i.quantity, i.unit || '', i.min_quantity, i.location || '',
    ]);
    UI.downloadCsv('inventory.csv', headers, rows);
  }

  function render(items) {
    if (!items.length) {
      const fresh = !state.q && !state.department_id && !state.low;
      tableEl.innerHTML = UI.emptyState({
        icon: 'inventory',
        title: fresh ? 'No items yet' : 'No matching items',
        hint: fresh ? 'Add your first inventory item to start tracking stock.' : 'Try a different search or filter.',
        action: fresh ? `<button class="btn" id="inv-empty-add">${UI.icon('plus')} New item</button>` : '',
      });
      const ea = tableEl.querySelector('#inv-empty-add');
      if (ea) ea.onclick = () => itemModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Item</th><th>Category</th><th>Department</th><th>Location</th>
          <th class="right">Quantity</th><th></th>
        </tr></thead>
        <tbody>${items.map((i) => `
          <tr>
            <td><strong>${UI.esc(i.name)}</strong><div class="muted mono">${UI.esc(i.sku || '—')}</div></td>
            <td>${UI.esc(i.category || '—')}</td>
            <td>${UI.esc(i.department_name || '—')}</td>
            <td>${UI.esc(i.location || '—')}</td>
            <td class="right">
              <span class="badge-pill ${i.low_stock ? 'low' : 'ok'}">${i.quantity} ${UI.esc(i.unit || '')}</span>
              ${i.low_stock ? `<div class="muted" style="font-size:11px">min ${i.min_quantity}</div>` : ''}
            </td>
            <td class="actions">
              <button class="icon-btn" title="Stock in/out" data-adjust="${i.id}">${UI.icon('adjust')}</button>
              <button class="icon-btn" title="History" data-history="${i.id}">${UI.icon('history')}</button>
              <button class="icon-btn" title="Edit" data-edit="${i.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${i.id}">${UI.icon('trash')}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    tableEl.querySelectorAll('[data-adjust]').forEach((b) => b.onclick = () => adjustModal(b.dataset.adjust, items));
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => itemModal(items.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-history]').forEach((b) => b.onclick = () => historyModal(b.dataset.history));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(items.find((x) => x.id == b.dataset.del)));
  }

  function itemFormHTML(it) {
    it = it || {};
    return `
      <div class="field-row">
        <div><label>Item name *</label><input data-f="name" value="${UI.esc(it.name || '')}" /></div>
        <div><label>SKU / Code</label><input data-f="sku" value="${UI.esc(it.sku || '')}" /></div>
      </div>
      <div class="field-row">
        <div><label>Category</label><input data-f="category" value="${UI.esc(it.category || '')}" /></div>
        <div><label>Department</label><select data-f="department_id">${
          '<option value="">— None —</option>' + App.getDepartments().map((d) =>
            `<option value="${d.id}" ${d.id === it.department_id ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('')
        }</select></div>
      </div>
      <div class="field-row">
        ${it.id ? '' : `<div><label>Starting quantity</label><input data-f="quantity" type="number" value="0" /></div>`}
        <div><label>Unit</label><input data-f="unit" value="${UI.esc(it.unit || 'pcs')}" /></div>
        <div><label>Reorder level (min)</label><input data-f="min_quantity" type="number" value="${it.min_quantity ?? 0}" /></div>
      </div>
      <div><label>Location</label><input data-f="location" value="${UI.esc(it.location || '')}" /></div>
      <div><label>Notes</label><textarea data-f="notes">${UI.esc(it.notes || '')}</textarea></div>`;
  }

  function readForm(overlay) {
    const body = {};
    overlay.querySelectorAll('[data-f]').forEach((el) => { body[el.dataset.f] = el.value; });
    return body;
  }

  function itemModal(it) {
    UI.modal({
      title: it ? 'Edit item' : 'New inventory item',
      bodyHTML: itemFormHTML(it),
      confirmText: it ? 'Save changes' : 'Create item',
      onConfirm: async (overlay, showErr) => {
        const body = readForm(overlay);
        if (!body.name.trim()) { showErr('Item name is required'); return false; }
        if (it) await API.put('/inventory/' + it.id, body);
        else await API.post('/inventory', body);
        UI.toast(it ? 'Item updated' : 'Item created');
        load();
        loadCategories();
      },
    });
  }

  function adjustModal(id, items) {
    const it = items.find((x) => x.id == id);
    UI.modal({
      title: `Adjust stock — ${it.name}`,
      bodyHTML: `
        <p class="muted">Current: <strong>${it.quantity} ${UI.esc(it.unit || '')}</strong></p>
        <div class="field-row">
          <div><label>Action</label><select data-f="dir">
            <option value="in">Stock IN (＋)</option><option value="out">Stock OUT (−)</option></select></div>
          <div><label>Amount</label><input data-f="amount" type="number" min="1" value="1" /></div>
        </div>
        <div><label>Reason / reference</label><input data-f="reason" placeholder="e.g. Purchase, Released to Dept" /></div>`,
      confirmText: 'Apply',
      onConfirm: async (overlay, showErr) => {
        const dir = overlay.querySelector('[data-f="dir"]').value;
        const amount = parseInt(overlay.querySelector('[data-f="amount"]').value, 10);
        const reason = overlay.querySelector('[data-f="reason"]').value;
        if (!amount || amount <= 0) { showErr('Enter a positive amount'); return false; }
        const change = dir === 'out' ? -amount : amount;
        const r = await API.post(`/inventory/${id}/adjust`, { change, reason });
        UI.toast(`Stock updated — new balance ${r.quantity}`);
        load();
      },
    });
  }

  async function historyModal(id) {
    const it = await API.get('/inventory/' + id);
    const rows = it.history.map((h) => `
      <tr><td>${UI.fmtDate(h.created_at)}</td>
      <td class="${h.change < 0 ? '' : ''}"><strong style="color:${h.change < 0 ? 'var(--danger)' : 'var(--green-700)'}">${h.change > 0 ? '+' : ''}${h.change}</strong></td>
      <td class="right">${h.balance_after}</td>
      <td>${UI.esc(h.reason || '—')}</td>
      <td>${UI.esc(h.user_name || '—')}</td></tr>`).join('');
    UI.modal({
      title: `History — ${it.name}`,
      bodyHTML: it.history.length
        ? `<table><thead><tr><th>When</th><th>Change</th><th class="right">Balance</th><th>Reason</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty">No movements recorded yet.</div>',
      cancelText: 'Close',
    });
  }

  async function del(it) {
    const ok = await UI.confirmDialog(`Delete "${it.name}"? This also removes its stock history.`, 'Delete');
    if (!ok) return;
    await API.del('/inventory/' + it.id);
    UI.toast('Item deleted');
    load();
  }

  // Wire toolbar
  let searchTimer;
  view.querySelector('#inv-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.q = e.target.value.trim();
    searchTimer = setTimeout(load, 250);
  });
  view.querySelector('#inv-cat').addEventListener('change', (e) => { state.category = e.target.value; load(); });
  view.querySelector('#inv-dept').addEventListener('change', (e) => { state.department_id = e.target.value; load(); });
  view.querySelector('#inv-low').addEventListener('change', (e) => { state.low = e.target.checked; load(); });
  view.querySelector('#inv-export').addEventListener('click', exportCsv);
  view.querySelector('#inv-add').addEventListener('click', () => itemModal(null));

  await Promise.all([load(), loadCategories()]);
});
