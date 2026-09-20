/* Accounting → Tax & Compliance: BIR returns + statutory contribution schedules.
   These read payroll / sales / purchase data but are the finance team's to file. */
const ACC_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const accPeso = (n) => (UI.money ? UI.money(n) : Number(n || 0).toFixed(2));

App.register('accounting', async (view) => {
  const canManage = App.hasPermission('accounting.manage');
  // group, title, hint, action, needsManage
  const SECTIONS = [
    ['Value-added tax', [
      ['sheet', 'BIR 2550M', 'Monthly VAT — output less input, re-sourced from the sales & purchase journals.', bir2550mModal],
      ['sheet', 'BIR 2550Q', 'Quarterly VAT — the quarter\'s output less input, with a per-month breakdown.', bir2550qModal],
      ['sheet', 'SLSP', 'Quarterly Summary List of Sales / Purchases — the RELIEF/DAT file.', slspModal],
      ['adjust', 'Tax codes', 'VAT / withholding classifications a sale, bill or note can carry.', taxCodesModal],
    ]],
    ['Expanded withholding (suppliers)', [
      ['sheet', 'Withholding register', 'Every vendor bill with EWT held back — by ATC, feeds 0619-E / 1601-EQ.', ewtRegisterModal],
      ['sheet', 'BIR 0619-E', 'Monthly remittance of expanded / creditable withholding tax, per ATC.', bir0619eModal],
      ['sheet', 'BIR 1601-EQ + QAP', 'Quarterly EWT return + Quarterly Alphalist of Payees.', bir1601eqModal],
      ['sheet', 'BIR 1604-E', 'Annual info return of creditable taxes withheld (expanded) + alphalist.', bir1604eModal],
      ['printer', 'BIR 2307', 'Certificate of Creditable Tax Withheld at Source — one per supplier, printable.', bir2307Modal],
    ]],
    ['Income tax', [
      ['sheet', 'BIR 1702Q / 1702-RT', 'Corporate income tax worksheet — book net income → adjustments → tax due, less credits.', bir1702Modal],
    ]],
    ['Withholding on compensation (payroll)', [
      ['sheet', 'BIR 1601-C', 'Monthly withholding-tax remittance worksheet.', bir1601cModal],
      ['sheet', 'BIR 1604-C', 'Annual return face + reconciliation to the Alphalist.', bir1604cModal],
      ['forms', 'BIR 1604-C Alphalist', 'Schedule 1 — Alphalist of Employees, BIR column layout.', birAlphalistModal],
      ['printer', 'BIR 2316', 'Year-end Certificate of Compensation Payment / Tax Withheld, per employee.', bir2316Modal],
    ]],
    ['Statutory contributions', [
      ['building', 'Contribution schedule', 'Monthly SSS R-3 / PhilHealth RF-1·EPRS / Pag-IBIG MCRF·eSRS collection list.', contributionScheduleModal],
      ['adjust', 'Statutory deductions', 'Turn SSS / PhilHealth / Pag-IBIG / withholding on or off per employee — feeds payroll.', statutoryDeductionsModal, true],
    ]],
    ['General ledger', [
      ['sheet', 'Books', 'Double-entry general ledger — chart of accounts, journal entries, trial balance, P&L, balance sheet, cash flow.', () => App.navigate('accounting-ledger')],
      ['sheet', 'Receivables & Payables', 'AR / AP aging, customer receipts & supplier payments, per-party statement.', () => App.navigate('accounting-receivables')],
      ['sheet', 'Petty cash', 'Named cash funds with a running money-in / money-out register.', () => App.navigate('accounting-petty-cash')],
      ['printer', 'Books of Accounts', 'The registered set — General Journal / Ledger, Cash books, Sales / Purchase Journals — printable + CSV for BIR CAS registration.', booksOfAccountsModal],
      ['printer', 'Financial Statements (AFS)', 'The five statements, this year vs last, notes-ready — a draft pack for the CPA.', afsModal],
    ]],
  ];

  const card = (c) => {
    const locked = c[4] && !canManage;
    return `<div class="${locked ? '' : 'clickable'}" data-card="${c[1]}"
        style="border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:16px;background:var(--surface-2)${locked ? ';opacity:.55' : ''}">
        <div style="color:var(--text-faint);margin-bottom:9px">${UI.icon(c[0], 22)}</div>
        <div style="font-weight:600;margin-bottom:3px">${UI.esc(c[1])}</div>
        <div class="muted" style="font-size:12.5px">${UI.esc(c[2])}</div>
        ${locked ? '<span class="badge-pill muted" style="margin-top:8px;display:inline-block">Needs Accounting: manage</span>' : ''}
      </div>`;
  };

  view.innerHTML = `
    <div class="topbar"><h2>Tax &amp; Compliance</h2></div>
    <div class="panel" style="padding:22px">
      <p class="muted" style="margin-top:0">Each item is a <b>worksheet</b> built from your payroll, sales and
      purchase records — review and adjust before filing in eBIRForms / eFPS or each agency's portal (PH agencies
      have no direct filing API). See the roadmap for a full general ledger in
      <code>docs/ACCOUNTING-SYSTEM-PLAN.md</code>.</p>
      ${SECTIONS.map(([group, cards]) => `
        <h4 style="margin:18px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">${UI.esc(group)}</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:12px">
          ${cards.map(card).join('')}
        </div>`).join('')}
    </div>`;

  const byName = Object.fromEntries(SECTIONS.flatMap(([, cs]) => cs).map((c) => [c[1], c]));
  view.querySelectorAll('[data-card]').forEach((el) => {
    if (!el.classList.contains('clickable')) return;
    el.onclick = () => byName[el.dataset.card][3]();
  });
});

