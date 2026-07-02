/* Form Builder (admin): manage form definitions (fields) + global variables.
   Route: form-builder. Tab driven: Forms | Global Variables. */
App.register('form-builder', async (view) => {
  let activeTab = 'forms';

  view.innerHTML = `
    <div class="topbar">
      <h2>Form Builder</h2>
    </div>
    <div class="subnav-tabs" id="fb-tabs">
      <button class="subtab active" data-tab="forms">Form Definitions</button>
      <button class="subtab" data-tab="globals">Global Variables</button>
    </div>
    <div id="fb-content"></div>`;

  const content = view.querySelector('#fb-content');

  view.querySelectorAll('#fb-tabs .subtab').forEach((btn) =>
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      view.querySelectorAll('#fb-tabs .subtab').forEach((b) =>
        b.classList.toggle('active', b === btn));
      renderTab();
    }));

  // ── Forms tab ──────────────────────────────────────────────────────────────

  async function renderFormsTab() {
    content.innerHTML = `
      <div class="topbar" style="padding:12px 20px">
        <span class="grow"></span>
        <button class="btn" id="fb-new-form">${UI.icon('plus')} New Form</button>
      </div>
      <div class="panel"><div id="fb-forms-table"></div></div>`;
    content.querySelector('#fb-new-form').onclick = () => formModal(null);
    await loadForms();
  }

  async function loadForms() {
    const el = content.querySelector('#fb-forms-table');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    const forms = await API.get('/form-definitions');
    if (!forms.length) {
      el.innerHTML = UI.emptyState({
        icon: 'file',
        title: 'No custom forms yet',
        hint: 'Create your first form to start collecting structured data.',
        action: `<button class="btn" id="fb-empty-new">${UI.icon('plus')} New Form</button>`,
      });
      const en = el.querySelector('#fb-empty-new');
      if (en) en.onclick = () => formModal(null);
      return;
    }
    el.innerHTML = `<table>
      <thead><tr><th>Name</th><th>Slug</th><th>Prefix</th><th>Fields</th><th>Records</th><th></th></tr></thead>
      <tbody>${forms.map((f) => `
        <tr class="clickable" data-open="${f.id}">
          <td><strong>${UI.esc(f.name)}</strong></td>
          <td><span class="mono muted">${UI.esc(f.slug)}</span></td>
          <td><span class="mono">${UI.esc(f.number_prefix)}-#####</span></td>
          <td>${f.fields.length} field${f.fields.length !== 1 ? 's' : ''}</td>
          <td>${f.record_count}</td>
          <td class="actions">
            <button class="btn secondary small" data-records="${f.id}" title="View Records">${UI.icon('forms', 14)} Records</button>
            <button class="icon-btn" data-edit="${f.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${f.id}" title="Delete">${UI.icon('trash')}</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    el.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); openForm(b.dataset.edit, forms); });
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); delForm(b.dataset.del, forms); });
    el.querySelectorAll('[data-records]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); App.navigate('form-records', { form_id: b.dataset.records }); });
    el.querySelectorAll('tr[data-open]').forEach((tr) =>
      tr.onclick = (e) => {
        if (e.target.closest('.actions')) return;
        openForm(tr.dataset.open, forms);
      });
  }

  function openForm(id, forms) {
    const form = forms.find((f) => String(f.id) === String(id));
    if (form) formModal(form);
  }

  async function delForm(id, forms) {
    const form = forms.find((f) => String(f.id) === String(id));
    if (!form) return;
    const hasRecords = form.record_count > 0;
    const msg = hasRecords
      ? `Delete "${form.name}"? This will also delete all ${form.record_count} record(s). Cannot be undone.`
      : `Delete "${form.name}"? Cannot be undone.`;
    if (!await UI.confirmDialog(msg, 'Delete')) return;
    await API.del('/form-definitions/' + id);
    UI.toast('Form deleted');
    loadForms();
  }

  // ── Form definition modal ──────────────────────────────────────────────────

  function formModal(existing) {
    const editing = !!existing;
    const fields = editing ? JSON.parse(JSON.stringify(existing.fields)) : [];

    UI.modal({
      title: editing ? `Edit: ${existing.name}` : 'New Form',
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div style="flex:2">
            <label>Form name</label>
            <input data-f="name" value="${UI.esc(existing ? existing.name : '')}" placeholder="e.g. Leave Request" />
          </div>
          <div>
            <label>Slug <span class="muted">(unique ID)</span></label>
            <input data-f="slug" value="${UI.esc(existing ? existing.slug : '')}" placeholder="leave_request" class="mono" />
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Number prefix</label>
            <input data-f="number_prefix" value="${UI.esc(existing ? existing.number_prefix : 'FM')}" placeholder="FM" class="mono" style="width:90px" />
          </div>
          <div>
            <label>Icon</label>
            <input data-f="icon" value="${UI.esc(existing ? existing.icon : 'file')}" placeholder="file" style="width:100px" />
          </div>
        </div>
        <div style="margin-top:16px;display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <strong>Fields</strong>
          <button type="button" class="btn secondary small" id="fb-add-field">${UI.icon('plus', 14)} Add field</button>
        </div>
        <div id="fb-fields-list"></div>
        <p class="muted" style="font-size:12px;margin-top:8px">
          Each field becomes a template variable: <span class="mono">{{field_key}}</span>
        </p>`,
      confirmText: editing ? 'Save form' : 'Create form',
      onOpen: (ov) => {
        const nameEl = ov.querySelector('[data-f="name"]');
        const slugEl = ov.querySelector('[data-f="slug"]');

        // Auto-fill slug from name for new forms.
        if (!editing) {
          nameEl.addEventListener('input', () => {
            slugEl.value = nameEl.value.toLowerCase()
              .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          });
        }

        ov.querySelector('#fb-add-field').onclick = () => {
          fields.push({ key: '', label: '', type: 'text', required: false, options: [], default: '' });
          renderFields(ov, fields);
        };
        renderFields(ov, fields);
      },
      onConfirm: async (ov, showErr) => {
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        if (!f('name')) { showErr('Form name is required'); return false; }
        if (!f('slug')) { showErr('Slug is required'); return false; }
        if (!/^[a-z0-9_]+$/.test(f('slug'))) { showErr('Slug must be lowercase letters, numbers, or underscores'); return false; }
        if (!f('number_prefix') || !/^[A-Z0-9]+$/.test(f('number_prefix'))) {
          showErr('Prefix must be uppercase letters or numbers (e.g. FM, LR)'); return false;
        }
        for (const field of fields) {
          if (!field.key) { showErr('All fields must have a key'); return false; }
          if (!field.label) { showErr(`Field "${field.key}" is missing a label`); return false; }
        }
        const keys = fields.map((f) => f.key);
        if (new Set(keys).size !== keys.length) { showErr('Field keys must be unique'); return false; }

        const body = {
          name: f('name'), slug: f('slug'),
          number_prefix: f('number_prefix'), icon: f('icon') || 'file',
          fields,
        };
        if (editing) await API.put('/form-definitions/' + existing.id, body);
        else await API.post('/form-definitions', body);
        UI.toast(editing ? 'Form saved' : 'Form created');
        loadForms();
      },
    });
  }

  function renderFields(ov, fields) {
    const el = ov.querySelector('#fb-fields-list');
    if (!fields.length) {
      el.innerHTML = `<div class="muted" style="text-align:center;padding:12px">No fields yet — add one above.</div>`;
      return;
    }
    const typeOptions = ['text', 'number', 'date', 'select', 'textarea', 'checkbox']
      .map((t) => `<option value="${t}">${t}</option>`).join('');

    el.innerHTML = `<table class="line-table"><thead><tr>
      <th>Key <span class="muted">(variable name)</span></th>
      <th>Label</th><th>Type</th><th>Required</th><th>Default / Options</th><th></th>
    </tr></thead><tbody id="fb-field-rows">${fields.map((f, i) => `
      <tr data-fi="${i}">
        <td><input class="mono" data-k="key" value="${UI.esc(f.key)}" placeholder="field_key" style="width:120px" /></td>
        <td><input data-k="label" value="${UI.esc(f.label)}" placeholder="Field Label" /></td>
        <td><select data-k="type">${typeOptions.replace(`"${f.type}"`, `"${f.type}" selected`)}</select></td>
        <td style="text-align:center"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''} /></td>
        <td>${f.type === 'select'
          ? `<input data-k="options" value="${UI.esc((f.options || []).join(', '))}" placeholder="Option 1, Option 2, …" />`
          : `<input data-k="default" value="${UI.esc(f.default || '')}" placeholder="default value" />`}
        </td>
        <td><button type="button" class="icon-btn danger" data-rm="${i}" title="Remove">${UI.icon('trash', 14)}</button></td>
      </tr>`).join('')}
    </tbody></table>`;

    el.querySelectorAll('input[data-k], select[data-k]').forEach((inp) => {
      inp.addEventListener('change', () => syncField(inp, fields));
      if (inp.type !== 'checkbox') inp.addEventListener('input', () => syncField(inp, fields));
    });
    el.querySelectorAll('[data-rm]').forEach((b) =>
      b.onclick = () => { fields.splice(Number(b.dataset.rm), 1); renderFields(ov, fields); });
  }

  function syncField(inp, fields) {
    const row = inp.closest('[data-fi]');
    if (!row) return;
    const i = Number(row.dataset.fi);
    const k = inp.dataset.k;
    if (k === 'required') { fields[i].required = inp.checked; return; }
    if (k === 'options') {
      fields[i].options = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (k === 'type') {
      fields[i].type = inp.value;
      // Re-render so the last cell switches between options/default input.
      const ov = inp.closest('.modal-body');
      renderFields(ov, fields);
    } else {
      fields[i][k] = inp.value;
    }
  }

  // ── Global Variables tab ───────────────────────────────────────────────────

  async function renderGlobalsTab() {
    content.innerHTML = `
      <div class="topbar" style="padding:12px 20px">
        <div>
          <div>Variables usable in <em>any</em> template as <span class="mono">{{global.key}}</span></div>
        </div>
        <span class="grow"></span>
        <button class="btn" id="fb-new-var">${UI.icon('plus')} New Variable</button>
      </div>
      <div class="panel"><div id="fb-vars-table"></div></div>`;
    content.querySelector('#fb-new-var').onclick = () => varModal(null);
    await loadVars();
  }

  async function loadVars() {
    const el = content.querySelector('#fb-vars-table');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    const vars = await API.get('/global-variables');
    if (!vars.length) {
      el.innerHTML = UI.emptyState({
        icon: 'settings',
        title: 'No global variables yet',
        hint: 'Add variables like company_tin or fiscal_year to use them across all templates.',
        action: `<button class="btn" id="fb-empty-var">${UI.icon('plus')} New Variable</button>`,
      });
      const en = el.querySelector('#fb-empty-var');
      if (en) en.onclick = () => varModal(null);
      return;
    }
    el.innerHTML = `<table>
      <thead><tr><th>Key</th><th>Label</th><th>Value</th><th></th></tr></thead>
      <tbody>${vars.map((v) => `
        <tr class="clickable" data-key="${UI.esc(v.key)}">
          <td><span class="mono">${UI.esc(v.key)}</span></td>
          <td>${UI.esc(v.label)}</td>
          <td>${UI.esc(v.value || '—')}</td>
          <td class="actions">
            <button class="icon-btn" data-edit="${UI.esc(v.key)}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${UI.esc(v.key)}" title="Delete">${UI.icon('trash')}</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;
    el.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); varModal(vars.find((v) => v.key === b.dataset.edit)); });
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); delVar(b.dataset.del); });
    el.querySelectorAll('tr[data-key]').forEach((tr) =>
      tr.onclick = (e) => {
        if (e.target.closest('.actions')) return;
        varModal(vars.find((v) => v.key === tr.dataset.key));
      });
  }

  function varModal(existing) {
    const editing = !!existing;
    UI.modal({
      title: editing ? `Edit: ${existing.key}` : 'New Global Variable',
      bodyHTML: `
        <label>Key <span class="muted">(used in templates as <span class="mono">{{global.key}}</span>)</span></label>
        <input data-f="key" class="mono" value="${UI.esc(existing ? existing.key : '')}"
          placeholder="e.g. company_tin" ${editing ? 'readonly style="opacity:0.6"' : ''} />
        <label style="margin-top:12px">Label</label>
        <input data-f="label" value="${UI.esc(existing ? existing.label : '')}" placeholder="e.g. Company TIN" />
        <label style="margin-top:12px">Value</label>
        <input data-f="value" value="${UI.esc(existing ? existing.value : '')}" placeholder="e.g. 123-456-789-000" />`,
      confirmText: editing ? 'Save' : 'Create',
      onConfirm: async (ov, showErr) => {
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        if (!editing && !f('key')) { showErr('Key is required'); return false; }
        if (!editing && !/^[a-z0-9_]+$/.test(f('key'))) {
          showErr('Key must be lowercase letters, numbers, or underscores'); return false;
        }
        if (!f('label')) { showErr('Label is required'); return false; }
        const key = editing ? existing.key : f('key');
        await API.put('/global-variables/' + key, { label: f('label'), value: f('value') });
        UI.toast(editing ? 'Variable saved' : 'Variable created');
        loadVars();
      },
    });
  }

  async function delVar(key) {
    if (!await UI.confirmDialog(`Delete variable "${key}"? Cannot be undone.`, 'Delete')) return;
    await API.del('/global-variables/' + key);
    UI.toast('Variable deleted');
    loadVars();
  }

  // ── Tab router ─────────────────────────────────────────────────────────────

  function renderTab() {
    if (activeTab === 'forms') renderFormsTab();
    else renderGlobalsTab();
  }

  renderTab();
});
