/* Purchase-order receiving: one goods receipt per delivery.
   Legacy Pick bookmarks return to Work; stock leaves through numbered release slips. */
(function () {
  /* ---------------- shared: open-order list ---------------- */
  function list(view) {
    var title = 'Receive';
    MApp.setTitle(title);
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    var q = ['/orders?type=purchase'];
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
          li.onclick = function () { open(view, o.id); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function open(view, orderId) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    var extra = API.get('/purchasing/orders/' + orderId).catch(function () { return null; });
    Promise.all([API.get('/orders/' + orderId), extra, mLocations.load()])
      .then(function (r) {
        receiveForm(view, r[0], r[1]);
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
              { label: 'Back to list', onClick: function () { list(view); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Receive failed', 'err'); btn.disabled = false; });
    };
  }

  MApp.route('receive', function (view) { list(view); });
  // Old bookmarks cannot identify a manufacturing job by a commercial order ID.
  // Work exposes the canonical sales/kit queues using their own permission gates.
  MApp.route('pick', function () { MApp.go('work'); });
})();