/* ── Tax codes — VAT / withholding classifications ───────────────────────── */
async function taxCodesModal() {
  const canManage = App.hasPermission('accounting.manage');
  const KINDS = ['output_vat', 'input_vat', 'exempt', 'zero_rated', 'ewt'];
  const KIND_LABEL = {
    output_vat: 'Output VAT', input_vat: 'Input VAT', exempt: 'VAT-exempt',
    zero_rated: 'Zero-rated', ewt: 'Expanded withholding',
  };
  let list = [];
  let bodyEl = null;

  const rowHtml = (t) => `<tr data-id="${t.id}" ${t.active ? '' : 'style="opacity:.5"'}>
    <td class="mono">${UI.esc(t.code)}</td><td>${UI.esc(t.name)}</td>
    <td class="muted">${KIND_LABEL[t.kind] || t.kind}</td>
    <td class="right">${t.rate ? t.rate + '%' : '—'}</td>
    <td class="mono">${UI.esc(t.atc || '—')}</td>
    <td class="muted">${UI.esc(t.account_name || '—')}</td>
    <td class="actions">${canManage ? `<button class="icon-btn" data-edit="${t.id}">${UI.icon('edit')}</button>` : ''}</td>
  </tr>`;

  async function reload() {
    list = await API.get('/accounting/tax-codes');
    if (!bodyEl) return;
    bodyEl.innerHTML = list.map(rowHtml).join('');
    bodyEl.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => editTaxCode(list.find((x) => x.id == b.dataset.edit)));
  }

  async function editTaxCode(t) {
    let accts = [];
    try { accts = (await API.get('/accounting/ledger/accounts')).filter((a) => !a.is_group); } catch { /* ledger maybe off */ }
    UI.modal({
      title: t ? `Edit ${t.code}` : 'New tax code',
      bodyHTML: `<div class="form-grid">
        <div class="form-field"><div class="field-label"><label>Code <span class="req">*</span></label></div>
          <input data-f="code" value="${UI.esc(t ? t.code : '')}" style="width:120px" /></div>
        <div class="form-field"><div class="field-label"><label>Kind</label></div>
          <select data-f="kind">${KINDS.map((k) => `<option value="${k}" ${t && t.kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select></div>
        <div class="form-field span2"><div class="field-label"><label>Name <span class="req">*</span></label></div>
          <input data-f="name" value="${UI.esc(t ? t.name : '')}" /></div>
        <div class="form-field"><div class="field-label"><label>Rate %</label></div>
          <input data-f="rate" type="number" step="0.01" min="0" max="100" value="${t ? (t.rate || 0) : 0}" /></div>
        <div class="form-field"><div class="field-label"><label>ATC (withholding)</label></div>
          <input data-f="atc" value="${UI.esc(t && t.atc || '')}" style="width:120px" /></div>
        <div class="form-field span2"><div class="field-label"><label>GL account (VAT codes)</label></div>
          <select data-f="account_id"><option value="">— use posting-rule default —</option>
            ${accts.map((a) => `<option value="${a.id}" ${t && String(t.account_id) === String(a.id) ? 'selected' : ''}>${a.code} · ${UI.esc(a.name)}</option>`).join('')}</select></div>
        ${t ? `<div class="form-field"><label class="check" style="margin-top:22px"><input type="checkbox" data-f="active" ${t.active ? 'checked' : ''} /> Active</label></div>` : ''}
      </div>
      ${t && canManage ? `<div style="margin-top:10px"><button type="button" class="btn danger small" id="tc-del">Delete</button></div>` : ''}`,
      confirmText: t ? 'Save' : 'Create',
      onOpen: (ov) => {
        const del = ov.querySelector('#tc-del');
        if (del) del.onclick = async () => {
          if (!(await UI.confirmDialog(`Delete tax code ${t.code}?`, 'Delete'))) return;
          try {
            await API.del('/accounting/tax-codes/' + t.id); UI.toast('Deleted'); reload();
            const c = ov.querySelector('[data-close]'); if (c) c.click();
          } catch (e) { UI.toast(e.message, 'error'); }
        };
      },
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`);
        const body = {
          code: g('code').value.trim(), name: g('name').value.trim(),
          kind: g('kind').value, rate: Number(g('rate').value) || 0,
          atc: g('atc').value.trim() || null,
          account_id: g('account_id').value ? Number(g('account_id').value) : null,
        };
        if (t) body.active = !!(g('active') && g('active').checked);
        if (!body.code || !body.name) { showErr('Code and name are required'); return false; }
        try {
          if (t) await API.put('/accounting/tax-codes/' + t.id, body);
          else await API.post('/accounting/tax-codes', body);
          UI.toast('Saved'); reload();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  try { list = await API.get('/accounting/tax-codes'); }
  catch (e) { UI.toast(e.message, 'error'); return; }

  UI.modal({
    title: 'Tax codes',
    size: 'lg',
    cancelText: 'Close',
    confirmText: canManage ? 'New tax code' : null,
    onConfirm: canManage ? () => { editTaxCode(null); return false; } : undefined,
    bodyHTML: `
      <p class="muted" style="margin-top:0;font-size:12px">A sale order, vendor bill or credit / debit note can carry one of these.
      It picks the GL VAT account for the auto-post and the column in the BIR sales / purchase journals.</p>
      <table class="line-table"><thead><tr><th>Code</th><th>Name</th><th>Kind</th><th class="right">Rate</th><th>ATC</th><th>GL account</th><th></th></tr></thead>
        <tbody id="tc-body">${list.map(rowHtml).join('')}</tbody></table>`,
    onOpen: (ov) => {
      bodyEl = ov.querySelector('#tc-body');
      bodyEl.querySelectorAll('[data-edit]').forEach((b) =>
        b.onclick = () => editTaxCode(list.find((x) => x.id == b.dataset.edit)));
    },
  });
}

/* ── Statutory deductions — per-employee SSS / PhilHealth / Pag-IBIG / WT switches ── */
async function statutoryDeductionsModal() {
  const COLS = [
    ['deduct_sss', 'SSS'], ['deduct_philhealth', 'PhilHealth'],
    ['deduct_pagibig', 'Pag-IBIG'], ['deduct_withholding_tax', 'Withholding tax'],
  ];
  let data;
  try { data = await API.get('/accounting/statutory-deductions'); }
  catch (e) { UI.toast(e.message, 'error'); return; }

  const rows = data.rows.map((r) => ({ ...r }));       // working copy
  const dirty = new Set();

  const m = UI.modal({
    title: 'Statutory deductions — per employee',
    size: 'lg',
    confirmText: 'Save changes',
    bodyHTML: `
      <p class="muted" style="margin-top:0;font-size:12px">${UI.esc(data.note || '')}</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <div class="search-box search" style="flex:1;min-width:180px">${UI.icon('search', 15)}<input id="sd-q" placeholder="Filter employees…" /></div>
        ${COLS.map((c) => `<button type="button" class="btn secondary small" data-col="${c[0]}">Toggle ${c[1]}</button>`).join('')}
      </div>
      <div style="max-height:52vh;overflow:auto;border:1px solid var(--border);border-radius:8px">
        <table class="line-table"><thead><tr>
          <th>Employee</th>${COLS.map((c) => `<th class="right" style="width:96px">${c[1]}</th>`).join('')}
        </tr></thead><tbody id="sd-body"></tbody></table>
      </div>`,
    onOpen: (ov) => {
      const body = ov.querySelector('#sd-body');
      const q = ov.querySelector('#sd-q');
      function draw() {
        const term = q.value.trim().toLowerCase();
        body.innerHTML = rows
          .filter((r) => !term || r.name.toLowerCase().includes(term) || (r.employee_no || '').toLowerCase().includes(term))
          .map((r) => `<tr data-id="${r.id}">
            <td>${UI.esc(r.name)}<div class="muted mono" style="font-size:11px">${UI.esc(r.employee_no || '')}${r.department_name ? ' · ' + UI.esc(r.department_name) : ''}</div></td>
            ${COLS.map((c) => `<td class="right"><input type="checkbox" data-f="${c[0]}" ${r[c[0]] ? 'checked' : ''} /></td>`).join('')}
          </tr>`).join('');
        body.querySelectorAll('tr[data-id]').forEach((tr) => {
          const r = rows.find((x) => x.id === Number(tr.dataset.id));
          tr.querySelectorAll('[data-f]').forEach((cb) => cb.onchange = () => {
            r[cb.dataset.f] = cb.checked; dirty.add(r.id);
          });
        });
      }
      q.oninput = draw;
      ov.querySelectorAll('[data-col]').forEach((b) => b.onclick = () => {
        const col = b.dataset.col;
        const visible = [...body.querySelectorAll('tr[data-id]')].map((tr) => Number(tr.dataset.id));
        const target = !visible.every((id) => rows.find((r) => r.id === id)[col]);
        visible.forEach((id) => { const r = rows.find((x) => x.id === id); r[col] = target; dirty.add(id); });
        draw();
      });
      draw();
    },
    onConfirm: async (ov, showErr) => {
      if (!dirty.size) { m.close && m.close(); return; }
      const updates = [...dirty].map((id) => {
        const r = rows.find((x) => x.id === id);
        return {
          employee_id: id,
          deduct_sss: r.deduct_sss, deduct_philhealth: r.deduct_philhealth,
          deduct_pagibig: r.deduct_pagibig, deduct_withholding_tax: r.deduct_withholding_tax,
        };
      });
      try {
        await API.put('/accounting/statutory-deductions', { updates });
        UI.toast(`Saved — ${updates.length} employee${updates.length === 1 ? '' : 's'} updated. Re-generate payslips to apply.`);
      } catch (e) { showErr(e.message); return false; }
    },
  });
}

/* ── BIR 2550M / 2550Q — VAT declaration ─────────────────────────────────── */
// Shared worksheet + breakdown renderer for the monthly / quarterly VAT return.
function vatReturnBodyHtml(state) {
  if (!state) return '<div class="m-error">Could not load.</div>';
  const w = state.worksheet;
  const bd = state.breakdown || { sales: {}, purchases: {} };
  const split = (label, s) => `<tr><td>${label} — vatable</td><td class="right">${accPeso(s.vatable)}</td></tr>
    <tr><td>${label} — exempt</td><td class="right">${accPeso(s.exempt)}</td></tr>
    <tr><td>${label} — zero-rated</td><td class="right">${accPeso(s.zero_rated)}</td></tr>`;
  const monthly = state.monthly ? `<h4 style="margin:14px 0 6px">Per month</h4>
    <table class="line-table"><thead><tr><th>Month</th><th class="right">Output VAT</th><th class="right">Input VAT</th><th class="right">Net</th></tr></thead>
      <tbody>${state.monthly.map((m) => `<tr><td>${UI.esc(m.month)}</td><td class="right">${accPeso(m.output_vat)}</td>
        <td class="right">${accPeso(m.input_vat)}</td><td class="right">${accPeso(m.net_vat)}</td></tr>`).join('')}</tbody></table>` : '';
  return `<table class="line-table"><tbody>
      ${split('Sales', bd.sales)}
      <tr><th>Output VAT</th><th class="right">${accPeso(w.output_vat)}</th></tr>
      ${split('Purchases', bd.purchases)}
      <tr><td>Input VAT — current</td><td class="right">${accPeso(w.input_vat_current)}</td></tr>
      <tr><td>Input VAT — carried over</td><td class="right">${accPeso(w.input_vat_carry_over)}</td></tr>
      <tr><th>Total available input VAT</th><th class="right">${accPeso(w.total_available_input_vat)}</th></tr>
      <tr><td>Net VAT payable</td><td class="right">${accPeso(w.net_vat_payable)}</td></tr>
      <tr><td>Less: VAT paid / withheld</td><td class="right">${accPeso(w.vat_payments)}</td></tr>
      <tr><th>Still payable</th><th class="right" style="color:${w.still_payable ? 'var(--danger)' : ''}">${accPeso(w.still_payable)}</th></tr>
      <tr><td>Excess input VAT (carry forward)</td><td class="right">${accPeso(w.excess_input_vat)}</td></tr>
    </tbody></table>
    ${monthly}
    <p class="muted" style="font-size:11px;margin-top:8px">${UI.esc(state.note || '')}</p>
    ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:8px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}`;
}

async function bir2550mModal() {
  UI.modal({
    title: 'BIR 2550M — monthly VAT declaration',
    size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Month</label><input id="v-month" type="month" value="${new Date().toISOString().slice(0, 7)}" />
        <label class="check" style="margin:0"><input type="checkbox" id="v-incl" /> Amounts are VAT-inclusive</label>
        <div class="grow"></div>
        <label style="margin:0;font-size:12px">Input VAT carry-over</label><input id="v-carry" type="number" min="0" step="0.01" value="0" style="width:110px" />
        <label style="margin:0;font-size:12px">VAT paid / withheld</label><input id="v-paid" type="number" min="0" step="0.01" value="0" style="width:110px" />
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Re-sourced from the BIR sales & purchase journals — the
        exempt / zero-rated split and any credit / debit notes are already netted. Confirm disallowed input VAT
        before filing. Deadline: the 20th of the following month.</p>
      <div id="v-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      async function load() {
        ov.querySelector('#v-body').innerHTML = '<div class="empty">Loading…</div>';
        const p = new URLSearchParams({
          month: ov.querySelector('#v-month').value,
          vat_inclusive: ov.querySelector('#v-incl').checked ? '1' : '0',
          input_vat_carry_over: ov.querySelector('#v-carry').value || 0,
          vat_payments: ov.querySelector('#v-paid').value || 0,
        });
        const state = await API.get('/accounting/bir-2550m?' + p.toString()).catch(() => null);
        ov.querySelector('#v-body').innerHTML = vatReturnBodyHtml(state);
      }
      ['#v-month', '#v-incl', '#v-carry', '#v-paid'].forEach((s) => ov.querySelector(s).addEventListener('change', load));
      load();
    },
  });
}

async function bir2550qModal() {
  const quarters = accQuarterOptions();
  UI.modal({
    title: 'BIR 2550Q — quarterly VAT declaration',
    size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Quarter</label>
        <select id="v-q">${quarters.map((q) => `<option value="${q}">${q}</option>`).join('')}</select>
        <label class="check" style="margin:0"><input type="checkbox" id="v-incl" /> Amounts are VAT-inclusive</label>
        <div class="grow"></div>
        <label style="margin:0;font-size:12px">Input VAT carry-over</label><input id="v-carry" type="number" min="0" step="0.01" value="0" style="width:110px" />
        <label style="margin:0;font-size:12px">VAT paid (2550M)</label><input id="v-paid" type="number" min="0" step="0.01" value="0" style="width:110px" />
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">The quarter's output less input, re-sourced from the sales
        & purchase journals. Enter the VAT already paid on the two monthly 2550M returns. Attach the SLSP when over
        the threshold. Deadline: the 25th day after the quarter.</p>
      <div id="v-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      async function load() {
        ov.querySelector('#v-body').innerHTML = '<div class="empty">Loading…</div>';
        const p = new URLSearchParams({
          quarter: ov.querySelector('#v-q').value,
          vat_inclusive: ov.querySelector('#v-incl').checked ? '1' : '0',
          input_vat_carry_over: ov.querySelector('#v-carry').value || 0,
          vat_payments: ov.querySelector('#v-paid').value || 0,
        });
        const state = await API.get('/accounting/bir-2550q?' + p.toString()).catch(() => null);
        ov.querySelector('#v-body').innerHTML = vatReturnBodyHtml(state);
      }
      ['#v-q', '#v-incl', '#v-carry', '#v-paid'].forEach((s) => ov.querySelector(s).addEventListener('change', load));
      load();
    },
  });
}

