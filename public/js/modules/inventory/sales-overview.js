/* Sales owns commercial orders. Inventory tracks their fulfillment separately. */
App.register('sales-overview', async (view) => {
  view.innerHTML = '<div class="topbar"><h2>Sales overview</h2></div><div class="panel"><div class="empty">Loading sales…</div></div>';
  try {
    const [data, orders, queue] = await Promise.all([
      API.get('/analytics/overview'), API.get('/orders?type=sale'), API.get('/release-slips/queue'),
    ]);
    const sales = data.sales;
    if (!sales) throw new Error('Sales reporting is unavailable for this account.');
    const money = (value) => UI.money(value || 0);
    const card = (label, count, value) => `<article class="stat-card"><div><div class="value">${UI.esc(count)}</div><div class="label">${UI.esc(label)} · ${money(value)}</div></div></article>`;
    const max = Math.max(1, ...sales.weekly.map((week) => week.value));
    const accepted = new Set(queue.releasing.map((o) => Number(o.id)));
    const waiting = new Set(queue.to_accept.map((o) => Number(o.id)));
    const stages = [
      { title: 'CSR review', hint: 'Draft and open orders', orders: [] },
      { title: 'Awaiting warehouse', hint: 'Approved, awaiting acceptance', orders: [] },
      { title: 'Picking & release', hint: 'Accepted or partly released', orders: [] },
      { title: 'Shipped / complete', hint: 'Release slip issued or completed', orders: [] },
    ];
    for (const order of orders) {
      const status = String(order.status || '').toLowerCase();
      if (status === 'cancelled') continue;
      const stage = (order.release_slip_number && !order.backordered) || status === 'completed' || status === 'fulfilled' ? stages[3]
        : accepted.has(Number(order.id)) || status === 'released' ? stages[2]
        : waiting.has(Number(order.id)) || status === 'approved' ? stages[1] : stages[0];
      stage.orders.push(order);
    }
    const attention = orders.filter((o) => o.backordered && !['cancelled', 'completed', 'fulfilled'].includes(String(o.status).toLowerCase()));
    view.innerHTML = `<div class="sales-dashboard">
      <div class="topbar"><h2>Sales pipeline</h2><div class="grow"></div>
        <button class="btn secondary" id="sales-refresh">${UI.icon('history', 15)} Refresh</button></div>
      <p class="muted">Follow each sale from CSR review to warehouse release. Stock leaves when a release slip is issued.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:16px 0">
        ${stages.map((stage) => `<article class="panel" style="min-width:210px;flex:1;margin:0">
          <div class="muted" style="font-size:12px">${UI.esc(stage.title)}</div><div style="font-size:26px;font-weight:700;margin:7px 0">${stage.orders.length}</div>
          <div class="muted" style="font-size:12px">${UI.esc(stage.hint)}</div>
          ${stage.orders.slice(0, 4).map((order) => `<button class="btn secondary small" data-order="${order.id}" style="display:block;width:100%;text-align:left;margin-top:6px;white-space:normal">${UI.esc(order.number)} · ${UI.esc(order.customer_name || 'Walk-in')}</button>`).join('')}
          ${stage.orders.length > 4 ? `<div class="muted" style="margin-top:8px">+${stage.orders.length - 4} more in Sale Orders</div>` : ''}
        </article>`).join('')}
      </div>
      <div class="panel"><h3>Needs attention · ${attention.length}</h3>
        ${attention.length ? `<div class="table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Next step</th></tr></thead><tbody>
        ${attention.slice(0, 12).map((order) => `<tr><td><button class="btn secondary small" data-order="${order.id}">${UI.esc(order.number)}</button></td><td>${UI.esc(order.customer_name || 'Walk-in')}</td><td>${UI.esc(order.status)}</td><td>${accepted.has(Number(order.id)) ? 'Complete picking or resolve shortage' : 'Review stock and hand off to warehouse'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No open order has an outstanding stock line.</p>'}</div>
      <div class="cards">
        ${card('Open sale orders', sales.open_orders, sales.open_value)}
        ${card('Awaiting stock or release', sales.backorder_count, sales.backorder_value)}
      </div>
      <div class="panel"><h3>Orders by status</h3>
        <div class="cards">${Object.entries(sales.by_status).map(([status, detail]) => card(status.replaceAll('_', ' '), detail.count, detail.value)).join('') || '<p class="muted">No sale orders yet.</p>'}</div></div>
      <div class="panel"><h3>Sale orders · last 8 weeks</h3>
        ${sales.weekly.length ? `<div class="table-scroll"><table><thead><tr><th>Week</th><th class="right">Orders</th><th class="right">Value</th><th>Trend</th></tr></thead>
          <tbody>${sales.weekly.map((week) => `<tr><td>${UI.esc(week.week)}</td><td class="right">${week.count}</td><td class="right">${money(week.value)}</td><td><div style="background:var(--accent);height:10px;border-radius:5px;width:${Math.round(week.value / max * 100)}%"></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No sale orders in the last 8 weeks.</div>'}</div>
      <div class="sales-actions"><button class="btn" id="sales-open-orders">View sale orders</button>
        <button class="btn secondary" id="sales-open-customers">Customers</button>
        ${App.hasPermission('orders.release') ? '<button class="btn secondary" id="sales-open-release">Release queue</button>' : ''}</div></div>`;
    view.querySelector('#sales-refresh').onclick = () => App.navigate('sales-overview');
    view.querySelector('#sales-open-orders').onclick = () => App.navigate('orders', { type: 'sale' });
    view.querySelector('#sales-open-customers').onclick = () => App.navigate('customers');
    const release = view.querySelector('#sales-open-release');
    if (release) release.onclick = () => App.navigate('releasing', { tab: 'queue' });
    view.querySelectorAll('[data-order]').forEach((button) => button.onclick = () => {
      const order = orders.find((o) => String(o.id) === button.dataset.order);
      if (order) App.navigate('orders', { type: 'sale', id: order.id });
    });
  } catch (error) {
    view.innerHTML = `<div class="topbar"><h2>Sales overview</h2></div><div class="panel"><p role="alert">${UI.esc(error.message)}</p><button class="btn secondary" id="sales-retry">Try again</button></div>`;
    view.querySelector('#sales-retry').onclick = () => App.navigate('sales-overview');
  }
});
