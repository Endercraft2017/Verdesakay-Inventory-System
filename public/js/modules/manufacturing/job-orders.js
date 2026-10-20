/* Production → Job Orders: manufacturing job orders. Build N units of a finished
   product by consuming its BOM; track progress, pause/cancel with returns.
   filter.id = <job order id> deep-links straight into that one's detail (used by the
   "View in Production" backlink on a job-type Order, and by the AI assistant's
   created-record links). */
App.register('job-orders', async (view, filter) => {
  const canWrite = App.hasPermission('production.plan');
  const canReleaseKit = App.hasPermission('production.kit_release');
  // Production execution requires explicit task permissions, separate from stock lifecycle actions.
  const canRecord = App.hasPermission('production.record');
  // Approval is its own permission (production.approve), not implied by inventory.adjust.
  const canApprove = App.hasPermission('production.approve');
  const canConvert = canApprove || App.hasPermission('production.manage');
  const canReportIssue = canRecord || canApprove || App.hasPermission('production.manage')
    || App.hasPermission('production.inspect_qc') || App.hasPermission('production.inspect_qa')
    || App.hasPermission('production.receive');
  const canInspectHere = App.hasPermission('production.inspect_qc') || App.hasPermission('production.inspect_qa');
  // Line decisions without the warehouse's inventory.adjust: a Production Manager may pause /
  // resume (production.pause or .manage) and close early (production.manage) — each with a reason
  // the server requires (job-orders.routes.ts reasonFor). Cancel / delete / release stay canWrite.
  const canPauseLine = App.hasPermission('production.pause') || App.hasPermission('production.manage');
  const canCloseEarly = App.hasPermission('production.manage');
  // A unit QA held for review: any QA inspector or a production.qa_review holder decides it.
  const canDecideHold = App.hasPermission('production.inspect_qa') || App.hasPermission('production.qa_review');
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
      ${canConvert ? `<button class="btn secondary" id="jo-convert">Finish semi-built RTS</button>` : ''}
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
      API.get('/finished-products').catch(() => []),
      API.get('/locations').catch(() => []),
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
            <td><strong>${UI.esc(j.number)}</strong><div class="muted" style="font-size:11px">${j.parent_job_order_number ? `Subassembly for ${UI.esc(j.parent_job_order_number)}` : j.order_number ? `For ${UI.esc(j.order_number)}` : 'RTS buffer stock'}</div></td>
            <td>${UI.esc(j.product_name)}<div class="muted" style="font-size:11px">${j.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built'}</div></td>
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
    return locations.map((l) => `<option value="${l.id}" ${String(l.id) === String(sel) ? 'selected' : ''}>${UI.esc(l.path || l.name)}${l.is_default ? ' (default)' : ''}</option>`).join('');
  }

  async function suggestSubassemblies(parentId, quiet = false) {
    let suggestions;
    try { suggestions = await API.get(`/job-orders/${parentId}/subassembly-suggestions`); }
    catch (error) { UI.toast(error.message, 'error'); return; }
    const needed = suggestions.filter((item) => item.uncovered > 0);
    if (!needed.length) { if (!quiet) UI.toast('No subassembly shortage on this job order.'); return; }
    const modal = UI.modal({ title: 'Build missing subassemblies?', size: 'md', confirmText: null, cancelText: 'Close',
      bodyHTML: `<p class="muted">These products remain separate components in the parent kit. Accepting a suggestion creates a linked draft job order. Finish and receive each subassembly before picking the parent kit.</p>
        ${needed.map((item) => `<section class="order-notice" style="margin-top:10px"><strong>${UI.esc(item.component_name)}</strong>
          <p>Short ${item.uncovered}; raw materials can build ${item.buildable_now} now.</p>
          ${item.suggested_qty && canWrite ? `<button type="button" class="btn secondary small" data-subassembly="${item.component_item_id}">Create draft for ${item.suggested_qty}</button>` : '<span class="muted">Replenish raw materials before creating this build.</span>'}
          ${item.linked_jobs.length ? `<p class="muted">Already planned: ${item.linked_jobs.map((job) => UI.esc(job.number)).join(', ')}</p>` : ''}</section>`).join('')}`,
    });
    modal.overlay.querySelectorAll('[data-subassembly]').forEach((button) => button.onclick = async () => {
      const item = needed.find((row) => String(row.component_item_id) === button.dataset.subassembly);
      button.disabled = true;
      try {
        const child = await API.post(`/job-orders/${parentId}/subassembly-jobs`,
          { component_item_id: item.component_item_id, quantity: item.suggested_qty },
          { idempotencyKey: `subassembly:${parentId}:${item.component_item_id}:${crypto.randomUUID()}` });
        modal.close(); UI.toast(`${child.number} created as a draft. Approve and receive it before releasing the parent kit.`);
        load();
      } catch (error) { UI.toast(error.message, 'error'); button.disabled = false; }
    });
  }

  async function conversionModal() {
    let demand;
    try { demand = await API.get('/job-orders/convert-semi/demand'); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    if (!demand.length) { UI.toast('No fully built sale shortage has a free semi-built package at its ship-from location.'); return; }
    let candidates = null;
    let attempt;
    UI.modal({ title: 'Finish an existing semi-built package', size: 'md',
      bodyHTML: `<p class="order-notice">A semi-built unit already contains every part. Select its sale shortage and physical package. The package leaves semi-built RTS now, passes QC, then enters fully built RTS at Products In. No CKD parts are picked again.</p>
        <div class="form-grid"><div class="form-field span2"><label>Fully built sale shortage</label><select data-f="demand">${demand.map((d, i) => `<option value="${i}">${UI.esc(d.order_number)} · ${UI.esc(d.product_name)} · ${d.uncovered} short · ${d.semi_built_available} semi available</option>`).join('')}</select></div>
        <div class="form-field span2"><label>Source package</label><select data-f="source"><option value="">Loading packages…</option></select></div>
        <div class="form-field span2"><label>Physical identifier</label><input data-f="identifier" maxlength="120" placeholder="Keep serial or label untracked package" /></div>
        <div class="form-field"><label>Additional finishing cost</label><input data-f="cost" type="number" min="0" step="0.01" value="0" /></div>
        <div class="form-field span2"><label>Package photo</label><input data-f="image" type="file" accept="image/jpeg,image/png,image/gif,image/webp" /></div>
        <div class="form-field span2"><label><input data-f="complete-kit" type="checkbox" /> I checked that every loose part remains with this complete package.</label></div>
        <div class="form-field span2"><label>Work note</label><input data-f="notes" maxlength="500" /></div></div>`,
      confirmText: 'Start finishing this unit',
      onOpen: (ov) => {
        const selected = () => demand[Number(ov.querySelector('[data-f="demand"]').value)];
        const pick = ov.querySelector('[data-f="source"]');
        const idField = ov.querySelector('[data-f="identifier"]');
        const fillId = () => { const unit = (candidates?.units || []).find((u) => `unit:${u.id}` === pick.value);
          idField.value = unit?.identifier || ''; idField.readOnly = !!unit?.identifier; };
        const loadCandidates = async () => {
          const d = selected(); candidates = null; pick.innerHTML = '<option value="">Loading packages…</option>';
          try {
            const result = await API.get(`/job-orders/convert-semi/options?product_item_id=${d.product_item_id}&location_id=${d.location_id}`);
            if (!ov.isConnected || selected() !== d) return;
            candidates = result;
            pick.innerHTML = (result.units || []).map((u) => `<option value="unit:${u.id}">${UI.esc(u.identifier || 'Tracked unit #' + u.id)}</option>`).join('')
              + (result.batches || []).map((b) => `<option value="batch:${b.id}">QR batch ${UI.esc(b.number)} · ${b.available} free</option>`).join('')
              + (result.bulk_available >= 1 ? '<option value="">Untracked semi-built unit</option>' : '');
            if (!pick.options.length) pick.innerHTML = '<option value="">No available packages — refresh</option>';
            fillId();
          } catch (e) { pick.innerHTML = `<option value="">${UI.esc(e.message)}</option>`; }
        };
        ov.querySelector('[data-f="demand"]').onchange = loadCandidates;
        pick.onchange = fillId;
        loadCandidates();
      },
      onConfirm: async (ov, showErr) => {
        const get = (key) => ov.querySelector(`[data-f="${key}"]`).value.trim();
        const d = demand[Number(get('demand'))];
        if (!candidates || (!get('source') && candidates.bulk_available < 1)) { showErr('Select an available package.'); return false; }
        if (!get('identifier')) { showErr('Enter or retain this package’s physical identifier.'); return false; }
        const image = ov.querySelector('[data-f="image"]').files[0];
        if (!image) { showErr('Take or choose a photo of the package.'); return false; }
        if (!ov.querySelector('[data-f="complete-kit"]').checked) { showErr('Check that the complete kit is present before finishing it.'); return false; }
        const cost = Number(get('cost'));
        if (!Number.isFinite(cost) || cost < 0) { showErr('Finishing cost must be zero or more.'); return false; }
        const payload = new FormData();
        Object.entries({ product_item_id: d.product_item_id, order_id: d.order_id,
          source_location_id: d.location_id, output_location_id: d.location_id,
          source_unit_id: get('source').startsWith('unit:') ? get('source').slice(5) : '',
          source_batch_id: get('source').startsWith('batch:') ? get('source').slice(6) : '',
          identifier: get('identifier'), finishing_cost: cost,
          notes: get('notes'), confirmed_complete_kit: 'true' }).forEach(([key, value]) => payload.append(key, String(value)));
        payload.append('image', image);
        const signature = JSON.stringify([...payload.entries()].map(([key, value]) =>
          value instanceof File ? [key, value.name, value.size, value.lastModified] : [key, value]));
        if (!attempt || attempt.signature !== signature) attempt = { signature,
          key: 'semi-finish:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) };
        try { const result = await API.upload('/job-orders/convert-semi', payload, { idempotencyKey: attempt.key });
          UI.toast(`${result.job_order.number} started; inspect its linked unit before Products In.`);
          await load();
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  function newModal() {
    if (!products.length) { UI.toast('Define a finished product first (Production → Finished Products)', 'error'); return; }
    UI.modal({
      title: 'New job order',
      helpTopic: 'job-orders',
      bodyHTML: `<div class="form-grid">
        <p class="muted span2">This independent job order builds RTS buffer stock. No sales order is required; units become available to sales after production, inspection and Products In.</p>
        <div class="form-field span2"><div class="field-label"><label>Product to build <span class="req">*</span></label></div>
          <select data-f="product">${products.map((p) => {
            const spec = p.attributes && typeof p.attributes === 'object' ? p.attributes.spec : null;
            const variant = [p.product_group, spec].filter(Boolean).join(' · ');
            const bomNote = p.component_count ? `BOM: ${p.component_count} parts, ${p.max_buildable} buildable` : 'no BOM';
            return `<option value="${p.id}">${UI.esc(p.name)}${variant ? ` (${UI.esc(variant)})` : ''} — ${bomNote}</option>`;
          }).join('')}</select></div>
        <div class="form-field"><div class="field-label"><label>Quantity to build <span class="req">*</span></label></div>
          <input data-f="qty" type="number" min="1" value="1" /></div>
        <div class="form-field"><div class="field-label"><label>Build state</label></div>
          <select data-f="mode"><option value="assembled">Fully built</option><option value="semi_built">Semi-built</option></select></div>
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
        const qty = Number(g('qty'));
        if (!g('product')) { showErr('Pick a product'); return false; }
        if (!Number.isInteger(qty) || qty < 1) { showErr('Quantity must be a whole number of at least 1'); return false; }
        const created = await API.post('/job-orders', {
          product_item_id: Number(g('product')), qty_ordered: qty,
          build_mode: g('mode'),
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
        setTimeout(() => suggestSubassemblies(created.id, true), 0);
      },
    });
  }

  async function trackModal(id) {
    let jo = await API.get('/job-orders/' + id);
    let units = [];
    let qcLog = [];
    let repairs = [];
    let batches = [];
    let events = [];
    let issues = [];
    let issuesLoadFailed = false;

    const m = UI.modal({ title: `Job order ${jo.number}`, size: 'lg', cancelText: 'Close', bodyHTML: '<div id="jo-body"></div>' });
    const host = () => m.overlay ? m.overlay.querySelector('#jo-body') : document.querySelector('#jo-body');

    async function refreshUnits() {
      if (jo.qc_stages > 0) {
        try { units = await API.get('/job-orders/' + id + '/units'); } catch { units = []; }
        try { qcLog = await API.get('/job-orders/' + id + '/qc'); } catch { qcLog = []; }
        try { repairs = await API.get('/production/repairs?job_order=' + id); } catch { repairs = []; }
      }
      try { batches = await API.get('/production/batches?job_order=' + id); } catch { batches = []; }
      try { events = await API.get('/job-orders/' + id + '/events'); } catch { events = []; }
      try { issues = await API.get('/production-issues?job_order_id=' + id); issuesLoadFailed = false; }
      catch { issues = []; issuesLoadFailed = true; }
    }

    const actionKeys = new Map();
    const busyActions = new Set();
    const act = async (path, body) => {
      const signature = path + JSON.stringify(body || {});
      if (busyActions.has(signature)) return;
      busyActions.add(signature);
      if (!actionKeys.has(signature)) actionKeys.set(signature,
        'jo-action-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now()));
      try {
        const r = await API.post('/job-orders/' + id + path, body || {}, { idempotencyKey: actionKeys.get(signature) });
        actionKeys.delete(signature);
        jo = r.job_order || (await API.get('/job-orders/' + id));
        await refreshUnits();
        UI.toast(API.syncLocal?.(r) ? 'Saved on this PC — confirmation pending' : 'Done');
        draw();
        load();
      } catch (e) {
        if (e.status && e.status < 500) actionKeys.delete(signature);
        if (path === '/release' && e && e.status === 400 && e.data && Array.isArray(e.data.shortfalls) && e.data.shortfalls.length) {
          purchaseShortfallModal();
          return;
        }
        UI.toast(e.message, 'error');
      } finally {
        busyActions.delete(signature);
      }
    };

    // Reach procurement from the shortage at pick time, before the kit can be prepared.
    async function purchaseShortfallModal() {
      let availability;
      try { availability = await API.get('/job-orders/' + id + '/availability'); }
      catch (e) { UI.toast(e.message, 'error'); return; }
      if (availability.supply_planning_order) {
        const sale = availability.supply_planning_order;
        const modal = UI.modal({
          title: `Component supply · ${jo.number}`, size: 'lg',
          bodyHTML: `<p>Purchase planning for this kit belongs to sale <strong>${UI.esc(sale.number)}</strong>. Its stock review combines demand from all linked jobs, so use that review before drafting a PO.</p>
            <p class="muted">Receive parts at ${UI.esc(availability.source_location_name || 'the job source location')}, then refresh and finish the pick.</p>
            <div class="jo-supply-cards">${(availability.shortfalls || []).map((line) => `<section class="jo-supply-card"><strong>${UI.esc(line.component_name)}</strong><dl>
              <div><dt>Need</dt><dd>${line.need}</dd></div><div><dt>Free here</dt><dd>${line.available}</dd></div><div><dt>Uncovered here</dt><dd>${line.short}</dd></div></dl></section>`).join('')}</div>`,
          confirmText: 'Review sale supply', cancelText: 'Close',
          onConfirm: () => { modal.close(); App.navigate('orders', { type: 'sale', review: sale.id }); return false; },
        });
        return;
      }
      const supplyBody = (av, message) => {
        const requirements = av.purchase_requirements || [];
        const toBuy = requirements.some((r) => r.to_purchase > 0);
        return `<p class="muted" style="margin-top:0">Parts must be received at ${UI.esc(av.source_location_name || 'the job source location')} before this kit can be fully picked. Open purchase orders are plans, not stock. Stock held by other kits or repairs must be freed or replenished separately.</p>
          <div class="table-scroll jo-supply-table"><table><thead><tr><th>Component</th><th class="right">Need</th><th class="right">On hand</th><th class="right">Held elsewhere</th><th class="right">Free</th><th class="right">Uncovered</th><th class="right">PO pending</th><th class="right">To purchase</th></tr></thead>
            <tbody>${(av.lines || []).map((line) => {
              const req = requirements.find((r) => r.component_item_id === line.component_item_id);
              return `<tr><td>${UI.esc(line.component_name)}</td><td class="right">${line.need}</td><td class="right">${line.have}</td><td class="right">${line.held_elsewhere}</td><td class="right">${line.available}</td><td class="right">${line.short}</td><td class="right">${req?.pending_purchase || 0}</td><td class="right">${req?.to_purchase || 0}</td></tr>`;
            }).join('')}</tbody></table></div>
          <div class="jo-supply-cards">${(av.lines || []).map((line) => {
            const req = requirements.find((r) => r.component_item_id === line.component_item_id);
            return `<section class="jo-supply-card"><strong>${UI.esc(line.component_name)}</strong><dl>
              <div><dt>Need</dt><dd>${line.need}</dd></div><div><dt>On hand</dt><dd>${line.have}</dd></div>
              <div><dt>Held elsewhere</dt><dd>${line.held_elsewhere}</dd></div><div><dt>Free</dt><dd>${line.available}</dd></div>
              <div><dt>Uncovered</dt><dd>${line.short}</dd></div><div><dt>PO pending</dt><dd>${req?.pending_purchase || 0}</dd></div>
              <div><dt>To purchase</dt><dd><strong>${req?.to_purchase || 0}</strong></dd></div></dl></section>`;
          }).join('')}</div>
          ${(av.linked_purchase_orders || []).length ? `<p>Existing purchase orders: ${av.linked_purchase_orders.map((po) => `<button type="button" class="btn secondary small" data-supply-po="${po.id}">${UI.esc(po.number)} · ${po.outstanding} pending</button>`).join(' ')}</p>` : ''}
          <div id="jo-sf-result" class="muted" style="font-size:12px;margin-top:8px">${message || (!requirements.length ? 'No component shortage for this kit.' : toBuy ? 'Draft only the uncovered component shortage.' : 'Existing purchase orders cover the shortage. Receive them at the job source location, then complete the pick.')}</div>`;
      };
      const toBuy = (availability.purchase_requirements || []).some((r) => r.to_purchase > 0);
      const modal = UI.modal({
        title: `Component supply · ${jo.number}`,
        size: 'lg',
        bodyHTML: `<div id="jo-supply-body">${supplyBody(availability)}</div>`,
        confirmText: toBuy ? 'Draft missing purchase orders' : null,
        cancelText: 'Close',
        onConfirm: async (ov, showErr) => {
          try {
            const r = await API.post('/job-orders/' + id + '/purchase-shortfall', {});
            const made = (r.created || []).map((c) => `<button type="button" class="btn secondary small" data-supply-po="${c.id}">${UI.esc(c.number)}</button> → ${UI.esc(c.supplier_name || 'supplier not set')} (${c.lines} line${c.lines === 1 ? '' : 's'})`);
            const message = made.length
              ? '<b>Draft POs:</b><br>' + made.join('<br>') + '<br>Review &amp; send them from Purchasing, then receive the stock and release again.'
              : UI.esc(r.note || 'Nothing to draft.');
            availability = await API.get('/job-orders/' + id + '/availability');
            ov.querySelector('#jo-supply-body').innerHTML = supplyBody(availability, message);
            ov.querySelector('[data-confirm]').hidden = !(availability.purchase_requirements || []).some((req) => req.to_purchase > 0);
            wirePurchaseLinks(ov);
            return false; // keep the modal so the result is readable
          } catch (e) { showErr(e.message); return false; }
        },
      });
      function wirePurchaseLinks(root) {
        root.querySelectorAll('[data-supply-po]').forEach((button) => button.onclick = () => {
          modal.close(); App.navigate('purchasing', { order: Number(button.dataset.supplyPo) });
        });
      }
      wirePurchaseLinks(modal.overlay);
    }

    async function prepareKitModal() {
      let availability;
      try { availability = await API.get('/job-orders/' + id + '/availability'); }
      catch (e) { UI.toast(e.message, 'error'); return; }
      const lines = availability.lines || [];
      const pickModal = UI.modal({
        title: `Pick parts kit · ${jo.number}`, size: 'lg', confirmText: 'Save picked quantities',
        bodyHTML: `<p class="order-notice">Count what is physically set aside at ${UI.esc(availability.source_location_name || 'the source location')}. Saving a pick holds stock for this kit; issuing the parts slip deducts it. A partial pick can be saved and completed later.</p>
          ${lines.some((line) => line.short > 0) ? '<p class="order-notice">Some parts are unavailable. Save a partial pick, or <button type="button" class="btn secondary small" id="jo-pick-supply">check component supply</button>.</p>' : ''}
          ${lines.length ? `<div class="table-scroll"><table><thead><tr><th>Component</th><th class="right">Planned</th><th class="right">On hand</th><th class="right">Held elsewhere</th><th class="right">Free for this kit</th><th class="right">Picked for this kit</th></tr></thead><tbody>
          ${lines.map((l) => `<tr><td>${UI.esc(l.component_name)}</td><td class="right">${l.need}</td><td class="right">${l.have}</td><td class="right">${l.held_elsewhere}</td><td class="right">${l.available}</td><td class="right"><input type="number" data-pick="${l.component_item_id}" min="0" max="${l.need}" step="1" value="${l.picked}" style="width:88px" /></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">This job order has no components. Save to mark its empty kit ready for handoff.</p>'}`,
        onConfirm: async (ov, showErr) => {
          const picks = [...ov.querySelectorAll('[data-pick]')].map((input) => ({
            component_item_id: Number(input.dataset.pick), qty_picked: Number(input.value),
          }));
          if (picks.some((p) => !Number.isInteger(p.qty_picked) || p.qty_picked < 0
            || p.qty_picked > lines.find((l) => l.component_item_id === p.component_item_id).need)) {
            showErr('Each picked quantity must be a whole number from zero to the planned amount.'); return false;
          }
          try {
            const body = lines.length ? { job_orders: [{ id: Number(id), lines: picks }] }
              : { job_orders: [{ id: Number(id) }] };
            await API.post('/job-orders/prepare', body);
            jo = await API.get('/job-orders/' + id);
            UI.toast(jo.prepared_at ? 'Kit fully picked — ready for parts slip' : 'Partial pick saved');
            draw(); load(); return true;
          } catch (e) { showErr(e.message); return false; }
        },
      });
      const supply = pickModal.overlay.querySelector('#jo-pick-supply');
      if (supply) supply.onclick = () => { pickModal.close(); purchaseShortfallModal(); };
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
      const unresolved = (sum.pending || 0) + (sum.rework || 0) + (sum.hold || 0);
      const availableToRecord = Math.max(0, jo.qty_ordered - jo.qty_done - jo.qty_scrapped - unresolved);
      const qc = jo.qc_stages > 0;
      const rework = units.filter((u) => u.status === 'rework');
      const held = units.filter((u) => u.status === 'hold');
      const FAULTS = ['assembler', 'production', 'supplier', 'wear', 'other'];
      const box = (inner) => `<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:12px;background:var(--surface-2)">${inner}</div>`;
      const boxTitle = (t) => `<h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">${t}</h4>`;
      el.innerHTML = `
        ${box(`
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            ${badge(jo.status)}
            <strong>${UI.esc(jo.product_name)}</strong>
            <span class="badge-pill">${jo.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built'}</span>
            ${jo.conversion_job_order_id ? '<span class="badge-pill">Finishing existing semi-built unit</span>' : ''}
            ${jo.parent_job_order_number ? `<span class="muted">Subassembly for ${UI.esc(jo.parent_job_order_number)}</span>` : jo.order_number ? `<span class="muted">from ${UI.esc(jo.order_number)}</span>` : '<span class="muted">RTS buffer stock</span>'}
          </div>
          <div class="kv" style="margin:10px 0 0">
            <div><span class="muted">Ordered</span><div>${jo.qty_ordered}</div></div>
            <div><span class="muted">Done</span><div>${jo.qty_done}</div></div>
            <div><span class="muted">Scrapped</span><div>${jo.qty_scrapped}</div></div>
            <div><span class="muted">${jo.conversion_job_order_id ? 'Linked unit awaiting QC / receipt' : 'Still to record'}</span><div>${jo.conversion_job_order_id ? (sum.pending || 0) + (sum.rework || 0) + (sum.hold || 0) + (sum.passed || 0) : availableToRecord}</div></div>
            <div><span class="muted">Inspection</span><div>${qc ? `${jo.qc_stages}-step` : 'none'}</div></div>
            ${qc ? `<div><span class="muted">Under inspection</span><div>${sum.pending}</div></div>` : ''}
            ${qc && sum.rework ? `<div><span class="muted">In repair</span><div>${sum.rework}</div></div>` : ''}
            ${qc && sum.hold ? `<div><span class="muted">QA hold</span><div>${sum.hold}</div></div>` : ''}
            ${sum.passed ? `<div><span class="muted">Awaiting Products In</span><div>${sum.passed}</div></div>` : ''}
            <div><span class="muted">Pull from</span><div>${UI.esc(jo.source_location_name || '—')}</div></div>
            <div><span class="muted">Output to</span><div>${UI.esc(jo.output_location_name || '—')}</div></div>
            <div><span class="muted">Team</span><div>${UI.esc(jo.team_name || '—')}${jo.work_center ? ` <span class="muted">· ${UI.esc(jo.work_center)}</span>` : ''}</div></div>
            ${(jo.planned_start || jo.due_date) ? `<div><span class="muted">Schedule</span><div>${UI.esc(jo.planned_start || '?')} → ${UI.esc(jo.due_date || '?')}${jo.priority ? ` <span class="muted">P${jo.priority}</span>` : ''}</div></div>` : ''}
            ${jo.released_by_name ? `<div><span class="muted">Released by</span><div>${UI.esc(jo.released_by_name)}${jo.released_at ? ` <span class="muted">${UI.esc(jo.released_at.slice(0, 16).replace('T', ' '))}</span>` : ''}</div></div>` : ''}
            ${jo.accepted_by_name ? `<div><span class="muted">Accepted by</span><div>${UI.esc(jo.accepted_by_name)}${jo.accepted_at ? ` <span class="muted">${UI.esc(jo.accepted_at.slice(0, 16).replace('T', ' '))}</span>` : ''}</div></div>` : ''}
          </div>
          ${jo.accept_notes ? `<p class="muted" style="white-space:pre-wrap;margin:10px 0 0"><b>Handover note:</b> ${UI.esc(jo.accept_notes)}</p>` : ''}
          ${jo.conversion_job_order_id ? '<p class="order-notice">This is the same complete package taken from semi-built RTS. Its loose parts were already included; no BOM components were picked again. Inspect the linked unit, then record Products In to make it fully built RTS.</p>' : ''}
          ${jo.conversion_source_batch_id ? `<p class="muted">Source QR batch: ${UI.esc(jo.conversion_source_batch_number || '#' + jo.conversion_source_batch_id)}</p>` : ''}
          ${jo.conversion_cancel_reason ? `<p class="order-notice">Complete package returned to semi-built RTS: ${UI.esc(jo.conversion_cancel_reason)}</p>` : ''}
          ${jo.notes ? `<p class="muted" style="white-space:pre-wrap;margin:10px 0 0">${UI.esc(jo.notes)}</p>` : ''}`)}
        ${held.length ? box(`${boxTitle('Held by QA for review')}
          <table><thead><tr><th>Unit</th><th>Reason</th><th></th></tr></thead><tbody>${held.map((u) => `
            <tr><td>${UI.esc(u.identifier || '#' + u.id)}</td><td class="muted">${UI.esc(u.remarks || '—')}</td>
              <td class="actions">${canDecideHold ? `<button type="button" class="btn small" data-hold="${u.id}">Decide…</button>` : ''}</td></tr>`).join('')}
          </tbody></table>`) : ''}

        ${box(`
          ${boxTitle(jo.conversion_job_order_id ? 'Packaged parts' : 'Components')}
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
            </tr>`).join('') : `<tr><td colspan="5" class="muted">${jo.conversion_job_order_id ? 'All kit parts came with the semi-built package; no new parts are issued.' : `No components — this product has no BOM. ${isDraft && canWrite ? 'Add parts below, or build it as-is.' : 'Nothing is reserved or consumed.'}`}</td></tr>`}</tbody>
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

        ${box(`${boxTitle(`Production issues${issues.filter((i) => i.status === 'open').length ? ` · ${issues.filter((i) => i.status === 'open').length} open` : ''}`)}
          <p class="muted" style="font-size:12px;margin:0 0 8px">Report a kit mismatch, line interruption, or product problem here. An issue is a record; it does not pause production or block output automatically.</p>
          ${issuesLoadFailed ? '<p class="muted">Issue list unavailable. Reopen this job order to retry.</p>' : issues.length ? `<div class="table-scroll"><table><thead><tr><th>Status</th><th>Category</th><th>Severity</th><th>Details</th><th>Reported by</th><th></th></tr></thead><tbody>${issues.map((i) => `<tr>
            <td>${UI.esc(i.status)}</td><td>${UI.esc(i.category)}</td><td>${UI.esc(i.severity)}</td>
            <td>${UI.esc(i.description)}${i.resolution ? `<div class="muted">Resolution: ${UI.esc(i.resolution)}</div>` : ''}</td>
            <td>${UI.esc(i.reported_by_name || '—')}</td>
            <td>${canReportIssue ? `<button type="button" class="btn secondary small" data-issue="${i.id}">Review</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No issues reported.</p>'}
          ${canReportIssue ? '<button type="button" class="btn secondary small" id="jo-issue-new">Report issue</button>' : ''}`)}

        ${running && canRecord && !qc ? box(`
          ${boxTitle('Record production')}
          <div class="field-row">
            <div><label>Finished now</label><input id="jo-done" type="number" min="0" value="0" /></div>
            <div><label>Scrapped now</label><input id="jo-scrap" type="number" min="0" value="0" /></div>
            <div><label>Batch / lot (auto)</label><input id="jo-batch" placeholder="auto BATCH-#####" title="A batch is recorded automatically for each entry" /></div>
            <div style="display:flex;align-items:flex-end"><button type="button" class="btn" id="jo-progress">Apply</button></div>
          </div>`) : ''}

        ${running && canRecord && qc && availableToRecord > 0 ? box(`
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
              <input id="jo-unit-count" type="number" min="1" max="${Math.max(1, availableToRecord)}" value="1" style="width:64px;text-align:center" />
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

        ${isDraft ? `<p class="muted" style="font-size:12px;margin:12px 0 0">${!jo.approved_at
          ? 'Waiting for approval before the warehouse can release the parts.'
          : !jo.warehouse_accepted_at ? `Approved by ${UI.esc(jo.approved_by_name || '—')} — waiting for the warehouse to accept.`
          : !jo.prepared_at ? `Warehouse (${UI.esc(jo.warehouse_accepted_by_name || '—')}) is preparing the parts kit.`
          : `Kit prepared by ${UI.esc(jo.prepared_by_name || '—')} — ready to release.`}</p>` : ''}
        ${jo.parts_slip_id ? `<p class="muted" style="font-size:12px;margin:12px 0 0">Parts release slip <b>${UI.esc(jo.parts_slip_number)}</b>
          <button type="button" class="btn secondary small" id="jo-slip-print">Print slip</button></p>` : ''}
        ${jo.status === 'paused' && jo.pause_reason ? `<p class="muted" style="font-size:12px;margin:12px 0 0">Paused by ${UI.esc(jo.paused_by_name || '—')}: ${UI.esc(jo.pause_reason)}</p>` : ''}
        ${isDraft && canApprove ? `<div class="jo-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${jo.approved_at ? `<button type="button" class="btn secondary" data-do="unapprove">Withdraw approval</button>`
                           : `<button type="button" class="btn" data-do="approve">Approve</button>`}
        </div>` : ''}
        ${!canWrite && (canPauseLine || canCloseEarly || canConvert) && (running || jo.status === 'paused') ? `<div class="jo-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
          ${running && canPauseLine ? `<button type="button" class="btn secondary" data-do="pause">Pause</button>` : ''}
          ${jo.status === 'paused' && canPauseLine ? `<button type="button" class="btn secondary" data-do="resume">Resume</button>` : ''}
          ${canCloseEarly && !jo.conversion_job_order_id ? `<button type="button" class="btn secondary" data-do="close">Close (finish early)</button>` : ''}
          ${canConvert && jo.conversion_job_order_id && sum.pending === 1 ? '<button type="button" class="btn secondary danger" data-do="cancel">Return package to semi-built RTS</button>' : ''}
        </div>` : ''}
        ${events.length ? `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Line decisions (${events.length})</summary>
          <table style="margin-top:6px"><tbody>${events.map((e) => `<tr><td class="muted" style="white-space:nowrap">${UI.esc(UI.fmtDate ? UI.fmtDate(e.created_at) : e.created_at)}</td>
            <td>${UI.esc(({ pause: 'Paused', resume: 'Resumed', close_early: 'Closed early' })[e.action] || e.action)}</td>
            <td>${UI.esc(e.actor_name || '—')}</td><td class="muted">${UI.esc(e.reason || '')}</td></tr>`).join('')}</tbody></table></details>` : ''}
        ${canWrite || canReleaseKit ? `<div class="jo-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
          ${canWrite ? '<button type="button" class="btn secondary" id="jo-assignees">Assign recorders…</button>' : ''}
          ${canWrite && jo.status !== 'completed' && jo.status !== 'cancelled' ? `<button type="button" class="btn secondary" id="jo-resched">Team / schedule…</button>` : ''}
          ${canWrite && isDraft && comps.length ? '<button type="button" class="btn secondary" id="jo-subassemblies">Check subassemblies</button>' : ''}
          ${isDraft ? `${canReleaseKit && jo.approved_at && !jo.warehouse_accepted_at ? `<button type="button" class="btn" data-do="_wh_accept">Accept (warehouse)</button>` : ''}
                       ${canWrite && comps.length ? '<button type="button" class="btn secondary" data-do="_supply">Check component supply</button>' : ''}
                       ${canReleaseKit && jo.warehouse_accepted_at ? `<button type="button" class="btn secondary" data-do="_prepare">${jo.prepared_at ? 'Review / adjust picked kit' : 'Pick / review kit'}</button>` : ''}
                       ${canReleaseKit && jo.prepared_at ? `<button type="button" class="btn" data-do="_release">Release &amp; issue slip</button>` : ''}
                       ${canWrite ? '<button type="button" class="btn secondary danger" data-do="_delete">Delete</button>' : ''}` : ''}
          ${running && canPauseLine ? `<button type="button" class="btn secondary" data-do="pause">Pause</button>` : ''}
          ${jo.status === 'paused' && canPauseLine ? `<button type="button" class="btn secondary" data-do="resume">Resume</button>` : ''}
          ${canWrite && (running || jo.status === 'paused') ? `${jo.conversion_job_order_id || !canCloseEarly ? '' : `<button type="button" class="btn secondary" data-do="close">Close (finish early)</button>`}
                       <button type="button" class="btn secondary danger" data-do="cancel">Cancel</button>` : ''}
        </div>` : ''}`;

      el.querySelector('#jo-assignees')?.addEventListener('click',async()=>{
        try {const access=await API.get('/job-orders/'+id+'/assignees');
          UI.modal({title:'Assign production recorders',bodyHTML:'<p class="muted">Linked members of the assigned production team can also record this job. These assignments do not change account permissions.</p>'+access.eligible.map(u=>'<label class="form-field"><span><input type="checkbox" data-recorder="'+u.id+'" '+(access.assigned.includes(u.id)?'checked':'')+'> '+UI.esc(u.full_name)+'</span></label>').join(''),confirmText:'Save assignments',onConfirm:async overlay=>{
            await API.put('/job-orders/'+id+'/assignees',{user_ids:Array.from(overlay.querySelectorAll('[data-recorder]:checked')).map(e=>Number(e.dataset.recorder))});UI.toast('Assignments saved');
          }});
        }catch(e){UI.toast(e.message,'error');}
      });
      const slipPrint = el.querySelector('#jo-slip-print');
      el.querySelector('#jo-subassemblies')?.addEventListener('click', () => suggestSubassemblies(id));
      if (slipPrint) slipPrint.onclick = () => API.blobUrl('/parts-slips/' + jo.parts_slip_id + '/print')
        .then((u) => window.open(u, '_blank')).catch((e) => UI.toast(e.message, 'error'));

      const newIssue = el.querySelector('#jo-issue-new');
      if (newIssue) newIssue.onclick = () => UI.modal({
        title: `Report production issue · ${jo.number}`,
        bodyHTML: `<p class="muted">This report alerts the team to a problem; pause the job separately if work must stop.</p>
          <div class="form-field"><label>Category</label><select data-f="category">
            <option value="kit">Kit mismatch / damage</option><option value="machine">Machine / line</option>
            <option value="quality">Quality</option><option value="material">Material</option><option value="other">Other</option>
          </select></div>
          <div class="form-field"><label>Severity</label><select data-f="severity">
            <option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option><option value="low">Low</option>
          </select></div>
          <div class="form-field"><label>What happened?</label><textarea data-f="description" rows="4" maxlength="4000"></textarea></div>`,
        confirmText: 'Report issue',
        onConfirm: async (ov, showErr) => {
          const description = ov.querySelector('[data-f="description"]').value.trim();
          if (!description) { showErr('Describe the issue'); return false; }
          await API.post('/production-issues', { job_order_id: Number(id),
            category: ov.querySelector('[data-f="category"]').value,
            severity: ov.querySelector('[data-f="severity"]').value, description });
          await refreshUnits(); draw(); UI.toast('Issue reported'); return true;
        },
      });
      el.querySelectorAll('[data-issue]').forEach((button) => button.onclick = () => {
        const issue = issues.find((i) => String(i.id) === button.dataset.issue);
        if (!issue) return;
        UI.modal({
          title: `Production issue #${issue.id}`,
          bodyHTML: `<p class="muted">Reported by ${UI.esc(issue.reported_by_name || '—')} · ${UI.esc(issue.status)}</p>
            <div class="form-field"><label>Description</label><textarea data-f="description" rows="4" maxlength="4000">${UI.esc(issue.description)}</textarea></div>
            ${issue.status === 'open' ? '<div class="form-field"><label>Resolution (optional)</label><textarea data-f="resolution" rows="3" maxlength="2000"></textarea></div>' : ''}
            <p class="muted">Save changes to the report, or use the status action below. Only its reporter or a manager may change it.</p>
            <button type="button" class="btn secondary" data-issue-status>${issue.status === 'open' ? 'Resolve issue' : 'Reopen issue'}</button>`,
          confirmText: 'Save description',
          onOpen: (ov) => {
            ov.querySelector('[data-issue-status]').onclick = async () => {
              try {
                if (issue.status === 'open') await API.post(`/production-issues/${issue.id}/resolve`, {
                  resolution: ov.querySelector('[data-f="resolution"]').value.trim() || null,
                });
                else await API.post(`/production-issues/${issue.id}/reopen`, {});
                ov.__close();
                await refreshUnits(); draw(); UI.toast('Issue status updated');
              } catch (e) { UI.toast(e.message, 'error'); }
            };
          },
          onConfirm: async (ov, showErr) => {
            if (issue.status !== 'open') { showErr('Reopen the issue before editing it'); return false; }
            const description = ov.querySelector('[data-f="description"]').value.trim();
            if (!description) { showErr('Describe the issue'); return false; }
            await API.put(`/production-issues/${issue.id}`, { description });
            await refreshUnits(); draw(); UI.toast('Issue updated'); return true;
          },
        });
      });

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
        const qty = Number(qtyEl.value);
        if (!Number.isInteger(qty) || qty <= 0) { UI.toast('Enter a positive whole planned quantity', 'error'); return; }
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
          component_item_id: Number(i.dataset.plan), qty_planned: Number(i.value),
        }));
        if (components.some((c) => !Number.isInteger(c.qty_planned) || c.qty_planned < 0)) {
          UI.toast('Planned quantities must be whole numbers of zero or more', 'error'); return;
        }
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
        const done_delta = Number(el.querySelector('#jo-done').value);
        const scrapped_delta = Number(el.querySelector('#jo-scrap').value);
        if (![done_delta, scrapped_delta].every((n) => Number.isInteger(n) && n >= 0)) {
          UI.toast('Use whole, non-negative quantities', 'error'); return;
        }
        if (done_delta + scrapped_delta <= 0) { UI.toast('Enter a finished or scrapped quantity', 'error'); return; }
        const batch_label = (el.querySelector('#jo-batch') || {}).value;
        act('/progress', { done_delta, scrapped_delta, batch_label: (batch_label || '').trim() || null });
      };
      const scrapApply = el.querySelector('#jo-scrap-apply');
      if (scrapApply) scrapApply.onclick = () => {
        const scrapped_delta = Number(el.querySelector('#jo-scrap').value);
        if (!Number.isInteger(scrapped_delta) || scrapped_delta < 0) {
          UI.toast('Use a whole, non-negative quantity', 'error'); return;
        }
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
          let n = Number(countEl.value);
          if (!Number.isInteger(n) || n < 1) n = 1;
          n = Math.min(n, 100, Math.max(1, availableToRecord));
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
        // Keep a row's retry key through a network failure. The server may have
        // saved that physical unit even when its response never reached this PC.
        const retryKeys = new WeakMap();
        let uncertainRow = null;
        unitsSubmit.onclick = async () => {
          const rowEls = [...unitRowsEl.querySelectorAll('[data-unit-row]')];
          const batchInput = el.querySelector('#jo-unit-batch');
          const batch_label = (batchInput.value || '').trim() || null;
          const pending = [];
          for (const row of rowEls) {
            if (row.dataset.saved === 'true') continue;
            const identifier = row.querySelector('.jo-unit-ident').value.trim();
            const file = row.querySelector('.jo-unit-photo').files[0];
            if (!identifier) { UI.toast('Every unit needs an identifier', 'error'); return; }
            if (!file) { UI.toast('Every unit needs a photo', 'error'); return; }
            pending.push({ row, identifier, file });
          }
          if (!pending.length) return;
          unitsSubmit.disabled = true;
          let done = 0;
          try {
            for (const p of pending) {
              uncertainRow = p.row;
              progressEl.textContent = `Recording unit ${done + 1} of ${pending.length}…`;
              // Identifier + photo in one request — the server refuses a unit without its photo.
              const fd = new FormData();
              fd.append('identifier', p.identifier);
              if (batch_label) fd.append('batch_label', batch_label);
              fd.append('image', p.file, p.file.name || 'unit.jpg');
              let key = retryKeys.get(p.row);
              if (!key) {
                key = 'jo-unit-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now());
                retryKeys.set(p.row, key);
              }
              const r = await API.upload('/job-orders/' + id + '/units', fd, { idempotencyKey: key });
              jo = r.job_order;
              p.row.dataset.saved = 'true';
              p.row.querySelectorAll('input').forEach((input) => { input.disabled = true; });
              p.row.insertAdjacentHTML('beforeend', `<span class="muted">${API.syncLocal?.(r) ? 'Saved on this PC · pending sync' : 'Saved'}</span>`);
              uncertainRow = null;
              done++;
            }
            progressEl.textContent = '';
            UI.toast(`Recorded ${done} unit${done === 1 ? '' : 's'}`);
            await refreshUnits();
            draw(); load();
          } catch (e) {
            countEl.disabled = true;
            el.querySelector('#jo-unit-dec').disabled = true;
            el.querySelector('#jo-unit-inc').disabled = true;
            if (uncertainRow && e.status && e.status < 500) retryKeys.delete(uncertainRow);
            if (uncertainRow && !e.status) {
              uncertainRow.querySelectorAll('input').forEach((input) => { input.disabled = true; });
              batchInput.disabled = true;
            }
            progressEl.textContent = `${done} of ${pending.length} confirmed in this attempt. Saved rows are locked. ${uncertainRow && !e.status ? 'The interrupted row may have saved; retry that row with the same key and values.' : 'Correct the remaining row, then retry.'}`;
            UI.toast(`Stopped after ${done} of ${pending.length}: ${e.message}`, 'error');
            try { jo = await API.get('/job-orders/' + id); } catch { /* keep entered rows for retry */ }
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
      el.querySelectorAll('[data-hold]').forEach((b) => b.onclick = () => {
        const u = held.find((x) => String(x.id) === b.dataset.hold);
        UI.modal({
          title: 'Decide held unit — ' + (u.identifier || '#' + u.id),
          bodyHTML: `<p class="muted" style="margin-top:0">${UI.esc(u.remarks || 'Held for review')}</p>
            <div><label>Decision</label><select data-f="outcome">
              <option value="pass">Pass — accept as is (goes on to RTS)</option>
              <option value="rectify">Rectify — back for correction, then recheck</option>
              <option value="fail">Fail — reject the unit</option></select></div>
            <div style="margin-top:8px" data-fail hidden><label>Disposition</label><select data-f="disposition">
              <option value="scrap">Scrap</option><option value="dispose">Dispose</option><option value="recycle">Recycle</option></select></div>
            <div style="margin-top:8px"><label>Reason <span class="req">*</span></label><textarea data-f="remarks" rows="3" maxlength="2000"></textarea></div>`,
          confirmText: 'Record decision',
          onOpen: (ov) => {
            const o = ov.querySelector('[data-f="outcome"]');
            o.onchange = () => { ov.querySelector('[data-fail]').hidden = o.value !== 'fail'; };
          },
          onConfirm: async (ov, showErr) => {
            const v = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
            if (v('remarks').length < 3) { showErr('Give the reason for the decision'); return false; }
            await API.post(`/job-orders/${id}/units/${u.id}/hold-decision`, {
              outcome: v('outcome'), remarks: v('remarks'), disposition: v('outcome') === 'fail' ? v('disposition') : undefined,
            });
            jo = await API.get('/job-orders/' + id);
            await refreshUnits(); UI.toast('Decision recorded'); draw(); load();
          },
        });
      });
      el.querySelectorAll('[data-do]').forEach((b) => b.onclick = () => {
        const d = b.dataset.do;
        // Non-administrators must give a reason for pause / resume / close early.
        if ((d === 'pause' || d === 'resume' || d === 'close') && !App.isAdmin()) {
          const what = d === 'close' ? 'close this job order early' : d;
          const reason = window.prompt(`Why ${what}? (required)`, '');
          if (reason === null) return;
          if (!reason.trim()) { UI.toast('A reason is required', 'error'); return; }
          act('/' + d, { reason: reason.trim() });
          return;
        }
        const bulk = (path, body) => API.post('/job-orders/' + path, body)
          .then(async () => { jo = await API.get('/job-orders/' + id); UI.toast('Done'); draw(); load(); })
          .catch((e) => UI.toast(e.message, 'error'));
        if (d === '_wh_accept') { bulk('warehouse-accept', { job_order_ids: [Number(id)] }); return; }
        if (d === '_supply') { purchaseShortfallModal(); return; }
        if (d === '_prepare') { prepareKitModal(); return; }
        if (d === '_release') {
          const who = window.prompt('Received by (production) — optional', jo.team_name || '');
          if (who === null) return;
          act('/release', { received_by: who.trim() || null });
          return;
        }
        if (d === 'pause') {
          const reason = window.prompt('Why pause this job order? (optional)', '');
          if (reason === null) return;
          act('/pause', { reason: reason.trim() || null });
          return;
        }
        if (d === '_delete') {
          UI.confirmDialog(`Delete draft ${jo.number}?`, 'Delete').then((ok) => {
            if (!ok) return;
            API.del('/job-orders/' + id).then(() => { UI.toast('Deleted'); m.close && m.close(); load(); }).catch((e) => UI.toast(e.message, 'error'));
          });
        } else if (d === 'cancel') {
          if (jo.conversion_job_order_id) {
            const reason = window.prompt('Why return this package to semi-built RTS? (required)', '');
            if (reason === null) return;
            if (!reason.trim()) { UI.toast('Give a reason for returning the package.', 'error'); return; }
            UI.confirmDialog(`Confirm that you counted and repacked every loose part with this same unit before returning ${jo.number} to semi-built RTS at ${UI.esc(jo.source_location_name || 'its source location')}.`, 'Return complete package')
              .then((ok) => ok && act('/cancel', { confirmed_repacked: true, reason: reason.trim() }));
          } else {
            UI.confirmDialog(`Cancel ${jo.number}? Unconsumed components are returned to ${UI.esc(jo.source_location_name || 'the source location')}.`, 'Cancel job order')
              .then((ok) => ok && act('/cancel'));
          }
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
  const cb = view.querySelector('#jo-convert');
  if (cb) cb.onclick = () => conversionModal();

  await load();
  if (filter && filter.id) trackModal(filter.id);
});
