/* Inventory → Suppliers: the vendor/supplier registry. Items link to a supplier. */
App.register('suppliers', async (view) => {
  const canWrite = App.hasPermission('inventory.create') || App.hasPermission('inventory.edit');
  let all = [];
  let q = '';

  view.innerHTML = `
    <div class="topbar">
      <h2>Suppliers</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="sup-search" placeholder="Search name, contact, email…" /></div>
      ${canWrite ? `<button class="btn secondary" id="sup-import" title="Create or update suppliers from a CSV file">${UI.icon('upload')} Import</button>` : ''}
      ${canWrite ? `<button class="btn" id="sup-add">${UI.icon('plus')} New supplier</button>` : ''}
    </div>
    <div class="panel"><div id="sup-table"></div></div>`;

  const tableEl = view.querySelector('#sup-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    all = await API.get('/suppliers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    render();
  }

  function render() {
    if (!all.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'building',
        title: q ? 'No matching suppliers' : 'No suppliers yet',
        hint: q ? 'Try a different search.' : 'Add the vendors you buy stock from, then link items to them.',
        action: (!q && canWrite) ? `<button class="btn" id="sup-empty-add">${UI.icon('plus')} New supplier</button>` : '',
      });
      const ea = tableEl.querySelector('#sup-empty-add');
      if (ea) ea.onclick = () => supplierModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th>
          <th class="right">Items</th><th></th>
        </tr></thead>
        <tbody>${all.map((s) => `
          <tr class="clickable" data-open="${s.id}">
            <td><strong>${UI.esc(s.name)}</strong>${s.address ? `<div class="muted" style="font-size:11px">${UI.esc(s.address)}</div>` : ''}</td>
            <td>${UI.esc(s.contact_person || '—')}</td>
            <td>${UI.esc(s.phone || '—')}</td>
            <td>${UI.esc(s.email || '—')}</td>
            <td class="right">${s.item_count || 0}</td>
            <td class="actions">
              ${canWrite ? `<button class="icon-btn" title="Edit" data-edit="${s.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${s.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => supplierModal(all.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = () => del(all.find((x) => x.id == b.dataset.del)));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      detailModal(all.find((x) => x.id == tr.dataset.open));
    });
  }

  const field = (label, key, val, type = 'text') =>
    `<div class="form-field"><div class="field-label"><label>${label}</label></div>
      <input data-f="${key}" type="${type}" value="${UI.esc(val || '')}" /></div>`;

  function supplierModal(s) {
    UI.modal({
      title: s ? 'Edit supplier' : 'New supplier',
      size: 'lg',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Name <span class="req">*</span></label></div>
          <input data-f="name" value="${UI.esc(s ? s.name : '')}" /></div>
        ${field('Contact person', 'contact_person', s && s.contact_person)}
        ${field('Phone', 'phone', s && s.phone)}
        ${field('Email', 'email', s && s.email, 'email')}
        <div class="form-field span2"><div class="field-label"><label>Address</label></div>
          <input data-f="address" value="${UI.esc(s && s.address || '')}" /></div>
        <div class="form-field span2"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes">${UI.esc(s && s.notes || '')}</textarea></div>
      </div>`,
      confirmText: s ? 'Save changes' : 'Create supplier',
      onConfirm: async (overlay, showErr) => {
        const g = (k) => overlay.querySelector(`[data-f="${k}"]`).value.trim();
        const body = {
          name: g('name'), contact_person: g('contact_person'), phone: g('phone'),
          email: g('email'), address: g('address'), notes: g('notes'),
        };
        if (!body.name) { showErr('Name is required'); return false; }
        if (s) await API.put('/suppliers/' + s.id, body);
        else await API.post('/suppliers', body);
        UI.toast(s ? 'Supplier updated' : 'Supplier created');
        load();
      },
    });
  }

  async function detailModal(row) {
    const s = await API.get('/suppliers/' + row.id).catch(() => row);
    const items = Array.isArray(s.items) ? s.items : [];
    UI.modal({
      title: 'Supplier details',
      size: 'lg',
      cancelText: 'Close',
      confirmText: canWrite ? 'Edit supplier' : null,
      onConfirm: canWrite ? () => supplierModal(s) : undefined,
      bodyHTML: `
        <h3 style="margin:0 0 4px">${UI.esc(s.name)}</h3>
        <div class="kv" style="margin-top:12px">
          <div><span class="muted">Contact</span><div>${UI.esc(s.contact_person || '—')}</div></div>
          <div><span class="muted">Phone</span><div>${UI.esc(s.phone || '—')}</div></div>
          <div><span class="muted">Email</span><div>${UI.esc(s.email || '—')}</div></div>
          <div><span class="muted">Address</span><div>${UI.esc(s.address || '—')}</div></div>
        </div>
        ${s.notes ? `<h4 style="margin:14px 0 4px">Notes</h4><p style="white-space:pre-wrap;margin:0">${UI.esc(s.notes)}</p>` : ''}
        <h4 style="margin:16px 0 4px">Items from this supplier (${items.length})</h4>
        ${items.length ? `<table><thead><tr><th>Item</th><th>SKU</th><th class="right">Qty</th></tr></thead>
          <tbody>${items.map((i) => `<tr><td>${UI.esc(i.name)}</td><td class="mono">${UI.esc(i.sku || '—')}</td>
          <td class="right">${i.quantity} ${UI.esc(i.unit || '')}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No items linked yet.</div>'}`,
    });
  }

  async function del(s) {
    const ok = await UI.confirmDialog(
      `Delete "${s.name}"?${s.item_count ? ` ${s.item_count} item(s) will keep their history but lose the supplier link.` : ''}`,
      'Delete'
    );
    if (!ok) return;
    await API.del('/suppliers/' + s.id);
    UI.toast('Supplier deleted');
    load();
  }

  let t;
  view.querySelector('#sup-search').addEventListener('input', (e) => {
    clearTimeout(t); q = e.target.value.trim(); t = setTimeout(load, 250);
  });
  const addBtn = view.querySelector('#sup-add');
  if (addBtn) addBtn.onclick = () => supplierModal(null);

  const importBtn = view.querySelector('#sup-import');
  if (importBtn) importBtn.onclick = () => UI.csvImportModal({
    title: 'Import suppliers',
    importPath: '/suppliers/import',
    exportPath: '/suppliers/export',
    columnsHtml:
      'Columns: <code>name</code> (required), <code>contact_person</code>, <code>phone</code>, ' +
      '<code>email</code>, <code>address</code>, <code>notes</code>. Rows are matched to existing ' +
      'suppliers by <strong>name</strong> (case-insensitive) — a match updates, no match creates.',
    templateHeaders: ['name', 'contact_person', 'phone', 'email', 'address', 'notes'],
    templateRows: [
      ['Acme Steel Supply', 'Jo Cruz', '+63 2 8123 4567', 'sales@acmesteel.test', '12 Ortigas Ave, Pasig City', 'Net 30 terms'],
      ['Metro Fasteners Inc', 'Rina Lim', '0917 555 0102', 'orders@metrofast.test', 'Cebu City', ''],
      ['Local Hardware', '', '', '', '', 'Walk-in / cash only'],
    ],
    onDone: () => load(),
  });

  await load();
});
