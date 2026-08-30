/* Accounting → Books: the double-entry general ledger (Phase 0).
   Chart of accounts · Journal entries · Trial Balance / P&L / Balance Sheet / GL. */
App.register('accounting-ledger', async (view, filter) => {
  const money = UI.money;
  const canManage = App.hasPermission('accounting.manage');
  let settings;
  try { settings = await API.get('/accounting/ledger/settings'); }
  catch (e) { view.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }

  if (!settings.enabled) { renderSetup(); return; }

  const tabs = ['Chart of Accounts', 'Journal', 'Trial Balance', 'Profit & Loss', 'Balance Sheet', 'General Ledger'];
  let active = filter && filter.tab ? tabs.find((t) => t.toLowerCase().replace(/[^a-z]/g, '') === filter.tab) || tabs[0] : tabs[0];

  view.innerHTML = `
    <div class="topbar">
      <h2>Books</h2>
      <div class="grow"></div>
      <span class="muted" style="font-size:12px">${settings.accounts} accounts · ${settings.entries} entries · FY from ${UI.esc(settings.fiscal_year_start)}</span>
    </div>
    <div class="subnav-inline" id="gl-tabs">${tabs.map((t) =>
      `<button class="tab ${t === active ? 'active' : ''}" data-tab="${UI.esc(t)}">${UI.esc(t)}</button>`).join('')}</div>
    <div class="panel"><div id="gl-body"><div class="empty">Loading…</div></div></div>
    <style>
      .subnav-inline{display:flex;gap:4px;margin:2px 0 10px;flex-wrap:wrap}
      .subnav-inline .tab{padding:6px 12px;border:1px solid var(--border);border-radius:7px;background:var(--surface);cursor:pointer;font-size:12.5px}
      .subnav-inline .tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
      .gl-neg{color:var(--danger)}
    </style>`;

  const body = view.querySelector('#gl-body');
  view.querySelectorAll('#gl-tabs .tab').forEach((b) => b.onclick = () => {
    active = b.dataset.tab;
    view.querySelectorAll('#gl-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    route();
  });
  route();

  function route() {
    if (active === 'Chart of Accounts') return coa();
    if (active === 'Journal') return journal();
    if (active === 'Trial Balance') return trialBalance();
    if (active === 'Profit & Loss') return pnl();
    if (active === 'Balance Sheet') return balanceSheet();
    return generalLedger();
  }

  /* ---------- setup ---------- */
  function renderSetup() {
    const jan1 = new Date().getFullYear() + '-01-01';
    view.innerHTML = `
      <div class="topbar"><h2>Books</h2></div>
      <div class="panel" style="max-width:520px">
        <h3 style="margin-top:0">Set up the general ledger</h3>
        <p class="muted">This creates a standard Philippine small-business <b>chart of accounts</b> and your
        first <b>fiscal year</b>. Everything is editable afterwards. See <code>docs/ACCOUNTING-SYSTEM-PLAN.md</code>.</p>
        ${canManage ? `
          <div class="field-row">
            <div><label>Fiscal year starts</label><input id="su-fy" type="date" value="${jan1}" /></div>
            <div><label>Base currency</label><input id="su-cur" value="PHP" maxlength="3" style="width:80px" /></div>
          </div>
          <button class="btn" id="su-go" style="margin-top:12px">Set up books</button>`
          : '<p class="muted">Ask someone with the <b>Accounting: manage</b> permission to set this up.</p>'}
      </div>`;
    const go = view.querySelector('#su-go');
    if (go) go.onclick = async () => {
      go.disabled = true;
      try {
        await API.post('/accounting/ledger/setup', {
          fiscal_year_start: view.querySelector('#su-fy').value,
          base_currency: view.querySelector('#su-cur').value.trim().toUpperCase() || 'PHP',
        });
        UI.toast('Books ready');
        App.navigate('accounting-ledger');
      } catch (e) { UI.toast(e.message, 'error'); go.disabled = false; }
    };
  }

  /* ---------- chart of accounts ---------- */
  async function coa() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    const tree = await API.get('/accounting/ledger/accounts?tree=1');
    const flat = [];
    (function walk(list, depth) {
      for (const a of list) { flat.push({ ...a, depth }); if (a.children) walk(a.children, depth + 1); }
    })(tree, 0);
    body.innerHTML = `
      <div style="display:flex;margin-bottom:8px">
        <div class="grow"></div>
        ${canManage ? `<button class="btn secondary small" id="coa-new">${UI.icon('plus')} New account</button>` : ''}
      </div>
      <table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="right">Balance</th><th></th></tr></thead>
        <tbody>${flat.map((a) => `<tr${a.is_group ? ' style="font-weight:600;background:var(--surface-2)"' : ''}>
          <td class="mono">${a.code}</td>
          <td style="padding-left:${8 + a.depth * 18}px">${UI.esc(a.name)}${a.archived ? ' <span class="badge-pill muted">archived</span>' : ''}</td>
          <td class="muted">${a.root_type}${a.account_type ? ' · ' + UI.esc(a.account_type) : ''}</td>
          <td class="right ${a.balance < 0 ? 'gl-neg' : ''}">${a.is_group ? '' : money(a.balance)}</td>
          <td class="actions">${canManage ? `<button class="icon-btn" data-edit="${a.id}" title="Edit">${UI.icon('edit')}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
    const nb = body.querySelector('#coa-new');
    if (nb) nb.onclick = () => accountModal(null, flat);
    body.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => accountModal(flat.find((x) => x.id == b.dataset.edit), flat));
  }

  function accountModal(existing, all) {
    const groups = all.filter((a) => a.is_group);
    const g = (k, d) => (existing && existing[k] != null ? existing[k] : d);
    UI.modal({
      title: existing ? `Edit ${existing.code} — ${existing.name}` : 'New account',
      bodyHTML: `
        <div class="field-row">
          <div><label>Code <span class="req">*</span></label><input data-f="code" value="${UI.esc(g('code', ''))}" style="width:110px" /></div>
          <div style="flex:1"><label>Name <span class="req">*</span></label><input data-f="name" value="${UI.esc(g('name', ''))}" /></div>
        </div>
        <div class="field-row">
          <div><label>Root type</label><select data-f="root_type">${['asset', 'liability', 'equity', 'income', 'expense'].map((t) => `<option value="${t}" ${g('root_type', 'asset') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div style="flex:1"><label>Parent (group)</label><select data-f="parent_id"><option value="">— top level —</option>
            ${groups.filter((x) => !existing || x.id !== existing.id).map((x) => `<option value="${x.id}" ${String(g('parent_id', '')) === String(x.id) ? 'selected' : ''}>${x.code} ${UI.esc(x.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field-row">
          <div style="flex:1"><label>Account type (tag)</label><input data-f="account_type" value="${UI.esc(g('account_type', ''))}" placeholder="cash / bank / receivable / tax / cogs …" /></div>
          <label class="check" style="align-self:flex-end"><input type="checkbox" data-f="is_group" ${g('is_group', 0) ? 'checked' : ''} /> Group (header)</label>
          ${existing ? `<label class="check" style="align-self:flex-end"><input type="checkbox" data-f="archived" ${existing.archived ? 'checked' : ''} /> Archived</label>` : ''}
        </div>
        <label>Description</label><input data-f="description" value="${UI.esc(g('description', ''))}" />
        ${existing ? `<div style="margin-top:10px">${canManage ? `<button type="button" class="btn danger small" id="acc-del">Delete account</button>` : ''}</div>` : ''}`,
      confirmText: existing ? 'Save' : 'Create account',
      onOpen: (ov) => {
        const del = ov.querySelector('#acc-del');
        if (del) del.onclick = async () => {
          if (!(await UI.confirmDialog('Delete this account? Only allowed if it has no entries and no sub-accounts.', 'Delete'))) return;
          try { await API.del('/accounting/ledger/accounts/' + existing.id); UI.toast('Deleted'); ov.querySelector('[data-close]').click(); coa(); }
          catch (e) { UI.toast(e.message, 'error'); }
        };
      },
      onConfirm: async (ov, showErr) => {
        const v = (k) => ov.querySelector(`[data-f="${k}"]`);
        const b = {
          code: v('code').value.trim(), name: v('name').value.trim(),
          root_type: v('root_type').value, parent_id: v('parent_id').value || null,
          account_type: v('account_type').value.trim() || null,
          is_group: v('is_group').checked, description: v('description').value.trim() || null,
          archived: v('archived') ? v('archived').checked : false,
        };
        if (!b.code || !b.name) { showErr('Code and name are required'); return false; }
        try {
          if (existing) await API.put('/accounting/ledger/accounts/' + existing.id, b);
          else await API.post('/accounting/ledger/accounts', b);
          UI.toast('Saved'); coa();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---------- journal ---------- */
  async function journal() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    const list = await API.get('/accounting/ledger/journal-entries');
    body.innerHTML = `
      <div style="display:flex;margin-bottom:8px"><div class="grow"></div>
        ${canManage ? `<button class="btn secondary small" id="je-new">${UI.icon('plus')} New entry</button>` : ''}</div>
      ${list.length ? `<table><thead><tr><th>No.</th><th>Date</th><th>Book</th><th>Memo</th><th class="right">Amount</th><th>Status</th></tr></thead>
        <tbody>${list.map((e) => `<tr class="clickable" data-open="${e.id}">
          <td class="mono">${UI.esc(e.number)}</td><td>${UI.esc(e.entry_date)}</td>
          <td class="muted">${e.book.replace('_', ' ')}</td><td>${UI.esc(e.memo || '—')}</td>
          <td class="right">${money(e.total_debit)}</td>
          <td><span class="badge-pill ${e.status === 'posted' ? 'status-completed' : 'status-open'}">${e.status}</span>${e.reversed_by ? ' <span class="badge-pill status-cancelled">reversed</span>' : ''}</td>
        </tr>`).join('')}</tbody></table>` : UI.emptyState({ icon: 'sheet', title: 'No journal entries', hint: 'Record a manual double-entry transaction.' })}`;
    const nb = body.querySelector('#je-new');
    if (nb) nb.onclick = () => entryModal(null);
    body.querySelectorAll('[data-open]').forEach((tr) => tr.onclick = () => openEntry(Number(tr.dataset.open)));
  }

  let ACCS = null;
  async function accountsForPicker() {
    if (!ACCS) ACCS = (await API.get('/accounting/ledger/accounts')).filter((a) => !a.is_group && !a.archived);
    return ACCS;
  }

  async function openEntry(id) {
    const e = await API.get('/accounting/ledger/journal-entries/' + id);
    const rows = (e.lines || []).map((l) => `<tr>
      <td class="mono">${l.account_code}</td><td>${UI.esc(l.account_name)}</td>
      <td class="right">${l.debit ? money(l.debit) : ''}</td><td class="right">${l.credit ? money(l.credit) : ''}</td>
      <td class="muted">${UI.esc(l.memo || '')}</td></tr>`).join('');
    const d = UI.drawer({
      title: `${e.number} · ${e.status}`,
      bodyHTML: `
        <div class="kv"><div><span class="muted">Date</span><div>${UI.esc(e.entry_date)}</div></div>
          <div><span class="muted">Book</span><div>${e.book.replace('_', ' ')}</div></div>
          ${e.reference ? `<div><span class="muted">Ref</span><div>${UI.esc(e.reference)}</div></div>` : ''}
          ${e.reverses_id ? `<div><span class="muted">Reverses</span><div>#${e.reverses_id}</div></div>` : ''}</div>
        ${e.memo ? `<p style="margin:8px 0">${UI.esc(e.memo)}</p>` : ''}
        ${e.reversed_by ? `<p class="muted" style="margin:8px 0">Reversed by <strong>${UI.esc(e.reversed_by)}</strong>.</p>` : ''}
        <table style="margin-top:8px"><thead><tr><th>Code</th><th>Account</th><th class="right">Debit</th><th class="right">Credit</th><th>Memo</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          ${canManage && e.status === 'draft' ? `<button class="btn" id="je-post">Post</button><button class="btn secondary" id="je-edit">Edit</button><button class="btn danger" id="je-del">Delete</button>` : ''}
          ${canManage && e.status === 'posted' && !e.reversed_by ? `<button class="btn secondary" id="je-void">Reverse</button>` : ''}
        </div>`,
    });
    const el = d.el || document;
    const close = () => d.close && d.close();
    const post = el.querySelector('#je-post');
    if (post) post.onclick = async () => { try { await API.post(`/accounting/ledger/journal-entries/${id}/post`, {}); UI.toast('Posted'); close(); journal(); } catch (er) { UI.toast(er.message, 'error'); } };
    const voidb = el.querySelector('#je-void');
    if (voidb) voidb.onclick = async () => { if (!(await UI.confirmDialog('Void this entry? A reversing entry will be posted.', 'Void'))) return; try { await API.post(`/accounting/ledger/journal-entries/${id}/void`, {}); UI.toast('Voided + reversed'); close(); journal(); } catch (er) { UI.toast(er.message, 'error'); } };
    const del = el.querySelector('#je-del');
    if (del) del.onclick = async () => { if (!(await UI.confirmDialog('Delete this draft?', 'Delete'))) return; try { await API.del('/accounting/ledger/journal-entries/' + id); UI.toast('Deleted'); close(); journal(); } catch (er) { UI.toast(er.message, 'error'); } };
    const edit = el.querySelector('#je-edit');
    if (edit) edit.onclick = () => { close(); entryModal(e); };
  }

  async function entryModal(existing) {
    const accs = await accountsForPicker();
    const opt = (sel) => '<option value="">— account —</option>' + accs.map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.code} · ${UI.esc(a.name)}</option>`).join('');
    const seed = (existing && existing.lines && existing.lines.length) ? existing.lines : [{}, {}];
    const rowHtml = (l) => `<tr class="je-row">
      <td><select data-k="account_id">${opt(l.account_id)}</select></td>
      <td><input data-k="debit" type="number" min="0" step="0.01" value="${l.debit || ''}" style="width:100px" /></td>
      <td><input data-k="credit" type="number" min="0" step="0.01" value="${l.credit || ''}" style="width:100px" /></td>
      <td><input data-k="memo" value="${UI.esc(l.memo || '')}" placeholder="line memo" /></td>
      <td><button type="button" class="icon-btn danger" data-rm>${UI.icon('trash')}</button></td></tr>`;
    UI.modal({
      title: existing ? `Edit ${existing.number}` : 'New journal entry',
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Date</label><input data-f="entry_date" type="date" value="${(existing && existing.entry_date) || new Date().toISOString().slice(0, 10)}" /></div>
          <div><label>Book</label><select data-f="book">${['general', 'sales', 'purchase', 'cash_receipts', 'cash_disbursements', 'payroll'].map((b) => `<option value="${b}" ${(existing && existing.book) === b ? 'selected' : ''}>${b.replace('_', ' ')}</option>`).join('')}</select></div>
          <div style="flex:1"><label>Reference</label><input data-f="reference" value="${UI.esc((existing && existing.reference) || '')}" /></div>
        </div>
        <label>Memo</label><input data-f="memo" value="${UI.esc((existing && existing.memo) || '')}" />
        <table style="margin-top:10px"><thead><tr><th>Account</th><th style="width:110px">Debit</th><th style="width:110px">Credit</th><th>Memo</th><th></th></tr></thead>
          <tbody id="je-rows">${seed.map(rowHtml).join('')}</tbody>
          <tfoot><tr><th class="right">Totals</th><th class="right" id="je-td">0.00</th><th class="right" id="je-tc">0.00</th><th colspan="2" id="je-bal" class="muted"></th></tr></tfoot></table>
        <button type="button" class="btn secondary small" id="je-add" style="margin-top:8px">${UI.icon('plus')} Add line</button>`,
      confirmText: existing ? 'Save draft' : 'Create draft',
      onOpen: (ov) => {
        const rowsEl = ov.querySelector('#je-rows');
        const recompute = () => {
          let td = 0, tc = 0;
          rowsEl.querySelectorAll('.je-row').forEach((r) => {
            td += parseFloat(r.querySelector('[data-k="debit"]').value) || 0;
            tc += parseFloat(r.querySelector('[data-k="credit"]').value) || 0;
          });
          ov.querySelector('#je-td').textContent = money(td);
          ov.querySelector('#je-tc').textContent = money(tc);
          const diff = Math.round((td - tc) * 100) / 100;
          ov.querySelector('#je-bal').textContent = diff === 0 ? '✓ balanced' : `out by ${money(diff)}`;
          ov.querySelector('#je-bal').style.color = diff === 0 ? 'var(--success)' : 'var(--danger)';
        };
        rowsEl.addEventListener('input', recompute);
        rowsEl.addEventListener('click', (e) => { const rm = e.target.closest('[data-rm]'); if (rm) { rm.closest('tr').remove(); recompute(); } });
        ov.querySelector('#je-add').onclick = () => { rowsEl.insertAdjacentHTML('beforeend', rowHtml({})); recompute(); };
        recompute();
      },
      onConfirm: async (ov, showErr) => {
        const f = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const lines = [...ov.querySelectorAll('.je-row')].map((r) => ({
          account_id: Number(r.querySelector('[data-k="account_id"]').value) || 0,
          debit: parseFloat(r.querySelector('[data-k="debit"]').value) || 0,
          credit: parseFloat(r.querySelector('[data-k="credit"]').value) || 0,
          memo: r.querySelector('[data-k="memo"]').value.trim() || null,
        })).filter((l) => l.account_id || l.debit || l.credit);
        const b = { entry_date: f('entry_date'), book: f('book'), reference: f('reference') || null, memo: f('memo') || null, lines };
        try {
          if (existing) await API.put('/accounting/ledger/journal-entries/' + existing.id, b);
          else await API.post('/accounting/ledger/journal-entries', b);
          UI.toast('Saved'); journal();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---------- reports ---------- */
  function dateControls(ids) {
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      ${ids.includes('from') ? `<label class="muted" style="font-size:12px">From</label><input type="date" id="r-from" />` : ''}
      ${ids.includes('to') ? `<label class="muted" style="font-size:12px">${ids.includes('from') ? 'To' : 'As of'}</label><input type="date" id="r-to" value="${new Date().toISOString().slice(0, 10)}" />` : ''}
      <button class="btn secondary small" id="r-go">Refresh</button></div>`;
  }

  async function trialBalance() {
    body.innerHTML = dateControls(['to']) + '<div id="r-out" class="empty">Loading…</div>';
    const run = async () => {
      const asOf = body.querySelector('#r-to').value;
      const d = await API.get('/accounting/ledger/reports/trial-balance?as_of=' + asOf);
      body.querySelector('#r-out').outerHTML = `<div id="r-out"><table><thead><tr><th>Code</th><th>Account</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr><td class="mono">${r.code}</td><td>${UI.esc(r.name)}</td><td class="right">${r.debit ? money(r.debit) : ''}</td><td class="right">${r.credit ? money(r.credit) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="2">Total ${d.balanced ? '✓' : '⚠ out of balance'}</th><th class="right">${money(d.total_debit)}</th><th class="right">${money(d.total_credit)}</th></tr></tfoot></table></div>`;
      body.querySelector('#r-go').onclick = run;
    };
    body.querySelector('#r-go').onclick = run; run();
  }

  async function pnl() {
    body.innerHTML = dateControls(['from', 'to']) + '<div id="r-out" class="empty">Loading…</div>';
    body.querySelector('#r-from').value = settings.fiscal_year_start;
    const run = async () => {
      const d = await API.get(`/accounting/ledger/reports/profit-and-loss?from=${body.querySelector('#r-from').value}&to=${body.querySelector('#r-to').value}`);
      const sec = (title, items, total) => `<tr style="font-weight:600;background:var(--surface-2)"><td colspan="2">${title}</td><td class="right">${money(total)}</td></tr>
        ${items.map((r) => `<tr><td class="mono">${r.code}</td><td>${UI.esc(r.name)}</td><td class="right">${money(r.amount)}</td></tr>`).join('')}`;
      body.querySelector('#r-out').outerHTML = `<div id="r-out"><table>
        <tbody>${sec('Income', d.income, d.total_income)}${sec('Expenses', d.expense, d.total_expense)}
        <tr style="font-weight:700"><td colspan="2">Net income</td><td class="right ${d.net_income < 0 ? 'gl-neg' : ''}">${money(d.net_income)}</td></tr></tbody></table></div>`;
      body.querySelector('#r-go').onclick = run;
    };
    body.querySelector('#r-go').onclick = run; run();
  }

  async function balanceSheet() {
    body.innerHTML = dateControls(['to']) + '<div id="r-out" class="empty">Loading…</div>';
    const run = async () => {
      const d = await API.get('/accounting/ledger/reports/balance-sheet?as_of=' + body.querySelector('#r-to').value);
      const sec = (title, s, extra) => `<tr style="font-weight:600;background:var(--surface-2)"><td>${title}</td><td class="right">${money((extra != null ? s.total_with_earnings : s.total))}</td></tr>
        ${s.items.map((r) => `<tr><td>${r.code} ${UI.esc(r.name)}</td><td class="right">${money(r.amount)}</td></tr>`).join('')}
        ${extra != null ? `<tr><td class="muted">Current-period earnings</td><td class="right">${money(extra)}</td></tr>` : ''}`;
      body.querySelector('#r-out').outerHTML = `<div id="r-out"><table><tbody>
        ${sec('Assets', d.assets)}
        ${sec('Liabilities', d.liabilities)}
        ${sec('Equity', d.equity, d.equity.current_period_earnings)}
        <tr style="font-weight:700"><td>Total assets</td><td class="right">${money(d.total_assets)}</td></tr>
        <tr style="font-weight:700"><td>Total liabilities + equity ${d.balanced ? '✓' : '⚠'}</td><td class="right">${money(d.total_liabilities_and_equity)}</td></tr>
      </tbody></table></div>`;
      body.querySelector('#r-go').onclick = run;
    };
    body.querySelector('#r-go').onclick = run; run();
  }

  async function generalLedger() {
    const accs = await accountsForPicker();
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select id="gl-acc" style="min-width:220px">${accs.map((a) => `<option value="${a.id}">${a.code} · ${UI.esc(a.name)}</option>`).join('')}</select>
        <label class="muted" style="font-size:12px">From</label><input type="date" id="r-from" />
        <label class="muted" style="font-size:12px">To</label><input type="date" id="r-to" value="${new Date().toISOString().slice(0, 10)}" />
        <button class="btn secondary small" id="r-go">Show</button>
      </div><div id="r-out" class="empty">Pick an account.</div>`;
    const run = async () => {
      const p = new URLSearchParams({ account_id: body.querySelector('#gl-acc').value });
      if (body.querySelector('#r-from').value) p.set('from', body.querySelector('#r-from').value);
      if (body.querySelector('#r-to').value) p.set('to', body.querySelector('#r-to').value);
      const d = await API.get('/accounting/ledger/reports/general-ledger?' + p);
      body.querySelector('#r-out').outerHTML = `<div id="r-out">
        <p class="muted">Opening balance: <strong>${money(d.opening_balance)}</strong></p>
        <table><thead><tr><th>Date</th><th>Entry</th><th>Memo</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead>
        <tbody>${d.entries.map((r) => `<tr><td>${UI.esc(r.entry_date)}</td><td class="mono">${UI.esc(r.number)}</td>
          <td>${UI.esc(r.line_memo || r.memo || '')}</td>
          <td class="right">${r.debit ? money(r.debit) : ''}</td><td class="right">${r.credit ? money(r.credit) : ''}</td>
          <td class="right">${money(r.running_balance)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="3">Closing balance</th><th class="right">${money(d.total_debit)}</th><th class="right">${money(d.total_credit)}</th><th class="right">${money(d.closing_balance)}</th></tr></tfoot></table></div>`;
      body.querySelector('#r-go').onclick = run;
    };
    body.querySelector('#r-go').onclick = run; run();
  }
});
