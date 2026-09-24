/* Products In — the Purchasing Goods Receipt pattern mirrored for finished goods, mobile
   side. A unit that passes final QC (or, with no QC stages, a batch once production
   progress is recorded) sits "receivable" until this screen posts it into a chosen
   location. Mirrors public/js/modules/manufacturing/production-receiving.js.
     #/receiving                  → worklist of job orders with something ready to receive
     #/receiving?id=<jobOrderId>  → receive: tick units / set batch quantities, or scan
   Scanning reuses the exact continuous-mode pattern public/mobile/modules/inventory/so.js
   uses for SO release: mScanner.open({ continuous: true }), matching a unit's identifier
   against this job order's receivable list and ticking it — never posts anything for a
   code that doesn't belong to the job order the screen is already scoped to. */
(function () {
  var SCAN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>';

  MApp.route('receiving', function (view, params) {
    var id = params && params.id;
    if (id) { load(view, id); } else { worklist(view); }
  });

  function worklist(view) {
    MApp.setTitle('Products In');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/job-orders')
      .then(function (rows) {
        view.innerHTML = '';
        var need = (rows || []).filter(function (j) {
          return ((j.units_passed || 0) > 0 || (j.batches_receivable || 0) > 0) && j.status !== 'cancelled';
        });
        if (!need.length) {
          view.appendChild(mEl('<div class="m-empty">Nothing waiting to be received.</div>'));
          view.appendChild(mEl('<div class="m-hint">Units queue here once they pass final QC — or, with no QC stages, once production progress is recorded.</div>'));
          return;
        }
        var ul = mEl('<ul class="m-list"></ul>');
        need.forEach(function (j) {
          var bits = [];
          if (j.units_passed) bits.push(j.units_passed + ' unit(s)');
          if (j.batches_receivable) bits.push(j.batches_receivable + ' batch(es)');
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(j.number) + '</b><span>' + mEsc(j.product_name) + '</span></div>' +
            '<div class="m-list-qty">' + mEsc(bits.join(' · ')) + '</div></li>'
          );
          li.onclick = function () { MApp.go('receiving', { id: j.id }); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function load(view, id) {
    MApp.setTitle('Receive');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/job-orders/' + id + '/receivable'), mLocations.load()])
      .then(function (r) { render(view, id, r[0]); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function render(view, id, rec) {
    view.innerHTML = '';
    if (!MApp.can('inventory.adjust') && !MApp.can('production.receive')) {
      view.appendChild(mEl('<div class="m-hint">You don\'t have permission to receive production output.</div>'));
      view.appendChild(actionBar([{ label: 'Back to Products In', fn: function () { worklist(view); } }]));
      return;
    }
    if (!rec.units.length && !rec.batches.length) {
      view.appendChild(mEl('<div class="m-empty">Nothing left to receive on this job order.</div>'));
      view.appendChild(actionBar([{ label: 'Back to Products In', fn: function () { worklist(view); } }]));
      return;
    }

    var locField = mLocations.select({ label: 'Received into' });
    if (rec.output_location_id) locField.select.value = String(rec.output_location_id);
    view.appendChild(locField.el);

    var noteField = mEl('<label class="m-field"><span class="m-label">Note (optional)</span><input class="m-input" data-note placeholder="Count discrepancy, condition…" /></label>');
    view.appendChild(noteField);

    var unitBoxes = {}; // unit id -> checkbox el

    if (rec.units.length) {
      var scanBtn = mEl('<button type="button" class="m-btn m-btn-secondary" style="margin-bottom:10px">' + SCAN_SVG + ' Scan to receive</button>');
      view.appendChild(scanBtn);
      var tally = mEl('<div class="m-hint" data-tally></div>');
      view.appendChild(tally);

      view.appendChild(mEl('<h3 class="m-h3">Units</h3>'));
      var ul = mEl('<ul class="m-list"></ul>');
      rec.units.forEach(function (u) {
        var li = mEl(
          '<li class="m-list-row">' +
          '<label class="m-check" style="flex:1"><input type="checkbox" checked data-u="' + u.id + '" /> ' +
          mEsc(u.identifier || ('Unit #' + u.id)) + '</label>' +
          '<button type="button" class="m-btn m-btn-sm m-btn-secondary" data-view>View</button>' +
          '</li>'
        );
        unitBoxes[u.id] = li.querySelector('input');
        li.querySelector('[data-view]').onclick = function () { MApp.go('record', { unit: u.id }); };
        ul.appendChild(li);
      });
      view.appendChild(ul);

      var scanned = 0;
      scanBtn.onclick = function () {
        var scanner = mScanner.open({
          title: 'Scan unit to receive',
          continuous: true,
          onResult: function (code) {
            code = String(code || '').trim();
            var match = rec.units.filter(function (u) { return u.identifier === code; })[0];
            var cb = match ? unitBoxes[match.id] : null;
            if (!cb) { mToast(code + ': not on this job order', 'err'); return; }
            if (!cb.checked) {
              cb.checked = true;
              scanned++;
              tally.textContent = scanned + ' unit(s) scanned this session';
            }
            if (Object.keys(unitBoxes).every(function (k) { return unitBoxes[k].checked; })) {
              mToast('All units selected');
              try { scanner.close(); } catch (e) { /* ignore */ }
            }
          },
        });
      };
    }

    var batchRows = [];
    if (rec.batches.length) {
      view.appendChild(mEl('<h3 class="m-h3">Batches</h3>'));
      rec.batches.forEach(function (b) {
        var row = mEl(
          '<div class="m-qc-unit"><div class="m-qc-id">' + mEsc(b.number) + ' · remaining ' + b.remaining_qty + '</div><div data-qslot></div></div>'
        );
        var qf = mQtyField('Receive now', b.remaining_qty);
        row.querySelector('[data-qslot]').appendChild(qf.el);
        batchRows.push({ id: b.id, remaining: b.remaining_qty, value: qf.value });
        view.appendChild(row);
      });
    }

    var acts = mEl('<div class="m-actions"></div>');
    if (rec.units.length) {
      var printBtn = mEl('<button class="m-btn m-btn-secondary">Print selected</button>');
      printBtn.onclick = function () {
        var ids = Object.keys(unitBoxes).filter(function (k) { return unitBoxes[k].checked; }).map(Number);
        if (!ids.length) { mToast('Select one or more units', 'err'); return; }
        printBtn.disabled = true;
        Promise.all(ids.map(function (uid) { return API.get('/production/record?unit=' + uid); }))
          .then(function (records) { return mProductionPrint.printUnitRecords(records); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); })
          .then(function () { printBtn.disabled = false; });
      };
      acts.appendChild(printBtn);
    }

    var receiveBtn = mEl('<button class="m-btn">Receive selected</button>');
    receiveBtn.onclick = function () {
      var unitIds = Object.keys(unitBoxes).filter(function (k) { return unitBoxes[k].checked; }).map(Number);
      var batchLines = batchRows
        .map(function (b) { return { batch_id: b.id, quantity: Math.min(b.value(), b.remaining) }; })
        .filter(function (b) { return b.quantity > 0; });
      if (!unitIds.length && !batchLines.length) { mToast('Nothing selected to receive', 'err'); return; }
      var loc = locField.value();
      if (!loc) { mToast('Pick a location', 'err'); return; }
      var body = { location_id: loc, notes: (noteField.querySelector('[data-note]').value || '').trim() || null };
      receiveBtn.disabled = true;
      var anyQueued = false;
      var chain = Promise.resolve();
      if (unitIds.length) {
        chain = chain.then(function () {
          return mSubmit('/job-orders/' + id + '/products-in', Object.assign({}, body, { unit_ids: unitIds }),
            { label: 'Receive ' + unitIds.length + ' unit(s) — job order #' + id });
        }).then(function (r) { if (r && r.queued) anyQueued = true; });
      }
      batchLines.forEach(function (b) {
        chain = chain.then(function () {
          return mSubmit('/job-orders/' + id + '/products-in', Object.assign({}, body, { batch_id: b.batch_id, quantity: b.quantity }),
            { label: 'Receive batch #' + b.batch_id + ' — job order #' + id });
        }).then(function (r) { if (r && r.queued) anyQueued = true; });
      });
      chain.then(function () { mToast(anyQueued ? 'Queued (offline)' : 'Received'); load(view, id); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); receiveBtn.disabled = false; });
    };
    acts.appendChild(receiveBtn);
    view.appendChild(acts);

    view.appendChild(actionBar([{ label: 'Back to Products In', fn: function () { worklist(view); }, secondary: true }]));
  }

  function actionBar(items) {
    var bar = mEl('<div class="m-actions"></div>');
    items.forEach(function (i) {
      var b = mEl('<button class="m-btn ' + (i.secondary ? 'm-btn-secondary' : '') + '">' + mEsc(i.label) + '</button>');
      b.onclick = i.fn;
      bar.appendChild(b);
    });
    return bar;
  }
})();