/* ── BIR 1702Q / 1702-RT — corporate income tax worksheet ───────────────── */
async function bir1702Modal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR 1702Q / 1702-RT — income tax', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <label style="margin:0">Year</label>
        <select id="it-y">${[0, 1, 2, 3].map((i) => `<option>${thisYear - i}</option>`).join('')}</select>
        <label style="margin:0">Period</label>
        <select id="it-q"><option value="">Annual (1702-RT)</option>${[1, 2, 3].map((q) => `<option value="Q${q}">Q${q} cumulative (1702Q)</option>`).join('')}</select>
        <label class="check" style="margin:0"><input type="checkbox" id="it-osd" /> Optional Standard Deduction (40%)</label>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <label class="check" style="margin:0"><input type="checkbox" id="it-small" /> Small / MSME corp (20% rate)</label>
        <label class="check" style="margin:0"><input type="checkbox" id="it-mcit" /> MCIT applies (4th year on)</label>
        <label style="margin:0;font-size:12px">Prior-quarter payments</label><input id="it-prior" type="number" min="0" step="0.01" value="0" style="width:110px" />
        <label style="margin:0;font-size:12px">Creditable WT (2307s received)</label><input id="it-cwt" type="number" min="0" step="0.01" value="0" style="width:110px" />
        <label style="margin:0;font-size:12px">Prior-year excess</label><input id="it-pye" type="number" min="0" step="0.01" value="0" style="width:110px" />
      </div>
      <p class="muted" style="font-size:12px;margin:0 0 6px">Book net income &amp; gross income come from the posted ledger for the period (the
        year-end closing entry is excluded). Under itemized deductions, add non-deductible expenses back and deduct
        non-taxable income here; under OSD these lines don't apply.</p>
      <table class="line-table"><thead><tr><th>Reconciliation item</th><th style="width:110px">Add / Deduct</th><th style="width:130px">Amount</th><th></th></tr></thead>
        <tbody id="it-rows"></tbody></table>
      <button type="button" class="btn secondary small" id="it-add" style="margin-top:6px">${UI.icon('plus', 14)} Add line</button>
      <div id="it-out" style="margin-top:12px" class="empty">Loading…</div>`,
    onOpen: (ov) => {
      const rowsEl = ov.querySelector('#it-rows');
      const out = ov.querySelector('#it-out');
      const rowHtml = () => `<tr>
        <td><input data-k="label" placeholder="e.g. Provision for bad debts" /></td>
        <td><select data-k="kind"><option value="add">Add back</option><option value="deduct">Deduct</option></select></td>
        <td><input data-k="amount" type="number" min="0" step="0.01" value="0" style="width:120px" /></td>
        <td><button type="button" class="icon-btn danger" data-rm>${UI.icon('trash', 14)}</button></td></tr>`;

      const recompute = async () => {
        const adjustments = [...rowsEl.querySelectorAll('tr')].map((tr) => ({
          label: tr.querySelector('[data-k="label"]').value.trim(),
          kind: tr.querySelector('[data-k="kind"]').value,
          amount: parseFloat(tr.querySelector('[data-k="amount"]').value) || 0,
        })).filter((a) => a.amount > 0);
        const q = new URLSearchParams({
          period: ov.querySelector('#it-q').value ? `${ov.querySelector('#it-y').value}-${ov.querySelector('#it-q').value}` : ov.querySelector('#it-y').value,
          deduction: ov.querySelector('#it-osd').checked ? 'osd' : 'itemized',
          adjustments: JSON.stringify(adjustments),
          small_corp: ov.querySelector('#it-small').checked ? '1' : '0',
          mcit: ov.querySelector('#it-mcit').checked ? '1' : '0',
          prior_payments: ov.querySelector('#it-prior').value || 0,
          creditable_withholding: ov.querySelector('#it-cwt').value || 0,
          prior_year_excess: ov.querySelector('#it-pye').value || 0,
        });
        try {
          const d = await API.get('/accounting/bir-1702?' + q.toString());
          const w = d.worksheet;
          out.innerHTML = `<p class="muted" style="font-size:11px;margin:0 0 6px">${UI.esc(d.form)} · ${UI.esc(d.period)} · ${UI.esc(d.from)} to ${UI.esc(d.to)}</p>
            <table class="line-table"><tbody>
              <tr><td>Gross income (net sales − COGS + other)</td><td class="right">${accPeso(d.sources.gross_income)}</td></tr>
              <tr><td>Book net income</td><td class="right">${accPeso(d.sources.book_net_income)}</td></tr>
              ${w.deduction_method === 'itemized' ? `<tr><td>Add: non-deductible items</td><td class="right">${accPeso(w.additions)}</td></tr>
                <tr><td>Less: non-taxable income</td><td class="right">${accPeso(w.deductions)}</td></tr>` : ''}
              <tr><th>Net taxable income</th><th class="right">${accPeso(w.net_taxable_income)}</th></tr>
              <tr><td>Regular income tax @ ${(w.rate * 100).toFixed(0)}%</td><td class="right">${accPeso(w.regular_income_tax)}</td></tr>
              ${w.mcit_applies ? `<tr><td>MCIT @ ${(w.mcit_rate * 100).toFixed(0)}% of gross income</td><td class="right">${accPeso(w.mcit)}</td></tr>` : ''}
              <tr><th>Income tax due</th><th class="right">${accPeso(w.income_tax_due)}</th></tr>
              <tr><td>Less: total tax credits / payments</td><td class="right">${accPeso(w.total_credits)}</td></tr>
              <tr><th>Still payable</th><th class="right" style="color:${w.still_payable ? 'var(--danger)' : ''}">${accPeso(w.still_payable)}</th></tr>
              ${w.overpayment ? `<tr><td>Overpayment (carry over / refund)</td><td class="right">${accPeso(w.overpayment)}</td></tr>` : ''}
            </tbody></table>
            ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:8px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}`;
        } catch { out.innerHTML = '<div class="m-error">Could not compute.</div>'; }
      };

      ov.querySelector('#it-add').onclick = () => {
        rowsEl.insertAdjacentHTML('beforeend', rowHtml());
        const tr = rowsEl.lastElementChild;
        tr.querySelector('[data-rm]').onclick = () => { tr.remove(); recompute(); };
        tr.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', recompute));
      };
      ov.querySelectorAll('#it-y,#it-q,#it-osd,#it-small,#it-mcit,#it-prior,#it-cwt,#it-pye').forEach((el) => el.addEventListener('input', recompute));
      recompute();
    },
  });
}

/* ── BIR 0619-E — expanded withholding tax remittance ────────────────────── */
async function bir0619eModal() {
  let ref = [];
  UI.modal({
    title: 'BIR 0619-E — expanded withholding remittance',
    size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Month</label><input id="e-month" type="month" value="${new Date().toISOString().slice(0, 7)}" />
        <div class="grow"></div>
        <label style="margin:0;font-size:12px">Already remitted this month</label>
        <input id="e-prior" type="number" min="0" step="0.01" value="0" style="width:110px" />
        <button type="button" class="btn secondary small" id="e-add">${UI.icon('plus', 14)} Add ATC line</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">One line per Alphanumeric Tax Code (type of income payment).
        The payee-by-payee detail goes on the quarterly 1601-EQ + QAP; 0619-E just remits the tax. Deadline: the
        10th of the following month (11th on eFPS).</p>
      <table class="line-table"><thead><tr><th>ATC</th><th>Nature</th><th style="width:120px">Tax base</th><th style="width:90px">Rate %</th><th class="right">Tax</th><th></th></tr></thead>
        <tbody id="e-rows"></tbody></table>
      <div id="e-out" style="margin-top:10px"></div>`,
    onOpen: async (ov) => {
      const rowsEl = ov.querySelector('#e-rows');
      const out = ov.querySelector('#e-out');
      try {
        const seed = await API.get('/accounting/bir-0619e?month=' + ov.querySelector('#e-month').value);
        ref = seed.atc_reference || [];
        if (seed.purchases_hint) out.innerHTML = `<p class="muted" style="font-size:11px">Approved vendor bills this month: ${accPeso(seed.purchases_hint)} — only the WT-applicable portion is a tax base.</p>`;
      } catch { /* leave ref empty */ }

      const rowHtml = () => `<tr>
        <td><select data-k="atc">${ref.map((a, i) => `<option value="${i}">${UI.esc(a.atc)}</option>`).join('')}</select></td>
        <td data-k="desc" class="muted" style="font-size:12px"></td>
        <td><input data-k="base" type="number" min="0" step="0.01" value="0" style="width:110px" /></td>
        <td><input data-k="rate" type="number" min="0" step="0.01" style="width:80px" readonly /></td>
        <td class="right" data-k="tax">0.00</td>
        <td><button type="button" class="icon-btn danger" data-rm>${UI.icon('trash', 14)}</button></td></tr>`;

      function recompute() {
        const lines = [];
        rowsEl.querySelectorAll('tr').forEach((tr) => {
          const a = ref[Number(tr.querySelector('[data-k="atc"]').value)] || { atc: '', description: '', rate: 0 };
          const base = parseFloat(tr.querySelector('[data-k="base"]').value) || 0;
          tr.querySelector('[data-k="desc"]').textContent = a.description;
          tr.querySelector('[data-k="rate"]').value = (a.rate * 100).toFixed(2);
          tr.querySelector('[data-k="tax"]').textContent = accPeso(base * a.rate);
          lines.push({ atc: a.atc, description: a.description, tax_base: base, rate: a.rate });
        });
        const q = new URLSearchParams({
          month: ov.querySelector('#e-month').value,
          remitted_prior: ov.querySelector('#e-prior').value || 0,
          lines: JSON.stringify(lines),
        });
        API.get('/accounting/bir-0619e?' + q.toString()).then((r) => {
          const w = r.worksheet;
          out.innerHTML = `<table class="line-table"><tbody>
              <tr><td>Total tax base</td><td class="right">${accPeso(w.total_tax_base)}</td></tr>
              <tr><th>Total tax withheld</th><th class="right">${accPeso(w.total_tax_withheld)}</th></tr>
              <tr><td>Less: already remitted</td><td class="right">${accPeso(w.remitted_prior)}</td></tr>
              <tr><th>Still payable</th><th class="right" style="color:${w.still_payable ? 'var(--danger)' : ''}">${accPeso(w.still_payable)}</th></tr>
            </tbody></table>
            ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:8px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}`;
        }).catch(() => { out.innerHTML = '<div class="m-error">Could not compute.</div>'; });
      }

      function addRow() {
        rowsEl.insertAdjacentHTML('beforeend', rowHtml());
        const tr = rowsEl.lastElementChild;
        tr.querySelector('[data-rm]').onclick = () => { tr.remove(); recompute(); };
        tr.querySelectorAll('select,input').forEach((el) => el.addEventListener('input', recompute));
        recompute();
      }
      ov.querySelector('#e-add').onclick = addRow;
      ov.querySelector('#e-month').addEventListener('change', recompute);
      ov.querySelector('#e-prior').addEventListener('input', recompute);
      addRow();
    },
  });
}

