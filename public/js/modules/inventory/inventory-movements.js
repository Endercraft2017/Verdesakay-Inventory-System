/* Inventory → Stock Movements: the cross-item stock-movement feed (read-only). */
App.register('inventory-movements', async (view) => {
  const state = { q: '', dir: '', location_id: '', from: '', to: '', offset: 0, limit: 100 };
  let last = { rows: [], total: 0 };

  view.innerHTML = `
    <div class="topbar">
      <h2>Stock Movements</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="mv-q" placeholder="Search item, SKU, reason…" /></div>
      <select id="mv-dir" style="width:120px">
        <option value="">All</option><option value="in">Stock IN</option><option value="out">Stock OUT</option>
      </select>
      <select id="mv-loc" style="width:150px"><option value="">— Location —</option></select>
      <label class="inline-date">From <input type="date" id="mv-from" /></label>
      <label class="inline-date">To <input type="date" id="mv-to" /></label>
      <button class="btn secondary" id="mv-export">${UI.icon('download')} Export</button>
    </div>
    <div class="panel"><div id="mv-table"></div></div>
    <div class="pager" id="mv-pager"></div>`;

  const tableEl = view.querySelector('#mv-table');
  const pagerEl = view.querySelector('#mv-pager');

  API.get('/locations').then((locs) => {
    view.querySelector('#mv-loc').innerHTML = '<option value="">— Location —</option>' +
      locs.map((l) => `<option value="${l.id}">${UI.esc(l.path || l.name)}</option>`).join('');
  }).catch(() => {});

  async function load() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.dir) p.set('dir', state.dir);
    if (state.location_id) p.set('location_id', state.location_id);
    if (state.from) p.set('from', state.from);
    if (state.to) p.set('to', state.to + ' 23:59:59');
    p.set('limit', state.limit);
    p.set('offset', state.offset);
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    last = await API.get('/inventory/movements?' + p.toString());
    render();
  }

  function render() {
    const { rows, total } = last;
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'adjust', title: 'No movements',
        hint: 'Stock in/out activity across every item shows up here.',
      });
      pagerEl.innerHTML = '';
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>When</th><th>Item</th><th>Location</th><th class="right">Change</th>
          <th class="right">At loc.</th><th class="right">Total</th><th>Reason</th><th>By</th>
        </tr></thead>
        <tbody>${rows.map((h) => `
          <tr>
            <td>${UI.fmtDate(h.created_at)}</td>
            <td><strong>${UI.esc(h.item_name || '—')}</strong><div class="muted mono">${UI.esc(h.item_sku || '')}</div></td>
            <td>${UI.esc(h.location_name || '—')}</td>
            <td class="right"><strong style="color:${h.change < 0 ? 'var(--danger)' : 'var(--success)'}">${h.change > 0 ? '+' : ''}${h.change}</strong></td>
            <td class="right">${h.location_balance_after ?? '—'}</td>
            <td class="right">${h.balance_after}</td>
            <td>${UI.esc(h.reason || '—')}</td>
            <td>${UI.esc(h.user_name || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    renderPager(total);
  }

  function renderPager(total) {
    const start = total ? state.offset + 1 : 0;
    const end = Math.min(state.offset + state.limit, total);
    const canPrev = state.offset > 0;
    const canNext = state.offset + state.limit < total;
    pagerEl.innerHTML = `
      <span class="muted">${start}–${end} of ${total}</span>
      <button class="btn secondary small" id="mv-prev" ${canPrev ? '' : 'disabled'}>Prev</button>
      <button class="btn secondary small" id="mv-next" ${canNext ? '' : 'disabled'}>Next</button>`;
    const prev = pagerEl.querySelector('#mv-prev');
    const next = pagerEl.querySelector('#mv-next');
    if (prev) prev.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); };
    if (next) next.onclick = () => { state.offset += state.limit; load(); };
  }

  function exportCsv() {
    if (!last.rows.length) { UI.toast('Nothing to export', 'error'); return; }
    UI.downloadCsv(
      'stock-movements.csv',
      ['When', 'Item', 'SKU', 'Location', 'Change', 'At location', 'Total', 'Reason', 'By'],
      last.rows.map((h) => [
        h.created_at, h.item_name || '', h.item_sku || '', h.location_name || '',
        h.change, h.location_balance_after ?? '', h.balance_after, h.reason || '', h.user_name || '',
      ])
    );
  }

  let t;
  view.querySelector('#mv-q').addEventListener('input', (e) => {
    clearTimeout(t); state.q = e.target.value.trim(); state.offset = 0; t = setTimeout(load, 250);
  });
  view.querySelector('#mv-dir').addEventListener('change', (e) => { state.dir = e.target.value; state.offset = 0; load(); });
  view.querySelector('#mv-loc').addEventListener('change', (e) => { state.location_id = e.target.value; state.offset = 0; load(); });
  view.querySelector('#mv-from').addEventListener('change', (e) => { state.from = e.target.value; state.offset = 0; load(); });
  view.querySelector('#mv-to').addEventListener('change', (e) => { state.to = e.target.value; state.offset = 0; load(); });
  view.querySelector('#mv-export').addEventListener('click', exportCsv);

  await load();
});
