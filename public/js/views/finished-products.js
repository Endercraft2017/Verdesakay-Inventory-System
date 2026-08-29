/* Inventory → Finished Products: items built from a bill of materials (bom_components). */
App.register('finished-products', async (view) => {
  const canWrite = App.hasPermission('inventory.edit');
  const canConfigQc = App.hasPermission('qc.configure');
  let list = [];
  let allItems = [];
  let checklists = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Finished Products</h2>
      <div class="grow"></div>
      ${canConfigQc ? `<button class="btn secondary" id="fp-qc">${UI.icon('edit')} QA/QC Checklists</button>` : ''}
      ${canWrite ? `<button class="btn" id="fp-add">${UI.icon('plus')} New finished product</button>` : ''}
    </div>
    <div class="panel"><div id="fp-table"></div></div>`;

  const tableEl = view.querySelector('#fp-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    [list, allItems, checklists] = await Promise.all([
      API.get('/finished-products'),
      API.get('/inventory'),
      API.get('/qc/checklists').catch(() => []),
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
          <th>Product</th><th class="right">Components</th><th>QA/QC checklist</th>
          <th class="right">Buildable now</th><th class="right">In stock</th><th></th>
        </tr></thead>
        <tbody>${list.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><strong>${UI.esc(p.name)}</strong><div class="muted mono">${UI.esc(p.sku || '—')}</div></td>
            <td class="right">${p.component_count}</td>
            <td>${p.qc_checklist_name ? UI.esc(p.qc_checklist_name) : '<span class="muted">Default</span>'}</td>
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
      <input data-c="qty" type="number" min="1" step="1" value="${c ? c.quantity : 1}" style="width:90px" title="Quantity per 1 finished unit" />
      <input data-c="notes" placeholder="Notes (optional)" value="${UI.esc(c && c.notes || '')}" />
      <button type="button" class="icon-btn danger" data-c="rm" title="Remove">${UI.icon('trash')}</button>
    </div>`;
  }

  async function bomModal(existing) {
    // For a brand-new one, first choose which item becomes the finished product.
    let productId = existing ? existing.id : '';
    let bom = [];
    let currentChecklistId = '';
    if (existing) {
      const full = await API.get('/finished-products/' + existing.id).catch(() => null);
      bom = (full && full.bom) || [];
      currentChecklistId = (full && full.qc_checklist_id) || '';
    }

    const pickerHTML = existing
      ? `<p class="muted" style="margin-top:0">Product: <strong>${UI.esc(existing.name)}</strong></p>`
      : `<div class="form-field span2"><div class="field-label"><label>Item to build <span class="req">*</span></label></div>
          <select data-f="product">
            <option value="">— pick an item —</option>
            ${allItems.map((i) => `<option value="${i.id}">${UI.esc(i.name)}${i.sku ? ' (' + UI.esc(i.sku) + ')' : ''}</option>`).join('')}
          </select></div>`;

    const copyFromHTML = list.length ? `
      <div class="field-row" style="align-items:flex-end;gap:8px;margin:10px 0">
        <div style="flex:1"><label>Copy components from a similar product</label>
          <select data-f="copyfrom"><option value="">— none —</option>
            ${list.filter((p) => !existing || p.id !== existing.id)
              .map((p) => `<option value="${p.id}">${UI.esc(p.name)} (${p.component_count} parts)</option>`).join('')}
          </select></div>
        <button type="button" class="btn secondary" id="bom-copy">Copy</button>
      </div>` : '';

    const checklistHTML = `
      <div class="form-field span2" style="margin-top:6px"><div class="field-label"><label>QA/QC checklist</label></div>
        <select data-f="checklist">
          <option value="">Use the default checklist</option>
          ${checklists.map((c) => `<option value="${c.id}" ${String(c.id) === String(currentChecklistId) ? 'selected' : ''}>${UI.esc(c.name)}${c.is_default ? ' (default)' : ''}</option>`).join('')}
        </select></div>`;

    UI.modal({
      title: existing ? `Bill of materials — ${existing.name}` : 'New finished product',
      size: 'lg',
      bodyHTML: `
        ${pickerHTML}
        ${checklistHTML}
        ${copyFromHTML}
        <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Components (per 1 unit)</h4>
        <div id="bom-rows">${(bom.length ? bom : [null]).map((c) => compRow(productId, c)).join('')}</div>
        <button type="button" class="btn secondary small" id="bom-add" style="margin-top:8px">${UI.icon('plus')} Add component</button>`,
      confirmText: existing ? 'Save BOM' : 'Create',
      onOpen: (ov) => {
        const rowsEl = ov.querySelector('#bom-rows');
        const prodSel = ov.querySelector('[data-f="product"]');
        const pidNow = () => (prodSel ? prodSel.value : productId);
        ov.querySelector('#bom-add').onclick = () => {
          rowsEl.insertAdjacentHTML('beforeend', compRow(pidNow(), null));
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
        // Copy the BOM of another product into the editor (as a starting point).
        const copyBtn = ov.querySelector('#bom-copy');
        if (copyBtn) copyBtn.onclick = async () => {
          const from = ov.querySelector('[data-f="copyfrom"]').value;
          if (!from) return;
          copyBtn.disabled = true;
          try {
            const src = await API.get('/finished-products/' + from);
            const lines = (src.bom || []);
            if (!lines.length) { UI.toast('That product has no components', 'error'); return; }
            rowsEl.innerHTML = lines.map((c) => compRow(pidNow(), {
              component_item_id: c.component_item_id, quantity: c.quantity, notes: c.notes,
            })).join('');
            UI.toast(`Copied ${lines.length} component${lines.length === 1 ? '' : 's'} — review and save`);
          } catch (e) { UI.toast(e.message, 'error'); }
          finally { copyBtn.disabled = false; }
        };
      },
      onConfirm: async (ov, showErr) => {
        const prodSel = ov.querySelector('[data-f="product"]');
        const pid = prodSel ? prodSel.value : productId;
        if (!pid) { showErr('Pick an item to build'); return false; }
        const components = [];
        for (const row of ov.querySelectorAll('.bom-row')) {
          const item = row.querySelector('[data-c="item"]').value;
          const qty = parseInt(row.querySelector('[data-c="qty"]').value, 10);
          const notes = row.querySelector('[data-c="notes"]').value.trim();
          if (!item) continue;
          if (!qty || qty <= 0) { showErr('Every component needs a whole quantity above 0'); return false; }
          components.push({ component_item_id: Number(item), quantity: qty, notes: notes || null });
        }
        if (!components.length) { showErr('Add at least one component'); return false; }
        const qc_checklist_id = ov.querySelector('[data-f="checklist"]').value || null;
        await API.put('/finished-products/' + pid, { components, qc_checklist_id });
        UI.toast(existing ? 'BOM saved' : 'Finished product created');
        load();
      },
    });
  }

  // ---- QA/QC checklist library (qc.configure) ----
  function checklistLibraryModal() {
    const STAGE_LABEL = { 0: 'Every inspection', 1: 'QA (first) stage', 2: 'QC (final) stage' };
    const m = UI.modal({
      title: 'QA / QC checklists',
      size: 'lg',
      cancelText: 'Close',
      bodyHTML: `<div id="qcl-list"></div>
        <button type="button" class="btn secondary small" id="qcl-new" style="margin-top:10px">${UI.icon('plus')} New checklist</button>`,
    });
    const listEl = m.overlay.querySelector('#qcl-list');
    async function refresh() {
      checklists = await API.get('/qc/checklists');
      listEl.innerHTML = checklists.length ? `
        <table><thead><tr><th>Name</th><th class="right">Checks</th><th></th></tr></thead>
        <tbody>${checklists.map((c) => `<tr>
          <td><strong>${UI.esc(c.name)}</strong>${c.is_default ? ' <span class="badge-pill ok">default</span>' : ''}</td>
          <td class="right">${c.item_count}</td>
          <td class="actions">
            <button class="icon-btn" data-edit="${c.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${c.id}" title="Delete">${UI.icon('trash')}</button>
          </td></tr>`).join('')}</tbody></table>` : '<p class="muted">No checklists yet.</p>';
      listEl.querySelectorAll('[data-edit]').forEach((b) =>
        b.onclick = () => editChecklist(checklists.find((c) => String(c.id) === b.dataset.edit), refresh));
      listEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
        if (!(await UI.confirmDialog('Delete this checklist? Products using it fall back to the default.', 'Delete'))) return;
        await API.del('/qc/checklists/' + b.dataset.del);
        UI.toast('Deleted'); refresh();
      });
    }
    m.overlay.querySelector('#qcl-new').onclick = () => editChecklist(null, refresh);
    refresh();

    function editChecklist(existing, after) {
      let items = existing ? (existing.items || []).map((it) => ({ label: it.label, required: !!it.required, stage: Number(it.stage) || 0 })) : [];
      const em = UI.modal({
        title: existing ? `Edit — ${existing.name}` : 'New checklist',
        size: 'lg',
        confirmText: 'Save',
        bodyHTML: `
          <div class="field-row">
            <div style="flex:1"><label>Checklist name <span class="req">*</span></label><input data-f="name" value="${UI.esc(existing ? existing.name : '')}" /></div>
            <label class="check" style="align-self:flex-end;white-space:nowrap"><input type="checkbox" data-f="default" ${existing && existing.is_default ? 'checked' : ''}/> Default</label>
          </div>
          <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Checks</h4>
          <div id="qce-list"></div>
          <button type="button" class="btn secondary small" id="qce-add" style="margin-top:8px">${UI.icon('plus')} Add check</button>`,
        onConfirm: async (ov, showErr) => {
          const name = ov.querySelector('[data-f="name"]').value.trim();
          if (!name) { showErr('Name is required'); return false; }
          const clean = items.map((it) => ({ label: (it.label || '').trim(), required: !!it.required, stage: it.stage })).filter((it) => it.label);
          const body = { name, is_default: ov.querySelector('[data-f="default"]').checked, items: clean };
          if (existing) await API.put('/qc/checklists/' + existing.id, body);
          else await API.post('/qc/checklists', body);
          UI.toast('Checklist saved');
          after();
        },
      });
      const le = em.overlay.querySelector('#qce-list');
      function drawItems() {
        le.innerHTML = items.length ? items.map((it, i) => `
          <div class="field-row" style="align-items:center;gap:8px;margin-bottom:6px" data-i="${i}">
            <input data-f="label" value="${UI.esc(it.label)}" placeholder="e.g. Dimensions within tolerance" style="flex:1" />
            <select data-f="stage" style="width:160px">${[0, 1, 2].map((s) => `<option value="${s}" ${s === it.stage ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select>
            <label class="check" style="white-space:nowrap"><input type="checkbox" data-f="required" ${it.required ? 'checked' : ''}/> Required</label>
            <button type="button" class="icon-btn danger" data-del title="Remove">${UI.icon('trash')}</button>
          </div>`).join('') : '<p class="muted">No checks yet.</p>';
        le.querySelectorAll('[data-i]').forEach((row) => {
          const i = Number(row.dataset.i);
          row.querySelector('[data-f="label"]').oninput = (e) => { items[i].label = e.target.value; };
          row.querySelector('[data-f="stage"]').onchange = (e) => { items[i].stage = Number(e.target.value); };
          row.querySelector('[data-f="required"]').onchange = (e) => { items[i].required = e.target.checked; };
          row.querySelector('[data-del]').onclick = () => { items.splice(i, 1); drawItems(); };
        });
      }
      em.overlay.querySelector('#qce-add').onclick = () => { items.push({ label: '', required: false, stage: 0 }); drawItems(); };
      drawItems();
    }
  }

  // ---- "Where used": products whose BOM consumes a given component ----
  async function whereUsedModal(itemId, itemName) {
    let rows = [];
    try { rows = await API.get('/inventory/' + itemId + '/where-used'); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    UI.modal({
      title: 'Where used — ' + itemName,
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: rows.length ? `
        <p class="muted" style="margin-top:0">Products and sub-assemblies that consume this item.</p>
        <table><thead><tr><th>Product</th><th>Via</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${UI.esc(r.name)}<div class="muted mono">${UI.esc(r.sku || '')}</div></td>
          <td>${r.indirect ? '<span class="muted">sub-assembly</span>' : 'direct'}</td>
        </tr>`).join('')}</tbody></table>`
        : '<div class="empty">Not used in any bill of materials.</div>',
    });
  }

  async function detailModal(id) {
    const [p, units, explodeRes, costRes] = await Promise.all([
      API.get('/finished-products/' + id),
      API.get('/finished-products/' + id + '/units?status=in_stock').catch(() => []),
      API.get('/finished-products/' + id + '/explode?qty=1').catch(() => null),
      API.get('/finished-products/' + id + '/cost').catch(() => null),
    ]);
    const bom = p.bom || [];
    const subIds = new Set((explodeRes && explodeRes.subassemblies || []).map((s) => s.item_id));
    const bottleneck = bom
      .map((c) => ({ name: c.component_name, can: Math.floor((c.component_on_hand || 0) / c.quantity) }))
      .sort((a, b) => a.can - b.can)[0];
    const serial = units.filter((u) => u.identifier && u.identifier.trim());
    const bulk = units.length - serial.length;

    const stdCost = costRes ? costRes.unit_material_cost : null;
    const multiLevelHTML = explodeRes && explodeRes.materials.length ? `
      <div style="display:flex;align-items:center;gap:10px;margin:18px 0 4px">
        <h4 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Full material requirements (all levels)</h4>
        <div class="grow"></div>
        <label class="muted" style="font-size:12px">Build qty</label>
        <input id="fp-exq" type="number" min="1" value="1" style="width:80px" />
      </div>
      ${explodeRes.had_cycle ? '<p class="danger" style="margin:4px 0">⚠ This BOM references itself — the loop was stopped, totals may be incomplete.</p>' : ''}
      <div id="fp-explode"></div>` : '';

    const m = UI.modal({
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
          <div><span class="muted">Std. material cost / unit</span><div>${stdCost != null ? UI.money(stdCost) : '—'}</div></div>
          <div><span class="muted">QA/QC checklist</span><div>${p.qc_checklist_name ? UI.esc(p.qc_checklist_name) : 'Default'}</div></div>
        </div>
        <h4 style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Bill of materials <span class="muted" style="text-transform:none;letter-spacing:0">(direct components)</span></h4>
        ${bom.length ? `<table>
          <thead><tr><th>Component</th><th class="right">Qty / unit</th><th class="right">On hand</th><th class="right">Std. cost</th><th></th></tr></thead>
          <tbody>${bom.map((c) => {
            const line = (costRes && costRes.lines || []).find((l) => l.item_id === c.component_item_id);
            return `<tr>
            <td>${UI.esc(c.component_name)}${subIds.has(c.component_item_id) ? ' <span class="badge-pill">sub-assembly</span>' : ''}<div class="muted mono">${UI.esc(c.component_sku || '')}</div></td>
            <td class="right">${c.quantity} ${UI.esc(c.component_unit || '')}</td>
            <td class="right">${c.component_on_hand ?? 0}</td>
            <td class="right">${line ? UI.money(line.extended) : '—'}</td>
            <td class="right"><button type="button" class="btn secondary small" data-wu="${c.component_item_id}" data-wun="${UI.esc(c.component_name)}">Where used</button></td>
          </tr>`;
          }).join('')}</tbody></table>` : '<div class="empty">No components defined.</div>'}
        ${multiLevelHTML}

        <div style="display:flex;align-items:center;gap:10px;margin:18px 0 4px">
          <h4 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">In-stock units (passed QA/QC)</h4>
          <div class="grow"></div>
          ${canWrite ? `<button type="button" class="btn secondary small" id="fp-print">${UI.icon('printer') || ''} Print QR labels</button>
          <button type="button" class="btn secondary small" id="fp-sell">Sell / move…</button>` : ''}
        </div>
        ${units.length ? `<table>
          <thead><tr>${canWrite ? '<th style="width:26px"><input type="checkbox" id="fp-all"/></th>' : ''}<th>Identifier</th><th>From MO</th><th>Location</th><th>Passed</th></tr></thead>
          <tbody>
            ${serial.map((u) => `<tr>
              ${canWrite ? `<td><input type="checkbox" class="fp-u" value="${u.id}" data-ident="${UI.esc(u.identifier)}"/></td>` : ''}
              <td class="mono">${UI.esc(u.identifier)}</td>
              <td>${UI.esc(u.job_order_number || '—')}</td>
              <td>${UI.esc(u.location_name || '—')}</td>
              <td class="muted">${UI.esc((u.updated_at || '').slice(0, 10))}</td>
            </tr>`).join('')}
            ${bulk ? `<tr>${canWrite ? '<td></td>' : ''}<td class="muted">Bulk / no identifier</td><td>—</td><td>—</td><td class="right">${bulk}</td></tr>` : ''}
          </tbody>
        </table>` : '<div class="empty">No units on hand.</div>'}`,
      onOpen: (ov) => {
        const all = ov.querySelector('#fp-all');
        if (all) all.onclick = () => ov.querySelectorAll('.fp-u').forEach((c) => { c.checked = all.checked; });
        const picked = () => [...ov.querySelectorAll('.fp-u:checked')].map((c) => ({ id: Number(c.value), ident: c.dataset.ident }));
        const pb = ov.querySelector('#fp-print');
        if (pb) pb.onclick = () => printLabelsModal(p, picked(), bulk);
        const sb = ov.querySelector('#fp-sell');
        if (sb) sb.onclick = () => sellMoveModal(p, picked(), bulk, () => { m.close && m.close(); detailModal(id); load(); });

        ov.querySelectorAll('[data-wu]').forEach((b) =>
          b.onclick = () => whereUsedModal(Number(b.dataset.wu), b.dataset.wun));

        // Multi-level material requirements — re-explode as the build qty changes.
        const exWrap = ov.querySelector('#fp-explode');
        const exQ = ov.querySelector('#fp-exq');
        if (exWrap && exQ) {
          const drawExplode = (data) => {
            exWrap.innerHTML = `<table>
              <thead><tr><th>Raw material</th><th class="right">Total qty</th><th class="right">Unit cost</th><th class="right">Line cost</th></tr></thead>
              <tbody>${data.materials.map((mtl) => `<tr>
                <td>${UI.esc(mtl.name)}<div class="muted mono">${UI.esc(mtl.sku || '')}</div></td>
                <td class="right">${(+mtl.total_qty).toLocaleString()} ${UI.esc(mtl.unit || '')}</td>
                <td class="right">${UI.money(mtl.unit_cost)}</td>
                <td class="right">${UI.money(mtl.line_cost)}</td>
              </tr>`).join('')}</tbody>
              <tfoot><tr><th colspan="3" class="right">Total material cost</th><th class="right">${UI.money(data.material_cost)}</th></tr></tfoot>
            </table>`;
          };
          drawExplode(explodeRes);
          let t;
          exQ.oninput = () => {
            clearTimeout(t);
            t = setTimeout(async () => {
              const q = Math.max(1, parseInt(exQ.value, 10) || 1);
              try { drawExplode(await API.get('/finished-products/' + id + '/explode?qty=' + q)); }
              catch (e) { UI.toast(e.message, 'error'); }
            }, 250);
          };
        }
      },
    });
  }

  // ---- QR label printing ----
  async function ensureQr() {
    if (window.qrcode) return;
    await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/mobile/vendor/qrcode.js';
      s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  /** Build one printable label (QR + human-readable block). `code` is what the QR encodes. */
  function labelHTML(product, code, sub) {
    const qr = window.qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    return `<div class="lbl">
      <img class="lbl-qr" src="${qr.createDataURL(6, 0)}" alt="" />
      <div class="lbl-txt">
        <div class="lbl-name">${UI.esc(product.name)}</div>
        <div class="lbl-sku">${UI.esc(product.sku || '')}</div>
        <div class="lbl-code">${UI.esc(code)}</div>
        ${sub ? `<div class="lbl-sub">${UI.esc(sub)}</div>` : ''}
      </div>
    </div>`;
  }

  function printLabelsModal(product, pickedUnits, bulkAvail) {
    UI.modal({
      title: 'Print QR labels — ' + product.name,
      bodyHTML: `
        <p class="muted" style="margin-top:0">${pickedUnits.length
          ? `${pickedUnits.length} unit${pickedUnits.length === 1 ? '' : 's'} selected — one label per unit (its identifier).`
          : 'No units ticked. Print a batch of labels using the product SKU as the code.'}</p>
        <div class="field-row">
          <div><label>Copies per label</label><input data-f="copies" type="number" min="1" value="1" /></div>
          ${pickedUnits.length ? '' : `<div><label>How many labels</label><input data-f="batch" type="number" min="1" value="${Math.max(1, bulkAvail || 10)}" /></div>`}
        </div>`,
      confirmText: 'Open print sheet',
      onConfirm: async (ov, showErr) => {
        const copies = Math.max(1, parseInt(ov.querySelector('[data-f="copies"]').value, 10) || 1);
        if (!product.sku && !pickedUnits.length) { showErr('This product has no SKU — tick units with identifiers instead'); return false; }
        await ensureQr();
        if (!window.qrcode) { showErr('QR generator failed to load'); return false; }

        const cells = [];
        const push = (code, sub) => { for (let i = 0; i < copies; i++) cells.push(labelHTML(product, code, sub)); };
        if (pickedUnits.length) {
          pickedUnits.forEach((u) => push(u.ident, 'Unit #' + u.id));
        } else {
          const n = Math.max(1, parseInt(ov.querySelector('[data-f="batch"]').value, 10) || 1);
          for (let i = 0; i < n; i++) push(product.sku, '');
        }

        const w = window.open('', '_blank');
        if (!w) { showErr('Allow pop-ups to open the print sheet'); return false; }
        w.document.write(`<!doctype html><html><head><title>${UI.esc(product.name)} labels</title>
          <style>
            *{box-sizing:border-box} body{margin:0;font-family:system-ui,Arial,sans-serif}
            .sheet{display:flex;flex-wrap:wrap;gap:4mm;padding:6mm}
            .lbl{width:52mm;height:30mm;border:1px solid #ddd;border-radius:2mm;display:flex;gap:2mm;padding:2mm;align-items:center;page-break-inside:avoid}
            .lbl-qr{width:26mm;height:26mm}
            .lbl-txt{overflow:hidden;font-size:9pt;line-height:1.2}
            .lbl-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .lbl-sku{color:#555}
            .lbl-code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;font-size:8pt}
            .lbl-sub{color:#888;font-size:7.5pt}
            @media print{.lbl{border-color:#999}}
          </style></head><body><div class="sheet">${cells.join('')}</div>
          <script>window.onload=function(){window.print()}<\/script></body></html>`);
        w.document.close();
        UI.toast(`${cells.length} label${cells.length === 1 ? '' : 's'} ready`);
      },
    });
  }

  // ---- Sell / move in-stock units against a sales order ----
  async function sellMoveModal(product, pickedUnits, bulkAvail, after) {
    const [orders, locs] = await Promise.all([
      API.get('/orders?type=sale').catch(() => []),
      API.get('/locations').catch(() => []),
    ]);
    UI.modal({
      title: 'Sell / move units — ' + product.name,
      bodyHTML: `
        <div class="field-row">
          <label class="check"><input type="radio" name="act" value="sell" checked/> Sell (remove from stock)</label>
          <label class="check"><input type="radio" name="act" value="move"/> Move to another location</label>
        </div>
        <p class="muted">${pickedUnits.length
          ? `${pickedUnits.length} unit${pickedUnits.length === 1 ? '' : 's'} selected.`
          : `No units ticked — enter a quantity of bulk/untracked units (${bulkAvail} available).`}</p>
        ${pickedUnits.length ? '' : `<div><label>Quantity</label><input data-f="qty" type="number" min="1" value="1" /></div>`}
        <div data-f="orderwrap"><label>Sales order</label>
          <select data-f="order"><option value="">— select —</option>
            ${orders.map((o) => `<option value="${o.id}">${UI.esc(o.number)}${o.customer_name ? ' · ' + UI.esc(o.customer_name) : ''}</option>`).join('')}
          </select></div>
        <div data-f="locwrap" style="display:none"><label>Destination location</label>
          <select data-f="loc"><option value="">— select —</option>
            ${locs.map((l) => `<option value="${l.id}">${UI.esc(l.name)}</option>`).join('')}
          </select></div>
        <div><label>Note (optional)</label><input data-f="note" /></div>`,
      confirmText: 'Apply',
      onOpen: (ov) => {
        const sync = () => {
          const act = ov.querySelector('input[name="act"]:checked').value;
          ov.querySelector('[data-f="locwrap"]').style.display = act === 'move' ? '' : 'none';
          ov.querySelector('[data-f="orderwrap"]').querySelector('label').textContent = act === 'move' ? 'Sales order (optional)' : 'Sales order';
        };
        ov.querySelectorAll('input[name="act"]').forEach((r) => r.onchange = sync);
        sync();
      },
      onConfirm: async (ov, showErr) => {
        const action = ov.querySelector('input[name="act"]:checked').value;
        const body = { action, reason: ov.querySelector('[data-f="note"]').value.trim() || null };
        if (pickedUnits.length) body.unit_ids = pickedUnits.map((u) => u.id);
        else {
          const q = parseInt(ov.querySelector('[data-f="qty"]').value, 10);
          if (!q || q < 1) { showErr('Enter a quantity'); return false; }
          body.quantity = q;
        }
        const orderId = ov.querySelector('[data-f="order"]').value;
        if (action === 'sell' && !orderId) { showErr('Pick the sales order'); return false; }
        if (orderId) body.order_id = Number(orderId);
        if (action === 'move') {
          const loc = ov.querySelector('[data-f="loc"]').value;
          if (!loc) { showErr('Pick a destination'); return false; }
          body.to_location_id = Number(loc);
        }
        const r = await API.post('/finished-products/' + product.id + '/units/allocate', body);
        UI.toast(`${r.affected} unit${r.affected === 1 ? '' : 's'} ${action === 'sell' ? 'sold' : 'moved'}`);
        after();
      },
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
  const qcBtn = view.querySelector('#fp-qc');
  if (qcBtn) qcBtn.onclick = () => checklistLibraryModal();

  await load();
});
