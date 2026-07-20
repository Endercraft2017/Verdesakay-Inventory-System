/* Document templates: list, editor (variable palette + live preview), company profile.
   Editing is admin-only; everyone can view/preview. */
App.register('templates', async (view) => {
  const admin = App.hasPermission('templates.edit');

  // Sample data so the editor preview shows realistic output.
  const SAMPLE = {
    company: { name: 'Verdesakay Inc.', address: '123 Main St, Cebu City', phone: '(032) 555-1234', email: 'hello@verdesakay.com' },
    order: {
      no: 'SO-00001', type: 'Sale Order', date: '2026-06-27', status: 'open',
      customer_name: 'ACME Corporation', customer_contact: 'orders@acme.com', notes: 'Deliver by Friday.',
      currency: 'PHP', subtotal: '1,375.00', tax_percent: 12, tax_amount: '165.00', total: '1,540.00',
    },
    items: [
      { name: 'Bond Paper A4', sku: 'PPR-A4', description: '80gsm, white', quantity: 10, unit: 'reams', unit_price: '120.00', line_total: '1,200.00' },
      { name: 'Marker (black)', sku: 'MRK-BK', description: '', quantity: 5, unit: 'pcs', unit_price: '35.00', line_total: '175.00' },
    ],
    user: { name: 'System Administrator' }, today: '2026-06-27',
  };

  view.innerHTML = `
    <div class="topbar">
      <h2>Document Templates</h2>
      <div class="grow"></div>
      <select id="tpl-period-filter" title="Filter by period" style="padding:6px 8px;border:1px solid var(--border-strong,#c6d4e6);border-radius:6px;background:var(--surface,#fff);color:var(--text,#16243d);font-size:13px">
        <option value="">All periods</option>
      </select>
      ${admin ? `<button class="btn secondary" id="tpl-vars">${UI.icon('settings')} Variables</button>` : ''}
      <button class="btn secondary" id="tpl-company">${UI.icon('building')} Company profile</button>
      ${admin ? `<button class="btn" id="tpl-new">${UI.icon('plus')} New template</button>` : ''}
    </div>
    <div class="panel"><div id="tpl-table"></div></div>`;

  const tableEl = view.querySelector('#tpl-table');
  const periodFilter = view.querySelector('#tpl-period-filter');
  let fullList = [];

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    fullList = await API.get('/templates');
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
    const groups = {};
    list.forEach((t) => { const k = t.period || ''; (groups[k] = groups[k] || []).push(t); });
    const sortedKeys = [...Object.keys(groups).filter(Boolean).sort((a, b) => b.localeCompare(a)), ...Object.keys(groups).filter((k) => !k)];
    let rows = '';
    sortedKeys.forEach((key) => {
      rows += `<tr><td colspan="4" style="padding:10px 14px 4px;font-weight:700;font-size:12px;color:var(--text-muted,#5d6b84);text-transform:uppercase;letter-spacing:.06em;border-bottom:none;background:var(--surface-2,#eef4fb)">${UI.esc(key || '—')}</td></tr>`;
      groups[key].forEach((t) => {
        rows += `<tr class="clickable" data-open="${t.id}">
            <td><strong>${UI.esc(t.name)}</strong></td>
            <td><span class="badge-pill muted">${UI.esc(t.type)}</span></td>
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
        <thead><tr><th>Name</th><th>Type</th><th>Updated</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    const openPreview = async (id) => {
      const t = await API.get('/templates/' + id);
      UI.printDocument(renderTemplate(t.body, SAMPLE), t.name + ' (preview)');
    };
    const openEdit = async (id) => editor(await API.get('/templates/' + id));

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

  const DEFAULT_BODY = `<div class="doc"><header class="doc-head">
      <div class="doc-company"><h1>{{company.name}}</h1><div>{{company.address}}</div></div>
      <div class="doc-meta"><h2>{{order.type}}</h2><div>No: {{order.no}}</div><div>{{order.date}}</div></div>
    </header>
    <p><strong>Customer:</strong> {{order.customer_name}}</p>
    <table class="doc-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}</td><td>{{quantity}}</td><td>{{unit_price}}</td><td>{{line_total}}</td></tr>{{/items}}</tbody></table>
    <p style="text-align:right"><strong>TOTAL: {{order.currency}} {{order.total}}</strong></p></div>`;

  async function editor(tpl) {
    const editing = !!tpl;
    if (!window.DocEditor) { UI.toast('Editor failed to load', 'error'); return; }
    const varsUrl = '/templates/variables' + (editing ? `?template_id=${tpl.id}` : '');
    const [catalog, initialCustom] = await Promise.all([
      API.get('/templates/variables/catalog').catch(() => []),
      API.get(varsUrl).catch(() => []),
    ]);
    let custom = initialCustom;
    let vars = buildVarList(catalog, custom);
    const reloadVars = async () => { custom = await API.get(varsUrl).catch(() => []); vars = buildVarList(catalog, custom); };

    window.DocEditor.open({
      title: editing ? 'Edit Template' : 'New Template',
      name: editing ? tpl.name : '',
      type: editing ? tpl.type : 'sale',
      period: editing ? (tpl.period || '') : '',
      periodLabel: 'Accounting Period',
      typeOptions: ['sale', 'job', 'purchase', 'generic'],
      body: editing ? tpl.body : DEFAULT_BODY,
      getVariables: () => vars,
      sampleContext: previewContext(custom),
      renderPreview: (body) => UI.printableHtml(renderTemplate(body, previewContext(custom)), 'Preview'),
      onManageVars: async (ed) => {
        await variableManager(editing ? 'template' : 'global', editing ? tpl.id : null, catalog);
        await reloadVars();
        if (ed && ed.refresh) ed.refresh();
      },
      onSave: async ({ name, type, period, body }) => {
        if (!name.trim()) return 'Template name is required';
        if (!body.trim()) return 'Template body cannot be empty';
        const payload = { name: name.trim(), type, period: period ? period.trim() : null, body };
        if (editing) await API.put('/templates/' + tpl.id, payload);
        else await API.post('/templates', payload);
        UI.toast('Template saved');
        load();
        return true;
      },
    });
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
            const groups = {}; mine.forEach((v) => (groups[v.category || 'Custom'] = groups[v.category || 'Custom'] || []).push(v));
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
        <label>Company name</label><input data-f="name" value="${UI.esc(c.name)}" ${admin ? '' : 'disabled'} />
        <label>Address</label><input data-f="address" value="${UI.esc(c.address)}" ${admin ? '' : 'disabled'} />
        <div class="field-row">
          <div><label>Phone</label><input data-f="phone" value="${UI.esc(c.phone)}" ${admin ? '' : 'disabled'} /></div>
          <div><label>Email</label><input data-f="email" value="${UI.esc(c.email)}" ${admin ? '' : 'disabled'} /></div>
        </div>
        <label>Logo URL</label><input data-f="logo_url" value="${UI.esc(c.logo_url)}" ${admin ? '' : 'disabled'} />`,
      confirmText: admin ? 'Save' : null,
      cancelText: admin ? 'Cancel' : 'Close',
      onConfirm: admin ? async (ov) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        await API.put('/templates/company', {
          name: g('name'), address: g('address'), phone: g('phone'), email: g('email'), logo_url: g('logo_url'),
        });
        UI.toast('Company profile saved');
      } : null,
    });
  }

  view.querySelector('#tpl-company').addEventListener('click', companyModal);
  const newBtn = view.querySelector('#tpl-new');
  if (newBtn) newBtn.addEventListener('click', () => editor(null));
  const varsBtn = view.querySelector('#tpl-vars');
  if (varsBtn) varsBtn.addEventListener('click', async () => {
    const catalog = await API.get('/templates/variables/catalog').catch(() => []);
    variableManager('global', null, catalog);
  });

  await load();
});
