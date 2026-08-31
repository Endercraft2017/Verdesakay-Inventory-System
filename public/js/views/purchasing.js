/* Purchasing: goods receipts + vendor bills + 3-way match, hung off a purchase order.
   filter.tab   = 'bills' | 'receipts'  (worklist tabs)
   filter.order = <PO id>               (opens that PO's receiving & billing panel) */
App.register('purchasing', async (view, filter) => {
  const money = UI.money;
  const canReceive = App.hasPermission('inventory.adjust');
  const canBill = App.hasPermission('orders.edit');
  let taxCodes = [];
  try { taxCodes = await API.get('/accounting/tax-codes?active=1'); } catch { /* needs accounting.view */ }
  const tab = filter && filter.tab === 'receipts' ? 'receipts' : 'bills';
  const LABEL = 'margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)';

  if (!document.getElementById('pur-style')) {
    const st = document.createElement('style');
    st.id = 'pur-style';
    st.textContent = `
      .match-box { border:1px solid var(--border); border-radius:8px; padding:12px; margin-top:14px; }
      .match-box.ok { border-color:var(--success); background:var(--success-weak); }
      .match-box.bad { border-color:var(--danger); background:var(--danger-weak); }
      .match-box tr.bad-row td { color:var(--danger); }
      td.ok { color:var(--success); } td.warn { color:var(--warn); }`;
    document.head.appendChild(st);
  }

  if (filter && filter.order) {
    await renderPoPanel(Number(filter.order));
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>${tab === 'bills' ? 'Vendor Bills' : 'Goods Receipts'}</h2>
      <div class="grow"></div>
      ${tab === 'bills' ? `<select id="pur-status">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="approved">Approved</option>
        <option value="disputed">Disputed</option>
      </select>` : ''}
      <button class="btn secondary small" id="pur-tol" title="3-way match tolerance">${UI.icon('settings', 15)} Match tolerance</button>
    </div>
    <div class="panel"><div id="pur-table"><div class="empty">Loading…</div></div></div>`;

  const tableEl = view.querySelector('#pur-table');
  const statusSel = view.querySelector('#pur-status');
  if (statusSel) statusSel.onchange = () => loadBills();
  view.querySelector('#pur-tol').onclick = () => toleranceModal();

  if (tab === 'bills') loadBills(); else loadReceipts();

  async function toleranceModal() {
    let t;
    try { t = await API.get('/purchasing/tolerance'); } catch (e) { UI.toast(e.message, 'error'); return; }
    UI.modal({
      title: '3-way match tolerance',
      bodyHTML: `
        <p class="muted" style="margin-top:0">How far a vendor bill's price/quantity may drift from the
          purchase order + goods receipts before the match panel flags it as an exception. A price line fails
          if it's outside <b>both</b> the % and absolute allowance (whichever is looser wins); quantity only
          checks %.</p>
        <div class="field-row">
          <div><label>Price tolerance (%)</label><input data-f="price_pct" type="number" min="0" step="0.1" value="${t.price_pct}" ${canBill ? '' : 'disabled'} /></div>
          <div><label>Price tolerance (₱, flat)</label><input data-f="price_abs" type="number" min="0" step="0.01" value="${t.price_abs}" ${canBill ? '' : 'disabled'} /></div>
          <div><label>Quantity tolerance (%)</label><input data-f="qty_pct" type="number" min="0" step="0.1" value="${t.qty_pct}" ${canBill ? '' : 'disabled'} /></div>
        </div>`,
      confirmText: canBill ? 'Save' : null,
      cancelText: canBill ? 'Cancel' : 'Close',
      onConfirm: canBill ? async (ov, showErr) => {
        const v = (k) => Number(ov.querySelector(`[data-f="${k}"]`).value);
        const body = { price_pct: v('price_pct'), price_abs: v('price_abs'), qty_pct: v('qty_pct') };
        if (body.price_pct < 0 || body.price_abs < 0 || body.qty_pct < 0) { showErr('Tolerances can’t be negative'); return false; }
        await API.put('/purchasing/tolerance', body);
        UI.toast('Match tolerance saved');
      } : undefined,
    });
  }

  async function loadBills() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const qs = statusSel && statusSel.value ? '?status=' + statusSel.value : '';
    const rows = await API.get('/purchasing/bills' + qs);
    if (!rows.length) { tableEl.innerHTML = UI.emptyState({ icon: 'sheet', title: 'No vendor bills', hint: 'Open a purchase order and record the supplier’s invoice against it.' }); return; }
    tableEl.innerHTML = `
      <table><thead><tr>
        <th>Bill</th><th>Supplier</th><th>PO</th><th>Bill date</th><th class="right">Total</th><th>Status</th>
      </tr></thead><tbody>${rows.map((b) => `
        <tr class="clickable" data-bill="${b.id}">
          <td><strong>${UI.esc(b.number)}</strong>${b.vendor_ref ? `<div class="muted mono">${UI.esc(b.vendor_ref)}</div>` : ''}</td>
          <td>${UI.esc(b.supplier_name || '—')}</td>
          <td>${UI.esc(b.order_number || '—')}</td>
          <td>${UI.esc(b.bill_date || UI.fmtDateShort(b.created_at))}</td>
          <td class="right">${UI.esc(b.currency || '')} ${money(b.total)}</td>
          <td><span class="badge-pill ${statusPill(b.status)}">${UI.esc(b.status)}</span></td>
        </tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('[data-bill]').forEach((tr) => tr.onclick = () => billDrawer(Number(tr.dataset.bill)));
  }

  async function loadReceipts() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const rows = await API.get('/purchasing/receipts');
    if (!rows.length) { tableEl.innerHTML = UI.emptyState({ icon: 'inbox', title: 'No goods receipts', hint: 'Open a purchase order and record what physically arrived.' }); return; }
    tableEl.innerHTML = `
      <table><thead><tr>
        <th>Receipt</th><th>PO</th><th>Received</th><th>Into</th><th class="right">Lines</th><th>By</th>
      </tr></thead><tbody>${rows.map((g) => `
        <tr class="clickable" data-rcpt="${g.id}">
          <td><strong>${UI.esc(g.number)}</strong></td>
          <td>${UI.esc(g.order_number || '—')}</td>
          <td>${UI.esc(g.received_date || UI.fmtDateShort(g.created_at))}</td>
          <td>${UI.esc(g.location_name || '—')}</td>
          <td class="right">${g.line_count}</td>
          <td>${UI.esc(g.received_by_name || '—')}</td>
        </tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('[data-rcpt]').forEach((tr) => tr.onclick = () => receiptDrawer(Number(tr.dataset.rcpt)));
  }

  /* --------------------------------------------------------- PO panel --- */

  async function renderPoPanel(orderId) {
    view.innerHTML = '<div class="empty">Loading…</div>';
    let data;
    try { data = await API.get('/purchasing/orders/' + orderId); }
    catch (e) { view.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
    const o = data.order;

    view.innerHTML = `
      <div class="topbar">
        <button class="btn secondary small" id="pur-back">${UI.icon('chevron-left', 14)} Purchasing</button>
        <h2 style="margin-left:10px">${UI.esc(o.number)} <span class="badge-pill ${rcptPill(data.receipt_status)}">${rcptLabel(data.receipt_status)}</span></h2>
        <div class="grow"></div>
        ${canReceive ? `<button class="btn" id="pur-recv">${UI.icon('inbox')} Record receipt</button>` : ''}
        ${canBill ? `<button class="btn secondary" id="pur-newbill">${UI.icon('sheet')} New vendor bill</button>` : ''}
      </div>

      <div class="panel">
        <div class="kv">
          <div><span class="muted">Supplier</span><div>${UI.esc(o.supplier_name || o.customer_name || '—')}</div></div>
          <div><span class="muted">Ordered</span><div>${UI.esc(o.order_date || UI.fmtDateShort(o.created_at))}</div></div>
          <div><span class="muted">Expected</span><div>${UI.esc(o.expected_date || '—')}</div></div>
          <div><span class="muted">PO total</span><div>${UI.esc(o.currency || '')} ${money(o.total)}</div></div>
        </div>
        <h4 style="${LABEL}">Lines — ordered vs received vs billed</h4>
        <table><thead><tr>
          <th>Item</th><th class="right">Ordered</th><th class="right">Received</th>
          <th class="right">Billed</th><th class="right">Outstanding</th><th class="right">Unit price</th>
        </tr></thead><tbody>${data.lines.map((l) => `
          <tr>
            <td>${UI.esc(l.name)}${l.sku ? `<div class="muted mono">${UI.esc(l.sku)}</div>` : ''}</td>
            <td class="right">${l.quantity} ${UI.esc(l.unit || '')}</td>
            <td class="right ${l.received >= l.quantity ? 'ok' : ''}">${l.received}</td>
            <td class="right">${l.billed}</td>
            <td class="right ${l.outstanding > 0 ? 'warn' : ''}">${l.outstanding}</td>
            <td class="right">${money(l.unit_price)}</td>
          </tr>`).join('')}</tbody></table>
      </div>

      <div class="panel">
        <h4 style="${LABEL}">Goods receipts</h4>
        ${data.receipts.length ? `<table><thead><tr><th>Receipt</th><th>Date</th><th>Into</th><th class="right">Lines</th><th>By</th><th></th></tr></thead>
          <tbody>${data.receipts.map((g) => `<tr class="clickable" data-rcpt="${g.id}">
            <td><strong>${UI.esc(g.number)}</strong></td><td>${UI.esc(g.received_date || UI.fmtDateShort(g.created_at))}</td>
            <td>${UI.esc(g.location_name || '—')}</td><td class="right">${g.line_count}</td><td>${UI.esc(g.received_by_name || '—')}</td>
            <td class="actions">${canReceive ? `<button class="icon-btn danger" data-rcptdel="${g.id}" title="Reverse & delete">${UI.icon('trash')}</button>` : ''}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing received yet.</div>'}
      </div>

      <div class="panel">
        <h4 style="${LABEL}">Vendor bills</h4>
        ${data.bills.length ? `<table><thead><tr><th>Bill</th><th>Ref</th><th>Date</th><th class="right">Total</th><th>Status</th></tr></thead>
          <tbody>${data.bills.map((b) => `<tr class="clickable" data-bill="${b.id}">
            <td><strong>${UI.esc(b.number)}</strong></td><td class="mono">${UI.esc(b.vendor_ref || '—')}</td>
            <td>${UI.esc(b.bill_date || UI.fmtDateShort(b.created_at))}</td>
            <td class="right">${UI.esc(b.currency || '')} ${money(b.total)}</td>
            <td><span class="badge-pill ${statusPill(b.status)}">${UI.esc(b.status)}</span></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No bills recorded.</div>'}
      </div>`;

    view.querySelector('#pur-back').onclick = () => App.navigate('purchasing', { tab: 'bills' });
    const rb = view.querySelector('#pur-recv');
    if (rb) rb.onclick = () => receiptModal(data, () => renderPoPanel(orderId));
    const nb = view.querySelector('#pur-newbill');
    if (nb) nb.onclick = () => billModal(data, null, () => renderPoPanel(orderId));
    view.querySelectorAll('[data-rcpt]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      receiptDrawer(Number(tr.dataset.rcpt));
    });
    view.querySelectorAll('[data-bill]').forEach((tr) => tr.onclick = () => billDrawer(Number(tr.dataset.bill), () => renderPoPanel(orderId)));
    view.querySelectorAll('[data-rcptdel]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      if (!(await UI.confirmDialog('Reverse the posted stock and delete this receipt?', 'Delete receipt'))) return;
      try { await API.del('/purchasing/receipts/' + b.dataset.rcptdel); UI.toast('Receipt reversed'); renderPoPanel(orderId); }
      catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  /* ------------------------------------------------------- receipt modal --- */

  async function receiptModal(data, after) {
    const locations = await API.get('/locations').catch(() => []);
    const def = locations.find((l) => l.is_default) || locations[0];
    const rows = data.lines.filter((l) => l.outstanding > 0 || l.received < l.quantity);
    const src = rows.length ? rows : data.lines;

    UI.modal({
      title: 'Record goods receipt — ' + data.order.number,
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Received date</label><input data-f="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div style="flex:1"><label>Received into <span class="req">*</span></label>
            <select data-f="loc">${locations.map((l) => `<option value="${l.id}" ${def && l.id === def.id ? 'selected' : ''}>${UI.esc(l.name)}</option>`).join('')}</select></div>
        </div>
        <div><label>Note</label><input data-f="note" placeholder="Delivery ref, condition…" /></div>
        <h4 style="${LABEL}">Lines received now</h4>
        <table><thead><tr><th>Item</th><th class="right">Outstanding</th><th style="width:120px">Receive</th></tr></thead>
          <tbody>${src.map((l, i) => `<tr data-i="${i}" data-oi="${l.id}" data-item="${l.item_id || ''}" data-name="${UI.esc(l.name)}" data-sku="${UI.esc(l.sku || '')}" data-unit="${UI.esc(l.unit || '')}">
            <td>${UI.esc(l.name)}</td>
            <td class="right">${Math.max(0, l.outstanding)}</td>
            <td><input data-q type="number" min="0" step="any" value="${Math.max(0, l.outstanding)}" style="width:110px" /></td>
          </tr>`).join('')}</tbody></table>`,
      confirmText: 'Post receipt',
      onConfirm: async (ov, showErr) => {
        const loc = ov.querySelector('[data-f="loc"]').value;
        if (!loc) { showErr('Pick a location'); return false; }
        const lines = [];
        ov.querySelectorAll('tr[data-i]').forEach((tr) => {
          const q = parseFloat(tr.querySelector('[data-q]').value);
          if (!q || q <= 0) return;
          lines.push({
            order_item_id: Number(tr.dataset.oi) || null,
            item_id: Number(tr.dataset.item) || null,
            name: tr.dataset.name, sku: tr.dataset.sku || null, unit: tr.dataset.unit || null,
            quantity: q,
          });
        });
        if (!lines.length) { showErr('Enter a received quantity on at least one line'); return false; }
        try {
          await API.post('/purchasing/orders/' + data.order.id + '/receipts', {
            received_date: ov.querySelector('[data-f="date"]').value || null,
            location_id: Number(loc),
            notes: ov.querySelector('[data-f="note"]').value.trim() || null,
            lines,
          });
          UI.toast('Stock received'); after();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ---------------------------------------------------------- bill modal --- */

  function billModal(data, existing, after) {
    const src = (existing && existing.items && existing.items.length)
      ? existing.items
      : data.lines.map((l) => ({
          order_item_id: l.id, item_id: l.item_id, name: l.name, sku: l.sku, unit: l.unit,
          quantity: l.outstanding > 0 ? l.outstanding : l.quantity, unit_price: l.unit_price,
        }));
    UI.modal({
      title: (existing ? 'Edit bill ' + existing.number : 'New vendor bill') + ' — ' + data.order.number,
      size: 'lg',
      bodyHTML: `
        <div class="field-row">
          <div><label>Supplier invoice no.</label><input data-f="ref" value="${UI.esc(existing ? existing.vendor_ref || '' : '')}" /></div>
          <div><label>Bill date</label><input data-f="bdate" type="date" value="${(existing && existing.bill_date) || new Date().toISOString().slice(0, 10)}" /></div>
          <div><label>Due date</label><input data-f="ddate" type="date" value="${(existing && existing.due_date) || ''}" /></div>
        </div>
        <div class="field-row">
          <div><label>Tax %</label><input data-f="tax" type="number" min="0" max="100" step="any" value="${existing ? existing.tax_percent : 0}" style="width:90px" /></div>
          ${taxCodes.length ? `<div><label>Tax code</label><select data-f="tcode"><option value="">— unclassified —</option>
            ${taxCodes.map((t) => `<option value="${t.id}" ${existing && String(existing.tax_code_id) === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)} — ${UI.esc(t.name)}</option>`).join('')}</select></div>` : ''}
          <div style="flex:1"><label>Note</label><input data-f="note" value="${UI.esc(existing ? existing.notes || '' : '')}" /></div>
        </div>
        <div class="field-row">
          <div><label>EWT %</label><input data-f="ewt" type="number" min="0" max="100" step="any" value="${existing ? (existing.ewt_rate || 0) : 0}" style="width:90px" /></div>
          <div><label>ATC</label><input data-f="ewtatc" value="${UI.esc(existing ? existing.ewt_atc || '' : '')}" placeholder="WI120 / WC140…" style="width:110px" /></div>
          <div style="flex:1;align-self:end"><span class="muted" id="ewt-hint" style="font-size:12px"></span></div>
        </div>
        <h4 style="${LABEL}">Lines</h4>
        <table><thead><tr><th>Item</th><th style="width:90px">Qty</th>${taxCodes.length ? '<th style="width:130px">Tax code</th>' : ''}<th style="width:120px">Unit price</th></tr></thead>
          <tbody id="bill-rows">${src.map((l) => billRow(l)).join('')}</tbody></table>
        <button type="button" class="btn secondary small" id="bill-add" style="margin-top:8px">${UI.icon('plus')} Add line</button>`,
      confirmText: existing ? 'Save bill' : 'Create bill',
      onOpen: (ov) => {
        ov.querySelector('#bill-add').onclick = () =>
          ov.querySelector('#bill-rows').insertAdjacentHTML('beforeend', billRow({ name: '', quantity: 1, unit_price: 0 }));
        ov.querySelector('#bill-rows').addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rm]');
          if (rm) rm.closest('tr').remove();
        });
        const hint = ov.querySelector('#ewt-hint');
        const updateEwt = () => {
          let net = 0;
          ov.querySelectorAll('#bill-rows tr').forEach((tr) => {
            net += (parseFloat(tr.querySelector('[data-q]').value) || 0) * (parseFloat(tr.querySelector('[data-p]').value) || 0);
          });
          const rate = parseFloat(ov.querySelector('[data-f="ewt"]').value) || 0;
          hint.textContent = rate > 0 ? `Withholds ${money(net * rate / 100)} from the supplier (remitted to BIR).` : '';
        };
        ov.querySelector('[data-f="ewt"]').addEventListener('input', updateEwt);
        ov.querySelector('#bill-rows').addEventListener('input', updateEwt);
        updateEwt();
      },
      onConfirm: async (ov, showErr) => {
        const lines = [];
        ov.querySelectorAll('#bill-rows tr').forEach((tr) => {
          const name = tr.querySelector('[data-n]').value.trim();
          if (!name) return;
          lines.push({
            order_item_id: Number(tr.dataset.oi) || null,
            item_id: Number(tr.dataset.item) || null,
            name,
            sku: tr.dataset.sku || null, unit: tr.dataset.unit || null,
            quantity: parseFloat(tr.querySelector('[data-q]').value) || 0,
            unit_price: parseFloat(tr.querySelector('[data-p]').value) || 0,
            tax_code_id: (() => { const s = tr.querySelector('[data-tc]'); return s && s.value ? Number(s.value) : null; })(),
          });
        });
        if (!lines.length) { showErr('Add at least one line'); return false; }
        const tcodeEl = ov.querySelector('[data-f="tcode"]');
        const body = {
          vendor_ref: ov.querySelector('[data-f="ref"]').value.trim() || null,
          bill_date: ov.querySelector('[data-f="bdate"]').value || null,
          due_date: ov.querySelector('[data-f="ddate"]').value || null,
          tax_percent: parseFloat(ov.querySelector('[data-f="tax"]').value) || 0,
          tax_code_id: tcodeEl && tcodeEl.value ? Number(tcodeEl.value) : null,
          ewt_rate: parseFloat(ov.querySelector('[data-f="ewt"]').value) || 0,
          ewt_atc: ov.querySelector('[data-f="ewtatc"]').value.trim() || null,
          notes: ov.querySelector('[data-f="note"]').value.trim() || null,
          lines,
        };
        try {
          if (existing) await API.put('/purchasing/bills/' + existing.id, body);
          else await API.post('/purchasing/orders/' + data.order.id + '/bills', body);
          UI.toast('Bill saved'); after();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  function billRow(l) {
    const tcCell = taxCodes.length
      ? `<td><select data-tc style="width:125px"><option value="">— doc default —</option>${taxCodes.map((t) =>
          `<option value="${t.id}" ${String(l.tax_code_id || '') === String(t.id) ? 'selected' : ''}>${UI.esc(t.code)}</option>`).join('')}</select></td>`
      : '';
    return `<tr data-oi="${l.order_item_id || ''}" data-item="${l.item_id || ''}" data-sku="${UI.esc(l.sku || '')}" data-unit="${UI.esc(l.unit || '')}">
      <td><input data-n value="${UI.esc(l.name || '')}" placeholder="Line item" style="width:100%" /></td>
      <td><input data-q type="number" min="0" step="any" value="${l.quantity != null ? l.quantity : 1}" style="width:80px" /></td>
      ${tcCell}
      <td style="display:flex;gap:4px">
        <input data-p type="number" min="0" step="any" value="${l.unit_price != null ? l.unit_price : 0}" style="width:100px" />
        <button type="button" class="icon-btn danger" data-rm title="Remove">${UI.icon('trash')}</button>
      </td></tr>`;
  }

  /* --------------------------------------------------------- bill drawer --- */

  async function billDrawer(billId, after) {
    let bill;
    try { bill = await API.get('/purchasing/bills/' + billId); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const m = bill.match;
    const matchHTML = m ? `
      <div class="match-box ${m.ok ? 'ok' : 'bad'}">
        <strong>${m.ok ? '✓ 3-way match clean' : '✗ ' + m.issues.length + ' exception' + (m.issues.length === 1 ? '' : 's')}</strong>
        <table style="margin-top:8px"><thead><tr><th>Item</th><th class="right">PO</th><th class="right">Recv</th><th class="right">Billed</th><th class="right">PO price</th><th class="right">Bill price</th></tr></thead>
          <tbody>${m.lines.map((l) => `<tr class="${l.qty_ok && l.price_ok && l.on_po ? '' : 'bad-row'}">
            <td>${UI.esc(l.name)}${l.issues.length ? `<div class="muted">${UI.esc(l.issues.join('; '))}</div>` : ''}</td>
            <td class="right">${l.ordered_qty}</td><td class="right">${l.received_qty}</td><td class="right">${l.billed_qty}</td>
            <td class="right">${l.po_unit_price != null ? money(l.po_unit_price) : '—'}</td>
            <td class="right">${l.bill_unit_price != null ? money(l.bill_unit_price) : '—'}</td>
          </tr>`).join('')}</tbody></table>
      </div>` : '';

    const isOpen = bill.status !== 'approved';
    const d = UI.drawer({
      title: bill.number + (bill.vendor_ref ? ' · ' + bill.vendor_ref : ''),
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">Supplier</span><div>${UI.esc(bill.supplier_name || '—')}</div></div>
          <div><span class="muted">PO</span><div>${UI.esc(bill.order_number || '—')}</div></div>
          <div><span class="muted">Status</span><div><span class="badge-pill ${statusPill(bill.status)}">${UI.esc(bill.status)}</span></div></div>
          <div><span class="muted">Total</span><div>${UI.esc(bill.currency || '')} ${money(bill.total)}</div></div>
          ${bill.ewt_amount ? `<div><span class="muted">EWT withheld</span><div>${money(bill.ewt_amount)}${bill.ewt_atc ? ' · ' + UI.esc(bill.ewt_atc) : ''} → net to supplier ${money(bill.total - bill.ewt_amount)}</div></div>` : ''}
          ${bill.approved_by_name ? `<div><span class="muted">Approved by</span><div>${UI.esc(bill.approved_by_name)} · ${UI.esc((bill.approved_at || '').slice(0, 10))}</div></div>` : ''}
          ${bill.dispute_note ? `<div><span class="muted">Dispute</span><div>${UI.esc(bill.dispute_note)}</div></div>` : ''}
        </div>
        <table style="margin-top:10px"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Line</th></tr></thead>
          <tbody>${(bill.items || []).map((l) => `<tr>
            <td>${UI.esc(l.name)}</td><td class="right">${l.quantity} ${UI.esc(l.unit || '')}</td>
            <td class="right">${money(l.unit_price)}</td><td class="right">${money(l.line_total)}</td>
          </tr>`).join('')}</tbody></table>
        ${matchHTML}
        <div class="drawer-actions" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          ${canBill && isOpen ? `<button class="btn" id="bd-approve">${m && m.ok ? 'Approve' : 'Approve…'}</button>` : ''}
          ${canBill && isOpen ? `<button class="btn secondary" id="bd-edit">Edit</button>` : ''}
          ${canBill && bill.status !== 'disputed' && isOpen ? `<button class="btn secondary" id="bd-dispute">Dispute</button>` : ''}
          ${canBill && bill.status === 'approved' ? `<button class="btn secondary" id="bd-dispute">Dispute (re-open)</button>` : ''}
          ${canBill && isOpen ? `<button class="btn danger" id="bd-del">Delete</button>` : ''}
        </div>`,
    });
    const ov = d.overlay || d.el || document;
    const done = () => { if (d.close) d.close(); if (after) after(); };

    const ap = ov.querySelector('#bd-approve');
    if (ap) ap.onclick = async () => {
      if (m && !m.ok) {
        const msg = 'The 3-way match has ' + m.issues.length + ' exception'
          + (m.issues.length === 1 ? '' : 's')
          + ' (see the panel above). Approve anyway? Your override is recorded against your name.';
        if (!(await UI.confirmDialog(msg, 'Force approve'))) return;
        try {
          await API.post('/purchasing/bills/' + billId + '/approve', { force: true });
          UI.toast('Bill force-approved'); done();
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      try {
        await API.post('/purchasing/bills/' + billId + '/approve', {});
        UI.toast('Bill approved'); done();
      } catch (e) { UI.toast(e.message, 'error'); }
    };
    const ed = ov.querySelector('#bd-edit');
    if (ed) ed.onclick = async () => {
      const data = await API.get('/purchasing/orders/' + bill.order_id);
      if (d.close) d.close();
      billModal(data, bill, () => { if (after) after(); });
    };
    const dp = ov.querySelector('#bd-dispute');
    if (dp) dp.onclick = () => UI.modal({
      title: 'Dispute ' + bill.number,
      bodyHTML: `<label>What is wrong with this bill? <span class="req">*</span></label><textarea data-f="note" rows="3"></textarea>`,
      confirmText: 'Mark disputed',
      onConfirm: async (mv, showErr) => {
        const note = mv.querySelector('[data-f="note"]').value.trim();
        if (note.length < 3) { showErr('Give a short reason'); return false; }
        try { await API.post('/purchasing/bills/' + billId + '/dispute', { note }); UI.toast('Bill disputed'); done(); }
        catch (e) { showErr(e.message); return false; }
      },
    });
    const dl = ov.querySelector('#bd-del');
    if (dl) dl.onclick = async () => {
      if (!(await UI.confirmDialog('Delete this bill?', 'Delete'))) return;
      try { await API.del('/purchasing/bills/' + billId); UI.toast('Bill deleted'); done(); }
      catch (e) { UI.toast(e.message, 'error'); }
    };
  }

  async function receiptDrawer(id) {
    let g;
    try { g = await API.get('/purchasing/receipts/' + id); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    UI.drawer({
      title: g.number,
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">PO</span><div>${UI.esc(g.order_number || '—')}</div></div>
          <div><span class="muted">Received</span><div>${UI.esc(g.received_date || UI.fmtDateShort(g.created_at))}</div></div>
          <div><span class="muted">Into</span><div>${UI.esc(g.location_name || '—')}</div></div>
          <div><span class="muted">By</span><div>${UI.esc(g.received_by_name || '—')}</div></div>
          ${g.notes ? `<div><span class="muted">Note</span><div>${UI.esc(g.notes)}</div></div>` : ''}
        </div>
        <table style="margin-top:10px"><thead><tr><th>Item</th><th class="right">Qty received</th></tr></thead>
          <tbody>${(g.items || []).map((l) => `<tr><td>${UI.esc(l.name)}${l.sku ? `<div class="muted mono">${UI.esc(l.sku)}</div>` : ''}</td>
            <td class="right">${l.quantity} ${UI.esc(l.unit || '')}</td></tr>`).join('')}</tbody></table>`,
    });
  }

  function statusPill(s) {
    return s === 'approved' ? 'status-completed' : s === 'disputed' ? 'status-cancelled' : 'status-open';
  }
  function rcptPill(s) {
    return s === 'complete' ? 'status-completed' : s === 'over' ? 'status-cancelled' : s === 'partial' ? 'status-confirmed' : 'status-open';
  }
  function rcptLabel(s) {
    return { none: 'not received', partial: 'partial', complete: 'received', over: 'over-received' }[s] || s;
  }
});
