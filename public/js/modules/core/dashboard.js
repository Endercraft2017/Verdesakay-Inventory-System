/* Dashboard: stats overview, quick actions, low-stock list + recent messages. */
App.register('dashboard', async (view) => {
  const me = App.getMe();
  const canInv = App.hasPermission('inventory.view') && App.hasModule('inventory');
  const canMsg = App.hasPermission('messages.view');
  const canForms = App.hasPermission('forms.view');
  const canUsers = App.hasPermission('users.manage');
  const canHr = App.hasPermission('hr.view') && App.hasModule('hr');

  const [stats, items, inbox, forms, unread, users, hrOverview] = await Promise.all([
    canInv ? API.get('/inventory/stats') : Promise.resolve({ items: 0, total_units: 0, low_stock: 0, out_of_stock: 0 }),
    canInv ? API.get('/inventory?low=1') : Promise.resolve([]),
    canMsg ? API.get('/messages?box=inbox') : Promise.resolve([]),
    canForms ? API.get('/forms') : Promise.resolve([]),
    canMsg ? API.get('/messages/unread-count') : Promise.resolve({ count: 0 }),
    canUsers ? API.get('/users') : Promise.resolve(null),
    canHr ? API.get('/analytics/overview').catch(() => null) : Promise.resolve(null),
  ]);
  const incompleteTk = hrOverview && hrOverview.payroll ? (hrOverview.payroll.incomplete_timekeeping || 0) : 0;

  const recent = inbox.slice(0, 5);

  const statCard = (cls, ic, label, value, go) => `
    <div class="stat-card ${cls}${go ? ' clickable' : ''}" ${go ? `data-go="${go}"` : ''}>
      <div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${label}</div></div>
    </div>`;

  view.innerHTML = `
    <div class="topbar">
      <div><h2>Welcome back, ${UI.esc(me.full_name.split(' ')[0])}</h2>
      <div class="sub">Here's what's happening across the office.</div></div>
      <div class="grow"></div>
      ${canInv ? `<button class="btn secondary" data-go="inventory">${UI.icon('plus')} Item</button>` : ''}
      <button class="btn secondary" data-go="forms">${UI.icon('upload')} Upload</button>
      <button class="btn" data-go="messages">${UI.icon('edit')} Message</button>
    </div>

    <div class="cards">
      ${canInv ? statCard('', 'inventory', 'Inventory items', stats.items) : ''}
      ${canInv ? statCard('warn', 'alert', 'Low stock', stats.low_stock || 0) : ''}
      ${canInv ? statCard('alert', 'alert', 'Out of stock', stats.out_of_stock || 0) : ''}
      ${statCard('', 'forms', 'Files available', forms.length)}
      ${statCard('', 'messages', 'Unread messages', unread.count)}
      ${canUsers ? statCard('', 'users', 'Staff accounts', users.length) : ''}
      ${canHr ? statCard(incompleteTk > 0 ? 'warn' : '', 'history', 'Incomplete timekeeping', incompleteTk, 'hr-timekeeping') : ''}
    </div>

    <div class="grid-2">
      ${canInv ? `<div class="panel">
        <div class="panel-head"><h3>Items needing restock</h3><div class="grow"></div>
          <button class="btn small secondary" data-go="inventory">View all</button></div>
        <div>${items.length ? `<table><tbody>${items.map((i) => `
          <tr><td>${UI.esc(i.name)}<div class="muted mono">${UI.esc(i.sku || '—')}</div></td>
          <td class="right"><span class="badge-pill low">${i.quantity} ${UI.esc(i.unit || '')}</span>
          <div class="muted" style="font-size:11px;margin-top:2px">min ${i.min_quantity}</div></td></tr>`).join('')}
          </tbody></table>` : UI.emptyState({ icon: 'inventory', title: 'Everything is well stocked', hint: 'No items are at or below their reorder level.' })}</div>
      </div>` : ''}

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