/* ── Withholding (EWT) register ──────────────────────────────────────────── */
async function ewtRegisterModal() {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const last = today.toISOString().slice(0, 10);
  UI.modal({
    title: 'Withholding (EWT) register', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">From</label><input id="w-from" type="date" value="${first}" />
        <label style="margin:0">To</label><input id="w-to" type="date" value="${last}" />
        <button type="button" class="btn secondary small" id="w-go">Refresh</button>
        <div class="grow"></div><button type="button" class="btn secondary small" id="w-csv">${UI.icon('download', 14)} CSV</button>
      </div>
      <div id="w-out" class="empty">Loading…</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#w-out');
      let data = { rows: [], total_base: 0, total_tax: 0, by_atc: [] };
      const run = async () => {
        const from = ov.querySelector('#w-from').value, to = ov.querySelector('#w-to').value;
        const d = await API.get(`/accounting/ewt-register?from=${from}&to=${to}`);
        data = d;
        out.innerHTML = `
          <table class="line-table"><thead><tr><th>Date</th><th>Bill</th><th>Supplier</th><th>TIN</th><th>ATC</th>
            <th class="right">Base</th><th class="right">Rate</th><th class="right">Withheld</th></tr></thead>
            <tbody>${d.rows.map((r) => `<tr><td>${UI.esc(r.date || '—')}</td><td class="mono">${UI.esc(r.ref)}</td>
              <td>${UI.esc(r.supplier || '—')}</td><td class="mono">${UI.esc(r.tin || '—')}</td><td class="mono">${UI.esc(r.atc || '—')}</td>
              <td class="right">${accPeso(r.base)}</td><td class="right">${(r.rate || 0).toFixed(2)}%</td><td class="right">${accPeso(r.tax)}</td></tr>`).join('')
              || `<tr><td colspan="8" class="muted" style="text-align:center;padding:14px">No EWT withheld in this range.</td></tr>`}</tbody>
            <tfoot><tr><th colspan="5">Totals</th><th class="right">${accPeso(d.total_base)}</th><th></th><th class="right">${accPeso(d.total_tax)}</th></tr></tfoot>
          </table>
          ${d.by_atc.length ? `<h4 style="margin:14px 0 6px">By ATC</h4><table class="line-table"><thead><tr><th>ATC</th><th class="right">Bills</th><th class="right">Base</th><th class="right">Withheld</th></tr></thead>
            <tbody>${d.by_atc.map((a) => `<tr><td class="mono">${UI.esc(a.atc)}</td><td class="right">${a.count}</td><td class="right">${accPeso(a.base)}</td><td class="right">${accPeso(a.tax)}</td></tr>`).join('')}</tbody></table>` : ''}`;
      };
      ov.querySelector('#w-go').onclick = run;
      ov.querySelector('#w-csv').onclick = () => UI.downloadCsv('ewt-register.csv',
        ['Date', 'Bill', 'Supplier', 'TIN', 'ATC', 'Base', 'Rate%', 'Withheld'],
        data.rows.map((r) => [r.date || '', r.ref, r.supplier || '', r.tin || '', r.atc || '', r.base, r.rate, r.tax]));
      run();
    },
  });
}

/* ── BIR 2307 — Certificate of Creditable Tax Withheld at Source ──────────── */
/* ── Books of Accounts — the registered CAS set ─────────────────────────── */
function boaBookHtml(bk) {
  const e = UI.esc, m = accPeso;
  const d = bk.data || {};
  if (bk.key === 'general_journal') {
    return `<table class="line-table"><thead><tr><th>Date</th><th>Ref</th><th>Account</th><th>Particulars</th><th class="right">Debit</th><th class="right">Credit</th></tr></thead>
      <tbody>${(d.rows || []).map((r) => `<tr><td>${e(r.date)}</td><td class="mono">${e(r.number)}</td>
        <td>${e(r.account_code)} ${e(r.account_name)}</td><td>${e(r.line_memo || r.memo || '')}</td>
        <td class="right">${r.debit ? m(r.debit) : ''}</td><td class="right">${r.credit ? m(r.credit) : ''}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted" style="text-align:center;padding:10px">No entries in this period.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="4">Totals</th><th class="right">${m(d.total_debit)}</th><th class="right">${m(d.total_credit)}</th></tr></tfoot></table>`;
  }
  if (bk.key === 'general_ledger') {
    return (d.accounts || []).map((acc) => `<h4 style="margin:12px 0 4px">${e(acc.account.code)} · ${e(acc.account.name)}</h4>
      <table class="line-table"><thead><tr><th>Date</th><th>Ref</th><th>Particulars</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead>
      <tbody>
        <tr><td colspan="5" class="muted">Opening balance</td><td class="right">${m(acc.opening_balance)}</td></tr>
        ${acc.entries.map((x) => `<tr><td>${e(x.date)}</td><td class="mono">${e(x.number)}</td><td>${e(x.memo || '')}</td>
          <td class="right">${x.debit ? m(x.debit) : ''}</td><td class="right">${x.credit ? m(x.credit) : ''}</td><td class="right">${m(x.running_balance)}</td></tr>`).join('')}
        <tr style="font-weight:600"><td colspan="3">Closing balance</td><td class="right">${m(acc.total_debit)}</td><td class="right">${m(acc.total_credit)}</td><td class="right">${m(acc.closing_balance)}</td></tr>
      </tbody></table>`).join('') || '<p class="muted">No account activity in this period.</p>';
  }
  if (bk.key === 'cash_receipts_book' || bk.key === 'cash_disbursements_book') {
    const inCol = bk.key === 'cash_receipts_book' ? 'Cash in' : 'Cash out';
    return `<table class="line-table"><thead><tr><th>Date</th><th>Ref</th><th>Payee / payor</th><th>Particulars</th><th class="right">${inCol}</th><th>Contra account(s)</th></tr></thead>
      <tbody>${(d.rows || []).map((r) => `<tr><td>${e(r.date)}</td><td class="mono">${e(r.ref || r.number)}</td>
        <td>${e(r.party || '')}</td><td>${e(r.memo || '')}</td>
        <td class="right">${m(bk.key === 'cash_receipts_book' ? r.cash_in : r.cash_out)}</td>
        <td class="muted" style="font-size:11px">${r.contra.map((c) => `${e(c.code)} ${c.debit ? 'Dr ' + m(c.debit) : 'Cr ' + m(c.credit)}`).join('; ')}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted" style="text-align:center;padding:10px">No entries in this period.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="4">Total</th><th class="right">${m(bk.key === 'cash_receipts_book' ? d.cash_totals.debit : d.cash_totals.credit)}</th><th></th></tr></tfoot></table>`;
  }
  // sales_journal / purchase_journal
  const who = bk.key === 'sales_journal' ? 'Customer' : 'Supplier';
  return `<table class="line-table"><thead><tr><th>Date</th><th>Ref</th><th>${who}</th><th>TIN</th>
      <th class="right">Gross</th><th class="right">VATable</th><th class="right">Exempt</th><th class="right">Zero-rated</th><th class="right">VAT</th></tr></thead>
    <tbody>${(d.rows || []).map((r) => `<tr><td>${e(r.date || '')}</td><td class="mono">${e(r.ref)}</td><td>${e(r.name || '')}</td><td class="mono">${e(r.tin || '')}</td>
      <td class="right">${m(r.cols.gross)}</td><td class="right">${m(r.cols.vatable)}</td><td class="right">${m(r.cols.exempt)}</td><td class="right">${m(r.cols.zero_rated)}</td><td class="right">${m(r.cols.vat)}</td></tr>`).join('')
      || '<tr><td colspan="9" class="muted" style="text-align:center;padding:10px">No documents in this period.</td></tr>'}</tbody>
    <tfoot><tr><th colspan="4">Totals</th><th class="right">${m(d.totals.gross)}</th><th class="right">${m(d.totals.vatable)}</th><th class="right">${m(d.totals.exempt)}</th><th class="right">${m(d.totals.zero_rated)}</th><th class="right">${m(d.totals.vat)}</th></tr></tfoot></table>`;
}

