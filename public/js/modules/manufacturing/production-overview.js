/* Production → Overview: the home screen for the Production tab — a summary of the whole
   pipeline's current state, not a working screen of its own. Warnings/problems (overdue job
   orders, units stuck in rework), what's waiting on someone's action (QC/QA queue, Products
   In, repair requests to accept), and a short production report (WIP, scrap rate, recently
   completed) pulled from the same GET /analytics/overview the Home → Reports page uses.
   Every row links straight to the screen that actually handles it. */
App.register('production-overview', async (view) => {
  view.innerHTML = '<div class="empty">Loading…</div>';
  const LABEL = 'margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)';

  const [analytics, jobOrders, repairs] = await Promise.all([
    API.get('/analytics/overview').catch(() => ({})),
    API.get('/job-orders').catch(() => []),
    API.get('/production/repairs?status=requested').catch(() => []),
  ]);
  const prod = analytics.production || {};

  const open = (jobOrders || []).filter((j) => ['draft', 'released', 'in_progress', 'paused'].includes(j.status));
  const overdue = open.filter((j) => j.overdue);
  const inRework = open.filter((j) => (j.units_rework || 0) > 0);
  // Released by the warehouse but not yet accepted by production (and nothing built yet —
  // mirrors job-orders.routes.ts needsAcceptance()).
  const toAccept = open.filter((j) => j.status === 'released' && !j.accepted_at && !(j.qty_done > 0 || j.qty_scrapped > 0));
  const awaitingQc = open.filter((j) => (j.units_pending || 0) > 0);
  const readyToReceive = open.filter((j) => (j.units_passed || 0) > 0 || (j.batches_receivable || 0) > 0);
  const qcUnitCount = awaitingQc.reduce((s, j) => s + (j.units_pending || 0), 0);
  const receiveCount = readyToReceive.reduce((s, j) => s + (j.units_passed || 0) + (j.batches_receivable || 0), 0);

  const card = (cls, ic, label, value, sub) => `
    <div class="stat-card ${cls || ''}">
      <div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${UI.esc(label)}${sub ? ` · ${UI.esc(sub)}` : ''}</div></div>
    </div>`;
  const panel = (title, inner, right) => `
    <div class="panel">
      <div class="panel-head"><h3>${UI.esc(title)}</h3><div class="grow"></div>${right || ''}</div>
      <div>${inner}</div>
    </div>`;
  const jobTable = (rows, extraHead, extra) => rows.length
    ? `<table><thead><tr><th>Job order</th><th>Product</th><th>Team</th><th class="right">${UI.esc(extraHead)}</th></tr></thead>
        <tbody>${rows.slice(0, 8).map((j) => `
          <tr class="clickable" data-jo="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong></td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="muted">${UI.esc(j.team_name || '—')}</td>
            <td class="right muted">${UI.esc(extra(j))}</td>
          </tr>`).join('')}</tbody></table>`
    : '';
  const actionRow = (route, filter, ic, label, sub, count) => `
    <tr class="clickable" data-go="${route}" ${filter ? `data-filter='${JSON.stringify(filter)}'` : ''}>
      <td style="width:34px">${UI.icon(ic, 18)}</td>
      <td><strong>${UI.esc(label)}</strong><div class="muted" style="font-size:12px">${UI.esc(sub)}</div></td>
      <td class="right">${count ? `<span class="badge-pill ${count > 0 ? 'low' : 'ok'}">${count}</span>` : '<span class="badge-pill ok">clear</span>'}</td>
    </tr>`;

  view.innerHTML = `
    <div class="topbar"><h2>Production Overview</h2></div>
    <div class="cards">
      ${card('', 'archive', 'Work in progress', prod.wip_orders ?? 0, (prod.wip_qty ?? 0) + ' units left to build')}
      ${card(overdue.length ? 'alert' : '', 'alert', 'Overdue job orders', overdue.length)}
      ${card('', 'calendar', 'Due this week', prod.due_this_week ?? 0)}
      ${card('', 'sheet', 'Scrap rate (30d)', (prod.last_30 ? prod.last_30.scrap_rate_pct : 0) + '%')}
    </div>

    <div class="grid-2">
      ${panel('Needs attention', (overdue.length || inRework.length) ? `
          ${overdue.length ? `<h4 style="${LABEL}">Overdue (${overdue.length})</h4>${jobTable(overdue, 'Due', (j) => j.due_date || '—')}` : ''}
          ${inRework.length ? `<h4 style="${LABEL}">In repair / rework (${inRework.length})</h4>${jobTable(inRework, 'Units', (j) => String(j.units_rework))}` : ''}
        ` : UI.emptyState({ icon: 'check', title: 'Nothing needs attention', hint: 'No overdue job orders and nothing stuck in rework.' })
      )}
      ${panel('Waiting on you', `
        <table><tbody>
          ${actionRow('job-orders', null, 'adjust', 'Job Orders', 'parts kits to accept', toAccept.length)}
          ${actionRow('production-qc', { tab: 'queue' }, 'check', 'QC / QA', 'units awaiting inspection', qcUnitCount)}
          ${actionRow('production-receiving', { tab: 'queue' }, 'inbox', 'Products In', 'ready to receive', receiveCount)}
          ${actionRow('repairs', null, 'inbox', 'Repairs', 'parts requests to accept', repairs.length)}
        </tbody></table>`
      )}
    </div>

    ${panel('Recently completed', prod.recent_completed && prod.recent_completed.length ? `
      <table><thead><tr><th>Job order</th><th>Product</th><th class="right">Units</th><th>Completed</th></tr></thead>
        <tbody>${prod.recent_completed.map((r) => `<tr>
          <td><strong>${UI.esc(r.number)}</strong></td>
          <td>${UI.esc(r.product_name)}</td>
          <td class="right">${r.qty_done}</td>
          <td class="muted">${UI.fmtDateShort(r.closed_at)}</td>
        </tr>`).join('')}</tbody></table>
      ` : UI.emptyState({ icon: 'archive', title: 'Nothing completed yet' }),
      `<button class="btn secondary small" id="po-reports">${UI.icon('sheet', 15)} Full report</button>`
    )}`;

  view.querySelectorAll('tr[data-jo]').forEach((tr) =>
    tr.onclick = () => App.navigate('job-orders', { id: tr.dataset.jo }));
  view.querySelectorAll('tr[data-go]').forEach((tr) =>
    tr.onclick = () => App.navigate(tr.dataset.go, tr.dataset.filter ? JSON.parse(tr.dataset.filter) : undefined));
  const rb = view.querySelector('#po-reports');
  if (rb) rb.onclick = () => App.navigate('analytics');
});
