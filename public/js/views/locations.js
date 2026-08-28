/* Inventory → Locations: warehouses / branches / stores / trucks that hold stock. */
App.register('locations', async (view) => {
  const canWrite = App.hasPermission('inventory.create') || App.hasPermission('inventory.edit');
  const TYPES = ['warehouse', 'branch', 'store', 'truck', 'other'];
  let all = [];
  let q = '';

  view.innerHTML = `
    <div class="topbar">
      <h2>Locations</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="loc-search" placeholder="Search name, address, type…" /></div>
      ${canWrite ? `<button class="btn" id="loc-add">${UI.icon('plus')} New location</button>` : ''}
    </div>
    <div class="panel"><div id="loc-table"></div></div>`;

  const tableEl = view.querySelector('#loc-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    all = await API.get('/locations' + (q ? '?q=' + encodeURIComponent(q) : ''));
    render();
  }

  function render() {
    if (!all.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'building',
        title: q ? 'No matching locations' : 'No locations yet',
        hint: q ? 'Try a different search.' : 'Add the warehouses, branches, stores or trucks where you keep stock.',
        action: (!q && canWrite) ? `<button class="btn" id="loc-empty-add">${UI.icon('plus')} New location</button>` : '',
      });
      const ea = tableEl.querySelector('#loc-empty-add');
      if (ea) ea.onclick = () => locationModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Location</th><th>Type</th><th>Address</th>
          <th class="right">Units</th><th class="right">Items</th><th></th>
        </tr></thead>
        <tbody>${all.map((l) => `
          <tr class="clickable" data-open="${l.id}">
            <td><strong>${UI.esc(l.name)}</strong> ${l.is_default ? '<span class="badge-pill ok">default</span>' : ''}</td>
            <td style="text-transform:capitalize">${UI.esc(l.type)}</td>
            <td>${UI.esc(l.address || '—')}</td>
            <td class="right">${l.total_units || 0}</td>
            <td class="right">${l.item_count || 0}</td>
            <td class="actions">
              ${canWrite ? `
                ${l.is_default ? '' : `<button class="icon-btn" title="Set as default" data-default="${l.id}">${UI.icon('check')}</button>`}
                <button class="icon-btn" title="Edit" data-edit="${l.id}">${UI.icon('edit')}</button>
                <button class="icon-btn danger" title="Delete" data-del="${l.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => locationModal(all.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = () => del(all.find((x) => x.id == b.dataset.del)));
    tableEl.querySelectorAll('[data-default]').forEach((b) =>
      b.onclick = async () => {
        await API.post('/locations/' + b.dataset.default + '/default');
        UI.toast('Default location updated');
        load();
      });
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      detailModal(all.find((x) => x.id == tr.dataset.open));
    });
  }

  function locationModal(l) {
    const typeOpts = TYPES.map((t) =>
      `<option value="${t}" ${l && l.type === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('');
    UI.modal({
      title: l ? 'Edit location' : 'New location',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Name <span class="req">*</span></label></div>
          <input data-f="name" value="${UI.esc(l ? l.name : '')}" /></div>
        <div class="form-field"><div class="field-label"><label>Type</label></div>
          <select data-f="type">${typeOpts}</select></div>
        <div class="form-field inline"><label class="check-opt">
          <input type="checkbox" data-f="is_default" ${l && l.is_default ? 'checked' : ''} /> Default location</label></div>
        <div class="form-field span2"><div class="field-label"><label>Address</label></div>
          <input data-f="address" value="${UI.esc(l && l.address || '')}" /></div>
        <div class="form-field span2"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes">${UI.esc(l && l.notes || '')}</textarea></div>
      </div>`,
      confirmText: l ? 'Save changes' : 'Create location',
      onConfirm: async (overlay, showErr) => {
        const g = (k) => overlay.querySelector(`[data-f="${k}"]`);
        const body = {
          name: g('name').value.trim(), type: g('type').value,
          address: g('address').value.trim(), notes: g('notes').value.trim(),
          is_default: g('is_default').checked,
        };
        if (!body.name) { showErr('Name is required'); return false; }
        if (l) await API.put('/locations/' + l.id, body);
        else await API.post('/locations', body);
        UI.toast(l ? 'Location updated' : 'Location created');
        load();
      },
    });
  }

  async function detailModal(row) {
    const l = await API.get('/locations/' + row.id).catch(() => row);
    const items = Array.isArray(l.items) ? l.items : [];
    UI.modal({
      title: 'Location details',
      size: 'lg',
      cancelText: 'Close',
      confirmText: canWrite ? 'Edit location' : null,
      onConfirm: canWrite ? () => locationModal(l) : undefined,
      bodyHTML: `
        <h3 style="margin:0 0 4px">${UI.esc(l.name)} ${l.is_default ? '<span class="badge-pill ok">default</span>' : ''}</h3>
        <div class="kv" style="margin-top:12px">
          <div><span class="muted">Type</span><div style="text-transform:capitalize">${UI.esc(l.type)}</div></div>
          <div><span class="muted">Address</span><div>${UI.esc(l.address || '—')}</div></div>
          <div><span class="muted">Total units</span><div>${l.total_units || 0}</div></div>
          <div><span class="muted">Items held</span><div>${l.item_count || 0}</div></div>
        </div>
        ${l.notes ? `<h4 style="margin:14px 0 4px">Notes</h4><p style="white-space:pre-wrap;margin:0">${UI.esc(l.notes)}</p>` : ''}
        <h4 style="margin:16px 0 4px">Stock here (${items.length})</h4>
        ${items.length ? `<table><thead><tr><th>Item</th><th>SKU</th><th class="right">Qty</th></tr></thead>
          <tbody>${items.map((i) => `<tr><td>${UI.esc(i.name)}</td><td class="mono">${UI.esc(i.sku || '—')}</td>
          <td class="right">${i.quantity} ${UI.esc(i.unit || '')}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No stock here.</div>'}`,
    });
  }

  async function del(l) {
    const ok = await UI.confirmDialog(`Delete location "${l.name}"?`, 'Delete');
    if (!ok) return;
    try {
      await API.del('/locations/' + l.id);
      UI.toast('Location deleted');
      load();
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  let t;
  view.querySelector('#loc-search').addEventListener('input', (e) => {
    clearTimeout(t); q = e.target.value.trim(); t = setTimeout(load, 250);
  });
  const addBtn = view.querySelector('#loc-add');
  if (addBtn) addBtn.onclick = () => locationModal(null);

  await load();
});
