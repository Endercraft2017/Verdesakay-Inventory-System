/* Dashboard: stats overview + low-stock list + recent messages. */
App.register('dashboard', async (view) => {
  const me = App.getMe();
  const [stats, items, inbox] = await Promise.all([
    API.get('/inventory/stats'),
    API.get('/inventory?low=1'),
    API.get('/messages?box=inbox'),
  ]);

  const recent = inbox.slice(0, 5);

  const statCard = (cls, ic, label, value) => `
    <div class="stat-card ${cls}">
      <div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${label}</div></div>
    </div>`;

  view.innerHTML = `
    <div class="topbar">
      <div><h2>Welcome back, ${UI.esc(me.full_name.split(' ')[0])}</h2>
      <div class="sub">Here's what's happening across the office.</div></div>
      <div class="grow"></div>
    </div>

    <div class="cards">
      ${statCard('', 'inventory', 'Inventory items', stats.items)}
      ${statCard('', 'dashboard', 'Total units', stats.total_units)}
      ${statCard('warn', 'alert', 'Low stock', stats.low_stock || 0)}
      ${statCard('alert', 'alert', 'Out of stock', stats.out_of_stock || 0)}
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h3>Items needing restock</h3><div class="grow"></div>
          <button class="btn small secondary" data-go="inventory">View all</button></div>
        <div>${items.length ? `<table><tbody>${items.map((i) => `
          <tr><td>${UI.esc(i.name)}<div class="muted mono">${UI.esc(i.sku || '—')}</div></td>
          <td class="right"><span class="badge-pill low">${i.quantity} ${UI.esc(i.unit || '')}</span>
          <div class="muted" style="font-size:11px;margin-top:2px">min ${i.min_quantity}</div></td></tr>`).join('')}
          </tbody></table>` : UI.emptyState({ icon: 'inventory', title: 'Everything is well stocked', hint: 'No items are at or below their reorder level.' })}</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Recent messages</h3><div class="grow"></div>
          <button class="btn small secondary" data-go="messages">Open inbox</button></div>
        <div>${recent.length ? `<div class="msg-list">${recent.map((m) => `
          <div class="msg-row ${m.read_at ? '' : 'unread'}" data-go="messages">
            <div class="avatar">${UI.esc(UI.initials(m.other_name))}</div>
            <div class="meta"><div class="who">${UI.esc(m.other_name)}</div>
            <div class="preview">${UI.esc(m.subject || m.body)}</div></div>
            <div class="when">${UI.fmtDateShort(m.created_at)}</div>
          </div>`).join('')}</div>` : UI.emptyState({ icon: 'messages', title: 'No messages yet', hint: 'Your recent conversations will appear here.' })}</div>
      </div>
    </div>`;

  view.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => App.navigate(b.dataset.go)));
});
