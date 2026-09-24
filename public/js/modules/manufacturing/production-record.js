/* Production record — the read-only dossier for one produced unit or one batch:
   what it is, who built it and when, its QC/QA sign-offs, any repairs, and the stock
   movements it drove. Opened from a scanned QR label, the Finished Products units
   table, or a batch. filter.unit = <unit id> | filter.batch = <batch id>. */
App.register('production-record', async (view, filter) => {
  const unitId = filter && filter.unit;
  const batchId = filter && filter.batch;

  if (!unitId && !batchId) {
    view.innerHTML = UI.emptyState({ icon: 'search', title: 'No record selected', hint: 'Open a production record from a unit, a batch, or a scanned QR label.' });
    return;
  }

  view.innerHTML = '<div class="panel"><div class="empty">Loading…</div></div>';
  let d;
  try {
    d = await API.get('/production/record?' + (unitId ? 'unit=' + encodeURIComponent(unitId) : 'batch=' + encodeURIComponent(batchId)));
  } catch (e) {
    view.innerHTML = `<div class="panel"><div class="empty">${UI.esc(e.message || 'Not found')}</div></div>`;
    return;
  }

  const p = d.product || {};
  const jo = d.job_order || {};
  const u = d.unit || null;
  const b = d.batch || null;
  const dt = (s) => UI.esc((s || '').slice(0, 16).replace('T', ' '));
  const kv = (label, val) => `<div><span class="muted">${label}</span><div>${val}</div></div>`;

  const title = u
    ? (u.identifier || ('Unit #' + u.id))
    : (b.number + (b.identifier ? ' · ' + b.identifier : ''));

  view.innerHTML = `
    <div class="topbar">
      <h2>Production record <span class="muted" style="font-weight:400;font-size:14px">${d.kind}</span></h2>
      <div class="grow"></div>
      <button class="btn secondary" id="pr-print">${UI.icon('printer') || ''} Print</button>
    </div>
    <div class="panel" id="pr-doc">
      <h3 style="margin:0 0 2px">${UI.esc(p.name || jo.product_name || '—')}</h3>
      <div class="muted mono">${UI.esc(title)}</div>

      <div class="kv" style="margin-top:12px">
        ${kv('Model', UI.esc(p.model || '—'))}
        ${kv('Variant', UI.esc(p.variant || '—'))}
        ${kv('SKU', UI.esc(p.sku || '—'))}
        ${u ? kv('Status', UI.esc(u.status) + (u.disposition ? ` <span class="muted">(${UI.esc(u.disposition)})</span>` : '')) : kv('Batch status', UI.esc(b.status))}
        ${u ? kv('Location', UI.esc(u.location_name || '—')) : kv('Batch qty', b.qty)}
        ${u && u.batch_number ? kv('Batch', UI.esc(u.batch_number)) : ''}
        ${u && u.order_number ? kv('Sales order', UI.esc(u.order_number)) : ''}
        ${b && b.created_by_name ? kv('Batch created by', UI.esc(b.created_by_name)) : ''}
        ${kv('Built', dt((u || b).created_at))}
      </div>

      <h4 class="pr-h">Job order</h4>
      ${jo.number ? `<div class="kv">
        ${kv('MO', UI.esc(jo.number))}
        ${kv('Team', UI.esc(jo.team_name || '—'))}
        ${kv('Created by', UI.esc(jo.created_by_name || '—'))}
        ${kv('Released by', UI.esc(jo.released_by_name || '—'))}
        ${kv('Accepted by', UI.esc(jo.accepted_by_name || '—'))}
        ${kv('Planned', UI.esc(jo.planned_start || '—') + ' → ' + UI.esc(jo.due_date || '—'))}
        ${kv('Pull / output', UI.esc(jo.source_location_name || '—') + ' → ' + UI.esc(jo.output_location_name || '—'))}
      </div>` : '<p class="muted">Not linked to a job order.</p>'}

      <h4 class="pr-h">QC / QA</h4>
      ${(d.qc && d.qc.length) ? `<table>
        <thead><tr><th>When</th><th>Stage</th><th>Result</th><th>Inspector</th><th>Remarks / checklist</th></tr></thead>
        <tbody>${d.qc.map((q) => {
          const issues = (Array.isArray(q.checklist) ? q.checklist : []).filter((c) => c.ok === false).map((c) => c.label).join(', ');
          const oks = (Array.isArray(q.checklist) ? q.checklist : []).filter((c) => c.ok === true).map((c) => c.label).join(', ');
          return `<tr>
            <td class="muted" style="white-space:nowrap">${dt(q.created_at)}</td>
            <td>${q.stage || '—'}</td>
            <td>${q.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : `<span class="badge-pill low">fail</span>${q.disposition ? ` <span class="muted">${UI.esc(q.disposition)}</span>` : ''}`}</td>
            <td>${UI.esc(q.inspector_name || '—')}</td>
            <td>${UI.esc(q.remarks || '')}${oks ? `<div class="muted" style="font-size:11px">✓ ${UI.esc(oks)}</div>` : ''}${issues ? `<div style="font-size:11px;color:var(--danger,#dc2626)">✗ ${UI.esc(issues)}</div>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>` : '<p class="muted">No inspection recorded.</p>'}

      ${d.repairs ? `<h4 class="pr-h">Repairs / parts requests</h4>
        ${d.repairs.length ? `<table>
          <thead><tr><th>Ref</th><th>Kind</th><th>Component</th><th class="right">Qty</th><th>Fault</th><th>Status</th><th>Handled by</th><th>Remarks</th></tr></thead>
          <tbody>${d.repairs.map((r) => `<tr>
            <td class="mono">${UI.esc(r.number)}</td>
            <td>${r.kind}</td>
            <td>${UI.esc(r.component_name)}</td>
            <td class="right">${r.quantity}</td>
            <td class="muted">${UI.esc(r.fault || '—')}</td>
            <td>${UI.esc(r.status)}</td>
            <td class="muted">${UI.esc(r.decided_by_name || r.requested_by_name || '—')}</td>
            <td class="muted">${UI.esc(r.warehouse_remarks || r.notes || '')}</td>
          </tr>`).join('')}</tbody></table>` : '<p class="muted">No repairs.</p>'}` : ''}

      ${b && d.units && d.units.length ? `<h4 class="pr-h">Units in this batch</h4>
        <table><thead><tr><th>Unit</th><th>Status</th><th>Identifier</th></tr></thead>
        <tbody>${d.units.map((x) => `<tr><td>#${x.id}</td><td>${x.status}</td><td class="mono">${UI.esc(x.identifier || '—')}</td></tr>`).join('')}</tbody></table>` : ''}

      <h4 class="pr-h">Stock movements</h4>
      ${(d.movements && d.movements.length) ? `<table>
        <thead><tr><th>When</th><th class="right">Change</th><th class="right">Balance</th><th>Location</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>${d.movements.map((m) => `<tr>
          <td class="muted" style="white-space:nowrap">${dt(m.created_at)}</td>
          <td class="right">${m.change > 0 ? '+' : ''}${m.change}</td>
          <td class="right">${m.balance_after}</td>
          <td>${UI.esc(m.location_name || '—')}</td>
          <td class="muted">${UI.esc(m.reason || '')}</td>
          <td class="muted">${UI.esc(m.user_name || '—')}</td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">No movements linked to this job order.</p>'}
    </div>`;

  const style = document.createElement('style');
  style.textContent = `#pr-doc .pr-h{margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)}
    @media print{.topbar,.tool-rail,.primary-nav,.subnav,.tree{display:none!important}#pr-doc{border:none;box-shadow:none}}`;
  view.appendChild(style);
  view.querySelector('#pr-print').onclick = () => window.print();
});
