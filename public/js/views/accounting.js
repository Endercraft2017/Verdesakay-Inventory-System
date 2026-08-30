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
      ['sheet', 'BIR 2550M', 'Monthly VAT — output VAT (sales) less input VAT (purchases).', bir2550mModal],
    ]],
    ['Expanded withholding (suppliers)', [
      ['sheet', 'BIR 0619-E', 'Monthly remittance of expanded / creditable withholding tax, per ATC.', bir0619eModal],
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
    ['Cash', [
      ['sheet', 'Petty cash', 'Named cash funds with a running money-in / money-out register.', () => App.navigate('accounting-petty-cash')],
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

/* ── BIR 2550M — monthly VAT declaration ─────────────────────────────────── */
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
      <p class="muted" style="font-size:12px;margin-top:0">Output VAT from the month's sale orders, input VAT from
        approved vendor bills (each document's own tax amount, else a 12% derivation). Adjust for exempt / zero-rated
        sales and disallowed input before filing. Deadline: the 20th of the following month.</p>
      <div id="v-body"><div class="empty">Loading…</div></div>`,
    onOpen: (ov) => {
      let state = null;
      async function load() {
        ov.querySelector('#v-body').innerHTML = '<div class="empty">Loading…</div>';
        const p = new URLSearchParams({
          month: ov.querySelector('#v-month').value,
          vat_inclusive: ov.querySelector('#v-incl').checked ? '1' : '0',
          input_vat_carry_over: ov.querySelector('#v-carry').value || 0,
          vat_payments: ov.querySelector('#v-paid').value || 0,
        });
        state = await API.get('/accounting/bir-2550m?' + p.toString()).catch(() => null);
        const b = ov.querySelector('#v-body');
        if (!state) { b.innerHTML = '<div class="m-error">Could not load.</div>'; return; }
        const w = state.worksheet;
        b.innerHTML = `<table class="line-table"><tbody>
            <tr><td>Vatable sales / receipts</td><td class="right">${accPeso(w.vatable_sales)}</td></tr>
            <tr><th>Output VAT</th><th class="right">${accPeso(w.output_vat)}</th></tr>
            <tr><td>Vatable purchases</td><td class="right">${accPeso(w.vatable_purchases)}</td></tr>
            <tr><td>Input VAT — current</td><td class="right">${accPeso(w.input_vat_current)}</td></tr>
            <tr><td>Input VAT — carried over</td><td class="right">${accPeso(w.input_vat_carry_over)}</td></tr>
            <tr><th>Total available input VAT</th><th class="right">${accPeso(w.total_available_input_vat)}</th></tr>
            <tr><td>Net VAT payable</td><td class="right">${accPeso(w.net_vat_payable)}</td></tr>
            <tr><td>Less: VAT paid / withheld</td><td class="right">${accPeso(w.vat_payments)}</td></tr>
            <tr><th>Still payable</th><th class="right" style="color:${w.still_payable ? 'var(--danger)' : ''}">${accPeso(w.still_payable)}</th></tr>
            <tr><td>Excess input VAT (carry forward)</td><td class="right">${accPeso(w.excess_input_vat)}</td></tr>
          </tbody></table>
          <p class="muted" style="font-size:11px;margin-top:8px">Sources — sales ${accPeso(state.sources.gross_sales)}, purchases ${accPeso(state.sources.gross_purchases)}.</p>
          ${w.notes.length ? `<ul class="muted" style="font-size:12px;margin:8px 0 0;padding-left:18px">${w.notes.map((n) => `<li>${UI.esc(n)}</li>`).join('')}</ul>` : ''}`;
      }
      ['#v-month', '#v-incl', '#v-carry', '#v-paid'].forEach((s) => ov.querySelector(s).addEventListener('change', load));
      load();
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
          const tplBody = (await API.get('/templates/' + meta.id)).body;
          const g = detail.figures;
          const f = {};
          Object.keys(g).forEach((k) => { f[k] = typeof g[k] === 'number' ? accPeso(g[k]) : g[k]; });
          f.payslip_count = g.payslip_count;
          f.thirteenth_month_ceiling = accPeso(g.thirteenth_month_ceiling);
          f.over_withheld_label = g.over_withheld >= 0 ? 'OVER-WITHHELD (refund to employee)' : 'TAX STILL DUE FROM EMPLOYEE';
          f.over_withheld_abs = accPeso(Math.abs(g.over_withheld));
          const ctx = { company: detail.company || {}, employee: detail.employee || {}, f, year: detail.year, today: new Date().toLocaleDateString() };
          const full = UI.printableHtml(renderTemplate(tplBody, ctx), '2316 - ' + (detail.employee.name || ''));
          UI.modal({
            title: `BIR 2316 — ${detail.employee.name || ''}`, size: 'lg', cancelText: 'Close', confirmText: 'Print…',
            bodyHTML: `<iframe id="b16-frame" style="width:100%;height:56vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
            onOpen: (o2) => { o2.querySelector('#b16-frame').srcdoc = full; },
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
