/* Form Records: index of all custom forms, or records list for a specific form.
   Route: form-records.  filter.form_id = <id> to open a specific form directly. */
const FORM_RECORDS_SCOPE_LABELS = { hr: 'HR', inventory: 'Inventory', admin: 'Admin', accounting: 'Accounting' };
const FORM_RECORDS_SCOPE_ORDER = ['hr', 'inventory', 'admin', 'accounting', null];

// Set by App.openFormRecordDraft just before navigating here; consumed once by
// renderFormView to pop a pre-filled "New record" modal. Kept off the URL filter so a big
// proposed payload doesn't end up in the address bar.
let pendingFormDraft = null;

App.register('form-records', async (view, filter) => {
  filter = filter || {};
  // filter.slug — jump straight to one form by its slug (HR nav's "Payroll" -> hr_payroll),
  // resolved to an id the same way hr.js's openDataForm does.
  if (filter.slug && !filter.form_id) {
    try {
      const forms = await API.get('/form-definitions');
      const f = forms.find((x) => x.slug === filter.slug);
      if (f) { await renderFormView(view, f.id, filter.period || '', filter.status || ''); return; }
    } catch { /* fall through to the index */ }
  }
  if (filter.form_id) {
    await renderFormView(view, Number(filter.form_id), filter.period || '', filter.status || '');
  } else {
    await renderIndex(view, filter.scope || '');
  }
});

/* Open a specific form's "New record" modal pre-filled with `proposal.data` — used by the AI
   assistant's "Review & issue" button (public/js/tools.js). */