/* ── Financial Statements (AFS) — comparative pack for the CPA ───────────── */
function afsStatementsHtml(d, mode) {
  // mode: 'screen' (compact tables) or 'print' (full, page-broken)
  const e = UI.esc, m = accPeso;
  const s = d.statements;
  const cur = d.year, pri = d.prior_year;
  const two = (label, c, p) => `<tr><td>${e(label)}</td><td class="right">${m(c)}</td><td class="right muted">${m(p)}</td></tr>`;
  const hd = (t) => `<tr style="font-weight:700;background:var(--surface-2)"><td>${e(t)}</td><td class="right">${cur}</td><td class="right muted">${pri}</td></tr>`;
  const items = (cur, pri, key) => {
    const map = new Map();
    (cur.items || cur || []).forEach((x) => map.set(x.code, { code: x.code, name: x.name, c: x.amount, p: 0 }));
    (pri.items || pri || []).forEach((x) => { const r = map.get(x.code) || { code: x.code, name: x.name, c: 0, p: 0 }; r.p = x.amount; map.set(x.code, r); });
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code))
      .map((r) => two(`${r.code} ${r.name}`, r.c, r.p)).join('');
  };

  const fp = s.financial_position;
  const ci = s.comprehensive_income;
  const cf = s.cash_flows;
  const ce = s.changes_in_equity;

  const sfp = `<h3>Statement of Financial Position — as at December 31</h3>
    <table><tbody>
      ${hd('ASSETS')}${items(fp.current.assets, fp.prior.assets)}
      ${two('Total assets', fp.current.total_assets, fp.prior.total_assets)}
      ${hd('LIABILITIES')}${items(fp.current.liabilities, fp.prior.liabilities)}
      ${two('Total liabilities', fp.current.liabilities.total, fp.prior.liabilities.total)}
      ${hd('EQUITY')}${items(fp.current.equity, fp.prior.equity)}
      ${two('Retained earnings — current period', fp.current.equity.current_period_earnings, fp.prior.equity.current_period_earnings)}
      ${two('Total equity', fp.current.equity.total_with_earnings, fp.prior.equity.total_with_earnings)}
      <tr style="font-weight:700"><td>Total liabilities and equity ${fp.current.balanced ? '' : '⚠'}</td><td class="right">${m(fp.current.total_liabilities_and_equity)}</td><td class="right muted">${m(fp.prior.total_liabilities_and_equity)}</td></tr>
    </tbody></table>`;

  const sci = `<h3>Statement of Comprehensive Income — for the year ended December 31</h3>
    <table><tbody>
      ${hd('Revenue')}${items(ci.current.income, ci.prior.income)}
      ${two('Total revenue', ci.current.total_income, ci.prior.total_income)}
      ${hd('Expenses')}${items(ci.current.expense, ci.prior.expense)}
      ${two('Total expenses', ci.current.total_expense, ci.prior.total_expense)}
      <tr style="font-weight:700"><td>Net income</td><td class="right">${m(ci.current.net_income)}</td><td class="right muted">${m(ci.prior.net_income)}</td></tr>
    </tbody></table>`;

  const scf = `<h3>Statement of Cash Flows (indirect) — for the year ended December 31</h3>
    <table><tbody>
      ${hd('Operating activities')}
      ${two('Net income', cf.current.operating.net_income, cf.prior.operating.net_income)}
      ${(cf.current.operating.adjustments || []).map((x) => two(`${x.code} ${x.name}`, x.amount, (cf.prior.operating.adjustments.find((y) => y.code === x.code) || {}).amount || 0)).join('')}
      ${two('Net cash from operating activities', cf.current.operating.total, cf.prior.operating.total)}
      ${hd('Investing activities')}
      ${(cf.current.investing.items || []).map((x) => two(`${x.code} ${x.name}`, x.amount, (cf.prior.investing.items.find((y) => y.code === x.code) || {}).amount || 0)).join('') || two('—', 0, 0)}
      ${two('Net cash from investing activities', cf.current.investing.total, cf.prior.investing.total)}
      ${hd('Financing activities')}
      ${(cf.current.financing.items || []).map((x) => two(`${x.code} ${x.name}`, x.amount, (cf.prior.financing.items.find((y) => y.code === x.code) || {}).amount || 0)).join('') || two('—', 0, 0)}
      ${two('Net cash from financing activities', cf.current.financing.total, cf.prior.financing.total)}
      <tr style="font-weight:700"><td>Net change in cash ${cf.current.reconciles ? '' : '⚠'}</td><td class="right">${m(cf.current.net_change_in_cash)}</td><td class="right muted">${m(cf.prior.net_change_in_cash)}</td></tr>
      ${two('Cash at beginning of year', cf.current.cash_beginning, cf.prior.cash_beginning)}
      <tr style="font-weight:700"><td>Cash at end of year</td><td class="right">${m(cf.current.cash_ending)}</td><td class="right muted">${m(cf.prior.cash_ending)}</td></tr>
    </tbody></table>`;

  const sce = `<h3>Statement of Changes in Equity — for the year ended December 31</h3>
    <table><thead><tr><th>Account</th><th class="right">Opening</th><th class="right">Movement</th><th class="right">Closing</th></tr></thead>
    <tbody>${ce.current.rows.map((r) => `<tr><td>${e(r.code)} ${e(r.name)}</td><td class="right">${m(r.opening)}</td><td class="right">${m(r.movement)}</td><td class="right">${m(r.closing)}</td></tr>`).join('')}
      <tr><td>Net income for the year</td><td class="right"></td><td class="right">${m(ce.current.net_income_for_period)}</td><td class="right"></td></tr>
      <tr style="font-weight:700"><td>Total equity</td><td class="right">${m(ce.current.opening_equity)}</td><td class="right">${m(ce.current.movements_total + ce.current.net_income_for_period)}</td><td class="right">${m(ce.current.closing_equity)}</td></tr>
    </tbody></table>`;

  const notes = `<h3>Notes to the Financial Statements</h3>
    <ol style="font-size:12px;line-height:1.7">${d.notes.map((n) => `<li>${e(n)}</li>`).join('')}</ol>
    <p class="muted" style="font-size:11px">${e(d.disclaimer)}</p>`;

  return mode === 'print'
    ? [sfp, sci, scf, sce, notes].map((x) => `<section>${x}</section>`).join('')
    : sfp + sci + scf + sce + notes;
}

async function afsModal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'Financial Statements (AFS pack)', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <p class="muted" style="font-size:12px;margin-top:0">A draft comparative pack (this year vs last) from the general
        ledger — statement of financial position, comprehensive income, cash flows, and changes in equity, plus the
        standard PFRS-for-SMEs note headings. For the CPA to review, adjust and audit; the app does not write the
        disclosures or perform the audit.</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Fiscal year</label>
        <select id="afs-y">${[0, 1, 2, 3].map((i) => `<option>${thisYear - i}</option>`).join('')}</select>
        <button type="button" class="btn secondary small" id="afs-go">Load</button>
        <button type="button" class="btn secondary small" id="afs-print">${UI.icon('printer', 14)} Print</button>
      </div>
      <div id="afs-out" class="empty">Load a year.</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#afs-out');
      let state = null;
      const run = async () => {
        out.innerHTML = '<div class="empty">Loading…</div>';
        state = await API.get('/accounting/afs?year=' + ov.querySelector('#afs-y').value).catch((e) => { out.innerHTML = `<div class="m-error">${UI.esc(e.message)}</div>`; return null; });
        if (!state) return;
        out.innerHTML = `<div class="afs-screen">${afsStatementsHtml(state, 'screen')}</div>
          <style>.afs-screen h3{font-size:13px;margin:16px 0 4px}.afs-screen table{width:100%}.afs-screen td,.afs-screen th{padding:2px 6px}</style>`;
      };
      ov.querySelector('#afs-go').onclick = run;
      ov.querySelector('#afs-print').onclick = () => {
        if (!state) { UI.toast('Load a year first', 'error'); return; }
        const c = state.company || {};
        const w = window.open('', '_blank');
        w.document.write(`<html><head><title>Audited Financial Statements — ${state.year}</title>
          <style>body{font:12px system-ui;padding:24px;color:#111}section{page-break-after:always}section:last-child{page-break-after:auto}
          h1{font-size:18px}h3{font-size:13px;border-bottom:1px solid #111;padding-bottom:2px;margin:16px 0 6px}
          table{border-collapse:collapse;width:100%;margin-bottom:6px}th,td{border:1px solid #ccc;padding:3px 7px;text-align:left}
          .right{text-align:right}.muted{color:#666}</style></head><body>
          <section style="text-align:center;page-break-after:always"><h1>${UI.esc(c.name || 'Company')}</h1>
            ${c.tin ? `<div>TIN ${UI.esc(c.tin)}</div>` : ''}${c.address ? `<div>${UI.esc(c.address)}</div>` : ''}
            <div style="margin-top:14px;font-weight:700">AUDITED FINANCIAL STATEMENTS</div>
            <div>For the years ended December 31, ${state.year} and ${state.prior_year}</div>
            <div style="margin-top:24px;font-size:11px" class="muted">Draft prepared from the general ledger — subject to the independent auditor's review and report.</div></section>
          ${afsStatementsHtml(state, 'print')}</body></html>`);
        w.document.close(); w.focus();
        setTimeout(() => w.print(), 300);
      };
      run();
    },
  });
}

async function booksOfAccountsModal() {
  const today = new Date();
  const yStart = today.getFullYear() + '-01-01';
  UI.modal({
    title: 'Books of Accounts', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <p class="muted" style="font-size:12px;margin-top:0">The registered set a Computerized Accounting System presents
        for BIR registration — General Journal, General Ledger, Cash Receipts / Disbursements Books, Sales &amp; Purchase
        Journals — from the posted ledger. The app does not register on your behalf.</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">From</label><input id="ba-from" type="date" value="${yStart}" />
        <label style="margin:0">To</label><input id="ba-to" type="date" value="${today.toISOString().slice(0, 10)}" />
        <button type="button" class="btn secondary small" id="ba-go">Load</button>
        <button type="button" class="btn secondary small" id="ba-print">${UI.icon('printer', 14)} Print all</button>
      </div>
      <div id="ba-out" class="empty">Load a period.</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#ba-out');
      let state = null;
      const run = async () => {
        out.innerHTML = '<div class="empty">Loading…</div>';
        const from = ov.querySelector('#ba-from').value, to = ov.querySelector('#ba-to').value;
        state = await API.get(`/accounting/books-of-accounts?from=${from}&to=${to}`).catch((err) => { out.innerHTML = `<div class="m-error">${UI.esc(err.message)}</div>`; return null; });
        if (!state) return;
        const count = (b) => b.key === 'general_ledger' ? `${(b.data.accounts || []).length} account(s)`
          : `${(b.data.rows || []).length} row(s)`;
        out.innerHTML = state.books.map((b) => `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1"><b>${UI.esc(b.title)}</b> <span class="muted" style="font-size:12px">— ${count(b)}</span></div>
          ${b.csv ? `<button type="button" class="btn secondary small" data-csv="${UI.esc(b.csv)}" data-name="${b.key}">${UI.icon('download', 13)} CSV</button>` : '<span class="muted" style="font-size:11px">CSV via Books tab</span>'}
        </div>`).join('') + `<p class="muted" style="font-size:11px;margin-top:10px">${UI.esc(state.note)}</p>`;
        out.querySelectorAll('[data-csv]').forEach((btn) => btn.onclick = () =>
          API.download(btn.dataset.csv.replace('/api/accounting', '/accounting'), `${btn.dataset.name}-${from}_${to}.csv`));
      };
      ov.querySelector('#ba-go').onclick = run;
      ov.querySelector('#ba-print').onclick = () => {
        if (!state) { UI.toast('Load a period first', 'error'); return; }
        const c = state.company || {};
        const head = `<div style="text-align:center;margin-bottom:8px">
          <div style="font-weight:700;font-size:15px">${UI.esc(c.name || 'Company')}</div>
          ${c.tin ? `<div>TIN ${UI.esc(c.tin)}</div>` : ''}${c.address ? `<div style="font-size:12px">${UI.esc(c.address)}</div>` : ''}
          <div style="margin-top:6px;font-weight:700">BOOKS OF ACCOUNTS</div>
          <div style="font-size:12px">${UI.esc(state.from)} to ${UI.esc(state.to)}</div></div>`;
        const body = state.books.map((b) => `<h2 style="page-break-before:always">${UI.esc(b.title)}</h2>${boaBookHtml(b)}`).join('');
        const w = window.open('', '_blank');
        w.document.write(`<html><head><title>Books of Accounts — ${UI.esc(state.from)} to ${UI.esc(state.to)}</title>
          <style>body{font:12px system-ui;padding:20px;color:#111}h2{font-size:14px;border-bottom:2px solid #111;padding-bottom:2px;margin:18px 0 6px}h2:first-of-type{page-break-before:auto}h4{margin:10px 0 3px;font-size:12px}
          table{border-collapse:collapse;width:100%;margin-bottom:6px}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}
          .right{text-align:right}.mono{font-family:ui-monospace,monospace}.muted{color:#666}tfoot th{border-top:2px solid #111}</style></head>
          <body>${head}${body}</body></html>`);
        w.document.close(); w.focus();
        setTimeout(() => w.print(), 300);
      };
      run();
    },
  });
}

