/* Form Records: index of all custom forms, or records list for a specific form.
   Route: form-records.  filter.form_id = <id> to open a specific form directly. */
const HR_REQUEST_SLUGS = ['leave_request','overtime_request','undertime_request','halfday_request','offset_form','lunch_offset_form','holiday_work_request','travel_order','coe_request','reimbursement_request','loan_application','training_request','incident_report','information_change','rest_day_work_request','rest_day_change'];
const FORM_RECORDS_SCOPE_LABELS = DataForms.labels;
const FORM_RECORDS_SCOPE_ORDER = [...DataForms.scopes, null];
const formRecordViews = new WeakMap();

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
      const f = forms.find(x => x.slug === filter.slug);
      if (!f) throw new Error('This form has not been configured. Ask HR to set it up in Form Builder.');
      await renderFormView(view, f.id, filter.period || '', filter.status || '', filter); return;
    } catch (e) {
      view.innerHTML = `<div class="panel">${UI.emptyState({icon:'alert',title:'Couldn’t open the requested form',hint:e.message,action:'<button class="btn secondary" id="fr-retry-destination">Try again</button>'})}</div>`;
      view.querySelector('#fr-retry-destination').onclick = () => App.navigate('form-records', filter);
      return;
    }
  }
  if (filter.form_id) {
    await renderFormView(view, Number(filter.form_id), filter.period || '', filter.status || '', filter);
  } else {
    await renderIndex(view, filter.scope || '', filter.q || '', filter.view || 'all');
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

function formCardHTML(f, favorite = false) {
  return `<tr class="form-card-item">
    <td><button type="button" class="form-card clickable" data-id="${f.id}" aria-label="Open ${UI.esc(f.name)}">
      <span class="form-card-icon">${UI.icon(f.icon || 'file', 19)}</span><span class="form-card-name">${UI.esc(f.name)}</span>
    </button></td>
    <td class="num">${Number(f.record_count) || 0}</td>
    <td class="num">${f.fields.length}</td>
    <td class="mono">${UI.esc(f.number_prefix)}-#####</td>
    <td>${f.updated_at || f.created_at ? UI.esc(UI.fmtDateShort(f.updated_at || f.created_at)) : '—'}</td>
    <td><button type="button" class="form-favorite icon-btn" data-favorite="${f.id}" aria-pressed="${favorite}" aria-label="${favorite ? 'Remove' : 'Add'} ${UI.esc(f.name)} ${favorite ? 'from' : 'to'} favorites">${favorite ? '★' : '☆'}</button></td>
  </tr>`;
}

/* ── Form index: pick which form to open, grouped by the section that owns it ────── */
async function renderIndex(view, onlyScope, initialQuery, initialView = 'all') {
  const owner = {};
  formRecordViews.set(view, owner);
  if (onlyScope && !DataForms.canBrowseScope(onlyScope === 'general' ? null : onlyScope)) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  let personal = await DataForms.preferences();
  const heading = 'Data Forms';
  const manageableScope = (onlyScope !== 'general' && DataForms.canManage(onlyScope) && onlyScope) || DataForms.scopes.find((scope) => DataForms.canManage(scope));
  view.innerHTML = `
    <div class="topbar"><h2>${UI.esc(heading)}</h2><div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="fr-index-search" placeholder="Search forms…" aria-label="Search forms" /></div>
      <select id="fr-index-scope" aria-label="Form section"><option value="">All sections</option>${FORM_RECORDS_SCOPE_ORDER.filter((scope) => DataForms.canBrowseScope(scope)).map((scope) => `<option value="${scope || 'general'}">${FORM_RECORDS_SCOPE_LABELS[scope || 'general']}</option>`).join('')}</select>
      <select id="fr-index-view" aria-label="Form collection"><option value="all">Active forms</option><option value="favorites">Favorites</option><option value="recent">Recent forms</option><option value="archived">Archived forms</option></select>
      ${manageableScope ? `<button class="btn secondary" id="fr-goto-builder">${UI.icon('edit')} Form Builder</button>` : ''}
    </div>
    <div class="panel"><div id="fr-index"></div></div>`;
  const el = view.querySelector('#fr-index');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const builder = view.querySelector('#fr-goto-builder');
  if (builder) builder.onclick = () => {
    const chosen = view.querySelector('#fr-index-scope').value;
    App.navigate('form-builder', { scope: chosen || manageableScope });
  };
  const search = view.querySelector('#fr-index-search');
  const section = view.querySelector('#fr-index-scope');
  search.value = initialQuery || '';
  section.value = onlyScope || '';
  const collection = view.querySelector('#fr-index-view'); collection.value = initialView;
  let sortKey = 'name', sortDirection = 1, sortTouched = false;
  if (builder) builder.hidden = !!onlyScope && !DataForms.canManage(onlyScope === 'general' ? null : onlyScope);
  let forms;
  try {
    forms = (await API.get('/form-definitions')).filter((form) =>
      (form.slug === 'hr_payroll' ? App.hasPermission('payroll.view') : (form.records_allowed ?? DataForms.canManage(form.scope))));
  } catch (error) {
    if (formRecordViews.get(view) !== owner) return;
    el.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load forms', hint: error.message || 'Please try again.', action: '<button class="btn secondary" type="button" id="fr-index-retry">Retry</button>' });
    el.querySelector('#fr-index-retry').onclick = () => App.navigate('form-records', { ...(onlyScope ? { scope: onlyScope } : {}), ...(initialQuery ? { q: initialQuery } : {}) });
    return;
  }
  if (formRecordViews.get(view) !== owner) return;
  function render() {
    const q = search.value.trim().toLowerCase();
    const chosenScope = section ? section.value : '';
    if (builder) builder.hidden = !!chosenScope && !DataForms.canManage(chosenScope === 'general' ? null : chosenScope);
    const matches = forms.filter((form) =>
      (collection.value === 'archived' ? !!form.archived_at : !form.archived_at) &&
      (collection.value !== 'favorites' || personal.favorites.includes(form.id)) &&
      (collection.value !== 'recent' || personal.recent.some(row => row.form_id === form.id)) &&
      (!chosenScope || (form.scope || 'general') === chosenScope) &&
      (!q || `${form.name} ${form.slug} ${form.number_prefix}`.toLowerCase().includes(q)));
    if (!matches.length) {
      el.innerHTML = UI.emptyState({
        icon: 'file', title: q ? 'No matching forms' : chosenScope ? 'No forms in this section' : 'No forms defined yet',
        hint: forms.length ? 'Try a different search or section.' : manageableScope ? 'Open Form Builder to create a form in this section.' : 'Ask an admin for access to forms.',
      });
      return;
    }
    if (collection.value === 'recent' && !sortTouched) matches.sort((a,b) => personal.recent.findIndex(row=>row.form_id===a.id)-personal.recent.findIndex(row=>row.form_id===b.id));
    else matches.sort((a,b) => {
      const value = (form) => sortKey === 'records' ? Number(form.record_count) || 0 : sortKey === 'fields' ? form.fields.length : sortKey === 'updated' ? form.updated_at || form.created_at || '' : form.name.toLocaleLowerCase();
      const aValue = value(a), bValue = value(b);
      return ((aValue < bValue ? -1 : aValue > bValue ? 1 : 0) * sortDirection) || a.name.localeCompare(b.name);
    });
    const groups = {};
    matches.forEach((form) => { const key = form.scope || 'general'; (groups[key] = groups[key] || []).push(form); });
    el.innerHTML = FORM_RECORDS_SCOPE_ORDER.map((scope) => scope || 'general')
      .filter((key) => groups[key]).map((key) => `
        <div class="fr-scope-group"><div class="fr-scope-heading">${UI.esc(FORM_RECORDS_SCOPE_LABELS[key])}</div>
        <div class="form-explorer-scroll" role="region" tabindex="0" aria-label="${UI.esc(FORM_RECORDS_SCOPE_LABELS[key])} forms"><table class="form-explorer">
          <thead><tr>${[['name','Form name'],['records','Records'],['fields','Fields']].map(([key,label]) => `<th ${key !== 'name' ? 'class="num"' : ''} ${sortTouched || collection.value !== 'recent' ? `aria-sort="${sortKey === key ? sortDirection === 1 ? 'ascending' : 'descending' : 'none'}"` : ''}><button type="button" class="form-explorer-sort" data-form-sort="${key}">${label}${sortKey === key && (sortTouched || collection.value !== 'recent') ? sortDirection === 1 ? ' ↑' : ' ↓' : ''}</button></th>`).join('')}<th>Number format</th><th ${sortTouched || collection.value !== 'recent' ? `aria-sort="${sortKey === 'updated' ? sortDirection === 1 ? 'ascending' : 'descending' : 'none'}"` : ''}><button type="button" class="form-explorer-sort" data-form-sort="updated">Updated${sortKey === 'updated' ? sortDirection === 1 ? ' ↑' : ' ↓' : ''}</button></th><th><span class="sr-only">Favorite</span></th></tr></thead>
          <tbody>${groups[key].map(form => formCardHTML(form, personal.favorites.includes(form.id))).join('')}</tbody>
        </table></div><p class="form-explorer-hint muted">Swipe the list sideways to see more columns.</p></div>`).join('');
    el.querySelectorAll('.form-card[data-id]').forEach((card) =>
      card.onclick = () => {
        const selected = forms.find(form => String(form.id) === card.dataset.id);
        App.navigate('form-records', { form_id: card.dataset.id, ...(selected?.slug === 'hr_payroll' ? { slug: 'hr_payroll' } : {}), ...(collection.value !== 'all' ? {index_view:collection.value} : {}), ...(section.value ? { scope: section.value } : { index_scope: 'all' }), ...(search.value.trim() ? { index_q: search.value.trim() } : {}) });
      });
    el.querySelectorAll('[data-favorite]').forEach(button => button.onclick = async () => { button.disabled = true; try { personal = await DataForms.savePreference({action:'favorite',form_id:Number(button.dataset.favorite),enabled:!personal.favorites.includes(Number(button.dataset.favorite))}); render(); } catch(error) { button.disabled = false; UI.toast(error.message,'error'); } });
    el.querySelectorAll('[data-form-sort]').forEach(button => button.onclick = () => { const key = button.dataset.formSort; sortDirection = sortKey === key && sortTouched ? -sortDirection : 1; sortKey = key; sortTouched = true; render(); el.querySelector(`[data-form-sort="${key}"]`)?.focus(); });
  }
  function refreshIndex() {
    App.replaceFilters?.('form-records', { ...(collection.value !== 'all' ? {view:collection.value} : {}), ...(section.value ? { scope: section.value } : {}), ...(search.value.trim() ? { q: search.value.trim() } : {}) });
    render();
  }
  search.oninput = refreshIndex;
  section.onchange = refreshIndex; collection.onchange = refreshIndex;
  render();
}

/* ── Per-form records view ───────────────────────────────────────────────── */
async function renderFormView(view, formId, initialPeriod, initialStatus, navigation = {}) {
  const owner = {};
  formRecordViews.set(view, owner);
  let formDef = null;
  let formVersions = new Map();
  let searchTimer;
  let currentRecords = [];
  let selectedIds = new Set();
  const state = { q: navigation.q || '', status: initialStatus || '', period: initialPeriod || '' };
  // Payroll "All periods" view: attendance_periods rows (id/dates), matched to a payslip's
  // free-text `period` label — that label is independently editable at Generate Payslips time
  // (see hr.routes.ts), so a match isn't guaranteed. A bundle with no match still shows its
  // stats, just without the id-dependent quick actions (Export CSV, Post to GL).
  let periodsMeta = [];
  let periodCombo = null; // payroll's Period filter (UI.combo); load() refreshes its options
  const periodOptions = (labels) => [{ value: '', label: 'All periods' }, ...labels.map((p) => ({ value: p, label: p }))];
  const expandedBundles = new Set(); // period labels the user has toggled open
  // Defaults the most-recent bundle open exactly once, on the very first render — without
  // this flag, collapsing that same bundle empties the set again, and the "default open"
  // fallback below would immediately re-add it right back, making it look like clicking to
  // collapse just did nothing.
  let bundlesDefaultApplied = false;

  try { formDef = await API.get('/form-definitions/' + formId); }
  catch { view.innerHTML = '<div class="empty">Form not found.</div>'; return; }
  if (formRecordViews.get(view) !== owner) return;
  if (window.Help) Help.rememberForm(formDef);

  // The server supplies the current form-specific entry decision. Payroll keeps its
  // independent permission; management rights alone continue to cover the owning section.
  const entryOnly = formDef.scope === 'inventory' && !DataForms.canManage('inventory');
  const canBrowse = formDef.records_allowed ?? (formDef.slug === 'hr_payroll' ? App.hasPermission('payroll.view') : DataForms.canManage(formDef.scope));
  if (!canBrowse) {
    view.innerHTML = `<div class="topbar">
        <button class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} Data Forms</button>
        <h2 style="margin-left:10px">${UI.esc(formDef.name)}</h2>
      </div>
      <div class="panel">${UI.emptyState({
        icon: 'key',
        title: 'No access to this form’s records',
        hint: 'Filed one yourself? Open Requests in the mobile app to see your own submissions and their status.',
      })}</div>`;
  view.querySelector('#fr-back').onclick = () => App.navigate('form-records', { ...(navigation.index_view && navigation.index_view !== 'all' ? {view:navigation.index_view} : {}), ...(navigation.index_scope === 'all' ? {} : (navigation.scope || formDef.scope) ? { scope: navigation.scope || formDef.scope } : {}), ...(navigation.index_q ? { q: navigation.index_q } : {}) });
    return;
  }

  // HR records retain the section's visual treatment even when opened by form id.
  if (formDef.scope === 'hr') view.dataset.section = 'hr';
  const versions = await API.get('/form-definitions/' + formId + '/versions').catch(()=>[]);
  if(Array.isArray(versions))formVersions=new Map(versions.map(version=>[version.version,version.definition]));
  let personal = await DataForms.preferences();
  let viewPreferences = personal.views[String(formId)] || {};
  DataForms.savePreference({action:'recent',form_id:formId}).catch(()=>{});
  const isPayroll = formDef.slug === 'hr_payroll';
  const canManagePayroll = isPayroll && App.hasPermission('payroll.manage');
  // Any other form with a linked print template gets the same "Print All"/"Print selected"
  // bulk actions payroll has always had — payroll keeps its own dedicated 2-up slip buttons.
  const canBulkPrint = !isPayroll && !!formDef.template_id;

  // Fetched once, lazily, only if this form actually has an 'employee' field — most forms don't.
  let employeesCache = null;
  async function getEmployees() {
    if (!employeesCache) employeesCache = await API.get('/hr/employees').catch(() => []);
    return employeesCache;
  }

  // Payslip writes need payroll.manage server-side (form-builder.routes.ts canAccessRecords); a
  // payroll.view-only reader browses, prints and exports. Every other form reaches this point
  // with management or assigned entry access; entry-only writes are limited to active drafts.
  const canWrite = !isPayroll || canManagePayroll;
  const statusOptions = `
        <option value="" ${state.status ? '' : 'selected'}>All statuses</option>
        ${['pending', 'draft', 'submitted', 'approved', 'rejected', 'completed'].concat(isPayroll ? ['paid'] : [])
          .map((s) => `<option value="${s}" ${state.status === s ? 'selected' : ''}>${s}</option>`).join('')}`;

  // Payroll gets a heading row (context + primary action), a separate filter / print-export
  // row, and its rare import/cleanup tools behind an inline disclosure. Other forms keep the
  // original single toolbar unchanged.
  const headerHTML = isPayroll ? `
    <div class="topbar">
      <button type="button" class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} HR Forms</button>
      <div>
        <h2>${UI.esc(formDef.name)}</h2>
        <div class="sub">Payslips grouped by cutoff — open one to see how its pay was computed.</div>
      </div>
      <div class="grow"></div>
      ${canManagePayroll ? `
        <button type="button" class="btn secondary" id="fr-more-toggle" aria-expanded="false" aria-controls="fr-more">${UI.icon('settings')} Import &amp; cleanup</button>
        <button type="button" class="btn secondary" id="fr-reconcile-owner">Review legacy owners</button>
        <button type="button" class="btn" id="fr-new">${UI.icon('plus')} New Record</button>` : ''}
    </div>
    ${canManagePayroll ? `<div class="hr-tools" id="fr-more" hidden>
      <div class="hr-tools-group" role="group" aria-labelledby="fr-more-import">
        <span class="hr-tools-label" id="fr-more-import">Import</span>
        <button type="button" class="btn secondary small" id="fr-import-csv">${UI.icon('upload', 14)} Upload CSV</button>
      </div>
      <div class="hr-tools-group" role="group" aria-labelledby="fr-more-clean">
        <span class="hr-tools-label" id="fr-more-clean">Cleanup</span>
        <button type="button" class="btn secondary small danger" id="fr-del-all" title="Delete all currently visible records">${UI.icon('trash', 14)} Delete visible</button>
      </div>
    </div>` : ''}
    <div class="hr-filters hr-filters-bar">
      <div class="search-box search">
        <span class="ic">${UI.icon('search', 15)}</span>
        <label class="hr-sr-only" for="fr-search">Search payslips by employee name</label>
        <input type="search" id="fr-search" placeholder="Search employee name…" autocomplete="off" />
      </div>
      <div class="fld"><label for="fr-status">Status</label><select id="fr-status">${statusOptions}</select></div>
      <div class="fld"><label for="fr-period">Period</label><div id="fr-period-combo"></div></div>
      <button type="button" class="btn secondary small" id="fr-filter-reset" hidden>Reset</button>
      <div class="grow"></div>
      <div class="hr-tools-group" role="group" aria-label="Print and export the payslips in view">
        <button type="button" class="btn secondary small" id="fr-print-slips">${UI.icon('printer', 14)} Print visible</button>
        <button type="button" class="btn secondary small" id="fr-print-summary" title="Print a payroll summary (totals, department subtotals, full payroll list) for the payslips in view">${UI.icon('printer', 14)} Print Summary</button>
        <button type="button" class="btn secondary small" id="fr-download-csv" title="Download the currently filtered payslips as a styled Excel workbook, with summary and per-department totals">${UI.icon('download', 14)} Download Excel</button>
      </div>
    </div>` : `
    <div class="topbar">
      <button class="btn secondary small" id="fr-back">${UI.icon('arrow-left', 14)} Data Forms</button>
      <h2 style="margin-left:10px">${UI.esc(formDef.name)}</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="fr-search" placeholder="Search number…" /></div>
      <select id="fr-status" aria-label="Record status" style="margin-left:8px">${statusOptions}
      </select>
      ${canBulkPrint ? `<button class="btn secondary" id="fr-print-all-tpl" style="margin-left:8px">${UI.icon('printer')} Print visible</button>` : ''}
      <button class="btn secondary" id="fr-download-csv" style="margin-left:8px" title="Download the currently filtered records as a CSV file">${UI.icon('download')} Download CSV</button>
      ${entryOnly ? '' : HR_REQUEST_SLUGS.includes(formDef.slug) ? '<button class="btn secondary" id="fr-open-approvals">Open Approvals</button>' : `<button class="btn secondary danger" id="fr-del-all" style="margin-left:8px" title="Delete all currently visible records">${UI.icon('trash')} Delete visible</button>`}
      <button class="btn" id="fr-new" style="margin-left:8px">${UI.icon('plus')} New Record</button>
    </div>`;

  view.innerHTML = `${headerHTML}
    <div id="fr-bulk-bar" style="display:none;align-items:center;gap:8px;padding:7px 16px;background:var(--accent-weak,#e7f1ff);border-bottom:1px solid var(--border,#dce6f2);flex-shrink:0">
      <span id="fr-sel-count" style="font-weight:700;font-size:13px;color:var(--accent,#2b7fff)">0 selected</span>
      <div style="flex:1"></div>
      ${isPayroll ? `<button class="btn secondary small" id="fr-bulk-print">${UI.icon('printer')} Print selected</button>` : ''}
      ${canBulkPrint ? `<button class="btn secondary small" id="fr-bulk-print-tpl">${UI.icon('printer')} Print selected</button>` : ''}
      ${canWrite && !HR_REQUEST_SLUGS.includes(formDef.slug) ? `<button class="btn secondary small" id="fr-bulk-status">${UI.icon('edit', 14)} Change status</button>` : ''}
      ${isPayroll && canManagePayroll ? `
        <button class="btn secondary small" id="fr-bulk-mark-paid">${UI.icon('check')} Mark paid</button>
        <button class="btn secondary small" id="fr-bulk-unmark-paid">${UI.icon('reply', 15)} Unmark paid</button>` : ''}
      ${canWrite && !entryOnly && !HR_REQUEST_SLUGS.includes(formDef.slug) ? `<button class="btn secondary small danger" id="fr-bulk-del">${UI.icon('trash')} Delete selected</button>` : ''}
      <button class="btn secondary small" id="fr-bulk-clear">${UI.icon('close', 12)} Clear</button>
    </div>
    <div class="panel"><div id="fr-table"></div></div>`;

  const tools = document.createElement('div'); tools.className = 'form-view-tools panel';
  tools.innerHTML = `<button type="button" class="btn secondary small" id="fr-columns">Choose columns</button><label for="fr-saved-filter">Saved view</label><select id="fr-saved-filter"><option value="">Current filters</option></select><button type="button" class="btn secondary small" id="fr-save-filter">Save current filters</button><button type="button" class="btn secondary small" id="fr-remove-filter" disabled>Remove saved view</button><span id="fr-personal-status" role="status"></span>`;
  view.querySelector('#fr-bulk-bar').before(tools);
  const savedSelect = tools.querySelector('#fr-saved-filter');
  function renderSavedViews(selected = '') {
    savedSelect.innerHTML = '<option value="">Current filters</option>' + (viewPreferences.filters || []).map(filter => `<option value="${UI.esc(filter.id)}">${UI.esc(filter.name)}</option>`).join('');
    savedSelect.value = selected; tools.querySelector('#fr-remove-filter').disabled = !selected;
    if (personal.unavailable) tools.querySelector('#fr-personal-status').textContent = 'Saved preferences are temporarily unavailable.';
  }
  async function savePersonal(change) {
    personal = await DataForms.savePreference({ ...change, form_id: formId });
    viewPreferences = personal.views[String(formId)] || {}; return personal;
  }
  function columnFields() {
    const fields = new Map(formDef.fields.map(field => [field.key, field]));
    currentRecords.forEach(record => (record.schema?.fields || []).forEach(field => { if (!fields.has(field.key)) fields.set(field.key, {...field,label:field.label+' (earlier version)'}); }));
    return fields;
  }
  tools.querySelector('#fr-columns').onclick = () => {
    const choices = [...columnFields().values()], selected = viewPreferences.columns || formDef.fields.slice(0,4).map(field=>field.key);
    UI.modal({ title:'Choose record columns', bodyHTML:`<p>These columns apply to your account for this form. Number, status and date remain visible.</p>${choices.map(field=>`<label class="form-column-choice"><input type="checkbox" data-column="${UI.esc(field.key)}" ${selected.includes(field.key)?'checked':''}> ${UI.esc(field.label)}</label>`).join('')}<p class="muted">Choose up to 12 field columns.</p><label><input type="checkbox" id="fr-column-defaults"> Restore the default columns</label>`,confirmText:'Save columns',onConfirm:async(overlay,showError)=>{
      const columns = overlay.querySelector('#fr-column-defaults').checked ? null : [...overlay.querySelectorAll('[data-column]:checked')].map(input=>input.dataset.column);
      if(columns && columns.length>12){showError('Choose no more than 12 columns.');return false;}
      await savePersonal({action:'columns',columns}); renderRecords(currentRecords); tools.querySelector('#fr-personal-status').textContent='Column preferences saved';
    }});
  };
  savedSelect.onchange = () => {
    const chosen=(viewPreferences.filters||[]).find(filter=>filter.id===savedSelect.value);
    tools.querySelector('#fr-remove-filter').disabled=!chosen; if(!chosen)return;
    state.q=chosen.q;state.status=chosen.status;state.period=chosen.period;
    view.querySelector('#fr-search').value=state.q;view.querySelector('#fr-status').value=state.status;periodCombo?.setSelected(state.period);load();
  };
  tools.querySelector('#fr-save-filter').onclick=()=>UI.modal({title:'Save this filtered view',bodyHTML:`<label for="fr-filter-name">Name *</label><input id="fr-filter-name" maxlength="80"><p class="muted">Search: ${UI.esc(state.q||'All')} · Status: ${UI.esc(state.status||'All')} · Period: ${UI.esc(state.period||'All')}</p>`,confirmText:'Save view',onConfirm:async(overlay,showError)=>{
    const name=overlay.querySelector('input').value.trim();if(!name){showError('Enter a name for this view.');return false;}
    const id=String(Date.now())+'-'+Math.random().toString(36).slice(2);
    await savePersonal({action:'save_filter',filter:{id,name,...state}});renderSavedViews(id);tools.querySelector('#fr-personal-status').textContent='Filtered view saved';
  }});
  tools.querySelector('#fr-remove-filter').onclick=async()=>{if(!savedSelect.value)return;try{await savePersonal({action:'delete_filter',filter_id:savedSelect.value});renderSavedViews();tools.querySelector('#fr-personal-status').textContent='Saved view removed';}catch(error){UI.toast(error.message,'error');}};
  renderSavedViews();

  view.querySelector('#fr-back').onclick = () => App.navigate('form-records', isPayroll ? { scope: 'hr' } : { ...(navigation.index_view && navigation.index_view !== 'all' ? {view:navigation.index_view} : {}), ...(navigation.index_scope === 'all' ? {} : (navigation.scope || formDef.scope) ? { scope: navigation.scope || formDef.scope } : {}), ...(navigation.index_q ? { q: navigation.index_q } : {}) });
  view.querySelector('#fr-search').value = state.q;
  const newBtn = view.querySelector('#fr-new');
  if (formDef.archived_at) { view.querySelectorAll('#fr-new,#fr-import-csv,#fr-del-all,#fr-bulk-del').forEach(button=>button.disabled=true); const notice=document.createElement('p');notice.className='panel';notice.textContent='Archived form — no new entries. Existing records may be corrected with a reason and are kept as revisions.';view.querySelector('#fr-bulk-bar').before(notice); }
  if (newBtn) newBtn.onclick = () => isPayroll ? App.navigate('hr-timekeeping') : recordModal(null);
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
    if (canManagePayroll) view.querySelector('#fr-reconcile-owner').onclick = () => reconcileLegacyOwners();
    const moreToggle = view.querySelector('#fr-more-toggle');
    if (moreToggle) moreToggle.onclick = () => {
      const open = moreToggle.getAttribute('aria-expanded') !== 'true';
      moreToggle.setAttribute('aria-expanded', String(open));
      view.querySelector('#fr-more').hidden = !open;
    };
    const importBtn = view.querySelector('#fr-import-csv');
    if (importBtn) importBtn.onclick = () => importCsvModal();
    view.querySelector('#fr-print-slips').onclick = () => printSlips();
    view.querySelector('#fr-print-summary').onclick = () => printSummary();
    view.querySelector('#fr-bulk-print').onclick = () => printSelected();
    // Type-to-search instead of a <select>: the cutoff list only grows (two a month).
    periodCombo = UI.combo(view.querySelector('#fr-period-combo'), periodOptions([]), {
      selected: state.period,
      placeholder: 'Type a period…',
      emptyText: 'No matching period',
      onSelect: (value) => {
        if ((value || '') === state.period) return;
        state.period = value || '';
        load();
      },
    });
    view.querySelector('#fr-period-combo .combo-input').id = 'fr-period';
    view.querySelector('#fr-filter-reset').onclick = () => clearPayrollFilters();
  }
  async function reconcileLegacyOwners() {
    try {
      const [records, employees] = await Promise.all([API.get('/hr/payroll/legacy-unresolved'), API.get('/hr/payroll/reconciliation-employees')]);
      if (!records.length) { UI.toast('All legacy payslips have an identified owner.'); return; }
      const listModal = UI.modal({
        title: `Unidentified payslips (${records.length})`, size: 'lg', cancelText: 'Close',
        bodyHTML: `<p class="muted">Review the original payroll record before assigning an employee. The pay amounts stay locked; this correction changes who can see the payslip and how reports group it.</p>
          <div style="max-height:45vh;overflow:auto" tabindex="0" role="region" aria-label="Unidentified payslips">${records.map(r => `<div class="tool-row"><span><strong>${UI.esc(r.number)}</strong> · ${UI.esc(r.employee_name || 'No name')}<br><small>${UI.esc(r.period || 'No period')} · ${UI.esc(r.status)} · Net ${UI.money(r.net_pay)}</small></span><button type="button" class="btn secondary small" data-reconcile="${r.id}">Review &amp; assign</button></div>`).join('')}</div>`,
        onOpen: overlay => overlay.querySelectorAll('[data-reconcile]').forEach(button => button.onclick = () => {
          const record = records.find(r => r.id === Number(button.dataset.reconcile));
          if (!record) return;
          UI.modal({
            title: `Assign owner · ${record.number}`, confirmText: 'Assign employee', cancelText: 'Cancel',
            bodyHTML: `<p>Legacy name: <strong>${UI.esc(record.employee_name || '—')}</strong><br>Period: ${UI.esc(record.period || '—')} · Status: ${UI.esc(record.status)} · Net: ${UI.money(record.net_pay)}</p>
              <details><summary>Review original payslip fields</summary><div style="max-height:28vh;overflow:auto" tabindex="0" role="region" aria-label="Original payslip fields">${Object.entries(record.data || {}).map(([key, value]) => `<div class="tool-row"><strong>${UI.esc(key.replaceAll('_', ' '))}</strong><span>${UI.esc(typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—'))}</span></div>`).join('')}</div></details>
              <label for="fr-legacy-employee">Verified employee *</label><select id="fr-legacy-employee"><option value="">Select employee…</option>${employees.map(e => `<option value="${e.id}">${UI.esc(e.employee_no || '')} · ${UI.esc(e.name)}</option>`).join('')}</select>
              <label for="fr-legacy-reason">Evidence and reason *</label><textarea id="fr-legacy-reason" maxlength="1000" placeholder="How did you verify this employee owns the payslip?"></textarea>`,
            onConfirm: async (ov, showError) => {
              const employee_id = Number(ov.querySelector('#fr-legacy-employee').value);
              const reason = ov.querySelector('#fr-legacy-reason').value.trim();
              if (!employee_id || reason.length < 10) { showError('Select the employee and enter at least 10 characters explaining your evidence.'); return false; }
              try {
                await API.post(`/hr/payroll/${record.id}/reconcile-owner`, { employee_id, record_number: record.number, reason });
                UI.toast(`${record.number} assigned to the selected employee`);
                listModal.close();
                load();
                return true;
              } catch (error) { showError(error.message || 'Could not assign the owner.'); return false; }
            },
          });
        }),
      });
    } catch (error) { UI.toast(error.message || 'Could not load unidentified payslips', 'error'); }
  }
  if (canBulkPrint) {
    view.querySelector('#fr-print-all-tpl').onclick = () => printRecordsViaTemplate(currentRecords);
    view.querySelector('#fr-bulk-print-tpl').onclick = () =>
      printRecordsViaTemplate(currentRecords.filter((r) => selectedIds.has(r.id)));
  }
  view.querySelector('#fr-download-csv').onclick = () => downloadCsv();
  const approvalsBtn = view.querySelector('#fr-open-approvals'); if (approvalsBtn) approvalsBtn.onclick = () => App.navigate('hr-approvals', { slug: formDef.slug });
  const delAllBtn = view.querySelector('#fr-del-all');
  if (delAllBtn) delAllBtn.onclick = () => delAll();
  const bulkDelBtn = view.querySelector('#fr-bulk-del');
  if (bulkDelBtn) bulkDelBtn.onclick = () => delSelected();
  view.querySelector('#fr-bulk-clear').onclick = () => { selectedIds.clear(); syncSelection(); };
  const bulkStatusBtn = view.querySelector('#fr-bulk-status');
  if (bulkStatusBtn) bulkStatusBtn.onclick = () => bulkChangeStatus();

  // Payroll's Reset / "Clear filters": drop search, status and period together, then reload.
  function clearPayrollFilters() {
    clearTimeout(searchTimer);
    state.q = ''; state.status = ''; state.period = '';
    view.querySelector('#fr-search').value = '';
    view.querySelector('#fr-status').value = '';
    periodCombo.setSelected('');
    load();
    view.querySelector('#fr-search').focus();
  }
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

  function batchPlan(targets, operation, nextStatus) {
    return targets.map((record) => {
      let reason = '';
      if(entryOnly&&(operation==='delete'||record.status!=='draft'||formDef.archived_at)) reason='Form entry permits changes to active drafts only';
      else if(record.sales_order_id && ['delete','status'].includes(operation)) reason='Linked to a sales order; review it there';
      else if (formDef.archived_at && operation === 'delete') reason = 'Archived records must be retained';
      else if (operation === 'paid' && record.status === 'paid') reason = 'Already paid';
      else if (operation === 'unpaid' && record.status !== 'paid') reason = 'Not marked paid';
      else if (isPayroll && record.status === 'paid' && operation !== 'unpaid') reason = 'Paid payslip is locked';
      else if (operation === 'status' && !nextStatus) reason = 'Choose a target status';
      else if (operation === 'status' && record.status === nextStatus) reason = 'Already has this status';
      return { record, reason };
    });
  }

  function reviewBatch(targets, operation) {
    const deleting = operation === 'delete';
    const verb = deleting ? 'Delete' : operation === 'paid' ? 'Mark paid' : operation === 'unpaid' ? 'Unmark paid' : 'Change status';
    return new Promise((resolve) => {
      const modal = UI.modal({
        title: `${verb} — review ${targets.length} record${targets.length === 1 ? '' : 's'}`,
        bodyHTML: `${operation === 'status' ? `<label for="fr-batch-status">New status</label><select id="fr-batch-status"><option value="">Choose a status…</option>${(entryOnly||(formDef.actions||[]).some(action=>action.type==='create_sales_draft')?['draft','submitted']:['draft', 'pending', 'submitted', 'approved', 'rejected', 'completed']).map(status => `<option value="${status}">${status}</option>`).join('')}</select>` : ''}
          <p class="muted">${UI.esc(formDef.name)}${state.period ? ' · Period: ' + UI.esc(state.period) : ''}${state.status ? ' · Status: ' + UI.esc(state.status) : ''}${state.q ? ' · Search: ' + UI.esc(state.q) : ''}</p>
          <p>${deleting ? 'Deletion cannot be undone.' : 'Only the eligible records below will change.'}</p>
          <p id="fr-batch-count" aria-live="polite"></p>
          ${formDef.archived_at ? '<label for="fr-batch-reason">Reason for archived-record corrections *</label><textarea id="fr-batch-reason" maxlength="1000"></textarea>' : ''}
          <div id="fr-batch-review" tabindex="0" role="region" aria-label="Affected records" style="max-height:320px;overflow:auto"></div>`,
        confirmText: deleting ? 'Delete records' : 'Apply changes',
        onOpen: (overlay) => {
          function renderReview() {
            const nextStatus = overlay.querySelector('#fr-batch-status')?.value;
            const plan = batchPlan(targets, operation, nextStatus);
            const eligible = plan.filter(entry => !entry.reason).length;
            overlay.querySelector('#fr-batch-count').textContent = `${eligible} will change · ${plan.length - eligible} excluded`;
            overlay.querySelector('#fr-batch-review').innerHTML = `<table><thead><tr><th>Record</th><th>Employee / item</th><th>Current status</th><th>Result</th></tr></thead><tbody>${plan.map(({record, reason}) => `<tr><td>${UI.esc(record.number)}</td><td>${UI.esc(record.data.employee_name || record.data.item || '—')}</td><td>${UI.esc(record.status)}</td><td>${UI.esc(reason || (operation === 'status' ? nextStatus : verb))}</td></tr>`).join('')}</tbody></table>`;
            overlay.querySelector('[data-confirm]').disabled = eligible === 0;
          }
          overlay.querySelector('#fr-batch-status')?.addEventListener('change', renderReview);
          renderReview();
        },
        onConfirm: (overlay,showError) => {
          const reason=overlay.querySelector('#fr-batch-reason')?.value.trim();
          if(formDef.archived_at&&!reason){showError('Enter a reason for these archived-record corrections.');return false;}
          const status = overlay.querySelector('#fr-batch-status')?.value;
          resolve({ status, reason, plan: batchPlan(targets, operation, status) });
        },
        onCancel: () => resolve(null),
      });
    });
  }

  let batchBusy = false;
  async function runBatch(targets, operation) {
    if (batchBusy) return;
    if (!targets.length) { UI.toast('No records selected', 'error'); return; }
    const review = await reviewBatch(targets, operation);
    if (!review) return;
    batchBusy = true;
    const controls = [...view.querySelectorAll('button, input, select')];
    const previousDisabled = new Map(controls.map(control => [control, control.disabled]));
    controls.forEach(control => { control.disabled = true; });
    const eligible = review.plan.filter(entry => !entry.reason);
    const excluded = review.plan.filter(entry => entry.reason);
    const failures = [], warnings = [];
    let changed = 0;
    try {
      for (const { record } of eligible) {
        try {
          const response = operation === 'delete' ? await API.del('/form-records/' + record.id)
            : operation === 'status' ? await API.put('/form-records/' + record.id, { data: record.data, status: review.status, change_reason:review.reason,expected_revision:record.revision || 1 })
            : await API.post(`/hr/payroll/${record.id}/${operation === 'paid' ? 'mark-paid' : 'unmark-paid'}`, {});
          changed++;
          if (response?.action_warnings?.length) warnings.push({ record, message: response.action_warnings.join('; ') });
        } catch (error) { failures.push({ record, message: error.message || 'Operation failed' }); }
      }
    } finally {
      controls.forEach(control => { control.disabled = previousDisabled.get(control); });
      batchBusy = false;
    }
    await load();
    if (formRecordViews.get(view) !== owner || !view.querySelector('#fr-table')) {
      UI.toast(`${changed} records changed, ${excluded.length} excluded, ${failures.length} failed`, failures.length ? 'error' : 'success');
      return;
    }
    selectedIds = new Set(failures.filter(entry => currentRecords.some(record => record.id === entry.record.id)).map(entry => entry.record.id));
    syncSelection();
    UI.modal({
      title: 'Bulk operation results', cancelText: 'Close',
      bodyHTML: `<p role="status">${changed} ${operation === 'delete' ? 'deleted' : 'updated'} · ${excluded.length} excluded · ${failures.length} failed</p>
        ${excluded.length ? `<h4>Excluded</h4><ul>${excluded.map(({record, reason}) => `<li>${UI.esc(record.number)}: ${UI.esc(reason)}</li>`).join('')}</ul>` : ''}
        ${failures.length ? `<h4>Failed records</h4><p>These records remain selected when visible. Review the errors before retrying.</p><ul>${failures.map(({record, message}) => `<li>${UI.esc(record.number)}: ${UI.esc(message)}</li>`).join('')}</ul>` : ''}
        ${warnings.length ? `<h4>Action warnings</h4><ul>${warnings.map(({record, message}) => `<li>${UI.esc(record.number)}: ${UI.esc(message)}</li>`).join('')}</ul>` : ''}`,
    });
  }

  function delSelected() { return runBatch(currentRecords.filter(record => selectedIds.has(record.id)), 'delete'); }
  function bulkChangeStatus() { return runBatch(currentRecords.filter(record => selectedIds.has(record.id)), 'status'); }
  function bulkSetPaid(toPaid) { return runBatch(currentRecords.filter(record => selectedIds.has(record.id)), toPaid ? 'paid' : 'unpaid'); }

  async function printSelected() {
    if (!selectedIds.size) { UI.toast('No records selected', 'error'); return; }
    const list = currentRecords.filter((r) => selectedIds.has(r.id)).map(payrollPrintData);
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

  function delAll() {
    return runBatch([...currentRecords], 'delete');
  }

  // Opens a floating preview (modal + iframe, no auto print) with a Print button the
  // user triggers when ready — that opens the browser's native print dialog (preview +
  // paper/copies/printer settings) scoped to just the iframe's content.
  // dataList defaults to every currently-loaded/filtered record; pass a single-item array
  // (from a row's Print button) to preview just that one employee's slip.
  // The per-slip HTML comes from the "HR Payroll Slip" document template (editable later
  // under Documents > Templates), not hardcoded — falls back to a plain layout if missing.
  async function loadPrintContext(templateId){
    const [company,globals,variables]=await Promise.all([API.get('/templates/company'),API.get('/global-variables'),API.get('/templates/variables?template_id='+templateId)]);
    return {company,global:Object.fromEntries(globals.map(v=>[v.key,v.value])),variables};
  }

  async function choosePrintLayout(print) {
    try {
      const layouts=await API.get(`/form-definitions/${formDef.id}/templates`);
      if(!layouts.length){UI.toast('No print template linked. Open Form Builder → Print templates.','error');return;}
      const defaultId=layouts.find(t=>t.is_default)?.id||layouts[0].id;
      if(layouts.length===1)return await print(defaultId);
      UI.modal({title:'Choose print layout',bodyHTML:`<label>Template<select id="fr-print-layout">${layouts.map(t=>`<option value="${t.id}" ${t.id===defaultId?'selected':''}>${UI.esc(t.name)}${t.is_default?' (Default)':''}</option>`).join('')}</select></label><p class="muted">This choice applies to this print only. Change the default in Form Builder.</p>`,cancelText:'Cancel',confirmText:'Preview',onConfirm:async ov=>{const id=Number(ov.querySelector('#fr-print-layout').value);await print(id);return true;}});
    }catch(err){UI.toast(err.message||'Could not load print layouts','error');}
  }

  function payrollPrintData(r){return {...r.data,number:r.number,record:{number:r.number,status:r.status,created_at:r.created_at},today:new Date().toLocaleDateString()};}
  async function printSlips(dataList,templateId) {
    if(!templateId)return choosePrintLayout(id=>printSlips(dataList,id));
    const list = dataList || currentRecords.map(payrollPrintData);
    if (!list.length) { UI.toast('No records to print', 'error'); return; }
    if (typeof buildPayrollSlipsHtml === 'undefined') { UI.toast('Print module failed to load', 'error'); return; }

    const tpl=await API.get('/templates/'+templateId),context=await loadPrintContext(templateId);
    const render=data=>renderSlip({...data,company:context.company,global:context.global},tpl.body,context.variables);
    const tiled=buildTiledPagesHtml(list,render,{copiesPerRecord:tpl.copies_per_record,recordsPerPage:tpl.records_per_page,tileFill:tpl.tile_fill,continuous:!!tpl.tile_continuous,gapXmm:tpl.grid_gap_x_mm,gapYmm:tpl.grid_gap_y_mm,repeatCount:tpl.repeat_count,pageContentHeightMm:pageContentHeightMm(tpl.body)});
    const html=tiled||list.map((data,i)=>`<div${i<list.length-1?' style="break-after:page"':''}>${render(data)}</div>`).join('');
    const full=UI.printableHtml(html,formDef.name);

    UI.modal({
      title: 'Payslip Preview',
      size: 'xl',
      bodyHTML: `<iframe title="Payslip print preview" id="payslip-preview-frame" style="width:100%;height:70vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
      cancelText: 'Close',
      confirmText: 'Print…',
      onOpen: (ov) => {
        const ifr = ov.querySelector('#payslip-preview-frame');
        // Once the slip HTML has actually rendered (real layout needed — scrollHeight is
        // meaningless before then), shrink any cell whose content overflows its fixed-height
        // grid cell instead of leaving it silently clipped by .payslip-grid's overflow:hidden.
        UI.loadPrintFrame(ifr,full,tiled?fitTiledCells:undefined);
      },
      onConfirm: async (ov) => {
        const ifr = ov.querySelector('#payslip-preview-frame');
        await UI.printFrame(ifr);
        return false; // keep the preview open — printing shouldn't close it
      },
    });
  }

  // Printable payroll summary for one period (or whatever's filtered) — same records and
  // totals as Download Excel (hr-payroll-export.js buildPayrollSummaryHtml), same preview-
  // modal + iframe pattern as printSlips() above. `records`/`labelHint` come from a period
  // bundle's own button; the header button prints what's currently in view.
  async function printSummary(records, labelHint) {
    const list = records || currentRecords;
    if (!list.length) { UI.toast('No records to print', 'error'); return; }
    if (typeof buildPayrollSummaryHtml === 'undefined') { UI.toast('Print module failed to load', 'error'); return; }
    const period = labelHint || state.period;
    const cutoffId = currentRecords.find(r => r.period === period && r.data && r.data.cutoff_id)?.data.cutoff_id;
    const meta = period ? periodsMeta.find(p => cutoffId ? p.id === Number(cutoffId) : p.label === period) : null;
    const company = await API.get('/templates/company').catch(() => null);
    const subtitle = `${list.length} payslip${list.length === 1 ? '' : 's'}` +
      (!labelHint && state.status ? ` — status "${state.status}"` : '') +
      (!labelHint && state.q ? ` — search "${state.q}"` : '');
    const html = buildPayrollSummaryHtml(list, formDef, {
      title: period || formDef.name,
      subtitle,
      company,
      dateRange: meta ? `${meta.start_date} – ${meta.end_date}` : '',
      printedAt: new Date().toLocaleString(),
    });
    UI.modal({
      title: 'Payroll Summary Preview',
      size: 'xl',
      bodyHTML: `<iframe id="payroll-summary-frame" style="width:100%;height:70vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
      cancelText: 'Close',
      confirmText: 'Print…',
      onOpen: (ov) => { ov.querySelector('#payroll-summary-frame').srcdoc = UI.printableHtml(html, `Payroll Summary - ${period || formDef.name}`); },
      onConfirm: (ov) => {
        const ifr = ov.querySelector('#payroll-summary-frame');
        ifr.contentWindow.focus();
        ifr.contentWindow.print();
        return false;
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
  async function payslipDetailModal(r, openAdjustments = false) {
    let detail;
    try {
      detail = await API.get(`/hr/payroll/${r.id}/detail`);
    } catch (err) {
      // Imported/legacy slips can lack a matching employee or attendance cutoff.
      // Keep their saved slip review available without pretending to have attendance data.
      detail = { employee_name: r.data.employee_name || 'Unknown employee', days: [], late_exempt: false, warning: err.message };
    }

    let slipHtml='',templateBody,printContext={company:{},global:{},variables:[]};
    try {
      const form=await API.get('/form-definitions/'+formDef.id);
      if(form.template_id){const tpl=await API.get('/templates/'+form.template_id),context=await loadPrintContext(tpl.id);templateBody=tpl.body;printContext=context;slipHtml=renderSlip({...payrollPrintData(r),company:context.company,global:context.global},tpl.body,context.variables);}
    } catch(err){UI.toast(err.message||'Could not load the default payslip layout','error');}

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
    const dedSection = canManagePayroll && !detail.warning ? `
      <details class="panel pd-adjustments" style="margin-bottom:14px;padding:12px 14px">
        <summary>Adjust payslip deductions${locked ? ' — locked' : ''}</summary>
        <div><strong>Statutory Deductions</strong>
        <p class="muted">Adjust deductions for this payslip only. Enter an amount to override automatic calculation; leave it blank to use automatic calculation. Zero is a valid override. Employee deductions only; employer contributions remain automatic. Totals update in the preview; click Save Deductions to persist changes.</p>
        <div class="statutory-adjustments">${Object.keys(DED_LABELS).map((k) => `
          <div data-validation-field class="statutory-adjustment">
            <label><input type="checkbox" data-ded="${k}" ${r.data[k + '_applied'] !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${DED_LABELS[k]}</label>
            <label for="pd-override-${k}">Override amount</label>
            <input id="pd-override-${k}" data-ded-override="${k}" type="number" min="0" max="10000000" step="0.01" placeholder="Automatic" value="${r.data.statutory_overrides?.[k] != null ? UI.esc(String(r.data.statutory_overrides[k])) : ''}" ${locked ? 'disabled' : ''}>
            <span data-ded-amount="${k}" class="muted">${UI.money(r.data[k])} · ${r.data.statutory_overrides?.[k] != null ? 'Manual' : 'Automatic'}</span>
            ${!locked ? `<button type="button" class="btn secondary small" data-ded-reset="${k}">Use automatic</button>` : ''}
          </div>`).join('')}</div>
        ${!locked ? `<label for="pd-change-reason">Reason for deduction change${formDef.archived_at ? ' *' : ' (optional)'}</label><textarea id="pd-change-reason" maxlength="1000" rows="2" ${formDef.archived_at ? 'aria-required="true"' : ''}></textarea>` : ''}
        <p id="pd-save-state" role="status">Saved</p><div id="pd-later-cutoffs" class="muted"></div>
        <p id="pd-ded-error" class="form-error hidden" role="alert"></p>
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
      </div></details>` : '';

    let deductionsDirty = false;
    const payslipModal = UI.modal({
      protectChanges: true, isDirty: () => deductionsDirty,
      title: `Payslip — ${detail.employee_name}`,
      size: 'xl',
      headActionHTML: `${detail.warning && canManagePayroll && r.status !== 'paid' ? '<button type="button" class="btn secondary small" id="pd-edit-imported">Adjust imported values</button>' : ''}<button type="button" class="btn secondary small" id="pd-history">Deduction history</button><button type="button" class="btn secondary small" id="pd-print">${UI.icon('printer')} Print</button>`,
      bodyHTML: `
        ${detail.notice ? `<p class="hr-workflow-notice" role="status">${UI.esc(detail.notice)}</p>` : ''}
        <div id="pd-slip" style="border:1px solid var(--border-strong);border-radius:8px;padding:8px;margin-bottom:14px;background:#fff;color:#111">${slipHtml}</div>
        ${detail.late_exempt ? `<p class="muted" style="font-size:12px;margin:0 0 8px">This employee is exempt from late deductions —
          late minutes are still shown below for reference, but never subtracted from pay.</p>` : ''}
        ${detail.always_whole_day ? `<p class="muted" style="font-size:12px;margin:0 0 8px">This employee is always paid a whole day —
          any day with both a time in and a time out counts in full, with no half day, late or undertime.</p>` : ''}
        ${detail.warning ? `<p class="form-error">${UI.esc(detail.warning)}</p>` : ''}
        ${dedSection}
        <div class="line-items" tabindex="0" role="region" aria-label="Attendance breakdown"><table class="line-table"><thead><tr>
          <th>Date</th><th>Time In</th><th>Time Out</th><th>Day Type</th><th>Late</th><th>Undertime</th><th>OT</th><th>Holiday/Rest-Day Premium</th><th>Night Diff</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">No attendance recorded for this period</td></tr>'}</tbody></table></div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        // Local working copy — the print button and any live edits below use this, never
        // mutating the caller's own `r.data` unless/until Save actually persists it, so
        // closing without saving leaves the record (and the list behind this modal) untouched.
        if (openAdjustments) ov.querySelector('.pd-adjustments')?.setAttribute('open', '');
        ov.querySelector('#pd-history').onclick = async () => { try {
          const history=await API.get(`/hr/payroll/${r.id}/deductions-history`);
          UI.modal({title:'Deduction history — '+r.number,size:'lg',cancelText:'Close',bodyHTML:history.length?history.map(entry=>`<section class="form-history-entry"><p><strong>${UI.esc(entry.changed_by_name)}</strong> · ${UI.esc(DataForms.displayTime(entry.created_at))}</p><p>${UI.esc(entry.reason||'No reason provided')}</p><table><thead><tr><th>Deduction</th><th>Before</th><th>After</th></tr></thead><tbody>${Object.entries(DED_LABELS).map(([key,label])=>`<tr><td>${label}</td><td>${UI.money(entry.before_values[key])}<small> · ${entry.before_values.applied?.[key]===false?'Off':entry.before_values.overrides?.[key]!=null?'Manual':'Automatic'}</small></td><td>${UI.money(entry.after_values[key])}<small> · ${entry.after_values.applied?.[key]===false?'Off':entry.after_values.overrides?.[key]!=null?'Manual':'Automatic'}</small></td></tr>`).join('')}<tr><td>Total deductions</td><td>${UI.money(entry.before_values.total_deductions)}</td><td>${UI.money(entry.after_values.total_deductions)}</td></tr><tr><td>Net pay</td><td>${UI.money(entry.before_values.net_pay)}</td><td>${UI.money(entry.after_values.net_pay)}</td></tr></tbody></table></section>`).join(''):'<p>No manual deduction changes have been recorded yet.</p>'});
        }catch(error){UI.toast(error.message,'error');} };
        let liveData = { ...r.data };
        const saveState=ov.querySelector('#pd-save-state');
        const markUnsaved=()=>{if(saveState)saveState.textContent='Unsaved changes';};
        ov.addEventListener('input', () => { deductionsDirty = true; markUnsaved(); });
        ov.addEventListener('change', () => { deductionsDirty = true; markUnsaved(); });
        ov.querySelector('#pd-edit-imported')?.addEventListener('click', () => { payslipModal.close(); recordModal(r); });
        const btn = ov.querySelector('#pd-print');
        if (btn) btn.onclick = async () => {
          btn.disabled = true;
          try {
            if (deductionsDirty && dedCheckboxes.length && !await refreshPreview()) return;
            if (ov.isConnected) await printSlips([{...payrollPrintData(r),...liveData}]);
          } finally { btn.disabled = false; }
        };

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

        const currentApplied = (requireReason = false) => {
          const applied = { other_deductions: otherDeductions, statutory_overrides: {}, change_reason:ov.querySelector('#pd-change-reason')?.value.trim(), expected_revision:r.revision || 1 };
          const errors = [];
          if(requireReason&&formDef.archived_at&&!applied.change_reason) errors.push({control:ov.querySelector('#pd-change-reason'),message:'A reason is required for this archived payslip correction.'});
          ov.querySelectorAll('[data-ded-override]').forEach(input => {
            if (input.validity.badInput || (input.value !== '' && (!input.validity.valid || !Number.isFinite(Number(input.value))))) {
              errors.push({ control: input, message: DED_LABELS[input.dataset.dedOverride] + ' must be between 0 and 10,000,000 with at most two decimal places.' });
            }
            applied.statutory_overrides[input.dataset.dedOverride] = input.value === '' ? null : Number(input.value);
          });
          if (!FormValidation.show(ov, errors, ov.querySelector('#pd-ded-error'))) {
            const error = new Error('Correct the deduction amounts before continuing.'); error.fieldValidation = true; throw error;
          }
          dedCheckboxes.forEach((cb) => { applied[cb.dataset.ded + '_applied'] = cb.checked; });
          return applied;
        };
        // Re-renders the ACTUAL slip visual with the recomputed numbers — this is the one
        // thing the user is looking at, not a separate summary table off to the side.
        const applyPreview = (vals) => {
          const {revision,ok,later_cutoffs,...amounts}=vals;
          liveData = { ...liveData, ...amounts };
          Object.keys(DED_LABELS).forEach(key => {
            ov.querySelector(`[data-ded-amount="${key}"]`).textContent = `${UI.money(liveData[key])} · ${liveData.statutory_overrides?.[key] != null ? 'Manual' : 'Automatic'}`;
          });
          if(templateBody)slipEl.innerHTML=renderSlip({...liveData,record:{number:r.number,status:r.status,created_at:r.created_at},company:printContext.company,global:printContext.global},templateBody,printContext.variables);
        };
        let previewGeneration = 0;
        const refreshPreview = async () => {
          ov.querySelector('#pd-ded-error').classList.add('hidden');
          deductionsDirty = true; markUnsaved();
          const generation = ++previewGeneration;
          dedCheckboxes.forEach((cb) => { cb.disabled = locked; });
          try {
            const values = await API.post(`/hr/payroll/${r.id}/preview-deductions`, currentApplied());
            if (generation === previewGeneration && ov.isConnected) { applyPreview(values); return true; }
            return false;
          }
          catch (err) { if (!err.fieldValidation) { const error = ov.querySelector('#pd-ded-error'); error.hidden = false; error.textContent = err.message; error.classList.remove('hidden'); } return false; }
        };
        dedCheckboxes.forEach((cb) => cb.addEventListener('change', refreshPreview));
        ov.querySelectorAll('[data-ded-override]').forEach(input => input.addEventListener('change', refreshPreview));
        ov.querySelectorAll('[data-ded-reset]').forEach(button => button.onclick = () => {
          ov.querySelector(`[data-ded-override="${button.dataset.dedReset}"]`).value = ''; refreshPreview();
        });

        const saveBtn = ov.querySelector('#pd-ded-save');
        if (saveBtn) {
          saveBtn.onclick = async () => {
            ov.querySelector('#pd-ded-error').classList.add('hidden');
            let applied;
            try { applied = currentApplied(true); } catch { return; }
            ++previewGeneration;
            const editControls = [...ov.querySelectorAll('[data-ded], [data-ded-override], [data-ded-reset], [data-other-ded-del], #pd-other-ded-label, #pd-other-ded-amount, #pd-other-ded-add, #pd-change-reason')];
            editControls.forEach(control => { control.disabled = true; });
            saveBtn.disabled = true; if(saveState)saveState.textContent='Saving…';
            ov.__setSaving(true);
            let finishSave;
            ov.__whenSaved = new Promise(resolve => { finishSave = resolve; });
            try {
              const vals = await API.put(`/hr/payroll/${r.id}/deductions`, applied);
              applyPreview(vals);
              r.revision = vals.revision || r.revision;
              if(saveState)saveState.textContent='Saved';
              const later=ov.querySelector('#pd-later-cutoffs');
              if(later && vals.later_cutoffs?.length){later.innerHTML='<p>Review later cutoffs in this month after changing earlier deductions. Regenerate unpaid cutoffs in date order; paid slips stay locked.</p>'+vals.later_cutoffs.map(cutoff=>`<button type="button" class="btn secondary small" data-later-cutoff="${UI.esc(cutoff.label)}">${UI.esc(cutoff.label)} · ${UI.esc(cutoff.status)}</button>`).join('');later.querySelectorAll('[data-later-cutoff]').forEach(button=>button.onclick=()=>App.navigate('form-records',{form_id:formId,period:button.dataset.laterCutoff}));}
              if(ov.querySelector('#pd-change-reason'))ov.querySelector('#pd-change-reason').value='';
              r.data = liveData; // so the row behind this modal reflects it once it closes
              deductionsDirty = false;
              payslipModal.markSaved();
              UI.toast('Deductions saved');
              load();
            } catch (err) { if(saveState)saveState.textContent='Could not save — your changes are still here'; const error = ov.querySelector('#pd-ded-error'); error.hidden = false; error.textContent = err.message; error.classList.remove('hidden'); }
            finally {
              saveBtn.disabled = false; editControls.forEach(control => { control.disabled = locked; });
              ov.__setSaving(false); ov.__whenSaved = null; finishSave();
            }
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
  async function printRecordsViaTemplate(records,templateId) {
    if(!templateId)return choosePrintLayout(id=>printRecordsViaTemplate(records,id));
    if (!templateId) { UI.toast('No print template linked to this form', 'error'); return; }
    if (!records.length) { UI.toast('No records to print', 'error'); return; }
    let tpl;
    try { tpl = await API.get('/templates/' + templateId); }
    catch { UI.toast('The linked template could not be loaded', 'error'); return; }
    const context=await loadPrintContext(templateId);
    const renderRecord = r => renderTemplate(tpl.body,applyVariables({...r.data,fields:r.data,number:r.number,today:new Date().toLocaleDateString(),record:{number:r.number,status:r.status,created_at:r.created_at},company:context.company,global:context.global},context.variables));
    const tiled = (typeof buildTiledPagesHtml === 'function')
      ? buildTiledPagesHtml(records, renderRecord, {
        copiesPerRecord: tpl.copies_per_record, recordsPerPage: tpl.records_per_page, tileFill: tpl.tile_fill,
        continuous: !!tpl.tile_continuous, gapXmm:tpl.grid_gap_x_mm,gapYmm:tpl.grid_gap_y_mm,repeatCount: tpl.repeat_count,
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
        <iframe id="fr-tpl-preview-frame" title="${UI.esc(title)} print preview" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
      cancelText: 'Close',
      confirmText: 'Print…',
      onOpen: (ov) => {
        const ifr = ov.querySelector('#fr-tpl-preview-frame');
        // Same shrink-to-fit as printSlips()'s fitPayslipCells() above, generalized for any
        // tiled template: once the tiled grid has actually rendered (real layout needed),
        // shrink any cell whose content overflows its fixed-height grid cell instead of
        // leaving it silently clipped by .tiled-grid's overflow:hidden.
        UI.loadPrintFrame(ifr, full, tiled && typeof fitTiledCells === 'function' ? fitTiledCells : undefined);
        const attachBtn = ov.querySelector('#fr-attach-pdf');
        if (attachBtn) attachBtn.onclick = () => attachPdfModal(records[0]);
      },
      onConfirm: async (ov) => {
        const ifr = ov.querySelector('#fr-tpl-preview-frame');
        await UI.printFrame(ifr);
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
      protectChanges: true,
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
    let reviewed = null;
    let reviewedSignature = '';
    function payload(overlay, preview) {
      const file = overlay.querySelector('[data-f=file]').files[0];
      const period = overlay.querySelector('[data-f=period]').value.trim();
      if (!period || !file) throw new Error('Choose a CSV file and enter the payroll period.');
      const date = overlay.querySelector('[data-f=pay_date]').value;
      const signature = JSON.stringify([period, date, file.name, file.size, file.lastModified]);
      const data = new FormData(); data.append('file', file); data.append('period', period); data.append('pay_date', date);
      if (preview) data.append('dry_run', '1');
      else {
        if (overlay.querySelector('#fr-import-duplicates')?.checked) data.append('allow_duplicates', '1');
        if (overlay.querySelector('#fr-import-partial')?.checked) data.append('allow_partial','1');
      }
      return { data, signature };
    }
    UI.modal({
      protectChanges: true, title: 'Review payroll CSV',
      bodyHTML: `<p>Upload the payroll Summary CSV. Review employees, period and totals before importing.</p>
        <label>Payroll period *</label><input data-f="period" placeholder="e.g. October 1–15, 2026">
        <label>CSV file *</label><input type="file" accept=".csv,text/csv" data-f="file">
        <label>Pay date</label><input type="date" data-f="pay_date">
        <div id="fr-import-review" aria-live="polite"></div>`,
      confirmText: 'Preview import',
      isConfirmDisabled:()=>reviewed?.count===0,
      onOpen: overlay => {
        overlay.addEventListener('change', event => {
          if (!event.target.matches('[data-f]')) return;
          reviewed = null; reviewedSignature = '';
          overlay.querySelector('#fr-import-review').innerHTML = '';
          overlay.querySelector('[data-confirm]').textContent = 'Preview import';overlay.querySelector('[data-confirm]').disabled=false;
        });
      },
      onConfirm: async (overlay, showError) => {
        const request = payload(overlay, !reviewed);
        if (!reviewed || reviewedSignature !== request.signature) {
          const previewRequest = payload(overlay, true);
          reviewed = await API.upload('/form-definitions/' + formId + '/import', previewRequest.data);
          reviewedSignature = previewRequest.signature;
          overlay.querySelector('#fr-import-review').innerHTML = `<h4>${reviewed.count} payslips · ${UI.esc(reviewed.period)}</h4><p>Gross ${UI.money(reviewed.total_earnings)} · Deductions ${UI.money(reviewed.total_deductions)} · Net ${UI.money(reviewed.net_pay)}</p>
            ${reviewed.rejected_count ? `<div class="form-error"><p>${reviewed.rejected_count} row(s) need correction.</p><button type="button" class="btn secondary small" id="fr-rejected-download">Download rejected rows with explanations</button><ul>${reviewed.rejected.map(row=>`<li>Row ${row.line}: ${UI.esc(row.error)}</li>`).join('')}</ul><label><input type="checkbox" id="fr-import-partial"> Import only the ${reviewed.count} valid rows; rejected rows will not be saved.</label></div>` : ''}
            ${reviewed.duplicate_count ? `<div class="form-error"><p>${reviewed.duplicate_count} row(s) match existing payslips in this period. Importing will add more records; existing payslips will not be replaced.</p><label><input id="fr-import-duplicates" type="checkbox"> I confirm importing these matching rows as additional payslips.</label></div>` : ''}
            <div class="fr-import-table" tabindex="0" role="region" aria-label="Import preview"><table><thead><tr><th>Employee</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Existing matches</th></tr></thead><tbody>${reviewed.rows.map(row => `<tr><td>${UI.esc(row.employee_name)}</td><td>${UI.money(row.total_earnings)}</td><td>${UI.money(row.total_deductions)}</td><td>${UI.money(row.net_pay)}</td><td>${UI.esc(row.matched_numbers.join(', ') || 'None')}</td></tr>`).join('')}</tbody></table></div>`;
          const download=overlay.querySelector('#fr-rejected-download');
          if(download)download.onclick=()=>{const blob=new Blob([reviewed.rejected_csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='payroll-rejected-rows.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
          overlay.querySelector('[data-confirm]').textContent = reviewed.count ? 'Import reviewed payslips' : 'Fix rejected rows first';
          overlay.querySelector('[data-confirm]').disabled = !reviewed.count;
          return false;
        }
        if(reviewed.rejected_count&&!overlay.querySelector('#fr-import-partial')?.checked){showError('Confirm importing valid rows only, or correct the rejected file first.');return false;}
        if (reviewed.duplicate_count && !overlay.querySelector('#fr-import-duplicates').checked) { showError('Confirm the duplicate import before continuing.'); return false; }
        let result;
        try { result = await API.upload('/form-definitions/' + formId + '/import', request.data); }
        catch (error) {
          reviewed = null; reviewedSignature = '';
          overlay.querySelector('#fr-import-review').innerHTML = '';
          overlay.querySelector('[data-confirm]').textContent = 'Preview import';
          showError(error.message + ' Review the file again before importing.');
          return false;
        }
        state.period = result.period; await load(); UI.toast(`${result.created} payslips imported`);
      },
    });
  }

  let loadGeneration = 0;
  let hasLoadedRecords = false;
  async function load() {
    if (formRecordViews.get(view) !== owner || !view.querySelector('#fr-table')) return;
    App.replaceFilters?.('form-records', { ...navigation, form_id: String(formId), q: state.q, status: state.status, period: state.period });
    const generation = ++loadGeneration;
    const el = view.querySelector('#fr-table');
    if (!el) return;
    view.querySelector('#fr-load-error')?.remove();
    if (!hasLoadedRecords) el.innerHTML = '<div class="empty">Loading…</div>';
    el.setAttribute('aria-busy', 'true');
    const actionControls = [...view.querySelectorAll('#fr-new, #fr-del-all, #fr-download-csv, #fr-import-csv, #fr-print-slips, #fr-print-all-tpl, #fr-bulk-bar button, #fr-table button, #fr-table input')];
    const disabledBefore = new Map(actionControls.map((control) => [control, control.disabled]));
    actionControls.forEach((control) => { control.disabled = true; });
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    if (state.period) params.set('period', state.period);
    if (isPayroll) view.querySelector('#fr-filter-reset').hidden = !(state.q || state.status || state.period);
    const periodsReq = isPayroll && periodCombo ? API.get('/form-definitions/' + formId + '/periods').catch(() => null) : null;
    const periodsMetaReq = isPayroll && !state.period ? API.get('/hr/periods').catch(() => []) : null;
    let records;
    try {
      records = await API.get('/form-definitions/' + formId + '/records?' + params.toString());
    } catch (error) {
      if (generation !== loadGeneration || !el.isConnected) return;
      el.setAttribute('aria-busy', 'false');
      if (!hasLoadedRecords) el.innerHTML = '';
      const message = document.createElement('div');
      message.id = 'fr-load-error';
      message.className = 'form-error';
      message.setAttribute('role', 'alert');
      message.innerHTML = `<p>Could not load records. ${UI.esc(error.message || 'Please try again.')}${hasLoadedRecords ? ' Previously loaded records are shown; actions are unavailable until refresh succeeds.' : ''}</p><button class="btn secondary" type="button">Retry</button>`;
      message.querySelector('button').onclick = () => load();
      el.before(message);
      return;
    }
    if (generation !== loadGeneration || !el.isConnected) return;
    el.setAttribute('aria-busy', 'false');
    actionControls.forEach((control) => { control.disabled = disabledBefore.get(control); });
    // These toolbar actions remain disabled after an error until a successful retry.
    view.querySelectorAll('#fr-new, #fr-del-all, #fr-download-csv, #fr-import-csv, #fr-print-slips, #fr-print-all-tpl, #fr-bulk-bar button').forEach((control) => { control.disabled = !!formDef.archived_at && ['fr-new','fr-del-all','fr-import-csv','fr-bulk-del'].includes(control.id); });
    hasLoadedRecords = true;
    records.forEach(record => { record.schema = formVersions.get(record.definition_version) || record.schema; });
    currentRecords = records;
    selectedIds.clear();
    updateBulkBar();
    // Refresh the period picker with known periods (preserving selection).
    const periods = await periodsReq;
    if (periodCombo && periods) {
      periodCombo.setOptions(periodOptions(periods));
      periodCombo.setSelected(state.period);
    }
    if (periodsMetaReq) periodsMeta = await periodsMetaReq;
    if (generation !== loadGeneration || !el.isConnected) return;
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
    const available = columnFields();
    const visibleFields = Array.isArray(viewPreferences.columns) ? viewPreferences.columns.map(key=>available.get(key)).filter(Boolean) : formDef.fields.slice(0,4);
    return `<table>
      <thead><tr>
        <th style="width:36px;text-align:center"><input type="checkbox" ${checkAllAttr} title="Select all" /></th>
        <th>Number</th>
        ${visibleFields.map((f) => `<th>${UI.esc(f.label)}</th>`).join('')}
        <th>Status</th><th>Date</th><th></th>
      </tr></thead>
      <tbody>${records.map((r) => `
        <tr class="clickable" data-id="${r.id}">
          <td style="text-align:center"><input type="checkbox" data-row-check="${r.id}" ${selectedIds.has(r.id) ? 'checked' : ''}${isPayroll ? ` aria-label="Select ${UI.esc(r.number)}"` : ''} /></td>
          <td>${isPayroll
            // A real button, so Tab + Enter opens the payslip detail; its click bubbles to the row.
            ? `<button type="button" class="hr-row-open" title="View payslip details">${UI.esc(r.number)}</button>`
            : `<strong>${UI.esc(r.number)}</strong>`}<small class="muted"> · v${r.definition_version || 1} / r${r.revision || 1}</small></td>
          ${visibleFields.map((f) => `<td>${UI.esc(DataForms.displayValue(r.data[f.key],f))}</td>`).join('')}
          <td><span class="badge-pill status-${UI.esc(r.status)}">${UI.esc(r.status)}</span></td>
          <td>${UI.esc(UI.fmtDateShort(r.created_at))}</td>
          <td class="actions"><button type="button" class="icon-btn" data-history="${r.id}" title="Change history" aria-label="Change history for ${UI.esc(r.number)}">${UI.icon('clock')}</button>
            ${isPayroll ? `<button class="icon-btn" data-print="${r.id}" title="Print this slip" aria-label="Print payslip ${UI.esc(r.number)}">${UI.icon('printer')}</button>` : ''}
            ${!isPayroll && formDef.template_id ? `<button class="icon-btn" data-print-tpl="${r.id}" title="Print">${UI.icon('printer')}</button>` : ''}
            ${isPayroll && canManagePayroll ? `<button class="icon-btn" data-email="${r.id}" title="Email this payslip" aria-label="Email payslip ${UI.esc(r.number)}">${UI.icon('mail')}</button>` : ''}
            ${isPayroll && canManagePayroll ? (r.status === 'paid'
              ? `<button class="icon-btn" data-unpaid="${r.id}" title="Unmark Paid (unlock for editing)" aria-label="Unmark payslip ${UI.esc(r.number)} as paid">${UI.icon('reply', 15)}</button>`
              : `<button class="icon-btn" data-paid="${r.id}" title="Mark as Paid (locks this payslip)" aria-label="Mark payslip ${UI.esc(r.number)} as paid">${UI.icon('check')}</button>`) : ''}
            ${r.status !== 'paid' && canWrite && (!entryOnly || (r.status==='draft'&&!formDef.archived_at)) ? `<button class="icon-btn" data-edit="${r.id}" title="Edit"${isPayroll ? ` aria-label="Edit payslip ${UI.esc(r.number)}"` : ''}>${UI.icon('edit')}</button>` : ''}
            ${!entryOnly && !formDef.archived_at && r.status !== 'paid' && canWrite && !HR_REQUEST_SLUGS.includes(formDef.slug) ? `<button class="icon-btn danger" data-del="${r.id}" title="Delete"${isPayroll ? ` aria-label="Delete payslip ${UI.esc(r.number)}"` : ''}>${UI.icon('trash')}</button>` : ''}
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
      label, records: recs, meta: periodsMeta.find(p => recs[0]?.data?.cutoff_id ? p.id === Number(recs[0].data.cutoff_id) : p.label === label) || null,
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

    return bundles.map((b, i) => {
      const open = expandedBundles.has(b.label);
      const t = payslipTotals(b.records);
      const dateRange = b.meta ? `${UI.esc(b.meta.start_date)} – ${UI.esc(b.meta.end_date)} · ` : '';
      // The caret + label is a real disclosure <button> (keyboard + screen-reader state); a
      // click anywhere else on the header still toggles via [data-bundle-toggle] below.
      return `<div class="panel payroll-bundle" style="margin-bottom:10px;padding:0;overflow:hidden">
        <div class="payroll-bundle-head clickable" data-bundle-toggle="${UI.esc(b.label)}"
             style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 16px">
          <button type="button" class="payroll-bundle-toggle" aria-expanded="${open}" aria-controls="fr-bundle-${i}">
            <span class="payroll-bundle-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>
            <span>
              <strong>${UI.esc(b.label)}</strong>
              <span class="muted payroll-bundle-meta">${dateRange}${b.records.length} payslip${b.records.length === 1 ? '' : 's'}</span>
            </span>
          </button>
          <div style="display:flex;gap:22px;flex-wrap:wrap">
            <div><div class="muted" style="font-size:10.5px">Gross</div><div style="font-weight:700;font-size:13px">${UI.money(t.gross)}</div></div>
            <div><div class="muted" style="font-size:10.5px">Deductions</div><div style="font-weight:700;font-size:13px">${UI.money(t.totalDeductions)}</div></div>
            <div><div class="muted" style="font-size:10.5px">Net Pay</div><div style="font-weight:700;font-size:13px">${UI.money(t.net)}</div></div>
          </div>
          <div class="grow"></div>
          <div class="payroll-bundle-actions" data-bundle-actions style="display:flex;gap:6px">
            <button type="button" class="btn secondary small" data-bundle-print="${UI.esc(b.label)}">${UI.icon('printer', 13)} Print visible</button>
            <button type="button" class="btn secondary small" data-bundle-summary="${UI.esc(b.label)}">${UI.icon('printer', 13)} Print Summary</button>
            <button type="button" class="btn secondary small" data-bundle-csv="${UI.esc(b.label)}">${UI.icon('download', 13)} Export Excel</button>
            ${canManagePayroll && b.meta ? `<button type="button" class="btn secondary small" data-bundle-post-gl="${b.meta.id}" data-bundle-post-gl-label="${UI.esc(b.label)}">${UI.icon('building', 13)} Post to GL</button>` : ''}
          </div>
        </div>
        <div ${open ? '' : 'hidden'} id="fr-bundle-${i}" data-bundle-body="${UI.esc(b.label)}" style="border-top:1px solid var(--border,#dce6f2)">
          ${tableHTML(b.records, `data-check-all="${UI.esc(b.label)}"`)}
        </div>
      </div>`;
    }).join('');
  }

  function renderRecords(records) {
    const el = view.querySelector('#fr-table');
    if (!records.length && isPayroll) {
      // Payroll counts the period filter too, offers one-step recovery, and only offers New
      // Record to someone who can write payslips.
      const filtered = !!(state.q || state.status || state.period);
      el.innerHTML = UI.emptyState({
        icon: formDef.icon || 'file',
        title: filtered ? 'No payslips match these filters' : 'No payslips yet',
        hint: filtered
          ? 'Try a different name, status or period.'
          : 'Generate payslips from a Time Keeping cutoff, or upload a payroll CSV.',
        action: filtered
          ? '<button type="button" class="btn secondary" id="fr-empty-clear">Clear filters</button>'
          : (canManagePayroll && !formDef.archived_at ? `<button type="button" class="btn" id="fr-empty-new">${UI.icon('plus')} New Record</button>` : ''),
      });
      const clear = el.querySelector('#fr-empty-clear');
      if (clear) clear.onclick = () => clearPayrollFilters();
      const en = el.querySelector('#fr-empty-new');
      if (en) en.onclick = () => recordModal(null);
      return;
    }
    if (!records.length) {
      el.innerHTML = UI.emptyState({
        icon: formDef.icon || 'file',
        title: state.q || state.status ? 'No matching records' : `No ${formDef.name} records yet`,
        hint: state.q || state.status ? 'Try a different search or status.' : 'Create the first record to get started.',
        action: !formDef.archived_at && !state.q && !state.status
          ? `<button class="btn" id="fr-empty-new">${UI.icon('plus')} ${isPayroll ? 'Generate payslips' : 'New Record'}</button>` : '',
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
        // The re-render replaced the button a keyboard user just pressed; put focus back on it.
        const again = [...el.querySelectorAll('[data-bundle-toggle]')].find((h) => h.dataset.bundleToggle === label);
        const toggleBtn = again && again.querySelector('.payroll-bundle-toggle');
        if (toggleBtn) toggleBtn.focus();
      });
      el.querySelectorAll('[data-bundle-print]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        printSlips(records.filter((r) => (r.period || '(no period)') === b.dataset.bundlePrint).map(payrollPrintData));
      });
      el.querySelectorAll('[data-bundle-summary]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        const label = b.dataset.bundleSummary;
        printSummary(records.filter((r) => (r.period || '(no period)') === label), label);
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
        if (r) printSlips([payrollPrintData(r)]);
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
      b.onclick = (e) => { e.stopPropagation(); openRecord(b.dataset.edit, records, true); });
    el.querySelectorAll('[data-history]').forEach(button=>button.onclick=event=>{event.stopPropagation();DataForms.recordHistory(records.find(record=>String(record.id)===button.dataset.history)).catch(error=>UI.toast(error.message,'error'));});
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

  function openRecord(id, records, adjust = false) {
    const r = records.find((x) => String(x.id) === String(id));
    if (r) { if (isPayroll) payslipDetailModal(r, adjust); else recordModal(r); }
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
    if (view.querySelector('#fr-load-error') || view.querySelector('#fr-table')?.getAttribute('aria-busy') === 'true') {
      UI.toast('Refresh records before editing.', 'error');
      return;
    }
    if (!existing && formDef.archived_at) { UI.toast('Restore this form before creating records.', 'error'); return; }
    const editing = !!existing;
    if(entryOnly&&existing&&(existing.status!=='draft'||formDef.archived_at)){
      UI.modal({title:existing.number,cancelText:'Close',bodyHTML:`<p>Status: ${UI.esc(existing.status)}. Entry users can edit active drafts only.</p>${(existing.schema?.fields||formDef.fields).map(field=>`<p><strong>${UI.esc(field.label)}</strong>: ${UI.esc(DataForms.displayValue(existing.data[field.key],field))}</p>`).join('')}`});return;
    }
    const linkedOrder=existing?.sales_order_id||existing?.sales_order?.order_id;
    if(linkedOrder){UI.modal({title:'Submitted '+existing.number,cancelText:'Close',bodyHTML:`<p>This record created sales order ${UI.esc(existing.sales_order_number||existing.sales_order?.order_number||'')}. Its submitted values are retained. Review and correct the draft through Sales Orders.</p>${App.hasPermission('orders.view')?'<button type="button" class="btn" data-open-linked-order>Review sales order</button>':''}`,onOpen:overlay=>{overlay.querySelector('[data-open-linked-order]')?.addEventListener('click',()=>App.navigate('orders',{type:'sale',id:linkedOrder}));}});return;}
    let saveKey=FormConnections.key(),pendingSave=null;
    const recordDefinition = existing?.schema || formDef;
    const request = HR_REQUEST_SLUGS.includes(formDef.slug);
    if (request && existing && (existing.status !== 'pending' || formDef.slug === 'information_change')) {
      UI.modal({title: `${formDef.name} — ${existing.number}`,cancelText:'Close',bodyHTML:`<p>Status: ${UI.esc(existing.status)}</p><p class="muted">HR requests are decided in Approvals. Decided requests cannot be edited.</p>${Object.entries(existing.data || {}).map(([k,v])=>`<div class="tool-row"><strong>${UI.esc(k.replace(/_/g,' '))}</strong><span>${UI.esc(String(v ?? ''))}</span></div>`).join('')}`});
      return;
    }
    const data = editing ? { ...existing.data } : { ...(prefill || {}) };
    const statusOpts = (request ? ['pending'] : entryOnly||(recordDefinition.actions||[]).some(action=>action.type==='create_sales_draft')?['draft','submitted']:['draft', 'submitted', 'approved', 'rejected', 'completed'])
      .map((s) => `<option value="${s}" ${(existing ? existing.status : 'draft') === s ? 'selected' : ''}>${s}</option>`)
      .join('');
    const employees = recordDefinition.fields.some((f) => f.type === 'employee') ? await getEmployees() : [];

    // For payroll records, append a Net Pay field so users can correct the value.
    const netPayField = isPayroll && !recordDefinition.fields.some((field) => field.key === 'net_pay') ? `
      <div style="margin-bottom:12px;padding:10px;background:var(--surface-2,#f5f7fa);border-radius:8px">
        <label for="fr-field-net_pay" style="font-weight:600">Net Pay</label>
        <input data-field="net_pay" id="fr-field-net_pay" type="number" step="0.01"
          value="${data.net_pay != null ? UI.esc(String(data.net_pay)) : ''}" />
        <div class="muted" style="font-size:11px;margin-top:4px">Auto-filled from CSV. Edit to correct if needed.</div>
      </div>` : '';

    UI.modal({
      protectChanges: true,
      title: editing ? `Edit ${existing.number}` : `New ${formDef.name}`,
      size: recordDefinition.fields.length > 6 ? 'lg' : undefined,
      bodyHTML: `
        ${entryOnly||(recordDefinition.actions||[]).some(action=>action.type==='create_sales_draft')?'<p class="panel">Save as Draft to continue editing. Submitting creates an open sales order for review and preserves these submitted values. Stock and accounting follow the sales order workflow.</p>':''}
        <div style="margin-bottom:14px">
          ${editing
            ? `<span class="muted">Status: ${UI.esc(existing.status)}. To change it, select the record and choose Change status.</span>`
            : `<label for="fr-record-status">Status</label><select id="fr-record-status" ${request ? 'disabled' : ''} data-f="status">${statusOpts}</select>`}
        </div>
        ${isPayroll ? ['Employee and period','Earnings and attendance','Deductions','Totals'].map((group,index) => `<fieldset class="payroll-edit-group"><legend>${group}</legend>${recordDefinition.fields.filter(field => {
          const totals = ['total_earnings','total_deductions','net_pay']; const deductions = ['sss','philhealth','pagibig','withholding_tax','cash_advance','late_absences']; const identity = ['employee_name','dept_position','payroll_period','pay_date'];
          return index === 0 ? identity.includes(field.key) : index === 2 ? deductions.includes(field.key) : index === 3 ? totals.includes(field.key) : !identity.includes(field.key) && !deductions.includes(field.key) && !totals.includes(field.key);
        }).map(field => renderFieldInput(field,data,employees)).join('')}</fieldset>`).join('') : recordDefinition.fields.map(field => renderFieldInput(field,data,employees)).join('')}
        ${editing ? `<label for="fr-change-reason">Reason for correction${formDef.archived_at ? ' *' : ' (optional)'}</label><textarea id="fr-change-reason" maxlength="1000" ${formDef.archived_at ? 'aria-required="true"' : ''}></textarea><p class="muted">Record revision ${existing.revision || 1} · Form version ${existing.definition_version || 1}. Previous revisions stay in Change history.</p>` : ''}
        ${netPayField}
        ${recordDefinition.fields.length === 0 && !isPayroll
          ? '<div class="muted" style="text-align:center;padding:20px">This form has no fields yet. Edit it in Form Builder to add fields.</div>'
          : ''}`,
      onOpen: (ov) => {
        FormConnections.mount(ov,recordDefinition.fields,data);
        function recalculate(){try{
          const values={...data};
          for(const field of recordDefinition.fields)if(field.type==='line_items')values[field.key]=FormItems.collect(ov,field);else if(field.type==='number')values[field.key]=ov.querySelector(`[data-field="${field.key}"]`)?.value;
          const calculated=FormMath.calculate(recordDefinition.fields,values);
          for(const field of recordDefinition.fields.filter(field=>field.type==='calculated'))ov.querySelector(`[data-field="${field.key}"]`).value=calculated[field.key];
        }catch{/* Invalid rows show their local errors; saving validates them again. */}}
        if(recordDefinition.fields.some(field=>field.type==='line_items'))FormItems.mount(ov,recordDefinition.fields,data,recalculate);
        ov.addEventListener('input',recalculate);ov.addEventListener('change',recalculate);recalculate();
        ov.querySelectorAll('select[data-field]').forEach((sel) => {
          const field = recordDefinition.fields.find((f) => f.key === sel.dataset.field);
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
        await FormConnections.ready(ov);
        // Collect field values from the modal.
        // Keep generated values and metadata that are not represented by editable fields.
        const collected = { ...data };
        const errors = [];
        for (const field of recordDefinition.fields) {
          if(field.type==='line_items'){
            const itemErrors=FormItems.validate(ov,field);
            errors.push(...itemErrors);
            if(!itemErrors.length)collected[field.key]=FormItems.collect(ov,field);
            continue;
          }
          const inp = ov.querySelector(`[data-field="${field.key}"]`);
          if (!inp) continue;
          if (field.type === 'checkbox') {
            collected[field.key] = inp.checked;
          } else {
            collected[field.key] = inp.value;
          }
          if (field.required && (field.type === 'checkbox' ? !inp.checked : !String(collected[field.key] ?? '').trim())) {
            errors.push({ control: inp, message: `${field.label} is required` });
          } else if (inp.willValidate && !inp.validity.valid) {
            errors.push({ control: inp, message: `${field.label}: ${inp.validationMessage}` });
          }
        }
        const reason = ov.querySelector('#fr-change-reason')?.value.trim();
        if (editing && formDef.archived_at && !reason) errors.push({control:ov.querySelector('#fr-change-reason'),message:'A reason is required for this archived record correction.'});
        if (!FormValidation.show(ov, errors, ov.querySelector('[data-modal-error]'))) return false;
        try{Object.assign(collected,FormMath.calculate(recordDefinition.fields,collected));}catch(error){showErr(error.message);return false;}
        // For payroll forms, also capture the net_pay value.
        if (isPayroll) {
          const netPayInp = ov.querySelector('[data-field="net_pay"]');
          if (netPayInp) collected.net_pay = netPayInp.value ? Number(netPayInp.value) : 0;
        }
        const status = editing ? existing.status : ov.querySelector('[data-f="status"]').value;

        let res;
        const payload={form_def_id:formId,expected_definition_version:formDef.version||1,data:collected,status};
        try{
          if(!editing&&!pendingSave)pendingSave=payload;
          res=editing?await API.put('/form-records/'+existing.id,{data:collected,expected_revision:existing.revision||1,change_reason:reason}):await API.post('/form-records',pendingSave,{idempotencyKey:saveKey});
        }catch(error){
          if(!editing&&error.status&&error.status<500){pendingSave=null;saveKey=FormConnections.key();ov.querySelectorAll('input,select,textarea,[data-add-item],[data-remove-item],[data-lookup-retry]').forEach(input=>input.disabled=request&&input.dataset.f==='status');}
          else if(!editing){ov.querySelectorAll('input,select,textarea,[data-add-item],[data-remove-item],[data-lookup-retry]').forEach(input=>input.disabled=true);error.message+=' — Retry Save to check the original request. Your values are kept; avoid creating another record.';}
          throw error;
        }
        UI.toast(API.syncLocal?.(res)?'Saved on this PC — awaiting synchronization':res.sales_order?'Record submitted — draft sales order '+res.sales_order.order_number+' is ready for review':editing ? 'Record saved' : 'Record created');
        const warns = (res && res.action_warnings) || [];
        if (warns.length) UI.toast('Some actions were skipped: ' + warns.join('; '), 'error');
        load();
      },
    });
  }

  function renderFieldInput(field, data, employees) {
    const val = data[field.key] ?? field.default ?? '';
    if(field.type==='line_items')return FormItems.render(field);
    if(field.type==='calculated')return `<div data-validation-field><label for="fr-field-${field.key}">${UI.esc(field.label)}${field.format==='currency'?' ('+UI.esc(field.currency||'PHP')+')':''}</label><input id="fr-field-${field.key}" data-field="${field.key}" type="number" step="any" readonly value="${UI.esc(String(val||0))}"><small class="muted">Calculated automatically</small></div>`;
    if(['reference','system'].includes(field.type))return FormConnections.render(field,val);
    const id = `fr-field-${field.key}`;
    const req = field.required ? '<span class="req">*</span>' : '';
    let input = '';
    if (field.type === 'textarea') {
      input = `<textarea data-field="${UI.esc(field.key)}" id="${id}" ${field.required ? 'aria-required="true"' : ''} rows="3">${UI.esc(String(val))}</textarea>`;
    } else if (field.type === 'checkbox') {
      input = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" data-field="${UI.esc(field.key)}" id="${id}" ${field.required ? 'aria-required="true"' : ''} ${val === true || val === 'Yes' ? 'checked' : ''} />
        <span>${UI.esc(field.label)}${req}</span>
      </label>`;
      return `<div data-validation-field style="margin-bottom:12px">${input}</div>`;
    } else if (field.type === 'select') {
      const opts = (field.options || []).map((o) =>
        `<option value="${UI.esc(o)}" ${String(val) === o ? 'selected' : ''}>${UI.esc(o)}</option>`
      ).join('');
      input = `<select data-field="${UI.esc(field.key)}" id="${id}" ${field.required ? 'aria-required="true"' : ''}>
        <option value="">— select —</option>${opts}
      </select>`;
    } else if (field.type === 'employee') {
      // Only real employees are selectable (never free text), so this always matches an actual
      // record — critical since Time Keeping/payroll match attendance to forms by exact name.
      const opts = (employees || []).map((e) =>
        `<option value="${UI.esc(e.name)}" ${String(val) === e.name ? 'selected' : ''}>${UI.esc(e.name)}</option>`
      ).join('');
      input = `<select data-field="${UI.esc(field.key)}" id="${id}" ${field.required ? 'aria-required="true"' : ''}>
        <option value="">— select employee —</option>${opts}
      </select>`;
    } else {
      input = `<input data-field="${UI.esc(field.key)}" id="${id}" ${field.required ? 'aria-required="true"' : ''} type="${field.type}" ${field.type === 'number' ? 'step="any"' : ''}
        value="${UI.esc(String(val))}" />`;
    }
    return `<div data-validation-field style="margin-bottom:12px">
      <label for="${id}">${UI.esc(field.label)}${field.format==='currency'?' ('+UI.esc(field.currency||'PHP')+')':''}${req}</label>
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
