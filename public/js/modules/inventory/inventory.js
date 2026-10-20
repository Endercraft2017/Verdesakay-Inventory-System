/* Inventory: list, search, filter, create/edit, stock in/out, history, delete. */

/* ---------- ECOUNT-style Item form (data-driven from item-form-config.js) ---------- */
// Cached merged config (defaults overlaid with the admin's saved customization).
let _itemFormConfig = null;
let _itemFieldSequence = 0;

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

// Suppliers registry — cached module-wide, refreshed when an item form opens.
let _suppliers = [];
async function loadSuppliers(force) {
  if (_suppliers.length && !force) return _suppliers;
  try { _suppliers = await API.get('/suppliers'); } catch { _suppliers = []; }
  return _suppliers;
}
function itemSupplierOptions(selected) {
  return '<option value="">— None —</option>' +
    _suppliers.map((s) =>
      `<option value="${s.id}" ${String(s.id) === String(selected) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('');
}

// Locations registry — same caching pattern.
let _locations = [];
async function loadLocations(force) {
  if (_locations.length && !force) return _locations;
  try { _locations = await API.get('/locations'); } catch { _locations = []; }
  return _locations;
}
function locationOptions(selected, list) {
  return (list || _locations).map((l) =>
    `<option value="${l.id}" ${String(l.id) === String(selected) ? 'selected' : ''}>${UI.esc(l.path || l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
}

/** New items start at a root. Each extra level is revealed only when requested.
 * New child names are sent with the item so the server can save everything atomically. */
function wireStartingLocationPicker(overlay) {
  const host = overlay.querySelector('[data-start-location]');
  if (!host) return () => null;
  const roots = _locations.filter((l) => !l.parent_id);
  const root = host.querySelector('[data-root-location]');
  root.innerHTML = roots.map((l) => `<option value="${l.id}">${UI.esc(l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
  const defaultLoc = _locations.find((l) => l.is_default);
  let defaultRoot = defaultLoc;
  while (defaultRoot?.parent_id) defaultRoot = _locations.find((l) => l.id === defaultRoot.parent_id);
  if (defaultRoot) root.value = String(defaultRoot.id);
  const levels = host.querySelector('[data-location-levels]');
  const add = host.querySelector('[data-add-location-level]');
  const selection = () => {
    let locationId = Number(root.value) || null;
    const newLevels = [];
    let incomplete = false;
    for (const row of levels.querySelectorAll('[data-location-row]')) {
      const value = row.querySelector('select').value;
      if (!value) break;
      if (value === '__new__') {
        const name = row.querySelector('input').value.trim();
        if (!name) { incomplete = true; break; }
        newLevels.push(name);
      } else if (!newLevels.length) locationId = Number(value);
    }
    return { locationId, newLevels, incomplete };
  };
  const refresh = () => {
    const depth = 1 + levels.querySelectorAll('select').length;
    const last = [...levels.querySelectorAll('select')].at(-1);
    add.style.display = depth >= 5 ? 'none' : '';
    add.disabled = !root.value || !!(last && (!last.value || selection().incomplete));
  };
  root.onchange = () => { levels.innerHTML = ''; refresh(); };
  add.onclick = () => {
    const current = selection();
    const children = current.newLevels.length ? [] : _locations.filter((l) => l.parent_id === current.locationId);
    const level = 2 + levels.querySelectorAll('select').length;
    const wrap = document.createElement('div');
    wrap.className = 'form-field';
    wrap.dataset.locationRow = '';
    wrap.innerHTML = `<label>Level ${level} (optional)</label><select data-child-location>
      <option value="">Use level ${level - 1}</option>
      ${children.map((l) => `<option value="${l.id}">${UI.esc(l.name)}</option>`).join('')}
      <option value="__new__">+ Create new sublocation…</option></select>
      <input data-new-location maxlength="120" placeholder="Name for level ${level}" style="display:none;margin-top:8px" />`;
    levels.appendChild(wrap);
    const select = wrap.querySelector('select');
    const name = wrap.querySelector('input');
    select.onchange = () => {
      while (wrap.nextElementSibling) wrap.nextElementSibling.remove();
      name.style.display = select.value === '__new__' ? '' : 'none';
      if (select.value === '__new__') name.focus();
      refresh();
    };
    name.oninput = refresh;
    refresh();
  };
  refresh();
  return selection;
}

/** Current value of a field for an item (or its default for a new item). */
function itemFieldValue(def, it) {
  if (!it) return def.default !== undefined ? def.default : (def.type === 'checkbox' ? false : '');
  if (def.core) {
    if (def.key === 'department_id') return it.department_id ?? '';
    if (def.key === 'quantity') return it.quantity ?? 0;
    if (def.key === 'min_quantity') return it.min_quantity ?? 0;
    if (def.key === 'unit_cost') return it.unit_cost ?? 0;
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
  const fieldId = `item-field-${++_itemFieldSequence}`;
  const head = `<div class="field-label"><label for="${fieldId}">${e(def.label)}${req}</label>${help}</div>`;

  if (def.type === 'checkbox') {
    return `<div class="form-field inline">
      <label class="check-opt"><input type="checkbox" id="${fieldId}" data-key="${def.key}" ${isChecked(v) ? 'checked' : ''} /> ${e(def.label)}</label>${help}
    </div>`;
  }
  if (def.type === 'static') {
    return `<div class="form-field span2">${head}<div class="static-field muted">${e(def.placeholder || '—')}</div></div>`;
  }
  // radio is rendered as a compact dropdown too — a single pick from a short list
  // doesn't need a full row of dots.
  if (def.type === 'select' || def.type === 'department' || def.type === 'supplier' || def.type === 'radio') {
    const inner = def.type === 'department'
      ? itemDeptOptions(v)
      : def.type === 'supplier'
        ? itemSupplierOptions(v)
        : (def.options || []).map((o) => `<option value="${e(o)}" ${String(v) === String(o) ? 'selected' : ''}>${e(o)}</option>`).join('');
    return `<div class="form-field">${head}<select id="${fieldId}" data-key="${def.key}">${inner}</select></div>`;
  }
  if (def.type === 'textarea') {
    return `<div class="form-field span2">${head}<textarea id="${fieldId}" data-key="${def.key}" placeholder="${e(def.placeholder || '')}">${e(v)}</textarea></div>`;
  }
  if (def.type === 'search') {
    return `<div class="form-field">${head}<div class="search-box">${UI.icon('search', 16)}<input id="${fieldId}" data-key="${def.key}" value="${e(v)}" placeholder="${e(def.placeholder || '')}" /></div></div>`;
  }
  if (def.type === 'combobox') {
    return `<div class="form-field">${head}
      <div class="combobox" data-combo-src="${e(def.source || '')}">
        <input id="${fieldId}" data-key="${def.key}" value="${e(v)}" autocomplete="off" placeholder="${e(def.placeholder || 'Type to search…')}" />
        <div class="combo-list hidden"></div>
      </div></div>`;
  }
  if (def.type === 'image') {
    return `<div class="form-field span2">${head}
      <div class="image-field" data-image>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
        <div class="image-actions">
          <button type="button" class="btn secondary small" data-img-pick>Choose image</button>
          <button type="button" class="btn secondary small" data-img-remove hidden>Remove</button>
          <span class="muted" style="font-size:11px">${e(def.placeholder || '')}</span>
        </div>
        <div class="image-preview" hidden></div>
      </div></div>`;
  }

  // text | number | money | percent
  const numeric = def.type === 'number' || def.type === 'money' || def.type === 'percent';
  const step = def.type === 'money' ? ' step="0.01"' : (def.type === 'percent' ? ' step="0.01"' : '');
  const disabled = opts.disabled ? ' disabled' : '';
  const suffix = def.type === 'percent' ? '<span class="field-suffix">%</span>'
    : (def.suffix ? `<span class="field-suffix">${e(def.suffix)}</span>` : '');
  const input = `<input id="${fieldId}" data-key="${def.key}" type="${numeric ? 'number' : 'text'}"${step}${disabled} value="${e(v)}" placeholder="${e(def.placeholder || '')}" />`;
  return `<div class="form-field">${head}<div class="field-with-suffix">${input}${suffix}</div></div>`;
}

/** Build the tabbed form body from the config for a given item (null = new). */
function renderItemFormBody(cfg, it) {
  // The location picker is essential even if an administrator hides every optional
  // stock field in Form Options.
  const tabs = ITEM_FORM_TABS.filter((t) => t.id === 'qty' || cfg.some((f) => f.tab === t.id && f.visible));
  const bar = tabs.map((t, i) =>
    `<button type="button" class="form-tab ${i === 0 ? 'active' : ''}" data-formtab="${t.id}">${UI.esc(t.label)}</button>`).join('');
  const panels = tabs.map((t, i) => {
    const fields = cfg.filter((f) => f.tab === t.id && f.visible).map((f) => {
      const editLocked = it && it.id && f.key === 'quantity'; // quantity changes go through the adjust modal
      const display = f.key === 'quantity' && editLocked ? { ...f, label: 'Current stock (read only)' } : f;
      return renderItemField(display, itemFieldValue(f, it), { disabled: editLocked });
    }).join('');
    const intro = {
      default: 'Identify and classify this item. Only the item name is required.',
      price: 'Defaults used when buying, selling and valuing this item. Order prices can still be changed on an individual order.',
      qty: it && it.id ? 'Current stock is changed through Stock in/out or Transfer stock. Set where this item is usually stored below.' : 'Enter opening stock only when creating an item. Choose a starting location; extra sublocation levels are optional.',
      info: 'Optional barcode, photo and internal notes.',
    }[t.id];
    const location = t.id !== 'qty' ? '' : (it && it.id ? `
      <div class="form-field span2" data-preferred-wrap><label for="item-preferred-location">Preferred storage location</label>
        <select id="item-preferred-location" data-preferred-location><option value="">No preference</option>${locationOptions(it.preferred_location_id, _locations)}</select>
        <p class="muted item-field-hint">Changing this preference does not move existing stock. Use Transfer stock for that.</p></div>` : `
      <div class="form-field span2" data-start-location>
        <label for="item-root-location">Starting-stock location <span class="req">*</span></label>
        <select id="item-root-location" data-root-location></select><div data-location-levels></div>
        <button type="button" class="btn secondary small item-add-location" data-add-location-level>+ Add sublocation level</button>
        <p class="muted item-field-hint">Stock goes to the last selected level. Add up to four optional levels.</p>
      </div>`);
    return `<div data-formpanel="${t.id}" class="form-panel ${i === 0 ? '' : 'hidden'}">${intro ? `<p class="muted item-tab-intro">${intro}</p>` : ''}<div class="form-grid">${fields}${location}</div></div>`;
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

/** Named option sources for `combobox` fields. */
const COMBO_SOURCES = {
  currencies: () => (typeof CURRENCIES !== 'undefined' ? CURRENCIES : [])
    .map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })),
};

/** Wire every combobox in the open form: type to filter, click a row to pick. */
function wireItemComboboxes(root) {
  root.querySelectorAll('.combobox').forEach((box) => {
    const input = box.querySelector('input[data-key]');
    const list = box.querySelector('.combo-list');
    const opts = (COMBO_SOURCES[box.dataset.comboSrc] || (() => []))();

    const render = (filter) => {
      const q = (filter || '').trim().toLowerCase();
      const hits = (q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts).slice(0, 60);
      list.innerHTML = hits.length
        ? hits.map((o) => `<div class="combo-opt" data-val="${UI.esc(o.value)}">${UI.esc(o.label)}</div>`).join('')
        : '<div class="combo-opt muted">No match</div>';
    };
    input.addEventListener('focus', () => { render(input.value); list.classList.remove('hidden'); });
    input.addEventListener('input', () => { render(input.value); list.classList.remove('hidden'); });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
    list.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.combo-opt[data-val]');
      if (!opt) return;
      input.value = opt.dataset.val;
      list.classList.add('hidden');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

/** Wire the item image widget. Returns a state obj read by the modal's onConfirm. */
function wireItemImageField(root, it) {
  const wrap = root.querySelector('[data-image]');
  if (!wrap) return null;
  const preview = wrap.querySelector('.image-preview');
  const fileInput = wrap.querySelector('input[type="file"]');
  const pickBtn = wrap.querySelector('[data-img-pick]');
  const removeBtn = wrap.querySelector('[data-img-remove]');
  const st = { file: null, remove: false, objUrl: null };

  const showImg = (src) => {
    preview.innerHTML = `<img alt="" src="${src}" />`;
    preview.hidden = false;
    removeBtn.hidden = false;
  };
  const showEmpty = () => {
    if (st.objUrl) { URL.revokeObjectURL(st.objUrl); st.objUrl = null; }
    preview.innerHTML = '';
    preview.hidden = true;
    removeBtn.hidden = true;
  };

  if (it && it.image_path) {
    API.blobUrl(`/inventory/${it.id}/image`).then((u) => { st.objUrl = u; showImg(u); }).catch(() => {});
    removeBtn.hidden = false;
  }
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { UI.toast('Image is larger than 5 MB', 'error'); fileInput.value = ''; return; }
    if (st.objUrl) URL.revokeObjectURL(st.objUrl);
    st.file = f; st.remove = false; st.objUrl = URL.createObjectURL(f);
    showImg(st.objUrl);
  };
  removeBtn.onclick = () => { st.file = null; st.remove = !!(it && it.image_path); fileInput.value = ''; showEmpty(); };
  return st;
}

/** Read a field's current value from the open form. */
function readItemField(overlay, def) {
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
    if (!def.visible || def.type === 'static' || def.type === 'image') return;
    const val = readItemField(overlay, def);
    if (def.core) core[def.key] = val;
    else attributes[def.key] = val;
  });
  return { core, attributes };
}

App.register('inventory', async (view, filter) => {
  const state = { q: '', department_id: '', supplier_id: '', location_id: '', category: '', kind: filter?.kind || 'parts', low: !!(filter && filter.low), include_damaged: false };
  let lastItems = [];
  let requestVersion = 0;
  let searchTimer;

  function deptOptions(selected) {
    return '<option value="">— Department —</option>' +
      App.getDepartments().map((d) =>
        `<option value="${d.id}" ${String(d.id) === String(selected) ? 'selected' : ''}>${UI.esc(d.name)}</option>`).join('');
  }

  view.innerHTML = `
    <div class="topbar">
      <h2 id="inv-title">Parts &amp; supplies</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="inv-search" aria-label="Search inventory" placeholder="Search name, SKU, spec, location…" /></div>
      <select id="inv-cat" aria-label="Category" style="width:150px"><option value="">— Category —</option></select>
      <select id="inv-dept" aria-label="Department" style="width:160px">${deptOptions('')}</select>
      <select id="inv-supplier" aria-label="Supplier" style="width:150px"><option value="">— Supplier —</option></select>
      <select id="inv-location" aria-label="Location" style="width:150px"><option value="">— Location —</option></select>
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:500;white-space:nowrap;">
        <input type="checkbox" id="inv-low" style="width:auto" ${state.low ? 'checked' : ''} /> Low stock</label>
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:500;white-space:nowrap;" title="Show damaged-stock records (hidden by default)">
        <input type="checkbox" id="inv-damaged" style="width:auto" ${state.include_damaged ? 'checked' : ''} /> Show damaged</label>
      <button class="btn secondary" id="inv-import" ${App.hasPermission('inventory.create') ? '' : 'hidden'} title="Create or update items from a CSV file">${UI.icon('upload')} Import</button>
      <button class="btn secondary" id="inv-export" title="Export current list to CSV">${UI.icon('download')} Export</button>
      <button class="btn secondary" id="inv-labels" title="Print barcode labels for the current list">${UI.icon('printer')} Labels</button>
      ${App.hasPermission('purchasing.manage') ? `<button class="btn secondary" id="inv-reorder" title="Draft purchase orders to restock everything below its reorder level">${UI.icon('inbox')} Reorder PO</button>` : ''}
      <button class="btn" id="inv-add" ${App.hasPermission('inventory.create') && state.kind !== 'finished' ? '' : 'hidden'}>${UI.icon('plus')} New item</button>
      <span class="muted inventory-result-count" id="inv-count" role="status"></span>
      <button class="btn secondary small" id="inv-clear">Clear filters</button>
    </div>
    <div class="item-kind-tabs" role="group" aria-label="Inventory item type">
      <button type="button" data-kind="parts">Parts &amp; supplies</button>
      <button type="button" data-kind="finished">Finished products</button>
      <button type="button" data-kind="all">All stock items</button>
    </div>
    <p class="muted item-kind-description" id="inv-kind-description"></p>
    <div class="panel"><div id="inv-table"></div></div>`;

  const tableEl = view.querySelector('#inv-table');

  function showKind() {
    const labels = { parts: 'Parts & supplies', finished: 'Finished products', all: 'All stock items' };
    const descriptions = {
      parts: 'Loose parts, materials and supplies. Finished products have their own view.',
      finished: 'Finished-product stock uses the same item record and SKU as its BOM. Production manages the build and individual RTS units.',
      all: 'Combined catalog. Item type is shown beside each name so parts and finished products remain distinct.',
    };
    view.querySelector('#inv-title').textContent = labels[state.kind];
    view.querySelector('#inv-kind-description').textContent = descriptions[state.kind];
    view.querySelector('#inv-add').hidden = !App.hasPermission('inventory.create') || state.kind === 'finished';
    const reorder = view.querySelector('#inv-reorder');
    if (reorder) reorder.hidden = state.kind === 'finished';
    view.querySelectorAll('[data-kind]').forEach((button) => {
      const active = button.dataset.kind === state.kind;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  showKind();

  function fillSupplierFilter() {
    const sel = view.querySelector('#inv-supplier');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Supplier —</option>' +
      _suppliers.map((s) => `<option value="${s.id}" ${String(s.id) === String(state.supplier_id) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('');
  }

  function fillLocationFilter() {
    const sel = view.querySelector('#inv-location');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Location —</option>' +
      _locations.map((l) => `<option value="${l.id}" ${String(l.id) === String(state.location_id) ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('');
  }

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
    if (state.supplier_id) params.set('supplier_id', state.supplier_id);
    if (state.location_id) params.set('location_id', state.location_id);
    if (state.category) params.set('category', state.category);
    params.set('kind', state.kind);
    if (state.low) params.set('low', '1');
    if (state.include_damaged) params.set('include_damaged', '1');
    const version = ++requestVersion;
    lastItems = [];
    tableEl.setAttribute('aria-busy', 'true');
    view.querySelector('#inv-count').textContent = 'Loading…';
    tableEl.innerHTML = '<div class="empty" role="status">Loading…</div>';
    try {
      const items = await API.get('/inventory?' + params.toString());
      if (version !== requestVersion) return;
      lastItems = items;
      render(items);
      view.querySelector('#inv-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'} shown`;
    } catch (err) {
      if (version !== requestVersion) return;
      // Do not offer an export or label sheet from an older filter result.
      lastItems = [];
      view.querySelector('#inv-count').textContent = 'Could not load items';
      tableEl.innerHTML = `<div class="empty" role="alert">Could not load items. Your filters are unchanged.
        <button class="btn secondary small" data-retry>Try again</button></div>`;
      tableEl.querySelector('[data-retry]').onclick = load;
    } finally {
      if (version === requestVersion) tableEl.removeAttribute('aria-busy');
    }
  }

  function exportCsv() {
    if (!lastItems.length) { UI.toast('Nothing to export', 'error'); return; }
    const headers = ['Name', 'SKU', 'Category', 'Department', 'Supplier', 'Quantity', 'Unit', 'Min', 'Location'];
    const rows = lastItems.map((i) => [
      i.name, i.sku || '', i.category || '', i.department_name || '', i.supplier_name || '',
      i.quantity, i.unit || '', i.min_quantity, i.location || '',
    ]);
    UI.downloadCsv('inventory.csv', headers, rows);
  }

  function importCsv() {
    return UI.csvImportModal({
      title: 'Import items',
      importPath: '/inventory/import',
      exportPath: '/inventory/export',
      columnsHtml:
        'Columns: <code>name</code> (required), <code>sku</code>, <code>category</code>, ' +
        '<code>department</code>, <code>supplier</code>, <code>unit</code>, <code>min_quantity</code>, ' +
        '<code>quantity</code>, <code>location</code>, <code>notes</code>. ' +
        'Rows are matched to existing items by <strong>SKU</strong> — a match updates details ' +
        '(never quantity); no match creates the item, using <code>quantity</code> as its starting ' +
        'stock. <code>department</code> and <code>supplier</code> must already exist.',
      templateHeaders: ['name', 'sku', 'category', 'department', 'supplier', 'unit', 'min_quantity', 'quantity', 'location', 'notes'],
      templateRows: [
        ['Hex Bolt M8 x 40mm', 'HB-M8-40', 'Fasteners', 'Operations', 'Acme Supply', 'pcs', '100', '500', 'Rack A1', 'Zinc-plated'],
        ['Steel Plate 4x8 3mm', 'SP-4X8-3', 'Raw Material', 'Operations', 'Metro Steel', 'sheet', '5', '20', 'Yard', ''],
        ['Cutting Disc 4in', 'CD-4', 'Consumables', '', '', 'pcs', '24', '0', '', 'No opening stock yet — will receive later'],
      ],
      onDone: () => load(),
    });
  }

  /* ---------- Reorder-level purchase orders ---------- */
  // Drafts one PO per supplier for items at/under their reorder level. Respects the current
  // filters when the Low-stock filter is on (sends just those item ids); otherwise sweeps
  // every low item on the server.
  function reorderPoModal() {
    const scoped = state.low ? lastItems.filter((i) => i.low_stock && i.category !== 'Damage' && !i.is_finished_product) : [];
    const scopeNote = state.low
      ? `${scoped.length} low-stock item${scoped.length === 1 ? '' : 's'} in the current list.`
      : 'Every item at or below its reorder level (finished products are excluded — those are produced).';
    UI.modal({
      title: 'Draft reorder purchase orders',
      bodyHTML: `
        <p class="muted" style="margin-top:0">${scopeNote} One draft PO is created per preferred supplier; items with no supplier land on a single unassigned PO you can fix up in Purchasing.</p>
        <div class="field-row">
          <div><label>Restock up to</label>
            <select data-f="mult">
              <option value="1">1× reorder level</option>
              <option value="2" selected>2× reorder level</option>
              <option value="3">3× reorder level</option>
              <option value="4">4× reorder level</option>
            </select></div>
        </div>
        <p class="muted" style="font-size:12px">Order quantity per item = target − on hand, always at least 1. Unit price is prefilled from each item's standard cost.</p>`,
      confirmText: 'Create draft POs',
      onConfirm: async (ov, showErr) => {
        const mult = Number(ov.querySelector('[data-f="mult"]').value) || 2;
        const body = { multiplier: mult };
        if (state.low) {
          if (!scoped.length) { showErr('No low-stock items in the current list'); return false; }
          body.item_ids = scoped.map((i) => i.id);
        }
        let r;
        try { r = await API.post('/inventory/reorder-po', body); }
        catch (e) { showErr(e.message); return false; }
        if (!r.created || !r.created.length) { UI.toast(r.note || 'Nothing to reorder'); return; }
        const lines = r.created.reduce((s, c) => s + c.lines, 0);
        UI.toast(`${r.created.length} draft PO${r.created.length === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'}`, 'success');
        App.navigate('orders', { type: 'purchase' });
      },
    });
  }

  /* ---------- Barcode label printing (Code 128, dependency-free) ---------- */
  // What a label encodes: the item's own `attributes.barcode` if set, else its SKU.
  const labelCode = (i) => (i.attributes && String(i.attributes.barcode || '').trim()) || (i.sku || '').trim();

  const LABEL_SIZES = {
    small: { w: 38, h: 22, mod: 0.26, bh: 34, fs: 7 },
    medium: { w: 52, h: 30, mod: 0.33, bh: 48, fs: 8 },
    large: { w: 70, h: 38, mod: 0.42, bh: 60, fs: 9 },
  };

  /** Open a print-sheet window of Code 128 labels for `items`. */
  function printLabelSheet(items, opts) {
    opts = opts || {};
    if (!window.Barcode) { UI.toast('Barcode generator failed to load — reload the page', 'error'); return false; }
    const list = items.filter((i) => labelCode(i));
    if (!list.length) { UI.toast('No SKU or barcode to print', 'error'); return false; }
    const copies = Math.max(1, opts.copies || 1);
    const withName = opts.withName !== false;
    const sz = LABEL_SIZES[opts.size] || LABEL_SIZES.medium;

    const cells = [];
    list.forEach((i) => {
      const svg = window.Barcode.code128svg(labelCode(i), {
        height: sz.bh, moduleWidth: sz.mod, margin: 6, showText: true, textHeight: sz.fs + 4,
      });
      const cell = `<div class="lbl">${withName ? `<div class="lbl-name">${UI.esc(i.name)}</div>` : ''}<div class="lbl-bc">${svg}</div></div>`;
      for (let c = 0; c < copies; c++) cells.push(cell);
    });

    const w = window.open('', '_blank');
    if (!w) { UI.toast('Allow pop-ups to open the print sheet', 'error'); return false; }
    w.document.write(`<!doctype html><html><head><title>Barcode labels</title><style>
      *{box-sizing:border-box} body{margin:0;font-family:system-ui,Arial,sans-serif}
      .sheet{display:flex;flex-wrap:wrap;gap:3mm;padding:5mm}
      .lbl{width:${sz.w}mm;height:${sz.h}mm;border:1px solid #ddd;border-radius:1.5mm;padding:1.5mm;
           display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1mm;page-break-inside:avoid}
      .lbl-name{font-size:${sz.fs}pt;font-weight:700;text-align:center;line-height:1.1;
                max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .lbl-bc{width:100%;flex:1;display:flex;align-items:center;justify-content:center}
      .lbl-bc svg{max-width:100%;max-height:100%}
      @media print{.lbl{border-color:#999}}
    </style></head><body><div class="sheet">${cells.join('')}</div>
    </body></html>`);
    w.document.close();
    UI.printWhenLoaded(w);
    UI.toast(`${cells.length} label${cells.length === 1 ? '' : 's'} ready`);
    return true;
  }

  function barcodeLabelsModal() {
    const printable = lastItems.filter((i) => labelCode(i));
    const skipped = lastItems.length - printable.length;
    if (!printable.length) {
      UI.toast('No items in the list have a SKU or barcode to print', 'error');
      return;
    }
    UI.modal({
      title: 'Print barcode labels',
      helpTopic: 'barcode-labels',
      size: 'lg',
      bodyHTML: `
        <p class="muted" style="margin-top:0">${printable.length} item${printable.length === 1 ? '' : 's'} in the current list have a code.${skipped ? ` ${skipped} without a SKU/barcode will be skipped.` : ''} Each label is a Code 128 barcode that this system's scanner reads back.</p>
        <div class="field-row">
          <div><label>Label size</label><select data-f="size">
            <option value="small">Small — 38 × 22 mm</option>
            <option value="medium" selected>Medium — 52 × 30 mm</option>
            <option value="large">Large — 70 × 38 mm</option>
          </select></div>
          <div><label>Copies per item</label><input data-f="copies" type="number" min="1" value="1" style="width:90px" /></div>
          <div><label>Show name</label><select data-f="name"><option value="1" selected>Yes</option><option value="0">No</option></select></div>
        </div>
        <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Items <button type="button" class="btn secondary small" id="lbl-all" style="margin-left:8px">Toggle all</button></h4>
        <div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px">
          <table><tbody>${printable.map((i, n) => `
            <tr><td style="width:34px"><input type="checkbox" class="lbl-pick" value="${n}" checked /></td>
            <td>${UI.esc(i.name)}<div class="muted mono">${UI.esc(labelCode(i))}</div></td>
            <td class="right muted">${i.quantity} ${UI.esc(i.unit || '')}</td></tr>`).join('')}</tbody></table>
        </div>`,
      confirmText: 'Open print sheet',
      onOpen: (ov) => {
        ov.querySelector('#lbl-all').onclick = () => {
          const boxes = [...ov.querySelectorAll('.lbl-pick')];
          const target = !boxes.every((b) => b.checked);
          boxes.forEach((b) => { b.checked = target; });
        };
      },
      onConfirm: (ov, showErr) => {
        const picked = [...ov.querySelectorAll('.lbl-pick:checked')].map((b) => printable[Number(b.value)]);
        if (!picked.length) { showErr('Tick at least one item'); return false; }
        return printLabelSheet(picked, {
          copies: parseInt(ov.querySelector('[data-f="copies"]').value, 10) || 1,
          withName: ov.querySelector('[data-f="name"]').value === '1',
          size: ov.querySelector('[data-f="size"]').value,
        }) !== false;
      },
    });
  }

  /** Small "Office Chair · Red / Large" line under the item name — the product_group and
      the variant's own spec attribute together, so variants are distinguishable in the list
      without opening each one. Either half is optional; renders nothing if both are empty. */
  function groupLineHTML(it) {
    const spec = it.attributes && typeof it.attributes === 'object' ? it.attributes.spec : null;
    const parts = [it.product_group, spec].filter(Boolean);
    if (!parts.length) return '';
    return `<div class="muted" style="font-size:11px">${parts.map((p) => UI.esc(String(p))).join(' · ')}</div>`;
  }

  function render(items) {
    if (!items.length) {
      const fresh = !state.q && !state.department_id && !state.supplier_id && !state.location_id && !state.category && !state.low && !state.include_damaged;
      tableEl.innerHTML = UI.emptyState({
        icon: 'inventory',
        title: fresh ? (state.kind === 'finished' ? 'No finished products yet' : 'No items yet') : 'No matching items',
        hint: fresh ? (state.kind === 'finished' ? 'Create a finished product and BOM under Production → Finished Products.' : 'Add your first item to start tracking stock.') : 'Try a different search or filter.',
        action: fresh && state.kind !== 'finished' && App.hasPermission('inventory.create') ? `<button class="btn" id="inv-empty-add">${UI.icon('plus')} New item</button>` : '',
      });
      const ea = tableEl.querySelector('#inv-empty-add');
      if (ea) ea.onclick = () => itemModal(null);
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Item</th><th>Category</th><th>Department</th><th>Supplier</th><th>Location</th>
          <th class="right">Quantity</th><th></th>
        </tr></thead>
        <tbody>${items.map((i) => `
          <tr class="clickable" data-open="${i.id}">
            <td><strong>${UI.esc(i.name)}</strong><div class="muted mono">${UI.esc(i.sku || '—')}</div><span class="item-kind-badge">${i.is_finished_product ? 'Finished product' : 'Part / supply'}</span>${groupLineHTML(i)}</td>
            <td>${UI.esc(i.category || '—')}</td>
            <td>${UI.esc(i.department_name || '—')}</td>
            <td>${UI.esc(i.supplier_name || '—')}</td>
            <td>${UI.esc(i.location || '—')}</td>
            <td class="right">
              <span class="badge-pill ${i.low_stock ? 'low' : 'ok'}">${i.quantity} ${UI.esc(i.unit || '')}</span>
              ${i.low_stock ? `<div class="muted" style="font-size:11px">min ${i.min_quantity}</div>` : ''}
            </td>
            <td class="actions">
              <button class="icon-btn" title="Stock in/out" data-adjust="${i.id}">${UI.icon('adjust')}</button>
              <button class="icon-btn" title="Transfer between locations" data-transfer="${i.id}">${UI.icon('archive')}</button>
              <button class="icon-btn" title="History" data-history="${i.id}">${UI.icon('history')}</button>
              <button class="icon-btn" title="Edit" data-edit="${i.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-del="${i.id}">${UI.icon('trash')}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    [['data-adjust', 'inventory.adjust'], ['data-transfer', 'inventory.transfer'], ['data-edit', 'inventory.edit'], ['data-del', 'inventory.delete']].forEach(([attr, permission]) => {
      if (!App.hasPermission(permission)) tableEl.querySelectorAll('[' + attr + ']').forEach((button) => { button.hidden = true; });
    });
    tableEl.querySelectorAll('button[title]').forEach((button) => button.setAttribute('aria-label', button.title));

    tableEl.querySelectorAll('[data-adjust]').forEach((b) => b.onclick = () => adjustModal(b.dataset.adjust, items));
    tableEl.querySelectorAll('[data-transfer]').forEach((b) => b.onclick = () => transferModal(b.dataset.transfer, items));
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => itemModal(items.find((x) => x.id == b.dataset.edit)));
    tableEl.querySelectorAll('[data-history]').forEach((b) => b.onclick = () => historyModal(b.dataset.history));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(items.find((x) => x.id == b.dataset.del)));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      detailModal(items.find((x) => x.id == tr.dataset.open));
    });
  }

  /** Read-only "everything about this item" view. Editing is via the Edit button only. */
  async function detailModal(row) {
    let full = row;
    const canEdit = App.hasPermission('inventory.edit');
    const opts = {
      title: 'Item details',
      size: 'lg',
      bodyHTML: `<div id="idt-host"><div class="empty">Loading…</div></div>`,
      cancelText: 'Close',
      onOpen: async (overlay) => {
        try { full = await API.get('/inventory/' + row.id); } catch { full = row; }
        renderItemDetail(overlay.querySelector('#idt-host'), full);
      },
    };
    if (canEdit) {
      opts.confirmText = 'Edit item';
      opts.onConfirm = () => { itemModal(full); };
    }
    UI.modal(opts);
  }

  async function renderItemDetail(host, it) {
    const e = UI.esc;
    const cfg = (await loadItemFormConfig()) || ITEM_FORM_DEFAULTS;
    const labelOf = {};
    cfg.forEach((f) => { labelOf[f.key] = f.label; });
    const attrs = (it.attributes && typeof it.attributes === 'object') ? it.attributes : {};

    const rows = [];
    const push = (label, v) => {
      if (v !== '' && v !== null && v !== undefined) rows.push([label, String(v)]);
    };
    push('Spec.', attrs.spec);
    push('Category', it.category);
    push('Department', it.department_name);
    push('Supplier', it.supplier_name);
    push('Unit', it.unit);
    push('Preferred storage location', it.preferred_location_name);
    push('Legacy location note', it.location);
    push('Currency', attrs.currency);
    push('Purchase price', attrs.purchase_price);
    push('Sale price', attrs.sale_price);
    push('Vendor', attrs.vendor);
    push('Barcode', attrs.barcode);
    push('Manufacturer', attrs.manufacturer);
    push('Model No.', attrs.model_no);

    const shown = new Set(['spec', 'currency', 'purchase_price', 'sale_price', 'vendor', 'barcode', 'manufacturer', 'model_no']);
    const extra = Object.entries(attrs).filter(([k, v]) =>
      !shown.has(k) && v !== '' && v !== null && v !== undefined && typeof v !== 'object');

    const hist = Array.isArray(it.history) ? it.history : [];

    host.innerHTML = `
      <div class="item-detail">
        <div class="idt-head">
          ${it.image_path ? '<div class="idt-img" data-idt-img><div class="empty">…</div></div>' : ''}
          <div>
            <h3>${e(it.name)}</h3>
            <div class="muted mono">${e(it.sku || '—')}</div>
            <div style="margin-top:8px">
              <span class="badge-pill ${it.low_stock ? 'low' : 'ok'}">${it.quantity} ${e(it.unit || '')}</span>
              <span class="muted" style="font-size:12px;margin-left:6px">reorder at ${it.min_quantity}</span>
            </div>
            ${labelCode(it) && window.Barcode ? `<div style="margin-top:10px;display:flex;align-items:center;gap:10px">
              <div style="max-width:180px">${window.Barcode.code128svg(labelCode(it), { height: 42, moduleWidth: 1.4, margin: 4, textHeight: 13 })}</div>
              <button type="button" class="btn secondary small" data-idt-label>${UI.icon('printer', 14)} Print label</button>
            </div>` : ''}
          </div>
        </div>
        ${rows.length ? `<div class="kv">${rows.map(([l, v]) =>
          `<div><span class="muted">${e(l)}</span><div>${e(v)}</div></div>`).join('')}</div>` : ''}
        ${extra.length ? `<h4>Other details</h4><div class="kv">${extra.map(([k, v]) =>
          `<div><span class="muted">${e(labelOf[k] || k)}</span><div>${e(String(v))}</div></div>`).join('')}</div>` : ''}
        ${Array.isArray(it.stock) && it.stock.length ? `
          <h4>Stock by location</h4>
          <table>
            <thead><tr><th>Location</th><th>Type</th><th class="right">Qty</th></tr></thead>
            <tbody>${it.stock.map((s, idx) => `
              <tr>
                <td>${idx === 0 ? `<strong>${e(s.location_name)}</strong>` : e(s.location_name)}</td>
                <td style="text-transform:capitalize">${e(s.location_type)}</td>
                <td class="right">${idx === 0 ? `<strong>${s.quantity}</strong>` : s.quantity} ${e(it.unit || '')}</td>
              </tr>`).join('')}</tbody>
          </table>` : ''}
        ${it.notes ? `<h4>Notes</h4><p style="white-space:pre-wrap;margin:0">${e(it.notes)}</p>` : ''}
        ${hist.length ? `
          <h4>Recent movements</h4>
          <table>
            <thead><tr><th>When</th><th>Location</th><th class="right">Change</th><th class="right">Total</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>${hist.slice(0, 8).map((h) => `
              <tr>
                <td>${UI.fmtDate(h.created_at)}</td>
                <td>${e(h.location_name || '—')}</td>
                <td class="right"><strong style="color:${h.change < 0 ? 'var(--danger)' : 'var(--success)'}">${h.change > 0 ? '+' : ''}${h.change}</strong></td>
                <td class="right">${h.balance_after}</td>
                <td>${e(h.reason || '—')}</td>
                <td>${e(h.user_name || '—')}</td>
              </tr>`).join('')}</tbody>
          </table>` : ''}
      </div>`;

    if (it.image_path) {
      API.blobUrl('/inventory/' + it.id + '/image')
        .then((u) => {
          const el = host.querySelector('[data-idt-img]');
          if (el) el.innerHTML = `<img alt="" src="${u}" />`;
        })
        .catch(() => { const el = host.querySelector('[data-idt-img]'); if (el) el.remove(); });
    }

    const lblBtn = host.querySelector('[data-idt-label]');
    if (lblBtn) lblBtn.onclick = () => printLabelSheet([it], { copies: 1, withName: true, size: 'medium' });
  }

  // `it` is either a real, existing item (has .id -> edit mode) or, for a brand-new item,
  // either null or a *partial* prefill stub like {name: 'Typed but not in inventory yet'}
  // (used by orderModal()'s missing-product prompt) — anything without .id is create mode,
  // its fields just seed the New Item form instead of starting blank. `onCreated(item)` — UI.modal
  // has no return channel of its own, so this is how a caller finds out what got created.
  function itemModal(it, onCreated) {
    return UI.modalTask('inventory:item:' + ((it && it.id) || 'new'), () => openItemModal(it, onCreated));
  }
  async function openItemModal(it, onCreated) {
    const cfg = await loadItemFormConfig();
    await loadSuppliers(true); // pick list must be current when the form renders
    await loadLocations(true);
    const canCustomize = App.hasPermission('inventory.configure');
    const editing = !!(it && it.id);
    let imageState = null;
    let startingLocation = () => null;
    const m = UI.modal({
      title: editing ? 'Edit item' : 'New item',
      protectChanges: true,
      helpTopic: 'new-item',
      size: 'lg',
      headActionHTML: canCustomize ? `<button class="btn secondary small" id="item-option-btn">Option</button>` : '',
      bodyHTML: `<div id="item-form-host">${renderItemFormBody(_itemFormConfig, it)}</div>`,
      confirmText: editing ? 'Save changes' : 'Create item',
      onOpen: (overlay) => {
        wireItemFormTabs(overlay);
        wireItemComboboxes(overlay);
        imageState = wireItemImageField(overlay, it);
        startingLocation = wireStartingLocationPicker(overlay);
        const opt = overlay.querySelector('#item-option-btn');
        if (opt) opt.addEventListener('click', () => openItemOptions(overlay, it, () => {
          refreshItemFormBody(overlay, it);
          startingLocation = wireStartingLocationPicker(overlay);
        }));
      },
      onConfirm: async (overlay, showErr) => {
        // Required-field validation (visible fields only).
        for (const def of _itemFormConfig) {
          if (!def.visible || def.type === 'static' || def.type === 'image' || !def.required) continue;
          const val = readItemField(overlay, def);
          if (val === false || val === null || val === undefined || String(val).trim() === '') {
            showErr(`${def.label} is required`);
            const panelBtn = overlay.querySelector(`[data-formtab="${def.tab}"]`);
            if (panelBtn) panelBtn.click();
            const field = overlay.querySelector(`[data-key="${def.key}"]`);
            if (field) {
              field.setAttribute('aria-invalid', 'true');
              field.setAttribute('aria-describedby', overlay.querySelector('[data-modal-error]').id);
              field.focus();
              field.addEventListener('input', () => {
                field.removeAttribute('aria-invalid');
                field.removeAttribute('aria-describedby');
              }, { once: true });
            }
            return false;
          }
        }
        const { core, attributes } = collectItemForm(overlay, _itemFormConfig, it);
        const body = { ...core, attributes };
        if (!App.hasPermission('inventory.costs')) delete body.unit_cost;
        if (!editing) {
          const choice = startingLocation();
          if (!choice?.locationId) { overlay.querySelector('[data-formtab="qty"]')?.click(); showErr('Create a stock location before adding an item'); return false; }
          if (choice.incomplete) { overlay.querySelector('[data-formtab="qty"]')?.click(); showErr('Enter a name for each new sublocation'); return false; }
          body.location_id = choice.locationId;
          body.new_location_levels = choice.newLevels;
        } else body.preferred_location_id = Number(overlay.querySelector('[data-preferred-location]').value) || null;
        let id;
        if (editing) {
          delete body.quantity; // stock changes go through the adjust modal
          await API.put('/inventory/' + it.id, body);
          id = it.id;
        } else {
          id = (await API.post('/inventory', body)).id;
        }
        // Item photo: upload a staged file, or clear an existing one.
        if (imageState && imageState.file) {
          const fd = new FormData();
          fd.append('image', imageState.file);
          try { await API.upload('/inventory/' + id + '/image', fd); }
          catch (err) { UI.toast('Item saved, but image upload failed: ' + err.message, 'error'); }
        } else if (imageState && imageState.remove) {
          try { await API.del('/inventory/' + id + '/image'); } catch { /* already gone */ }
        }
        UI.toast(editing ? 'Item updated' : 'Item created');
        load();
        loadCategories();
        if (!editing && onCreated) onCreated({ id, ...body });
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
    wireItemComboboxes(overlay);
    wireItemImageField(overlay, it);
  }

  /** Admin "Option" panel: show/hide, required, default per field — saved app-wide. */
  function openItemOptions(formOverlay, it, refreshForm) {
    const tabs = ITEM_FORM_TABS.filter((t) => _itemFormConfig.some((f) => f.tab === t.id));
    const bar = tabs.map((t, i) => {
      const n = _itemFormConfig.filter((f) => f.tab === t.id).length;
      return `<button type="button" class="form-tab ${i === 0 ? 'active' : ''}" data-formtab="${t.id}">${UI.esc(t.label)} <span class="opt-count">${n}</span></button>`;
    }).join('');
    const optCard = (f) => `
      <div class="opt-row" data-optkey="${f.key}">
        <div class="opt-name">${UI.esc(f.label)} ${f.core ? '<span class="badge-pill muted">core</span>' : ''} ${UI.helpIcon(f.help)}</div>
        <div class="opt-controls">
          <label class="check-opt"><input type="checkbox" data-opt="visible" ${f.visible ? 'checked' : ''} /> Visible</label>
          <label class="check-opt"><input type="checkbox" data-opt="required" ${f.required ? 'checked' : ''} /> Required</label>
        </div>
        <input class="opt-default" data-opt="default" value="${UI.esc(f.default ?? '')}" placeholder="Default value" />
      </div>`;

    const panels = tabs.map((t, i) => {
      const tabFields = _itemFormConfig.filter((f) => f.tab === t.id);
      // Group the tab's fields under capability-section headings (ITEM_FORM_SECTIONS order),
      // so an admin can enable a whole capability (e.g. "Standard costing") at once.
      const groups = ITEM_FORM_SECTIONS
        .filter((s) => tabFields.some((f) => f.section === s.id))
        .map((s) => {
          const group = tabFields.filter((f) => f.section === s.id);
          const on = group.filter((f) => f.visible).length;
          return `<div class="opt-section">${UI.esc(s.label)}<span class="opt-count">${on}/${group.length}</span></div>` +
            group.map(optCard).join('');
        }).join('');
      const orphans = tabFields.filter((f) => !ITEM_FORM_SECTIONS.some((s) => s.id === f.section));
      const orphanBlock = orphans.length
        ? `<div class="opt-section">Other</div>${orphans.map(optCard).join('')}`
        : '';
      return `<div data-formpanel="${t.id}" class="form-panel ${i === 0 ? '' : 'hidden'}"><div class="opt-grid">${groups}${orphanBlock}</div></div>`;
    }).join('');

    UI.modal({
      title: 'Form Options',
      protectChanges: true,
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
            refreshForm();
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
        refreshForm();
      },
    });
  }

  function adjustModal(id, items) {
    return UI.modalTask('inventory:adjust:' + id, () => openAdjustModal(id, items));
  }
  async function openAdjustModal(id, items) {
    const it = items.find((x) => x.id == id);
    const breakdown = await API.get(`/inventory/${id}/stock`).catch(() => []);
    const rows = breakdown.map((b) => ({ id: b.location_id, name: b.location_name, is_default: b.is_default }));
    const qtyAt = (locId, mode = 'assembled') => (breakdown.find((b) => String(b.location_id) === String(locId)) || {})[mode === 'semi_built' ? 'semi_built_quantity' : 'assembled_quantity'] || 0;
    const top = [...breakdown].filter((b) => b.quantity > 0).sort((a, b) => b.quantity - a.quantity)[0];
    const initial = (top || breakdown.find((b) => b.is_default) || breakdown[0] || {}).location_id;

    return UI.modal({
      title: `Adjust stock — ${it.name}`,
      bodyHTML: `
        <p class="muted">Total on hand: <strong>${it.quantity} ${UI.esc(it.unit || '')}</strong></p>
        <div class="field-row">
          <div><label>Location</label><select data-f="loc">${locationOptions(initial, rows)}</select></div>
          <div><label>Action</label><select data-f="dir">
            <option value="in">Stock IN (＋)</option><option value="out">Stock OUT (−)</option></select></div>
        </div>
        ${it.is_finished_product ? '<div><label>Product build state</label><select data-f="mode"><option value="assembled">Fully built</option><option value="semi_built">Semi-built package</option></select></div>' : ''}
        <div class="field-row">
          <div><label>Amount</label><input data-f="amount" type="number" min="1" value="1" /></div>
          <div><label>Reason / reference</label><input data-f="reason" placeholder="e.g. Purchase, Released to Dept" /></div>
        </div>
        <p class="muted" data-at style="margin-bottom:0">At this location: <strong>${qtyAt(initial)}</strong></p>`,
      confirmText: 'Apply',
      onOpen: (overlay) => {
        const sel = overlay.querySelector('[data-f="loc"]');
        const mode = overlay.querySelector('[data-f="mode"]');
        const at = overlay.querySelector('[data-at] strong');
        const refreshQty = () => { at.textContent = qtyAt(sel.value, mode?.value || 'assembled'); };
        sel.addEventListener('change', refreshQty); mode?.addEventListener('change', refreshQty);
      },
      onConfirm: async (overlay, showErr) => {
        const location_id = overlay.querySelector('[data-f="loc"]').value;
        const dir = overlay.querySelector('[data-f="dir"]').value;
        const amount = parseInt(overlay.querySelector('[data-f="amount"]').value, 10);
        const reason = overlay.querySelector('[data-f="reason"]').value;
        const build_mode = overlay.querySelector('[data-f="mode"]')?.value || 'assembled';
        if (!location_id) { showErr('Pick a location'); return false; }
        if (!amount || amount <= 0) { showErr('Enter a positive amount'); return false; }
        const change = dir === 'out' ? -amount : amount;
        const r = await API.post(`/inventory/${id}/adjust`, { change, reason, location_id, build_mode });
        UI.toast(`Stock updated — ${r.location_quantity} here, ${r.quantity} total`);
        load();
      },
    });
  }

  function transferModal(id, items) {
    return UI.modalTask('inventory:transfer:' + id, () => openTransferModal(id, items));
  }
  async function openTransferModal(id, items) {
    const it = items.find((x) => x.id == id);
    const breakdown = await API.get(`/inventory/${id}/stock`).catch(() => []);
    if (breakdown.length < 2) { UI.toast('Add a second location first (Inventory → Locations)', 'error'); return; }
    const rows = breakdown.map((b) => ({ id: b.location_id, name: b.location_name, is_default: b.is_default }));
    const qtyAt = (locId, mode = 'assembled') => (breakdown.find((b) => String(b.location_id) === String(locId)) || {})[mode === 'semi_built' ? 'semi_built_quantity' : 'assembled_quantity'] || 0;
    const top = [...breakdown].filter((b) => b.quantity > 0).sort((a, b) => b.quantity - a.quantity)[0];
    const fromInit = (top || breakdown[0]).location_id;
    const toInit = (breakdown.find((b) => b.location_id !== fromInit) || {}).location_id;

    return UI.modal({
      title: `Transfer stock — ${it.name}`,
      bodyHTML: `
        <div class="field-row">
          <div><label>From</label><select data-f="from">${locationOptions(fromInit, rows)}</select>
            <p class="muted" data-fromat style="margin:4px 0 0;font-size:12px">Available: <strong>${qtyAt(fromInit)}</strong></p></div>
          <div><label>To</label><select data-f="to">${locationOptions(toInit, rows)}</select>
            <p class="muted" data-toat style="margin:4px 0 0;font-size:12px">Currently: <strong>${qtyAt(toInit)}</strong></p></div>
        </div>
        ${it.is_finished_product ? '<div><label>Product build state</label><select data-f="mode"><option value="assembled">Fully built</option><option value="semi_built">Semi-built package</option></select></div>' : ''}
        <div class="field-row">
          <div><label>Amount</label><input data-f="amount" type="number" min="1" value="1" /></div>
          <div><label>Reason / reference</label><input data-f="reason" placeholder="e.g. Restock branch" /></div>
        </div>`,
      confirmText: 'Transfer',
      onOpen: (overlay) => {
        const from = overlay.querySelector('[data-f="from"]');
        const to = overlay.querySelector('[data-f="to"]');
        const mode = overlay.querySelector('[data-f="mode"]');
        const refreshQty = () => { overlay.querySelector('[data-fromat] strong').textContent = qtyAt(from.value, mode?.value || 'assembled'); overlay.querySelector('[data-toat] strong').textContent = qtyAt(to.value, mode?.value || 'assembled'); };
        from.addEventListener('change', refreshQty); to.addEventListener('change', refreshQty); mode?.addEventListener('change', refreshQty);
      },
      onConfirm: async (overlay, showErr) => {
        const from_location_id = overlay.querySelector('[data-f="from"]').value;
        const to_location_id = overlay.querySelector('[data-f="to"]').value;
        const amount = parseInt(overlay.querySelector('[data-f="amount"]').value, 10);
        const reason = overlay.querySelector('[data-f="reason"]').value;
        const build_mode = overlay.querySelector('[data-f="mode"]')?.value || 'assembled';
        if (from_location_id === to_location_id) { showErr('Pick two different locations'); return false; }
        if (!amount || amount <= 0) { showErr('Enter a positive amount'); return false; }
        const r = await API.post(`/inventory/${id}/transfer`, { from_location_id, to_location_id, amount, reason, build_mode });
        UI.toast(`Transferred — ${r.from} left at source, ${r.to} now at destination`);
        load();
      },
    });
  }

  function historyModal(id) {
    return UI.modalTask('inventory:history:' + id, () => openHistoryModal(id));
  }
  async function openHistoryModal(id) {
    const it = await API.get('/inventory/' + id);
    const rows = it.history.map((h) => `
      <tr><td>${UI.fmtDate(h.created_at)}</td>
      <td>${UI.esc(h.location_name || '—')}</td>
      <td><strong style="color:${h.change < 0 ? 'var(--danger)' : 'var(--success)'}">${h.change > 0 ? '+' : ''}${h.change}</strong></td>
      <td class="right">${h.location_balance_after ?? '—'}</td>
      <td class="right">${h.balance_after}</td>
      <td>${UI.esc(h.reason || '—')}</td>
      <td>${UI.esc(h.user_name || '—')}</td></tr>`).join('');
    return UI.modal({
      title: `History — ${it.name}`,
      size: 'lg',
      bodyHTML: it.history.length
        ? `<table><thead><tr><th>When</th><th>Location</th><th>Change</th><th class="right">At loc.</th><th class="right">Total</th><th>Reason</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty">No movements recorded yet.</div>',
      cancelText: 'Close',
    });
  }

  async function del(it) {
    if ((Number(it.quantity) || 0) > 0) {
      UI.toast(`"${it.name}" still has ${it.quantity} in stock — set it to 0 before deleting.`, 'error');
      return;
    }
    const ok = await UI.confirmDialog(`Delete "${it.name}"? This also removes its stock history.`, 'Delete');
    if (!ok) return;
    try {
      await API.del('/inventory/' + it.id);
      UI.toast('Item deleted');
      load();
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  // Wire toolbar
  view.querySelectorAll('[data-kind]').forEach((button) => button.addEventListener('click', () => {
    if (state.kind === button.dataset.kind) return;
    App.navigate('inventory', { kind: button.dataset.kind });
  }));
  view.querySelector('#inv-clear').onclick = () => {
    clearTimeout(searchTimer);
    Object.assign(state, { q: '', department_id: '', supplier_id: '', location_id: '', category: '', low: false, include_damaged: false });
    ['inv-search', 'inv-cat', 'inv-dept', 'inv-supplier', 'inv-location'].forEach((id) => { view.querySelector('#' + id).value = ''; });
    view.querySelector('#inv-low').checked = false;
    view.querySelector('#inv-damaged').checked = false;
    load();
  };
  view.querySelector('#inv-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.q = e.target.value.trim();
    requestVersion++;
    searchTimer = setTimeout(load, 250);
  });
  view.querySelector('#inv-cat').addEventListener('change', (e) => { state.category = e.target.value; load(); });
  view.querySelector('#inv-dept').addEventListener('change', (e) => { state.department_id = e.target.value; load(); });
  view.querySelector('#inv-supplier').addEventListener('change', (e) => { state.supplier_id = e.target.value; load(); });
  view.querySelector('#inv-location').addEventListener('change', (e) => { state.location_id = e.target.value; load(); });
  view.querySelector('#inv-low').addEventListener('change', (e) => { state.low = e.target.checked; load(); });
  view.querySelector('#inv-damaged').addEventListener('change', (e) => { state.include_damaged = e.target.checked; load(); });
  view.querySelector('#inv-export').addEventListener('click', exportCsv);
  view.querySelector('#inv-labels').addEventListener('click', barcodeLabelsModal);
  view.querySelector('#inv-import').addEventListener('click', importCsv);
  const reorderBtn = view.querySelector('#inv-reorder');
  if (reorderBtn) reorderBtn.addEventListener('click', reorderPoModal);
  view.querySelector('#inv-add').addEventListener('click', () => itemModal(null));

  await Promise.all([
    load(), loadCategories(), loadItemFormConfig(),
    loadSuppliers(true).then(fillSupplierFilter),
    loadLocations(true).then(fillLocationFilter),
  ]);
  // filter.id deep-links straight into one item's detail (used by the AI assistant's
  // created-record links) — detailModal() only needs {id}, it fetches the rest itself.
  if (filter && filter.id) detailModal({ id: Number(filter.id) });
});
