/* Inventory → Stock Discrepancies (docs/OFFLINE-FIRST.md decision D1).

   When someone working offline takes out more than the records show, the stock-out is still
   recorded (the goods did leave) and the location goes below zero. Each such case opens a
   discrepancy here: count the location, correct the stock with a normal adjustment if needed,
   then resolve it with a note. Resolving moves no stock by itself. */
App.register('stock-discrepancies', async (view) => {
  const canResolve = App.hasPermission('inventory.adjust');
  let mode = 'discrepancies';
  let status = 'open';

  view.innerHTML = `
    <div class="topbar">
      <h2>Stock Review</h2>
      <div class="grow"></div>
      <div class="subnav-inline" id="sd-modes">
        <button class="tab active" data-mode="discrepancies">Stock discrepancies</button>
        <button class="tab" data-mode="sale-audit">Direct-sale audit</button>
      </div>
      <div class="subnav-inline" id="sd-tabs">
        <button class="tab active" data-status="open">Open</button>
        <button class="tab" data-status="resolved">Resolved</button>
        <button class="tab" data-status="all">All</button>
      </div>
    </div>
    <p class="muted small" id="sd-help">An offline stock-out was recorded although the records showed too little stock there.
      Count the location, correct the quantity with a stock adjustment if needed, then resolve it.</p>
    <div class="panel" style="overflow-x:auto"><div id="sd-table"></div></div>`;

  const tableEl = view.querySelector('#sd-table');
  view.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
    mode = b.dataset.mode;
    status = 'open';
    view.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
    view.querySelector('#sd-help').textContent = mode === 'sale-audit'
      ? 'Possible duplicate deductions on older direct sales. Compare the ledger with the shipment and count physical stock before any separate adjustment. Reviewing this evidence does not change stock.'
      : 'An offline stock-out was recorded although the records showed too little stock there. Count the location, correct the quantity with a stock adjustment if needed, then resolve it.';
    view.querySelectorAll('[data-status]').forEach((x) => {
      x.textContent = x.dataset.status === 'resolved' ? (mode === 'sale-audit' ? 'Reviewed' : 'Resolved') : x.dataset.status[0].toUpperCase() + x.dataset.status.slice(1);
      x.classList.toggle('active', x.dataset.status === 'open');
    });
    load();
  });
  view.querySelectorAll('[data-status]').forEach((b) => b.onclick = () => {
    status = b.dataset.status === 'resolved' && mode === 'sale-audit' ? 'reviewed' : b.dataset.status;
    view.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    if (mode === 'sale-audit') {
      const rows = await API.get('/inventory/direct-sale-audit?status=' + status);
      if (mode !== 'sale-audit') return;
      renderSaleAudit(rows);
      return;
    }
    const rows = await API.get('/inventory/discrepancies?status=' + status);
    if (mode !== 'discrepancies') return;
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'check',
        title: status === 'open' ? 'No open discrepancies' : 'Nothing here',
        hint: status === 'open' ? 'Offline stock-outs that went below the recorded stock appear here.' : '',
      });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Item</th><th>Location</th><th class="right">Taken out</th><th class="right">Left after</th>
          <th class="right">Now</th><th>Reason</th><th>By / when</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map((d) => `
          <tr>
            <td><strong>${UI.esc(d.item_name)}</strong>${d.sku ? ` <span class="muted small">${UI.esc(d.sku)}</span>` : ''}</td>
            <td>${UI.esc(d.location_name || '—')}</td>
            <td class="right">${-d.change}</td>
            <td class="right">${d.location_balance_after}</td>
            <td class="right">${d.location_quantity_now}</td>
            <td>${UI.esc(d.reason || '—')}</td>
            <td>${UI.esc(d.created_by_name || '—')}<div class="muted small">${UI.fmtDate(d.created_at)}</div></td>
            <td>${d.status === 'open'
              ? '<span class="badge-pill low">open</span>'
              : `<span class="badge-pill ok">resolved</span><div class="muted small">${UI.esc(d.resolution_note || '')}</div>`}</td>
            <td class="actions">${d.status === 'open' && canResolve
              ? `<button class="btn secondary small" data-resolve="${d.id}">Resolve</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = () => resolve(rows.find((x) => x.id == b.dataset.resolve)));
  }

  function renderSaleAudit(rows) {
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({icon: 'check', title: status === 'open' ? 'No open direct-sale cases' : 'Nothing here',
        hint: 'The ledger and shipped quantities have no currently flagged excess.'});
      return;
    }
    tableEl.innerHTML = `<table><thead><tr><th>Sale / item</th><th class="right">Shipped</th><th class="right">Removed</th>
      <th class="right">Awaiting slip</th><th class="right">Possible extra</th><th class="right">On hand now</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((d, idx) => `<tr><td><strong>${UI.esc(d.order_number)}</strong><div>${UI.esc(d.item_name)}${d.sku ? ` · ${UI.esc(d.sku)}` : ''}</div></td>
      <td class="right">${d.shipped_quantity}</td><td class="right">${d.removed_quantity}</td><td class="right">${d.awaiting_slip_quantity}</td>
      <td class="right"><strong>${d.possible_extra_quantity}</strong></td><td class="right">${d.on_hand}</td>
      <td>${d.status === 'reviewed' ? '<span class="badge-pill ok">reviewed</span>' : '<span class="badge-pill low">open</span>'}</td>
      <td><button class="btn secondary small" data-audit="${idx}">Evidence</button></td></tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('[data-audit]').forEach((b) => b.onclick = () => showAudit(rows[Number(b.dataset.audit)]));
  }

  function showAudit(d) {
    UI.modal({
      title: `Direct-sale audit · ${d.order_number}`,
      bodyHTML: `<p><strong>${UI.esc(d.item_name)}</strong> · possible extra ${d.possible_extra_quantity}; current on hand ${d.on_hand}.</p>
        <p class="muted small">${d.shipped_quantity} shipped on ${d.slip_count} slip(s), ${d.removed_quantity} removed in ${d.movement_count} sale movement(s), ${d.awaiting_slip_quantity} directly sold unit(s) awaiting a slip. The latest 50 movements are shown.</p>
        <div style="max-height:240px;overflow:auto"><table><thead><tr><th>When</th><th>Stock change</th><th>Location</th><th>Reason</th></tr></thead><tbody>
          ${d.movements.map((m) => `<tr><td>${UI.fmtDate(m.created_at)}</td><td>${m.change}</td><td>${UI.esc(m.location_name || '—')}</td><td>${UI.esc(m.reason)}</td></tr>`).join('')}
        </tbody></table></div>
        ${d.review ? `<p class="small">Previous review by ${UI.esc(d.review.reviewer_name || 'unknown')} · ${UI.fmtDate(d.review.reviewed_at)}${d.review.stale ? ' · evidence changed since review' : ''}<br>${UI.esc(d.review.note)}</p>` : ''}
        ${d.status === 'open' && canResolve ? '<label for="sd-audit-note">Count and findings</label><textarea id="sd-audit-note" rows="3" maxlength="1000" placeholder="Record the physical count, checked location, and any separate correction reference"></textarea>' : ''}
        <p class="muted small">Reviewing does not adjust stock. Make any verified correction through the normal stock adjustment flow.</p>`,
      confirmText: d.status === 'open' && canResolve ? 'Mark reviewed' : 'Close',
      onConfirm: async (overlay) => {
        if (d.status !== 'open' || !canResolve) return;
        const note = overlay.querySelector('#sd-audit-note').value.trim();
        if (note.length < 10) throw new Error('Describe the physical count and what you found (at least 10 characters).');
        await API.post(`/inventory/direct-sale-audit/${d.order_id}/${d.item_id}/review`, {evidence_hash: d.evidence_hash, note});
        UI.toast('Audit evidence reviewed');
        load();
      },
    });
  }

  function resolve(d) {
    UI.modal({
      title: 'Resolve discrepancy',
      bodyHTML: `
        <p><strong>${UI.esc(d.item_name)}</strong> at ${UI.esc(d.location_name || '—')} — now ${d.location_quantity_now}.</p>
        <label>What was found / done</label>
        <textarea id="sd-note" rows="3" placeholder="e.g. Counted 12 on the shelf; adjusted stock to 12"></textarea>`,
      confirmText: 'Resolve',
      onConfirm: async (overlay) => {
        await API.post('/inventory/discrepancies/' + d.id + '/resolve', { note: overlay.querySelector('#sd-note').value });
        UI.toast('Discrepancy resolved');
        if (window.SyncStatus) SyncStatus.refresh();
        load();
      },
    });
  }

  load();
});
