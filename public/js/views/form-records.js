/* Form Records: index of all custom forms, or records list for a specific form.
   Route: form-records.  filter.form_id = <id> to open a specific form directly. */
const FORM_RECORDS_SCOPE_LABELS = { hr: 'HR', inventory: 'Inventory', admin: 'Admin', accounting: 'Accounting' };
const FORM_RECORDS_SCOPE_ORDER = ['hr', 'inventory', 'admin', 'accounting', null];

App.register('form-records', async (view, filter) => {
  if (filter && filter.form_id) {
    await renderFormView(view, Number(filter.form_id), filter.period || '');
  } else {
    await renderIndex(view);
  }
});

function formCardHTML(f) {
  return `<div class="form-card clickable" data-id="${f.id}">
    <div class="form-card-icon">${UI.icon(f.icon || 'file', 32)}</div>
    <div class="form-card-info">
      <div class="form-card-name">${UI.esc(f.name)}</div>
      <div class="form-card-meta">${f.fields.length} field${f.fields.length !== 1 ? 's' : ''} · ${f.record_count} record${f.record_count !== 1 ? 's' : ''}</div>
      <div class="form-card-prefix muted mono">${UI.esc(f.number_prefix)}-#####</div>
    </div>
  </div>`;
}

/* ── Form index: pick which form to open, grouped by the section that owns it ────── */
async function renderIndex(view) {
  view.innerHTML = `
    <div class="topbar"><h2>Data Forms</h2></div>
    <div class="panel"><div id="fr-index"></div></div>`;
  const el = view.querySelector('#fr-index');
  el.innerHTML = '<div class="empty">Loading…</div>';

  const forms = await API.get('/form-definitions');
  // Which section (if any) this user could jump into Form Builder for, for the empty-state
  // shortcut below — every Form Builder entry now requires a scope, so "open Form Builder" with
  // none no longer resolves to anything.
  const manageableScope = ['hr', 'inventory', 'admin', 'accounting'].find((s) => App.hasPermission('forms.manage.' + s));

  if (!forms.length) {
    el.innerHTML = UI.emptyState({
      icon: 'file',
      title: 'No forms defined yet',
      hint: manageableScope ? 'Go to Form Builder (in its section’s nav) to create your first form.' : 'Ask an admin to create a form.',
      action: manageableScope
        ? `<button class="btn" id="fr-goto-builder">${UI.icon('edit')} Open Form Builder</button>` : '',
    });
    const btn = el.querySelector('#fr-goto-builder');
    if (btn) btn.onclick = () => App.navigate('form-builder', { scope: manageableScope });
    return;
  }

  const groups = {};
  forms.forEach((f) => { const k = f.scope || 'general'; (groups[k] = groups[k] || []).push(f); });
  const order = [...FORM_RECORDS_SCOPE_ORDER.map((s) => s || 'general')];
  el.innerHTML = order.filter((k) => groups[k] && groups[k].length).map((k) => `
    <div class="fr-scope-group">
      <div class="fr-scope-heading">${UI.esc(FORM_RECORDS_SCOPE_LABELS[k] || 'General')}</div>
      <div class="form-card-grid">${groups[k].map(formCardHTML).join('')}</div>
    </div>`).join('');

  el.querySelectorAll('.form-card[data-id]').forEach((card) =>
    card.onclick = () => App.navigate('form-records', { form_id: card.dataset.id }));
}

