/* Production → Job Orders: manufacturing job orders. Build N units of a finished
   product by consuming its BOM; track progress, pause/cancel with returns.
   filter.id = <job order id> deep-links straight into that one's detail (used by the
   "View in Production" backlink on a job-type Order, and by the AI assistant's
   created-record links). */
App.register('job-orders', async (view, filter) => {
  const canWrite = App.hasPermission('inventory.adjust');
  // Narrower than canWrite: a production_lead/qc_inspector/qa_inspector account
  // (production.record / production.inspect_qc / production.inspect_qa, no
  // inventory.adjust) can use just the Record production / QC callout + repair-parts
  // sections below — not the job-order-lifecycle actions (new/release/pause/cancel/
  // close/components) that stay canWrite-only. This is only the door check (does the
  // section render at all) — which specific pass a qc_inspector/qa_inspector account
  // may actually perform is enforced per-unit by the server (see production-qc.js).
  const canRecord = canWrite || App.hasPermission('production.record');
  const canInspectHere = canWrite || App.hasPermission('production.inspect_qc') || App.hasPermission('production.inspect_qa');
  const STATUS = ['', 'draft', 'released', 'in_progress', 'paused', 'completed', 'cancelled'];
  const state = { status: '' };
  let rows = [];
  let products = [];
  let locations = [];
  let items = [];
  let teams = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Job Orders <span class="muted" style="font-weight:400;font-size:14px">(Production)</span></h2>
      <div class="grow"></div>
      <select id="jo-status" style="width:150px">
        ${STATUS.map((s) => `<option value="${s}">${s ? s.replace('_', ' ') : 'All statuses'}</option>`).join('')}
      </select>
      ${canWrite ? `<button class="btn" id="jo-new">${UI.icon('plus')} New job order</button>` : ''}
    </div>
    <div class="panel"><div id="jo-table"></div></div>`;

  const tableEl = view.querySelector('#jo-table');
  const badge = (s) => `<span class="badge-pill status-${s === 'completed' ? 'completed' : s === 'cancelled' ? 'cancelled' : s === 'paused' ? 'confirmed' : 'open'}">${s.replace('_', ' ')}</span>`;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    [rows, products, locations, items, teams] = await Promise.all([
      API.get('/job-orders?' + p.toString()),
      API.get('/finished-products'),
      API.get('/locations'),
      API.get('/inventory').catch(() => []),
      API.get('/production/teams?active=1').catch(() => []),
    ]);
    render();
  }

  function render() {
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'adjust',
        title: state.status ? 'No job orders with that status' : 'No job orders yet',
        hint: 'Create a job order to build finished products from their BOM.',
        action: (!state.status && canWrite) ? `<button class="btn" id="jo-empty-new">${UI.icon('plus')} New job order</button>` : '',
      });
      const en = tableEl.querySelector('#jo-empty-new');
      if (en) en.onclick = () => newModal();
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Number</th><th>Product</th><th>Team</th><th>Due</th><th class="right">Ordered</th><th class="right">Done</th>
          <th class="right">Scrapped</th><th class="right">Left</th><th>Status</th><th>Step</th>
        </tr></thead>
        <tbody>${rows.map((j) => {
          const step = ProductionSteps.jobOrderStep(j);
          return `
          <tr class="clickable" data-open="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong>${j.order_number ? `<div class="muted" style="font-size:11px">${UI.esc(j.order_number)}</div>` : ''}</td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="muted">${UI.esc(j.team_name || '—')}</td>
            <td class="${j.overdue ? 'danger' : 'muted'}">${j.due_date ? UI.esc(j.due_date) + (j.overdue ? ' ⚠' : '') : '—'}</td>
            <td class="right">${j.qty_ordered}</td>
            <td class="right">${j.qty_done}</td>
            <td class="right">${j.qty_scrapped}</td>
            <td class="right">${j.remaining}</td>
            <td>${badge(j.status)}</td>
            <td><span class="badge-pill ${step.cls}">${step.label}</span></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => trackModal(tr.dataset.open));
  }

  function locOptions(sel) {
    return locations.map((l) => `<option value="${l.id}" ${String(l.id) === String(sel) ? 'selected' : ''}>${UI.esc(l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
  }

  function newModal() {
    if (!products.length) { UI.toast('Define a finished product first (Production → Finished Products)', 'error'); return; }
    UI.modal({
      title: 'New job order',
      helpTopic: 'job-orders',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Product to build <span class="req">*</span></label></div>
          <select data-f="product">${products.map((p) => {
            const spec = p.attributes && typeof p.attributes === 'object' ? p.attributes.spec : null;
            const variant = [p.product_group, spec].filter(Boolean).join(' · ');
            const bomNote = p.component_count ? `BOM: ${p.component_count} parts, ${p.max_buildable} buildable` : 'no BOM';
            return `<option value="${p.id}">${UI.esc(p.name)}${variant ? ` (${UI.esc(variant)})` : ''} — ${bomNote}</option>`;
          }).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Quantity to build <span class="req">*</span></label></div>
          <input data-f="qty" type="number" min="1" value="1" /></div>
        <div class="form-field"><div class="field-label"><label>Pull components from</label></div>
          <select data-f="source">${locOptions()}</select></div>
        <div class="form-field"><div class="field-label"><label>Put finished units in</label></div>
          <select data-f="output">${locOptions()}</select></div>
        <div class="form-field"><div class="field-label"><label>Inspection before stock</label></div>
          <select data-f="qc">
            <option value="0">None — straight to stock</option>
            <option value="1">1 step (QC/QA)</option>
            <option value="2">2 steps — QC then QA</option>
          </select></div>
        <div class="form-field"><div class="field-label"><label>Production team</label></div>
          <select data-f="team"><option value="">— unassigned —</option>
            ${teams.map((t) => `<option value="${t.id}">${UI.esc(t.name)}</option>`).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Work centre / line</label></div>
          <input data-f="wc" placeholder="e.g. Assembly Line 2" /></div>
        <div class="form-field"><div class="field-label"><label>Planned start</label></div>
          <input data-f="start" type="date" /></div>
        <div class="form-field"><div class="field-label"><label>Due date</label></div>
          <input data-f="due" type="date" /></div>
        <div class="form-field"><div class="field-label"><label>Priority (0–9)</label></div>
          <input data-f="prio" type="number" min="0" max="9" value="0" /></div>
        <div class="form-field span2"><div class="field-label"><label>Notes</label></div>
          <textarea data-f="notes"></textarea></div>
      </div>`,
      confirmText: 'Create draft',
      onConfirm: async (ov, showErr) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
        const qty = parseInt(g('qty'), 10);
        if (!g('product')) { showErr('Pick a product'); return false; }
        if (!qty || qty < 1) { showErr('Quantity must be at least 1'); return false; }
        await API.post('/job-orders', {
          product_item_id: Number(g('product')), qty_ordered: qty,
          source_location_id: Number(g('source')) || null,
          output_location_id: Number(g('output')) || null,
          qc_stages: Number(g('qc')) || 0,
          team_id: Number(g('team')) || null,
          work_center: g('wc').trim() || null,
          planned_start: g('start') || null,
          due_date: g('due') || null,
          priority: Number(g('prio')) || 0,
          notes: g('notes').trim() || null,
        });
        UI.toast('Job order created (draft)');
        load();
      },
    });
  }

  async function trackModal(id) {
    let jo = await API.get('/job-orders/' + id);
    let units = [];
    let qcLog = [];
    let repairs = [];
    let batches = [];

    const m = UI.modal({ title: `Job order ${jo.number}`, size: 'lg', cancelText: 'Close', bodyHTML: '<div id="jo-body"></div>' });
    const host = () => m.overlay ? m.overlay.querySelector('#jo-body') : document.querySelector('#jo-body');

    async function refreshUnits() {
      if (jo.qc_stages > 0) {
        try { units = await API.get('/job-orders/' + id + '/units'); } catch { units = []; }
        try { qcLog = await API.get('/job-orders/' + id + '/qc'); } catch { qcLog = []; }
        try { repairs = await API.get('/production/repairs?job_order=' + id); } catch { repairs = []; }
      }
      try { batches = await API.get('/production/batches?job_order=' + id); } catch { batches = []; }
    }

    const act = async (path, body) => {
      try {
        const r = await API.post('/job-orders/' + id + path, body || {});
        jo = r.job_order || (await API.get('/job-orders/' + id));
        await refreshUnits();
        UI.toast('Done');
        draw();
        load();
      } catch (e) {
        if (path === '/release' && e && e.status === 400 && e.data && Array.isArray(e.data.shortfalls) && e.data.shortfalls.length) {
          releaseShortfallModal(e.data.shortfalls);
          return;
        }
        UI.toast(e.message, 'error');
      }
    };

    // Release blocked: components short at the source location. Offer to draft POs for them.
    function releaseShortfallModal(shortfalls) {
      UI.modal({
        title: `Can't release ${jo.number} — components short`,
        bodyHTML: `
          <p class="muted" style="margin-top:0">These components aren't on hand at ${UI.esc(jo.source_location_name || 'the source location')}:</p>
          <table><thead><tr><th>Component</th><th class="right">Need</th><th class="right">Have</th><th class="right">Short</th></tr></thead>
            <tbody>${shortfalls.map((s) => `<tr><td>${UI.esc(s.component_name)}</td><td class="right">${s.need}</td><td class="right">${s.have}</td><td class="right danger">${s.short}</td></tr>`).join('')}</tbody></table>
          <div id="jo-sf-result" class="muted" style="font-size:12px;margin-top:8px"></div>`,
        confirmText: 'Draft purchase orders',
        cancelText: 'Close',
        onConfirm: async (ov, showErr) => {
          try {
            const r = await API.post('/job-orders/' + id + '/purchase-shortfall', {});
            const made = (r.created || []).map((c) => `${UI.esc(c.number)} → ${UI.esc(c.supplier_name || 'no supplier on the items')} (${c.lines} line${c.lines === 1 ? '' : 's'})`);
            ov.querySelector('#jo-sf-result').innerHTML = made.length
              ? '<b>Draft POs:</b><br>' + made.join('<br>') + '<br>Review &amp; send them from Purchasing, then receive the stock and release again.'
              : UI.esc(r.note || 'Nothing to draft.');
            return false; // keep the modal so the result is readable
          } catch (e) { showErr(e.message); return false; }
        },
      });
    }

    function draw() {
      const el = host();
      if (!el) return;
      const isDraft = jo.status === 'draft';
      // Production must accept the released parts kit before output can be recorded
      // (server: job-orders.routes.ts needsAcceptance — older job orders with output
      // already on record are exempt).
      const sumAny = Object.values(jo.units_summary || {}).some((n) => n > 0);
      const awaitingAccept = !jo.accepted_at && ['released', 'in_progress', 'paused'].includes(jo.status)
        && !(jo.qty_done > 0 || jo.qty_scrapped > 0 || sumAny);
      const running = (jo.status === 'released' || jo.status === 'in_progress') && !awaitingAccept;
      const comps = jo.components || [];
      const sum = jo.units_summary || { pending: 0, passed: 0, in_stock: 0, failed: 0, scrapped: 0, rework: 0 };
      const qc = jo.qc_stages > 0;
      const rework = units.filter((u) => u.status === 'rework');
      const FAULTS = ['assembler', 'production', 'supplier', 'wear', 'other'];
      const box = (inner) => `<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:12px;background:var(--surface-2)">${inner}</div>`;
      const boxTitle = (t) => `<h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">${t}</h4>`;
      el.innerHTML = `
        ${box(`
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            ${badge(jo.status)}
            <strong>${UI.esc(jo.product_name)}</strong>
            ${jo.order_number ? `<span class="muted">from ${UI.esc(jo.order_number)}</span>` : ''}
          </div>
          <div class="kv" style="margin:10px 0 0">
            <div><span class="muted">Ordered</span><div>${jo.qty_ordered}</div></div>
            <div><span class="muted">Done</span><div>${jo.qty_done}</div></div>
            <div><span class="muted">Scrapped</span><div>${jo.qty_scrapped}</div></div>
            <div><span class="muted">Remaining</span><div>${jo.qty_ordered - jo.qty_done - jo.qty_scrapped}</div></div>
            <div><span class="muted">Inspection</span><div>${qc ? `${jo.qc_stages}-step` : 'none'}</div></div>
            ${qc ? `<div><span class="muted">Under inspection</span><div>${sum.pending}</div></div>` : ''}
            ${qc && sum.rework ? `<div><span class="muted">In repair</span><div>${sum.rework}</div></div>` : ''}
            ${sum.passed ? `<div><span class="muted">Awaiting Products In</span><div>${sum.passed}</div></div>` : ''}
            <div><span class="muted">Pull from</span><div>${UI.esc(jo.source_location_name || '—')}</div></div>
            <div><span class="muted">Output to</span><div>${UI.esc(jo.output_location_name || '—')}</div></div>
            <div><span class="muted">Team</span><div>${UI.esc(jo.team_name || '—')}${jo.work_center ? ` <span class="muted">· ${UI.esc(jo.work_center)}</span>` : ''}</div></div>
            ${(jo.planned_start || jo.due_date) ? `<div><span class="muted">Schedule</span><div>${UI.esc(jo.planned_start || '?')} → ${UI.esc(jo.due_date || '?')}${jo.priority ? ` <span class="muted">P${jo.priority}</span>` : ''}</div></div>` : ''}
            ${jo.released_by_name ? `<div><span class="muted">Released by</span><div>${UI.esc(jo.released_by_name)}${jo.released_at ? ` <span class="muted">${UI.esc(jo.released_at.slice(0, 16).replace('T', ' '))}</span>` : ''}</div></div>` : ''}
            ${jo.accepted_by_name ? `<div><span class="muted">Accepted by</span><div>${UI.esc(jo.accepted_by_name)}${jo.accepted_at ? ` <span class="muted">${UI.esc(jo.accepted_at.slice(0, 16).replace('T', ' '))}</span>` : ''}</div></div>` : ''}
          </div>
          ${jo.accept_notes ? `<p class="muted" style="white-space:pre-wrap;margin:10px 0 0"><b>Handover note:</b> ${UI.esc(jo.accept_notes)}</p>` : ''}
          ${jo.notes ? `<p class="muted" style="white-space:pre-wrap;margin:10px 0 0">${UI.esc(jo.notes)}</p>` : ''}`)}

        ${box(`
          ${boxTitle('Components')}
          <table>
            <thead><tr><th>Component</th><th class="right">Per unit</th><th class="right">Planned</th><th class="right">Consumed</th><th class="right">On hand</th></tr></thead>
            <tbody id="jo-comp-body">${comps.length ? comps.map((c) => `<tr>
              <td>${UI.esc(c.component_name)}</td>
              <td class="right">${c.qty_per_unit}</td>
              <td class="right">${isDraft
                ? `<input data-plan="${c.component_item_id}" type="number" min="0" value="${c.qty_planned}" style="width:80px" />`
                : c.qty_planned}</td>
              <td class="right">${c.qty_consumed}</td>
              <td class="right">${c.component_on_hand ?? '—'}</td>
            </tr>`).join('') : `<tr><td colspan="5" class="muted">No components — this product has no BOM. ${isDraft && canWrite ? 'Add parts below, or build it as-is.' : 'Nothing is reserved or consumed.'}</td></tr>`}</tbody>
          </table>
          ${isDraft && canWrite ? `
            <div class="field-row" style="align-items:flex-end;gap:8px;margin-top:8px">
              <div style="flex:1"><label class="muted" style="font-size:12px">Add a component</label>
                <select id="jo-comp-pick"><option value="">— pick an item —</option>
                  ${items.filter((it) => !comps.some((c) => String(c.component_item_id) === String(it.id)))
                    .map((it) => `<option value="${it.id}">${UI.esc(it.name)}${it.sku ? ' (' + UI.esc(it.sku) + ')' : ''}</option>`).join('')}
                </select></div>
              <div><label class="muted" style="font-size:12px">Total planned</label>
                <input id="jo-comp-qty" type="number" min="0" value="1" style="width:90px" /></div>
              <button type="button" class="btn secondary small" id="jo-comp-add">Add</button>
            </div>
            <button type="button" class="btn secondary small" id="jo-save-plan" style="margin-top:8px">Save planned quantities</button>` : ''}`)}

        ${awaitingAccept && jo.status !== 'paused' ? box(`
          ${boxTitle('Accept parts kit')}
          <p class="muted" style="font-size:12px;margin:0 0 8px">Released by the warehouse — waiting for production to count the kit against the Components list and accept it. Output can't be recorded until then.</p>
          ${canRecord ? `
            <label style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" id="jo-acc-counted" /> I counted the kit and it matches the Components list</label>
            <div class="field-row">
              <div style="flex:1"><label>Note (optional)</label><input id="jo-acc-note" maxlength="500" placeholder="e.g. bolts swapped for equivalent" /></div>
              <div style="display:flex;align-items:flex-end"><button type="button" class="btn" id="jo-accept">Accept job order</button></div>
            </div>` : ''}`) : ''}

        ${running && canRecord && !qc ? box(`
          ${boxTitle('Record production')}
          <div class="field-row">
            <div><label>Finished now</label><input id="jo-done" type="number" min="0" value="0" /></div>
            <div><label>Scrapped now</label><input id="jo-scrap" type="number" min="0" value="0" /></div>
            <div><label>Batch / lot (auto)</label><input id="jo-batch" placeholder="auto BATCH-#####" title="A batch is recorded automatically for each entry" /></div>
            <div style="display:flex;align-items:flex-end"><button type="button" class="btn" id="jo-progress">Apply</button></div>
          </div>`) : ''}

        ${running && canRecord && qc ? box(`
          ${boxTitle('Record production')}
          <div class="field-row">
            <div><label>Scrapped now</label><input id="jo-scrap" type="number" min="0" value="0" /></div>
            <div style="display:flex;align-items:flex-end"><button type="button" class="btn secondary" id="jo-scrap-apply">Record scrap</button></div>
          </div>
          <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
            <label style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Units finished — off the line</label>
            <p class="muted" style="font-size:12px;margin:4px 0 8px">Each unit needs its own identifier (motor/serial no.) and a photo. Use the +/− (or type a number) for several at once.</p>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <button type="button" class="btn secondary small" id="jo-unit-dec">−</button>
              <input id="jo-unit-count" type="number" min="1" value="1" style="width:64px;text-align:center" />
              <button type="button" class="btn secondary small" id="jo-unit-inc">+</button>
              <span class="muted" style="font-size:12px">unit(s) to add</span>
            </div>
            <div id="jo-unit-rows"></div>
            <div class="field-row" style="margin-top:8px">
              <div><label>Batch / lot (optional)</label><input id="jo-unit-batch" placeholder="label to group these units" /></div>
            </div>
            <button type="button" class="btn" id="jo-units-submit" style="margin-top:10px">${UI.icon('plus')} Record unit(s)</button>
            <div id="jo-unit-progress" class="muted" style="font-size:12px;margin-top:6px"></div>
          </div>`) : ''}

        ${qc && canInspectHere && (sum.pending > 0 || sum.rework > 0) ? box(`
          ${boxTitle(`Inspection queue — ${sum.pending} pending${sum.rework ? `, ${sum.rework} back from repair` : ''}`)}
          <p class="muted" style="margin:0 0 8px">Pass/fail and each unit's checklist happen in QC / QA, not here.</p>
          <button type="button" class="btn secondary" id="jo-open-qc">${UI.icon('check')} Open in QC / QA</button>`) : ''}

        ${qc && canInspectHere && (rework.length || repairs.length) ? box(`
          ${boxTitle('Repair — parts requests to the warehouse')}
          ${rework.length ? `
            <div class="field-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
              <div><label class="muted" style="font-size:12px">Unit</label>
                <select id="rp-unit">${rework.map((u) => `<option value="${u.id}">#${u.id}${u.identifier ? ' · ' + UI.esc(u.identifier) : ''}</option>`).join('')}</select></div>
              <div><label class="muted" style="font-size:12px">Kind</label>
                <select id="rp-kind"><option value="replace">Replace a part</option><option value="add">Add a missing part</option></select></div>
              <div style="flex:1;min-width:160px"><label class="muted" style="font-size:12px">Component</label>
                <select id="rp-comp"><option value="">— pick an item —</option>${items.map((it) => `<option value="${it.id}">${UI.esc(it.name)}${it.sku ? ' (' + UI.esc(it.sku) + ')' : ''}</option>`).join('')}</select></div>
              <div><label class="muted" style="font-size:12px">Qty</label><input id="rp-qty" type="number" min="1" value="1" style="width:70px" /></div>
              <div><label class="muted" style="font-size:12px">Fault</label>
                <select id="rp-fault">${FAULTS.map((f) => `<option value="${f}">${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}</select></div>
              <label class="check" style="white-space:nowrap"><input type="checkbox" id="rp-dmg" checked /> Old part → damage</label>
              <button type="button" class="btn secondary small" id="rp-add">Request</button>
            </div>` : ''}
          ${repairs.length ? `
            <table style="margin-top:10px">
              <thead><tr><th>Ref</th><th>Unit</th><th>Kind</th><th>Component</th><th class="right">Qty</th><th>Fault</th><th>Status</th><th>Warehouse remarks</th><th></th></tr></thead>
              <tbody>${repairs.map((r) => `<tr>
                <td class="mono">${UI.esc(r.number)}</td>
                <td>#${r.unit_id}</td>
                <td>${r.kind}</td>
                <td>${UI.esc(r.component_name)}</td>
                <td class="right">${r.quantity}</td>
                <td class="muted">${UI.esc(r.fault || '—')}</td>
                <td><span class="badge-pill status-${r.status === 'accepted' ? 'completed' : r.status === 'rejected' || r.status === 'cancelled' ? 'cancelled' : 'open'}">${r.status}</span></td>
                <td class="muted">${UI.esc(r.warehouse_remarks || '')}</td>
                <td>${r.status === 'requested' ? `<button type="button" class="btn secondary small" data-rp-cancel="${r.id}">Cancel</button>` : ''}</td>
              </tr>`).join('')}</tbody>
            </table>` : '<p class="muted">No parts requested yet.</p>'}`) : ''}

        ${qc && qcLog.length ? box(`
          ${boxTitle('Inspection history')}
          <table>
            <thead><tr><th>When</th><th>Unit</th><th>Result</th><th>Inspector</th><th>Remarks / issues</th></tr></thead>
            <tbody>${qcLog.slice(0, 50).map((q) => {
              const issues = (Array.isArray(q.checklist) ? q.checklist : []).filter((c) => c.ok === false).map((c) => c.label).join(', ');
              return `<tr>
                <td class="muted" style="white-space:nowrap">${UI.esc((q.created_at || '').slice(0, 16).replace('T', ' '))}</td>
                <td>#${q.unit_id || '—'}${q.stage ? ` <span class="muted">s${q.stage}</span>` : ''}</td>
                <td>${q.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : `<span class="badge-pill low">fail</span>${q.disposition ? ` <span class="muted" style="font-size:11px">${UI.esc(q.disposition)}</span>` : ''}`}</td>
                <td>${UI.esc(q.inspector_name || '—')}</td>
                <td>${UI.esc(q.remarks || '')}${issues ? `<div class="muted" style="font-size:11px">✗ ${UI.esc(issues)}</div>` : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>`) : ''}

        ${batches.length ? box(`
          ${boxTitle('Batches / lots')}
          <table>
            <thead><tr><th>Batch</th><th>Lot</th><th class="right">Qty</th><th class="right">Units</th><th>Status</th></tr></thead>
            <tbody>${batches.map((b) => `<tr class="clickable" data-batch="${b.id}">
              <td class="mono">${UI.esc(b.number)}</td>
              <td class="mono">${UI.esc(b.identifier || '—')}</td>
              <td class="right">${b.qty}</td>
              <td class="right">${b.unit_count || 0}</td>
              <td>${UI.esc(b.status)}</td>
            </tr>`).join('')}</tbody>
          </table>`) : ''}

        ${canWrite ? `<div class="jo-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
          ${jo.status !== 'completed' && jo.status !== 'cancelled' ? `<button type="button" class="btn secondary" id="jo-resched">Team / schedule…</button>` : ''}
          ${isDraft ? `<button type="button" class="btn" data-do="release">Release</button>
                       <button type="button" class="btn secondary danger" data-do="_delete">Delete</button>` : ''}
          ${running ? `<button type="button" class="btn secondary" data-do="pause">Pause</button>` : ''}
          ${jo.status === 'paused' ? `<button type="button" class="btn secondary" data-do="resume">Resume</button>` : ''}
          ${(running || jo.status === 'paused') ? `<button type="button" class="btn secondary" data-do="close">Close (finish early)</button>
                       <button type="button" class="btn secondary danger" data-do="cancel">Cancel</button>` : ''}
        </div>` : ''}`;

      const rs = el.querySelector('#jo-resched');
      if (rs) rs.onclick = () => {
        UI.modal({
          title: `Team / schedule — ${jo.number}`,
          bodyHTML: `<div class="form-grid">
            <div class="form-field"><div class="field-label"><label>Production team</label></div>
              <select data-f="team"><option value="">— unassigned —</option>
                ${teams.map((t) => `<option value="${t.id}" ${String(t.id) === String(jo.team_id) ? 'selected' : ''}>${UI.esc(t.name)}</option>`).join('')}</select></div>
            <div class="form-field"><div class="field-label"><label>Work centre / line</label></div>
              <input data-f="wc" value="${UI.esc(jo.work_center || '')}" /></div>
            <div class="form-field"><div class="field-label"><label>Planned start</label></div>
              <input data-f="start" type="date" value="${UI.esc(jo.planned_start || '')}" /></div>
            <div class="form-field"><div class="field-label"><label>Due date</label></div>
              <input data-f="due" type="date" value="${UI.esc(jo.due_date || '')}" /></div>
            <div class="form-field"><div class="field-label"><label>Priority (0–9)</label></div>
              <input data-f="prio" type="number" min="0" max="9" value="${jo.priority || 0}" /></div>
          </div>`,
          confirmText: 'Save',
          onConfirm: async (ov) => {
            const g = (k) => ov.querySelector(`[data-f="${k}"]`).value;
            const r = await API.put('/job-orders/' + id + '/schedule', {
              team_id: Number(g('team')) || null,
              work_center: g('wc').trim() || null,
              planned_start: g('start') || null,
              due_date: g('due') || null,
              priority: Number(g('prio')) || 0,
            });
            jo = r.job_order; UI.toast('Saved'); draw(); load();
          },
        });
      };

      const addComp = el.querySelector('#jo-comp-add');
      if (addComp) addComp.onclick = () => {
        const pick = el.querySelector('#jo-comp-pick');
        const qtyEl = el.querySelector('#jo-comp-qty');
        const itemId = pick.value;
        if (!itemId) { UI.toast('Pick an item', 'error'); return; }
        if (el.querySelector(`[data-plan="${itemId}"]`)) { UI.toast('That component is already listed', 'error'); return; }
        const it = items.find((x) => String(x.id) === String(itemId));
        const qty = parseInt(qtyEl.value, 10) || 0;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${UI.esc(it ? it.name : '#' + itemId)}</td>
          <td class="right">—</td>
          <td class="right"><input data-plan="${itemId}" type="number" min="0" value="${qty}" style="width:80px" /></td>
          <td class="right">0</td>
          <td class="right">${it && it.quantity != null ? it.quantity : '—'}</td>`;
        const body = el.querySelector('#jo-comp-body');
        const placeholder = body.querySelector('td[colspan]');
        if (placeholder) body.innerHTML = '';
        body.appendChild(tr);
        pick.querySelector(`option[value="${itemId}"]`)?.remove();
        pick.value = '';
      };

      const sp = el.querySelector('#jo-save-plan');
      if (sp) sp.onclick = async () => {
        const components = [...el.querySelectorAll('[data-plan]')].map((i) => ({
          component_item_id: Number(i.dataset.plan), qty_planned: parseInt(i.value, 10) || 0,
        }));
        try {
          const r = await API.put('/job-orders/' + id + '/components', { components });
          jo = r.job_order; UI.toast('Planned quantities saved'); draw();
        } catch (e) { UI.toast(e.message, 'error'); }
      };
      const acc = el.querySelector('#jo-accept');
      if (acc) acc.onclick = () => {
        if (!el.querySelector('#jo-acc-counted').checked) { UI.toast('Count the kit first, then tick the box', 'error'); return; }
        const notes = (el.querySelector('#jo-acc-note').value || '').trim();
        act('/accept', { notes: notes || null });
      };
      const pg = el.querySelector('#jo-progress');
      if (pg) pg.onclick = () => {
        const done_delta = parseInt(el.querySelector('#jo-done').value, 10) || 0;
        const scrapped_delta = parseInt(el.querySelector('#jo-scrap').value, 10) || 0;
        if (done_delta + scrapped_delta <= 0) { UI.toast('Enter a finished or scrapped quantity', 'error'); return; }
        const batch_label = (el.querySelector('#jo-batch') || {}).value;
        act('/progress', { done_delta, scrapped_delta, batch_label: (batch_label || '').trim() || null });
      };
      const scrapApply = el.querySelector('#jo-scrap-apply');
      if (scrapApply) scrapApply.onclick = () => {
        const scrapped_delta = parseInt(el.querySelector('#jo-scrap').value, 10) || 0;
        if (scrapped_delta <= 0) { UI.toast('Enter a scrapped quantity', 'error'); return; }
        act('/progress', { scrapped_delta });
      };

      // Units finished — one row per unit (identifier + photo required each), row count
      // driven by the +/− buttons or typing a number directly into #jo-unit-count. Rows
      // are appended/removed rather than fully redrawn so a file already picked for an
      // earlier row survives changing the count (a <input type=file>'s value can't be
      // reapplied programmatically once the DOM node is replaced).
      const unitRowsEl = el.querySelector('#jo-unit-rows');
      if (unitRowsEl) {
        const unitRowHTML = (i) => `
          <div class="field-row" style="align-items:flex-end;gap:8px;margin-bottom:8px" data-unit-row="${i}">
            <div style="flex:1"><label class="muted" style="font-size:12px">Unit ${i + 1} — identifier <span class="req">*</span></label>
              <input class="jo-unit-ident" placeholder="e.g. chassis / motor / serial no." /></div>
            <div><label class="muted" style="font-size:12px">Photo <span class="req">*</span></label>
              <input type="file" accept="image/*" class="jo-unit-photo" /></div>
            <div class="jo-unit-thumb" style="width:44px;height:44px;border-radius:6px;overflow:hidden;background:var(--surface-3);flex-shrink:0"></div>
          </div>`;
        const wirePhotoPreview = (row) => {
          const fileInput = row.querySelector('.jo-unit-photo');
          const thumb = row.querySelector('.jo-unit-thumb');
          fileInput.onchange = () => {
            const file = fileInput.files && fileInput.files[0];
            thumb.innerHTML = file ? `<img src="${URL.createObjectURL(file)}" style="width:100%;height:100%;object-fit:cover" />` : '';
          };
        };
        const countEl = el.querySelector('#jo-unit-count');
        const syncUnitRows = () => {
          let n = parseInt(countEl.value, 10) || 1;
          if (n < 1) n = 1;
          countEl.value = n;
          const existingRows = [...unitRowsEl.querySelectorAll('[data-unit-row]')];
          if (n > existingRows.length) {
            for (let i = existingRows.length; i < n; i++) {
              unitRowsEl.insertAdjacentHTML('beforeend', unitRowHTML(i));
              wirePhotoPreview(unitRowsEl.querySelector(`[data-unit-row="${i}"]`));
            }
          } else if (n < existingRows.length) {
            for (let i = existingRows.length - 1; i >= n; i--) existingRows[i].remove();
          }
        };
        el.querySelector('#jo-unit-dec').onclick = () => { countEl.value = Math.max(1, (parseInt(countEl.value, 10) || 1) - 1); syncUnitRows(); };
        el.querySelector('#jo-unit-inc').onclick = () => { countEl.value = (parseInt(countEl.value, 10) || 1) + 1; syncUnitRows(); };
        countEl.addEventListener('input', syncUnitRows);
        syncUnitRows();

        const unitsSubmit = el.querySelector('#jo-units-submit');
        const progressEl = el.querySelector('#jo-unit-progress');
        unitsSubmit.onclick = async () => {
          const rowEls = [...unitRowsEl.querySelectorAll('[data-unit-row]')];
          const batch_label = (el.querySelector('#jo-unit-batch').value || '').trim() || null;
          const pending = [];
          for (const row of rowEls) {
            const identifier = row.querySelector('.jo-unit-ident').value.trim();
            const file = row.querySelector('.jo-unit-photo').files[0];
            if (!identifier) { UI.toast('Every unit needs an identifier', 'error'); return; }
            if (!file) { UI.toast('Every unit needs a photo', 'error'); return; }
            pending.push({ identifier, file });
          }
          unitsSubmit.disabled = true;
          let done = 0;
          try {
            for (const p of pending) {
              progressEl.textContent = `Recording unit ${done + 1} of ${pending.length}…`;
              const r = await API.post('/job-orders/' + id + '/units', { identifier: p.identifier, batch_label });
              const fd = new FormData();
              fd.append('image', p.file, p.file.name || 'unit.jpg');
              fd.append('kind', 'qc_unit');
              fd.append('ref_id', String(r.id));
              await API.upload('/attachments', fd);
              jo = r.job_order;
              done++;
            }
            progressEl.textContent = '';
            UI.toast(`Recorded ${done} unit${done === 1 ? '' : 's'}`);
            await refreshUnits();
            draw(); load();
          } catch (e) {
            progressEl.textContent = '';
            UI.toast(`Recorded ${done} of ${pending.length} — ${e.message}`, 'error');
            unitsSubmit.disabled = false;
          }
        };
      }

      const openQc = el.querySelector('#jo-open-qc');
      if (openQc) openQc.onclick = () => ProductionQC.inspect(id, async () => {
        jo = await API.get('/job-orders/' + id);
        await refreshUnits();
        draw(); load();
      });

      const rpAdd = el.querySelector('#rp-add');
      if (rpAdd) rpAdd.onclick = async () => {
        const unitId = Number(el.querySelector('#rp-unit').value);
        const component_item_id = Number(el.querySelector('#rp-comp').value);
        if (!component_item_id) { UI.toast('Pick a component', 'error'); return; }
        const body = {
          kind: el.querySelector('#rp-kind').value,
          component_item_id,
          quantity: parseInt(el.querySelector('#rp-qty').value, 10) || 1,
          fault: el.querySelector('#rp-fault').value,
          return_to_damage: el.querySelector('#rp-dmg').checked,
        };
        try {
          await API.post('/production/units/' + unitId + '/repairs', body);
          await refreshUnits(); UI.toast('Request sent to the warehouse'); draw();
        } catch (e) { UI.toast(e.message, 'error'); }
      };
      el.querySelectorAll('[data-rp-cancel]').forEach((b) => b.onclick = async () => {
        try {
          await API.post('/production/repairs/' + b.dataset.rpCancel + '/cancel', {});
          await refreshUnits(); UI.toast('Request cancelled'); draw();
        } catch (e) { UI.toast(e.message, 'error'); }
      });
      el.querySelectorAll('[data-batch]').forEach((tr) => tr.onclick = () => App.navigate('production-batches', { id: tr.dataset.batch }));
      el.querySelectorAll('[data-do]').forEach((b) => b.onclick = () => {
        const d = b.dataset.do;
        if (d === '_delete') {
          UI.confirmDialog(`Delete draft ${jo.number}?`, 'Delete').then((ok) => {
            if (!ok) return;
            API.del('/job-orders/' + id).then(() => { UI.toast('Deleted'); m.close && m.close(); load(); }).catch((e) => UI.toast(e.message, 'error'));
          });
        } else if (d === 'cancel') {
          UI.confirmDialog(`Cancel ${jo.number}? Unconsumed components are returned to ${UI.esc(jo.source_location_name || 'the source location')}.`, 'Cancel job order')
            .then((ok) => ok && act('/cancel'));
        } else {
          act('/' + d);
        }
      });
    }

    await refreshUnits();
    draw();
  }

  view.querySelector('#jo-status').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  const nb = view.querySelector('#jo-new');
  if (nb) nb.onclick = () => newModal();

  await load();
  if (filter && filter.id) trackModal(filter.id);
});
