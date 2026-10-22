/* CSR desk. Its stages are derived from existing sale and release records. */
App.register('sales-service', async (view) => {
  view.innerHTML = '<div class="topbar"><h2>Customer service</h2></div><div class="panel"><div class="empty">Loading customer orders…</div></div>';
  try {
    const orders = await API.get('/orders?type=sale');
    const stage = (o) => {
      const s = String(o.status || '').toLowerCase();
      if (s === 'cancelled') return 'Cancelled';
      if (s === 'completed' || s === 'fulfilled') return 'Complete';
      if (o.release_slip_number && !o.backordered) return 'Shipped';
      if (s === 'released' || o.release_slip_number) return 'In release';
      if (s === 'approved') return 'Waiting for warehouse';
      return 'Needs CSR review';
    };
    const active = orders.filter((o) => !['Cancelled', 'Complete', 'Shipped'].includes(stage(o)));
    view.innerHTML = `<div class="sales-service"><div class="topbar"><h2>Customer service</h2><div class="grow"></div>
      ${App.hasPermission('orders.create') ? '<button class="btn" id="csr-new">New sale order</button>' : ''}
      <button class="btn secondary" id="csr-customers">Customers</button><button class="btn secondary" id="csr-refresh">Refresh</button></div>
      <p class="muted">Find a customer order, confirm its stage, and open it for review or follow-up.</p>
      <div class="cards"><article class="stat-card"><div><div class="value">${active.length}</div><div class="label">Active customer orders</div></div></article>
        <article class="stat-card"><div><div class="value">${orders.filter((o) => o.backordered).length}</div><div class="label">Goods awaiting release</div></div></article></div>
      <div class="topbar"><div class="search-box search">${UI.icon('search', 16)}<input id="csr-search" aria-label="Search customer orders" placeholder="Search order or customer…"></div>
        <select id="csr-stage" aria-label="Filter customer order stage"><option value="active">Active orders</option><option value="all">All orders</option><option value="Needs CSR review">Needs CSR review</option><option value="Waiting for warehouse">Waiting for warehouse</option><option value="In release">In release</option><option value="shipped">Shipped or complete</option></select></div>
      <div class="panel"><div id="csr-list"></div></div></div>`;
    const list = view.querySelector('#csr-list');
    const search = view.querySelector('#csr-search');
    const filter = view.querySelector('#csr-stage');
    function render() {
      const q = search.value.trim().toLowerCase();
      const matches = orders.filter((o) => {
        const s = stage(o);
        return (!q || `${o.number} ${o.customer_name || ''}`.toLowerCase().includes(q)) &&
          (filter.value === 'all' || filter.value === 'active' && !['Cancelled', 'Complete', 'Shipped'].includes(s) ||
           filter.value === 'shipped' && ['Complete', 'Shipped'].includes(s) || s === filter.value);
      });
      list.innerHTML = matches.length ? `<div class="orders-table-scroll"><table><thead><tr><th>Order</th><th>Customer</th><th>Stage</th><th>Outstanding</th><th></th></tr></thead><tbody>
        ${matches.map((o) => `<tr><td><strong>${UI.esc(o.number)}</strong></td><td>${UI.esc(o.customer_name || 'Walk-in')}</td><td>${UI.esc(stage(o))}</td>
          <td>${o.backordered ? '<span class="badge-pill low">Goods pending</span>' : '—'}</td>
          <td><button class="btn secondary small" data-open="${o.id}" aria-label="Open ${UI.esc(o.number)}">Open</button></td></tr>`).join('')}
        </tbody></table></div>` : UI.emptyState({ icon: 'forms', title: 'No matching customer orders', hint: q ? 'Try another order number or customer.' : 'Choose another stage, or create a sale order.' });
      list.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => App.navigate('orders', { type: 'sale', id: Number(b.dataset.open) }));
    }
    search.addEventListener('input', render);
    filter.addEventListener('change', render);
    view.querySelector('#csr-new')?.addEventListener('click', () => App.navigate('orders', { type: 'sale', new: '1' }));
    view.querySelector('#csr-customers').onclick = () => App.navigate('customers');
    view.querySelector('#csr-refresh').onclick = () => App.navigate('sales-service');
    render();
  } catch (error) {
    view.innerHTML = `<div class="topbar"><h2>Customer service</h2></div><div class="panel"><p role="alert">${UI.esc(error.message)}</p><button class="btn secondary" id="csr-retry">Try again</button></div>`;
    view.querySelector('#csr-retry').onclick = () => App.navigate('sales-service');
  }
});
