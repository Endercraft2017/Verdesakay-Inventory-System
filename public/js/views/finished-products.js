/* Inventory → Finished Products: items built from a bill of materials (bom_components). */
App.register('finished-products', async (view) => {
  const canWrite = App.hasPermission('inventory.edit');
  let list = [];
  let allItems = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Finished Products</h2>
      <div class="grow"></div>
      ${canWrite ? `<button class="btn" id="fp-add">${UI.icon('plus')} New finished product</button>` : ''}
    </div>
    <div class="panel"><div id="fp-table"></div></div>`;

  const tableEl = view.querySelector('#fp-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    [list, allItems] = await Promise.all([
      API.get('/finished-products'),
      API.get('/inventory'),
    ]);
    render();
  }

  function render() {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'sparkles',
        title: 'No finished products yet',
        hint: 'Pick an item, then list the parts it is built from. That parts list is the BOM.',
        action: canWrite ? `<button class="btn" id="fp-empty-add">${UI.icon('plus')} New finished product</button>` : '',
      });
      const ea = tableEl.querySelector('#fp-empty-add');
      if (ea) ea.onclick = () => bomModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Product</th><th class="right">Components</th>
          <th class="right">Buildable now</th><th class="right">In stock</th><th></th>
        </tr></thead>
        <tbody>${list.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><strong>${UI.esc(p.name)}</strong><div class="muted mono">${UI.esc(p.sku || '—')}</div></td>
            <td class="right">${p.component_count}</td>
            <td class="right">${p.component_count ? p.max_buildable : '—'}</td>
            <td class="right">${p.quantity} ${UI.esc(p.unit || '')}</td>
            <td class="actions">
              ${canWrite ? `<button class="icon-btn" title="Edit BOM" data-edit="${p.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Remove finished-product flag" data-del="${p.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => bomModal(list.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = () => unflag(list.find((x) => x.id == b.dataset.del)));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      detailModal(tr.dataset.open);
    });
  }

  function componentSelect(productId, selected) {
    return '<option value="">— component —</option>' +
      allItems
        .filter((i) => String(i.id) !== String(productId))
        .map((i) => `<option value="${i.id}" ${String(i.id) === String(selected) ? 'selected' : ''}>${UI.esc(i.name)}${i.sku ? ' (' + UI.esc(i.sku) + ')' : ''}</option>`)
        .join('');
  }

  function compRow(productId, c) {
    return `<div class="bom-row">
      <select data-c="item">${componentSelect(productId, c && c.component_item_id)}</select>
      <input data-c="qty" type="number" min="0" step="any" value="${c ? c.quantity : 1}" style="width:90px" />
      <input data-c="notes" placeholder="Notes (optional)" value="${UI.esc(c && c.notes || '')}" />
      <button type="button" class="icon-btn danger" data-c="rm" title="Remove">${UI.icon('trash')}</button>
    </div>`;
  }

  async function bomModal(existing) {
    // For a brand-new one, first choose which item becomes the finished product.
    let productId = existing ? existing.id : '';
    let bom = [];
    if (existing) {
      const full = await API.get('/finished-products/' + existing.id).catch(() => null);
      bom = (full && full.bom) || [];
    }

    const pickerHTML = existing
      ? `<p class="muted" style="margin-top:0">Product: <strong>${UI.esc(existing.name)}</strong></p>`
      : `<div class="form-field span2"><div class="field-label"><label>Item to build <span class="req">*</span></label></div>
          <select data-f="product">
            <option value="">— pick an item —</option>
            ${allItems.map((i) => `<option value="${i.id}">${UI.esc(i.name)}${i.sku ? ' (' + UI.esc(i.sku) + ')' : ''}</option>`).join('')}
          </select></div>`;

    UI.modal({
      title: existing ? `Bill of materials — ${existing.name}` : 'New finished product',
      size: 'lg',
      bodyHTML: `
        ${pickerHTML}
        <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Components (per 1 unit)</h4>
        <div id="bom-rows">${(bom.length ? bom : [null]).map((c) => compRow(productId, c)).join('')}</div>
        <button type="button" class="btn secondary small" id="bom-add" style="margin-top:8px">${UI.icon('plus')} Add component</button>`,
      confirmText: existing ? 'Save BOM' : 'Create',
      onOpen: (ov) => {
        const rowsEl = ov.querySelector('#bom-rows');
        const prodSel = ov.querySelector('[data-f="product"]');
        ov.querySelector('#bom-add').onclick = () => {
          const pid = prodSel ? prodSel.value : productId;
          rowsEl.insertAdjacentHTML('beforeend', compRow(pid, null));
        };
        rowsEl.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-c="rm"]');
          if (rm) rm.closest('.bom-row').remove();
        });
        // Keep component options in sync with the chosen product (exclude self).
        if (prodSel) prodSel.addEventListener('change', () => {
          rowsEl.querySelectorAll('[data-c="item"]').forEach((sel) => {
            const keep = sel.value;
            sel.innerHTML = componentSelect(prodSel.value, keep);
          });
        });
      },
      onConfirm: async (ov, showErr) => {
        const prodSel = ov.querySelector('[data-f="product"]');
        const pid = prodSel ? prodSel.value : productId;
        if (!pid) { showErr('Pick an item to build'); return false; }
        const components = [];
        for (const row of ov.querySelectorAll('.bom-row')) {
          const item = row.querySelector('[data-c="item"]').value;
          const qty = parseFloat(row.querySelector('[data-c="qty"]').value);
          const notes = row.querySelector('[data-c="notes"]').value.trim();
          if (!item) continue;
          if (!qty || qty <= 0) { showErr('Every component needs a quantity above 0'); return false; }
          components.push({ component_item_id: Number(item), quantity: qty, notes: notes || null });
        }
        if (!components.length) { showErr('Add at least one component'); return false; }
        await API.put('/finished-products/' + pid, { components });
        UI.toast(existing ? 'BOM saved' : 'Finished product created');
        load();
      },
    });
  }

  async function detailModal(id) {
    const p = await API.get('/finished-products/' + id);
    const bom = p.bom || [];
    const bottleneck = bom
      .map((c) => ({ name: c.component_name, can: Math.floor((c.component_on_hand || 0) / c.quantity) }))
      .sort((a, b) => a.can - b.can)[0];
    UI.modal({
      title: 'Finished product',
      size: 'lg',
      cancelText: 'Close',
      confirmText: canWrite ? 'Edit BOM' : null,
      onConfirm: canWrite ? () => bomModal(list.find((x) => x.id == id) || { id: p.id, name: p.name }) : undefined,
      bodyHTML: `
        <h3 style="margin:0 0 4px">${UI.esc(p.name)}</h3>
        <div class="muted mono">${UI.esc(p.sku || '—')}</div>
        <div class="kv" style="margin-top:12px">
          <div><span class="muted">In stock</span><div>${p.quantity} ${UI.esc(p.unit || '')}</div></div>
          <div><span class="muted">Buildable now</span><div>${bom.length ? p.max_buildable : '—'}</div></div>
          <div><span class="muted">Limiting part</span><div>${bottleneck ? UI.esc(bottleneck.name) : '—'}</div></div>
        </div>
        <h4 style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Bill of materials</h4>
        ${bom.length ? `<table>
          <thead><tr><th>Component</th><th class="right">Qty / unit</th><th class="right">On hand</th><th>Notes</th></tr></thead>
          <tbody>${bom.map((c) => `<tr>
            <td>${UI.esc(c.component_name)}<div class="muted mono">${UI.esc(c.component_sku || '')}</div></td>
            <td class="right">${c.quantity} ${UI.esc(c.component_unit || '')}</td>
            <td class="right">${c.component_on_hand ?? 0}</td>
            <td>${UI.esc(c.notes || '—')}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No components defined.</div>'}`,
    });
  }

  async function unflag(p) {
    const ok = await UI.confirmDialog(`Remove "${p.name}" from finished products? Its BOM will be cleared (the item itself stays).`, 'Remove');
    if (!ok) return;
    await API.del('/finished-products/' + p.id);
    UI.toast('Removed from finished products');
    load();
  }

  const addBtn = view.querySelector('#fp-add');
  if (addBtn) addBtn.onclick = () => bomModal(null);

  await load();
});
