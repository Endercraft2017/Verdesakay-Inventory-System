/* Sales owns commercial orders. Inventory tracks their fulfillment separately. */
App.register('sales-overview', async (view) => {
  view.innerHTML = '<div class="topbar"><h2>Sales overview</h2></div><div class="panel"><div class="empty">Loading sales…</div></div>';
  try {
    const data = await API.get('/analytics/overview');
    const sales = data.sales;
    if (!sales) throw new Error('Sales reporting is unavailable for this account.');
    const money = (value) => UI.money(value || 0);
    const card = (label, count, value) => `<article class="stat-card"><div><div class="value">${UI.esc(count)}</div><div class="label">${UI.esc(label)} · ${money(value)}</div></div></article>`;
    const max = Math.max(1, ...sales.weekly.map((week) => week.value));
    view.innerHTML = `<div class="sales-dashboard">
      <div class="topbar"><h2>Sales overview</h2><div class="grow"></div>
        <button class="btn secondary" id="sales-refresh">${UI.icon('history', 15)} Refresh</button></div>
      <p class="muted">Sale order value and fulfillment status. Values reflect orders, not payments received.</p>
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
        <button class="btn secondary" id="sales-open-customers">Customers</button></div></div>`;
    view.querySelector('#sales-refresh').onclick = () => App.navigate('sales-overview');
    view.querySelector('#sales-open-orders').onclick = () => App.navigate('orders', { type: 'sale' });
    view.querySelector('#sales-open-customers').onclick = () => App.navigate('customers');
  } catch (error) {
    view.innerHTML = `<div class="topbar"><h2>Sales overview</h2></div><div class="panel"><p role="alert">${UI.esc(error.message)}</p><button class="btn secondary" id="sales-retry">Try again</button></div>`;
    view.querySelector('#sales-retry').onclick = () => App.navigate('sales-overview');
  }
});
