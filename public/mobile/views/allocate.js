/* Ship / move finished units — allocate QC-passed units of a finished product to a
   sales order (sell → out of stock) or relocate them. Scan a unit's QR label to
   tick it. Wraps POST /finished-products/:id/units/allocate. */
(function () {
  function start(view, params) {
    MApp.setTitle('Ship units');
    view.innerHTML = '';
    if (params && params.id) { load(view, params.id); return; }
    var picker = mItemPicker({
      label: 'Scan or search a finished product',
      onPick: function (it) {
        if (!it.is_finished_product) { mToast('Not a finished product', 'err'); return; }
        load(view, it.id);
      },
    });
    view.appendChild(picker.el);
    view.appendChild(mEl('<div class="m-hint">Only units that passed QA/QC can be shipped or moved.</div>'));
    picker.focus();
  }

  function load(view, id) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([
      API.get('/finished-products/' + id),
      API.get('/finished-products/' + id + '/units?status=in_stock'),
      API.get('/orders?type=sale').catch(function () { return []; }),
      mLocations.load(),
    ])
      .then(function (r) { render(view, r[0], r[1] || [], r[2] || []); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function render(view, product, units, orders) {
    MApp.setTitle('Ship · ' + (product.name.length > 18 ? product.name.slice(0, 17) + '…' : product.name));
    view.innerHTML = '';
    var serial = units.filter(function (u) { return u.identifier && u.identifier.trim(); });
    var bulk = units.length - serial.length;

    view.appendChild(mEl('<div class="m-hint">' + mEsc(product.name) + ' · ' + units.length + ' unit(s) in stock (QA/QC passed)</div>'));
    if (!units.length) {
      view.appendChild(mEl('<div class="m-empty">No QC-passed units on hand for this product.</div>'));
      view.appendChild(actions([{ label: 'Pick another', fn: function () { start(view, {}); } }]));
      return;
    }

    // action toggle
    var seg = mEl(
      '<div class="m-seg">' +
      '<button data-act="sell" class="on">Sell to order</button>' +
      '<button data-act="move">Move location</button>' +
      '</div>'
    );
    view.appendChild(seg);

    var orderSel = mEl(
      '<label class="m-field" data-sell><span class="m-label">Sales order</span>' +
      '<select class="m-select"><option value="">— select —</option>' +
      orders.filter(function (o) { return o.status !== 'cancelled' && o.status !== 'closed' && o.status !== 'completed'; })
        .map(function (o) { return '<option value="' + o.id + '">' + mEsc(o.number) + (o.customer_name ? ' · ' + mEsc(o.customer_name) : '') + '</option>'; }).join('') +
      '</select></label>'
    );
    view.appendChild(orderSel);
    var loc = mLocations.select({ label: 'Move to' });
    loc.el.setAttribute('data-move', '');
    loc.el.style.display = 'none';
    view.appendChild(loc.el);

    var mode = { act: 'sell' };
    seg.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        mode.act = b.dataset.act;
        orderSel.style.display = mode.act === 'sell' ? '' : 'none';
        loc.el.style.display = mode.act === 'move' ? '' : 'none';
      };
    });

    // scan-to-tick
    if (serial.length) {
      var scanBtn = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary">📷  Scan a unit label</button></div>');
      scanBtn.querySelector('button').onclick = function () {
        mScanner.open({
          title: 'Scan the unit QR label',
          onResult: function (code) {
            var c = (code || '').trim();
            var row = view.querySelector('.m-qc-unit[data-ident="' + cssEsc(c) + '"] input[type=checkbox]');
            if (!row) { mToast('No pending unit with ID ' + c, 'err'); return; }
            row.checked = true;
            row.closest('.m-qc-unit').scrollIntoView({ block: 'center' });
          },
        });
      };
      view.appendChild(scanBtn);
    }

    // serialized units list
    if (serial.length) {
      var all = mEl('<label class="m-check" style="margin:6px 0"><input type="checkbox" data-all /> Select all ' + serial.length + '</label>');
      view.appendChild(all);
      var wrap = mEl('<div class="m-qc-units"></div>');
      serial.forEach(function (u) {
        var row = mEl(
          '<label class="m-qc-unit" data-ident="' + mEsc(u.identifier) + '" style="flex-direction:row;align-items:center;gap:10px">' +
          '<input type="checkbox" value="' + u.id + '" />' +
          '<span><b class="m-qc-id">' + mEsc(u.identifier) + '</b>' +
          '<span class="m-qc-log-meta">' + mEsc(u.job_order_number || '') +
          (u.location_name ? ' · ' + mEsc(u.location_name) : '') + '</span></span>' +
          '</label>'
        );
        wrap.appendChild(row);
      });
      view.appendChild(wrap);
      all.querySelector('[data-all]').onclick = function (e) {
        wrap.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = e.target.checked; });
      };
    }

    // bulk (no identifier)
    var bulkField = null;
    if (bulk) {
      bulkField = mQtyField('Untracked units to include (' + bulk + ' available)', 0);
      view.appendChild(bulkField.el);
    }

    var note = mEl('<label class="m-field"><span class="m-label">Note (optional)</span><input class="m-input" data-note maxlength="500" /></label>');
    view.appendChild(note);

    var go = mEl('<div class="m-actions"><button class="m-btn">Confirm</button></div>');
    go.querySelector('button').onclick = function () {
      var ids = [].slice.call(view.querySelectorAll('.m-qc-unit input[type=checkbox]:checked')).map(function (c) { return Number(c.value); });
      var qty = bulkField ? bulkField.value() : 0;
      if (!ids.length && qty < 1) { mToast('Pick units or a quantity', 'err'); return; }
      if (ids.length && qty > 0) { mToast('Do serialized units and bulk in separate steps', 'err'); return; }

      var body = { action: mode.act, reason: note.querySelector('[data-note]').value.trim() || null };
      if (ids.length) body.unit_ids = ids; else body.quantity = qty;
      if (mode.act === 'sell') {
        var oid = orderSel.querySelector('select').value;
        if (!oid) { mToast('Pick the sales order', 'err'); return; }
        body.order_id = Number(oid);
      } else {
        if (!loc.value()) { mToast('Pick a destination location', 'err'); return; }
        body.to_location_id = Number(loc.value());
      }

      go.querySelector('button').disabled = true;
      var n = ids.length || qty;
      mSubmit('/finished-products/' + product.id + '/units/allocate', body,
        { label: (mode.act === 'sell' ? 'Sell ' : 'Move ') + n + ' × ' + product.name })
        .then(function (r) {
          mSuccess(view, {
            title: mode.act === 'sell' ? 'Sold' : 'Moved',
            lines: [n + ' unit(s) ' + (mode.act === 'sell' ? 'shipped' : 'relocated') + (r && r.queued ? ' (queued offline)' : '')],
            actions: [
              { label: 'Ship more', onClick: function () { start(view, {}); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); go.querySelector('button').disabled = false; });
    };
    view.appendChild(go);
  }

  function cssEsc(s) { return String(s).replace(/["\\\]]/g, '\\$&'); }

  function actions(items) {
    var bar = mEl('<div class="m-actions"></div>');
    items.forEach(function (i) {
      var b = mEl('<button class="m-btn m-btn-secondary">' + mEsc(i.label) + '</button>');
      b.onclick = i.fn;
      bar.appendChild(b);
    });
    return bar;
  }

  MApp.route('allocate', function (view, params) { start(view, params); });
})();
