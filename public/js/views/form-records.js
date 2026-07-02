/* Form Records: index of all custom forms, or records list for a specific form.
   Route: form-records.  filter.form_id = <id> to open a specific form directly. */
App.register('form-records', async (view, filter) => {
  if (filter && filter.form_id) {
    await renderFormView(view, Number(filter.form_id));
  } else {
    await renderIndex(view);
  }
});

/* ── Form index: pick which form to open ─────────────────────────────────── */
async function renderIndex(view) {
  view.innerHTML = `
    <div class="topbar"><h2>Data Forms</h2></div>
    <div class="panel"><div id="fr-index"></div></div>`;
  const el = view.querySelector('#fr-index');
  el.innerHTML = '<div class="empty">Loading…</div>';

  const forms = await API.get('/form-definitions');
  if (!forms.length) {
    el.innerHTML = UI.emptyState({
      icon: 'file',
      title: 'No forms defined yet',
      hint: App.isAdmin() ? 'Go to Admin → Form Builder to create your first form.' : 'Ask an admin to create a form.',
      action: App.isAdmin()
        ? `<button class="btn" id="fr-goto-builder">${UI.icon('edit')} Open Form Builder</button>` : '',
    });
    const btn = el.querySelector('#fr-goto-builder');
    if (btn) btn.onclick = () => App.navigate('form-builder');
    return;
  }

  el.innerHTML = `<div class="form-card-grid">${forms.map((f) => `
    <div class="form-card clickable" data-id="${f.id}">
      <div class="form-card-icon">${UI.icon(f.icon || 'file', 32)}</div>
      <div class="form-card-info">
        <div class="form-card-name">${UI.esc(f.name)}</div>
        <div class="form-card-meta">${f.fields.length} field${f.fields.length !== 1 ? 's' : ''} · ${f.record_count} record${f.record_count !== 1 ? 's' : ''}</div>
        <div class="form-card-prefix muted mono">${UI.esc(f.number_prefix)}-#####</div>
      </div>
    </div>`).join('')}</div>`;

  el.querySelectorAll('.form-card[data-id]').forEach((card) =>
    card.onclick = () => App.navigate('form-records', { form_id: card.dataset.id }));
}

