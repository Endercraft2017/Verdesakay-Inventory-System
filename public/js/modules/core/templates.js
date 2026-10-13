/* Document templates: list, editor (variable palette + live preview), company profile.
   Editing is admin-only; everyone can view/preview. */
App.register('templates', async (view) => {
  const admin = App.hasPermission('templates.edit');
  const companyEdit = App.hasPermission('templates.company');

  // A small neutral placeholder headshot so {{employee.photo}} renders something in previews.
  const SAMPLE_PHOTO = UI.PLACEHOLDER_PHOTO;

  // Sample data so the editor preview shows realistic output.
  const SAMPLE = {
    company: { name: 'Example Company', address: '123 Main St, Cebu City', phone: '(032) 555-1234', email: 'hello@example.com' },
    order: {
      no: 'SO-00001', type: 'Sale Order', date: '2026-06-27', status: 'open',
      customer_name: 'ACME Corporation', customer_contact: 'orders@acme.com', notes: 'Deliver by Friday.',
      currency: 'PHP', subtotal: '1,375.00', tax_percent: 12, tax_amount: '165.00', total: '1,540.00',
    },
    items: [
      { name: 'Bond Paper A4', sku: 'PPR-A4', description: '80gsm, white', quantity: 10, unit: 'reams', unit_price: '120.00', line_total: '1,200.00' },
      { name: 'Marker (black)', sku: 'MRK-BK', description: '', quantity: 5, unit: 'pcs', unit_price: '35.00', line_total: '175.00' },
    ],
    employee: {
      name: 'Juan Dela Cruz', employee_no: 'EMP-00001', position: 'Warehouse Staff',
      department: 'Operations', photo: SAMPLE_PHOTO,
    },
    user: { name: 'System Administrator' }, today: '2026-06-27',
  };

  Object.assign(SAMPLE,(typeof buildSlipContext==='function'?buildSlipContext:value=>value)({employee_name:SAMPLE.employee.name,dept_position:'Operations / Warehouse Staff',payroll_period:'Sample cutoff',pay_date:SAMPLE.today,daily_rate:600,days_worked:10,basic_salary:6000,total_earnings:6500,total_deductions:500,net_pay:6000,overtime_pay:500,sss:250,philhealth:150,pagibig:100}));
  SAMPLE.company.tin='123-456-789-000';SAMPLE.employee.tin_no='123-456-789';SAMPLE.employee.address='Sample employee address';
  SAMPLE.issuance={number:'AI-00001',issued_date:SAMPLE.today,notes:'Company property issued for work',issued_by_name:SAMPLE.user.name};
  SAMPLE.items.forEach((item,i)=>Object.assign(item,{asset_name:i?'Company phone':'Company laptop',category:'Equipment',asset_tag:'AST-0000'+(i+1),condition_on_issue:'Good'}));
  SAMPLE.year=2026;SAMPLE.f={"sss_gsis_phic_pagibig_union": "0.00", "thirteenth_month_ceiling": "90,000.00", "thirteenth_month_and_other_benefits": "0.00", "de_minimis": "0.00", "total_non_taxable": "0.00", "basic_salary": "0.00", "overtime_pay": "0.00", "holiday_pay": "0.00", "night_diff_and_other": "0.00", "taxable_13th_month_excess": "0.00", "gross_compensation": "0.00", "taxable_compensation_present": "0.00", "taxable_compensation_previous": "0.00", "gross_taxable_compensation": "0.00", "tax_due": "0.00", "tax_withheld_present": "0.00", "tax_withheld_previous": "0.00", "total_tax_withheld": "0.00", "over_withheld_label": "OVER-WITHHELD", "over_withheld_abs": "0.00", "payslip_count": "12"};

  view.innerHTML = `
    <section class="tpl-library">
      <header class="tpl-library-header">
        <div><span class="tpl-eyebrow">DOCUMENTS</span><h2>Template library</h2><p>Design consistent documents for your everyday work.</p></div>
        ${admin ? `<button class="btn" id="tpl-new">${UI.icon('plus')} Create template</button>` : ''}
      </header>
      <div class="tpl-library-toolbar">
        <div class="tpl-library-count"><span id="tpl-count">—</span> templates</div>
        <label class="tpl-period-label"><span>Period</span><select id="tpl-period-filter" title="Filter by accounting period"><option value="">All periods</option></select></label>
        <div class="grow"></div>
        ${admin ? `<button class="btn secondary" id="tpl-defaults">${UI.icon('file')} Built-in defaults</button><button class="btn secondary" id="tpl-vars">${UI.icon('settings')} Variables</button>` : ''}
        <button class="btn secondary" id="tpl-company">${UI.icon('building')} Company profile</button>
      </div>
      <div class="tpl-library-list"><div id="tpl-table"></div></div>
      <p class="tpl-library-note">Templates connect your layout with live data. Preview uses sample records.</p>
    </section>`;

  const tableEl = view.querySelector('#tpl-table');
  const periodFilter = view.querySelector('#tpl-period-filter');
  let fullList = [];

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    fullList = await API.get('/templates');
    view.querySelector('#tpl-count').textContent = fullList.length;
    // Populate period filter from unique periods in the list.
    const periods = [...new Set(fullList.map((t) => t.period || '').filter(Boolean))].sort((a, b) => b.localeCompare(a));
    const cur = periodFilter.value;
    periodFilter.innerHTML = '<option value="">All periods</option>' + periods.map((p) => `<option value="${UI.esc(p)}" ${p === cur ? 'selected' : ''}>${UI.esc(p)}</option>`).join('');
    render(periodFilter.value ? fullList.filter((t) => t.period === periodFilter.value) : fullList);
  }
  periodFilter.addEventListener('change', () => {
    render(periodFilter.value ? fullList.filter((t) => t.period === periodFilter.value) : fullList);
  });

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'forms', title: 'No templates', hint: admin ? 'Create a template to format printed documents.' : 'An admin can add templates.' });
      return;
    }
    // Group by period (most-recent first, no-period last).
    const groups = Object.create(null);
    list.forEach((t) => { const k = t.period || ''; (groups[k] = groups[k] || []).push(t); });
    const sortedKeys = [...Object.keys(groups).filter(Boolean).sort((a, b) => b.localeCompare(a)), ...Object.keys(groups).filter((k) => !k)];
    let rows = '';
    sortedKeys.forEach((key) => {
      rows += `<tr><td colspan="4" class="tpl-period-heading">${UI.esc(key || 'General templates')}</td></tr>`;
      groups[key].forEach((t) => {
        rows += `<tr class="clickable" data-open="${t.id}">
            <td><div class="tpl-name-cell"><span class="tpl-document-icon">${UI.icon('file', 20)}</span><div><strong>${UI.esc(t.name)}</strong><span class="tpl-row-detail">${(t.copies_per_record || 1) * (t.records_per_page || 1) > 1 ? `${t.copies_per_record} × ${t.records_per_page} print grid` : 'Single document'}${t.tile_continuous ? ' · Continuous' : ''}</span></div></div></td>
            <td><span class="tpl-type-badge">${UI.esc(t.type.charAt(0).toUpperCase() + t.type.slice(1))}</span></td>
            <td>${UI.fmtDate(t.updated_at)}</td>
            <td class="actions">
              <button class="icon-btn" title="Preview" data-prev="${t.id}">${UI.icon('eye')}</button>
              ${admin ? `<button class="icon-btn" title="Edit" data-edit="${t.id}">${UI.icon('edit')}</button>
                <button class="icon-btn danger" title="Delete" data-del="${t.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`;
      });
    });
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Template</th><th>Document type</th><th>Last updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    // Preview-modal + iframe, not window.open() — a new browser window/tab can be
    // popup-blocked outright by some browsers/extensions regardless of gesture timing; an
    // iframe inside a modal that's already part of the page never opens a new window, so
    // there's nothing for a popup blocker to block.
    // A template with a Print Grid set (rows/columns > 1) previews as the actual tiled grid —
    // always fully repeated (tileFill forced 'repeat' here) so you can see the layout, rather
    // than simulating the real-batch "fewer records than cells" edge case that only matters
    // when actually printing a batch of records.
    const openPreview = async (id) => {
      try {
        const [t, custom] = await Promise.all([API.get('/templates/' + id), API.get('/templates/variables?template_id=' + id)]);
        const context = previewContext(custom);
        const rows = t.copies_per_record || 1, cols = t.records_per_page || 1;
        const continuous = !!t.tile_continuous, repeatCount = t.repeat_count || 1;
        const tiled = (rows > 1 || cols > 1 || (continuous && repeatCount > 1)) && typeof buildTiledPagesHtml === 'function';
        const rendered = (tiled
          ? buildTiledPagesHtml([1], () => renderTemplate(t.body, context), {
            copiesPerRecord: rows, recordsPerPage: cols, tileFill: 'repeat', continuous, repeatCount, gapXmm:t.grid_gap_x_mm,gapYmm:t.grid_gap_y_mm,
            pageContentHeightMm: typeof pageContentHeightMm === 'function' ? pageContentHeightMm(t.body) : undefined,
          })
          : renderTemplate(t.body, context)) || renderTemplate(t.body, context);
        const full = UI.printableHtml(rendered, t.name + ' (preview)');
        UI.modal({
          title: t.name + ' — Preview',
          size: 'lg',
          bodyHTML: `<iframe sandbox="allow-same-origin allow-modals" title="Document preview" id="tpl-preview-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
          cancelText: 'Close',
          confirmText: 'Print…',
          onOpen: (ov) => {
            const ifr = ov.querySelector('#tpl-preview-frame');
            UI.loadPrintFrame(ifr, full, tiled && typeof fitTiledCells === 'function' ? fitTiledCells : undefined);
          },
          onConfirm: async (ov) => {
            const ifr = ov.querySelector('#tpl-preview-frame');
            await UI.printFrame(ifr);
            return false; // keep the preview open — printing shouldn't close it
          },
        });
      } catch (err) { UI.toast(err.message || 'Could not load preview', 'error'); }
    };
    const openEdit = async (id) => { try { await editor(await API.get('/templates/' + id)); } catch (err) { UI.toast(err.message || 'Could not open editor', 'error'); } };

    tableEl.querySelectorAll('[data-prev]').forEach((b) => b.onclick = () => openPreview(b.dataset.prev));
    tableEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEdit(b.dataset.edit));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(b.dataset.del, list));
    // Row click → edit (admins) or preview (everyone else).
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      if (admin) openEdit(tr.dataset.open); else openPreview(tr.dataset.open);
    });
  }

  // Build the editor's picker list from the server catalog + custom variables.
  function buildVarList(catalog, custom) {
    const list = [];
    (catalog || []).forEach((g) => (g.items || []).forEach((it) => list.push({ category: g.group, label: it.label, token: `{{${it.path}}}` })));
    (custom || []).forEach((v) => list.push({ category: v.category || 'Custom', label: v.label, token: `{{${v.key}}}` }));
    return list;
  }
  // Sample render context with custom variables resolved (for the live preview).
  function previewContext(custom) {
    const ctx = JSON.parse(JSON.stringify(SAMPLE));
    return (typeof applyVariables !== 'undefined') ? applyVariables(ctx, custom || []) : ctx;
  }

  // "Start fresh" — just the company letterhead so the editor canvas isn't a blank page.
  const BLANK_BODY = `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
      <div class="doc-meta"><div>{{today}}</div></div>
    </header>
    <p>Start writing your document here. Use the <strong>{ } Variable</strong> button on the Insert tab to drop in live data.</p></div>`;

  // Ready-made starting points offered when "New template" is pressed. Each is plain
  // HTML + {{tokens}} the renderer understands; the user edits everything afterwards.
  // `group` buckets them in the picker; the layouts are deliberately different from
  // each other (not one shell with a swapped heading).
  const STARTERS = [
    {
      id: 'sales-invoice', name: 'Sales Invoice', type: 'sale', icon: 'file',
      group: 'Sales & purchasing',
      blurb: 'Bill-to / terms row, line-item table, VAT total, and payment details.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
      <div class="doc-meta"><h2>SALES INVOICE</h2><div>Invoice No: {{order.no}}</div><div>Date: {{order.date}}</div></div>
    </header>
    <table class="doc-table plain"><tbody><tr>
      <td style="width:55%"><strong>Bill To</strong><br>{{order.customer_name}}<br>{{order.customer_contact}}</td>
      <td><strong>Terms:</strong> Due on receipt<br><strong>Reference:</strong> {{order.type}} {{order.no}}<br><strong>Status:</strong> {{order.status}}</td>
    </tr></tbody></table>
    <table class="doc-table striped"><thead><tr><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit Price</th><th class="r">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}</td><td class="r">{{quantity}}</td><td>{{unit}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-totals">
      <div>Subtotal: {{order.currency}} {{order.subtotal}}</div>
      <div>VAT ({{order.tax_percent}}%): {{order.currency}} {{order.tax_amount}}</div>
      <div class="grand">TOTAL DUE: {{order.currency}} {{order.total}}</div>
    </div>
    <div class="doc-notes"><strong>Payment details</strong><br><span class="muted">Make payment to {{company.name}} &nbsp;·&nbsp; Bank: ____________ &nbsp;·&nbsp; Account No.: ____________</span></div>
    <div class="doc-foot">Prepared by {{user.name}}. Thank you for your business.</div></div>`,
    },
    {
      id: 'quotation', name: 'Quotation', type: 'sale', icon: 'note',
      group: 'Sales & purchasing',
      blurb: 'Cover-letter style: greeting, priced table, numbered terms & conditions, sign-off.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
      <div class="doc-meta"><h2>QUOTATION</h2><div>Ref: {{order.no}}</div><div>Date: {{order.date}}</div></div>
    </header>
    <p>{{order.customer_name}}<br>{{order.customer_contact}}</p>
    <p>Dear Sir/Madam,</p>
    <p>Thank you for your inquiry. We are pleased to submit our quotation for the items listed below.</p>
    <table class="doc-table"><thead><tr><th>Item</th><th>Description</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}</td><td>{{description}}</td><td class="r">{{quantity}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-totals">
      <div>Subtotal: {{order.currency}} {{order.subtotal}}</div>
      <div>VAT ({{order.tax_percent}}%): {{order.currency}} {{order.tax_amount}}</div>
      <div class="grand">TOTAL: {{order.currency}} {{order.total}}</div>
    </div>
    <p><strong>Terms &amp; Conditions</strong></p>
    <ol class="muted">
      <li>This quotation is valid for 30 days from the date above.</li>
      <li>Prices are quoted in {{order.currency}}, VAT inclusive where applicable.</li>
      <li>Delivery: within ______ working days from receipt of your purchase order.</li>
      <li>Payment terms: ______ .</li>
      <li>Warranty: ______ against manufacturing defects.</li>
    </ol>
    <p>We look forward to your favorable response.</p>
    <p style="margin-top:24px">Sincerely,<br><br><strong>{{user.name}}</strong><br>{{company.name}}</p></div>`,
    },
    {
      id: 'delivery-receipt', name: 'Delivery Receipt', type: 'sale', icon: 'inventory',
      group: 'Sales & purchasing',
      blurb: 'No prices — Qty Ordered vs Delivered, vehicle line, three-way sign-off.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}}</div></div>
      <div class="doc-meta"><h2>DELIVERY RECEIPT</h2><div>DR No: {{order.no}}</div><div>Date: {{order.date}}</div></div>
    </header>
    <table class="doc-table plain"><tbody><tr>
      <td style="width:60%"><strong>Deliver To</strong><br>{{order.customer_name}}<br>{{order.customer_contact}}</td>
      <td><strong>Reference:</strong> {{order.type}} {{order.no}}<br><strong>P.O. No.:</strong> ____________</td>
    </tr></tbody></table>
    <table class="doc-table"><thead><tr><th>SKU</th><th>Item Description</th><th class="r">Qty Ordered</th><th class="r">Qty Delivered</th><th>Unit</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{sku}}</td><td>{{name}} <span class="muted">{{description}}</span></td><td class="r">{{quantity}}</td><td class="r">{{quantity}}</td><td>{{unit}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-notes"><strong>Remarks:</strong> {{order.notes}}</div>
    <p class="muted">Delivered by (vehicle / plate no.): __________________________</p>
    <table class="doc-table plain" style="margin-top:26px"><tbody><tr>
      <td style="width:33%">Prepared by<br><br><strong>{{user.name}}</strong><br><span class="muted">Warehouse</span></td>
      <td style="width:33%">Checked by<br><br>_____________________</td>
      <td>Received the above in good order &amp; condition:<br><br>_____________________<br><span class="muted">Signature over printed name / Date</span></td>
    </tr></tbody></table></div>`,
    },
    {
      id: 'purchase-order', name: 'Purchase Order', type: 'purchase', icon: 'archive',
      group: 'Sales & purchasing',
      blurb: 'Vendor / Ship-to, a ship-via grid, costed lines, procurement boilerplate, approvals.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
      <div class="doc-meta"><h2>PURCHASE ORDER</h2><div>P.O. No: {{order.no}}</div><div>Date: {{order.date}}</div></div>
    </header>
    <table class="doc-table plain"><tbody><tr>
      <td style="width:50%"><strong>Vendor</strong><br>{{order.customer_name}}<br>{{order.customer_contact}}</td>
      <td><strong>Ship To</strong><br>{{company.name}}<br>{{company.address}}</td>
    </tr></tbody></table>
    <table class="doc-table"><thead><tr><th>Required By</th><th>Payment Terms</th><th>Ship Via</th><th>FOB</th></tr></thead>
    <tbody><tr><td>____________</td><td>____________</td><td>____________</td><td>____________</td></tr></tbody></table>
    <table class="doc-table striped"><thead><tr><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit Price</th><th class="r">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{sku}}</td><td>{{name}}</td><td class="r">{{quantity}}</td><td>{{unit}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-totals">
      <div>Subtotal: {{order.currency}} {{order.subtotal}}</div>
      <div>VAT ({{order.tax_percent}}%): {{order.currency}} {{order.tax_amount}}</div>
      <div class="grand">PURCHASE TOTAL: {{order.currency}} {{order.total}}</div>
    </div>
    <ol class="muted">
      <li>Please acknowledge receipt of this order and confirm the delivery date.</li>
      <li>Send two (2) copies of your invoice quoting this P.O. number.</li>
      <li>Deliver per the prices, terms, and specifications stated above.</li>
    </ol>
    <table class="doc-table plain" style="margin-top:22px"><tbody><tr>
      <td>Requested by<br><br><strong>{{user.name}}</strong></td>
      <td>Approved by<br><br>_____________________<br><span class="muted">Authorized signatory</span></td>
    </tr></tbody></table></div>`,
    },
    {
      id: 'job-order', name: 'Job Order', type: 'job', icon: 'forms',
      group: 'Sales & purchasing',
      blurb: 'Job grid, problem-reported box, separate Parts and Labor tables, customer authorization.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}}</div></div>
      <div class="doc-meta"><h2>JOB ORDER</h2><div>J.O. No: {{order.no}}</div><div>Date: {{order.date}}</div></div>
    </header>
    <table class="doc-table"><thead><tr><th>Customer</th><th>Date Received</th><th>Date Promised</th><th>Technician</th><th>Priority</th></tr></thead>
    <tbody><tr><td>{{order.customer_name}}</td><td>{{order.date}}</td><td>____________</td><td>____________</td><td>Normal</td></tr></tbody></table>
    <p><strong>Problem reported / Work requested</strong></p>
    <p>{{order.notes}}</p>
    <p><strong>Parts &amp; Materials</strong></p>
    <table class="doc-table"><thead><tr><th class="r">Qty</th><th>Part / Material</th><th class="r">Unit Cost</th><th class="r">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td class="r">{{quantity}}</td><td>{{name}} <span class="muted">{{description}}</span></td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <p><strong>Labor</strong></p>
    <table class="doc-table"><thead><tr><th>Task performed</th><th class="r">Hours</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody><tr><td>&nbsp;</td><td class="r">&nbsp;</td><td class="r">&nbsp;</td><td class="r">&nbsp;</td></tr></tbody></table>
    <div class="doc-totals">
      <div>Parts &amp; materials: {{order.currency}} {{order.subtotal}}</div>
      <div>Labor: {{order.currency}} 0.00</div>
      <div class="grand">TOTAL: {{order.currency}} {{order.total}}</div>
    </div>
    <p class="muted">I authorize the above work and agree to pay the amount indicated upon completion.</p>
    <table class="doc-table plain" style="margin-top:18px"><tbody><tr>
      <td>Customer authorization<br><br>_____________________<br><span class="muted">{{order.customer_name}} / Date</span></td>
      <td>Work completed by<br><br><strong>{{user.name}}</strong><br><span class="muted">Date completed: ____________</span></td>
    </tr></tbody></table></div>`,
    },
    {
      id: 'official-receipt', name: 'Official Receipt', type: 'generic', icon: 'bookmark',
      group: 'Generic documents',
      blurb: 'Centered form: “received from … the sum of …”, amount in words, payment method.',
      body: `<div class="doc">
    <div style="text-align:center">
      <h1 style="margin-bottom:2px">{{company.name}}</h1>
      <div class="muted">{{company.address}} · {{company.phone}}</div>
      <h2 style="margin-top:14px;letter-spacing:.1em">OFFICIAL RECEIPT</h2>
    </div>
    <table class="doc-table plain"><tbody><tr>
      <td style="width:60%">No.: <strong>{{order.no}}</strong></td>
      <td>Date: <strong>{{order.date}}</strong></td>
    </tr></tbody></table>
    <p style="margin-top:18px">RECEIVED from <strong>{{order.customer_name}}</strong></p>
    <p>the sum of <span style="border-bottom:1px solid #999">&nbsp;_____________________________________________&nbsp;</span> pesos</p>
    <p style="font-size:15px;font-weight:700;border:1px solid #222;display:inline-block;padding:6px 16px">{{order.currency}} {{order.total}}</p>
    <p>as payment for:</p>
    <p style="border-bottom:1px solid #999;min-height:20px">{{order.notes}}</p>
    <p style="border-bottom:1px solid #999;min-height:20px">&nbsp;</p>
    <table class="doc-table plain" style="margin-top:14px"><tbody><tr>
      <td>Payment: &#9744; Cash&nbsp;&nbsp; &#9744; Check&nbsp;&nbsp; &#9744; Bank transfer</td>
      <td>Check / Ref. No.: ____________</td>
    </tr></tbody></table>
    <table class="doc-table plain" style="margin-top:28px"><tbody><tr>
      <td style="width:55%">&nbsp;</td>
      <td style="text-align:center">_____________________<br><strong>{{user.name}}</strong><br><span class="muted">Received by / Authorized signature</span></td>
    </tr></tbody></table></div>`,
    },
    {
      id: 'statement-of-account', name: 'Statement of Account', type: 'generic', icon: 'sheet',
      group: 'Generic documents',
      blurb: 'Aging summary (Current / 30 / 60 / 90+) over a dated transaction ledger.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
      <div class="doc-meta"><h2>STATEMENT OF ACCOUNT</h2><div>Statement Date: {{today}}</div><div>Account: {{order.no}}</div></div>
    </header>
    <p><strong>{{order.customer_name}}</strong><br>{{order.customer_contact}}</p>
    <table class="doc-table shaded"><thead><tr><th class="r">Current</th><th class="r">1–30 days</th><th class="r">31–60 days</th><th class="r">61–90 days</th><th class="r">Over 90</th><th class="r">Total Due</th></tr></thead>
    <tbody><tr><td class="r">{{order.total}}</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r"><strong>{{order.total}}</strong></td></tr></tbody></table>
    <table class="doc-table striped"><thead><tr><th>Date</th><th>Invoice / Reference</th><th>Description</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{sku}}</td><td>{{name}}</td><td>{{description}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}</tbody></table>
    <div class="doc-totals"><div class="grand">AMOUNT DUE: {{order.currency}} {{order.total}}</div></div>
    <div class="doc-notes muted">Please remit payment to {{company.name}} within 30 days of the statement date. If payment has already been made, kindly disregard this notice.</div>
    <div class="doc-foot">Questions about this statement? Contact {{company.email}} or {{company.phone}}.</div></div>`,
    },
    {
      id: 'business-letter', name: 'Business Letter', type: 'generic', icon: 'mail',
      group: 'Generic documents',
      blurb: 'Letterhead, date, inside address, salutation, three body paragraphs, sign-off.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
    </header>
    <p>{{today}}</p>
    <p style="margin-top:16px">[Recipient name]<br>[Title]<br>[Company]<br>[Address]</p>
    <p>Dear [Recipient name]:</p>
    <p>[Opening paragraph — state the purpose of this letter in one or two sentences.]</p>
    <p>[Body paragraph — the details, background, or supporting information the reader needs.]</p>
    <p>[Closing paragraph — the action you would like the reader to take, or the next step, and a thank-you.]</p>
    <p style="margin-top:18px">Sincerely,</p>
    <p style="margin-top:38px"><strong>{{user.name}}</strong><br>{{company.name}}</p>
    <p class="muted">Enclosure(s): ____________</p></div>`,
    },
    {
      id: 'internal-memo', name: 'Internal Memo', type: 'generic', icon: 'note',
      group: 'Generic documents',
      blurb: 'MEMORANDUM header with TO / FROM / DATE / RE lines, divider, body, cc.',
      body: `<div class="doc">
    <div style="text-align:center;border-bottom:2px solid #222;padding-bottom:10px;margin-bottom:14px">
      <h1 style="margin:0">{{company.name}}</h1>
      <h2 style="margin:4px 0 0;letter-spacing:.14em">MEMORANDUM</h2>
    </div>
    <table class="doc-table plain"><tbody>
      <tr><td style="width:90px"><strong>TO</strong></td><td style="border-bottom:1px solid #999">All Staff</td></tr>
      <tr><td><strong>FROM</strong></td><td style="border-bottom:1px solid #999">{{user.name}}</td></tr>
      <tr><td><strong>DATE</strong></td><td style="border-bottom:1px solid #999">{{today}}</td></tr>
      <tr><td><strong>RE</strong></td><td style="border-bottom:1px solid #999">[Subject]</td></tr>
    </tbody></table>
    <hr>
    <p>[Purpose — one sentence on why you are sending this memo.]</p>
    <p>[Details — the information, policy, or change being communicated. Keep paragraphs short.]</p>
    <p>[Action needed — what recipients should do, and by when.]</p>
    <p class="muted">cc: ____________</p></div>`,
    },
    {
      id: 'certificate-employment', name: 'Certificate of Employment', type: 'generic', icon: 'idcard',
      group: 'Generic documents',
      blurb: '“To whom it may concern” certification body with an issued-date and HR signature.',
      body: `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div><div class="muted">{{company.phone}} · {{company.email}}</div></div>
    </header>
    <h2 style="text-align:center;letter-spacing:.1em;margin-top:22px">CERTIFICATE OF EMPLOYMENT</h2>
    <p style="margin-top:24px">TO WHOM IT MAY CONCERN:</p>
    <p>This is to certify that <strong>[Employee full name]</strong> is a bona fide employee of {{company.name}}, holding the position of <strong>[Position]</strong> under the [Department] department, from [Date hired] up to the present.</p>
    <p>This certification is issued upon the request of the above-named employee for whatever legal purpose it may serve. It does not indicate any disciplinary or performance information.</p>
    <p style="margin-top:20px">Issued this {{today}} at {{company.address}}.</p>
    <p style="margin-top:44px">_____________________<br><strong>{{user.name}}</strong><br><span class="muted">Human Resources / Authorized representative</span></p></div>`,
    },
  ];

  async function editor(tpl, starter) {
    const editing = !!tpl;
    let savedId = tpl ? tpl.id : null, savedRevision = tpl ? tpl.revision : undefined;
    if (!window.DocEditor) { UI.toast('Editor failed to load', 'error'); return; }
    const seed = tpl || starter || {};
    const sourceId = editing ? tpl.id : seed.source_template_id;
    const varsUrl = '/templates/variables' + (sourceId ? `?template_id=${sourceId}` : '');
    const [catalog, initialCustom] = await Promise.all([
      API.get('/templates/variables/catalog'),
      API.get(varsUrl),
    ]);
    let custom = initialCustom;
    let vars = buildVarList(catalog, custom);
    const reloadVars = async () => { custom = await API.get(varsUrl); vars = buildVarList(catalog, custom); };

    window.DocEditor.open({
      sharedStudio: true,
      getSavedRevision: () => savedRevision,
      onSharedRevision: revision => { savedRevision=revision; },
      getDocumentKey: () => savedId ? 'template:' + savedId : 'new-template:' + (seed.source_template_id || seed.name || 'blank'),
      documentKey: editing ? 'template:' + tpl.id : 'new-template:' + (seed.source_template_id || seed.name || 'blank'),
      title: editing ? 'Edit Template' : (starter ? 'New Template · ' + starter.name : 'New Template'),
      name: editing ? tpl.name : (starter ? starter.name : ''),
      type: editing ? tpl.type : (starter ? starter.type : 'sale'),
      period: seed.period || '',
      periodLabel: 'Accounting Period',
      typeOptions: ['sale', 'job', 'purchase', 'generic'],
      body: editing ? tpl.body : (starter ? starter.body : BLANK_BODY),
      copiesPerRecord: seed.copies_per_record || 1,
      recordsPerPage: seed.records_per_page || 1,
      gapXmm: seed.grid_gap_x_mm ?? 6, gapYmm: seed.grid_gap_y_mm ?? 6,
      tileFill: seed.tile_fill || 'blank',
      continuous: !!seed.tile_continuous,
      repeatCount: seed.repeat_count || 1,
      getVariables: () => vars,
      sampleContext: () => previewContext(custom),
      loadPreviewRecord: ['sale','purchase','job'].includes(seed.type || 'sale') ? async (id) => {
        const [order, company] = await Promise.all([API.get('/orders/' + id), API.get('/templates/company')]);
        return buildDocContext({ order, company, user: App.getMe(), variables: custom });
      } : undefined,
      renderPreview: (body) => UI.printableHtml(renderTemplate(body, previewContext(custom)), 'Preview'),
      onManageVars: sourceId && !editing ? undefined : async (ed) => {
        await variableManager(editing ? 'template' : 'global', editing ? tpl.id : null, catalog);
        await reloadVars();
        if (ed && ed.refresh) ed.refresh();
      },
      onSave: async ({ name, type, period, body, copiesPerRecord, recordsPerPage, tileFill, continuous, repeatCount, gapXmm, gapYmm, studioVersion }) => {
        if (!name.trim()) return 'Template name is required';
        if (!body.trim()) return 'Template body cannot be empty';
        const payload = {
          name: name.trim(), type, period: period ? period.trim() : null, body,
          copies_per_record: copiesPerRecord, records_per_page: recordsPerPage, tile_fill: tileFill,
          grid_gap_x_mm: gapXmm, grid_gap_y_mm: gapYmm, tile_continuous: continuous, repeat_count: repeatCount, studio_version: studioVersion,
        };
        if (savedId) {
          const result = await API.put('/templates/' + savedId, { ...payload, expected_revision: savedRevision });
          savedRevision = result.revision;
        } else {
          const result = await API.post('/templates', { ...payload, source_template_id: seed.source_template_id, source_revision: seed.source_revision });
          savedId = result.id; savedRevision = result.revision;
        }
        UI.toast('Template saved');
        load().catch((err) => UI.toast(err.message || 'Could not refresh template list', 'error'));
        return true;
      },
    });
  }

  /* ---------- "New template" → pick a starting point (or a blank page) ---------- */
  const TYPE_ICON = { sale: 'file', purchase: 'archive', job: 'forms', generic: 'note' };
  function newTemplateModal() {
    const tile = (attr, id, icon, name, blurb, extraClass) => `
      <button type="button" class="tpl-starter${extraClass ? ' ' + extraClass : ''}" data-${attr}="${UI.esc(id)}">
        <span class="tpl-starter-ic">${UI.icon(icon, 20)}</span>
        <span class="tpl-starter-name">${UI.esc(name)}</span>
        <span class="tpl-starter-blurb">${UI.esc(blurb)}</span>
      </button>`;
    const groups = [...new Set(STARTERS.map((s) => s.group))];
    const builtIn = groups.map((g) =>
      `<div class="tpl-starter-section">${UI.esc(g)}</div>` +
      STARTERS.filter((s) => s.group === g).map((s) => tile('starter', s.id, s.icon, s.name, s.blurb)).join('')
    ).join('');
    // "Our other formats" — start a new template from a copy of one that already exists
    // (the seeded HR Payroll Slip / Employee ID Card / BIR 2316, plus anything added here).
    const existing = (fullList || []).length
      ? `<div class="tpl-starter-section">Copy an existing template</div>` +
        fullList.map((t) => tile('copy', t.id, TYPE_ICON[t.type] || 'note', t.name,
          `Start from a copy of this ${t.type} template.`)).join('')
      : '';
    const m = UI.modal({
      title: 'New template',
      size: 'lg',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Pick a starting point — the whole layout is dropped into the editor and everything stays editable — or begin from a blank page.</p>
        <div class="tpl-starter-grid">
          <div class="tpl-starter-section">Start from scratch</div>
          ${tile('starter', '', 'plus', 'Blank document', 'An empty page with just your company letterhead.', 'blank')}
          ${builtIn}
          ${existing}
        </div>`,
      cancelText: 'Cancel',
    });
    m.overlay.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', () => {
      m.close();
      editor(null, STARTERS.find((s) => s.id === b.dataset.starter) || null).catch((err) => UI.toast(err.message || 'Could not open editor', 'error'));
    }));
    m.overlay.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      m.close();
      try {
        const t = await API.get('/templates/' + b.dataset.copy);
        await editor(null, { ...t, name: t.name + ' (copy)', source_template_id: t.id, source_revision: t.revision });
      } catch (err) {
        UI.toast((err && err.message) || 'Could not load that template', 'error');
      }
    }));
  }

  /* ---------- Variable manager (add/rename/remove; global or template-local) ---------- */
  function variableManager(scope, templateId, catalog) {
    return new Promise((resolve) => {
      const url = '/templates/variables' + (scope === 'template' ? `?template_id=${templateId}` : '');
      const m = UI.modal({
        title: scope === 'global' ? 'Global variables' : 'Template variables',
        size: 'lg',
        bodyHTML: `<p class="muted" style="margin-top:0">Your own variables — a fixed value, a bound data field, or a formula. Use them via the <b>{ } Variable</b> picker or by typing <code>{{key}}</code>. ${scope === 'global' ? 'Global variables work in every template.' : 'These belong to this template only.'}</p>
          <div style="text-align:right;margin-bottom:8px"><button class="btn" id="var-add">${UI.icon('plus')} New variable</button></div>
          <div id="var-mgr-list"><div class="empty">Loading…</div></div>`,
        cancelText: 'Close',
        onOpen: (ov) => {
          const listEl = ov.querySelector('#var-mgr-list');
          async function refresh() {
            const all = await API.get(url).catch(() => []);
            const mine = all.filter((v) => scope === 'global' ? v.scope === 'global' : (v.scope === 'template' && String(v.template_id) === String(templateId)));
            if (!mine.length) { listEl.innerHTML = UI.emptyState({ icon: 'settings', title: 'No custom variables yet', hint: 'Create one with “New variable”.' }); return; }
            const groups = Object.create(null); mine.forEach((v) => (groups[v.category || 'Custom'] = groups[v.category || 'Custom'] || []).push(v));
            const detail = (v) => v.source_type === 'constant' ? (v.value || '') : v.source_type === 'field' ? '↳ ' + (v.field_path || '') : 'ƒ ' + (v.formula || '');
            listEl.innerHTML = Object.keys(groups).map((g) => `<div style="margin-bottom:10px"><div class="pal-head">${UI.esc(g)}</div>${groups[g].map((v) => `
              <div class="tool-row" data-id="${v.id}">
                <div class="tool-row-main"><div class="tool-row-title">${UI.esc(v.label)} <span class="muted mono">{{${UI.esc(v.key)}}}</span> <span class="badge-pill muted">${UI.esc(v.source_type)}</span></div>
                  <div class="tool-row-sub">${UI.esc(detail(v))}</div></div>
                <button class="icon-btn" data-edit="${v.id}" title="Edit">${UI.icon('edit')}</button>
                <button class="icon-btn danger" data-del="${v.id}" title="Delete">${UI.icon('trash')}</button>
              </div>`).join('')}</div>`).join('');
            listEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => varForm(scope, templateId, catalog, mine.find((x) => x.id == b.dataset.edit), refresh));
            listEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (await UI.confirmDialog('Delete this variable?', 'Delete')) { await API.del('/templates/variables/' + b.dataset.del); refresh(); } });
          }
          ov.querySelector('#var-add').onclick = () => varForm(scope, templateId, catalog, null, refresh);
          refresh();
        },
      });
      m.overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve()));
    });
  }

  function varForm(scope, templateId, catalog, v, after) {
    const editing = !!v;
    const fieldOpts = (catalog || []).map((g) => `<optgroup label="${UI.esc(g.group)}">${g.items.map((it) => `<option value="${UI.esc(it.path)}" ${v && v.field_path === it.path ? 'selected' : ''}>${UI.esc(it.label)}</option>`).join('')}</optgroup>`).join('');
    const sel = (val, opts) => opts.map(([o, l]) => `<option value="${o}" ${v && v[val] === o ? 'selected' : ''}>${l}</option>`).join('');
    UI.modal({
      title: editing ? 'Edit variable' : 'New variable',
      bodyHTML: `
        <div class="field-row">
          <div><label>Key *</label><input data-f="key" value="${UI.esc(v ? v.key : '')}" ${editing ? 'disabled' : ''} placeholder="e.g. vat_percent" /></div>
          <div><label>Label *</label><input data-f="label" value="${UI.esc(v ? v.label : '')}" placeholder="e.g. VAT %" /></div>
        </div>
        <div class="field-row">
          <div><label>Category</label><input data-f="category" value="${UI.esc(v ? v.category : 'Custom')}" /></div>
          <div><label>Kind</label><select data-f="source_type">${sel('source_type', [['constant', 'Fixed value'], ['field', 'Bound data field'], ['formula', 'Formula']])}</select></div>
          <div><label>Data type</label><select data-f="data_type">${sel('data_type', [['text', 'Text'], ['number', 'Number'], ['currency', 'Currency'], ['date', 'Date']])}</select></div>
        </div>
        <div data-when="constant"><label>Value</label><input data-f="value" value="${UI.esc(v ? v.value || '' : '')}" placeholder="e.g. 12" /></div>
        <div data-when="field"><label>Data field</label><select data-f="field_path">${fieldOpts}</select></div>
        <div data-when="formula"><label>Formula</label><input data-f="formula" value="${UI.esc(v ? v.formula || '' : '')}" placeholder="e.g. order.subtotal * 0.12" style="font-family:Consolas,monospace" /></div>`,
      confirmText: editing ? 'Save' : 'Create',
      onOpen: (ov) => {
        const kind = ov.querySelector('[data-f="source_type"]');
        const toggle = () => ov.querySelectorAll('[data-when]').forEach((el) => el.classList.toggle('hidden', el.dataset.when !== kind.value));
        kind.addEventListener('change', toggle); toggle();
      },
      onConfirm: async (ov, showErr) => {
        const g = (k) => { const el = ov.querySelector(`[data-f="${k}"]`); return el ? el.value : ''; };
        const key = (v ? v.key : g('key')).trim();
        if (!key || !g('label').trim()) { showErr('Key and label are required'); return false; }
        if (!editing && !/^[a-zA-Z_]\w{0,63}$/.test(key)) { showErr('Key must start with a letter; letters, numbers, _ only'); return false; }
        const payload = {
          scope, template_id: scope === 'template' ? templateId : null,
          key, label: g('label'), category: g('category') || 'Custom',
          source_type: g('source_type'), data_type: g('data_type'),
          value: g('value'), field_path: g('field_path'), formula: g('formula'),
        };
        if (editing) await API.put('/templates/variables/' + v.id, payload);
        else await API.post('/templates/variables', payload);
        UI.toast('Variable saved');
        after();
      },
    });
  }

  async function del(id, list) {
    const t = list.find((x) => x.id == id);
    if (!t) return;
    if (!await UI.confirmDialog(`Delete template "${t.name}"?`, 'Delete')) return;
    try {
      await API.del('/templates/' + id);
      UI.toast('Template deleted');
      load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  async function companyModal() {
    const c = await API.get('/templates/company');
    UI.modal({
      title: 'Company profile',
      bodyHTML: `
        <p class="muted" style="margin-top:0">Used by the {{company.*}} variables on printed documents.</p>
        <label>Company name</label><input data-f="name" value="${UI.esc(c.name)}" ${companyEdit ? '' : 'disabled'} />
        <label>Address</label><input data-f="address" value="${UI.esc(c.address)}" ${companyEdit ? '' : 'disabled'} />
        <div class="field-row">
          <div><label>Phone</label><input data-f="phone" value="${UI.esc(c.phone)}" ${companyEdit ? '' : 'disabled'} /></div>
          <div><label>Email</label><input data-f="email" value="${UI.esc(c.email)}" ${companyEdit ? '' : 'disabled'} /></div>
        </div>
        <label>Logo URL</label><input data-f="logo_url" value="${UI.esc(c.logo_url)}" ${companyEdit ? '' : 'disabled'} />
        <p class="muted" style="font-size:12px;margin:14px 0 0">Supported photos in messages and reports are compressed before upload. Documents are kept in their original format.</p>`,
      confirmText: companyEdit ? 'Save' : null,
      cancelText: companyEdit ? 'Cancel' : 'Close',
      onConfirm: companyEdit ? async (ov) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        await API.put('/templates/company', {
          name: g('name'), address: g('address'), phone: g('phone'), email: g('email'), logo_url: g('logo_url'),
          compress_images: true,
        });
        UI.toast('Company profile saved');
      } : null,
    });
  }

  async function builtInDefaultsModal(){
    try{
      const [defaults,templates]=await Promise.all([API.get('/templates/defaults'),API.get('/templates')]);
      UI.modal({title:'Built-in document defaults',size:'lg',cancelText:'Cancel',confirmText:'Save defaults',bodyHTML:`<p class="muted">Choose the layout used by each built-in document. Renaming a template keeps its assignment. A replacement must use the document's fields; use Preview with real data to verify it. Payslip defaults are managed on HR Payroll in Form Builder.</p>${defaults.map(d=>`<label>${UI.esc(d.label)}<select data-default-key="${UI.esc(d.key)}"><option value="">Choose a template…</option>${templates.filter(t=>t.type===d.type).map(t=>`<option value="${t.id}" ${t.id===d.template_id?'selected':''}>${UI.esc(t.name)}</option>`).join('')}</select></label>`).join('')}`,
       onConfirm:async ov=>{const choices=[...ov.querySelectorAll('[data-default-key]')].map(el=>({key:el.dataset.defaultKey,id:Number(el.value)}));if(choices.some(c=>!c.id))throw Error('Choose a layout for every built-in document');for(const c of choices)if(defaults.find(d=>d.key===c.key).template_id!==c.id)await API.put('/templates/defaults/'+c.key,{template_id:c.id});UI.toast('Built-in document defaults saved');return true;}
      });
    }catch(err){UI.toast(err.message,'error');}
  }
  view.querySelector('#tpl-defaults')?.addEventListener('click',builtInDefaultsModal);

  view.querySelector('#tpl-company').addEventListener('click', companyModal);
  const newBtn = view.querySelector('#tpl-new');
  if (newBtn) newBtn.addEventListener('click', newTemplateModal);
  const varsBtn = view.querySelector('#tpl-vars');
  if (varsBtn) varsBtn.addEventListener('click', async () => {
    const catalog = await API.get('/templates/variables/catalog').catch(() => []);
    variableManager('global', null, catalog);
  });

  await load();
});
