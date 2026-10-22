/* Reports: fixed operational dashboards (stock value, production, purchasing/AP,
   sales, payroll). One GET /analytics/overview call; sections render if present. */
App.register('analytics', async (view) => {
  const money = UI.money;
  view.innerHTML = '<div class="empty">Loading…</div>';

  let d;
  try { d = await API.get('/analytics/overview'); }
  catch (e) { view.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }

  const card = (cls, ic, label, value, sub) => `
    <div class="stat-card ${cls || ''}">
      <div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${UI.esc(label)}${sub ? ` · ${UI.esc(sub)}` : ''}</div></div>
    </div>`;
  const panel = (title, inner, headRight) => `
    <div class="panel">
      <div class="panel-head"><h3>${UI.esc(title)}</h3><div class="grow"></div>${headRight || ''}</div>
      <div>${inner}</div>
    </div>`;
  const tbl = (head, rows) => rows.length
    ? `<table><thead><tr>${head.map((h) => `<th${h.startsWith('#') ? ' class="right"' : ''}>${UI.esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<div class="empty">No data yet.</div>';

  const sections = [];

  /* -------- inventory -------- */
  if (d.inventory) {
    const iv = d.inventory;
    sections.push(`
      <h3 class="rep-h">Inventory</h3>
      <div class="cards">
        ${iv.stock_value !== undefined ? card('', 'sheet', 'Stock value', money(iv.stock_value)) : ''}
        ${card('', 'inventory', 'Items', iv.items)}
        ${card('warn', 'alert', 'Low stock', iv.low_stock)}
        ${card('alert', 'alert', 'Out of stock', iv.out_of_stock)}
        ${card('warn', 'history', 'Dead stock (90d)', iv.dead_stock_count, iv.dead_stock_value !== undefined ? money(iv.dead_stock_value) : '')}
      </div>
      ${iv.value_by_location && iv.top_value_items ? `<div class="grid-2">
        ${panel('Stock value by location', tbl(['Location', '#Units', '#Value'],
          iv.value_by_location.map((r) => `<tr><td>${UI.esc(r.location)}</td><td class="right">${r.units}</td><td class="right">${money(r.value)}</td></tr>`)))}
        ${panel('Highest-value items', tbl(['Item', '#On hand', '#Value'],
          iv.top_value_items.map((r) => `<tr><td>${UI.esc(r.name)}<div class="muted mono">${UI.esc(r.sku || '—')}</div></td><td class="right">${r.quantity}</td><td class="right">${money(r.value)}</td></tr>`)))}
      </div>` : ''}`);
  }

  /* -------- production -------- */
  if (d.production) {
    const p = d.production;
    const st = p.by_status || {};
    sections.push(`
      <h3 class="rep-h">Production</h3>
      <div class="cards">
        ${card('', 'adjust', 'Work in progress', p.wip_qty, `${p.wip_orders} MO`)}
        ${card(p.overdue ? 'warn' : '', 'alert', 'Overdue MOs', p.overdue || 0, `${p.due_this_week || 0} due this week`)}
        ${card('', 'sparkles', 'Units done · 30d', p.last_30.units_done)}
        ${card(p.last_30.scrap_rate_pct > 5 ? 'warn' : '', 'alert', 'Scrap rate · 30d', p.last_30.scrap_rate_pct + '%')}
        ${card('', 'sparkles', 'Units done · 90d', p.last_90.units_done)}
        ${card('', 'printer', 'MOs completed · 90d', p.last_90.mos)}
      </div>
      <div class="grid-2">
        ${panel('Job orders by status', tbl(['Status', '#Count'],
          ['draft', 'released', 'in_progress', 'paused', 'completed', 'cancelled']
            .filter((s) => st[s]).map((s) => `<tr><td>${s.replace('_', ' ')}</td><td class="right">${st[s]}</td></tr>`)))}
        ${panel('Recently completed', tbl(['MO', 'Product', '#Qty', 'Closed'],
          p.recent_completed.map((r) => `<tr><td class="mono">${UI.esc(r.number)}</td><td>${UI.esc(r.product_name)}</td><td class="right">${r.qty_done}</td><td>${UI.esc((r.closed_at || '').slice(0, 10))}</td></tr>`)))}
      </div>`);
  }

  /* -------- purchasing / AP -------- */
  if (d.purchasing) {
    const pu = d.purchasing;
    const a = pu.ap_aging;
    sections.push(`
      <h3 class="rep-h">Purchasing &amp; payables</h3>
      <div class="cards">
        ${card('', 'inbox', 'Open POs', pu.open_pos, pu.open_po_value !== undefined ? money(pu.open_po_value) : '')}
        ${pu.gr_ni_value !== undefined ? card(pu.gr_ni_value > 0 ? 'warn' : '', 'history', 'Received, not invoiced', money(pu.gr_ni_value)) : ''}
        ${card(pu.bills_to_approve ? 'warn' : '', 'sheet', 'Bills to approve', pu.bills_to_approve)}
        ${a ? card(a.d60_plus > 0 ? 'alert' : '', 'alert', 'Payables 60+ days', money(a.d60_plus)) : ''}
        ${a ? card('', 'sheet', 'Total payable', money(a.total)) : ''}
      </div>
      ${a ? panel('Payables aging (approved bills)', tbl(['Bucket', '#Amount'], [
        `<tr><td>Current / not due</td><td class="right">${money(a.current)}</td></tr>`,
        `<tr><td>1–30 days overdue</td><td class="right">${money(a.d1_30)}</td></tr>`,
        `<tr><td>31–60 days overdue</td><td class="right">${money(a.d31_60)}</td></tr>`,
        `<tr><td>60+ days overdue</td><td class="right">${money(a.d60_plus)}</td></tr>`,
      ])) : ''}`);
  }

  /* -------- sales -------- */
  if (d.sales) {
    const s = d.sales;
    const maxV = Math.max(1, ...s.weekly.map((w) => w.value));
    sections.push(`
      <h3 class="rep-h">Sales orders</h3>
      <div class="cards">
        ${card('', 'forms', 'Open sale orders', s.open_orders, money(s.open_value))}
        ${s.backorder_count ? card('warn', 'alert', 'On backorder', s.backorder_count, money(s.backorder_value)) : ''}
        ${Object.entries(s.by_status).map(([k, v]) => card('', 'forms', k, v.count, money(v.value))).slice(0, s.backorder_count ? 3 : 4).join('')}
      </div>
      ${panel('Sale orders — last 8 weeks', s.weekly.length ? `
        <table><thead><tr><th>Week</th><th class="right">Orders</th><th class="right">Value</th><th style="width:40%">&nbsp;</th></tr></thead>
        <tbody>${s.weekly.map((w) => `<tr>
          <td class="mono">${UI.esc(w.week)}</td><td class="right">${w.count}</td><td class="right">${money(w.value)}</td>
          <td><div style="background:var(--accent);height:10px;border-radius:5px;width:${Math.round(w.value / maxV * 100)}%"></div></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No sale orders in the last 8 weeks.</div>')}`);
  }

  /* -------- payroll -------- */
  if (d.payroll) {
    const rows = d.payroll.periods || [];
    const latest = rows[0];
    sections.push(`
      <h3 class="rep-h">Payroll</h3>
      ${latest ? `<div class="cards">
        ${card('', 'users', 'Headcount', latest.headcount, latest.period || '')}
        ${card('', 'sheet', 'Gross', money(latest.gross))}
        ${card('', 'sheet', 'Net pay', money(latest.net))}
        ${card('', 'sheet', 'Statutory', money(latest.statutory))}
        ${card('', 'sheet', 'Withholding tax', money(latest.tax))}
      </div>` : ''}
      ${panel('Recent pay periods', tbl(['Period', '#Staff', '#Gross', '#Statutory', '#Tax', '#Net'],
        rows.map((r) => `<tr><td>${UI.esc(r.period || '—')}</td><td class="right">${r.headcount}</td><td class="right">${money(r.gross)}</td><td class="right">${money(r.statutory)}</td><td class="right">${money(r.tax)}</td><td class="right">${money(r.net)}</td></tr>`)))}`);
  }

  if (!sections.length) {
    view.innerHTML = `<div class="topbar"><h2>Reports</h2></div>${UI.emptyState({ icon: 'sheet', title: 'Nothing to report yet', hint: 'Reports appear here once you have inventory, orders, production or payroll data.' })}`;
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <h2>Reports</h2>
      <div class="sub">Operational snapshot · ${UI.esc((d.generated_at || '').slice(0, 16).replace('T', ' '))}</div>
      <div class="grow"></div>
      <button class="btn secondary" id="rep-refresh">${UI.icon('history', 15)} Refresh</button>
    </div>
    ${sections.join('\n')}`;
  view.querySelector('#rep-refresh').onclick = () => App.navigate('analytics');

  if (!document.getElementById('rep-style')) {
    const st = document.createElement('style');
    st.id = 'rep-style';
    st.textContent = `.rep-h{margin:22px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)}
      .rep-h:first-child{margin-top:4px}`;
    document.head.appendChild(st);
  }
});
