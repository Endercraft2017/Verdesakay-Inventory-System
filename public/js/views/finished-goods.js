/* Production → Finished Goods: a cross-product view of finished stock actually on hand —
   what Products In has received, ready to sell or move — across every finished product at a
   glance, instead of opening each one individually. Row click reuses Finished Products' own
   detail modal (BOM, cost, per-unit/location breakdown, Print QR labels, Sell / Move) via
   filter.open rather than duplicating that UI. */
App.register('finished-goods', async (view) => {
  view.innerHTML = `
    <div class="topbar">
      <h2>Finished Goods <span class="muted" style="font-weight:400;font-size:14px">On hand, ready to sell or move</span></h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="fg-q" placeholder="Search product, SKU…" /></div>
    </div>
    <div class="panel"><div id="fg-table"><div class="empty">Loading…</div></div></div>`;

  const tableEl = view.querySelector('#fg-table');
  let list = [];
  let q = '';

  async function load() {
    list = await API.get('/finished-products').catch(() => []);
    render();
  }

  function render() {
    const rows = list
      .filter((p) => (p.quantity || 0) > 0)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q))
      .sort((a, b) => b.quantity - a.quantity);

    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'sparkles',
        title: list.some((p) => (p.quantity || 0) > 0) ? 'No matching finished goods' : 'Nothing in stock yet',
        hint: list.some((p) => (p.quantity || 0) > 0)
          ? 'Try a different search.'
          : 'Finished goods show up here once Products In receives them.',
      });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Product</th><th class="right">In stock</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr class="clickable" data-open="${p.id}">
            <td><strong>${UI.esc(p.name)}</strong><div class="muted mono">${UI.esc(p.sku || '—')}</div></td>
            <td class="right">${p.quantity} ${UI.esc(p.unit || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) =>
      tr.onclick = () => App.navigate('finished-products', { open: tr.dataset.open }));
  }

  view.querySelector('#fg-q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); render(); });
  await load();
});