async function bir2307Modal() {
  let suppliers = [];
  try { suppliers = await API.get('/suppliers'); } catch { /* */ }
  const today = new Date();
  const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
  UI.modal({
    title: 'BIR Form 2307', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Supplier</label>
        <select id="c-sup" style="min-width:200px"><option value="">— pick —</option>${suppliers.map((s) => `<option value="${s.id}">${UI.esc(s.name)}</option>`).join('')}</select>
        <label style="margin:0">From</label><input id="c-from" type="date" value="${qStart}" />
        <label style="margin:0">To</label><input id="c-to" type="date" value="${today.toISOString().slice(0, 10)}" />
        <button type="button" class="btn secondary small" id="c-go">Show</button>
        <button type="button" class="btn secondary small" id="c-print">${UI.icon('printer', 14)} Print</button>
      </div>
      <div id="c-out" class="muted">Pick a supplier and period.</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#c-out');
      const run = async () => {
        const sid = ov.querySelector('#c-sup').value;
        if (!sid) { out.innerHTML = '<div class="muted">Pick a supplier.</div>'; return; }
        const d = await API.get(`/accounting/bir-2307?supplier_id=${sid}&from=${ov.querySelector('#c-from').value}&to=${ov.querySelector('#c-to').value}`);
        out.innerHTML = `
          <div style="border:1px solid var(--border-strong);border-radius:8px;padding:16px" id="c-cert">
            <div style="text-align:center;font-weight:700;margin-bottom:10px">CERTIFICATE OF CREDITABLE TAX WITHHELD AT SOURCE<br><span style="font-weight:400;font-size:12px">BIR Form 2307 — ${UI.esc(d.from)} to ${UI.esc(d.to)}</span></div>
            <div class="kv">
              <div><span class="muted">Payor</span><div>${UI.esc(d.company.name || '—')}${d.company.tin ? ' · TIN ' + UI.esc(d.company.tin) : ''}</div></div>
              <div><span class="muted">Payee</span><div>${UI.esc(d.payee.name)}${d.payee.tin ? ' · TIN ' + UI.esc(d.payee.tin) : ''}</div></div>
              ${d.payee.address ? `<div><span class="muted">Payee address</span><div>${UI.esc(d.payee.address)}</div></div>` : ''}
            </div>
            <table class="line-table" style="margin-top:10px"><thead><tr><th>Month</th><th>ATC</th><th class="right">Income payment</th><th class="right">Tax withheld</th></tr></thead>
              <tbody>${d.lines.map((l) => `<tr><td>${UI.esc(l.month)}</td><td class="mono">${UI.esc(l.atc)}</td><td class="right">${accPeso(l.base)}</td><td class="right">${accPeso(l.tax)}</td></tr>`).join('')
                || `<tr><td colspan="4" class="muted" style="text-align:center;padding:12px">No withholding for this supplier in the period.</td></tr>`}</tbody>
              <tfoot><tr><th colspan="2">Totals</th><th class="right">${accPeso(d.total_base)}</th><th class="right">${accPeso(d.total_tax)}</th></tr></tfoot>
            </table>
            <p class="muted" style="font-size:11px;margin:10px 0 0">${UI.esc(d.note || '')}</p>
          </div>`;
      };
      ov.querySelector('#c-go').onclick = run;
      ov.querySelector('#c-sup').onchange = run;
      ov.querySelector('#c-print').onclick = () => {
        const el = ov.querySelector('#c-cert');
        if (!el) { UI.toast('Show a certificate first', 'error'); return; }
        const w = window.open('', '_blank');
        w.document.write(`<html><head><title>BIR 2307</title><style>body{font:13px system-ui;padding:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 8px;text-align:left}td:last-child,th:last-child,td:nth-child(3),th:nth-child(3){text-align:right}</style></head><body>${el.innerHTML}</body></html>`);
        w.document.close(); w.focus(); w.print();
      };
    },
  });
}

/* ── quarter picker helper ──────────────────────────────────────────────── */
function accQuarterOptions(back = 8) {
  const now = new Date();
  const opts = [];
  let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
  for (let i = 0; i < back; i++) {
    opts.push(`${y}-Q${q}`);
    q -= 1; if (q === 0) { q = 4; y -= 1; }
  }
  return opts;
}

/* ── BIR 1601-EQ + QAP — quarterly EWT return + alphalist of payees ──────── */
async function bir1601eqModal() {
  const quarters = accQuarterOptions();
  UI.modal({
    title: 'BIR 1601-EQ + QAP', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Quarter</label>
        <select id="eq-q">${quarters.map((q) => `<option value="${q}">${q}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="eq-qap-csv">${UI.icon('download', 14)} QAP CSV</button>
        <button type="button" class="btn secondary small" id="eq-qap-dat">QAP .DAT</button>
      </div>
      <div id="eq-out" class="empty">Loading…</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#eq-out');
      const run = async () => {
        const q = ov.querySelector('#eq-q').value;
        const [face, qap] = await Promise.all([
          API.get('/accounting/bir-1601eq?quarter=' + q),
          API.get('/accounting/qap?quarter=' + q),
        ]);
        out.innerHTML = `
          <table class="line-table"><thead><tr><th>Month</th><th class="right">Tax base</th><th class="right">Withheld</th><th class="right">Remitted</th><th class="right">Still due</th></tr></thead>
            <tbody>${face.monthly.map((m) => `<tr><td>${UI.esc(m.month)}</td><td class="right">${accPeso(m.tax_base)}</td><td class="right">${accPeso(m.tax_withheld)}</td><td class="right">${accPeso(m.remitted)}</td><td class="right">${accPeso(m.still_due)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><th>Quarter</th><th class="right">${accPeso(face.total_tax_base)}</th><th class="right">${accPeso(face.total_tax_withheld)}</th><th class="right">${accPeso(face.total_remitted)}</th><th class="right">${accPeso(face.still_due)}</th></tr></tfoot>
          </table>
          <p class="muted" style="font-size:12px">${UI.esc(face.note)}</p>
          <h4 style="margin:14px 0 6px">Quarterly Alphalist of Payees — ${qap.rows.length} line(s)</h4>
          <table class="line-table"><thead><tr><th>TIN</th><th>Payee</th><th>ATC</th><th class="right">Tax base</th><th class="right">Rate</th><th class="right">Withheld</th></tr></thead>
            <tbody>${qap.rows.map((r) => `<tr><td class="mono">${UI.esc(r.tin || '—')}</td><td>${UI.esc(r.name || '—')}</td><td class="mono">${UI.esc(r.atc)}</td>
              <td class="right">${accPeso(r.base)}</td><td class="right">${(r.rate || 0).toFixed(2)}%</td><td class="right">${accPeso(r.tax)}</td></tr>`).join('')
              || `<tr><td colspan="6" class="muted" style="text-align:center;padding:12px">No withholding this quarter.</td></tr>`}</tbody>
            <tfoot><tr><th colspan="3">Totals</th><th class="right">${accPeso(qap.total_base)}</th><th></th><th class="right">${accPeso(qap.total_tax)}</th></tr></tfoot>
          </table>`;
      };
      const dl = (fmt) => {
        const q = ov.querySelector('#eq-q').value;
        API.download(`/accounting/qap?format=${fmt}&quarter=${q}`, `QAP-${q.replace('-', '')}.${fmt}`);
      };
      ov.querySelector('#eq-q').onchange = run;
      ov.querySelector('#eq-qap-csv').onclick = () => dl('csv');
      ov.querySelector('#eq-qap-dat').onclick = () => dl('dat');
      run();
    },
  });
}

/* ── BIR 1604-E — annual info return + alphalist ─────────────────────────── */
async function bir1604eModal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR 1604-E', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Year</label>
        <select id="ae-y">${[0, 1, 2, 3].map((i) => `<option>${thisYear - i}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="ae-csv">${UI.icon('download', 14)} Alphalist CSV</button>
        <button type="button" class="btn secondary small" id="ae-dat">.DAT</button>
      </div>
      <div id="ae-out" class="empty">Loading…</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#ae-out');
      const run = async () => {
        const d = await API.get('/accounting/bir-1604e?year=' + ov.querySelector('#ae-y').value);
        out.innerHTML = `
          <p class="muted" style="font-size:12px">${UI.esc(d.note)}</p>
          <table class="line-table"><thead><tr><th>TIN</th><th>Payee</th><th>ATC</th><th class="right">Income payment</th><th class="right">Rate</th><th class="right">Tax withheld</th></tr></thead>
            <tbody>${d.rows.map((r) => `<tr><td class="mono">${UI.esc(r.tin || '—')}</td><td>${UI.esc(r.name || '—')}</td><td class="mono">${UI.esc(r.atc)}</td>
              <td class="right">${accPeso(r.base)}</td><td class="right">${(r.rate || 0).toFixed(2)}%</td><td class="right">${accPeso(r.tax)}</td></tr>`).join('')
              || `<tr><td colspan="6" class="muted" style="text-align:center;padding:12px">No withholding this year.</td></tr>`}</tbody>
            <tfoot><tr><th colspan="3">Totals</th><th class="right">${accPeso(d.total_base)}</th><th></th><th class="right">${accPeso(d.total_tax)}</th></tr></tfoot>
          </table>`;
      };
      const dl = (fmt) => {
        const y = ov.querySelector('#ae-y').value;
        API.download(`/accounting/bir-1604e?format=${fmt}&year=${y}`, `1604E-alphalist-${y}.${fmt}`);
      };
      ov.querySelector('#ae-y').onchange = run;
      ov.querySelector('#ae-csv').onclick = () => dl('csv');
      ov.querySelector('#ae-dat').onclick = () => dl('dat');
      run();
    },
  });
}

/* ── SLSP — Summary List of Sales / Purchases ───────────────────────────── */
async function slspModal() {
  const quarters = accQuarterOptions();
  UI.modal({
    title: 'Summary List of Sales / Purchases (SLSP)', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select id="sl-kind"><option value="sales">Sales (SLS)</option><option value="purchases">Purchases (SLP)</option></select>
        <label style="margin:0">Quarter</label>
        <select id="sl-q">${quarters.map((q) => `<option value="${q}">${q}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="sl-csv">${UI.icon('download', 14)} CSV</button>
        <button type="button" class="btn secondary small" id="sl-dat">.DAT</button>
      </div>
      <div id="sl-out" class="empty">Loading…</div>`,
    onOpen: (ov) => {
      const out = ov.querySelector('#sl-out');
      const run = async () => {
        const kind = ov.querySelector('#sl-kind').value, q = ov.querySelector('#sl-q').value;
        const d = await API.get(`/accounting/slsp?kind=${kind}&quarter=${q}`);
        const t = d.totals;
        out.innerHTML = `
          <div style="overflow-x:auto"><table class="line-table"><thead><tr><th>TIN</th><th>Name</th><th>Address</th>
            <th class="right">Gross</th><th class="right">Exempt</th><th class="right">Zero-rated</th><th class="right">Taxable</th><th class="right">VAT</th></tr></thead>
            <tbody>${d.rows.map((r) => `<tr><td class="mono">${UI.esc(r.tin || '—')}</td><td>${UI.esc(r.name || '—')}</td><td class="muted">${UI.esc(r.address || '—')}</td>
              <td class="right">${accPeso(r.cols.gross)}</td><td class="right">${accPeso(r.cols.exempt)}</td><td class="right">${accPeso(r.cols.zero_rated)}</td>
              <td class="right">${accPeso(r.cols.vatable)}</td><td class="right">${accPeso(r.cols.vat)}</td></tr>`).join('')
              || `<tr><td colspan="8" class="muted" style="text-align:center;padding:12px">Nothing in this quarter.</td></tr>`}</tbody>
            <tfoot><tr><th colspan="3">Totals</th><th class="right">${accPeso(t.gross)}</th><th class="right">${accPeso(t.exempt)}</th><th class="right">${accPeso(t.zero_rated)}</th><th class="right">${accPeso(t.vatable)}</th><th class="right">${accPeso(t.vat)}</th></tr></tfoot>
          </table></div>
          <p class="muted" style="font-size:11px">Attach the relevant list to the quarterly 2550Q. The .DAT is a pipe-delimited layout to load into BIR's RELIEF / Alphalist tool.</p>`;
      };
      const dl = (fmt) => {
        const kind = ov.querySelector('#sl-kind').value, q = ov.querySelector('#sl-q').value;
        API.download(`/accounting/slsp?kind=${kind}&quarter=${q}&format=${fmt}`, `SL${kind === 'sales' ? 'S' : 'P'}-${q.replace('-', '')}.${fmt}`);
      };
      ov.querySelector('#sl-kind').onchange = run;
      ov.querySelector('#sl-q').onchange = run;
      ov.querySelector('#sl-csv').onclick = () => dl('csv');
      ov.querySelector('#sl-dat').onclick = () => dl('dat');
      run();
    },
  });
}

