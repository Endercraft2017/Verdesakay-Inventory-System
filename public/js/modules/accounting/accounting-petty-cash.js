/* Accounting → Petty Cash: named cash funds + a running money-in / money-out register. */
App.register('accounting-petty-cash', async (view) => {
  const money = UI.money;
  const canManage = App.hasPermission('accounting.manage');
  const state = { fundId: null, from: '', to: '' };
  let funds = [];
  let locations = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Petty Cash</h2>
      <select id="pc-fund" style="min-width:200px"></select>
      <div class="grow"></div>
      <input type="date" id="pc-from" title="From" />
      <input type="date" id="pc-to" title="To" />
      <button class="btn secondary" id="pc-csv" title="Export the shown register to CSV">${UI.icon('download')} Export</button>
      ${canManage ? `<button class="btn secondary" id="pc-newfund">${UI.icon('building')} Funds</button>
      <button class="btn" id="pc-in">${UI.icon('plus')} Cash in</button>
      <button class="btn" id="pc-out">${UI.icon('adjust')} Cash out</button>` : ''}
    </div>
    <div id="pc-summary"></div>
    <div class="panel"><div id="pc-table"><div class="empty">Loading…</div></div></div>`;

  const fundSel = view.querySelector('#pc-fund');
  const tableEl = view.querySelector('#pc-table');
  const sumEl = view.querySelector('#pc-summary');

  view.querySelector('#pc-from').onchange = (e) => { state.from = e.target.value; loadRegister(); };
  view.querySelector('#pc-to').onchange = (e) => { state.to = e.target.value; loadRegister(); };
  fundSel.onchange = () => { state.fundId = Number(fundSel.value) || null; loadRegister(); };
  view.querySelector('#pc-csv').onclick = exportCsv;
  const inBtn = view.querySelector('#pc-in');
  if (inBtn) inBtn.onclick = () => entryModal('in');
  const outBtn = view.querySelector('#pc-out');
  if (outBtn) outBtn.onclick = () => entryModal('out');
  const fundsBtn = view.querySelector('#pc-newfund');
  if (fundsBtn) fundsBtn.onclick = fundsModal;

  await loadFunds();

  async function loadFunds() {
    [funds, locations] = await Promise.all([
      API.get('/accounting/petty-cash/funds'),
      API.get('/locations').catch(() => []),
    ]);
    if (!funds.length) {
      fundSel.innerHTML = '';
      sumEl.innerHTML = '';
      tableEl.innerHTML = UI.emptyState({
        icon: 'sheet',
        title: 'No petty cash fund yet',
        hint: 'Create a fund (e.g. "Main Petty Cash") with its opening float, then record money in and out.',
        action: canManage ? `<button class="btn" id="pc-empty-new">${UI.icon('plus')} New fund</button>` : '',
      });
      const b = tableEl.querySelector('#pc-empty-new');
      if (b) b.onclick = () => fundModal(null);
      return;
    }
    if (!state.fundId || !funds.some((f) => f.id === state.fundId)) state.fundId = funds[0].id;
    fundSel.innerHTML = funds.map((f) =>
      `<option value="${f.id}" ${f.id === state.fundId ? 'selected' : ''}>${UI.esc(f.name)} — ${money(f.balance)}</option>`).join('');
    loadRegister();
  }

  async function loadRegister() {
    if (!state.fundId) return;
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const qs = new URLSearchParams();
    if (state.from) qs.set('from', state.from);
    if (state.to) qs.set('to', state.to);
    let data;
    try { data = await API.get(`/accounting/petty-cash/funds/${state.fundId}/entries?${qs}`); }
    catch (e) { tableEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
    render(data);
  }

  function render(d) {
    const cur = d.fund.currency || '';
    sumEl.innerHTML = `
      <div class="cards" style="margin-bottom:14px">
        <div class="stat-card"><div class="stat-ic">${UI.icon('sheet', 20)}</div><div><div class="value">${cur} ${money(d.opening_balance)}</div><div class="label">Opening balance</div></div></div>
        <div class="stat-card"><div class="stat-ic">${UI.icon('plus', 20)}</div><div><div class="value">${money(d.totals.in)}</div><div class="label">Money in</div></div></div>
        <div class="stat-card ${d.totals.out ? 'warn' : ''}"><div class="stat-ic">${UI.icon('adjust', 20)}</div><div><div class="value">${money(d.totals.out)}</div><div class="label">Money out</div></div></div>
        <div class="stat-card"><div class="stat-ic">${UI.icon('sheet', 20)}</div><div><div class="value">${cur} ${money(d.closing_balance)}</div><div class="label">Closing balance</div></div></div>
      </div>`;

    if (!d.entries.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'sheet', title: 'No entries in this range', hint: 'Record a cash-in or cash-out to start the register.' });
      return;
    }
    tableEl.innerHTML = `
      <table><thead><tr>
        <th>Date</th><th>Category</th><th>Payee / Source</th><th>Ref</th>
        <th class="right">In</th><th class="right">Out</th><th class="right">Balance</th><th></th>
      </tr></thead><tbody>${d.entries.map((e) => `
        <tr>
          <td>${UI.esc(e.entry_date)}</td>
          <td>${UI.esc(e.category || '—')}</td>
          <td>${UI.esc(e.counterparty || '—')}${e.notes ? `<div class="muted" style="font-size:11px">${UI.esc(e.notes)}</div>` : ''}</td>
          <td class="mono">${UI.esc(e.reference_no || '')}</td>
          <td class="right" style="color:var(--success)">${e.direction === 'in' ? money(e.amount) : ''}</td>
          <td class="right" style="color:var(--danger)">${e.direction === 'out' ? money(e.amount) : ''}</td>
          <td class="right"><strong>${money(e.running_balance)}</strong></td>
          <td class="actions">${canManage ? `<button class="icon-btn danger" title="Delete" data-del="${e.id}">${UI.icon('trash')}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirmDialog('Delete this petty-cash entry? The running balance will re-compute.', 'Delete'))) return;
      try { await API.del('/accounting/petty-cash/entries/' + b.dataset.del); UI.toast('Deleted'); loadFunds(); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  function exportCsv() {
    if (!state.fundId) { UI.toast('No fund selected', 'error'); return; }
    const qs = new URLSearchParams({ format: 'csv' });
    if (state.from) qs.set('from', state.from);
    if (state.to) qs.set('to', state.to);
    window.open(API.base() + `/api/accounting/petty-cash/funds/${state.fundId}/entries?${qs}`, '_blank');
  }

  /* ---- record a money-in / money-out entry ---- */
  const CATS = {
    in: ['Replenishment', 'Cash advance return', 'Refund', 'Collection', 'Other'],
    out: ['Office supplies', 'Transport / fare', 'Meals', 'Utilities', 'Repairs', 'Freight', 'Representation', 'Other'],
  };
  function entryModal(direction) {
    if (!state.fundId) { UI.toast('Create a fund first', 'error'); return; }
    const fund = funds.find((f) => f.id === state.fundId);
    UI.modal({
      title: (direction === 'in' ? 'Cash in' : 'Cash out') + ' — ' + fund.name,
      bodyHTML: `
        <div class="field-row">
          <div><label>Date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div><label>Amount (${UI.esc(fund.currency || 'PHP')}) <span class="req">*</span></label><input data-f="amount" type="number" min="0.01" step="0.01" /></div>
        </div>
        <div class="field-row">
          <div style="flex:1"><label>Category</label>
            <input data-f="category" list="pc-cats" placeholder="Pick or type" /></div>
          <div style="flex:1"><label>${direction === 'in' ? 'Source' : 'Payee'}</label><input data-f="counterparty" /></div>
        </div>
        <datalist id="pc-cats">${CATS[direction].map((c) => `<option value="${UI.esc(c)}"></option>`).join('')}</datalist>
        <div class="field-row">
          <div><label>Reference no. (OR / voucher)</label><input data-f="reference_no" /></div>
        </div>
        <label>Notes</label><textarea data-f="notes" rows="2"></textarea>`,
      confirmText: direction === 'in' ? 'Record cash in' : 'Record cash out',
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        const amount = parseFloat(g('amount'));
        if (!amount || amount <= 0) { showErr('Enter an amount above 0'); return false; }
        try {
          await API.post(`/accounting/petty-cash/funds/${state.fundId}/entries`, {
            entry_date: g('date'), direction, amount,
            category: g('category') || null, counterparty: g('counterparty') || null,
            reference_no: g('reference_no') || null, notes: g('notes') || null,
          });
          UI.toast(direction === 'in' ? 'Cash in recorded' : 'Cash out recorded');
          loadFunds();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---- manage funds ---- */
  function fundsModal() {
    const m = UI.modal({
      title: 'Petty cash funds',
      size: 'lg',
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: `<div id="pcf-list"></div>
        <button type="button" class="btn secondary small" id="pcf-new" style="margin-top:10px">${UI.icon('plus')} New fund</button>`,
    });
    const listEl = m.overlay.querySelector('#pcf-list');
    function refresh() {
      listEl.innerHTML = funds.length ? `<table><thead><tr><th>Fund</th><th>Custodian</th><th>Location</th><th class="right">Balance</th><th></th></tr></thead>
        <tbody>${funds.map((f) => `<tr>
          <td><strong>${UI.esc(f.name)}</strong>${f.active ? '' : ' <span class="badge-pill muted">inactive</span>'}</td>
          <td>${UI.esc(f.custodian || '—')}</td><td>${UI.esc(f.location_name || '—')}</td>
          <td class="right">${money(f.balance)}</td>
          <td class="actions">
            <button class="icon-btn" data-edit="${f.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${f.id}" title="Delete (empty funds only)">${UI.icon('trash')}</button>
          </td></tr>`).join('')}</tbody></table>` : '<p class="muted">No funds yet.</p>';
      listEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => fundModal(funds.find((f) => f.id == b.dataset.edit)));
      listEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
        if (!(await UI.confirmDialog('Delete this fund?', 'Delete'))) return;
        try { await API.del('/accounting/petty-cash/funds/' + b.dataset.del); UI.toast('Deleted'); loadFunds().then(refresh); }
        catch (e) { UI.toast(e.message, 'error'); }
      });
    }
    m.overlay.querySelector('#pcf-new').onclick = () => fundModal(null, refresh);
    refresh();
    m._refresh = refresh;
  }

  function fundModal(existing, after) {
    const g = (k, d) => (existing && existing[k] != null ? existing[k] : d);
    UI.modal({
      title: existing ? 'Edit fund — ' + existing.name : 'New petty cash fund',
      bodyHTML: `
        <div class="field-row">
          <div style="flex:1"><label>Name <span class="req">*</span></label><input data-f="name" value="${UI.esc(g('name', ''))}" /></div>
          <div><label>Currency</label><input data-f="currency" value="${UI.esc(g('currency', 'PHP'))}" style="width:80px" /></div>
        </div>
        <div class="field-row">
          <div style="flex:1"><label>Custodian</label><input data-f="custodian" value="${UI.esc(g('custodian', ''))}" /></div>
          <div style="flex:1"><label>Location</label>
            <select data-f="location_id"><option value="">— none —</option>
              ${locations.map((l) => `<option value="${l.id}" ${String(g('location_id', '')) === String(l.id) ? 'selected' : ''}>${UI.esc(l.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field-row">
          <div><label>Opening balance / float</label><input data-f="opening_balance" type="number" min="0" step="0.01" value="${g('opening_balance', 0)}" /></div>
          <label class="check" style="align-self:flex-end"><input type="checkbox" data-f="active" ${existing && !existing.active ? '' : 'checked'} /> Active</label>
        </div>
        <label>Notes</label><textarea data-f="notes" rows="2">${UI.esc(g('notes', ''))}</textarea>`,
      confirmText: existing ? 'Save' : 'Create fund',
      onConfirm: async (ov, showErr) => {
        const val = (k) => ov.querySelector(`[data-f="${k}"]`);
        const name = val('name').value.trim();
        if (!name) { showErr('Name is required'); return false; }
        const body = {
          name, currency: val('currency').value.trim() || 'PHP',
          custodian: val('custodian').value.trim() || null,
          location_id: val('location_id').value || null,
          opening_balance: parseFloat(val('opening_balance').value) || 0,
          active: val('active').checked,
          notes: val('notes').value.trim() || null,
        };
        try {
          if (existing) await API.put('/accounting/petty-cash/funds/' + existing.id, body);
          else await API.post('/accounting/petty-cash/funds', body);
          UI.toast('Fund saved');
          await loadFunds();
          if (after) after();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }
});
