/* Dashboard: stats overview + low-stock list + recent messages. */
App.register('dashboard', async (view) => {
  const me = App.getMe();
  const [stats, items, inbox] = await Promise.all([
    API.get('/inventory/stats'),
    API.get('/inventory?low=1'),
    API.get('/messages?box=inbox'),
  ]);

  const recent = inbox.slice(0, 5);

  view.innerHTML = `
    <div class="topbar"><h2>Welcome, ${UI.esc(me.full_name.split(' ')[0])}</h2><div class="grow"></div></div>

    <div class="cards">
      <div class="stat-card"><div class="label">Inventory Items</div><div class="value">${stats.items}</div></div>
      <div class="stat-card"><div class="label">Total Units</div><div class="value">${stats.total_units}</div></div>
      <div class="stat-card warn"><div class="label">Low Stock</div><div class="value">${stats.low_stock || 0}</div></div>
      <div class="stat-card alert"><div class="label">Out of Stock</div><div class="value">${stats.out_of_stock || 0}</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
      <div class="panel">
        <div class="panel-head"><h3>⚠️ Items needing restock</h3><div class="grow" style="flex:1"></div>
          <button class="btn small secondary" data-go="inventory">View all</button></div>
        <div>${items.length ? `<table><tbody>${items.map((i) => `
          <tr><td>${UI.esc(i.name)}<div class="muted mono">${UI.esc(i.sku || '')}</div></td>
          <td class="right"><span class="badge-pill low">${i.quantity} ${UI.esc(i.unit || '')}</span>
          <div class="muted" style="font-size:12px;">min ${i.min_quantity}</div></td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">Everything is well stocked. 🎉</div>'}</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>✉️ Recent messages</h3><div class="grow" style="flex:1"></div>
          <button class="btn small secondary" data-go="messages">Open inbox</button></div>
        <div>${recent.length ? `<div class="msg-list">${recent.map((m) => `
          <div class="msg-row ${m.read_at ? '' : 'unread'}" data-go="messages">
            <div class="avatar">${UI.esc(UI.initials(m.other_name))}</div>
            <div class="meta"><div class="who">${UI.esc(m.other_name)}</div>
            <div class="preview">${UI.esc(m.subject || m.body)}</div></div>
            <div class="when">${UI.fmtDateShort(m.created_at)}</div>
          </div>`).join('')}</div>` : '<div class="empty">No messages yet.</div>'}</div>
      </div>
    </div>`;

  view.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => App.navigate(b.dataset.go)));
});