/* ── BIR 1601-C — monthly withholding on compensation ────────────────────── */
async function bir1601cModal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR Form 1601-C — monthly withholding', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="c16-year">${[thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="c16-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Monthly Remittance Return of Income Taxes Withheld on
        Compensation. Each month's <b>Tax Withheld</b> is what you remit; the 12 months reconcile to the annual
        1604-C. Non-taxable here is the statutory employee shares only — 13th-month pay isn't a payslip line.</p>
      <div id="c16-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#c16-year');
      let state = { months: [], totals: {}, year: '' };
      async function load() {
        ov.querySelector('#c16-body').innerHTML = '<div class="empty">Loading…</div>';
        state = await API.get('/accounting/bir-1601c?year=' + yearSel.value).catch(() => ({ months: [], totals: {}, year: yearSel.value }));
        const b = ov.querySelector('#c16-body');
        if (!state.months.some((m) => m.employee_count || m.gross_compensation)) {
          b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return;
        }
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>Month</th><th class="right">Employees</th><th class="right">Gross compensation</th>
            <th class="right">Non-taxable</th><th class="right">Taxable</th><th class="right">Tax withheld</th>
          </tr></thead><tbody>${state.months.map((m) => `
            <tr><td>${ACC_MONTHS[m.month - 1]}</td>
              <td class="right">${m.employee_count || ''}</td>
              <td class="right">${m.gross_compensation ? accPeso(m.gross_compensation) : ''}</td>
              <td class="right">${m.non_taxable ? accPeso(m.non_taxable) : ''}</td>
              <td class="right">${m.taxable_compensation ? accPeso(m.taxable_compensation) : ''}</td>
              <td class="right"><strong>${m.tax_withheld ? accPeso(m.tax_withheld) : ''}</strong></td></tr>`).join('')}</tbody>
          <tfoot><tr><th>Year total</th><th></th>
            <th class="right">${accPeso(state.totals.gross_compensation)}</th>
            <th class="right">${accPeso(state.totals.non_taxable)}</th>
            <th class="right">${accPeso(state.totals.taxable_compensation)}</th>
            <th class="right">${accPeso(state.totals.tax_withheld)}</th></tr></tfoot></table>`;
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#c16-csv').onclick = () => {
        if (!state.months.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`bir-1601c-${state.year}.csv`,
          ['Month', 'Employees', 'Gross compensation', 'Non-taxable', 'Taxable compensation', 'Tax withheld'],
          [...state.months.map((m) => [ACC_MONTHS[m.month - 1], m.employee_count, m.gross_compensation, m.non_taxable, m.taxable_compensation, m.tax_withheld]),
           ['Year total', '', state.totals.gross_compensation, state.totals.non_taxable, state.totals.taxable_compensation, state.totals.tax_withheld]]);
      };
      load();
    },
  });
}

/* ── BIR 1604-C — annual return face + reconciliation ────────────────────── */
async function bir1604cModal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR Form 1604-C — annual return', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="a4-year">${[thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="a4-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Annual Information Return of Income Taxes Withheld on
        Compensation. The monthly schedule is what you filed on the 1601-Cs; the reconciliation compares total
        remitted against the year-end tax due per the Alphalist. Clear any <b>under-remittance</b> before filing.</p>
      <div id="a4-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#a4-year');
      let state = { months: [], totals: {}, reconciliation: {}, year: '' };
      async function load() {
        ov.querySelector('#a4-body').innerHTML = '<div class="empty">Loading…</div>';
        state = await API.get('/accounting/bir-1604c?year=' + yearSel.value).catch(() => ({ months: [], totals: {}, reconciliation: {}, year: yearSel.value }));
        const b = ov.querySelector('#a4-body');
        if (!state.months.some((m) => m.employee_count || m.gross_compensation)) {
          b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return;
        }
        const rc = state.reconciliation || {};
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>Month</th><th class="right">Employees</th><th class="right">Gross</th>
            <th class="right">Non-taxable</th><th class="right">Taxable</th><th class="right">Tax withheld</th>
          </tr></thead><tbody>${state.months.map((m) => `
            <tr><td>${ACC_MONTHS[m.month - 1]}</td>
              <td class="right">${m.employee_count || ''}</td>
              <td class="right">${m.gross_compensation ? accPeso(m.gross_compensation) : ''}</td>
              <td class="right">${m.non_taxable ? accPeso(m.non_taxable) : ''}</td>
              <td class="right">${m.taxable_compensation ? accPeso(m.taxable_compensation) : ''}</td>
              <td class="right"><strong>${m.tax_withheld ? accPeso(m.tax_withheld) : ''}</strong></td></tr>`).join('')}</tbody>
          <tfoot><tr><th>Year total</th><th></th>
            <th class="right">${accPeso(state.totals.gross_compensation)}</th>
            <th class="right">${accPeso(state.totals.non_taxable)}</th>
            <th class="right">${accPeso(state.totals.taxable_compensation)}</th>
            <th class="right">${accPeso(state.totals.tax_withheld)}</th></tr></tfoot></table>
          <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Reconciliation</h4>
          <table class="line-table"><tbody>
            <tr><td>Tax remitted per 1601-C returns</td><td class="right">${accPeso(rc.tax_remitted_per_1601c)}</td></tr>
            <tr><td>Tax withheld per Alphalist</td><td class="right">${accPeso(rc.tax_withheld_per_alphalist)}</td></tr>
            <tr><td>Tax due per Alphalist (annualised)</td><td class="right">${accPeso(rc.tax_due_per_alphalist)}</td></tr>
            <tr><td><b>Over-remittance</b></td><td class="right"><b>${accPeso(rc.over_remittance)}</b></td></tr>
            <tr><td><b>Under-remittance</b></td><td class="right" style="color:${rc.under_remittance ? 'var(--danger)' : ''}"><b>${accPeso(rc.under_remittance)}</b></td></tr>
          </tbody></table>`;
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#a4-csv').onclick = () => {
        if (!state.months.length) { UI.toast('Nothing to export', 'error'); return; }
        const rc = state.reconciliation || {};
        UI.downloadCsv(`bir-1604c-${state.year}.csv`,
          ['Month', 'Employees', 'Gross', 'Non-taxable', 'Taxable', 'Tax withheld'],
          [...state.months.map((m) => [ACC_MONTHS[m.month - 1], m.employee_count, m.gross_compensation, m.non_taxable, m.taxable_compensation, m.tax_withheld]),
           ['Year total', '', state.totals.gross_compensation, state.totals.non_taxable, state.totals.taxable_compensation, state.totals.tax_withheld],
           [], ['Tax remitted per 1601-C', '', '', '', '', rc.tax_remitted_per_1601c],
           ['Tax due per Alphalist', '', '', '', '', rc.tax_due_per_alphalist],
           ['Under-remittance', '', '', '', '', rc.under_remittance]]);
      };
      load();
    },
  });
}

