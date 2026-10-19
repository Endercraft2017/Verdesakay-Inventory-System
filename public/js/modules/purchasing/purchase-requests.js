/* Internal spending requests; supplier purchase orders and goods receipts stay separate. */
App.register('purchase-requests', async (view) => {
  const base = '/purchasing/requests';
  const canRequest = App.hasPermission('purchasing.request');
  const canReview = App.hasPermission('purchasing.manage');
  const esc = UI.esc;
  const pesos = (n) => 'PHP ' + UI.money(Number(n) || 0);
  view.innerHTML = `<div class="topbar"><h2>Purchase Requests</h2><div class="grow"></div>${canRequest ? '<button class="btn" id="pr-new">New request</button>' : ''}</div>
    <p class="muted">Request a budget for parts, tools or supplies. Approval authorizes a buyer; receipts and liquidation close the request. This does not receive stock.</p>
    <div class="panel" id="pr-list">Loading…</div>`;
  view.querySelector('#pr-new')?.addEventListener('click', () => lineForm('request'));
  const host = view.querySelector('#pr-list');

  async function load() {
    try {
      const rows = await API.get(base);
      host.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Request</th><th>Requester / buyer</th><th>Reason</th><th>Budget / actual</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><strong>${esc(r.number)}</strong><div class="muted">${esc(r.created_at || '')}</div></td>
          <td>${esc(r.requested_by_name || '—')}${r.buyer_name ? `<div class="muted">Buyer: ${esc(r.buyer_name)}</div>` : ''}</td>
          <td>${esc(r.reason)}${r.needed_by ? `<div class="muted">Needed by ${esc(r.needed_by)}</div>` : ''}</td>
          <td>${pesos(r.approved_budget ?? r.requested_budget)}${r.actual_total != null ? `<div class="muted">Actual ${pesos(r.actual_total)}</div>` : ''}</td>
          <td><span class="badge-pill status-${esc(r.status)}">${esc(r.status.replaceAll('_',' '))}</span></td>
          <td><button class="btn secondary small" data-open="${r.id}">View</button></td></tr>`).join('')}</tbody></table></div>`
        : UI.emptyState({ icon: 'inbox', title: 'No purchase requests yet', hint: canRequest ? 'Submit the items and expected amount you need.' : 'Staff requests will appear here.' });
      host.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => detail(Number(b.dataset.open)));
    } catch (e) { host.innerHTML = `<div role="alert">${esc(e.message)} <button class="btn secondary" data-retry>Retry</button></div>`; host.querySelector('[data-retry]').onclick = load; }
  }

  function lineForm(kind, request) {
    const actual = kind === 'liquidation';
    const lines = actual && request.purchases.length ? request.purchases.map((x) => ({ name: x.name, quantity: x.quantity, price: x.actual_unit_price }))
      : actual ? request.items.map((x) => ({ name: x.name, quantity: x.quantity, price: 0 })) : [{ name: '', quantity: 1, price: '' }];
    UI.modal({ title: actual ? `Liquidate ${request.number}` : 'New purchase request', size: 'lg', confirmText: actual ? 'Submit liquidation' : 'Submit request',
      bodyHTML: `<p class="muted">${actual ? `Record what was actually bought. You may add other items if the total stays within ${pesos(request.approved_budget)}. Upload receipts on the request before submitting.` : 'Items can be new or outside the inventory catalog. Enter a realistic expected price; this is a budget, not the final cost.'}</p>
        ${actual ? '' : '<div class="form-field"><label>Reason for purchase *</label><textarea data-reason rows="2" maxlength="2000"></textarea></div><div class="form-field"><label>Needed by (optional)</label><input data-date type="date"></div>'}
        <div data-lines></div><button type="button" class="btn secondary" data-add>Add item</button>
        <p><strong data-total></strong></p>${actual ? '<div class="form-field"><label>Liquidation note (optional)</label><textarea data-note rows="2"></textarea></div>' : ''}`,
      onOpen: (ov) => {
        const render = () => {
          ov.querySelector('[data-lines]').innerHTML = lines.map((x,i) => `<div class="field-row" style="align-items:end">
            <div><label>Item ${i+1} *</label><input data-name="${i}" maxlength="200" value="${esc(x.name)}" placeholder="e.g. wrench, cleaning supplies"></div>
            <div><label>Qty *</label><input data-qty="${i}" type="number" min="0.001" step="any" value="${esc(x.quantity)}"></div>
            <div><label>${actual ? 'Actual' : 'Expected'} unit price *</label><input data-price="${i}" type="number" min="0" step="0.01" value="${esc(x.price)}"></div>
            <button type="button" class="btn secondary" data-remove="${i}" aria-label="Remove item ${i+1}">Remove</button></div>`).join('');
          ov.querySelectorAll('[data-name]').forEach((el) => el.oninput = () => { lines[Number(el.dataset.name)].name = el.value; });
          ov.querySelectorAll('[data-qty]').forEach((el) => el.oninput = () => { lines[Number(el.dataset.qty)].quantity = el.value; total(); });
          ov.querySelectorAll('[data-price]').forEach((el) => el.oninput = () => { lines[Number(el.dataset.price)].price = el.value; total(); });
          ov.querySelectorAll('[data-remove]').forEach((el) => el.onclick = () => { lines.splice(Number(el.dataset.remove), 1); render(); });
          total();
        };
        const total = () => { ov.querySelector('[data-total]').textContent = `${actual ? 'Actual spending' : 'Requested budget'}: ${pesos(lines.reduce((s,x) => s + (Number(x.quantity)||0)*(Number(x.price)||0),0))}`; };
        ov.querySelector('[data-add]').onclick = () => { lines.push({ name:'', quantity:1, price:'' }); render(); };
        render();
      },
      onConfirm: async (ov, showErr) => {
        const valid = lines.length && lines.every((x) => x.name.trim().length >= 2 && Number(x.quantity) > 0 && String(x.price).trim() !== '' && Number(x.price) >= 0);
        if (!valid) { showErr('Complete every item, quantity and price.'); return false; }
        const total = lines.reduce((s,x) => s + Number(x.quantity)*Number(x.price),0);
        if (!Number.isFinite(total) || total <= 0) { showErr('Total amount must be above zero.'); return false; }
        if (actual && Math.round(total*100) > Math.round(request.approved_budget*100)) { showErr('Actual spending exceeds the approved overall budget.'); return false; }
        if (!actual && ov.querySelector('[data-reason]').value.trim().length < 3) { showErr('Explain why this purchase is needed.'); return false; }
        try {
          if (actual) await API.post(`${base}/${request.id}/liquidation`, { note: ov.querySelector('[data-note]').value.trim() || null,
            items: lines.map((x) => ({ name:x.name.trim(), quantity:Number(x.quantity), actual_unit_price:Number(x.price) })) });
          else await API.post(base, { reason:ov.querySelector('[data-reason]').value.trim(), needed_by:ov.querySelector('[data-date]').value || null,
            items: lines.map((x) => ({ name:x.name.trim(), quantity:Number(x.quantity), estimated_unit_price:Number(x.price) })) });
          UI.toast(actual ? 'Liquidation submitted for review' : 'Purchase request submitted', 'success'); load();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function detail(id) {
    let r;
    try { r = await API.get(`${base}/${id}`); } catch (e) { UI.toast(e.message,'error'); return; }
    const isBuyer = canReview || r.buyer_id === App.getMe()?.id;
    const lineTable = (items, price) => `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>${items.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.quantity)}</td><td>${pesos(x[price])}</td><td>${pesos(x.quantity*x[price])}</td></tr>`).join('')}</tbody></table></div>`;
    const m = UI.modal({ title: r.number + ' · ' + r.status.replaceAll('_',' '), size:'lg', confirmText:null, cancelText:'Close',
      bodyHTML: `<p>${esc(r.reason)}</p><p class="muted">Needed by ${esc(r.needed_by || 'unspecified')}</p>
        <h4>Requested · ${pesos(r.requested_budget)}</h4>${lineTable(r.items,'estimated_unit_price')}
        ${r.approved_budget != null ? `<p><strong>Approved budget: ${pesos(r.approved_budget)}</strong> · ${r.purchase_mode === 'requester_cash' ? 'Cash to requester' : 'Assigned buyer'} · Buyer: ${esc(r.buyer_name || '—')} · Approved by ${esc(r.decided_by_name || '—')}</p>` : ''}
        ${r.decision_note ? `<p class="muted">Approval decision: ${esc(r.decision_note)}</p>` : ''}
        ${r.cash_issued != null ? `<p>Cash issued: ${pesos(r.cash_issued)}</p>` : ''}
        ${r.purchases.length ? `<h4>Actual purchases · ${pesos(r.actual_total)}</h4>${lineTable(r.purchases,'actual_unit_price')}` : ''}
        ${r.close_note ? `<p class="muted">Review note: ${esc(r.close_note)}</p>` : ''}${r.closed_by_name ? `<p class="muted">Closed by ${esc(r.closed_by_name)}</p>` : ''}
        ${r.receipts.length ? `<h4>Receipts</h4>${r.receipts.map((f) => `<span><button type="button" class="btn secondary small" data-receipt="${f.id}">${esc(f.original_name)}</button>
          ${isBuyer && r.status === 'approved' ? `<button type="button" class="btn secondary small" data-remove-receipt="${f.id}" aria-label="Remove ${esc(f.original_name)}">Remove</button>` : ''}</span>`).join(' ')}` : '<p class="muted">No receipts uploaded yet.</p>'}
        <div class="field-row" style="margin-top:16px">
          ${canReview && r.status === 'pending' ? '<button class="btn" data-action="approve">Approve budget</button><button class="btn secondary" data-action="reject">Reject</button>' : ''}
          ${canReview && r.status === 'approved' && r.purchase_mode === 'requester_cash' && r.cash_issued == null ? '<button class="btn" data-action="cash">Record cash issued</button>' : ''}
          ${isBuyer && r.status === 'approved' ? '<button class="btn secondary" data-action="receipt">Upload receipt</button><button class="btn" data-action="liquidate">Submit liquidation</button>' : ''}
          ${canReview && r.status === 'liquidation_submitted' ? '<button class="btn" data-action="close">Close after review</button><button class="btn secondary" data-action="return">Return for correction</button>' : ''}
        </div>`,
      onOpen: (ov) => {
        ov.querySelectorAll('[data-receipt]').forEach((b) => b.onclick = async () => { const f = r.receipts.find((x) => String(x.id) === b.dataset.receipt); try { await API.download(`${base}/${r.id}/receipts/${f.id}`, f.original_name); } catch(e) { UI.toast(e.message,'error'); } });
        ov.querySelectorAll('[data-remove-receipt]').forEach((b) => b.onclick = async () => {
          if (!(await UI.confirmDialog('Remove this receipt from the draft liquidation?', 'Remove'))) return;
          try { await API.del(`${base}/${r.id}/receipts/${b.dataset.removeReceipt}`); m.close(); detail(r.id); }
          catch (e) { UI.toast(e.message,'error'); }
        });
        ov.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => {
          m.close();
          const action = b.dataset.action;
          if (action === 'approve') approve(r); else if (action === 'reject') noteDecision(r,'reject');
          else if (action === 'cash') cash(r); else if (action === 'receipt') uploadReceipt(r);
          else if (action === 'liquidate') lineForm('liquidation',r);
          else if (action === 'close') close(r); else if (action === 'return') noteDecision(r,'return-liquidation');
        });
      },
    });
  }

  async function approve(r) {
    let buyers;
    try { buyers = await API.get(base + '/buyers'); } catch (e) { UI.toast(e.message,'error'); return; }
    UI.modal({ title:'Approve '+r.number, confirmText:'Approve budget', bodyHTML:
      `<p class="muted">Approval allows spending up to this overall amount. Choose who will buy; the request stays open until receipts and liquidation are reviewed.</p>
       <div class="form-field"><label>Approved budget *</label><input data-budget type="number" min="0.01" step="0.01" value="${esc(r.requested_budget)}"></div>
       <div class="form-field"><label>Purchase arrangement *</label><select data-mode><option value="requester_cash">Give cash to requester</option><option value="assigned_buyer">Assign purchasing personnel</option></select></div>
       <div class="form-field" data-buyer-wrap hidden><label>Buyer *</label><select data-buyer><option value="">Choose buyer</option>${buyers.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
       <div class="form-field"><label>Decision note (optional)</label><textarea data-note rows="2"></textarea></div>`,
      onOpen: (ov) => { ov.querySelector('[data-mode]').onchange = () => { ov.querySelector('[data-buyer-wrap]').hidden = ov.querySelector('[data-mode]').value !== 'assigned_buyer'; }; },
      onConfirm: async (ov, showErr) => {
        const budget = Number(ov.querySelector('[data-budget]').value), mode = ov.querySelector('[data-mode]').value;
        const buyer = Number(ov.querySelector('[data-buyer]').value) || null;
        if (!Number.isFinite(budget) || budget <= 0 || (mode === 'assigned_buyer' && !buyer)) { showErr('Enter a positive budget and select a buyer when needed.'); return false; }
        try { await API.post(`${base}/${r.id}/approve`, { approved_budget:budget, purchase_mode:mode, buyer_id:buyer, note:ov.querySelector('[data-note]').value.trim() || null }); UI.toast('Request approved','success'); load(); }
        catch(e) { showErr(e.message); return false; }
      },
    });
  }
  function noteDecision(r, action) {
    UI.modal({ title:action === 'reject' ? 'Reject '+r.number : 'Return liquidation for correction', confirmText:action === 'reject' ? 'Reject request' : 'Return to buyer',
      bodyHTML:'<div class="form-field"><label>Reason *</label><textarea data-note rows="3" maxlength="2000"></textarea></div>',
      onConfirm:async(ov,showErr)=>{ const note=ov.querySelector('[data-note]').value.trim(); if(note.length<3){showErr('Give a reason.');return false;}
        try{await API.post(`${base}/${r.id}/${action}`,{note});UI.toast('Decision recorded');load();}catch(e){showErr(e.message);return false;} },
    });
  }
  function cash(r) {
    UI.modal({ title:'Record cash issued · '+r.number, confirmText:'Record cash handoff', bodyHTML:
      `<p class="muted">Record the amount physically given to the requester. This can be less than the approved budget; liquidation will reconcile the difference.</p>
       <div class="form-field"><label>Cash given *</label><input data-amount type="number" min="0.01" step="0.01" value="${esc(r.approved_budget)}"></div>`,
      onConfirm:async(ov,showErr)=>{const amount=Number(ov.querySelector('[data-amount]').value);if(!Number.isFinite(amount)||amount<=0||amount>r.approved_budget){showErr('Amount must be within the approved budget.');return false;}
        try{await API.post(`${base}/${r.id}/issue-cash`,{amount});UI.toast('Cash handoff recorded','success');load();}catch(e){showErr(e.message);return false;} },
    });
  }
  function uploadReceipt(r) {
    UI.modal({ title:'Upload receipt · '+r.number, confirmText:'Upload receipt', bodyHTML:
      '<p class="muted">Upload a photo or PDF of the receipt, up to 8 MB.</p><div class="form-field"><label>Receipt file *</label><input type="file" data-file accept="image/jpeg,image/png,image/webp,application/pdf"></div>',
      onConfirm:async(ov,showErr)=>{const f=ov.querySelector('[data-file]').files[0];if(!f){showErr('Choose a receipt file.');return false;}
        const fd=new FormData();fd.append('file',f);try{await API.upload(`${base}/${r.id}/receipts`,fd);UI.toast('Receipt uploaded','success');load();}catch(e){showErr(e.message);return false;} },
    });
  }
  function close(r) {
    const change = r.purchase_mode === 'requester_cash' ? Math.max(0,Math.round((r.cash_issued-r.actual_total)*100)/100) : 0;
    const reimburse = r.purchase_mode === 'requester_cash' ? Math.max(0,Math.round((r.actual_total-r.cash_issued)*100)/100) : 0;
    UI.modal({ title:'Close '+r.number, confirmText:'Confirm liquidation & close', bodyHTML:
      `<p>Review every purchased item and receipt before closing. Actual spending: <strong>${pesos(r.actual_total)}</strong>.</p>
       ${r.purchase_mode === 'requester_cash' ? `<p>Change returned: <strong>${pesos(change)}</strong>; reimbursement paid: <strong>${pesos(reimburse)}</strong>.</p>
         <label><input type="checkbox" data-cash-check> I confirm the change was received and any reimbursement was paid.</label>` : ''}
       <div class="form-field"><label>Closing note (optional)</label><textarea data-note rows="2"></textarea></div>`,
      onConfirm:async(ov,showErr)=>{if(r.purchase_mode==='requester_cash'&&!ov.querySelector('[data-cash-check]').checked){showErr('Confirm the cash reconciliation before closing.');return false;}
        try{await API.post(`${base}/${r.id}/close`,{cash_returned:change,reimbursed_amount:reimburse,note:ov.querySelector('[data-note]').value.trim()||null});UI.toast('PR closed','success');load();}catch(e){showErr(e.message);return false;} },
    });
  }
  await load();
});
