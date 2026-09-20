/* Accounting → Receivables & Payables (Phase 1b): AR / AP aging, customer receipts &
   supplier payments, and a per-party statement. Sits on top of the general ledger. */
App.register('accounting-receivables', async (view, filter) => {
  const money = UI.money;
  const canManage = App.hasPermission('accounting.manage');

  let settings;
  try { settings = await API.get('/accounting/ledger/settings'); }
  catch (e) { view.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
  if (!settings.enabled) {
    view.innerHTML = `<div class="topbar"><h2>Receivables &amp; Payables</h2></div>
      <div class="panel"><p class="muted">Set up the general ledger first — Accounting → General Ledger → Books.</p></div>`;
    return;
  }

  const tabs = ['Receivables', 'Payables', 'Payments', 'Credit Notes', 'Statement'];
  let active = filter && filter.tab
    ? tabs.find((t) => t.toLowerCase() === String(filter.tab).toLowerCase()) || tabs[0] : tabs[0];

  view.innerHTML = `
    <div class="topbar"><h2>Receivables &amp; Payables</h2><div class="grow"></div>
      ${canManage ? `<button class="btn" id="rp-new-pay">${UI.icon('plus')} Record payment</button>` : ''}</div>
    <div class="subnav-inline" id="rp-tabs">${tabs.map((t) =>
      `<button class="tab ${t === active ? 'active' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <div class="panel"><div id="rp-body"><div class="empty">Loading…</div></div></div>
    <style>
      .subnav-inline{display:flex;gap:4px;margin:2px 0 10px;flex-wrap:wrap}
      .subnav-inline .tab{padding:6px 12px;border:1px solid var(--border);border-radius:7px;background:var(--surface);cursor:pointer;font-size:12.5px}
      .subnav-inline .tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
      .rp-over{color:var(--danger)}
    </style>`;

  const body = view.querySelector('#rp-body');
  view.querySelectorAll('#rp-tabs .tab').forEach((b) => b.onclick = () => {
    active = b.dataset.tab;
    view.querySelectorAll('#rp-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    route();
  });
  const newBtn = view.querySelector('#rp-new-pay');
  if (newBtn) newBtn.onclick = () => paymentModal();
  route();

  function route() {
    if (active === 'Receivables') return aging('ar');
    if (active === 'Payables') return aging('ap');
    if (active === 'Payments') return payments();
    if (active === 'Credit Notes') return creditNotes();
    return statement();
  }

  const BUCKET_LABEL = { current: 'Current', '1_30': '1–30', '31_60': '31–60', '61_90': '61–90', '90_plus': '90+' };

  /* ---------- aging ---------- */
  async function aging(kind) {
    body.innerHTML = '<div class="empty">Loading…</div>';
    const asOf = new Date().toISOString().slice(0, 10);
    const d = await API.get(`/accounting/${kind}-aging?as_of=${asOf}`);
    const who = kind === 'ar' ? 'Customer' : 'Supplier';
    if (!d.parties.length) {
      body.innerHTML = UI.emptyState({ icon: 'sheet', title: `Nothing outstanding`, hint: `No open ${kind === 'ar' ? 'customer invoices' : 'vendor bills'} as of ${asOf}.` });
      return;
    }
    const hasCredits = d.parties.some((p) => p.credits);
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Open ${kind === 'ar' ? 'sale orders' : 'vendor bills'} as of <b>${asOf}</b>, aged by due date${hasCredits ? '; less on-account credits (credit/debit notes + unapplied payments)' : ''}.</p>
      <table><thead><tr><th>${who}</th>${d.buckets.map((b) => `<th class="right">${BUCKET_LABEL[b]}</th>`).join('')}${hasCredits ? '<th class="right">Credits</th>' : ''}<th class="right">Net</th></tr></thead>
        <tbody>${d.parties.map((p, i) => `
          <tr class="clickable" data-party="${i}">
            <td>${UI.esc(p.party_name)}</td>
            ${d.buckets.map((b) => `<td class="right ${b !== 'current' && p.buckets[b] ? 'rp-over' : ''}">${p.buckets[b] ? money(p.buckets[b]) : '—'}</td>`).join('')}
            ${hasCredits ? `<td class="right">${p.credits ? '(' + money(p.credits) + ')' : '—'}</td>` : ''}
            <td class="right"><strong>${money(p.total)}</strong></td>
          </tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th>${d.buckets.map((b) => `<th class="right">${money(d.totals[b])}</th>`).join('')}${hasCredits ? `<th class="right">(${money(d.total_credits)})</th>` : ''}<th class="right">${money(d.grand_total)}</th></tr></tfoot>
      </table>`;
    body.querySelectorAll('[data-party]').forEach((tr) => tr.onclick = () => {
      const p = d.parties[Number(tr.dataset.party)];
      UI.drawer({
        title: p.party_name,
        bodyHTML: `${p.docs.length ? `<table><thead><tr><th>Document</th><th>Due</th><th>Bucket</th><th class="right">Outstanding</th></tr></thead>
          <tbody>${p.docs.map((doc) => `<tr><td class="mono">${UI.esc(doc.doc_number)}</td><td>${UI.esc(doc.due_date || '—')}</td>
            <td class="muted">${BUCKET_LABEL[doc.bucket]}</td><td class="right">${money(doc.outstanding)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No open documents.</p>'}
          ${p.credits ? `<p class="muted">On-account credit: <strong>${money(p.credits)}</strong> — net owed <strong>${money(p.total)}</strong>.</p>` : ''}
          ${canManage && p.party_id ? `<button class="btn" style="margin-top:12px" id="rp-pay-party">Record ${kind === 'ar' ? 'receipt' : 'payment'}</button>` : ''}`,
      });
      const pb = document.getElementById('rp-pay-party');
      if (pb) pb.onclick = () => paymentModal({
        direction: kind === 'ar' ? 'in' : 'out',
        party_type: kind === 'ar' ? 'customer' : 'supplier',
        party_id: p.party_id, party_name: p.party_name, docs: p.docs,
      });
    });
  }

  /* ---------- payments ---------- */
  async function payments() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    const list = await API.get('/accounting/payments');
    body.innerHTML = list.length ? `
      <table><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Party</th><th>Method</th>
        <th class="right">Amount</th><th class="right">Applied</th><th>Status</th></tr></thead>
        <tbody>${list.map((p) => `<tr class="clickable" data-open="${p.id}">
          <td class="mono">${UI.esc(p.number)}</td><td>${UI.esc(p.payment_date)}</td>
          <td>${p.direction === 'in' ? 'Receipt' : 'Payment'}</td>
          <td>${UI.esc(p.party_name || '—')}</td><td class="muted">${UI.esc(p.method || '—')}</td>
          <td class="right">${money(p.amount)}</td><td class="right muted">${money(p.allocated || 0)}</td>
          <td><span class="badge-pill ${p.status === 'posted' ? 'status-completed' : 'status-cancelled'}">${p.status}</span></td>
        </tr>`).join('')}</tbody></table>`
      : UI.emptyState({ icon: 'sheet', title: 'No payments yet', hint: 'Record a customer receipt or a supplier payment.' });
    body.querySelectorAll('[data-open]').forEach((tr) => tr.onclick = () => openPayment(Number(tr.dataset.open)));
  }

  async function openPayment(id) {
    const p = await API.get('/accounting/payments/' + id);
    UI.drawer({
      title: `${p.number} · ${p.direction === 'in' ? 'Receipt' : 'Payment'}`,
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">Date</span><div>${UI.esc(p.payment_date)}</div></div>
          <div><span class="muted">Party</span><div>${UI.esc(p.party_name || '—')}</div></div>
          <div><span class="muted">Amount</span><div>${money(p.amount)}</div></div>
          <div><span class="muted">Deposit / from</span><div>${UI.esc(p.deposit_account_name || '—')}</div></div>
          ${p.method ? `<div><span class="muted">Method</span><div>${UI.esc(p.method)}</div></div>` : ''}
          ${p.reference ? `<div><span class="muted">Reference</span><div>${UI.esc(p.reference)}</div></div>` : ''}
          <div><span class="muted">Status</span><div>${p.status}</div></div>
        </div>
        ${p.memo ? `<p style="margin:8px 0">${UI.esc(p.memo)}</p>` : ''}
        <h4 style="margin:14px 0 4px">Applied to</h4>
        ${(p.allocations && p.allocations.length) ? `<table><thead><tr><th>Document</th><th class="right">Amount</th></tr></thead>
          <tbody>${p.allocations.map((a) => `<tr><td class="mono">${UI.esc(a.doc_number || ('#' + a.doc_id))}</td><td class="right">${money(a.amount)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">Unapplied (on account).</p>'}
        ${canManage && p.status === 'posted' ? `<button class="btn danger" style="margin-top:14px" id="rp-void">Void payment</button>` : ''}`,
    });
    const vb = document.getElementById('rp-void');
    if (vb) vb.onclick = async () => {
      if (!(await UI.confirmDialog(`Void ${p.number}? This reverses its ledger entry.`, 'Void'))) return;
      try { await API.post(`/accounting/payments/${id}/void`, {}); UI.toast('Payment voided'); route(); }
      catch (e) { UI.toast(e.message, 'error'); }
    };
  }

  async function paymentModal(pre) {
    pre = pre || {};
    const [cashAccts, customers, suppliers] = await Promise.all([
      API.get('/accounting/cash-accounts'),
      API.get('/customers').catch(() => []),
      API.get('/suppliers').catch(() => []),
    ]);
    let direction = pre.direction || 'in';

    const render = () => {
      const parties = direction === 'in' ? customers : suppliers;
      const partyType = direction === 'in' ? 'customer' : 'supplier';
      return `
        <div class="form-grid">
          <div class="form-field"><div class="field-label"><label>Type</label></div>
            <select data-f="direction">
              <option value="in" ${direction === 'in' ? 'selected' : ''}>Receipt — money in from a customer</option>
              <option value="out" ${direction === 'out' ? 'selected' : ''}>Payment — money out to a supplier</option>
            </select></div>
          <div class="form-field"><div class="field-label"><label>Date <span class="req">*</span></label></div>
            <input data-f="payment_date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div class="form-field span2"><div class="field-label"><label>${partyType === 'customer' ? 'Customer' : 'Supplier'}</label></div>
            <select data-f="party_id"><option value="">— on account / none —</option>
              ${parties.map((p) => `<option value="${p.id}" ${String(pre.party_id) === String(p.id) ? 'selected' : ''}>${UI.esc(p.name)}</option>`).join('')}</select></div>
          <div class="form-field"><div class="field-label"><label>Amount <span class="req">*</span></label></div>
            <input data-f="amount" type="number" step="0.01" min="0" value="${pre.amount || ''}" /></div>
          <div class="form-field"><div class="field-label"><label>${direction === 'in' ? 'Deposit to' : 'Pay from'} <span class="req">*</span></label></div>
            <select data-f="deposit_account_id">${cashAccts.map((a) => `<option value="${a.id}">${a.code} · ${UI.esc(a.name)}</option>`).join('')}</select></div>
          <div class="form-field"><div class="field-label"><label>Method</label></div>
            <input data-f="method" placeholder="cash / check / bank transfer / GCash" /></div>
          <div class="form-field"><div class="field-label"><label>Reference</label></div>
            <input data-f="reference" placeholder="check no. / txn ref" /></div>
          <div class="form-field span2"><div class="field-label"><label>Memo</label></div>
            <input data-f="memo" /></div>
        </div>
        ${pre.docs && pre.docs.length ? `<h4 style="margin:12px 0 4px">Apply to open ${direction === 'in' ? 'orders' : 'bills'}</h4>
          <table><thead><tr><th></th><th>Document</th><th class="right">Outstanding</th><th class="right">Apply</th></tr></thead>
          <tbody>${pre.docs.map((doc) => `<tr>
            <td><input type="checkbox" data-alloc-chk="${doc.doc_id}" /></td>
            <td class="mono">${UI.esc(doc.doc_number)}</td>
            <td class="right">${money(doc.outstanding)}</td>
            <td class="right"><input type="number" step="0.01" min="0" style="width:110px" data-alloc-amt="${doc.doc_id}" value="${doc.outstanding}" /></td>
          </tr>`).join('')}</tbody></table>` : ''}`;
    };

    UI.modal({
      title: 'Record payment',
      size: 'lg',
      bodyHTML: `<div id="rp-pay-wrap">${render()}</div>`,
      confirmText: 'Save payment',
      onOpen: (ov) => {
        const bind = () => {
          const sel = ov.querySelector('[data-f="direction"]');
          sel.onchange = (e) => {
            direction = e.target.value;
            // keep the parties-only allocation table hidden after a manual type switch
            if (pre.docs && direction !== pre.direction) pre = { ...pre, docs: null };
            ov.querySelector('#rp-pay-wrap').innerHTML = render();
            bind();
          };
        };
        bind();
      },
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`);
        const dir = g('direction').value;
        const body = {
          direction: dir,
          party_type: dir === 'in' ? 'customer' : 'supplier',
          party_id: g('party_id').value ? Number(g('party_id').value) : null,
          payment_date: g('payment_date').value,
          amount: Number(g('amount').value),
          deposit_account_id: Number(g('deposit_account_id').value),
          method: g('method').value.trim() || null,
          reference: g('reference').value.trim() || null,
          memo: g('memo').value.trim() || null,
        };
        if (!body.amount || body.amount <= 0) { showErr('Enter an amount'); return false; }
        if (!body.deposit_account_id) { showErr('Pick a cash / bank account'); return false; }
        const allocs = [];
        ov.querySelectorAll('[data-alloc-chk]').forEach((chk) => {
          if (!chk.checked) return;
          const id = chk.dataset.allocChk;
          const amt = Number(ov.querySelector(`[data-alloc-amt="${id}"]`).value);
          if (amt > 0) allocs.push({ doc_type: dir === 'in' ? 'sale_order' : 'vendor_bill', doc_id: Number(id), amount: amt });
        });
        if (allocs.length) body.allocations = allocs;
        try {
          await API.post('/accounting/payments', body);
          UI.toast('Payment recorded');
          route();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---------- credit / debit notes ---------- */
  async function creditNotes() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    const list = await API.get('/accounting/credit-notes');
    body.innerHTML = `
      <div style="display:flex;margin-bottom:8px"><div class="grow"></div>
        ${canManage ? `<button class="btn secondary small" id="cn-new">${UI.icon('plus')} New note</button>` : ''}</div>
      ${list.length ? `<table><thead><tr><th>No.</th><th>Date</th><th>Kind</th><th>Party</th><th>Reason</th>
        <th class="right">Total</th><th>Status</th></tr></thead>
        <tbody>${list.map((n) => `<tr class="clickable" data-open="${n.id}">
          <td class="mono">${UI.esc(n.number)}</td><td>${UI.esc(n.note_date)}</td>
          <td>${n.kind === 'customer' ? 'Credit note' : 'Debit note'}</td>
          <td>${UI.esc(n.party_name || '—')}</td><td class="muted">${UI.esc(n.reason || '—')}</td>
          <td class="right">${money(n.total)}</td>
          <td><span class="badge-pill ${n.status === 'issued' ? 'status-completed' : 'status-cancelled'}">${n.status}</span></td>
        </tr>`).join('')}</tbody></table>`
        : UI.emptyState({ icon: 'sheet', title: 'No credit / debit notes', hint: 'Issue one for a sales return, allowance or overbilling.' })}`;
    const nb = body.querySelector('#cn-new');
    if (nb) nb.onclick = () => creditNoteModal();
    body.querySelectorAll('[data-open]').forEach((tr) => tr.onclick = () => openNote(Number(tr.dataset.open)));
  }

  async function openNote(id) {
    const n = await API.get('/accounting/credit-notes/' + id);
    UI.drawer({
      title: `${n.number} · ${n.kind === 'customer' ? 'Credit note' : 'Debit note'}`,
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">Date</span><div>${UI.esc(n.note_date)}</div></div>
          <div><span class="muted">Party</span><div>${UI.esc(n.party_name || '—')}</div></div>
          <div><span class="muted">Net</span><div>${money(n.subtotal)}</div></div>
          <div><span class="muted">Tax</span><div>${money(n.tax_amount)}</div></div>
          <div><span class="muted">Total</span><div><strong>${money(n.total)}</strong></div></div>
          ${n.source_doc_number ? `<div><span class="muted">Against</span><div class="mono">${UI.esc(n.source_doc_number)}</div></div>` : ''}
          <div><span class="muted">Status</span><div>${n.status}</div></div>
        </div>
        ${n.reason ? `<p style="margin:8px 0">${UI.esc(n.reason)}</p>` : ''}
        ${canManage && n.status === 'issued' ? `<button class="btn danger" style="margin-top:14px" id="cn-void">Void note</button>` : ''}`,
    });
    const vb = document.getElementById('cn-void');
    if (vb) vb.onclick = async () => {
      if (!(await UI.confirmDialog(`Void ${n.number}? This reverses its ledger entry.`, 'Void'))) return;
      try { await API.post(`/accounting/credit-notes/${id}/void`, {}); UI.toast('Note voided'); route(); }
      catch (e) { UI.toast(e.message, 'error'); }
    };
  }

  async function creditNoteModal() {
    const [customers, suppliers, allCodes] = await Promise.all([
      API.get('/customers').catch(() => []),
      API.get('/suppliers').catch(() => []),
      API.get('/accounting/tax-codes?active=1').catch(() => []),
    ]);
    let kind = 'customer';
    const render = () => {
      const parties = kind === 'customer' ? customers : suppliers;
      const vatKind = kind === 'customer' ? 'output_vat' : 'input_vat';
      const codes = allCodes.filter((t) => t.kind === vatKind || t.kind === 'exempt' || t.kind === 'zero_rated');
      return `<div class="form-grid">
        <div class="form-field"><div class="field-label"><label>Kind</label></div>
          <select data-f="kind">
            <option value="customer" ${kind === 'customer' ? 'selected' : ''}>Customer credit note (sales return → reduces AR)</option>
            <option value="supplier" ${kind === 'supplier' ? 'selected' : ''}>Supplier debit note (purchase return → reduces AP)</option>
          </select></div>
        <div class="form-field"><div class="field-label"><label>Date <span class="req">*</span></label></div>
          <input data-f="note_date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div class="form-field span2"><div class="field-label"><label>${kind === 'customer' ? 'Customer' : 'Supplier'}</label></div>
          <select data-f="party_id"><option value="">— name only —</option>
            ${parties.map((p) => `<option value="${p.id}">${UI.esc(p.name)}</option>`).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Net amount <span class="req">*</span></label></div>
          <input data-f="subtotal" type="number" step="0.01" min="0" value="" /></div>
        <div class="form-field"><div class="field-label"><label>VAT amount</label></div>
          <input data-f="tax_amount" type="number" step="0.01" min="0" value="0" /></div>
        ${codes.length ? `<div class="form-field span2"><div class="field-label"><label>Tax code</label></div>
          <select data-f="tax_code_id"><option value="">— unclassified —</option>
            ${codes.map((t) => `<option value="${t.id}">${UI.esc(t.code)} — ${UI.esc(t.name)}</option>`).join('')}</select></div>` : ''}
        <div class="form-field span2"><div class="field-label"><label>Reason</label></div>
          <input data-f="reason" placeholder="Sales return / allowance / overbilling" /></div>
      </div>`;
    };
    UI.modal({
      title: 'New credit / debit note',
      size: 'lg',
      bodyHTML: `<div id="cn-wrap">${render()}</div>`,
      confirmText: 'Issue note',
      onOpen: (ov) => {
        const bind = () => {
          ov.querySelector('[data-f="kind"]').onchange = (e) => {
            kind = e.target.value; ov.querySelector('#cn-wrap').innerHTML = render(); bind();
          };
        };
        bind();
      },
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`);
        const tc = g('tax_code_id');
        const b = {
          kind: g('kind').value,
          party_id: g('party_id').value ? Number(g('party_id').value) : null,
          note_date: g('note_date').value,
          subtotal: Number(g('subtotal').value) || 0,
          tax_amount: Number(g('tax_amount').value) || 0,
          tax_code_id: tc && tc.value ? Number(tc.value) : null,
          reason: g('reason').value.trim() || null,
        };
        if (b.subtotal + b.tax_amount <= 0) { showErr('Enter an amount'); return false; }
        try { await API.post('/accounting/credit-notes', b); UI.toast('Note issued'); route(); }
        catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---------- party statement ---------- */
  async function statement() {
    const [customers, suppliers] = await Promise.all([
      API.get('/customers').catch(() => []),
      API.get('/suppliers').catch(() => []),
    ]);
    body.innerHTML = `
      <div class="field-row" style="margin-bottom:10px">
        <div><label>Party type</label><select id="st-type">
          <option value="customer">Customer</option><option value="supplier">Supplier</option></select></div>
        <div style="flex:1"><label>Party</label><select id="st-party"></select></div>
      </div>
      <div id="st-out"><p class="muted">Pick a party.</p></div>`;
    const typeSel = body.querySelector('#st-type');
    const partySel = body.querySelector('#st-party');
    const fillParties = () => {
      const list = typeSel.value === 'customer' ? customers : suppliers;
      partySel.innerHTML = '<option value="">—</option>' + list.map((p) => `<option value="${p.id}">${UI.esc(p.name)}</option>`).join('');
    };
    fillParties();
    typeSel.onchange = () => { fillParties(); body.querySelector('#st-out').innerHTML = '<p class="muted">Pick a party.</p>'; };
    partySel.onchange = async () => {
      if (!partySel.value) return;
      const out = body.querySelector('#st-out');
      out.innerHTML = '<div class="empty">Loading…</div>';
      const d = await API.get(`/accounting/party-ledger?party_type=${typeSel.value}&party_id=${partySel.value}`);
      out.innerHTML = `
        <table><thead><tr><th>Date</th><th>Ref</th><th class="right">Charge</th><th class="right">Payment</th><th class="right">Balance</th></tr></thead>
          <tbody>${d.lines.map((l) => `<tr><td>${UI.esc(l.date || '—')}</td><td class="mono">${UI.esc(l.ref)}</td>
            <td class="right">${l.charge ? money(l.charge) : ''}</td><td class="right">${l.payment ? money(l.payment) : ''}</td>
            <td class="right">${money(l.balance)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><th colspan="2">Balance owed</th><th class="right">${money(d.total_charges)}</th><th class="right">${money(d.total_payments)}</th><th class="right">${money(d.balance)}</th></tr></tfoot>
        </table>`;
    };
  }
});