/* ── BIR 1604-C Alphalist (Schedule 1) ──────────────────────────────────── */
async function birAlphalistModal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR 1604-C Alphalist (Schedule 1)', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="al-year">${[thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="al-csv">${UI.icon('download', 14)} Export CSV (BIR layout)</button>
      </div>
      <div id="al-note" class="muted" style="font-size:12px;margin-top:0"></div>
      <div id="al-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#al-year');
      let state = { headers: [], rows: [], cells: [], note: '', year: '' };
      async function load() {
        ov.querySelector('#al-body').innerHTML = '<div class="empty">Loading…</div>';
        state = await API.get('/accounting/bir-alphalist?year=' + yearSel.value).catch(() => ({ headers: [], rows: [], cells: [], note: '', year: yearSel.value }));
        ov.querySelector('#al-note').textContent = state.note || '';
        const b = ov.querySelector('#al-body');
        if (!state.rows.length) { b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return; }
        b.innerHTML = `<p class="muted" style="font-size:12px">${state.rows.length} employee(s). The CSV has all
            ${state.headers.length} BIR Schedule-1 columns — this is a summary preview.</p>
          <div style="overflow:auto"><table class="line-table"><thead><tr>
            <th>#</th><th>Name</th><th>TIN</th><th class="right">Gross</th><th class="right">Non-taxable</th>
            <th class="right">Taxable</th><th class="right">Tax due</th><th class="right">Withheld (adj.)</th><th>Subst.</th>
          </tr></thead><tbody>${state.rows.map((r) => `
            <tr><td>${r.seq}</td>
              <td>${UI.esc([r.last_name, r.first_name, r.middle_name].filter(Boolean).join(', '))}</td>
              <td>${UI.esc(r.tin || '—')}</td>
              <td class="right">${accPeso(r.gross_compensation)}</td>
              <td class="right">${accPeso(r.nt_total)}</td>
              <td class="right">${accPeso(r.total_taxable_present_prev)}</td>
              <td class="right">${accPeso(r.tax_due)}</td>
              <td class="right">${accPeso(r.tax_withheld_adjusted)}</td>
              <td>${r.substituted_filing}</td></tr>`).join('')}</tbody></table></div>`;
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#al-csv').onclick = () => {
        if (!state.cells.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`bir-1604c-alphalist-schedule1-${state.year}.csv`, state.headers, state.cells);
      };
      load();
    },
  });
}

/* ── BIR 2316 — year-end certificate, per employee ──────────────────────── */
async function bir2316Modal() {
  const thisYear = new Date().getFullYear();
  UI.modal({
    title: 'BIR Form 2316', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label style="margin:0">Year</label>
        <select id="b16-year">${[thisYear, thisYear - 1, thisYear - 2].map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="b16-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Year-end Certificate of Compensation Payment / Tax Withheld,
        computed from the payslips generated for the year + the annual tax table. <b>Worksheet only</b> — de-minimis,
        allowances and previous-employer amounts aren't tracked; complete against the official BIR form before issuing.</p>
      <div id="b16-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      const yearSel = ov.querySelector('#b16-year');
      let state = { rows: [], company: {}, year: '' };
      let templates = [];
      async function load() {
        ov.querySelector('#b16-body').innerHTML = '<div class="empty">Loading…</div>';
        [state, templates] = await Promise.all([
          API.get('/accounting/bir-2316?year=' + yearSel.value).catch(() => ({ rows: [], company: {}, year: yearSel.value })),
          templates.length ? Promise.resolve(templates) : API.get('/templates').catch(() => []),
        ]);
        const b = ov.querySelector('#b16-body');
        if (!state.rows.length) { b.innerHTML = '<div class="empty">No payslips found for ' + UI.esc(yearSel.value) + '.</div>'; return; }
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>Employee</th><th class="right">Gross comp.</th><th class="right">Taxable</th>
            <th class="right">Tax due</th><th class="right">Withheld</th><th class="right">Over / (under)</th><th></th>
          </tr></thead><tbody>${state.rows.map((r, i) => `
            <tr><td>${UI.esc(r.employee_name)}</td>
              <td class="right">${accPeso(r.figures.gross_compensation)}</td>
              <td class="right">${accPeso(r.figures.gross_taxable_compensation)}</td>
              <td class="right">${accPeso(r.figures.tax_due)}</td>
              <td class="right">${accPeso(r.figures.total_tax_withheld)}</td>
              <td class="right">${accPeso(r.figures.over_withheld)}</td>
              <td class="right"><button type="button" class="btn secondary small" data-print="${i}" ${r.employee_id ? '' : 'disabled title="No matching employee record"'}>${UI.icon('printer', 13)} Print</button></td>
            </tr>`).join('')}</tbody></table>`;
        b.querySelectorAll('[data-print]').forEach((btn) => btn.onclick = () => printOne(state.rows[Number(btn.dataset.print)]));
      }
      async function printOne(row) {
        try {
          const detail = await API.get(`/accounting/bir-2316/${row.employee_id}?year=${yearSel.value}`);
          const meta = templates.find((t) => t.name === 'BIR 2316');
          if (!meta) { UI.toast('BIR 2316 template not found (Documents → Templates)', 'error'); return; }
          const tpl = await API.get('/templates/' + meta.id);
          const tplBody = tpl.body;
          const g = detail.figures;
          const f = {};
          Object.keys(g).forEach((k) => { f[k] = typeof g[k] === 'number' ? accPeso(g[k]) : g[k]; });
          f.payslip_count = g.payslip_count;
          f.thirteenth_month_ceiling = accPeso(g.thirteenth_month_ceiling);
          f.over_withheld_label = g.over_withheld >= 0 ? 'OVER-WITHHELD (refund to employee)' : 'TAX STILL DUE FROM EMPLOYEE';
          f.over_withheld_abs = accPeso(Math.abs(g.over_withheld));
          const ctx = { company: detail.company || {}, employee: detail.employee || {}, f, year: detail.year, today: new Date().toLocaleDateString() };
          // Same opt-in Print Grid tiling as form-linked templates (public/js/print-tiling.js) —
          // e.g. 2 copies of the 2316 (one for BIR filing, one for the employee's file).
          const tiled = typeof buildTiledPagesHtml === 'function'
            ? buildTiledPagesHtml([detail], () => renderTemplate(tplBody, ctx), {
              copiesPerRecord: tpl.copies_per_record, recordsPerPage: tpl.records_per_page, tileFill: tpl.tile_fill,
              continuous: !!tpl.tile_continuous, repeatCount: tpl.repeat_count,
              pageContentHeightMm: typeof pageContentHeightMm === 'function' ? pageContentHeightMm(tplBody) : undefined,
            })
            : '';
          const full = UI.printableHtml(tiled || renderTemplate(tplBody, ctx), '2316 - ' + (detail.employee.name || ''));
          UI.modal({
            title: `BIR 2316 — ${detail.employee.name || ''}`, size: 'lg', cancelText: 'Close', confirmText: 'Print…',
            bodyHTML: `<iframe id="b16-frame" style="width:100%;height:56vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
            onOpen: (o2) => {
              const ifr = o2.querySelector('#b16-frame');
              if (tiled) ifr.onload = () => { if (typeof fitTiledCells === 'function') fitTiledCells(ifr.contentDocument); };
              ifr.srcdoc = full;
            },
            onConfirm: (o2) => { const ifr = o2.querySelector('#b16-frame'); ifr.contentWindow.focus(); ifr.contentWindow.print(); return false; },
          });
        } catch (e) { UI.toast(e.message, 'error'); }
      }
      yearSel.addEventListener('change', load);
      ov.querySelector('#b16-csv').onclick = () => {
        if (!state.rows.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`bir-2316-${state.year}.csv`,
          ['Employee', 'TIN', 'Gross compensation', 'Total non-taxable', 'Gross taxable', 'Tax due', 'Tax withheld', 'Over/(under) withheld'],
          state.rows.map((r) => [r.employee_name, r.tin_no || '', r.figures.gross_compensation, r.figures.total_non_taxable,
            r.figures.gross_taxable_compensation, r.figures.tax_due, r.figures.total_tax_withheld, r.figures.over_withheld]));
      };
      load();
    },
  });
}

/* ── SSS R-3 / PhilHealth RF-1 / Pag-IBIG MCRF — monthly contribution schedule ── */
async function contributionScheduleModal() {
  const AGENCIES = { sss: 'SSS (R-3)', philhealth: 'PhilHealth (RF-1 / EPRS)', pagibig: 'Pag-IBIG (MCRF / eSRS)' };
  UI.modal({
    title: 'Monthly contribution schedule', size: 'lg', cancelText: 'Close', confirmText: null,
    bodyHTML: `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <label style="margin:0">Month</label><input id="cs-month" type="month" value="${new Date().toISOString().slice(0, 7)}" />
        <label style="margin:0">Agency</label>
        <select id="cs-agency">${Object.entries(AGENCIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <div class="grow"></div>
        <button type="button" class="btn secondary small" id="cs-csv">${UI.icon('download', 14)} Export CSV</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:0">Employee + employer shares recomputed from the effective
        rate tables on each person's total compensation for the month. Upload in the agency's own portal
        (SSS ELRS, PhilHealth EPRS, Pag-IBIG eSRS) — there is no direct filing API.</p>
      <div id="cs-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      let state = null;
      async function load() {
        ov.querySelector('#cs-body').innerHTML = '<div class="empty">Loading…</div>';
        const month = ov.querySelector('#cs-month').value;
        const agency = ov.querySelector('#cs-agency').value;
        state = await API.get(`/accounting/contribution-schedule?month=${month}&agency=${agency}`).catch(() => null);
        const b = ov.querySelector('#cs-body');
        if (!state || !state.rows.length) { b.innerHTML = '<div class="empty">No payslips for that month.</div>'; return; }
        const isSss = agency === 'sss';
        b.innerHTML = `<table class="line-table"><thead><tr>
            <th>${UI.esc(state.id_label)}</th><th>Name</th><th class="right">Basis</th>
            <th class="right">EE</th><th class="right">ER</th>${isSss ? '<th class="right">EC</th>' : ''}<th class="right">Total</th>
          </tr></thead><tbody>${state.rows.map((r) => `
            <tr><td class="mono">${UI.esc(r.id_number || '—')}</td><td>${UI.esc(r.name)}</td>
              <td class="right">${accPeso(r.basis)}</td><td class="right">${accPeso(r.employee)}</td>
              <td class="right">${accPeso(r.employer)}</td>${isSss ? `<td class="right">${accPeso(r.ec || 0)}</td>` : ''}
              <td class="right"><strong>${accPeso(r.total)}</strong></td></tr>`).join('')}</tbody>
          <tfoot><tr><th colspan="2">Total (${state.rows.length})</th>
            <th></th><th class="right">${accPeso(state.totals.employee)}</th>
            <th class="right">${accPeso(state.totals.employer)}</th>${isSss ? `<th class="right">${accPeso(state.totals.ec)}</th>` : ''}
            <th class="right">${accPeso(state.totals.grand)}</th></tr></tfoot></table>`;
      }
      ov.querySelector('#cs-month').addEventListener('change', load);
      ov.querySelector('#cs-agency').addEventListener('change', load);
      ov.querySelector('#cs-csv').onclick = () => {
        if (!state || !state.rows.length) { UI.toast('Nothing to export', 'error'); return; }
        UI.downloadCsv(`${ov.querySelector('#cs-agency').value}-schedule-${ov.querySelector('#cs-month').value}.csv`,
          state.headers, state.cells);
      };
      load();
    },
  });
}
