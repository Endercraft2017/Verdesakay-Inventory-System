/* Production → Finished Products: items built from a bill of materials (bom_components).
   filter.open = <product id> deep-links straight into that product's detail (used by
   Finished Goods to reuse this file's Sell / Move action instead of duplicating it). */
App.register('finished-products', async (view, filter) => {
  const canWrite = App.hasPermission('inventory.edit');
  const canConfigQc = App.hasPermission('qc.configure');
  const canAdjust = App.hasPermission('inventory.adjust');
  let list = [];
  let allItems = [];
  let checklists = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Finished Products</h2>
      <div class="grow"></div>
      ${canAdjust ? `<button class="btn secondary" id="fp-label">${UI.icon('printer') || UI.icon('edit')} Label design</button>` : ''}
      ${canConfigQc ? `<button class="btn secondary" id="fp-qc">${UI.icon('edit')} QC/QA Checklists</button>` : ''}
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
          <th>Product</th><th class="right">Components</th><th>QC checklist</th><th>QA checklist</th>
          <th class="right">Buildable now</th><th class="right">In stock</th><th></th>
        </tr></thead>
        <tbody>${list.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><strong>${UI.esc(p.name)}</strong><div class="muted mono">${UI.esc(p.sku || '—')}</div></td>
            <td class="right">${p.component_count}</td>
            <td>${p.qc_checklist_qc_name ? UI.esc(p.qc_checklist_qc_name) : '<span class="muted">Default</span>'}</td>
            <td>${p.qc_checklist_qa_name ? UI.esc(p.qc_checklist_qa_name) : '<span class="muted">Default</span>'}</td>
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
    let currentChecklistQaId = '';
    let currentChecklistQcId = '';
    let currentLabor = '';
    let currentOverhead = '';
    if (existing) {
      const full = await API.get('/finished-products/' + existing.id).catch(() => null);
      bom = (full && full.bom) || [];
      currentChecklistQaId = (full && full.qc_checklist_qa_id) || '';
      currentChecklistQcId = (full && full.qc_checklist_qc_id) || '';
      if (full && Number(full.std_labor_cost)) currentLabor = full.std_labor_cost;
      if (full && Number(full.std_overhead_cost)) currentOverhead = full.std_overhead_cost;
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
        <div style="flex:1"><label>Copy BOM from another product</label>
          <select data-f="copyfrom"><option value="">— none —</option>
            ${list.filter((p) => !existing || p.id !== existing.id)
              .map((p) => `<option value="${p.id}">${UI.esc(p.name)} (${p.component_count} parts)</option>`).join('')}
          </select></div>
        <button type="button" class="btn secondary" id="bom-copy">Copy</button>
      </div>` : '';

    const checklistOptions = (stage, currentId) => {
      const opts = checklists.filter((c) => Number(c.stage) === stage);
      return `<option value="">Use the default ${stage === 1 ? 'QC' : 'QA'} checklist</option>
        ${opts.map((c) => `<option value="${c.id}" ${String(c.id) === String(currentId) ? 'selected' : ''}>${UI.esc(c.name)}${c.is_default ? ' (default)' : ''}</option>`).join('')}`;
    };
    const checklistHTML = `
      <div class="field-row" style="margin-top:6px">
        <div><label>QC checklist</label><select data-f="checklist-qc">${checklistOptions(1, currentChecklistQcId)}</select></div>
        <div><label>QA checklist</label><select data-f="checklist-qa">${checklistOptions(2, currentChecklistQaId)}</select></div>
      </div>`;

    const costHTML = `
      <div class="form-field span2" style="margin-top:6px"><div class="field-label"><label>Standard costs per unit (optional)</label></div>
        <div class="field-row">
          <div><label class="muted" style="font-size:12px">Labor</label>
            <input data-f="labor" type="number" min="0" step="0.01" value="${currentLabor}" placeholder="0.00" /></div>
          <div><label class="muted" style="font-size:12px">Overhead</label>
            <input data-f="overhead" type="number" min="0" step="0.01" value="${currentOverhead}" placeholder="0.00" /></div>
        </div>
        <p class="muted" style="font-size:11px;margin:4px 0 0">Added on top of the rolled-up material cost when set — used for the standard unit cost and to value finished units into stock.</p>
      </div>`;

    UI.modal({
      title: existing ? `Bill of materials — ${existing.name}` : 'New finished product',
      helpTopic: 'finished-products',
      size: 'lg',
      bodyHTML: `
        ${pickerHTML}
        ${checklistHTML}
        ${costHTML}
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
        if (!components.length) {
          const ok = await UI.confirmDialog(
            'Save this product with no bill of materials? It can still be built — a job order for it just won\'t reserve or consume any parts until you add components.',
            'Save without BOM');
          if (!ok) return false;
        }
        const qc_checklist_qa_id = ov.querySelector('[data-f="checklist-qa"]').value || null;
        const qc_checklist_qc_id = ov.querySelector('[data-f="checklist-qc"]').value || null;
        const laborRaw = ov.querySelector('[data-f="labor"]').value.trim();
        const overheadRaw = ov.querySelector('[data-f="overhead"]').value.trim();
        await API.put('/finished-products/' + pid, {
          components, qc_checklist_qa_id, qc_checklist_qc_id,
          std_labor_cost: laborRaw === '' ? null : Number(laborRaw),
          std_overhead_cost: overheadRaw === '' ? null : Number(overheadRaw),
        });
        UI.toast(existing ? 'BOM saved' : 'Finished product created');
        load();
      },
    });
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

    const cost = costRes || {};
    const stdTotal = cost.unit_total_cost != null ? cost.unit_total_cost : cost.unit_material_cost;
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
          <div><span class="muted">Std. material / unit</span><div>${cost.unit_material_cost != null ? UI.money(cost.unit_material_cost) : '—'}</div></div>
          ${Number(cost.unit_labor_cost) ? `<div><span class="muted">Std. labor / unit</span><div>${UI.money(cost.unit_labor_cost)}</div></div>` : ''}
          ${Number(cost.unit_overhead_cost) ? `<div><span class="muted">Std. overhead / unit</span><div>${UI.money(cost.unit_overhead_cost)}</div></div>` : ''}
          <div><span class="muted">Std. unit cost</span><div><strong>${stdTotal != null ? UI.money(stdTotal) : '—'}</strong></div></div>
          <div><span class="muted">QC checklist</span><div>${p.qc_checklist_qc_name ? UI.esc(p.qc_checklist_qc_name) : 'Default'}</div></div>
          <div><span class="muted">QA checklist</span><div>${p.qc_checklist_qa_name ? UI.esc(p.qc_checklist_qa_name) : 'Default'}</div></div>
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
          <h4 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">In-stock units (passed QC/QA)</h4>
          <div class="grow"></div>
          ${canWrite ? `<button type="button" class="btn secondary small" id="fp-print">${UI.icon('printer') || ''} Print QR labels</button>
          <button type="button" class="btn secondary small" id="fp-sell">Sell / move…</button>` : ''}
        </div>
        ${units.length ? `<table>
          <thead><tr>${canWrite ? '<th style="width:26px"><input type="checkbox" id="fp-all"/></th>' : ''}<th>Identifier</th><th>From MO</th><th>Location</th><th>Passed</th><th></th></tr></thead>
          <tbody>
            ${serial.map((u) => `<tr>
              ${canWrite ? `<td><input type="checkbox" class="fp-u" value="${u.id}" data-ident="${UI.esc(u.identifier)}"/></td>` : ''}
              <td class="mono">${UI.esc(u.identifier)}</td>
              <td>${UI.esc(u.job_order_number || '—')}</td>
              <td>${UI.esc(u.location_name || '—')}</td>
              <td class="muted">${UI.esc((u.updated_at || '').slice(0, 10))}</td>
              <td><button type="button" class="btn secondary small" data-record="${u.id}">Record</button></td>
            </tr>`).join('')}
            ${bulk ? `<tr>${canWrite ? '<td></td>' : ''}<td class="muted">Bulk / no identifier</td><td>—</td><td>—</td><td class="right">${bulk}</td><td></td></tr>` : ''}
          </tbody>
        </table>` : '<div class="empty">No units on hand.</div>'}`,
      onOpen: (ov) => {
        ov.querySelectorAll('[data-record]').forEach((b) => b.onclick = () =>
          App.navigate('production-record', { unit: b.dataset.record }));
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

  // ---- QR label printing (uses the editable label templates via renderTemplate) ----
  async function ensureQr() {
    if (window.qrcode) return;
    await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/mobile/vendor/qrcode.js';
      s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  function qrDataUrl(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text || ''));
    qr.make();
    return qr.createDataURL(6, 0);
  }

  /** Context for the label templates. `product` is a finished-product row. */
  function labelContext(product, opts) {
    let attrs = {};
    try { attrs = typeof product.attributes === 'string' ? JSON.parse(product.attributes || '{}') : (product.attributes || {}); } catch (_) { attrs = {}; }
    const code = opts.code != null ? opts.code : '';
    return {
      product: { name: product.name, sku: product.sku || '', model: product.product_group || '', variant: attrs.spec || '' },
      code, sub: opts.sub || '', batch: opts.batch || {},
      qr_src: qrDataUrl(code || product.sku || product.name),
      date: new Date().toISOString().slice(0, 10),
    };
  }

  const LABEL_SHEET_CSS = `
    *{box-sizing:border-box} body{margin:0;font-family:system-ui,Arial,sans-serif}
    .sheet{display:flex;flex-wrap:wrap;gap:4mm;padding:6mm}
    .lbl{width:52mm;height:30mm;border:1px solid #ddd;border-radius:2mm;display:flex;gap:2mm;padding:2mm;align-items:center;page-break-inside:avoid;overflow:hidden}
    .lbl-qr{width:26mm;height:26mm;flex:none}
    .lbl-txt{overflow:hidden;font-size:9pt;line-height:1.2}
    .lbl-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .lbl-variant{color:#111;font-size:8.5pt}
    .lbl-model,.lbl-sku{color:#555;font-size:8pt}
    .lbl-code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;font-size:8pt}
    .lbl-sub{color:#888;font-size:7.5pt}
    @media print{.lbl{border-color:#999}}`;

  function openLabelSheet(title, cells, showErr) {
    const w = window.open('', '_blank');
    if (!w) { showErr && showErr('Allow pop-ups to open the print sheet'); return false; }
    w.document.write(`<!doctype html><html><head><title>${UI.esc(title)}</title><style>${LABEL_SHEET_CSS}</style></head>`
      + `<body><div class="sheet">${cells.join('')}</div><script>window.onload=function(){window.print()}<\/script></body></html>`);
    w.document.close();
    return true;
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
        if (!window.qrcode || !window.renderTemplate) { showErr('Label renderer failed to load'); return false; }
        const tpl = (await API.get('/production/label-templates').catch(() => ({}))).unit || '';

        const cells = [];
        const push = (ctx) => { for (let i = 0; i < copies; i++) cells.push(`<div class="lbl">${window.renderTemplate(tpl, ctx)}</div>`); };
        if (pickedUnits.length) {
          pickedUnits.forEach((u) => push(labelContext(product, { code: u.ident, sub: 'Unit #' + u.id })));
        } else {
          const n = Math.max(1, parseInt(ov.querySelector('[data-f="batch"]').value, 10) || 1);
          for (let i = 0; i < n; i++) push(labelContext(product, { code: product.sku, sub: '' }));
        }
        if (!openLabelSheet(product.name + ' labels', cells, showErr)) return false;
        UI.toast(`${cells.length} label${cells.length === 1 ? '' : 's'} ready`);
      },
    });
  }

  // ---- Label design editor (unit + batch templates, stored per workspace) ----
  async function labelDesignModal() {
    const t = await API.get('/production/label-templates').catch(() => null);
    if (!t) { UI.toast('Could not load label templates', 'error'); return; }
    UI.modal({
      title: 'Label design',
      size: 'lg',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Mustache-style HTML rendered inside each <code>.lbl</code> card. Variables:
          <code>{{product.name}}</code> <code>{{product.model}}</code> <code>{{product.variant}}</code>
          <code>{{code}}</code> <code>{{sub}}</code> <code>{{batch.number}}</code> <code>{{batch.identifier}}</code>
          <code>{{batch.qty}}</code> <code>{{qr_src}}</code> <code>{{date}}</code>,
          plus <code>{{#if …}}…{{/if}}</code>.</p>
        <label>Unit label</label>
        <textarea data-f="unit" rows="7" style="font-family:ui-monospace,monospace;font-size:12px">${UI.esc(t.unit || '')}</textarea>
        <label style="margin-top:10px">Batch label</label>
        <textarea data-f="batch" rows="7" style="font-family:ui-monospace,monospace;font-size:12px">${UI.esc(t.batch || '')}</textarea>
        <button type="button" class="btn secondary small" id="lbl-reset" style="margin-top:8px">Reset both to default</button>`,
      confirmText: 'Save',
      onOpen: (ov) => {
        ov.querySelector('#lbl-reset').onclick = () => {
          ov.querySelector('[data-f="unit"]').value = t.default_unit || '';
          ov.querySelector('[data-f="batch"]').value = t.default_batch || '';
        };
      },
      onConfirm: async (ov) => {
        await API.put('/production/label-templates', {
          unit: ov.querySelector('[data-f="unit"]').value,
          batch: ov.querySelector('[data-f="batch"]').value,
        });
        UI.toast('Label design saved');
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
  if (qcBtn) qcBtn.onclick = () => QCChecklists.open(load);
  const lblBtn = view.querySelector('#fp-label');
  if (lblBtn) lblBtn.onclick = () => labelDesignModal();

  await load();
  if (filter && filter.open) detailModal(Number(filter.open));
});
