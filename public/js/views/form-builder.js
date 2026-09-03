/* Form Builder (per-section): manage form definitions (fields) + global variables. Each nav
   entry (HR/Inventory/Admin/Accounting → Form Builder) opens this same route scoped to its own
   section via filter.scope — forms.manage.<scope> gates which sections a given user can reach.
   Route: form-builder. Tab driven: Forms | Global Variables. */
const FORM_SCOPE_LABELS = { hr: 'HR', inventory: 'Inventory', admin: 'Admin', accounting: 'Accounting' };
App.register('form-builder', async (view, filter) => {
  const scope = filter && filter.scope;
  if (!scope || !App.hasPermission('forms.manage.' + scope)) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }
  let activeTab = 'forms';

  // ── Common HR form starting points ("Quick Add") ─────────────────────────────
  // Prefills New Form with a sensible name/slug/prefix/field set for a common request type —
  // the admin still reviews and confirms in the normal form modal before anything is created.
  const req = (key, label, type, opts) => ({ key, label, type, required: true, options: opts || [], default: '' });
  const opt = (key, label, type, opts) => ({ key, label, type, required: false, options: opts || [], default: '' });
  const FORM_TEMPLATES = [
    {
      key: 'leave', label: 'Leave Form', icon: 'calendar',
      name: 'Leave Request', slug: 'leave_request', number_prefix: 'LV',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('leave_type', 'Leave Type', 'select', ['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Maternity/Paternity Leave', 'Bereavement Leave', 'Unpaid Leave']),
        req('with_pay', 'With Pay?', 'select', ['Yes', 'No']),
        req('date_from', 'Date From', 'date'),
        req('date_to', 'Date To', 'date'),
        req('days', 'Number of Days', 'number'),
        req('reason', 'Reason', 'textarea'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'halfday', label: 'Half Day Form', icon: 'calendar',
      name: 'Half Day Request', slug: 'halfday_request', number_prefix: 'HD',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('date', 'Date', 'date'),
        req('session', 'Session', 'select', ['Morning (AM)', 'Afternoon (PM)']),
        req('reason', 'Reason', 'textarea'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      // These 5 request-type templates (undertime/offset here, plus overtime/half day/holiday
      // work elsewhere in this list) exist only as a recovery path for an admin who deleted an
      // auto-seeded request form and wants to recreate it — src/db.ts's seedHrRequestForms()
      // always auto-seeds all 5 on every install already, so in the normal case this template
      // is never actually used (the slug already exists). Kept field-for-field identical to the
      // canonical auto-seeded shape (not a superset with extra convenience fields) so a
      // recreated form is guaranteed to still work with the compute engine, which reads these
      // keys directly.
      key: 'undertime', label: 'Undertime Form', icon: 'calendar',
      name: 'Undertime Request', slug: 'undertime_request', number_prefix: 'UT',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        req('work_date', 'Date', 'date'),
        // 'Yes', once this request is approved and linked to the attendance day, waives the
        // undertime deduction outright — a company-authorized paid early release, no make-up
        // owed (unlike an Offset form, which defers the obligation instead of waiving it).
        // Anything else (including left blank) still deducts, same as no form linked at all.
        req('with_pay', 'With Pay?', 'select', ['Yes', 'No']),
        req('reason', 'Reason', 'textarea'),
      ],
    },
    {
      key: 'offset', label: 'Offset Form', icon: 'calendar',
      name: 'Offset Request', slug: 'offset_form', number_prefix: 'OFS',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        req('work_date', 'Date', 'date'),
        // Optional — when both this and Adjusted Time Out are filled in, the whole day's
        // window shifts (late/OT/undertime judged against it instead of the original shift).
        // Left blank, only the time-out shifts.
        opt('new_time_in', 'New Time In (optional)', 'time'),
        req('new_time_out', 'Adjusted Time Out', 'time'),
        req('reason', 'Reason', 'textarea'),
      ],
    },
    {
      key: 'nowork', label: 'No Work Memo', icon: 'alert',
      name: 'No Work Memo', slug: 'no_work_memo', number_prefix: 'NW',
      fields: [
        req('date_from', 'Date From', 'date'),
        req('date_to', 'Date To', 'date'),
        req('reason', 'Reason', 'textarea'),
        req('paid', 'Paid?', 'select', ['Yes', 'No']),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'holiday', label: 'Holiday Work Form', icon: 'calendar',
      name: 'Holiday Work Request', slug: 'holiday_work_request', number_prefix: 'HW',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('holiday_name', 'Holiday Name', 'text'),
        req('date', 'Date', 'date'),
        req('holiday_type', 'Holiday Type', 'select', ['Regular Holiday', 'Special Non-Working Holiday']),
        req('hours_worked', 'Hours Worked', 'number'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'overtime', label: 'Overtime Form', icon: 'calendar',
      name: 'Overtime Request', slug: 'overtime_request', number_prefix: 'OT',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('date', 'Date', 'date'),
        req('time_start', 'Time Start', 'text'),
        req('time_end', 'Time End', 'text'),
        req('hours', 'Total Hours', 'number'),
        req('reason', 'Reason', 'textarea'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'travel', label: 'Travel Order Form', icon: 'calendar',
      name: 'Travel Order', slug: 'travel_order', number_prefix: 'TO',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('destination', 'Destination', 'text'),
        req('purpose', 'Purpose', 'textarea'),
        req('date_from', 'Date From', 'date'),
        req('date_to', 'Date To', 'date'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'coe', label: 'Certificate of Employment Request', icon: 'file',
      name: 'Certificate of Employment Request', slug: 'coe_request', number_prefix: 'COE',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('purpose', 'Purpose', 'select', ['Loan Application', 'Visa Application', 'New Employer', 'Government Requirement', 'Other']),
        req('date_needed', 'Date Needed', 'date'),
        opt('include_salary', 'Include Salary Details?', 'select', ['Yes', 'No']),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'resignation', label: 'Resignation & Clearance', icon: 'file',
      name: 'Resignation & Clearance', slug: 'resignation_clearance', number_prefix: 'RC',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('last_working_day', 'Last Working Day', 'date'),
        req('reason', 'Reason', 'textarea'),
        opt('turnover_notes', 'Turnover Notes', 'textarea'),
        opt('clearance_status', 'Clearance Status', 'select', ['Pending', 'Cleared']),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'incident', label: 'Incident Report', icon: 'alert',
      name: 'Incident Report', slug: 'incident_report', number_prefix: 'IR',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('incident_date', 'Date of Incident', 'date'),
        opt('location', 'Location', 'text'),
        req('description', 'Description', 'textarea'),
        opt('witnesses', 'Witnesses', 'text'),
        opt('action_taken', 'Action Taken', 'textarea'),
        opt('reported_by', 'Reported By', 'text'),
      ],
    },
    {
      key: 'reimbursement', label: 'Reimbursement Request', icon: 'sheet',
      name: 'Reimbursement Request', slug: 'reimbursement_request', number_prefix: 'RB',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('expense_type', 'Expense Type', 'select', ['Transportation', 'Medical', 'Meals', 'Supplies', 'Other']),
        req('amount', 'Amount', 'number'),
        req('date_incurred', 'Date Incurred', 'date'),
        opt('receipt_ref', 'Receipt Reference', 'text'),
        opt('description', 'Description', 'textarea'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'infoupdate', label: '201 File Update', icon: 'users',
      name: '201 File Update', slug: '201_file_update', number_prefix: 'IU',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        req('update_type', 'Update Type', 'select', ['Address', 'Civil Status', 'Dependents', 'Emergency Contact', 'Contact Number', 'Other']),
        opt('old_info', 'Current Information', 'textarea'),
        req('new_info', 'New Information', 'textarea'),
        opt('effective_date', 'Effective Date', 'date'),
      ],
    },
    {
      key: 'loan', label: 'Loan Application', icon: 'sheet',
      name: 'Loan Application', slug: 'loan_application', number_prefix: 'LN',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('loan_type', 'Loan Type', 'select', ['SSS Salary Loan', 'SSS Calamity Loan', 'Pag-IBIG Multi-Purpose Loan', 'Company Loan', 'Other']),
        req('amount', 'Amount', 'number'),
        opt('purpose', 'Purpose', 'textarea'),
        opt('terms_months', 'Terms (months)', 'number'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
    {
      key: 'training', label: 'Training / Seminar Request', icon: 'calendar',
      name: 'Training / Seminar Request', slug: 'training_request', number_prefix: 'TR',
      fields: [
        req('employee_name', 'Employee Name', 'employee'),
        opt('department', 'Department', 'text'),
        req('training_title', 'Training / Seminar Title', 'text'),
        opt('provider', 'Provider', 'text'),
        req('date_from', 'Date From', 'date'),
        req('date_to', 'Date To', 'date'),
        opt('cost', 'Cost', 'number'),
        opt('justification', 'Justification', 'textarea'),
        opt('approved_by', 'Approved By', 'text'),
      ],
    },
  ];

  async function quickAddModal() {
    // Checked against ALL forms (not just this scope) — the slug is globally unique in the DB,
    // so a catalog entry can be unavailable here even if a different section created it.
    const existing = await API.get('/form-definitions').catch(() => []);
    const usedSlugs = new Set(existing.map((f) => f.slug));
    const m = UI.modal({
      title: `Quick Add: Common HR Forms (${FORM_SCOPE_LABELS[scope]})`,
      bodyHTML: `
        <p class="muted" style="margin-top:0">Pick a starting point — you'll still review and confirm the fields before it's created.</p>
        <div class="form-card-grid">${FORM_TEMPLATES.map((t) => {
          const already = usedSlugs.has(t.slug);
          return `<div class="form-card ${already ? '' : 'clickable'}" data-tpl="${t.key}" style="${already ? 'opacity:.5' : ''}">
            <div class="form-card-icon">${UI.icon(t.icon, 32)}</div>
            <div class="form-card-info">
              <div class="form-card-name">${UI.esc(t.label)}</div>
              <div class="form-card-meta">${t.fields.length} fields</div>
              ${already ? `<div class="muted" style="font-size:12px">Slug already taken</div>` : ''}
            </div>
          </div>`;
        }).join('')}</div>`,
      cancelText: 'Close',
      onOpen: (ov) => {
        ov.querySelectorAll('.form-card[data-tpl]').forEach((card) => {
          const tpl = FORM_TEMPLATES.find((t) => t.key === card.dataset.tpl);
          if (usedSlugs.has(tpl.slug)) return;
          card.onclick = () => { m.close(); formModal(null, tpl); };
        });
      },
    });
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Form Builder — ${UI.esc(FORM_SCOPE_LABELS[scope])}</h2>
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
        <button class="btn secondary" id="fb-quick-add">${UI.icon('calendar', 14)} Quick Add (Common HR Forms)</button>
        <button class="btn" id="fb-new-form">${UI.icon('plus')} New Form</button>
      </div>
      <div class="panel"><div id="fb-forms-table"></div></div>`;
    content.querySelector('#fb-new-form').onclick = () => formModal(null);
    content.querySelector('#fb-quick-add').onclick = () => quickAddModal();
    await loadForms();
  }

  async function loadForms() {
    const el = content.querySelector('#fb-forms-table');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    const forms = (await API.get('/form-definitions')).filter((f) => f.scope === scope);
    if (!forms.length) {
      el.innerHTML = UI.emptyState({
        icon: 'file',
        title: `No ${FORM_SCOPE_LABELS[scope]} forms yet`,
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
            <button class="icon-btn" data-tpl="${f.id}" title="${f.template_id ? 'Edit print template' : 'Design print template'}">${UI.icon(f.template_id ? 'file' : 'plus', 16)}</button>
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
    el.querySelectorAll('[data-tpl]').forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); openFormTemplate(forms.find((f) => String(f.id) === String(b.dataset.tpl))); });
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

  // ── Print template link (Design/Edit print template) ────────────────────────
  // Opens (creating on first use) the doc_template linked to this form, with its own fields
  // exposed as {{variables}} — the same DocEditor used for Sale/Job/Purchase order templates.

  function formTemplateVariables(form) {
    const vars = form.fields.map((f) => ({ category: 'Form Fields', label: f.label, token: `{{${f.key}}}` }));
    vars.push(
      { category: 'Record', label: 'Record Number', token: '{{record.number}}' },
      { category: 'Record', label: 'Status', token: '{{record.status}}' },
      { category: 'Record', label: 'Date Created', token: '{{record.created_at}}' },
      { category: 'Company', label: 'Company Name', token: '{{company.name}}' },
      { category: 'Company', label: 'Company Address', token: '{{company.address}}' },
      { category: 'Company', label: 'Company Phone', token: '{{company.phone}}' },
    );
    return vars;
  }

  function sampleFieldValue(field) {
    if (field.default) return field.default;
    switch (field.type) {
      case 'number': return 1;
      case 'date': return new Date().toLocaleDateString();
      case 'checkbox': return true;
      case 'select': return (field.options && field.options[0]) || '';
      default: return field.label || 'Sample';
    }
  }

  function sampleContextFor(form) {
    const ctx = {};
    form.fields.forEach((f) => { ctx[f.key] = sampleFieldValue(f); });
    ctx.record = { number: form.number_prefix + '-00001', status: 'submitted', created_at: new Date().toLocaleDateString() };
    ctx.company = { name: 'Verdesakay Inc.', address: '123 Main St, Cebu City', phone: '(032) 555-1234' };
    return ctx;
  }

  // A proper printable "official form" layout, generated from any field list — not just a bare
  // list of labels, but a bordered card with a company/title header, dotted label:value rows,
  // and a two-signature footer (matching the visual language already used by the Employee ID
  // Card / HR Payroll Slip templates elsewhere in this codebase). Used both as the starting
  // point when someone clicks "Design print template" on a hand-built form, and stamped
  // automatically onto every Quick Add form the moment it's created.
  function defaultFormTemplateBody(form) {
    const rows = form.fields.map((f) => `
      <div class="ff-row"><span class="ff-label">${UI.esc(f.label)}</span><span class="ff-value">{{${f.key}}}</span></div>`).join('');
    return `<style>
  .ff-card { border: 1px solid #222; padding: 14px 18px; font-size: 12.5px; }
  .ff-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 10px; margin-bottom: 12px; }
  .ff-co { font-weight: 800; font-size: 15px; }
  .ff-title { text-align: right; }
  .ff-title h2 { margin: 0 0 4px; font-size: 14px; letter-spacing: .05em; }
  .ff-ref { color: #555; font-size: 11px; }
  .ff-fields { display: flex; flex-direction: column; gap: 7px; margin-bottom: 20px; }
  .ff-row { display: flex; gap: 10px; border-bottom: 1px dotted #bbb; padding-bottom: 5px; }
  .ff-label { font-weight: 700; width: 160px; flex-shrink: 0; color: #333; }
  .ff-value { flex: 1; }
  .ff-sig { display: flex; justify-content: space-between; margin-top: 32px; gap: 24px; }
  .ff-sig div { text-align: center; width: 45%; border-top: 1px solid #333; padding-top: 5px; font-size: 11px; color: #444; }
</style>
<div class="ff-card">
  <div class="ff-head">
    <div class="ff-co">{{company.name}}</div>
    <div class="ff-title"><h2>${UI.esc(form.name.toUpperCase())}</h2><div class="ff-ref">No: {{record.number}} &middot; {{record.created_at}}</div></div>
  </div>
  <div class="ff-fields">${rows}</div>
  <div class="ff-sig">
    <div>Requested By</div>
    <div>Approved By</div>
  </div>
</div>`;
  }

  // Any user who can reach this Form Builder (forms.manage.<scope>) can also design its forms'
  // print templates — deliberately NOT gated by the separate templates.edit permission, which
  // stays reserved for the hand-authored Sale/Job/Purchase Order etc. templates. Creation is
  // deferred to Save (not eagerly POSTed the moment the button is clicked), so opening the
  // editor and just closing it doesn't leave an orphan template behind.
  async function openFormTemplate(form) {
    if (!form) return;
    if (!window.DocEditor) { UI.toast('Editor failed to load', 'error'); return; }
    const existingTpl = form.template_id ? await API.get('/templates/' + form.template_id).catch(() => null) : null;
    const isNew = !existingTpl;
    const tpl = existingTpl || { name: `${form.name} Template`, type: 'generic', body: defaultFormTemplateBody(form) };
    const sample = sampleContextFor(form);
    window.DocEditor.open({
      title: isNew ? 'New Print Template' : 'Edit Print Template',
      name: tpl.name,
      type: tpl.type,
      typeOptions: ['sale', 'job', 'purchase', 'generic'],
      body: tpl.body,
      getVariables: () => formTemplateVariables(form),
      sampleContext: sample,
      renderPreview: (body) => UI.printableHtml(renderTemplate(body, sample), 'Preview'),
      onSave: async ({ name, type, body }) => {
        if (!name.trim()) return 'Template name is required';
        if (!body.trim()) return 'Template body cannot be empty';
        const res = await API.put(`/form-definitions/${form.id}/template-body`, { name: name.trim(), type, body });
        form.template_id = res.id; // keep the in-memory row in sync until the next loadForms()
        UI.toast('Template saved');
        loadForms();
        return true;
      },
    });
  }

  // ── Form definition modal ──────────────────────────────────────────────────

  // `prefill` (no .id) seeds a brand-new form from a Quick Add template — still POSTs on save
  // like any new form, just pre-populated for review instead of blank. `existing` (has .id) is
  // a real edit and always wins if somehow both were passed.
  function formModal(existing, prefill) {
    const editing = !!existing;
    const seed = existing || prefill || null;
    const fields = seed ? JSON.parse(JSON.stringify(seed.fields)) : [];
    const actions = seed && seed.actions ? JSON.parse(JSON.stringify(seed.actions)) : [];

    UI.modal({
      title: editing ? `Edit: ${existing.name}` : 'New Form',
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div style="flex:2">
            <label>Form name</label>
            <input data-f="name" value="${UI.esc(seed ? seed.name : '')}" placeholder="e.g. Leave Request" />
          </div>
          <div>
            <label>Slug <span class="muted">(unique ID)</span></label>
            <input data-f="slug" value="${UI.esc(seed ? seed.slug : '')}" placeholder="leave_request" class="mono" />
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Number prefix</label>
            <input data-f="number_prefix" value="${UI.esc(seed ? seed.number_prefix : 'FM')}" placeholder="FM" class="mono" style="width:90px" />
          </div>
          <div>
            <label>Icon</label>
            <input data-f="icon" value="${UI.esc(seed ? seed.icon : 'file')}" placeholder="file" style="width:100px" />
          </div>
        </div>
        <div style="margin-top:16px;display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <strong>Fields</strong>
          <button type="button" class="btn secondary small" id="fb-add-field">${UI.icon('plus', 14)} Add field</button>
        </div>
        <div id="fb-fields-list"></div>
        <p class="muted" style="font-size:12px;margin-top:8px">
          Each field becomes a template variable: <span class="mono">{{field_key}}</span> —
          this form belongs to <strong>${UI.esc(FORM_SCOPE_LABELS[scope])}</strong>.
        </p>
        <div style="margin-top:18px;display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <strong>Automated actions</strong>
          <button type="button" class="btn secondary small" id="fb-add-action">${UI.icon('plus', 14)} Add action</button>
        </div>
        <div id="fb-actions-list"></div>
        <p class="muted" style="font-size:12px;margin-top:8px">
          Actions run when a record is saved (or reaches <em>approved</em>). "Notify"/"File to 201"/"Email"
          use the field of type <span class="mono">employee</span> to find who the record is about.
          Message text may use <span class="mono">{number} {form} {employee} {field:key}</span>.
        </p>`,
      confirmText: editing ? 'Save form' : 'Create form',
      onOpen: (ov) => {
        const nameEl = ov.querySelector('[data-f="name"]');
        const slugEl = ov.querySelector('[data-f="slug"]');

        // Auto-fill slug from name for brand-new, blank forms only — a Quick Add template
        // already ships a sensible slug that typing in the name field shouldn't silently
        // overwrite, and editing an existing form must never rewrite its slug either.
        if (!editing && !prefill) {
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

        ov.querySelector('#fb-add-action').onclick = () => {
          actions.push({ type: 'notify_employee', run_on: 'create' });
          renderActions(ov, actions);
        };
        renderActions(ov, actions);
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
          fields, actions, scope,
        };
        if (editing) {
          await API.put('/form-definitions/' + existing.id, body);
        } else {
          const created = await API.post('/form-definitions', body);
          // Quick Add forms come with a ready-made print template already, not just field
          // defaults — no separate "Design template" click required before it's printable.
          if (prefill) {
            await API.put(`/form-definitions/${created.id}/template-body`,
              { name: `${body.name} Template`, type: 'generic', body: defaultFormTemplateBody(body) })
              .catch(() => { /* form itself still created fine; template can be designed later */ });
          }
        }
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
    const typeOptions = ['text', 'number', 'date', 'select', 'textarea', 'checkbox', 'employee']
      .map((t) => `<option value="${t}">${t === 'employee' ? 'employee (dropdown)' : t}</option>`).join('');

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
          : f.type === 'employee'
            ? `<span class="muted" style="font-size:12px">Live employee list — no options needed</span>`
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

  const ACTION_TYPES = [
    ['notify_employee', 'Send notice to employee (login account)'],
    ['save_to_201', 'File rendered form into employee 201'],
    ['email_employee', 'Email the employee (company SMTP)'],
    ['notify_hr', 'Notify HR / department head'],
    ['create_followup_task', 'Create a follow-up task'],
    ['apply_no_work', 'Feed date_from/date_to/paid into payroll no-work'],
  ];

  function renderActions(ov, actions) {
    const el = ov.querySelector('#fb-actions-list');
    if (!actions.length) {
      el.innerHTML = `<div class="muted" style="text-align:center;padding:12px">No actions — this form just stores records.</div>`;
      return;
    }
    const typeOpts = (sel) => ACTION_TYPES
      .map(([v, label]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${UI.esc(label)}</option>`).join('');
    const runOpts = (sel) => ['create', 'approved']
      .map((v) => `<option value="${v}" ${v === (sel || 'create') ? 'selected' : ''}>on ${v}</option>`).join('');

    el.innerHTML = `<table class="line-table"><thead><tr>
      <th>Action</th><th>When</th><th>Details</th><th></th>
    </tr></thead><tbody>${actions.map((a, i) => {
      let details = '';
      if (a.type === 'notify_employee') {
        details = `<input data-ak="subject" value="${UI.esc(a.subject || '')}" placeholder="Subject (optional)" style="margin-bottom:4px" />
          <textarea data-ak="body" rows="2" placeholder="Message body (optional)">${UI.esc(a.body || '')}</textarea>`;
      } else if (a.type === 'email_employee') {
        details = `<input data-ak="subject" value="${UI.esc(a.subject || '')}" placeholder="Email subject (optional)" />`;
      } else if (a.type === 'create_followup_task') {
        details = `<input data-ak="title" value="${UI.esc(a.title || '')}" placeholder="Task title (optional)" style="margin-bottom:4px" />
          <input class="mono" data-ak="due_field" value="${UI.esc(a.due_field || '')}" placeholder="due date field key (optional)" />`;
      } else {
        details = `<span class="muted" style="font-size:12px">No extra settings</span>`;
      }
      return `<tr data-ai="${i}">
        <td><select data-ak="type">${typeOpts(a.type)}</select></td>
        <td><select data-ak="run_on">${runOpts(a.run_on)}</select></td>
        <td>${details}</td>
        <td><button type="button" class="icon-btn danger" data-arm="${i}" title="Remove">${UI.icon('trash', 14)}</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;

    el.querySelectorAll('input[data-ak], select[data-ak], textarea[data-ak]').forEach((inp) => {
      inp.addEventListener('change', () => syncAction(inp, actions));
      if (inp.tagName !== 'SELECT') inp.addEventListener('input', () => syncAction(inp, actions));
    });
    el.querySelectorAll('[data-arm]').forEach((b) =>
      b.onclick = () => { actions.splice(Number(b.dataset.arm), 1); renderActions(ov, actions); });
  }

  function syncAction(inp, actions) {
    const row = inp.closest('[data-ai]');
    if (!row) return;
    const i = Number(row.dataset.ai);
    const k = inp.dataset.ak;
    if (k === 'type') {
      actions[i] = { type: inp.value, run_on: actions[i].run_on || 'create' };
      renderActions(inp.closest('.modal-body'), actions);
      return;
    }
    actions[i][k] = inp.value;
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