/* ── Per-form records view ───────────────────────────────────────────────── */
async function renderFormView(view, formId) {
  let formDef = null;
  let searchTimer;
  const state = { q: '', status: '' };

  try { formDef = await API.get('/form-definitions/' + formId); }
  catch { view.innerHTML = '<div class="empty">Form not found.</div>'; return; }

  view.innerHTML = `
    <div class="topbar">
      <button class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} All Forms</button>
      <h2 style="margin-left:10px">${UI.esc(formDef.name)}</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="fr-search" placeholder="Search number…" /></div>
      <select id="fr-status" style="margin-left:8px">
        <option value="">All statuses</option>
        ${['draft', 'submitted', 'approved', 'rejected', 'completed']
          .map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
      <button class="btn" id="fr-new" style="margin-left:8px">${UI.icon('plus')} New Record</button>
    </div>
    <div class="panel"><div id="fr-table"></div></div>`;

  view.querySelector('#fr-back').onclick = () => App.navigate('form-records');
  view.querySelector('#fr-new').onclick = () => recordModal(null);
  view.querySelector('#fr-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.q = e.target.value.trim();
    searchTimer = setTimeout(load, 250);
  });
  view.querySelector('#fr-status').addEventListener('change', (e) => {
    state.status = e.target.value;
    load();
  });

  async function load() {
    const el = view.querySelector('#fr-table');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    const records = await API.get('/form-definitions/' + formId + '/records?' + params.toString());
    renderRecords(records);
  }

  function renderRecords(records) {
    const el = view.querySelector('#fr-table');
    if (!records.length) {
      el.innerHTML = UI.emptyState({
        icon: formDef.icon || 'file',
        title: state.q || state.status ? 'No matching records' : `No ${formDef.name} records yet`,
        hint: state.q || state.status ? 'Try a different search or status.' : 'Create the first record to get started.',
        action: !state.q && !state.status
          ? `<button class="btn" id="fr-empty-new">${UI.icon('plus')} New Record</button>` : '',
      });
      const en = el.querySelector('#fr-empty-new');
      if (en) en.onclick = () => recordModal(null);
      return;
    }

    // Build column headers from form fields (show first 4 to keep table readable).
    const visibleFields = formDef.fields.slice(0, 4);
    el.innerHTML = `<table>
      <thead><tr>
        <th>Number</th>
        ${visibleFields.map((f) => `<th>${UI.esc(f.label)}</th>`).join('')}
        <th>Status</th><th>Date</th><th></th>
      </tr></thead>
      <tbody>${records.map((r) => `
        <tr class="clickable" data-id="${r.id}">
          <td><strong>${UI.esc(r.number)}</strong></td>
          ${visibleFields.map((f) => `<td>${UI.esc(String(r.data[f.key] ?? ''))}</td>`).join('')}
          <td><span class="badge-pill status-${UI.esc(r.status)}">${UI.esc(r.status)}</span></td>
          <td>${UI.esc(UI.fmtDateShort(r.created_at))}</td>
          <td class="actions">
            <button class="icon-btn" data-edit="${r.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${r.id}" title="Delete">${UI.icon('trash')}</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    el.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); openRecord(b.dataset.edit, records); });
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); delRecord(b.dataset.del, records); });
    el.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.onclick = (e) => {
        if (e.target.closest('.actions')) return;
        openRecord(tr.dataset.id, records);
      });
  }

  function openRecord(id, records) {
    const r = records.find((x) => String(x.id) === String(id));
    if (r) recordModal(r);
  }

  async function delRecord(id, records) {
    const r = records.find((x) => String(x.id) === String(id));
    if (!r) return;
    if (!await UI.confirmDialog(`Delete record ${r.number}? Cannot be undone.`, 'Delete')) return;
    await API.del('/form-records/' + id);
    UI.toast('Record deleted');
    load();
  }

  /* ── Record create / edit modal ─────────────────────────────────────────── */
  function recordModal(existing) {
    const editing = !!existing;
    const data = editing ? { ...existing.data } : {};
    const statusOpts = ['draft', 'submitted', 'approved', 'rejected', 'completed']
      .map((s) => `<option value="${s}" ${(existing ? existing.status : 'draft') === s ? 'selected' : ''}>${s}</option>`)
      .join('');

    UI.modal({
      title: editing ? `Edit ${existing.number}` : `New ${formDef.name}`,
      size: formDef.fields.length > 6 ? 'lg' : undefined,
      bodyHTML: `
        <div style="margin-bottom:14px">
          <label>Status</label>
          <select data-f="status">${statusOpts}</select>
        </div>
        ${formDef.fields.map((field) => renderFieldInput(field, data)).join('')}
        ${formDef.fields.length === 0
          ? '<div class="muted" style="text-align:center;padding:20px">This form has no fields yet. Edit it in Form Builder to add fields.</div>'
          : ''}`,
      confirmText: editing ? 'Save' : 'Create',
      onConfirm: async (ov, showErr) => {
        // Collect field values from the modal.
        const collected = {};
        for (const field of formDef.fields) {
          const inp = ov.querySelector(`[data-field="${field.key}"]`);
          if (!inp) continue;
          if (field.type === 'checkbox') {
            collected[field.key] = inp.checked;
          } else {
            collected[field.key] = inp.value;
          }
          if (field.required && !collected[field.key] && collected[field.key] !== false) {
            showErr(`"${field.label}" is required`); return false;
          }
        }
        const status = ov.querySelector('[data-f="status"]').value;

        if (editing) {
          await API.put('/form-records/' + existing.id, { data: collected, status });
        } else {
          await API.post('/form-records', { form_def_id: formId, data: collected, status });
        }
        UI.toast(editing ? 'Record saved' : 'Record created');
        load();
      },
    });
  }

  function renderFieldInput(field, data) {
    const val = data[field.key] ?? field.default ?? '';
    const id = `fr-field-${field.key}`;
    const req = field.required ? '<span class="req">*</span>' : '';
    let input = '';
    if (field.type === 'textarea') {
      input = `<textarea data-field="${UI.esc(field.key)}" id="${id}" rows="3">${UI.esc(String(val))}</textarea>`;
    } else if (field.type === 'checkbox') {
      input = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" data-field="${UI.esc(field.key)}" id="${id}" ${val ? 'checked' : ''} />
        <span>${UI.esc(field.label)}${req}</span>
      </label>`;
      return `<div style="margin-bottom:12px">${input}</div>`;
    } else if (field.type === 'select') {
      const opts = (field.options || []).map((o) =>
        `<option value="${UI.esc(o)}" ${String(val) === o ? 'selected' : ''}>${UI.esc(o)}</option>`
      ).join('');
      input = `<select data-field="${UI.esc(field.key)}" id="${id}">
        <option value="">— select —</option>${opts}
      </select>`;
    } else {
      input = `<input data-field="${UI.esc(field.key)}" id="${id}" type="${field.type}"
        value="${UI.esc(String(val))}" />`;
    }
    return `<div style="margin-bottom:12px">
      <label for="${id}">${UI.esc(field.label)}${req}</label>
      ${input}
    </div>`;
  }

  await load();
}
