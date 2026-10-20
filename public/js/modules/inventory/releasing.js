/* Inventory → Releasing: the warehouse side of a sale order, in pipeline order.
     1. Release Queue — approved SOs waiting for the warehouse to accept them, then the
        accepted ones being picked (scan unit labels / enter quantities).
     2. Issue the release slip once every line is out — who collected it, the vehicle, and
        photos of the goods. Issuing it confirms the SO, which is when stock goes out. When Sales'
        authorization allows a partial release, the slip can go for what is out now; the server
        keeps the rest reserved on this SO. A supervisor (inventory.adjust) may release without
        the recipient's token, with a reason (POST /release-slips/orders/:id/override).
     3. Release Slips — the printable record of everything that left.
   Backend: /api/release-slips (queue + slips), /api/orders/:id/accept-release | release |
   release-slip, photos = /api/attachments kind 'release_proof' on the order first, taken over by the
   slip as kind 'release' (both apps must send one — the server refuses the slip without). filter.tab = 'queue' | 'slips' */
App.register('releasing', async (view, filter) => {
  const canRelease = App.hasPermission('orders.release');
  const canInspectReturn = App.hasPermission('inventory.adjust');
  const canRepairReturn = canInspectReturn || App.hasPermission('production.inspect_qc') || App.hasPermission('production.inspect_qa');
  const canLinkCredit = App.hasPermission('accounting.manage');
  const tab = filter && filter.tab === 'slips' ? 'slips' : 'queue';
  const LABEL = 'margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)';

  if (tab === 'slips') await renderSlips(); else await renderQueue();

  /* ------------------------------------------------------------- 1. release queue --- */
  async function renderQueue() {
    view.innerHTML = `
      <div class="topbar">
        <h2>Release Queue</h2>
        <div class="grow"></div>
        <button class="btn secondary" id="rl-refresh">Refresh</button>
      </div>
      <div class="panel">
        <h4 style="${LABEL};margin-top:0">Waiting for warehouse acceptance</h4>
        <div id="rl-accept"><div class="empty">Loading…</div></div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h4 style="${LABEL};margin-top:0">Being released</h4>
        <div id="rl-picking"><div class="empty">Loading…</div></div>
      </div>`;
    view.querySelector('#rl-refresh').onclick = () => renderQueue();

    let q;
    try { q = await API.get('/release-slips/queue'); }
    catch (e) { view.querySelector('#rl-accept').innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }

    const acceptEl = view.querySelector('#rl-accept');
    acceptEl.innerHTML = q.to_accept.length ? `
      <table>
        <thead><tr><th>Sale order</th><th>Customer</th><th>Ship from</th><th>Expected</th><th class="right">Qty</th><th></th></tr></thead>
        <tbody>${q.to_accept.map((o) => `
          <tr>
            <td><strong>${UI.esc(o.number)}</strong></td>
            <td>${UI.esc(o.customer_name || 'Walk-in')}</td>
            <td>${UI.esc(o.location_name || 'Choose location')}</td>
            <td class="muted">${UI.esc(o.expected_date || '—')}</td>
            <td class="right">${o.qty_ordered}</td>
            <td class="actions">${canRelease ? `<button class="btn small" data-accept="${o.id}">Accept for release</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
      : UI.emptyState({ icon: 'inbox', title: 'Nothing to accept', hint: 'Sale orders appear here once they are approved.' });
    acceptEl.querySelectorAll('[data-accept]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        await API.post('/orders/' + b.dataset.accept + '/accept-release');
        UI.toast('Accepted — allocation can begin');
        await renderQueue();
        openRelease(Number(b.dataset.accept));
      } catch (e) { UI.toast(e.message, 'error'); b.disabled = false; }
    });

    const pickEl = view.querySelector('#rl-picking');
    pickEl.innerHTML = q.releasing.length ? `
      <table>
        <thead><tr><th>Sale order</th><th>Customer</th><th>Ship from</th><th>Accepted by</th><th>Expected</th><th class="right">Allocated</th><th></th></tr></thead>
        <tbody>${q.releasing.map((o) => {
          const done = o.qty_ordered > 0 && o.qty_released >= o.qty_ordered;
          return `
          <tr class="${canRelease ? 'clickable' : ''}" data-open="${o.id}">
            <td><strong>${UI.esc(o.number)}</strong></td>
            <td>${UI.esc(o.customer_name || 'Walk-in')}</td>
            <td>${UI.esc(o.location_name || '—')}</td>
            <td class="muted">${UI.esc(o.warehouse_accepted_by_name || '—')}</td>
            <td class="muted">${UI.esc(o.expected_date || '—')}</td>
            <td class="right">${o.qty_released} / ${o.qty_ordered}</td>
            <td>${done ? '<span class="badge-pill ok">Ready for slip</span>' : ''}
              ${o.open_reports ? `<span class="badge-pill warn">${o.open_reports} open report${o.open_reports === 1 ? '' : 's'}</span>` : ''}
              ${o.authorization && o.authorization.required && o.authorization.state !== 'valid'
                ? `<span class="badge-pill warn">Authorization ${UI.esc(o.authorization.state === 'none' ? 'missing' : o.authorization.state)}</span>` : ''}
              ${o.authorization && o.authorization.override && o.authorization.override.status === 'requested'
                ? '<span class="badge-pill warn" title="' + UI.esc(o.authorization.override.reason) + '">Token override requested</span>' : ''}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`
      : UI.emptyState({ icon: 'forms', title: 'Nothing being released', hint: 'Accept an order above to start picking it.' });
    if (canRelease) pickEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => openRelease(Number(tr.dataset.open)));
  }

  /* --------------------------------------------------- 2. pick / release an order --- */
  const covered = (l) => {
    const dispatched = Number(l.dispatched_qty || 0);
    const shippedSerials = Math.max(0, dispatched - Number(l.dispatched_bulk_qty || 0));
    const heldSerials = Number(l.reserved_qty || 0) + Math.max(0, Number(l.allocated_qty || 0) - shippedSerials);
    const heldBulk = Math.max(0, Number(l.released_qty || 0) - Number(l.dispatched_bulk_qty || 0));
    return dispatched + heldSerials + heldBulk;
  };

  async function openRelease(orderId) {
    let order, rc = null;
    try {
      [order, rc] = await Promise.all([
        API.get('/orders/' + orderId),
        API.get('/release-slips/orders/' + orderId + '/context').catch(() => null),
      ]);
    } catch (e) { UI.toast(e.message, 'error'); return; }

    // No footer confirm button on purpose: UI.modal clicks it on Enter in any input, and a
    // barcode scanner sends Enter after every label — the slip button lives in the body.
    const m = UI.modal({
      title: 'Release ' + order.number,
      size: 'lg',
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: '<div id="rl-body"></div>',
    });
    const body = m.overlay.querySelector('#rl-body');

    const refresh = async () => {
      [order, rc] = await Promise.all([
        API.get('/orders/' + order.id),
        API.get('/release-slips/orders/' + order.id + '/context'),
      ]);
      draw();
    };

    const post = async (payload) => {
      try {
        const r = await API.post('/orders/' + order.id + '/release', payload);
        await refresh();
        return r;
      } catch (e) { UI.toast(e.message, 'error'); return null; }
    };

    const undo = async (payload) => {
      try {
        await API.post('/orders/' + order.id + '/release/unreserve', payload);
        await refresh();
        UI.toast('Allocation undone; stock is available for another order');
      } catch (e) { UI.toast(e.message, 'error'); }
    };

    function draw() {
      const items = order.items || [];
      const stock = new Map((rc && rc.availability || []).map((l) => [Number(l.order_item_id), l]));
      const serialized = new Set((rc && rc.lines || []).filter((l) => l.serialized).map((l) => Number(l.id)));
      const heldTotal = (rc?.lines || []).filter((l) => l.item_id && l.fulfillment_mode !== 'ckd')
        .reduce((sum, l) => sum + Number(l.held_qty || 0), 0);
      // Partial release: only with Sales' authorization that allows it, and once something is out.
      const auth = (rc && rc.authorization) || {};
      const ckdParents = items.filter((l) => l.fulfillment_mode === 'ckd');
      const heldByLine = new Map((rc?.lines || []).map((l) => [Number(l.id), Number(l.held_qty || 0)]));
      const ckdPick = ckdParents.map((parent) => {
        const parts = items.filter((l) => l.parent_order_item_id === parent.id);
        const kits = parts.length ? Math.min(Number(parent.quantity), ...parts.map((p) => Math.floor(((heldByLine.get(Number(p.id)) || 0) + 1e-9) / (Number(p.quantity) / Number(parent.quantity))))) : 0;
        return { kits, clean: parts.every((p) => (heldByLine.get(Number(p.id)) || 0) <= kits * Number(p.quantity) / Number(parent.quantity) + 1e-9) };
      });
      const ckdClean = ckdPick.every((p) => p.clean);
      const fullyOut = !!rc?.order?.warehouse_accepted_at && Number(rc?.outstanding || 0) > 0
        && heldTotal + 1e-9 >= Number(rc.outstanding) && ckdClean;
      const nonCkdHeld = (rc?.lines || []).filter((l) => l.item_id && l.fulfillment_mode !== 'ckd' && l.fulfillment_mode !== 'ckd_component')
        .reduce((sum, l) => sum + Number(l.held_qty || 0), 0);
      const partialOk = !fullyOut && ckdClean && auth.state === 'valid' && !!auth.partial_allowed
        && (nonCkdHeld > 0 || ckdPick.some((p) => p.kits > 0));
      body.innerHTML = `
        <div class="kv">
          <div><span class="muted">Customer</span><div>${UI.esc(order.customer_name || 'Walk-in')}</div></div>
          <div><span class="muted">Status</span><div><span class="badge-pill status-${UI.esc(order.status)}">${UI.esc(order.status)}</span></div></div>
          <div><span class="muted">Accepted by</span><div>${UI.esc(order.warehouse_accepted_by_name || '—')}</div></div>
          <div><span class="muted">Expected</span><div>${UI.esc(order.expected_date || '—')}</div></div>
          <div><span class="muted">Ship from</span><div>${UI.esc(rc && rc.order && rc.order.location_name || 'No warehouse selected')}</div></div>
        </div>
        ${fullyOut ? '' : `
          <h4 style="${LABEL}">Scan unit labels</h4>
          <div class="search-box">${UI.icon('search', 16)}<input id="rl-scan" autocomplete="off" placeholder="Scan or type a unit label, then Enter" /></div>
          <label for="rl-serial-line" class="muted">Sale line for duplicate serial items</label>
          <select id="rl-serial-line"><option value="">Match automatically when unique</option>${items.filter((l) => l.item_id && l.fulfillment_mode !== 'ckd').map((l) => `<option value="${l.id}">${UI.esc(l.name)} · ${l.fulfillment_mode === 'semi_built' ? 'Semi-built' : l.fulfillment_mode === 'ckd_component' ? 'CKD part' : 'Fully built'} · ${UI.esc(l.quantity)} @ ${UI.esc(l.unit_price)}</option>`).join('')}</select>`}
        <h4 style="${LABEL}">Lines</h4>
        <table>
          <thead><tr><th>Item</th><th class="right">Allocated</th><th style="width:210px"></th></tr></thead>
          <tbody>${items.map((l, i) => {
            if (l.fulfillment_mode === 'ckd') return `<tr><td><strong>${UI.esc(l.name)} (CKD)</strong><div class="muted">${l.quantity} unit${l.quantity === 1 ? '' : 's'} sold · pick the parts listed below</div></td><td colspan="2" class="muted">Component stock leaves on the release slip</td></tr>`;
            if (!l.item_id) return `<tr><td>${UI.esc(l.name)}</td><td class="right muted" colspan="2">service / free-text — nothing to release</td></tr>`;
            const got = covered(l), need = Math.max(0, Number(l.quantity)-Number(l.cancelled_qty||0));
            const heldBulk=Math.max(0,Number(l.released_qty||0)-Number(l.dispatched_bulk_qty||0));
            const free = Math.max(0, Number(stock.get(Number(l.id))?.free_to_allocate || 0));
            const bulk = !serialized.has(Number(l.id));
            return `<tr>
              <td><span class="muted">${l.parent_order_item_id ? 'CKD part' : l.fulfillment_mode === 'semi_built' ? 'Semi-built' : 'Fully built / part'} · </span>${UI.esc(l.name)}${l.sku ? `<div class="muted mono">${UI.esc(l.sku)}</div>` : ''}
                <div class="muted">${bulk ? `${free} uncommitted at ship-from` : 'Scan each serial label'}</div></td>
              <td class="right">${got} / ${need} ${UI.esc(l.unit || '')}${got >= need ? ' ✓' : ''}</td>
              <td>${got < need && bulk && free > 0 ? `<div style="display:flex;gap:6px;justify-content:flex-end">
                <input type="number" min="0.001" step="any" max="${Math.min(need - got, free)}" value="${Math.min(need - got, free)}" data-qty="${i}" style="width:80px" aria-label="Allocate quantity of ${UI.esc(l.name)}" />
                <button class="btn secondary small" data-bulk="${i}">Allocate qty</button></div>` : got < need && bulk ? '<span class="muted">Awaiting stock</span>' : ''}
                ${bulk && heldBulk > 0 ? `<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">
                  <input type="number" min="0.001" step="any" max="${heldBulk}" value="${heldBulk}" data-undo-qty="${i}" style="width:80px" aria-label="Undo allocated quantity of ${UI.esc(l.name)}" />
                  <button type="button" class="btn secondary small" data-undo-bulk="${i}">Undo qty</button></div>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        ${(rc && rc.units || []).some((u) => u.status === 'reserved') ? `
          <h4 style="${LABEL}">Allocated serials</h4>
          <div class="release-allocated-serials">${rc.units.filter((u) => u.status === 'reserved').map((u) => `
            <div><span class="mono">${UI.esc(u.identifier || `Unit #${u.id}`)}</span>
              <button type="button" class="btn secondary small" data-undo-unit="${u.id}" aria-label="Undo allocation of ${UI.esc(u.identifier || `unit ${u.id}`)}">Undo allocation</button></div>`).join('')}</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;margin-top:16px">
          <span class="muted" style="font-size:12px">${fullyOut
            ? 'Every stock line is allocated. Issue the trip slip as the goods leave; directly sold units were already deducted.'
            : partialOk
              ? 'Sales allowed a partial release: the slip covers what is out now, and the rest remains held on this sales order.'
              : ckdPick.some((p) => !p.clean) ? 'Only complete CKD kits may leave. Unreserve extra picked parts or complete another kit.'
              : 'Allocate every stock line before issuing the release slip.'}</span>
          <div class="grow"></div>
          <button class="btn" id="rl-slip" ${fullyOut || partialOk ? '' : 'disabled'}>${UI.icon('sheet')} ${partialOk ? 'Issue partial release slip' : 'Issue release slip'}</button>
        </div>`;

      const scan = body.querySelector('#rl-scan');
      if (scan) {
        scan.focus();
        scan.addEventListener('keydown', async (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const code = scan.value.trim();
          if (!code) return;
          scan.value = '';
          scan.disabled = true;
          if (await post({ codes: [code], order_item_id: Number(body.querySelector('#rl-serial-line')?.value) || undefined })) UI.toast(code + ' allocated');
          else scan.disabled = false;
        });
      }
      body.querySelectorAll('[data-bulk]').forEach((b) => b.onclick = async () => {
        const l = items[Number(b.dataset.bulk)];
        const q = Number(body.querySelector(`[data-qty="${b.dataset.bulk}"]`).value);
        const free = Number(stock.get(Number(l.id))?.free_to_allocate || 0);
        if (!Number.isFinite(q) || q <= 0 || q > free || q > Number(l.quantity) - covered(l)) {
          UI.toast(`Enter a quantity up to ${Math.min(free, Number(l.quantity) - covered(l))}`, 'error'); return;
        }
        b.disabled = true;
        if (await post({ bulk: [{ item_id: l.item_id, order_item_id: l.id, quantity: q }] })) UI.toast(`${l.name} ×${q} allocated`);
        else b.disabled = false;
      });
      body.querySelectorAll('[data-undo-bulk]').forEach((b) => b.onclick = async () => {
        const l = items[Number(b.dataset.undoBulk)];
        const q = Number(body.querySelector(`[data-undo-qty="${b.dataset.undoBulk}"]`).value);
        if (!Number.isFinite(q) || q <= 0 || q > Math.max(0,Number(l.released_qty||0)-Number(l.dispatched_bulk_qty||0))) {
          UI.toast(`Enter a quantity up to ${l.released_qty || 0}`, 'error'); return;
        }
        if (!(await UI.confirmDialog(`Undo ${q} allocated ${l.name}?`, 'Undo allocation'))) return;
        b.disabled = true;
        await undo({ bulk: [{ item_id: l.item_id, order_item_id: l.id, quantity: q }] });
        if (b.isConnected) b.disabled = false;
      });
      body.querySelectorAll('[data-undo-unit]').forEach((b) => b.onclick = async () => {
        if (!(await UI.confirmDialog('Remove this serial allocation? The customer’s remaining demand stays committed.', 'Undo allocation'))) return;
        b.disabled = true;
        await undo({ unit_ids: [Number(b.dataset.undoUnit)] });
        if (b.isConnected) b.disabled = false;
      });
      body.querySelector('#rl-slip').onclick = () => slipModal(order, () => { m.close(); if (tab === 'queue') renderQueue(); }, partialOk);
    }
    draw();
  }

  /* ------------------------------------------------------ 3. issue the release slip --- */
  async function slipModal(order, onDone, partial) {
    const photos = []; // File[]
    let slipAttempt = null;
    const newKey = (prefix) => prefix + ':' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    // Warehouse-out rules (release-auth.ts): the recipient's token when Sales issued an
    // authorization, and every required package item. The server re-checks both.
    let rc = { authorization: { state: 'none' }, package: [] };
    try { rc = await API.get('/release-slips/orders/' + order.id + '/context'); } catch (e) { /* older server: plain slip */ }
    const auth = rc.authorization || { state: 'none' };
    // A supervisor's approved override stands in for the token; a supervisor can make one here.
    const tov = auth.override || null;
    const ovOk = !!tov && tov.status === 'approved';
    const canOverride = !ovOk && App.hasPermission('inventory.adjust');
    const authBlock = auth.state === 'valid'
      ? `<div class="panel" style="padding:10px 12px;margin-bottom:10px">
           <div><b>${UI.esc(auth.mode === 'delivery' ? 'Delivery' : 'Customer pickup')}</b> · approved recipient
             <b>${UI.esc(auth.recipient_name)}</b>${auth.id_reference ? ' · ID ' + UI.esc(auth.id_reference) : ''}</div>
           ${ovOk
             ? `<div style="margin-top:8px"><span class="badge-pill ok">Supervisor override</span> ${UI.esc(tov.decided_by_name || '')}:
                  ${UI.esc(tov.decision_note || tov.reason)} — the token isn't needed.</div>`
             : `<div style="margin-top:8px" data-token-row><label>Release token the recipient presents <span class="req">*</span></label>
                  <input data-f="authorization_token" placeholder="${UI.esc(auth.token_hint)}" style="text-transform:uppercase" /></div>`}
           ${tov && tov.status === 'requested' ? `<div class="muted" style="margin-top:6px">${UI.esc(tov.requested_by_name || 'The releaser')} asked to release without the token: ${UI.esc(tov.reason)}</div>` : ''}
           ${canOverride ? `<label style="display:flex;gap:8px;align-items:center;margin-top:8px">
               <input type="checkbox" data-ov /> Release without the token (supervisor override)</label>
             <div data-ov-row hidden style="margin-top:6px"><label>Reason <span class="req">*</span></label>
               <input data-f="override_reason" maxlength="500" placeholder="e.g. ID checked in person against the order" /></div>` : ''}
         </div>`
      : auth.state !== 'none' || auth.required
        ? `<div class="error" style="margin-bottom:10px">Release authorization ${UI.esc(auth.state === 'none' ? 'missing' : auth.state)} —
             Sales must issue a valid one on the sale order before the goods can leave.</div>`
        : '';
    const pkgBlock = (rc.package || []).length ? `
        <h4 style="${LABEL}">Package — confirm each item leaves with the goods</h4>
        ${rc.package.map((p, i) => `<label style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <input type="checkbox" data-pkg="${i}" /> ${UI.esc(p.item_name)}: ${UI.esc(p.label)}${p.required ? ' <span class="req">*</span>' : ''}</label>`).join('')}
        <div style="margin-top:8px"><label>Package seal / tag</label><input data-f="seal_tag" placeholder="Optional" /></div>` : '';
    UI.modal({
      title: 'Release slip — ' + order.number,
      bodyHTML: `
        <p class="muted" style="margin-top:0">Record who took the goods out. Issuing the slip records
          ${UI.esc(order.number)} and deducts stock still on hand. Units sold directly were already deducted.</p>
        ${partial ? '<div class="panel" style="padding:10px 12px;margin-bottom:10px"><b>Partial release.</b> Only what is out now leaves; the rest of the order stays reserved here.</div>' : ''}
        <div class="panel"><b>This vehicle’s load</b><p class="muted">Only this load leaves. The remainder stays reserved on this order.</p>${(rc.lines||[]).filter(l=>l.item_id&&l.fulfillment_mode!=='ckd'&&Number(l.held_qty||0)>0).map(l=>{
          const units=(rc.units||[]).filter(u=>u.order_item_id===l.id&&(u.status==='reserved'||u.pending_direct));
          const batches=(rc.batch_allocations||[]).filter(a=>a.order_item_id===l.id&&a.state==='reserved');
          const bulk=Math.max(0,l.held_qty-units.length-batches.reduce((n,a)=>n+a.quantity,0));
          return `<fieldset data-trip-line="${l.id}"><legend>Line #${l.id} · ${UI.esc(l.name)} · ${l.held_qty} for this trip</legend>
            ${units.map(u=>`<label><input type="checkbox" data-trip-unit="${u.id}" ${u.pending_direct?'disabled':''} checked> ${UI.esc(u.identifier||'Unit #'+u.id)}${u.pending_direct?' · already out; required on this slip':''}</label>`).join('')}
            ${batches.map(a=>`<label>${UI.esc(a.batch_number)} · ${a.quantity} reserved<input type="number" min="0" max="${a.quantity}" step="any" data-trip-batch="${a.id}" value="${a.quantity}"></label>`).join('')}
            ${bulk>0?`<label>Other reserved quantity<input type="number" min="0" max="${bulk}" step="any" data-trip-bulk value="${bulk}"></label>`:''}</fieldset>`;
        }).join('')}</div>
        ${authBlock}
        <div><label>Collected by <span class="req">*</span></label>
          <input data-f="collected_by" placeholder="Driver / customer representative" value="${auth.state === 'valid' ? UI.esc(auth.recipient_name) : ''}" /></div>
        <div class="field-row" style="margin-top:10px">
          <div><label>Vehicle / plate no.</label><input data-f="vehicle_plate" placeholder="Optional" /></div>
        </div>
        <div style="margin-top:10px"><label>Notes</label><input data-f="notes" placeholder="Optional" /></div>
        ${pkgBlock}
        <h4 style="${LABEL}">Photos of the outgoing goods <span class="req">*</span></h4>
        <input type="file" id="rl-photo-in" accept="image/*" capture="environment" multiple hidden />
        <div id="rl-photos" style="display:flex;flex-wrap:wrap;gap:8px"></div>
        <button type="button" class="btn secondary small" id="rl-photo-add" style="margin-top:8px">${UI.icon('plus')} Add photo</button>`,
      confirmText: 'Issue slip',
      onOpen: (ov) => {
        const input = ov.querySelector('#rl-photo-in');
        const grid = ov.querySelector('#rl-photos');
        const drawPhotos = () => {
          grid.innerHTML = photos.map((f, i) => `
            <div style="position:relative;width:96px;height:96px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
              <img src="${URL.createObjectURL(f)}" alt="" style="width:100%;height:100%;object-fit:cover" />
              <button type="button" class="icon-btn danger" data-rm="${i}" title="Remove"
                style="position:absolute;top:2px;right:2px;background:var(--surface)">${UI.icon('trash')}</button>
            </div>`).join('');
          grid.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { photos.splice(Number(b.dataset.rm), 1); drawPhotos(); });
        };
        const ovBox = ov.querySelector('[data-ov]');
        if (ovBox) ovBox.onchange = () => {
          ov.querySelector('[data-ov-row]').hidden = !ovBox.checked;
          const tr = ov.querySelector('[data-token-row]');
          if (tr) tr.hidden = ovBox.checked;
        };
        ov.querySelector('#rl-photo-add').onclick = () => input.click();
        input.onchange = () => { photos.push(...input.files); input.value = ''; drawPhotos(); };
      },
      onConfirm: async (ov, showErr) => {
        const val = (k) => { const el = ov.querySelector(`[data-f="${k}"]`); return el ? el.value.trim() : ''; };
        if (!val('collected_by')) { showErr('Enter who collected the goods'); return false; }
        const overriding = !!(ov.querySelector('[data-ov]') && ov.querySelector('[data-ov]').checked);
        if (overriding && val('override_reason').length < 5) { showErr('Give the reason for releasing without the token'); return false; }
        if (auth.state === 'valid' && !ovOk && !overriding && !val('authorization_token')) { showErr('Enter the release token the recipient presents'); return false; }
        const pkg = (rc.package || []).map((p, i) => ({ item_id: p.item_id, label: p.label, ok: ov.querySelector(`[data-pkg="${i}"]`).checked }));
        const shipping=[...ov.querySelectorAll('[data-trip-line]')].filter(box=>box.querySelector('[data-trip-unit]:checked')||[...box.querySelectorAll('input[type=number]')].some(e=>Number(e.value)>0)).map(box=>Number(box.dataset.tripLine));
        const shippingItems=(rc.lines||[]).filter(l=>shipping.includes(l.id)||l.fulfillment_mode==='ckd'&&(rc.lines||[]).some(p=>p.parent_order_item_id===l.id&&shipping.includes(p.id))).map(l=>l.item_id);
        const missing = (rc.package || []).filter((p, i) => shippingItems.includes(p.item_id)&&p.required && !pkg[i].ok);
        if (missing.length) { showErr('Confirm every required package item: ' + missing.map((p) => p.label).join(', ')); return false; }
        if (!photos.length) { showErr('Add at least one photo of the goods going out'); return false; }
        if (overriding) await API.post('/release-slips/orders/' + order.id + '/override', { approve: true, reason: val('override_reason') });
        // Photos first, on the order (each once across retries): the slip takes them over, and the
        // server refuses a warehouse-out without one. If an upload fails nothing has moved.
        for (const f of photos) {
          if (f._attId) continue;
          const fd = new FormData();
          fd.append('kind', 'release_proof');
          fd.append('ref_id', String(order.id));
          fd.append('caption', 'Goods going out');
          fd.append('image', f);
          f._uploadKey = f._uploadKey || newKey('release-photo');
          try { f._attId = (await API.upload('/attachments', fd, { idempotencyKey: f._uploadKey })).id; }
          catch (e) { showErr('Photo confirmation is unknown. Retry this upload with the same photo; warehouse-out has not been submitted. ' + e.message); return false; }
        }
        const tripLines=[...ov.querySelectorAll('[data-trip-line]')].map(box=>{
          const unit_ids=[...box.querySelectorAll('[data-trip-unit]:checked')].map(e=>Number(e.dataset.tripUnit));
          const counts=[...box.querySelectorAll('input[type=number]')];
          if(counts.some(e=>!e.value.trim()||!Number.isFinite(Number(e.value))||Number(e.value)<0||Number(e.value)>Number(e.max)))return {quantity:NaN};
          return {order_item_id:Number(box.dataset.tripLine),unit_ids,batches:counts.filter(e=>e.dataset.tripBatch&&Number(e.value)>0).map(e=>({allocation_id:Number(e.dataset.tripBatch),quantity:Number(e.value)})),quantity:unit_ids.length+counts.reduce((n,e)=>n+Number(e.value),0)};
        });
        if(tripLines.some(l=>!Number.isFinite(l.quantity)||l.quantity<0)||!tripLines.some(l=>l.quantity>0)){showErr('Choose a positive trip load.');return false;}
        const payload = {
          lines:tripLines.filter(l=>l.quantity>0),
          previous_slip_id:rc.slip?rc.slip.id:null,
          collected_by: val('collected_by'), vehicle_plate: val('vehicle_plate') || null, notes: val('notes') || null,
          authorization_token: overriding ? null : (val('authorization_token').toUpperCase() || null), seal_tag: val('seal_tag') || null, package: pkg,
          evidence_ids: photos.map((f) => f._attId),
        };
        const signature = JSON.stringify(payload);
        if (!slipAttempt || slipAttempt.signature !== signature) slipAttempt = { signature, key: newKey('release-slip') };
        let r;
        try { r = await API.post('/orders/' + order.id + '/release-slip', payload, { idempotencyKey: slipAttempt.key }); }
        catch (e) {
          showErr(e.status && e.status < 500 ? e.message
            : 'Release confirmation is unknown. Keep this form open and retry; the same request key will be used. ' + e.message); return false;
        }
        UI.toast(r.backorder ? `Release slip issued — the rest is on backorder ${r.backorder.number}` : 'Release slip issued — stock deducted');
        if (onDone) onDone();
        slipView(r.id);
      },
    });
  }

  /* ----------------------------------------------------------- 4. release slip list --- */
  async function renderSlips() {
    view.innerHTML = `
      <div class="topbar">
        <h2>Release Slips</h2>
        <div class="grow"></div>
        <div class="search-box">${UI.icon('search', 16)}<input id="rs-q" placeholder="Slip, order, customer, collector…" /></div>
      </div>
      <div class="panel"><div id="rs-table"><div class="empty">Loading…</div></div></div>`;
    const tableEl = view.querySelector('#rs-table');
    const qEl = view.querySelector('#rs-q');
    let timer = null;
    qEl.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };

    async function load() {
      const q = qEl.value.trim();
      let rows;
      try { rows = await API.get('/release-slips' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { tableEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!rows.length) {
        tableEl.innerHTML = UI.emptyState({ icon: 'sheet', title: q ? 'No matching slips' : 'No release slips yet',
          hint: 'A slip is issued from the Release Queue once every line of a sale order is out.' });
        return;
      }
      tableEl.innerHTML = `
        <table>
          <thead><tr><th>Slip</th><th>Sale order</th><th>Customer</th><th>Collected by</th><th>Released by</th><th>Date</th><th class="right">Photos</th></tr></thead>
          <tbody>${rows.map((s) => `
            <tr class="clickable" data-open="${s.id}">
              <td><strong>${UI.esc(s.number)}</strong></td>
              <td>${UI.esc(s.order_number)}${s.order_status === 'cancelled' ? ' <span class="badge-pill low">cancelled</span>' : ''}</td>
              <td>${UI.esc(s.customer_name || 'Walk-in')}</td>
              <td>${UI.esc(s.collected_by || '—')}${s.vehicle_plate ? `<div class="muted">${UI.esc(s.vehicle_plate)}</div>` : ''}</td>
              <td class="muted">${UI.esc(s.released_by_name || '—')}</td>
              <td class="muted">${UI.esc(UI.fmtDate(s.released_at))}</td>
              <td class="right">${s.photo_count}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => slipView(Number(tr.dataset.open)));
    }
    await load();
  }

  async function courierBooking(slip,mode='courier') {
    var dispatch;try{dispatch=await API.get('/deliveries/planning-context?order_id='+slip.order_id);}catch(e){UI.toast(e.message,'error');return;}
    const bookingKey = 'courier-book:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
    const m = UI.modal({ title: (mode==='own'?'Book own delivery — ':'Book courier pickup — ') + slip.order_number, confirmText: 'Book trip',
      bodyHTML: `<p class="muted">This booking contains only this slip’s load. Record the trip outcome separately when it happens.</p>
        ${mode==='courier'?'<div><label>Courier company <span class="req">*</span></label><input data-f="courier" maxlength="160" placeholder="Courier name" /></div>':''}
        <label>Assigned driver / staff<select data-f="driver"><option value="">Choose staff</option>${dispatch.drivers.map(u=>`<option value="${u.id}">${UI.esc(u.full_name)}</option>`).join('')}</select></label>
        <div style="margin-top:10px"><label>Tracking / waybill</label><input data-f="tracking" maxlength="160" placeholder="Optional until pickup" /></div>`,
      onConfirm: async (ov, showErr) => {
        const courier = mode==='courier'?ov.querySelector('[data-f="courier"]').value.trim():null;
        const assigned=Number(ov.querySelector('[data-f="driver"]').value)||null;
        if(!assigned){showErr('Choose the assigned driver/staff.');return false;}
        if (mode==='courier'&&!courier) { showErr('Enter the courier company'); return false; }
        try {
          try { await API.post('/deliveries', { order_id: slip.order_id, delivery_mode: mode,assigned_to:assigned,release_slip_id:slip.id,courier_name: courier,
            tracking_number: ov.querySelector('[data-f="tracking"]').value.trim() || null }, { idempotencyKey: bookingKey }); }
          catch (error) { throw error; }
          UI.toast(mode==='own'?'Delivery trip booked':'Courier pickup booked'); m.close(); slipView(slip.id); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function courierPickup(slip, deliveryId) {
    const pickupKey = 'courier-pickup:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
    const photoKey = 'courier-photo:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
    let uploaded = false;
    const m = UI.modal({ title: 'Confirm courier pickup — ' + slip.order_number, confirmText: 'Confirm pickup',
      bodyHTML: `<p class="muted">This closes our delivery task when the courier physically accepts the goods. Photograph the handoff or waybill.</p>
        <div><label>Courier representative (optional)</label><input data-f="collector" maxlength="160" placeholder="Name of person collecting" /></div>
        <div style="margin-top:10px"><label>Tracking / waybill</label><input data-f="tracking" maxlength="160" /></div>
        <div style="margin-top:10px"><label>Pickup photo (optional)</label><input data-f="photo" type="file" accept="image/*" capture="environment" /></div>`,
      onConfirm: async (ov, showErr) => {
        const collector = ov.querySelector('[data-f="collector"]').value.trim();
        const file = ov.querySelector('[data-f="photo"]').files[0];
        try {
          if (file && !uploaded) {
            const fd = new FormData(); fd.append('kind', 'delivery'); fd.append('ref_id', String(deliveryId)); fd.append('image', file);
            await API.upload('/attachments', fd, { idempotencyKey: photoKey }); uploaded = true;
          }
          try { await API.post('/deliveries/' + deliveryId + '/complete', { outcome: 'courier_handoff', recipient: collector || null,
            tracking_number: ov.querySelector('[data-f="tracking"]').value.trim() || null }, { idempotencyKey: pickupKey }); }
          catch (error) {
            const current = await API.get('/deliveries/' + deliveryId).catch(() => null);
            if (!(current?.status === 'delivered' && current?.delivery_mode === 'courier' && current?.pod_recipient === (collector || null))) throw error;
          }
          UI.toast('Courier pickup recorded'); m.close(); slipView(slip.id); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  /* ------------------------------------------------------- 5. one slip: view / print --- */
  async function slipView(id) {
    let slip, photos, company, returnsContext, deliveries;
    try {
      [slip, photos, company, returnsContext] = await Promise.all([
        API.get('/release-slips/' + id),
        API.get('/attachments?kind=release&ref_id=' + id).catch(() => []),
        API.get('/templates/company').catch(() => ({})),
        API.get('/sales-returns/slips/' + id + '/context'),
      ]);
      deliveries = (App.hasPermission('delivery.run') || App.hasPermission('delivery.manage'))
        ? await API.get('/deliveries?order_id=' + slip.order_id).catch(() => []) : [];
    } catch (e) { UI.toast(e.message, 'error'); return; }
    // Attachment images need the auth header, so load them as blob URLs.
    const urls = await Promise.all(photos.map((p) => API.blobUrl(p.url.replace(/^\/api/, '')).catch(() => '')));
    deliveries=deliveries.filter(d=>d.release_slip_id===slip.id);
    const activeShipment = deliveries.find((d) => ['pending', 'out_for_delivery'].includes(d.status));

    const itemsTable = `
      <table class="doc-table">
        <thead><tr><th>Item</th><th>Unit serials</th><th class="r">Qty</th></tr></thead>
        <tbody>${(slip.items || []).map((it) => `<tr>
          <td>${UI.esc(it.name)}${it.sku ? `<div style="color:#667">${UI.esc(it.sku)}</div>` : ''}</td>
          <td style="font-family:monospace;font-size:11.5px">${UI.esc(it.unit_identifiers || '—')}</td>
          <td class="r">${it.quantity} ${UI.esc(it.unit || '')}</td></tr>`).join('')}</tbody>
      </table>`;
    const photoGrid = (cls) => urls.filter(Boolean).map((u) =>
      `<img src="${u}" alt="" class="${cls}" style="width:160px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #ccd" />`).join('');

    const printHtml = `<div class="doc">
      <header class="doc-head">
        <div class="doc-company"><h1>${UI.esc(company.name || '')}</h1><div>${UI.esc(company.address || '')}</div></div>
        <div class="doc-meta"><h2>RELEASE SLIP</h2><div>No: ${UI.esc(slip.number)}</div><div>${UI.esc(UI.fmtDate(slip.released_at))}</div></div>
      </header>
      <div class="doc-parties">
        <div><strong>Sale order:</strong> ${UI.esc(slip.order_number)}<br><strong>Customer:</strong> ${UI.esc(slip.customer_name || 'Walk-in')}</div>
        <div><strong>Collected by:</strong> ${UI.esc(slip.collected_by || '')}<br><strong>Vehicle:</strong> ${UI.esc(slip.vehicle_plate || '—')}</div>
      </div>
      ${itemsTable}
      ${slip.notes ? `<p><strong>Notes:</strong> ${UI.esc(slip.notes)}</p>` : ''}
      ${slip.override_reason ? `<p><strong>Released without token — supervisor override by ${UI.esc(slip.override_by_name || '')}:</strong> ${UI.esc(slip.override_reason)}</p>` : ''}
      ${urls.some(Boolean) ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 18px">${photoGrid('')}</div>` : ''}
      <div style="display:flex;justify-content:space-between;gap:40px;margin-top:40px">
        <div style="flex:1;border-top:1px solid #333;padding-top:4px">Released by: ${UI.esc(slip.released_by_name || '')}</div>
        <div style="flex:1;border-top:1px solid #333;padding-top:4px">Received by: ${UI.esc(slip.collected_by || '')}</div>
      </div>
    </div>`;

    const m = UI.modal({
      title: 'Release slip ' + slip.number,
      size: 'lg',
      cancelText: 'Close',
      confirmText: 'Print…',
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">Sale order</span><div>${UI.esc(slip.order_number)}</div></div>
          <div><span class="muted">Customer</span><div>${UI.esc(slip.customer_name || 'Walk-in')}</div></div>
          <div><span class="muted">Collected by</span><div>${UI.esc(slip.collected_by || '—')}</div></div>
          <div><span class="muted">Vehicle</span><div>${UI.esc(slip.vehicle_plate || '—')}</div></div>
          <div><span class="muted">Released by</span><div>${UI.esc(slip.released_by_name || '—')}</div></div>
          <div><span class="muted">Released</span><div>${UI.esc(UI.fmtDate(slip.released_at))}</div></div>
          ${slip.override_reason ? `<div><span class="muted">Token</span><div>Supervisor override by ${UI.esc(slip.override_by_name || '—')}: ${UI.esc(slip.override_reason)}</div></div>` : ''}
        </div>
        ${slip.notes ? `<p style="margin:12px 0 0"><span class="muted">Notes:</span> ${UI.esc(slip.notes)}</p>` : ''}
        <div style="display:flex;align-items:center;gap:8px;margin:16px 0 6px;flex-wrap:wrap">
          <h4 style="${LABEL};margin:0">Courier pickup</h4><div class="grow"></div>
          ${App.hasPermission('delivery.manage') && !activeShipment && !deliveries.some((d) => d.status === 'delivered') ? '<button type="button" class="btn secondary small" id="rs-book-own">Book own delivery</button><button type="button" class="btn secondary small" id="rs-book-courier">Book courier</button>' : ''}
        </div>
        ${activeShipment?.delivery_mode === 'own' ? '<p class="muted">Our delivery team has an active booking for this sale. Complete or cancel that booking before choosing a courier.</p>' : ''}
        ${deliveries.filter((d) => d.delivery_mode === 'courier').map((d) => `<div class="panel" style="padding:10px 12px;margin-bottom:8px">
          <b>${UI.esc(d.courier_name || 'Courier')}</b> · ${d.status === 'delivered' ? 'Picked up' : UI.esc(d.status)}
          ${d.tracking_number ? ` · Tracking ${UI.esc(d.tracking_number)}` : ''}
          ${d.pod_recipient ? `<div class="muted">Collected by ${UI.esc(d.pod_recipient)} · ${UI.esc(UI.fmtDate(d.delivered_at))}</div>` : ''}
          ${d.status === 'pending' && App.hasPermission('delivery.manage') ? `<button type="button" class="btn secondary small" data-courier-pickup="${d.id}" style="margin-top:8px">Confirm courier pickup</button>` : ''}
        </div>`).join('') || '<p class="muted">No courier booking for this release.</p>'}
        <h4 style="${LABEL}">Goods released</h4>
        <table>
          <thead><tr><th>Item</th><th>Unit serials</th><th class="right">Qty</th></tr></thead>
          <tbody>${(slip.items || []).map((it) => `<tr>
            <td>${UI.esc(it.name)}${it.sku ? `<div class="muted mono">${UI.esc(it.sku)}</div>` : ''}</td>
            <td class="mono" style="font-size:12px">${UI.esc(it.unit_identifiers || '—')}</td>
            <td class="right">${it.quantity} ${UI.esc(it.unit || '')}</td></tr>`).join('')}</tbody>
        </table>
        <div style="display:flex;align-items:center;gap:8px;margin:16px 0 6px;flex-wrap:wrap">
          <h4 style="${LABEL};margin:0">Customer returns</h4><div class="grow"></div>
          ${canRelease ? '<button type="button" class="btn secondary small" id="rs-return">Record goods received</button>' : ''}
        </div>
        <p class="muted" style="margin:0 0 8px">Receipt records physical arrival. Only inspected goods marked restock become available again; Finance handles the customer credit separately.</p>
        ${returnsContext.returns.length ? `<div class="table-scroll"><table><thead><tr><th>Return</th><th>Item</th><th>Qty</th><th>Status</th><th>Credit</th><th></th></tr></thead><tbody>
          ${returnsContext.returns.map((r) => `<tr><td>${UI.esc(r.number)}</td><td>${UI.esc(r.item_name)}<div class="muted">${UI.esc(r.reason)}</div></td><td>${r.quantity}</td><td>${UI.esc(r.disposition_state === 'repair' ? 'Repair in progress' : r.disposition_state === 'awaiting_inspection' ? 'Reinspect after repair' : r.disposition_state === 'completed' ? 'Repaired · restocked' : r.disposition_state === 'salvaged' ? 'Salvaged · damage stock' : r.disposition_state === 'disposed' ? 'Disposed' : r.status)}${r.condition_note ? `<div class="muted">${UI.esc(r.condition_note)}</div>` : ''}${r.decision_note ? `<div class="muted">${UI.esc(r.decision_note)}</div>` : ''}</td><td>${r.credit_note_status === 'issued' ? '#' + r.credit_note_id : r.credit_note_status === 'void' ? 'Voided · replace' : 'Pending Finance'}</td><td class="actions">
            ${canInspectReturn && r.status === 'received' ? `<button type="button" class="btn secondary small" data-inspect="${r.id}">Inspect</button>` : ''}
            ${canInspectReturn && r.status === 'rejected' && !r.disposition_state ? `<button type="button" class="btn secondary small" data-dispose="${r.id}">Decide next step</button>` : ''}
            ${canRepairReturn && r.disposition_state === 'repair' ? `<button type="button" class="btn secondary small" data-rework="${r.id}">Repair work</button>` : ''}
            ${canInspectReturn && r.disposition_state === 'awaiting_inspection' ? `<button type="button" class="btn secondary small" data-reinspect="${r.id}">Reinspect</button>` : ''}
            ${r.disposition_state ? `<button type="button" class="btn secondary small" data-return-history="${r.id}">History</button>` : ''}
            ${canLinkCredit && r.credit_note_status !== 'issued' ? `<button type="button" class="btn secondary small" data-credit="${r.id}">Link credit</button>` : ''}
          </td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No returns recorded for this slip.</p>'}
        <div style="display:flex;align-items:center;margin:16px 0 6px">
          <h4 style="${LABEL};margin:0">Photos</h4><div class="grow"></div>
          ${canRelease ? `<button type="button" class="btn secondary small" id="rs-add-photo">${UI.icon('plus')} Add photo</button>
            <input type="file" id="rs-photo-in" accept="image/*" capture="environment" multiple hidden />` : ''}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${urls.some(Boolean) ? photoGrid('') : '<span class="muted">No photos.</span>'}</div>`,
      onOpen: (ov) => {
        ov.querySelector('#rs-book-own')?.addEventListener('click',()=>{m.close();courierBooking(slip,'own');});
        ov.querySelector('#rs-book-courier')?.addEventListener('click', () => { m.close(); courierBooking(slip); });
        ov.querySelectorAll('[data-courier-pickup]').forEach((b) => b.onclick = () => { m.close(); courierPickup(slip, Number(b.dataset.courierPickup)); });
        ov.querySelector('#rs-return')?.addEventListener('click', () => { m.close(); receiveReturn(slip, returnsContext); });
        ov.querySelectorAll('[data-inspect]').forEach((b) => b.onclick = () => { m.close(); inspectReturn(id, Number(b.dataset.inspect)); });
        ov.querySelectorAll('[data-dispose]').forEach((b) => b.onclick = () => { m.close(); decideReturn(id, Number(b.dataset.dispose)); });
        ov.querySelectorAll('[data-rework]').forEach((b) => b.onclick = () => { m.close(); repairReturn(id, Number(b.dataset.rework)); });
        ov.querySelectorAll('[data-reinspect]').forEach((b) => b.onclick = () => { m.close(); reinspectReturn(id, Number(b.dataset.reinspect)); });
        ov.querySelectorAll('[data-return-history]').forEach((b) => b.onclick = () => { m.close(); returnHistory(id, Number(b.dataset.returnHistory)); });
        ov.querySelectorAll('[data-credit]').forEach((b) => b.onclick = () => { m.close(); linkReturnCredit(id, Number(b.dataset.credit)); });
        const add = ov.querySelector('#rs-add-photo');
        if (!add) return;
        const input = ov.querySelector('#rs-photo-in');
        add.onclick = () => input.click();
        input.onchange = async () => {
          for (const f of input.files) {
            const fd = new FormData();
            fd.append('kind', 'release');
            fd.append('ref_id', String(slip.id));
            fd.append('image', f);
            try { await API.upload('/attachments', fd); } catch (e) { UI.toast(e.message, 'error'); }
          }
          m.close();
          slipView(slip.id);
        };
      },
      onConfirm: () => {
        UI.modal({
          title: slip.number + ' — Preview',
          size: 'lg',
          cancelText: 'Close',
          confirmText: 'Print…',
          bodyHTML: '<iframe id="rs-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>',
          onOpen: (ov) => { ov.querySelector('#rs-frame').srcdoc = UI.printableHtml(printHtml, slip.number); },
          onConfirm: (ov) => {
            const ifr = ov.querySelector('#rs-frame');
            ifr.contentWindow.focus();
            ifr.contentWindow.print();
            return false;
          },
        });
        return false;
      },
    });
  }

  function receiveReturn(slip, context) {
    const available = context.lines.filter((l) => l.item_id && l.quantity - l.returned_qty > 0);
    if (!available.length) { UI.toast('Every shipped item is already accounted for in returns.', 'error'); slipView(slip.id); return; }
    let photo = null;
    let saveKey = 'sales-return:' + crypto.randomUUID();
    const m = UI.modal({
      title: 'Receive customer return · ' + slip.number, size: 'lg', confirmText: 'Record receipt',
      bodyHTML: `<p class="order-notice">Recording receipt does not increase stock. Inspect the item before it can be restocked.</p>
        <div class="form-grid">
          <div class="form-field span2"><label>Shipped item</label><select id="sr-line">${available.map((l) => `<option value="${l.id}">${UI.esc(l.name)} · ${l.quantity - l.returned_qty} remaining</option>`).join('')}</select></div>
          <div class="form-field"><label>Quantity received</label><input id="sr-qty" type="number" min="0.001" step="any" value="1" /></div>
          <div class="form-field"><label>Serial, if applicable</label><select id="sr-unit"><option value="">Bulk item</option></select></div>
          <div class="form-field span2"><label>Reason for return</label><textarea id="sr-reason" rows="2" placeholder="What did the customer report?"></textarea></div>
          <div class="form-field span2"><label>Photo of goods received</label><input id="sr-photo" type="file" accept="image/*" capture="environment" /></div>
        </div>`,
      onOpen: (ov) => {
        const line = ov.querySelector('#sr-line');
        const unit = ov.querySelector('#sr-unit');
        const qty = ov.querySelector('#sr-qty');
        const refresh = () => {
          const selected = available.find((l) => l.id === Number(line.value));
          const units = context.units.filter((u) => u.item_id === selected.item_id);
          unit.innerHTML = units.length ? units.map((u) => `<option value="${u.id}">${UI.esc(u.identifier || '#' + u.id)}</option>`).join('') : '<option value="">Bulk item</option>';
          unit.disabled = !units.length;
          qty.max = String(selected.quantity - selected.returned_qty);
          if (units.length) { qty.value = '1'; qty.disabled = true; } else { qty.disabled = false; qty.value = String(Math.min(1, selected.quantity - selected.returned_qty)); }
        };
        line.onchange = refresh; refresh();
      },
      onConfirm: async (ov, showErr) => {
        const line = available.find((l) => l.id === Number(ov.querySelector('#sr-line').value));
        const quantity = Number(ov.querySelector('#sr-qty').value);
        const reason = ov.querySelector('#sr-reason').value.trim();
        const file = ov.querySelector('#sr-photo').files[0] || photo;
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > line.quantity - line.returned_qty) { showErr('Enter a quantity no greater than the shipped remainder.'); return false; }
        if (reason.length < 5) { showErr('Describe the reason for return.'); return false; }
        if (!file) { showErr('Take or select a photo of the returned goods.'); return false; }
        photo = file;
        if (!file._returnAttachmentId) {
          const fd = new FormData(); fd.append('kind', 'sales_return_proof'); fd.append('ref_id', String(slip.id)); fd.append('image', file);
          try { file._returnAttachmentId = (await API.upload('/attachments', fd)).id; }
          catch (e) { showErr('Photo upload failed: ' + e.message); return false; }
        }
        try {
          const result = await API.post('/sales-returns', { slip_id: slip.id, slip_item_id: line.id, quantity,
            unit_id: Number(ov.querySelector('#sr-unit').value) || null, reason, evidence_ids: [file._returnAttachmentId] },
          { idempotencyKey: saveKey });
          UI.toast(`${result.number} received — awaiting inspection`);
          m.close(); slipView(slip.id); return true;
        } catch (e) { if (e.status >= 400 && e.status < 500) saveKey = 'sales-return:' + crypto.randomUUID(); showErr(e.message); return false; }
      },
    });
  }

  async function inspectReturn(slipId, returnId) {
    let locations, photos;
    try { [locations, photos] = await Promise.all([API.get('/locations'), API.get(`/attachments?kind=sales_return&ref_id=${returnId}`)]); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const photoUrls = await Promise.all(photos.map((p) => API.blobUrl(p.url.replace(/^\/api/, '')).catch(() => '')));
    const saveKey = 'sales-return-inspect:' + crypto.randomUUID();
    const m = UI.modal({ title: 'Inspect returned goods', confirmText: 'Record inspection',
      bodyHTML: `<p class="order-notice">Restock adds the received quantity to sellable inventory at the selected location. Reject keeps it out of stock. This decision is recorded once.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px">${photoUrls.filter(Boolean).map((url) => `<img src="${url}" alt="Returned goods evidence" style="width:150px;height:110px;object-fit:cover;border:1px solid var(--border);border-radius:6px" />`).join('')}</div>
        <div class="form-grid"><div class="form-field"><label>Decision</label><select id="sr-decision"><option value="restock">Passed inspection — restock</option><option value="reject">Rejected — keep out of stock</option></select></div>
        <div class="form-field"><label>Restock at</label><select id="sr-location">${locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('')}</select></div>
        <div class="form-field span2"><label>Condition and inspection findings</label><textarea id="sr-condition" rows="3"></textarea></div></div>`,
      onOpen: (ov) => { const toggle = () => { ov.querySelector('#sr-location').disabled = ov.querySelector('#sr-decision').value !== 'restock'; }; ov.querySelector('#sr-decision').onchange = toggle; toggle(); },
      onConfirm: async (ov, showErr) => {
        const decision = ov.querySelector('#sr-decision').value;
        const condition_note = ov.querySelector('#sr-condition').value.trim();
        if (condition_note.length < 5) { showErr('Record the inspection findings.'); return false; }
        if (!(await UI.confirmDialog(decision === 'restock' ? 'Make these returned goods available at the selected location?' : 'Reject these goods and keep them out of stock?', 'Confirm inspection'))) return false;
        try {
          const result = await API.post(`/sales-returns/${returnId}/inspect`, { decision, condition_note,
            location_id: decision === 'restock' ? Number(ov.querySelector('#sr-location').value) : null },
          { idempotencyKey: saveKey });
          UI.toast(result.accounting?.error || result.accounting?.skipped === 'cost_missing'
            ? 'Inspection saved; Finance must reconcile the return cost.' : 'Inspection saved.');
          m.close(); slipView(slipId); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function decideReturn(slipId, returnId) {
    let row, locations;
    try { [row, locations] = await Promise.all([API.get(`/sales-returns/${returnId}`), API.get('/locations')]); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const m = UI.modal({ title: `Next step · ${row.number}`, confirmText: 'Record decision',
      bodyHTML: `<p class="order-notice">These goods are outside sellable stock. Repair requires a tracked serial and a fresh inspection before restocking. Salvage records the quantity only in damage stock. Disposal records no stock.</p>
        <div class="form-grid"><div class="form-field"><label>Disposition</label><select id="sr-disposition">
          ${row.unit_id ? '<option value="repair">Repair serialized unit</option>' : ''}
          <option value="salvage">Salvage to damage stock</option><option value="dispose">Dispose</option></select></div>
          <div class="form-field"><label>Salvage location</label><select id="sr-salvage-loc">${locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('')}</select></div>
          <div class="form-field span2"><label>Decision reason</label><textarea id="sr-disposition-note" rows="3"></textarea></div></div>`,
      onOpen: (ov) => { const update = () => { ov.querySelector('#sr-salvage-loc').disabled = ov.querySelector('#sr-disposition').value !== 'salvage'; }; ov.querySelector('#sr-disposition').onchange = update; update(); },
      onConfirm: async (ov, showErr) => {
        const decision = ov.querySelector('#sr-disposition').value;
        const note = ov.querySelector('#sr-disposition-note').value.trim();
        if (note.length < 5) { showErr('Record why this disposition was chosen.'); return false; }
        if (!(await UI.confirmDialog(`Confirm ${decision} for ${row.number}?`, 'Confirm disposition'))) return false;
        try { await API.post(`/sales-returns/${returnId}/disposition`, { decision, note,
          location_id: decision === 'salvage' ? Number(ov.querySelector('#sr-salvage-loc').value) : null },
        { idempotencyKey: `sales-return-disposition:${returnId}:${decision}` });
          UI.toast('Disposition recorded'); m.close(); slipView(slipId); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function returnHistory(slipId, returnId) {
    let row, events;
    try { [row, events] = await Promise.all([API.get(`/sales-returns/${returnId}`), API.get(`/sales-returns/${returnId}/events`)]); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const m = UI.modal({ title: `Return history · ${row.number}`, cancelText: 'Back to slip',
      bodyHTML: `<p class="muted">Original inspection: ${UI.esc(row.condition_note || '—')}</p>
        <div class="table-scroll"><table><thead><tr><th>When</th><th>Action</th><th>Finding</th></tr></thead><tbody>
          ${events.map((e) => `<tr><td>${UI.esc(UI.fmtDate(e.created_at))}</td><td>${UI.esc(e.action.replaceAll('_', ' '))}</td><td>${UI.esc(e.note)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No disposition events.</td></tr>'}
        </tbody></table></div>`,
      onClose: () => { slipView(slipId); },
    });
    return m;
  }

  async function repairReturn(slipId, returnId) {
    let row, requests;
    try { row = await API.get(`/sales-returns/${returnId}`);
      requests = await API.get(`/production/units/${row.unit_id}/repairs`); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const related = requests.filter((r) => r.sales_return_id === returnId);
    const pending = related.filter((r) => r.status === 'requested');
    const m = UI.modal({ title: `Repair · ${row.number}`, size: 'lg', confirmText: 'Complete repair',
      bodyHTML: `<p class="order-notice">The unit remains out of sellable stock. Request needed parts below; the warehouse issues them in Production → Repairs & Parts Requests. Complete repair only after every request is resolved.</p>
        <div class="table-scroll"><table><thead><tr><th>Request</th><th>Part</th><th>Qty</th><th>Status</th></tr></thead><tbody>
        ${related.map((r) => `<tr><td>${UI.esc(r.number)}</td><td>${UI.esc(r.component_name)}</td><td>${r.quantity}</td><td>${UI.esc(r.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No parts requested.</td></tr>'}</tbody></table></div>
        <div class="form-grid"><div class="form-field span2"><label>Find part by name or SKU</label><input id="sr-part-search" placeholder="Search inventory" /><select id="sr-part-results"><option value="">Search for a component</option></select></div>
        <div class="form-field"><label>Request type</label><select id="sr-part-kind"><option value="replace">Replace fitted part</option><option value="add">Add missing part</option></select></div>
        <div class="form-field"><label>Quantity</label><input id="sr-part-qty" type="number" min="1" step="1" value="1" /></div>
        <div class="form-field span2"><label>Part request note</label><input id="sr-part-note" placeholder="Fault and part needed" /></div></div>
        <button type="button" class="btn secondary small" id="sr-part-request">Request part</button>
        <div class="form-field" style="margin-top:16px"><label>Repair completion note</label><textarea id="sr-repair-note" rows="3" placeholder="Work performed and outcome"></textarea></div>
        ${pending.length ? `<p class="order-notice">${pending.length} parts request${pending.length === 1 ? '' : 's'} pending. Resolve before completing repair.</p>` : ''}`,
      onOpen: (ov) => {
        const search = ov.querySelector('#sr-part-search');
        let timer;
        search.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
          const q = search.value.trim();
          const select = ov.querySelector('#sr-part-results');
          if (q.length < 2) { select.innerHTML = '<option value="">Enter at least 2 characters</option>'; return; }
          try { const items = await API.get('/inventory?q=' + encodeURIComponent(q));
            select.innerHTML = '<option value="">Choose a part</option>' + items.slice(0, 50).map((i) => `<option value="${i.id}">${UI.esc(i.name)}${i.sku ? ' · ' + UI.esc(i.sku) : ''}</option>`).join(''); }
          catch (e) { UI.toast(e.message, 'error'); }
        }, 250); };
        ov.querySelector('#sr-part-request').onclick = async () => {
          const component_item_id = Number(ov.querySelector('#sr-part-results').value);
          const quantity = Number(ov.querySelector('#sr-part-qty').value);
          if (!component_item_id || !Number.isInteger(quantity) || quantity < 1) { UI.toast('Choose a part and whole quantity.', 'error'); return; }
          try { await API.post(`/production/units/${row.unit_id}/repairs`, {
            kind: ov.querySelector('#sr-part-kind').value, component_item_id, quantity,
            notes: ov.querySelector('#sr-part-note').value.trim() || null });
            UI.toast('Part requested'); m.close(); repairReturn(slipId, returnId);
          } catch (e) { UI.toast(e.message, 'error'); }
        };
      },
      onConfirm: async (ov, showErr) => {
        const note = ov.querySelector('#sr-repair-note').value.trim();
        if (note.length < 5) { showErr('Describe the repair work.'); return false; }
        if (pending.length) { showErr('Resolve pending parts requests first.'); return false; }
        try { await API.post(`/sales-returns/${returnId}/repair-complete`, { note });
          UI.toast('Ready for fresh inspection'); m.close(); slipView(slipId); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function reinspectReturn(slipId, returnId) {
    let row, locations;
    try { [row, locations] = await Promise.all([API.get(`/sales-returns/${returnId}`), API.get('/locations')]); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const m = UI.modal({ title: `Reinspect repaired unit · ${row.number}`, confirmText: 'Record reinspection',
      bodyHTML: `<p class="order-notice">Pass adds this unit once to sellable stock. Reject returns it to repair, without changing stock or the original production receipt.</p>
        <p class="muted">Repair performed: ${UI.esc(row.repair_note || '—')}</p>
        <div class="form-grid"><div class="form-field"><label>Decision</label><select id="sr-reinspect-decision"><option value="restock">Pass · restock</option><option value="reject">Reject · repair again</option></select></div>
        <div class="form-field"><label>Restock at</label><select id="sr-reinspect-loc">${locations.map((l) => `<option value="${l.id}" ${l.is_default ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('')}</select></div>
        <div class="form-field span2"><label>Fresh inspection findings</label><textarea id="sr-reinspect-note" rows="3"></textarea></div></div>`,
      onOpen: (ov) => { const update = () => { ov.querySelector('#sr-reinspect-loc').disabled = ov.querySelector('#sr-reinspect-decision').value !== 'restock'; }; ov.querySelector('#sr-reinspect-decision').onchange = update; update(); },
      onConfirm: async (ov, showErr) => {
        const decision = ov.querySelector('#sr-reinspect-decision').value;
        const condition_note = ov.querySelector('#sr-reinspect-note').value.trim();
        if (condition_note.length < 5) { showErr('Record the fresh inspection findings.'); return false; }
        try { const result = await API.post(`/sales-returns/${returnId}/reinspect`, { decision, condition_note,
          location_id: decision === 'restock' ? Number(ov.querySelector('#sr-reinspect-loc').value) : null });
          UI.toast(result.accounting?.error || result.accounting?.skipped === 'cost_missing'
            ? 'Unit restocked; Finance must reconcile return cost.'
            : decision === 'restock' ? 'Unit restocked after reinspection' : 'Unit returned to repair');
          m.close(); slipView(slipId); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }

  async function linkReturnCredit(slipId, returnId) {
    let notes;
    try { notes = (await API.get('/accounting/credit-notes?kind=customer&status=issued')).filter((n) => n.source_doc_type === 'sale_order'); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const slip = await API.get('/release-slips/' + slipId);
    notes = notes.filter((n) => n.source_doc_id === slip.order_id);
    const m = UI.modal({ title: 'Link customer credit note', confirmText: 'Link note',
      bodyHTML: `<p class="muted">Finance issues a customer credit note against sale ${UI.esc(slip.order_number)} in Accounting. Linking it records which physical return it covers; it does not issue a second credit.</p>
        <div class="form-field"><label>Issued credit note</label><select id="sr-credit">${notes.map((n) => `<option value="${n.id}">${UI.esc(n.number)} · ${UI.money(n.total)}</option>`).join('')}</select></div>
        ${notes.length ? '' : '<p class="order-notice">No issued credit note is linked to this sale yet.</p>'}`,
      onConfirm: async (ov, showErr) => {
        if (!ov.querySelector('#sr-credit').value) { showErr('Issue the linked credit note in Accounting first.'); return false; }
        try { await API.post(`/sales-returns/${returnId}/link-credit`, { credit_note_id: Number(ov.querySelector('#sr-credit').value) });
          UI.toast('Credit note linked'); m.close(); slipView(slipId); return true;
        } catch (e) { showErr(e.message); return false; }
      },
    });
  }
});
