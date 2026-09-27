/* Inventory → Releasing: the warehouse side of a sale order, in pipeline order.
     1. Release Queue — approved SOs waiting for the warehouse to accept them, then the
        accepted ones being picked (scan unit labels / enter quantities).
     2. Issue the release slip once every line is out — who collected it, the vehicle, and
        photos of the goods. Issuing it confirms the SO, which is when stock goes out.
     3. Release Slips — the printable record of everything that left.
   Backend: /api/release-slips (queue + slips), /api/orders/:id/accept-release | release |
   release-slip, photos = /api/attachments kind 'release'. filter.tab = 'queue' | 'slips' */
App.register('releasing', async (view, filter) => {
  const canRelease = App.hasPermission('inventory.adjust') || App.hasPermission('orders.release');
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
        <thead><tr><th>Sale order</th><th>Customer</th><th>Expected</th><th class="right">Qty</th><th></th></tr></thead>
        <tbody>${q.to_accept.map((o) => `
          <tr>
            <td><strong>${UI.esc(o.number)}</strong></td>
            <td>${UI.esc(o.customer_name || 'Walk-in')}</td>
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
        UI.toast('Accepted — ready to release');
        await renderQueue();
        openRelease(Number(b.dataset.accept));
      } catch (e) { UI.toast(e.message, 'error'); b.disabled = false; }
    });

    const pickEl = view.querySelector('#rl-picking');
    pickEl.innerHTML = q.releasing.length ? `
      <table>
        <thead><tr><th>Sale order</th><th>Customer</th><th>Accepted by</th><th>Expected</th><th class="right">Released</th><th></th></tr></thead>
        <tbody>${q.releasing.map((o) => {
          const done = o.qty_ordered > 0 && o.qty_released >= o.qty_ordered;
          return `
          <tr class="${canRelease ? 'clickable' : ''}" data-open="${o.id}">
            <td><strong>${UI.esc(o.number)}</strong></td>
            <td>${UI.esc(o.customer_name || 'Walk-in')}</td>
            <td class="muted">${UI.esc(o.warehouse_accepted_by_name || '—')}</td>
            <td class="muted">${UI.esc(o.expected_date || '—')}</td>
            <td class="right">${o.qty_released} / ${o.qty_ordered}</td>
            <td>${done ? '<span class="badge-pill ok">Ready for slip</span>' : ''}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`
      : UI.emptyState({ icon: 'forms', title: 'Nothing being released', hint: 'Accept an order above to start picking it.' });
    if (canRelease) pickEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => openRelease(Number(tr.dataset.open)));
  }

  /* --------------------------------------------------- 2. pick / release an order --- */
  const covered = (l) => Math.max(Number(l.allocated_qty || 0) + Number(l.reserved_qty || 0), Number(l.released_qty || 0));

  async function openRelease(orderId) {
    let order;
    try { order = await API.get('/orders/' + orderId); }
    catch (e) { UI.toast(e.message, 'error'); return; }

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

    const post = async (payload) => {
      try {
        const r = await API.post('/orders/' + order.id + '/release', payload);
        order = await API.get('/orders/' + order.id);
        draw();
        return r;
      } catch (e) { UI.toast(e.message, 'error'); return null; }
    };

    function draw() {
      const items = order.items || [];
      const fullyOut = String(order.status).toLowerCase() === 'released';
      body.innerHTML = `
        <div class="kv">
          <div><span class="muted">Customer</span><div>${UI.esc(order.customer_name || 'Walk-in')}</div></div>
          <div><span class="muted">Status</span><div><span class="badge-pill status-${UI.esc(order.status)}">${UI.esc(order.status)}</span></div></div>
          <div><span class="muted">Accepted by</span><div>${UI.esc(order.warehouse_accepted_by_name || '—')}</div></div>
          <div><span class="muted">Expected</span><div>${UI.esc(order.expected_date || '—')}</div></div>
        </div>
        ${fullyOut ? '' : `
          <h4 style="${LABEL}">Scan unit labels</h4>
          <div class="search-box">${UI.icon('search', 16)}<input id="rl-scan" autocomplete="off" placeholder="Scan or type a unit label, then Enter" /></div>`}
        <h4 style="${LABEL}">Lines</h4>
        <table>
          <thead><tr><th>Item</th><th class="right">Released</th><th style="width:210px"></th></tr></thead>
          <tbody>${items.map((l, i) => {
            if (!l.item_id) return `<tr><td>${UI.esc(l.name)}</td><td class="right muted" colspan="2">service / free-text — nothing to release</td></tr>`;
            const got = covered(l), need = Number(l.quantity) || 0;
            return `<tr>
              <td>${UI.esc(l.name)}${l.sku ? `<div class="muted mono">${UI.esc(l.sku)}</div>` : ''}</td>
              <td class="right">${got} / ${need} ${UI.esc(l.unit || '')}${got >= need ? ' ✓' : ''}</td>
              <td>${got < need ? `<div style="display:flex;gap:6px;justify-content:flex-end">
                <input type="number" min="1" max="${need - got}" value="${need - got}" data-qty="${i}" style="width:80px" />
                <button class="btn secondary small" data-bulk="${i}">Release qty</button></div>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <div style="display:flex;align-items:center;gap:10px;margin-top:16px">
          <span class="muted" style="font-size:12px">${fullyOut
            ? 'Every line is out. Issue the release slip as the goods leave — that is when stock is deducted.'
            : 'Release every line to issue the release slip.'}</span>
          <div class="grow"></div>
          <button class="btn" id="rl-slip" ${fullyOut ? '' : 'disabled'}>${UI.icon('sheet')} Issue release slip</button>
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
          if (await post({ codes: [code] })) UI.toast(code + ' released');
        });
      }
      body.querySelectorAll('[data-bulk]').forEach((b) => b.onclick = async () => {
        const l = items[Number(b.dataset.bulk)];
        const q = Number(body.querySelector(`[data-qty="${b.dataset.bulk}"]`).value);
        if (!q || q <= 0) { UI.toast('Enter a quantity', 'error'); return; }
        b.disabled = true;
        if (await post({ bulk: [{ item_id: l.item_id, quantity: q }] })) UI.toast(`${l.name} ×${q} released`);
        else b.disabled = false;
      });
      body.querySelector('#rl-slip').onclick = () => slipModal(order, () => { m.close(); if (tab === 'queue') renderQueue(); });
    }
    draw();
  }

  /* ------------------------------------------------------ 3. issue the release slip --- */
  function slipModal(order, onDone) {
    const photos = []; // File[]
    UI.modal({
      title: 'Release slip — ' + order.number,
      bodyHTML: `
        <p class="muted" style="margin-top:0">Record who took the goods out. Issuing the slip confirms
          ${UI.esc(order.number)} and deducts the released stock.</p>
        <div><label>Collected by <span class="req">*</span></label>
          <input data-f="collected_by" placeholder="Driver / customer representative" /></div>
        <div class="field-row" style="margin-top:10px">
          <div><label>Vehicle / plate no.</label><input data-f="vehicle_plate" placeholder="Optional" /></div>
        </div>
        <div style="margin-top:10px"><label>Notes</label><input data-f="notes" placeholder="Optional" /></div>
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
        ov.querySelector('#rl-photo-add').onclick = () => input.click();
        input.onchange = () => { photos.push(...input.files); input.value = ''; drawPhotos(); };
      },
      onConfirm: async (ov, showErr) => {
        const val = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        if (!val('collected_by')) { showErr('Enter who collected the goods'); return false; }
        if (!photos.length) { showErr('Add at least one photo of the goods going out'); return false; }
        const r = await API.post('/orders/' + order.id + '/release-slip', {
          collected_by: val('collected_by'), vehicle_plate: val('vehicle_plate') || null, notes: val('notes') || null,
        });
        let failed = 0;
        for (const f of photos) {
          const fd = new FormData();
          fd.append('kind', 'release');
          fd.append('ref_id', String(r.id));
          fd.append('image', f);
          try { await API.upload('/attachments', fd); } catch (e) { failed += 1; }
        }
        UI.toast(failed ? `Slip issued — ${failed} photo(s) failed to upload; add them from the slip` : 'Release slip issued — stock deducted',
          failed ? 'error' : undefined);
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

  /* ------------------------------------------------------- 5. one slip: view / print --- */
  async function slipView(id) {
    let slip, photos, company;
    try {
      [slip, photos, company] = await Promise.all([
        API.get('/release-slips/' + id),
        API.get('/attachments?kind=release&ref_id=' + id).catch(() => []),
        API.get('/templates/company').catch(() => ({})),
      ]);
    } catch (e) { UI.toast(e.message, 'error'); return; }
    // Attachment images need the auth header, so load them as blob URLs.
    const urls = await Promise.all(photos.map((p) => API.blobUrl(p.url.replace(/^\/api/, '')).catch(() => '')));

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
        </div>
        ${slip.notes ? `<p style="margin:12px 0 0"><span class="muted">Notes:</span> ${UI.esc(slip.notes)}</p>` : ''}
        <h4 style="${LABEL}">Goods released</h4>
        <table>
          <thead><tr><th>Item</th><th>Unit serials</th><th class="right">Qty</th></tr></thead>
          <tbody>${(slip.items || []).map((it) => `<tr>
            <td>${UI.esc(it.name)}${it.sku ? `<div class="muted mono">${UI.esc(it.sku)}</div>` : ''}</td>
            <td class="mono" style="font-size:12px">${UI.esc(it.unit_identifiers || '—')}</td>
            <td class="right">${it.quantity} ${UI.esc(it.unit || '')}</td></tr>`).join('')}</tbody>
        </table>
        <div style="display:flex;align-items:center;margin:16px 0 6px">
          <h4 style="${LABEL};margin:0">Photos</h4><div class="grow"></div>
          ${canRelease ? `<button type="button" class="btn secondary small" id="rs-add-photo">${UI.icon('plus')} Add photo</button>
            <input type="file" id="rs-photo-in" accept="image/*" capture="environment" multiple hidden />` : ''}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${urls.some(Boolean) ? photoGrid('') : '<span class="muted">No photos.</span>'}</div>`,
      onOpen: (ov) => {
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
});