App.openFormRecordDraft = async function (proposal) {
  if (!proposal) return;
  let id = proposal.form_def_id;
  if (!id && proposal.slug) {
    try {
      const forms = await API.get('/form-definitions');
      const f = forms.find((x) => x.slug === proposal.slug);
      id = f && f.id;
    } catch { /* ignore */ }
  }
  if (!id) { UI.toast('That form could not be found', 'error'); return; }
  pendingFormDraft = { formId: Number(id), data: proposal.data || {} };
  App.navigate('form-records', { form_id: String(id) });
};

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
async function renderIndex(view, onlyScope) {
  const heading = onlyScope
    ? `${FORM_RECORDS_SCOPE_LABELS[onlyScope] || onlyScope} Forms`
    : 'Data Forms';
  view.innerHTML = `
    <div class="topbar"><h2>${UI.esc(heading)}</h2></div>
    <div class="panel"><div id="fr-index"></div></div>`;
  const el = view.querySelector('#fr-index');
  el.innerHTML = '<div class="empty">Loading…</div>';

  let forms = await API.get('/form-definitions');
  if (onlyScope) forms = forms.filter((f) => f.scope === onlyScope);
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
async function renderFormView(view, formId, initialPeriod, initialStatus) {
  let formDef = null;
  let searchTimer;
  let currentRecords = [];
  let selectedIds = new Set();
  const state = { q: '', status: initialStatus || '', period: initialPeriod || '' };
  // Payroll "All periods" view: attendance_periods rows (id/dates), matched to a payslip's
  // free-text `period` label — that label is independently editable at Generate Payslips time
  // (see hr.routes.ts), so a match isn't guaranteed. A bundle with no match still shows its
  // stats, just without the id-dependent quick actions (Export CSV, Post to GL).
  let periodsMeta = [];
  const expandedBundles = new Set(); // period labels the user has toggled open
  // Defaults the most-recent bundle open exactly once, on the very first render — without
  // this flag, collapsing that same bundle empties the set again, and the "default open"
  // fallback below would immediately re-add it right back, making it look like clicking to
  // collapse just did nothing.
  let bundlesDefaultApplied = false;

  try { formDef = await API.get('/form-definitions/' + formId); }
  catch { view.innerHTML = '<div class="empty">Form not found.</div>'; return; }

  // Browsing a section's records needs the same forms.manage.<scope> permission as managing
  // them — there's no separate view-only tier for this system (mirrors the server-side gate in
  // form-builder.routes.ts's canManageScope). Checked client-side too so a user without access
  // gets a clean message instead of a raw 403 from the records fetch below.
  const canBrowse = formDef.scope
    ? App.hasPermission('forms.manage.' + formDef.scope)
    : ['hr', 'inventory', 'admin', 'accounting'].every((s) => App.hasPermission('forms.manage.' + s));
  if (!canBrowse) {
    view.innerHTML = `<div class="topbar">
        <button class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} All Forms</button>
        <h2 style="margin-left:10px">${UI.esc(formDef.name)}</h2>
      </div>
      <div class="panel">${UI.emptyState({
        icon: 'key',
        title: 'No access to this form’s records',
        hint: 'Filed one yourself? Open Requests in the mobile app to see your own submissions and their status.',
      })}</div>`;
    view.querySelector('#fr-back').onclick = () => App.navigate('form-records');
    return;
  }

  const isPayroll = formDef.slug === 'hr_payroll';
  const canManagePayroll = isPayroll && App.hasPermission('hr.manage');
  // Any other form with a linked print template gets the same "Print All"/"Print selected"
  // bulk actions payroll has always had — payroll keeps its own dedicated 2-up slip buttons.
  const canBulkPrint = !isPayroll && !!formDef.template_id;

  // Fetched once, lazily, only if this form actually has an 'employee' field — most forms don't.
  let employeesCache = null;
  async function getEmployees() {
    if (!employeesCache) employeesCache = await API.get('/hr/employees').catch(() => []);
    return employeesCache;
  }

  view.innerHTML = `
    <div class="topbar">
      <button class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} All Forms</button>
      <h2 style="margin-left:10px">${UI.esc(formDef.name)}</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="fr-search" placeholder="${isPayroll ? 'Search employee name…' : 'Search number…'}" /></div>
      <select id="fr-status" style="margin-left:8px">
        <option value="" ${state.status ? '' : 'selected'}>All statuses</option>
        ${['pending', 'draft', 'submitted', 'approved', 'rejected', 'completed'].concat(isPayroll ? ['paid'] : [])
          .map((s) => `<option value="${s}" ${state.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      ${isPayroll ? `
        <select id="fr-period" style="margin-left:8px;padding:6px 8px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:13px" title="Filter by payroll period">
          <option value="">All periods</option>
        </select>
        <button class="btn secondary" id="fr-import-csv" style="margin-left:8px">${UI.icon('upload')} Upload CSV</button>
        <button class="btn secondary" id="fr-print-slips" style="margin-left:8px">${UI.icon('printer')} Print All</button>` : ''}
      ${canBulkPrint ? `<button class="btn secondary" id="fr-print-all-tpl" style="margin-left:8px">${UI.icon('printer')} Print All</button>` : ''}
      <button class="btn secondary" id="fr-download-csv" style="margin-left:8px" title="${isPayroll ? 'Download the currently filtered payslips as a styled Excel workbook, with summary and per-department totals' : 'Download the currently filtered records as a CSV file'}">${UI.icon('download')} ${isPayroll ? 'Download Excel' : 'Download CSV'}</button>
      <button class="btn secondary danger" id="fr-del-all" style="margin-left:8px" title="Delete all currently visible records">${UI.icon('trash')} Delete Period</button>
      <button class="btn" id="fr-new" style="margin-left:8px">${UI.icon('plus')} New Record</button>
    </div>
    <div id="fr-bulk-bar" style="display:none;align-items:center;gap:8px;padding:7px 16px;background:var(--accent-weak,#e7f1ff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0">
      <span id="fr-sel-count" style="font-weight:700;font-size:13px;color:var(--accent,#2b7fff)">0 selected</span>
      <div style="flex:1"></div>
      ${isPayroll ? `<button class="btn secondary small" id="fr-bulk-print">${UI.icon('printer')} Print selected</button>` : ''}
      ${canBulkPrint ? `<button class="btn secondary small" id="fr-bulk-print-tpl">${UI.icon('printer')} Print selected</button>` : ''}
      <button class="btn secondary small" id="fr-bulk-status">${UI.icon('edit', 14)} Change status</button>
      ${isPayroll && canManagePayroll ? `
        <button class="btn secondary small" id="fr-bulk-mark-paid">${UI.icon('check')} Mark paid</button>
        <button class="btn secondary small" id="fr-bulk-unmark-paid">${UI.icon('reply', 15)} Unmark paid</button>` : ''}
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
  view.querySelector('#fr-download-csv').onclick = () => downloadCsv();
  view.querySelector('#fr-del-all').onclick = () => delAll();
  view.querySelector('#fr-bulk-del').onclick = () => delSelected();
  view.querySelector('#fr-bulk-clear').onclick = () => { selectedIds.clear(); syncSelection(); };
  view.querySelector('#fr-bulk-status').onclick = () => bulkChangeStatus();
  if (isPayroll && canManagePayroll) {
    view.querySelector('#fr-bulk-mark-paid').onclick = () => bulkSetPaid(true);
    view.querySelector('#fr-bulk-unmark-paid').onclick = () => bulkSetPaid(false);
  }

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
    // One check-all per table — the plain view has exactly one (#fr-check-all); the grouped
    // payroll view has one per bundle ([data-check-all]), each scoped to just its own table's rows.
    tableEl.querySelectorAll('#fr-check-all, [data-check-all]').forEach((allCb) => {
      const rowChecks = [...allCb.closest('table').querySelectorAll('[data-row-check]')];
      allCb.checked = rowChecks.length > 0 && rowChecks.every((cb) => selectedIds.has(Number(cb.dataset.rowCheck)));
      allCb.indeterminate = !allCb.checked && rowChecks.some((cb) => selectedIds.has(Number(cb.dataset.rowCheck)));
    });
    updateBulkBar();
  }

  // Item 5: one "are you sure" per record, not a single combined confirm for the whole batch —
  // each delete is its own irreversible action, so a rushed single "yes" can't take out more
  // than the user actually meant to. Cancelling one skips just that record and moves on.
  async function delSelected() {
    if (!selectedIds.size) return;
    const targets = currentRecords.filter((r) => selectedIds.has(r.id));
    let deleted = 0, skipped = 0, failed = 0;
    for (const r of targets) {
      const ok = await UI.confirmDialog(`Delete record ${r.number}? Cannot be undone.`, 'Delete');
      if (!ok) { skipped++; continue; }
      try { await API.del('/form-records/' + r.id); deleted++; }
      catch (e) { failed++; UI.toast(`${r.number}: ${e.message}`, 'error'); }
    }
    selectedIds.clear();
    if (deleted) UI.toast(`${deleted} record${deleted === 1 ? '' : 's'} deleted${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`);
    else if (skipped) UI.toast('Nothing deleted');
    load();
  }

  // Batch status change — works for any form's records (not just payroll). Same one-confirm-
  // per-record convention as delSelected() above: a rushed single "yes" can't apply a status
  // change to more records than the user actually meant to, and cancelling one just skips it.
  // A record already paid is locked (server 423s the generic PUT — see form-builder.routes.ts)
  // and is skipped without even asking; 'paid' itself isn't offered here — that's only ever set
  // via the dedicated Mark Paid action, same restriction the single-record editor already has.
  async function bulkChangeStatus() {
    if (!selectedIds.size) { UI.toast('No records selected', 'error'); return; }
    const targets = currentRecords.filter((r) => selectedIds.has(r.id));

    const statusOpts = ['draft', 'submitted', 'approved', 'rejected', 'completed'];
    // Same resolve(true/false)-on-[data-close] wrapping UI.confirmDialog itself uses (ui.js) —
    // the only supported way to read "confirmed vs cancelled" out of a modal that also needs
    // to hand back a value (the picked status), not just a yes/no.
    const newStatus = await new Promise((resolve) => {
      const m = UI.modal({
        title: `Change status — ${targets.length} record${targets.length === 1 ? '' : 's'}`,
        bodyHTML: `<label>New status</label>
          <select data-f="status">${statusOpts.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
          <p class="muted" style="font-size:12px;margin-top:8px">Asks separately for each record — cancel any single one to leave it as-is.</p>`,
        confirmText: 'Continue',
        onConfirm: (ov) => { resolve(ov.querySelector('[data-f="status"]').value); },
      });
      m.overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(null)));
    });
    if (!newStatus) return; // cancelled

    let changed = 0, skipped = 0, failed = 0;
    for (const r of targets) {
      if (r.status === newStatus) { skipped++; continue; }
      if (r.status === 'paid') { skipped++; continue; } // locked — unmark paid first
      const ok = await UI.confirmDialog(`Set ${r.number} to "${newStatus}"?`, 'Change');
      if (!ok) { skipped++; continue; }
      try { await API.put('/form-records/' + r.id, { data: r.data, status: newStatus }); changed++; }
      catch (e) { failed++; UI.toast(`${r.number}: ${e.message}`, 'error'); }
    }
    selectedIds.clear();
    if (changed) UI.toast(`${changed} record${changed === 1 ? '' : 's'} updated${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`);
    else if (skipped) UI.toast('Nothing changed');
    load();
  }

  // Batch Mark/Unmark Paid (payroll only). Same per-record confirm convention as above — a
  // payslip already in the target state is skipped without asking (nothing to confirm).
  async function bulkSetPaid(toPaid) {
    if (!selectedIds.size) { UI.toast('No records selected', 'error'); return; }
    const targets = currentRecords.filter((r) => selectedIds.has(r.id));
    const verb = toPaid ? 'Mark' : 'Unmark';
    const endpoint = toPaid ? 'mark-paid' : 'unmark-paid';
    let changed = 0, skipped = 0, failed = 0;
    for (const r of targets) {
      const already = toPaid ? r.status === 'paid' : r.status !== 'paid';
      if (already) { skipped++; continue; }
      const ok = await UI.confirmDialog(`${verb} ${r.number} as paid?`, verb);
      if (!ok) { skipped++; continue; }
      try { await API.post(`/hr/payroll/${r.id}/${endpoint}`, {}); changed++; }
      catch (e) { failed++; UI.toast(`${r.number}: ${e.message}`, 'error'); }
    }
    selectedIds.clear();
    if (changed) UI.toast(`${changed} payslip${changed === 1 ? '' : 's'} ${toPaid ? 'marked' : 'unmarked'} paid${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`);
    else if (skipped) UI.toast('Nothing changed');
    load();
  }

  async function printSelected() {
    if (!selectedIds.size) { UI.toast('No records selected', 'error'); return; }
    const list = currentRecords.filter((r) => selectedIds.has(r.id)).map((r) => r.data);
    printSlips(list);
  }

  // Generic — works for any form, not just payroll. Exports whatever's currently filtered
  // (search/status/period), one row per record, columns driven by the form's own field list.
  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // `records`/`labelHint` are only passed by a payroll bundle's own "Export Excel" button
  // (scopes the download to just that period); the top-level header button calls this with no
  // args, exporting whatever's currently filtered — unchanged from before.
  //
  // Payroll gets a real styled .xlsx (colored header/summary/department bands, currency +
  // date cell formats — see hr-payroll-export.js; CSV is plain text and can't carry any of
  // that). Every other form keeps the original plain-CSV export, unchanged.
  function downloadCsv(records, labelHint) {
    const list = records || currentRecords;
    if (!list.length) { UI.toast('No records to export', 'error'); return; }
    const baseName = `${(formDef.slug || 'records') + (labelHint || state.period ? '-' + (labelHint || state.period) : '')}`.replace(/[^a-z0-9._-]+/gi, '_');

    if (isPayroll) {
      if (typeof downloadPayrollWorkbook === 'undefined' || typeof XLSX === 'undefined') {
        UI.toast('Excel export module failed to load', 'error');
        return;
      }
      // The period IS the workbook's title (a bundle's own labelHint, else whatever period is
      // selected) — only an unfiltered "All periods" export has no single period to name it
      // after, so that falls back to the form's own name instead.
      const title = labelHint || state.period || formDef.name;
      const subtitle = `${list.length} payslip${list.length === 1 ? '' : 's'}` +
        (!labelHint && !state.period && state.status ? ` — status "${state.status}"` : '');
      downloadPayrollWorkbook(list, formDef, { title, subtitle, filename: `${baseName}.xlsx` });
      return;
    }

    const headers = ['Number', ...formDef.fields.map((f) => f.label), 'Status', 'Date'];
    const rows = list.map((r) => [
      r.number,
      ...formDef.fields.map((f) => r.data[f.key] ?? ''),
      r.status,
      UI.fmtDateShort(r.created_at),
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM so Excel reads UTF-8 correctly
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      onOpen: (ov) => {
        const ifr = ov.querySelector('#payslip-preview-frame');
        // Once the slip HTML has actually rendered (real layout needed — scrollHeight is
        // meaningless before then), shrink any cell whose content overflows its fixed-height
        // grid cell instead of leaving it silently clipped by .payslip-grid's overflow:hidden.
        ifr.onload = () => { if (typeof fitPayslipCells === 'function') fitPayslipCells(ifr.contentDocument); };
        ifr.srcdoc = full;
      },
      onConfirm: (ov) => {
        const ifr = ov.querySelector('#payslip-preview-frame');
        ifr.contentWindow.focus();
        ifr.contentWindow.print();
        return false; // keep the preview open — printing shouldn't close it
      },
    });
  }

  // Same Day Type badge vocabulary hr-timekeeping.js's Daily Time grid already shows — kept
  // duplicated (not shared) rather than requiring that view's script on this page just for one
  // lookup table.
  const DETAIL_HOLIDAY_LABELS = {
    regular: 'Regular Holiday', special_non_working: 'Special Non-Working', special_working: 'Special Working',
    cancelled_paid: 'Cancelled (Paid)', cancelled_unpaid: 'Cancelled (Unpaid)',
  };
  function detailDayTag(d) {
    if (d.holiday) {
      const isCancellation = d.holiday === 'cancelled_paid' || d.holiday === 'cancelled_unpaid';
      return `<span class="badge-pill ${isCancellation ? 'status-cancelled' : 'status-completed'}">${UI.esc(DETAIL_HOLIDAY_LABELS[d.holiday] || d.holiday)}</span>`;
    }
    if (d.no_work) {
      return `<span class="badge-pill ${d.no_work === 'paid' ? 'status-completed' : 'status-cancelled'}">No Work (${d.no_work === 'paid' ? 'Paid' : 'Unpaid'})</span>`;
    }
    if (d.is_rest_day) return '<span class="badge-pill status-confirmed">Rest Day</span>';
    if (d.status === 'below_minimum_denied') return '<span class="badge-pill status-cancelled" title="Under the configured minimum work time, HR denied pay for it">Below Min — Denied</span>';
    if (d.status === 'absent') return '<span class="badge-pill status-cancelled">Absent</span>';
    if (d.status === 'paid_leave') return '<span class="badge-pill status-completed">Paid Leave</span>';
    if (d.half_day_manual) return '<span class="badge-pill status-confirmed" title="HR manually credited this day a half day (0.5 day) on the Daily Time grid — no Half Day request was ever filed for it.">Half Day (recorded, no request)</span>';
    if (d.possible_half_day) return '<span class="badge-pill status-confirmed" title="This day\'s times look like a half day with no Half Day request linked — it\'s paid as a half day (0.5 day, judged against just that AM/PM window), but file the actual Half Day request on the Daily Time grid to keep the record straight.">Half Day (unlinked)</span>';
    if (d.status === 'half_day') return '<span class="badge-pill status-confirmed" title="Judged against just this half\'s own AM/PM window, not the full shift">Half Day</span>';
    if (d.status === 'undertime') return `<span class="badge-pill status-cancelled" title="Under the configured whole-day minimum — paid proportionally for actual hours present (${UI.money(d.undertime_day_pay)}), not counted as a whole day worked">Undertime Day</span>`;
    if (d.below_minimum) return '<span class="badge-pill status-confirmed" title="Under the configured minimum work time — still paid for actual hours (allowed by default)">Below Min — Allowed</span>';
    return '';
  }

  // Read-only "why does my payslip say X" view — opened by clicking a payroll row's body (see
  // the tr[data-id] wiring below). Shows the exact same slip visual (reusing renderSlip from
  // hr-payroll-print.js, same template printSlips() uses) plus a per-day breakdown fetched from
  // the server route that reruns the exact resolution+compute generate-payslips itself used, so
  // these numbers can never disagree with what's actually on the payslip. Never opens an
  // editable form — Edit (the pencil icon, stopPropagation'ed) is the only way into that now.
  async function payslipDetailModal(r) {
    let detail;
    try {
      detail = await API.get(`/hr/payroll/${r.id}/detail`);
    } catch (err) {
      UI.modal({
        title: `Payslip — ${r.data.employee_name || 'Unknown employee'}`,
        bodyHTML: `<p class="muted">${UI.esc(err.message)}</p>`,
        cancelText: 'Close',
      });
      return;
    }

    let templateBody;
    try {
      const templates = await API.get('/templates');
      const meta = templates.find((t) => t.name === 'HR Payroll Slip');
      if (meta) templateBody = (await API.get('/templates/' + meta.id)).body;
    } catch { /* fall back to renderSlip's own built-in default layout */ }
    const slipHtml = typeof renderSlip === 'function' ? renderSlip(r.data, templateBody) : '';

    const rows = detail.days.map((d) => `
      <tr>
        <td>${UI.esc(d.work_date)}</td>
        <td>${UI.esc(d.time_in || '—')}</td>
        <td>${UI.esc(d.time_out || '—')}</td>
        <td>${detailDayTag(d) || '<span class="muted">—</span>'}</td>
        <td>${d.late_minutes ? `${d.late_minutes} min<div class="muted" style="font-size:11px">${detail.late_exempt ? 'exempt' : UI.money(d.late_pay)}</div>` : '—'}</td>
        <td>${d.undertime_minutes ? `${d.undertime_minutes} min<div class="muted" style="font-size:11px">${UI.money(-d.undertime_pay)}</div>` : '—'}</td>
        <td>${d.ot_hours ? `${d.ot_hours.toFixed(2)} hr<div class="muted" style="font-size:11px">${UI.money(d.ot_pay)}</div>` : '—'}</td>
        <td>${d.day_premium_pay ? UI.money(d.day_premium_pay) : '—'}</td>
        <td>${d.night_diff_pay ? UI.money(d.night_diff_pay) : '—'}</td>
      </tr>`).join('');

    const locked = r.status === 'paid';
    const DED_LABELS = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', withholding_tax: 'Withholding Tax' };
    const dedSection = canManagePayroll ? `
      <div class="panel" style="margin-bottom:14px;padding:12px 14px">
        <strong>Statutory Deductions</strong>
        <p class="muted" style="font-size:12px;margin:2px 0 10px">Turn off any deduction that shouldn't apply to
          this one payslip — the slip above updates instantly as you toggle (withholding tax's own taxable base
          moves too), nothing is saved until you click Save.</p>
        <div style="display:flex;flex-wrap:wrap;gap:16px">
          ${Object.keys(DED_LABELS).map((k) => `
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
              <input type="checkbox" data-ded="${k}" style="width:auto" ${r.data[k + '_applied'] !== false ? 'checked' : ''} ${locked ? 'disabled' : ''} />
              ${DED_LABELS[k]}
            </label>`).join('')}
        </div>
        <hr style="margin:14px 0;border:none;border-top:1px solid var(--border,#dce6f2)" />
        <strong>Other Deductions</strong>
        <p class="muted" style="font-size:12px;margin:2px 0 10px">Ad-hoc lines for this one payslip — Cash Advance,
          uniform, misc, etc. — auto-deducted from the total the same as SSS/etc. above. No running balance is
          tracked across cutoffs; re-add a remaining Cash Advance balance next cutoff if there is one.</p>
        <div id="pd-other-ded-list"></div>
        ${!locked ? `
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:140px"><label style="font-size:12px">Label</label><input id="pd-other-ded-label" placeholder="e.g. Cash Advance" /></div>
          <div style="width:120px"><label style="font-size:12px">Amount</label><input id="pd-other-ded-amount" type="number" min="0" step="0.01" /></div>
          <button type="button" class="btn secondary small" id="pd-other-ded-add">${UI.icon('plus', 14)} Add</button>
        </div>` : ''}
        ${locked
          ? `<p class="muted" style="font-size:12px;margin-top:8px">This payslip is marked Paid — unmark it first to change its deductions.</p>`
          : `<button type="button" class="btn small" id="pd-ded-save" style="margin-top:14px">Save Deductions</button>`}
      </div>` : '';

    UI.modal({
      title: `Payslip — ${detail.employee_name}`,
      size: 'xl',
      headActionHTML: `<button type="button" class="btn secondary small" id="pd-print">${UI.icon('printer')} Print</button>`,
      bodyHTML: `
        <div id="pd-slip" style="border:1px solid var(--border-strong);border-radius:8px;padding:8px;margin-bottom:14px;background:#fff;color:#111">${slipHtml}</div>
        ${detail.late_exempt ? `<p class="muted" style="font-size:12px;margin:0 0 8px">This employee is exempt from late deductions —
          late minutes are still shown below for reference, but never subtracted from pay.</p>` : ''}
        ${dedSection}
        <div class="line-items"><table class="line-table"><thead><tr>
          <th>Date</th><th>Time In</th><th>Time Out</th><th>Day Type</th><th>Late</th><th>Undertime</th><th>OT</th><th>Holiday/Rest-Day Premium</th><th>Night Diff</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">No attendance recorded for this period</td></tr>'}</tbody></table></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        // Local working copy — the print button and any live edits below use this, never
        // mutating the caller's own `r.data` unless/until Save actually persists it, so
        // closing without saving leaves the record (and the list behind this modal) untouched.
        let liveData = { ...r.data };
        const btn = ov.querySelector('#pd-print');
        if (btn) btn.onclick = () => printSlips([liveData]);

        const dedCheckboxes = ov.querySelectorAll('[data-ded]');
        if (!dedCheckboxes.length) return;
        const slipEl = ov.querySelector('#pd-slip');
        // Local working copy of the ad-hoc lines — same "nothing persists until Save" rule as
        // the statutory checkboxes above, mutated by the add/remove UI below and re-rendered
        // into #pd-other-ded-list each time.
        let otherDeductions = Array.isArray(r.data.other_deductions) ? r.data.other_deductions.map((d) => ({ ...d })) : [];
        const otherDedListEl = ov.querySelector('#pd-other-ded-list');
        function renderOtherDedList() {
          otherDedListEl.innerHTML = otherDeductions.length
            ? otherDeductions.map((d, i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border,#eee)">
                  <span>${UI.esc(d.label)}</span>
                  <span style="display:flex;align-items:center;gap:10px">
                    ${UI.money(d.amount)}
                    ${!locked ? `<button type="button" class="icon-btn" data-other-ded-del="${i}" title="Remove">${UI.icon('trash', 14)}</button>` : ''}
                  </span>
                </div>`).join('')
            : '<p class="muted" style="font-size:12.5px;margin:2px 0">No other deductions on this payslip.</p>';
          otherDedListEl.querySelectorAll('[data-other-ded-del]').forEach((b) => b.onclick = () => {
            otherDeductions.splice(Number(b.dataset.otherDedDel), 1);
            renderOtherDedList();
            refreshPreview();
          });
        }
        renderOtherDedList();
        const addBtn = ov.querySelector('#pd-other-ded-add');
        if (addBtn) {
          addBtn.onclick = () => {
            const labelInp = ov.querySelector('#pd-other-ded-label');
            const amountInp = ov.querySelector('#pd-other-ded-amount');
            const label = labelInp.value.trim();
            const amount = Number(amountInp.value);
            if (!label || !(amount > 0)) { UI.toast('Enter a label and an amount greater than 0', 'error'); return; }
            otherDeductions.push({ label, amount });
            labelInp.value = ''; amountInp.value = '';
            renderOtherDedList();
            refreshPreview();
          };
        }

        const currentApplied = () => {
          const applied = { other_deductions: otherDeductions };
          dedCheckboxes.forEach((cb) => { applied[cb.dataset.ded + '_applied'] = cb.checked; });
          return applied;
        };
        // Re-renders the ACTUAL slip visual with the recomputed numbers — this is the one
        // thing the user is looking at, not a separate summary table off to the side.
        const applyPreview = (vals) => {
          liveData = { ...liveData, ...vals };
          slipEl.innerHTML = typeof renderSlip === 'function' ? renderSlip(liveData, templateBody) : slipEl.innerHTML;
        };
        const refreshPreview = async () => {
          dedCheckboxes.forEach((cb) => { cb.disabled = locked; });
          try { applyPreview(await API.post(`/hr/payroll/${r.id}/preview-deductions`, currentApplied())); }
          catch (err) { UI.toast(err.message, 'error'); }
        };
        dedCheckboxes.forEach((cb) => cb.addEventListener('change', refreshPreview));

        const saveBtn = ov.querySelector('#pd-ded-save');
        if (saveBtn) {
          saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            try {
              const vals = await API.put(`/hr/payroll/${r.id}/deductions`, currentApplied());
              applyPreview(vals);
              r.data = liveData; // so the row behind this modal reflects it once it closes
              UI.toast('Deductions saved');
              load();
            } catch (err) { UI.toast(err.message, 'error'); }
            finally { saveBtn.disabled = false; }
          };
        }
      },
    });
  }

  // Print one or many records through the form's linked template (data filled in) — additive
  // to, not a replacement for, the payroll-specific printSlips() above (which stays the
  // specialized 2-up slip layout for hr_payroll). Any other form that has a template linked in
  // Form Builder can print its records this way, including "Print All"/"Print selected". By
  // default each record renders as its own page (page-break-after between them); if the
  // template opts into a grid (Layout tab > Print Grid: rows/columns/fill mode), records are
  // tiled N-up instead via print-tiling.js's buildTiledPagesHtml — the same layout
  // hr-payroll-print.js hand-built for payroll, generalized for any template.
  async function printRecordsViaTemplate(records) {
    if (!formDef.template_id) { UI.toast('No print template linked to this form', 'error'); return; }
    if (!records.length) { UI.toast('No records to print', 'error'); return; }
    let tpl;
    try { tpl = await API.get('/templates/' + formDef.template_id); }
    catch { UI.toast('The linked template could not be loaded', 'error'); return; }
    let company = {};
    try { company = await API.get('/templates/company'); } catch { /* optional */ }
    const renderRecord = (r) => renderTemplate(tpl.body, { ...r.data, record: { number: r.number, status: r.status, created_at: r.created_at }, company });
    const tiled = (typeof buildTiledPagesHtml === 'function')
      ? buildTiledPagesHtml(records, renderRecord, {
        copiesPerRecord: tpl.copies_per_record, recordsPerPage: tpl.records_per_page, tileFill: tpl.tile_fill,
        continuous: !!tpl.tile_continuous, repeatCount: tpl.repeat_count,
        pageContentHeightMm: typeof pageContentHeightMm === 'function' ? pageContentHeightMm(tpl.body) : undefined,
      })
      : '';
    const html = tiled || records.map((r, i) => (i < records.length - 1 ? `<div style="page-break-after:always">${renderRecord(r)}</div>` : renderRecord(r))).join('');
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
        const ifr = ov.querySelector('#fr-tpl-preview-frame');
        // Same shrink-to-fit as printSlips()'s fitPayslipCells() above, generalized for any
        // tiled template: once the tiled grid has actually rendered (real layout needed),
        // shrink any cell whose content overflows its fixed-height grid cell instead of
        // leaving it silently clipped by .tiled-grid's overflow:hidden.
        if (tiled) ifr.onload = () => { if (typeof fitTiledCells === 'function') fitTiledCells(ifr.contentDocument); };
        ifr.srcdoc = full;
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
      // Only needed for the grouped "All periods" bundle view below — skip the extra request
      // otherwise (a single period selected already scopes everything, no grouping to do).
      if (!state.period) {
        periodsMeta = await API.get('/hr/periods').catch(() => []);
      }
    }
    renderRecords(records);
  }

  // Shared with downloadCsv()'s Excel export, so the file's subtitle always reads the same as
  // what's on screen. labelHint (a payroll bundle's own period) overrides the state.period/
  // state.status filter — that's the only case a caller ever passes it.
  function payslipPeriodLabel(labelHint) {
    if (labelHint) return `for "${labelHint}"`;
    return state.period ? `for "${state.period}"` : (state.status ? `for status "${state.status}"` : '(all periods shown)');
  }

  // Item 3: a total-salary summary for the currently-filtered payslips (usually one payroll
  // period, via the period dropdown — but works for whatever's on screen, e.g. a status
  // filter too). Summed client-side from the already-loaded records' data, no extra request.
  function payslipSummaryHTML(records) {
    if (!isPayroll || !records.length) return '';
    const num = (v) => Number(v) || 0;
    const sum = (key) => records.reduce((s, r) => s + num(r.data[key]), 0);
    const gross = sum('total_earnings');
    const statutory = sum('sss') + sum('philhealth') + sum('pagibig') + sum('withholding_tax');
    const otherDeductions = sum('total_deductions') - statutory;
    const totalDeductions = sum('total_deductions');
    const net = sum('net_pay');
    const label = payslipPeriodLabel();
    const cell = (l, v) => `<div><div class="muted" style="font-size:11px">${UI.esc(l)}</div><div style="font-weight:700;font-size:15px">${UI.money(v)}</div></div>`;
    return `<div class="panel" style="margin-bottom:14px;padding:12px 16px">
      <div class="muted" style="font-size:12px;margin-bottom:8px">Summary — ${records.length} payslip${records.length === 1 ? '' : 's'} ${UI.esc(label)}</div>
      <div style="display:flex;gap:28px;flex-wrap:wrap">
        ${cell('Total Gross', gross)}
        ${cell('Statutory (SSS/PhilHealth/Pag-IBIG/Tax)', statutory)}
        ${cell('Other Deductions', otherDeductions)}
        ${cell('Total Deductions', totalDeductions)}
        ${cell('Total Net Pay', net)}
      </div>
    </div>`;
  }

  // Column headers + one <table> for a set of records — used both for the plain (ungrouped)
  // view and, once per period, inside each collapsible bundle below. `checkAllAttr` lets each
  // caller give its own "select all" checkbox a distinct hook (a literal id would collide once
  // there's more than one table on screen).
  function tableHTML(records, checkAllAttr) {
    const visibleFields = formDef.fields.slice(0, 4);
    return `<table>
      <thead><tr>
        <th style="width:36px;text-align:center"><input type="checkbox" ${checkAllAttr} title="Select all" /></th>
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
            ${isPayroll && canManagePayroll ? `<button class="icon-btn" data-email="${r.id}" title="Email this payslip">${UI.icon('mail')}</button>` : ''}
            ${isPayroll && canManagePayroll ? (r.status === 'paid'
              ? `<button class="icon-btn" data-unpaid="${r.id}" title="Unmark Paid (unlock for editing)">${UI.icon('reply', 15)}</button>`
              : `<button class="icon-btn" data-paid="${r.id}" title="Mark as Paid (locks this payslip)">${UI.icon('check')}</button>`) : ''}
            ${r.status !== 'paid' ? `<button class="icon-btn" data-edit="${r.id}" title="Edit">${UI.icon('edit')}</button>` : ''}
            ${r.status !== 'paid' ? `<button class="icon-btn danger" data-del="${r.id}" title="Delete">${UI.icon('trash')}</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody></table>`;
  }

  // Same totals payslipSummaryHTML sums, factored out so a bundle header can show them too.
  function payslipTotals(records) {
    const num = (v) => Number(v) || 0;
    const sum = (key) => records.reduce((s, r) => s + num(r.data[key]), 0);
    const gross = sum('total_earnings');
    const statutory = sum('sss') + sum('philhealth') + sum('pagibig') + sum('withholding_tax');
    const totalDeductions = sum('total_deductions');
    return { gross, statutory, otherDeductions: totalDeductions - statutory, totalDeductions, net: sum('net_pay') };
  }

  // Item: "the per payroll timeline should be collapsible, with that payroll's settings
  // visible on the collapsed bundle" — one collapsible section per payroll period instead of
  // one flat table mixing every cutoff together. Only kicks in for payroll's "All periods"
  // view (state.period === '') — a single period already scopes everything, same flat table
  // as before covers that case (and every non-payroll form) with no behavior change.
  function bundlesHTML(records) {
    const groups = new Map();
    for (const r of records) {
      const label = r.period || '(no period)';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    const bundles = [...groups.entries()].map(([label, recs]) => ({
      label, records: recs, meta: periodsMeta.find((p) => p.label === label) || null,
    }));
    // Most recent cutoff first — by its real start_date when known, else fall back to the
    // label itself (periods endpoint already returns labels in DESC order server-side).
    bundles.sort((a, b) => {
      if (a.meta && b.meta) return b.meta.start_date.localeCompare(a.meta.start_date);
      if (a.meta) return -1;
      if (b.meta) return 1;
      return b.label.localeCompare(a.label);
    });
    // Default the most recent bundle open — but only once, on the very first render. Checking
    // "is the set empty" instead of this flag would re-trigger every time the user collapses
    // the last open bundle back down to zero, undoing their own click.
    if (!bundlesDefaultApplied && bundles.length) { expandedBundles.add(bundles[0].label); bundlesDefaultApplied = true; }

    return bundles.map((b) => {
      const open = expandedBundles.has(b.label);
      const t = payslipTotals(b.records);
      const dateRange = b.meta ? `${UI.esc(b.meta.start_date)} – ${UI.esc(b.meta.end_date)} · ` : '';
      return `<div class="panel payroll-bundle" style="margin-bottom:10px;padding:0;overflow:hidden">
        <div class="payroll-bundle-head clickable" data-bundle-toggle="${UI.esc(b.label)}"
             style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 16px">
          <span style="font-size:12px;width:14px;flex-shrink:0">${open ? '▾' : '▸'}</span>
          <div style="min-width:170px">
            <strong>${UI.esc(b.label)}</strong>
            <div class="muted" style="font-size:11.5px">${dateRange}${b.records.length} payslip${b.records.length === 1 ? '' : 's'}</div>
          </div>
          <div style="display:flex;gap:22px;flex-wrap:wrap">
            <div><div class="muted" style="font-size:10.5px">Gross</div><div style="font-weight:700;font-size:13px">${UI.money(t.gross)}</div></div>
            <div><div class="muted" style="font-size:10.5px">Deductions</div><div style="font-weight:700;font-size:13px">${UI.money(t.totalDeductions)}</div></div>
            <div><div class="muted" style="font-size:10.5px">Net Pay</div><div style="font-weight:700;font-size:13px">${UI.money(t.net)}</div></div>
          </div>
          <div class="grow"></div>
          <div class="payroll-bundle-actions" data-bundle-actions style="display:flex;gap:6px" onclick="event.stopPropagation()">
            <button type="button" class="btn secondary small" data-bundle-print="${UI.esc(b.label)}">${UI.icon('printer', 13)} Print All</button>
            <button type="button" class="btn secondary small" data-bundle-csv="${UI.esc(b.label)}">${UI.icon('download', 13)} Export Excel</button>
            ${canManagePayroll && b.meta ? `<button type="button" class="btn secondary small" data-bundle-post-gl="${b.meta.id}" data-bundle-post-gl-label="${UI.esc(b.label)}">${UI.icon('building', 13)} Post to GL</button>` : ''}
          </div>
        </div>
        <div ${open ? '' : 'hidden'} data-bundle-body="${UI.esc(b.label)}" style="border-top:1px solid var(--border,#dce6f2)">
          ${tableHTML(b.records, `data-check-all="${UI.esc(b.label)}"`)}
        </div>
      </div>`;
    }).join('');
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

    const grouped = isPayroll && !state.period;
    el.innerHTML = grouped
      ? bundlesHTML(records)
      : `${payslipSummaryHTML(records)}${tableHTML(records, 'id="fr-check-all"')}`;

    if (grouped) {
      el.querySelectorAll('[data-bundle-toggle]').forEach((head) => head.onclick = (e) => {
        if (e.target.closest('[data-bundle-actions]')) return;
        const label = head.dataset.bundleToggle;
        if (expandedBundles.has(label)) expandedBundles.delete(label); else expandedBundles.add(label);
        renderRecords(records); // cheap re-render — just flips which bundle bodies are hidden
      });
      el.querySelectorAll('[data-bundle-print]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        printSlips(records.filter((r) => (r.period || '(no period)') === b.dataset.bundlePrint).map((r) => r.data));
      });
      el.querySelectorAll('[data-bundle-csv]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        const label = b.dataset.bundleCsv;
        downloadCsv(records.filter((r) => (r.period || '(no period)') === label), label);
      });
      el.querySelectorAll('[data-bundle-post-gl]').forEach((b) => b.onclick = async (e) => {
        e.stopPropagation();
        const label = b.dataset.bundlePostGlLabel;
        if (!await UI.confirmDialog(`Post "${label}" payroll to the General Ledger?`, 'Post to GL')) return;
        try {
          const res = await API.post(`/hr/periods/${b.dataset.bundlePostGl}/post-payroll-gl`, { payroll_period: label });
          UI.toast(`Posted to GL — journal entry ${res.entry ? res.entry.number : ''}`.trim());
        } catch (err) { UI.toast(err.message, 'error'); }
      });
    }

    // Select-all checkbox(es) — one per table (the plain view has exactly one; the grouped
    // view has one per bundle, each scoped to just that bundle's own rows).
    el.querySelectorAll('#fr-check-all, [data-check-all]').forEach((allCb) => {
      allCb.onchange = (e) => {
        const scope = e.target.closest('table').querySelectorAll('[data-row-check]');
        scope.forEach((cb) => {
          const id = Number(cb.dataset.rowCheck);
          if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
        });
        syncSelection();
      };
    });
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
    el.querySelectorAll('[data-email]').forEach((b) =>
      b.onclick = async (e) => {
        e.stopPropagation();
        b.disabled = true;
        try {
          await API.post(`/hr/payroll/${b.dataset.email}/email`, {});
          UI.toast('Payslip emailed');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          b.disabled = false;
        }
      });
    el.querySelectorAll('[data-paid]').forEach((b) =>
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await API.post(`/hr/payroll/${b.dataset.paid}/mark-paid`, {});
          UI.toast('Payslip marked as paid');
          load();
        } catch (err) { UI.toast(err.message, 'error'); }
      });
    el.querySelectorAll('[data-unpaid]').forEach((b) =>
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await API.post(`/hr/payroll/${b.dataset.unpaid}/unmark-paid`, {});
          UI.toast('Payslip unmarked — editable again');
          load();
        } catch (err) { UI.toast(err.message, 'error'); }
      });
    el.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); openRecord(b.dataset.edit, records); });
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); delRecord(b.dataset.del, records); });
    el.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.onclick = (e) => {
        if (e.target.closest('.actions')) return;
        // Payroll rows open the read-only detail view — Edit (the pencil button, already
        // stopPropagation'ed above) is the only way into the editable form for payroll now, so
        // a click meant to "just look" (or an already-paid, locked slip) can't turn into an
        // accidental/confusing edit attempt. Every other form's rows are unaffected.
        if (isPayroll) {
          const r = records.find((x) => String(x.id) === String(tr.dataset.id));
          if (r) payslipDetailModal(r);
          return;
        }
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

  // An 'employee' field auto-fills these sibling fields (if the form has them) from the
  // selected employee — still fully editable afterward, this just saves re-typing the common case.
  const EMPLOYEE_AUTOFILL_MAP = { department: 'department_name', position: 'position', employee_no: 'employee_no', daily_rate: 'daily_rate' };

  /* ── Record create / edit modal ─────────────────────────────────────────── */
  // `prefill` (a plain data object) seeds a brand-new record — used by the AI assistant's
  // "Review & issue" flow so a proposed memo/NTE opens here for the user to confirm.
  async function recordModal(existing, prefill) {
    const editing = !!existing;
    const data = editing ? { ...existing.data } : { ...(prefill || {}) };
    const statusOpts = ['draft', 'submitted', 'approved', 'rejected', 'completed']
      .map((s) => `<option value="${s}" ${(existing ? existing.status : 'draft') === s ? 'selected' : ''}>${s}</option>`)
      .join('');
    const employees = formDef.fields.some((f) => f.type === 'employee') ? await getEmployees() : [];

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
        ${formDef.fields.map((field) => renderFieldInput(field, data, employees)).join('')}
        ${netPayField}
        ${formDef.fields.length === 0 && !isPayroll
          ? '<div class="muted" style="text-align:center;padding:20px">This form has no fields yet. Edit it in Form Builder to add fields.</div>'
          : ''}`,
      onOpen: (ov) => {
        ov.querySelectorAll('select[data-field]').forEach((sel) => {
          const field = formDef.fields.find((f) => f.key === sel.dataset.field);
          if (!field || field.type !== 'employee') return;
          sel.addEventListener('change', () => {
            const emp = employees.find((e) => e.name === sel.value);
            if (!emp) return;
            Object.entries(EMPLOYEE_AUTOFILL_MAP).forEach(([formKey, empKey]) => {
              const target = ov.querySelector(`[data-field="${formKey}"]`);
              if (target && emp[empKey] != null) target.value = String(emp[empKey]);
            });
          });
        });
      },
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

        const res = editing
          ? await API.put('/form-records/' + existing.id, { data: collected, status })
          : await API.post('/form-records', { form_def_id: formId, data: collected, status });
        UI.toast(editing ? 'Record saved' : 'Record created');
        const warns = (res && res.action_warnings) || [];
        if (warns.length) UI.toast('Some actions were skipped: ' + warns.join('; '), 'error');
        load();
      },
    });
  }

  function renderFieldInput(field, data, employees) {
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
    } else if (field.type === 'employee') {
      // Only real employees are selectable (never free text), so this always matches an actual
      // record — critical since Time Keeping/payroll match attendance to forms by exact name.
      const opts = (employees || []).map((e) =>
        `<option value="${UI.esc(e.name)}" ${String(val) === e.name ? 'selected' : ''}>${UI.esc(e.name)}</option>`
      ).join('');
      input = `<select data-field="${UI.esc(field.key)}" id="${id}">
        <option value="">— select employee —</option>${opts}
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
  if (pendingFormDraft && pendingFormDraft.formId === Number(formId)) {
    const d = pendingFormDraft.data;
    pendingFormDraft = null;
    recordModal(null, d);
  }
}
