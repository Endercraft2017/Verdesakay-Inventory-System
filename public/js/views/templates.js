/* Document templates: list, editor (variable palette + live preview), company profile.
   Editing is admin-only; everyone can view/preview. */
App.register('templates', async (view) => {
  const admin = App.isAdmin();

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
      <button class="btn secondary" id="tpl-company">${UI.icon('building')} Company profile</button>
      ${admin ? `<button class="btn" id="tpl-new">${UI.icon('plus')} New template</button>` : ''}
    </div>
    <div class="panel"><div id="tpl-table"></div></div>`;

  const tableEl = view.querySelector('#tpl-table');

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const list = await API.get('/templates');
    render(list);
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'forms', title: 'No templates', hint: admin ? 'Create a template to format printed documents.' : 'An admin can add templates.' });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map((t) => `
          <tr class="clickable" data-open="${t.id}">
            <td><strong>${UI.esc(t.name)}</strong></td>
            <td><span class="badge-pill muted">${UI.esc(t.type)}</span></td>
            <td>${UI.fmtDate(t.updated_at)}</td>
            <td class="actions">
              <button class="icon-btn" title="Preview" data-prev="${t.id}">${UI.icon('eye')}</button>
              ${admin ? `<button class="icon-btn" title="Edit" data-edit="${t.id}">${UI.icon('edit')}</button>
                <button class="icon-btn danger" title="Delete" data-del="${t.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
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

  function paletteHTML() {
    return ORDER_VARIABLES.map((g) => `
      <div class="pal-group"><div class="pal-head">${UI.esc(g.group)}</div>
        ${g.items.map((v) => `<button type="button" class="pal-chip" data-token="${UI.esc(v.token)}" title="${UI.esc(v.label)}">${UI.esc(v.token)}</button>`).join('')}
      </div>`).join('');
  }

  function editor(tpl) {
    const editing = !!tpl;
    const typeOpts = ['sale', 'job', 'generic']
      .map((t) => `<option value="${t}" ${(editing ? tpl.type : 'sale') === t ? 'selected' : ''}>${t}</option>`).join('');
    UI.modal({
      title: editing ? 'Edit template' : 'New template',
      size: 'xl',
      bodyHTML: `
        <div class="field-row">
          <div><label>Name</label><input data-f="name" value="${UI.esc(editing ? tpl.name : '')}" placeholder="e.g. Sale Order" /></div>
          <div style="max-width:160px"><label>Type</label><select data-f="type">${typeOpts}</select></div>
        </div>
        <div class="tpl-editor">
          <div class="tpl-left">
            <label>Template body (HTML + variables)</label>
            <textarea data-f="body" class="tpl-body" spellcheck="false">${UI.esc(editing ? tpl.body : '')}</textarea>
            <div class="tpl-palette">
              <div class="muted" style="font-size:12px;margin-bottom:4px">Click to insert at cursor:</div>
              ${paletteHTML()}
            </div>
          </div>
          <div class="tpl-right">
            <label>Live preview</label>
            <iframe class="tpl-preview" id="tpl-preview"></iframe>
          </div>
        </div>`,
      confirmText: editing ? 'Save template' : 'Create template',
      onOpen: (ov) => {
        const body = ov.querySelector('[data-f="body"]');
        const frame = ov.querySelector('#tpl-preview');
        const refresh = () => {
          try { frame.srcdoc = UI.printableHtml(renderTemplate(body.value, SAMPLE), 'Preview'); }
          catch { frame.srcdoc = '<p style="color:#b00">Template error</p>'; }
        };
        body.addEventListener('input', refresh);
        ov.querySelectorAll('.pal-chip').forEach((c) => c.onclick = () => {
          insertAtCursor(body, c.dataset.token);
          refresh();
        });
        refresh();
      },
      onConfirm: async (ov, showErr) => {
        const name = ov.querySelector('[data-f="name"]').value.trim();
        const bodyVal = ov.querySelector('[data-f="body"]').value.trim();
        if (!name) { showErr('Template name is required'); return false; }
        if (!bodyVal) { showErr('Template body cannot be empty'); return false; }
        const payload = { name, type: ov.querySelector('[data-f="type"]').value, body: bodyVal };
        if (editing) await API.put('/templates/' + tpl.id, payload);
        else await API.post('/templates', payload);
        UI.toast('Template saved');
        load();
      },
    });
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    const pos = start + text.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  }

  async function del(id, list) {
    const t = list.find((x) => x.id == id);
    if (!await UI.confirmDialog(`Delete template "${t.name}"?`, 'Delete')) return;
    await API.del('/templates/' + id);
    UI.toast('Template deleted');
    load();
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

  await load();
});
