/* Inventory: list, search, filter, create/edit, stock in/out, history, delete. */

/* ---------- ECOUNT-style Item form (data-driven from item-form-config.js) ---------- */
// Cached merged config (defaults overlaid with the admin's saved customization).
let _itemFormConfig = null;

/** Merge the admin's saved per-field overrides over ITEM_FORM_DEFAULTS (by key). */
function mergeFormConfig(saved) {
  const base = ITEM_FORM_DEFAULTS.map((f) => ({ ...f }));
  if (!Array.isArray(saved)) return base;
  const byKey = {};
  saved.forEach((s) => { if (s && s.key) byKey[s.key] = s; });
  return base.map((f) => {
    const s = byKey[f.key];
    if (!s) return f;
    return {
      ...f,
      visible: typeof s.visible === 'boolean' ? s.visible : f.visible,
      required: typeof s.required === 'boolean' ? s.required : f.required,
      default: (s.default !== undefined && s.default !== null && s.default !== '') ? s.default : f.default,
    };
  });
}

async function loadItemFormConfig(force) {
  if (_itemFormConfig && !force) return _itemFormConfig;
  let saved = null;
  try { saved = await API.get('/inventory/form-config'); } catch { /* use defaults */ }
  _itemFormConfig = mergeFormConfig(saved);
  return _itemFormConfig;
}

