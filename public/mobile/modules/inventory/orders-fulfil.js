/* Receive against a Purchase Order, or pick a Sale / Job order.
     receive → one goods receipt (GRN) for the whole delivery
               (POST /api/purchasing/orders/:id/receipts — posts +stock,
               drives receipt_status, supports repeat partial deliveries)
     pick    → −qty per line at the chosen location (SO / JO) */
(function () {
  /* ---------------- shared: open-order list ---------------- */
  function list(view, mode) {
    var title = mode === 'pick' ? 'Pick order' : 'Receive';
    MApp.setTitle(title);
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    var q = mode === 'pick' ? ['/orders?type=sale', '/orders?type=job'] : ['/orders?type=purchase'];
    Promise.all(q.map(function (u) { return API.get(u); }))
      .then(function (parts) {
        var orders = [].concat.apply([], parts).filter(function (o) {
          return o.status !== 'cancelled' && o.status !== 'closed' && o.status !== 'completed';
        });
        orders.sort(function (a, b) { return b.id - a.id; });
        view.innerHTML = '';
        if (!orders.length) { view.appendChild(mEl('<div class="m-empty">No open orders.</div>')); return; }
        var ul = mEl('<ul class="m-list"></ul>');
        orders.forEach(function (o) {
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(o.number) + '</b>' +
            '<span>' + mEsc(o.customer_name || o.type) + ' · ' + mEsc(o.status) + '</span></div>' +
            '<div class="m-list-qty">' + (o.type || '').toUpperCase() + '</div></li>'
          );
          li.onclick = function () { open(view, mode, o.id); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function open(view, mode, orderId) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    var extra = mode === 'receive'
      ? API.get('/purchasing/orders/' + orderId).catch(function () { return null; })
      : Promise.resolve(null);
    Promise.all([API.get('/orders/' + orderId), extra, mLocations.load()])
      .then(function (r) {
        if (mode === 'receive') receiveForm(view, r[0], r[1]);
        else pickForm(view, r[0]);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /* ---------------- receive → one GRN ---------------- */
  var RECEIVED_KEYS = ['received', 'qty_received', 'received_qty', 'quantity_received'];
  var ORDERED_KEYS = ['ordered', 'quantity', 'qty_ordered'];

  /** Build a map of order_item_id → outstanding qty from the purchasing view (best effort). */
  function outstandingMap(purch) {
    var m = {};
    var rows = purch && (purch.items || purch.lines);
    if (!Array.isArray(rows)) return m;
    rows.forEach(function (r) {
      var id = r.order_item_id != null ? r.order_item_id : r.id;
      if (id == null) return;
      var got = pickNum(r, RECEIVED_KEYS, 0);
      var ord = pickNum(r, ORDERED_KEYS, null);
      if (ord != null) m[id] = Math.max(0, ord - got);
    });
    return m;
  }
  function pickNum(o, keys, dflt) {
    for (var i = 0; i < keys.length; i++) if (typeof o[keys[i]] === 'number') return o[keys[i]];
    return dflt;
  }

  function receiveForm(view, order, purch) {
    MApp.setTitle('Receive · ' + order.number);
    view.innerHTML = '';

    var status = purch && purch.receipt_status;
    if (status && status !== 'none') {
      view.appendChild(mEl('<div class="m-hint" style="margin-bottom:8px">Already ' +
        (status === 'over' ? 'over-received' : status) + ' — this records another delivery.</div>'));
    }

    var loc = mLocations.select({ label: 'Receive into' });
    view.appendChild(loc.el);

    var outstanding = outstandingMap(purch);
    var lines = (order.items || []).map(function (it) {
      var out = outstanding[it.id];
      var start = out != null ? out : it.quantity;
      return { it: it, qty: start, ordered: it.quantity, outstanding: out };
    });

    var wrap = mEl('<div class="m-count-list"></div>');
    lines.forEach(function (L) {
      var sub = 'ordered ' + L.ordered + ' ' + mEsc(L.it.unit || '') +
        (L.outstanding != null ? ' · ' + L.outstanding + ' outstanding' : '') +
        (L.it.item_id ? '' : ' · not stocked');
      var row = mEl(
        '<div class="m-count-row">' +
        '  <div class="m-count-name"><b>' + mEsc(L.it.name) + '</b><span>' + sub + '</span></div>' +
        '  <input type="number" inputmode="numeric" min="0" class="m-input m-count-in" value="' + L.qty + '" />' +
        '</div>'
      );
      row.querySelector('input').oninput = function (e) { L.qty = Math.max(0, parseInt(e.target.value, 10) || 0); };
      wrap.appendChild(row);
    });
    view.appendChild(wrap);

    var go = mEl('<div class="m-actions"><button class="m-btn">Receive delivery</button></div>');
    view.appendChild(go);
    view.appendChild(mEl('<div class="m-hint">Records a goods receipt for the quantities entered. Call it again as more of the order arrives.</div>'));

    go.querySelector('button').onclick = function () {
      var payloadLines = lines
        .filter(function (L) { return L.qty > 0; })
        .map(function (L) {
          return {
            order_item_id: L.it.id,
            item_id: L.it.item_id || null,
            name: L.it.name,
            sku: L.it.sku || null,
            unit: L.it.unit || null,
            quantity: L.qty,
          };
        });
      if (!payloadLines.length) { mToast('Enter a quantity on at least one line', 'err'); return; }
      if (!loc.value()) { mToast('Choose a location', 'err'); return; }

      var btn = go.querySelector('button'); btn.disabled = true;
      var total = payloadLines.reduce(function (a, l) { return a + l.quantity; }, 0);
      mSubmit('/purchasing/orders/' + order.id + '/receipts',
        { location_id: loc.value(), lines: payloadLines },
        { label: 'Receive ' + order.number + ' — ' + total + ' unit(s)' })
        .then(function (r) {
          mSuccess(view, {
            title: 'Received — ' + order.number,
            lines: [(r && r.number ? r.number + ' · ' : '') + payloadLines.length + ' line(s) into ' +
              loc.select.options[loc.select.selectedIndex].text.split(' — ')[0]]
              .concat(r && r.queued ? ['queued (offline)'] : []),
            actions: [
              { label: 'Back to list', onClick: function () { list(view, 'receive'); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Receive failed', 'err'); btn.disabled = false; });
    };
  }

  /* ---------------- pick → −qty per line ---------------- */
  function pickForm(view, order) {
    MApp.setTitle('Pick order · ' + order.number);
    view.innerHTML = '';
    var loc = mLocations.select({ label: 'Pick from' });
    view.appendChild(loc.el);

    var lines = (order.items || []).map(function (it) { return { it: it, qty: it.quantity, done: false }; });
    var wrap = mEl('<div class="m-count-list"></div>');
    view.appendChild(wrap);
    var bar = mEl('<div class="m-actions"><button class="m-btn" data-all>Pick all lines</button></div>');
    view.appendChild(bar);

    function draw() {
      wrap.innerHTML = '';
      lines.forEach(function (L) {
        if (!L.it.item_id) {
          wrap.appendChild(mEl('<div class="m-count-row muted"><div class="m-count-name"><b>' +
            mEsc(L.it.name) + '</b><span>free-text line — skipped</span></div></div>'));
          return;
        }
        var row = mEl(
          '<div class="m-count-row' + (L.done ? ' done' : '') + '">' +
          '  <div class="m-count-name"><b>' + mEsc(L.it.name) + '</b>' +
          '    <span>ordered ' + L.it.quantity + ' ' + mEsc(L.it.unit || '') + '</span></div>' +
          '  <input type="number" inputmode="numeric" class="m-input m-count-in" value="' + L.qty + '" ' + (L.done ? 'disabled' : '') + ' />' +
          '  <button class="m-btn m-btn-sm" ' + (L.done ? 'disabled' : '') + '>' + (L.done ? '✓' : 'Pick') + '</button>' +
          '</div>'
        );
        row.querySelector('input').oninput = function (e) { L.qty = parseInt(e.target.value, 10) || 0; };
        row.querySelector('button').onclick = function () { postLine(L, row); };
        wrap.appendChild(row);
      });
    }
    draw();

    function postLine(L, row) {
      if (L.done || !L.it.item_id) return;
      if (L.qty < 1) { mToast('Enter a quantity', 'err'); return; }
      var btn = row ? row.querySelector('button') : null;
      if (btn) btn.disabled = true;
      return mSubmit('/inventory/' + L.it.item_id + '/adjust', {
        change: -L.qty, location_id: loc.value(), reason: 'Picked for order ' + order.number,
      }, { label: 'Pick ' + order.number + ' — ' + L.it.name + ' ×' + L.qty })
        .then(function (r) { L.done = true; L.queued = !!r.queued; draw(); })
        .catch(function (ex) { mToast(L.it.name + ': ' + (ex.message || 'failed'), 'err'); if (btn) btn.disabled = false; });
    }

    bar.querySelector('[data-all]').onclick = function () {
      var todo = lines.filter(function (L) { return L.it.item_id && !L.done; });
      if (!todo.length) { mToast('Nothing left to pick', 'err'); return; }
      bar.querySelector('[data-all]').disabled = true;
      todo.reduce(function (p, L) { return p.then(function () { return postLine(L); }); }, Promise.resolve())
        .then(function () {
          var done = lines.filter(function (L) { return L.done; });
          var q = done.filter(function (L) { return L.queued; }).length;
          mSuccess(view, {
            title: 'Picked — ' + order.number,
            lines: [done.length + ' line(s) at ' + loc.select.options[loc.select.selectedIndex].text.split(' — ')[0]]
              .concat(q ? [q + ' queued (offline)'] : []),
            actions: [
              { label: 'Back to list', onClick: function () { list(view, 'pick'); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        });
    };
  }

  MApp.route('receive', function (view) { list(view, 'receive'); });
  MApp.route('pick', function (view) { list(view, 'pick'); });
})();
