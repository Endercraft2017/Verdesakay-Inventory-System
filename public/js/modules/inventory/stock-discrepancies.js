/* Inventory → Stock Discrepancies (docs/OFFLINE-FIRST.md decision D1).

   When someone working offline takes out more than the records show, the stock-out is still
   recorded (the goods did leave) and the location goes below zero. Each such case opens a
   discrepancy here: count the location, correct the stock with a normal adjustment if needed,
   then resolve it with a note. Resolving moves no stock by itself. */
App.register('stock-discrepancies', async (view) => {
  const canResolve = App.hasPermission('inventory.adjust');
  let status = 'open';

  view.innerHTML = `
    <div class="topbar">
      <h2>Stock Discrepancies</h2>
      <div class="grow"></div>
      <div class="subnav-inline" id="sd-tabs">
        <button class="tab active" data-status="open">Open</button>
        <button class="tab" data-status="resolved">Resolved</button>
        <button class="tab" data-status="all">All</button>
      </div>
    </div>
    <p class="muted small">An offline stock-out was recorded although the records showed too little stock there.
      Count the location, correct the quantity with a stock adjustment if needed, then resolve it.</p>
    <div class="panel"><div id="sd-table"></div></div>`;

  const tableEl = view.querySelector('#sd-table');
  view.querySelectorAll('[data-status]').forEach((b) => b.onclick = () => {
    status = b.dataset.status;
    view.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const rows = await API.get('/inventory/discrepancies?status=' + status);
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