function itemDeptOptions(selected) {
  return '<option value="">— None —</option>' +
    App.getDepartments().map((d) =>
      `<option value="${d.id}" ${String(d.id) === String(selected) ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('');
}

/** Current value of a field for an item (or its default for a new item). */
function itemFieldValue(def, it) {
  if (!it) return def.default !== undefined ? def.default : (def.type === 'checkbox' ? false : '');
  if (def.core) {
    if (def.key === 'department_id') return it.department_id ?? '';
    if (def.key === 'quantity') return it.quantity ?? 0;
    if (def.key === 'min_quantity') return it.min_quantity ?? 0;
    return it[def.key] ?? '';
  }
  const attrs = (it.attributes && typeof it.attributes === 'object') ? it.attributes : {};
  if (Object.prototype.hasOwnProperty.call(attrs, def.key)) return attrs[def.key];
  return def.default !== undefined ? def.default : (def.type === 'checkbox' ? false : '');
}

const isChecked = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Render one labeled field row from its def + current value. */
function renderItemField(def, value, opts = {}) {
  const e = UI.esc;
  const v = value === null || value === undefined ? '' : value;
  const req = def.required ? ' <span class="req">*</span>' : '';
  const help = UI.helpIcon(def.help);
  const head = `<div class="field-label"><label>${e(def.label)}${req}</label>${help}</div>`;

  if (def.type === 'checkbox') {
    return `<div class="form-field span2 inline">
      <label class="check-opt"><input type="checkbox" data-key="${def.key}" ${isChecked(v) ? 'checked' : ''} /> ${e(def.label)}</label>${help}
    </div>`;
  }
  if (def.type === 'static') {
    return `<div class="form-field span2">${head}<div class="static-field muted">${e(def.placeholder || '—')}</div></div>`;
  }
  if (def.type === 'radio') {
    const opts2 = (def.options || []).map((o) =>
      `<label class="radio-opt"><input type="radio" name="f_${def.key}" value="${e(o)}" ${String(v) === String(o) ? 'checked' : ''} /> ${e(o)}</label>`).join('');
    return `<div class="form-field span2">${head}<div class="radio-row">${opts2}</div></div>`;
  }
  if (def.type === 'select' || def.type === 'department') {
    const inner = def.type === 'department'
      ? itemDeptOptions(v)
      : (def.options || []).map((o) => `<option value="${e(o)}" ${String(v) === String(o) ? 'selected' : ''}>${e(o)}</option>`).join('');
    return `<div class="form-field">${head}<select data-key="${def.key}">${inner}</select></div>`;
  }
  if (def.type === 'textarea') {
    return `<div class="form-field span2">${head}<textarea data-key="${def.key}" placeholder="${e(def.placeholder || '')}">${e(v)}</textarea></div>`;
  }
  if (def.type === 'search') {
    return `<div class="form-field">${head}<div class="search-box">${UI.icon('search', 16)}<input data-key="${def.key}" value="${e(v)}" placeholder="${e(def.placeholder || '')}" /></div></div>`;
  }

  // text | number | money | percent
  const numeric = def.type === 'number' || def.type === 'money' || def.type === 'percent';
  const step = def.type === 'money' ? ' step="0.01"' : (def.type === 'percent' ? ' step="0.01"' : '');
  const disabled = opts.disabled ? ' disabled' : '';
  const suffix = def.type === 'percent' ? '<span class="field-suffix">%</span>'
    : (def.suffix ? `<span class="field-suffix">${e(def.suffix)}</span>` : '');
  const input = `<input data-key="${def.key}" type="${numeric ? 'number' : 'text'}"${step}${disabled} value="${e(v)}" placeholder="${e(def.placeholder || '')}" />`;
  return `<div class="form-field">${head}<div class="field-with-suffix">${input}${suffix}</div></div>`;
}

/** Build the tabbed form body from the config for a given item (null = new). */
function renderItemFormBody(cfg, it) {
  const tabs = ITEM_FORM_TABS.filter((t) => cfg.some((f) => f.tab === t.id && f.visible));
  const bar = tabs.map((t, i) =>
    `<button type="button" class="form-tab ${i === 0 ? 'active' : ''}" data-formtab="${t.id}">${UI.esc(t.label)}</button>`).join('');
  const panels = tabs.map((t, i) => {
    const fields = cfg.filter((f) => f.tab === t.id && f.visible).map((f) => {
      const editLocked = it && f.key === 'quantity'; // quantity changes go through the adjust modal
      return renderItemField(f, itemFieldValue(f, it), { disabled: editLocked });
    }).join('');
    return `<div data-formpanel="${t.id}" class="form-panel ${i === 0 ? '' : 'hidden'}"><div class="form-grid">${fields}</div></div>`;
  }).join('');
  return `<div class="form-tabs">${bar}</div>${panels}`;
}

function wireItemFormTabs(overlay) {
  overlay.querySelectorAll('[data-formtab]').forEach((btn) => {
    btn.onclick = () => {
      overlay.querySelectorAll('[data-formtab]').forEach((b) => b.classList.toggle('active', b === btn));
      overlay.querySelectorAll('[data-formpanel]').forEach((p) =>
        p.classList.toggle('hidden', p.dataset.formpanel !== btn.dataset.formtab));
    };
  });
}

/** Read a field's current value from the open form. */
function readItemField(overlay, def) {
  if (def.type === 'radio') {
    const c = overlay.querySelector(`input[name="f_${def.key}"]:checked`);
    return c ? c.value : '';
  }
  if (def.type === 'checkbox') {
    const el = overlay.querySelector(`[data-key="${def.key}"]`);
    return !!(el && el.checked);
  }
  const el = overlay.querySelector(`[data-key="${def.key}"]`);
  return el ? el.value : '';
}

/** Collect core columns + attributes from the open form. */
function collectItemForm(overlay, cfg, it) {
  const core = {};
  const attributes = (it && it.attributes && typeof it.attributes === 'object') ? { ...it.attributes } : {};
  cfg.forEach((def) => {
    if (!def.visible || def.type === 'static') return;
    const val = readItemField(overlay, def);
    if (def.core) core[def.key] = val;
    else attributes[def.key] = val;
  });
  return { core, attributes };
}

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

  async function itemModal(it) {
    const cfg = await loadItemFormConfig();
    const canCustomize = App.isAdmin();
    const m = UI.modal({
      title: it ? 'Edit item' : 'New item',
      size: 'lg',
      headActionHTML: canCustomize ? `<button class="btn secondary small" id="item-option-btn">Option</button>` : '',
      bodyHTML: `<div id="item-form-host">${renderItemFormBody(_itemFormConfig, it)}</div>`,
      confirmText: it ? 'Save changes' : 'Create item',
      onOpen: (overlay) => {
        wireItemFormTabs(overlay);
        const opt = overlay.querySelector('#item-option-btn');
        if (opt) opt.addEventListener('click', () => openItemOptions(overlay, it));
      },
      onConfirm: async (overlay, showErr) => {
        // Required-field validation (visible fields only).
        for (const def of _itemFormConfig) {
          if (!def.visible || def.type === 'static' || !def.required) continue;
          const val = readItemField(overlay, def);
          if (val === '' || val === false || val === null || val === undefined) {
            showErr(`${def.label} is required`);
            const panelBtn = overlay.querySelector(`[data-formtab="${def.tab}"]`);
            if (panelBtn) panelBtn.click();
            return false;
          }
        }
        const { core, attributes } = collectItemForm(overlay, _itemFormConfig, it);
        const body = { ...core, attributes };
        if (it) {
          delete body.quantity; // stock changes go through the adjust modal
          await API.put('/inventory/' + it.id, body);
        } else {
          await API.post('/inventory', body);
        }
        UI.toast(it ? 'Item updated' : 'Item created');
        load();
        loadCategories();
      },
    });
    return m;
  }

  /** Re-render the open form body after the layout changed (Option saved). */
  function refreshItemFormBody(overlay, it) {
    const host = overlay.querySelector('#item-form-host');
    if (!host) return;
    host.innerHTML = renderItemFormBody(_itemFormConfig, it);
    wireItemFormTabs(overlay);
  }

  /** Admin "Option" panel: show/hide, required, default per field — saved app-wide. */
  function openItemOptions(formOverlay, it) {
    const tabs = ITEM_FORM_TABS.filter((t) => _itemFormConfig.some((f) => f.tab === t.id));
    const bar = tabs.map((t, i) => {
      const n = _itemFormConfig.filter((f) => f.tab === t.id).length;
      return `<button type="button" class="form-tab ${i === 0 ? 'active' : ''}" data-formtab="${t.id}">${UI.esc(t.label)} <span class="opt-count">${n}</span></button>`;
    }).join('');
    const panels = tabs.map((t, i) => {
      const cards = _itemFormConfig.filter((f) => f.tab === t.id).map((f) => `
        <div class="opt-row" data-optkey="${f.key}">
          <div class="opt-name">${UI.esc(f.label)} ${f.core ? '<span class="badge-pill muted">core</span>' : ''} ${UI.helpIcon(f.help)}</div>
          <div class="opt-controls">
            <label class="check-opt"><input type="checkbox" data-opt="visible" ${f.visible ? 'checked' : ''} /> Visible</label>
            <label class="check-opt"><input type="checkbox" data-opt="required" ${f.required ? 'checked' : ''} /> Required</label>
          </div>
          <input class="opt-default" data-opt="default" value="${UI.esc(f.default ?? '')}" placeholder="Default value" />
        </div>`).join('');
      return `<div data-formpanel="${t.id}" class="form-panel ${i === 0 ? '' : 'hidden'}"><div class="opt-grid">${cards}</div></div>`;
    }).join('');

    UI.modal({
      title: 'Form Options',
      size: 'lg',
      headActionHTML: `<button class="btn secondary small" id="opt-reset">Reset to defaults</button>`,
      bodyHTML: `<p class="muted" style="margin-top:0">Show or hide fields, mark them required, and set defaults. Saved for everyone.</p>
        <div class="form-tabs">${bar}</div>${panels}`,
      confirmText: 'Save layout',
      onOpen: (ov) => {
        wireItemFormTabs(ov);
        const reset = ov.querySelector('#opt-reset');
        reset.addEventListener('click', async () => {
          reset.disabled = true;
          try {
            const payload = ITEM_FORM_DEFAULTS.map((f) => ({
              key: f.key, visible: f.visible, required: f.required, default: f.default ?? null,
            }));
            await API.put('/inventory/form-config', payload);
            _itemFormConfig = mergeFormConfig(null);
            UI.toast('Form layout reset to defaults');
            refreshItemFormBody(formOverlay, it);
            ov.remove();
          } catch (e) { UI.toast(e.message, 'error'); reset.disabled = false; }
        });
      },
      onConfirm: async (ov) => {
        const newCfg = _itemFormConfig.map((f) => {
          const row = ov.querySelector(`[data-optkey="${f.key}"]`);
          if (!row) return f;
          const visible = row.querySelector('[data-opt="visible"]').checked;
          const required = row.querySelector('[data-opt="required"]').checked;
          const def = row.querySelector('[data-opt="default"]').value;
          return { ...f, visible, required, default: def === '' ? f.default : def };
        });
        const payload = newCfg.map((f) => ({
          key: f.key, visible: f.visible, required: f.required, default: f.default ?? null,
        }));
        await API.put('/inventory/form-config', payload);
        _itemFormConfig = newCfg;
        UI.toast('Form layout saved');
        refreshItemFormBody(formOverlay, it);
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

  await Promise.all([load(), loadCategories(), loadItemFormConfig()]);
});