/* ── Per-form records view ───────────────────────────────────────────────── */
async function renderFormView(view, formId, initialPeriod) {
  let formDef = null;
  let searchTimer;
  let currentRecords = [];
  let selectedIds = new Set();
  const state = { q: '', status: '', period: initialPeriod || '' };

  try { formDef = await API.get('/form-definitions/' + formId); }
  catch { view.innerHTML = '<div class="empty">Form not found.</div>'; return; }

  const isPayroll = formDef.slug === 'hr_payroll';
  // Any other form with a linked print template gets the same "Print All"/"Print selected"
  // bulk actions payroll has always had — payroll keeps its own dedicated 2-up slip buttons.
  const canBulkPrint = !isPayroll && !!formDef.template_id;

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
      ${isPayroll ? `
        <select id="fr-period" style="margin-left:8px;padding:6px 8px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:13px" title="Filter by payroll period">
          <option value="">All periods</option>
        </select>
        <button class="btn secondary" id="fr-import-csv" style="margin-left:8px">${UI.icon('upload')} Upload CSV</button>
        <button class="btn secondary" id="fr-print-slips" style="margin-left:8px">${UI.icon('printer')} Print All</button>` : ''}
      ${canBulkPrint ? `<button class="btn secondary" id="fr-print-all-tpl" style="margin-left:8px">${UI.icon('printer')} Print All</button>` : ''}
      <button class="btn secondary danger" id="fr-del-all" style="margin-left:8px" title="Delete all currently visible records">${UI.icon('trash')} Delete Period</button>
      <button class="btn" id="fr-new" style="margin-left:8px">${UI.icon('plus')} New Record</button>
    </div>
    <div id="fr-bulk-bar" style="display:none;align-items:center;gap:8px;padding:7px 16px;background:var(--accent-weak,#e7f1ff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0">
      <span id="fr-sel-count" style="font-weight:700;font-size:13px;color:var(--accent,#2b7fff)">0 selected</span>
      <div style="flex:1"></div>
      ${isPayroll ? `<button class="btn secondary small" id="fr-bulk-print">${UI.icon('printer')} Print selected</button>` : ''}
      ${canBulkPrint ? `<button class="btn secondary small" id="fr-bulk-print-tpl">${UI.icon('printer')} Print selected</button>` : ''}
      <button class="btn secondary small danger" id="fr-bulk-del">${UI.icon('trash')} Delete selected</button>
      <button class="btn secondary small" id="fr-bulk-clear">${UI.icon('close', 12)} Clear</button>
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
  if (isPayroll) {
    view.querySelector('#fr-import-csv').onclick = () => importCsvModal();
    view.querySelector('#fr-print-slips').onclick = () => printSlips();
    view.querySelector('#fr-bulk-print').onclick = () => printSelected();
    view.querySelector('#fr-period').addEventListener('change', (e) => {
      state.period = e.target.value;
      load();
    });
  }
  if (canBulkPrint) {
    view.querySelector('#fr-print-all-tpl').onclick = () => printRecordsViaTemplate(currentRecords);
    view.querySelector('#fr-bulk-print-tpl').onclick = () =>
      printRecordsViaTemplate(currentRecords.filter((r) => selectedIds.has(r.id)));
  }
  view.querySelector('#fr-del-all').onclick = () => delAll();
  view.querySelector('#fr-bulk-del').onclick = () => delSelected();
  view.querySelector('#fr-bulk-clear').onclick = () => { selectedIds.clear(); syncSelection(); };

  function updateBulkBar() {
    const bar = view.querySelector('#fr-bulk-bar');
    if (!bar) return;
    if (selectedIds.size > 0) {
      bar.style.display = 'flex';
      view.querySelector('#fr-sel-count').textContent = `${selectedIds.size} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  function syncSelection() {
    const tableEl = view.querySelector('#fr-table');
    if (!tableEl) return;
    tableEl.querySelectorAll('[data-row-check]').forEach((cb) => {
      cb.checked = selectedIds.has(Number(cb.dataset.rowCheck));
    });
    const allCb = tableEl.querySelector('#fr-check-all');
    if (allCb) {
      allCb.checked = currentRecords.length > 0 && currentRecords.every((r) => selectedIds.has(r.id));
      allCb.indeterminate = selectedIds.size > 0 && !allCb.checked;
    }
    updateBulkBar();
  }

  async function delSelected() {
    if (!selectedIds.size) return;
    const n = selectedIds.size;
    if (!await UI.confirmDialog(`Delete ${n} selected record${n === 1 ? '' : 's'}? Cannot be undone.`, 'Delete')) return;
    let failed = 0;
    await Promise.all([...selectedIds].map((id) => API.del('/form-records/' + id).catch(() => { failed++; })));
    selectedIds.clear();
    UI.toast(failed ? `Deleted with ${failed} error${failed === 1 ? '' : 's'}` : `${n - failed} record${n - failed === 1 ? '' : 's'} deleted`);
    load();
  }

  async function printSelected() {
    if (!selectedIds.size) { UI.toast('No records selected', 'error'); return; }
    const list = currentRecords.filter((r) => selectedIds.has(r.id)).map((r) => r.data);
    printSlips(list);
  }

  async function delAll() {
    if (!currentRecords.length) { UI.toast('No records visible to delete', 'error'); return; }
    const n = currentRecords.length;
    const periodLabel = state.period ? `period "${state.period}"` : (state.q || state.status ? 'current filter' : 'all periods');
    if (!await UI.confirmDialog(`Delete all ${n} record${n === 1 ? '' : 's'} for ${periodLabel}? Cannot be undone.`, 'Delete')) return;
    let failed = 0;
    await Promise.all(currentRecords.map((r) => API.del('/form-records/' + r.id).catch(() => { failed++; })));
    selectedIds.clear();
    // If we deleted a specific period, reset the period filter since it no longer exists.
    if (state.period) { state.period = ''; }
    UI.toast(failed ? `Deleted with ${failed} error${failed === 1 ? '' : 's'}` : `${n - failed} record${n - failed === 1 ? '' : 's'} deleted`);
    load();
  }

  // Opens a floating preview (modal + iframe, no auto print) with a Print button the
  // user triggers when ready — that opens the browser's native print dialog (preview +
  // paper/copies/printer settings) scoped to just the iframe's content.
  // dataList defaults to every currently-loaded/filtered record; pass a single-item array
  // (from a row's Print button) to preview just that one employee's slip.
  // The per-slip HTML comes from the "HR Payroll Slip" document template (editable later
  // under Documents > Templates), not hardcoded — falls back to a plain layout if missing.
  async function printSlips(dataList) {
    const list = dataList || currentRecords.map((r) => r.data);
    if (!list.length) { UI.toast('No records to print', 'error'); return; }
    if (typeof buildPayrollSlipsHtml === 'undefined') { UI.toast('Print module failed to load', 'error'); return; }

    let templateBody;
    try {
      const templates = await API.get('/templates');
      const meta = templates.find((t) => t.name === 'HR Payroll Slip');
      if (meta) templateBody = (await API.get('/templates/' + meta.id)).body;
    } catch { /* fall back to the built-in default layout */ }

    const html = buildPayrollSlipsHtml(list, templateBody);
    const full = UI.printableHtml(html, formDef.name);

    UI.modal({
      title: 'Payslip Preview',
      size: 'xl',
      bodyHTML: `<iframe id="payslip-preview-frame" style="width:100%;height:70vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
      cancelText: 'Close',
      confirmText: 'Print…',
      onOpen: (ov) => { ov.querySelector('#payslip-preview-frame').srcdoc = full; },
      onConfirm: (ov) => {
        const ifr = ov.querySelector('#payslip-preview-frame');
        ifr.contentWindow.focus();
        ifr.contentWindow.print();
        return false; // keep the preview open — printing shouldn't close it
      },
    });
  }

  // Print one or many records through the form's linked template (data filled in) — additive
  // to, not a replacement for, the payroll-specific printSlips() above (which stays the
  // specialized 2-up slip layout for hr_payroll). Any other form that has a template linked in
  // Form Builder can print its records this way, including "Print All"/"Print selected" — each
  // record renders as its own page (page-break-after between them), unlike payroll's 2-up grid.
  async function printRecordsViaTemplate(records) {
    if (!formDef.template_id) { UI.toast('No print template linked to this form', 'error'); return; }
    if (!records.length) { UI.toast('No records to print', 'error'); return; }
    let tpl;
    try { tpl = await API.get('/templates/' + formDef.template_id); }
    catch { UI.toast('The linked template could not be loaded', 'error'); return; }
    let company = {};
    try { company = await API.get('/templates/company'); } catch { /* optional */ }
    const pages = records.map((r) => {
      const ctx = { ...r.data, record: { number: r.number, status: r.status, created_at: r.created_at }, company };
      return renderTemplate(tpl.body, ctx);
    });
    const html = pages.map((p, i) => (i < pages.length - 1 ? `<div style="page-break-after:always">${p}</div>` : p)).join('');
    const title = records.length > 1 ? `${formDef.name} (${records.length})` : formDef.name + ' - ' + records[0].number;
    const full = UI.printableHtml(html, title);
    // Attaching a saved PDF to Files only makes sense for a single record — a bulk print's
    // output doesn't map to any one record's identity.
    const canAttach = records.length === 1 && App.hasPermission('forms.upload');

    UI.modal({
      title: records.length > 1 ? `${records.length} records — Preview` : records[0].number + ' — Preview',
      size: 'lg',
      bodyHTML: `
        ${canAttach ? `<div style="margin-bottom:8px"><button type="button" class="btn secondary small" id="fr-attach-pdf">${UI.icon('upload', 14)} Attach saved PDF to Files</button></div>` : ''}
        <iframe id="fr-tpl-preview-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
      cancelText: 'Close',
      confirmText: 'Print…',
      onOpen: (ov) => {
        ov.querySelector('#fr-tpl-preview-frame').srcdoc = full;
        const attachBtn = ov.querySelector('#fr-attach-pdf');
        if (attachBtn) attachBtn.onclick = () => attachPdfModal(records[0]);
      },
      onConfirm: (ov) => {
        const ifr = ov.querySelector('#fr-tpl-preview-frame');
        ifr.contentWindow.focus();
        ifr.contentWindow.print();
        return false; // keep the preview open — printing shouldn't close it
      },
    });
  }

  // Manual hand-off, not automation: the browser's own print dialog already lets the user pick
  // "Save as PDF" as the destination, but JS has no way to capture those bytes back — there's no
  // API for it. So this just uploads whatever PDF the user saved, through the same endpoint the
  // Files "Upload" button already uses (public/js/views/forms.js's uploadModal()).
  function attachPdfModal(record) {
    const deptOpts = '<option value="">All staff (shared)</option>' +
      App.getDepartments().map((d) => `<option value="${d.id}">${UI.esc(d.name)} only</option>`).join('');
    UI.modal({
      title: 'Attach saved PDF to Files',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Print the document and choose <strong>Save as PDF</strong> as the destination, then pick that saved file below.</p>
        <div><label>PDF file *</label><input type="file" accept="application/pdf" data-f="file" /></div>
        <div style="margin-top:10px"><label>Title</label><input data-f="title" value="${UI.esc(formDef.name + ' - ' + record.number)}" /></div>
        <div style="margin-top:10px"><label>Visible to</label><select data-f="department_id">${deptOpts}</select></div>`,
      confirmText: 'Attach',
      onConfirm: async (ov, showErr) => {
        const fileEl = ov.querySelector('[data-f="file"]');
        if (!fileEl.files[0]) { showErr('Choose the PDF file you just saved'); return false; }
        const fd = new FormData();
        fd.append('file', fileEl.files[0]);
        fd.append('title', ov.querySelector('[data-f="title"]').value);
        fd.append('category', formDef.name);
        fd.append('department_id', ov.querySelector('[data-f="department_id"]').value);
        await API.upload('/forms', fd);
        UI.toast('Attached to Files');
      },
    });
  }

  function importCsvModal() {
    UI.modal({
      title: 'Upload payroll CSV',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Upload the payroll "Summary" CSV for a cutoff — employee, rate, hours, earnings and deductions are pulled from the sheet automatically.</p>
        <div><label>Payroll Period * <span class="muted" style="font-weight:400">(e.g. "1st Half June 2026")</span></label>
          <input data-f="period" placeholder="e.g. 1st Half June 2026" autocomplete="off" /></div>
        <div style="margin-top:10px"><label>CSV file *</label><input type="file" accept=".csv,text/csv" data-f="file" /></div>
        <div style="margin-top:10px"><label>Pay Date <span class="muted">(applied to every record — not in the sheet)</span></label><input type="date" data-f="pay_date" /></div>`,
      confirmText: 'Upload',
      onConfirm: async (ov, showErr) => {
        const period = ov.querySelector('[data-f="period"]').value.trim();
        if (!period) { showErr('Payroll period label is required'); return false; }
        const fileEl = ov.querySelector('[data-f="file"]');
        if (!fileEl.files.length) { showErr('Please choose a CSV file'); return false; }
        const fd = new FormData();
        fd.append('file', fileEl.files[0]);
        fd.append('period', period);
        fd.append('pay_date', ov.querySelector('[data-f="pay_date"]').value);
        const res = await API.upload('/form-definitions/' + formId + '/import', fd);
        UI.toast(`Imported ${res.created} record${res.created === 1 ? '' : 's'} for "${res.period}"`);
        // Auto-select the newly imported period.
        state.period = res.period;
        load();
      },
    });
  }

  async function load() {
    const el = view.querySelector('#fr-table');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    if (state.period) params.set('period', state.period);
    const records = await API.get('/form-definitions/' + formId + '/records?' + params.toString());
    currentRecords = records;
    selectedIds.clear();
    updateBulkBar();
    // Refresh the period dropdown with known periods (preserving selection).
    if (isPayroll) {
      const periodSel = view.querySelector('#fr-period');
      if (periodSel) {
        try {
          const periods = await API.get('/form-definitions/' + formId + '/periods');
          const cur = state.period;
          periodSel.innerHTML = '<option value="">All periods</option>' +
            periods.map((p) => `<option value="${UI.esc(p)}" ${p === cur ? 'selected' : ''}>${UI.esc(p)}</option>`).join('');
        } catch { /* non-critical */ }
      }
    }
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
        <th style="width:36px;text-align:center"><input type="checkbox" id="fr-check-all" title="Select all" /></th>
        <th>Number</th>
        ${visibleFields.map((f) => `<th>${UI.esc(f.label)}</th>`).join('')}
        <th>Status</th><th>Date</th><th></th>
      </tr></thead>
      <tbody>${records.map((r) => `
        <tr class="clickable" data-id="${r.id}">
          <td style="text-align:center"><input type="checkbox" data-row-check="${r.id}" ${selectedIds.has(r.id) ? 'checked' : ''} /></td>
          <td><strong>${UI.esc(r.number)}</strong></td>
          ${visibleFields.map((f) => `<td>${UI.esc(String(r.data[f.key] ?? ''))}</td>`).join('')}
          <td><span class="badge-pill status-${UI.esc(r.status)}">${UI.esc(r.status)}</span></td>
          <td>${UI.esc(UI.fmtDateShort(r.created_at))}</td>
          <td class="actions">
            ${isPayroll ? `<button class="icon-btn" data-print="${r.id}" title="Print this slip">${UI.icon('printer')}</button>` : ''}
            ${!isPayroll && formDef.template_id ? `<button class="icon-btn" data-print-tpl="${r.id}" title="Print">${UI.icon('printer')}</button>` : ''}
            <button class="icon-btn" data-edit="${r.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${r.id}" title="Delete">${UI.icon('trash')}</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    // Select-all checkbox
    el.querySelector('#fr-check-all').onchange = (e) => {
      records.forEach((r) => e.target.checked ? selectedIds.add(r.id) : selectedIds.delete(r.id));
      syncSelection();
    };
    // Per-row checkboxes
    el.querySelectorAll('[data-row-check]').forEach((cb) => {
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        const id = Number(cb.dataset.rowCheck);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        syncSelection();
      };
    });

    el.querySelectorAll('[data-print]').forEach((b) =>
      b.onclick = (e) => {
        e.stopPropagation();
        const r = records.find((x) => String(x.id) === String(b.dataset.print));
        if (r) printSlips([r.data]);
      });
    el.querySelectorAll('[data-print-tpl]').forEach((b) =>
      b.onclick = (e) => {
        e.stopPropagation();
        const r = records.find((x) => String(x.id) === String(b.dataset.printTpl));
        if (r) printRecordsViaTemplate([r]);
      });
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

    // For payroll records, append a Net Pay field so users can correct the value.
    const netPayField = isPayroll ? `
      <div style="margin-bottom:12px;padding:10px;background:var(--surface-2,#f5f7fa);border-radius:8px">
        <label for="fr-field-net_pay" style="font-weight:600">Net Pay</label>
        <input data-field="net_pay" id="fr-field-net_pay" type="number" step="0.01"
          value="${data.net_pay != null ? UI.esc(String(data.net_pay)) : ''}" />
        <div class="muted" style="font-size:11px;margin-top:4px">Auto-filled from CSV. Edit to correct if needed.</div>
      </div>` : '';

    UI.modal({
      title: editing ? `Edit ${existing.number}` : `New ${formDef.name}`,
      size: formDef.fields.length > 6 ? 'lg' : undefined,
      bodyHTML: `
        <div style="margin-bottom:14px">
          <label>Status</label>
          <select data-f="status">${statusOpts}</select>
        </div>
        ${formDef.fields.map((field) => renderFieldInput(field, data)).join('')}
        ${netPayField}
        ${formDef.fields.length === 0 && !isPayroll
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
        // For payroll forms, also capture the net_pay value.
        if (isPayroll) {
          const netPayInp = ov.querySelector('[data-field="net_pay"]');
          if (netPayInp) collected.net_pay = netPayInp.value ? Number(netPayInp.value) : 0;
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
