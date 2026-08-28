/* Receive against a Purchase Request, or pick a Sale / Job order.
   Both walk an order's line items and post a stock adjustment per line:
     receive → +qty at the chosen location   (from PR, type=purchase)
     pick    → −qty at the chosen location   (for SO / JO)
   Free-text lines (no item_id) are shown but skipped. */
(function () {
  var MODES = {
    'receive': { type: 'purchase', title: 'Receive', verb: 'Received', sign: 1, reason: 'Received on PR' },
    'pick':    { type: 'sale',     title: 'Pick order', verb: 'Picked', sign: -1, reason: 'Picked for order' },
  };

  function list(view, mode) {
    var cfg = MODES[mode];
    MApp.setTitle(cfg.title);
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    // pick covers both sale and job orders
    var q = mode === 'pick' ? ['/orders?type=sale', '/orders?type=job'] : ['/orders?type=purchase'];
    Promise.all(q.map(function (u) { return API.get(u); }))
      .then(function (parts) {
        var orders = [].concat.apply([], parts);
        orders = orders.filter(function (o) { return o.status !== 'cancelled' && o.status !== 'closed' && o.status !== 'completed'; });
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
    var cfg = MODES[mode];
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/orders/' + orderId), mLocations.load()])
      .then(function (r) { form(view, mode, r[0]); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function form(view, mode, order) {
    var cfg = MODES[mode];
    MApp.setTitle(cfg.title + ' · ' + order.number);
    view.innerHTML = '';
    var loc = mLocations.select({ label: cfg.sign > 0 ? 'Receive into' : 'Pick from' });
    view.appendChild(loc.el);

    var lines = (order.items || []).map(function (it) {
      return { it: it, qty: it.quantity, done: false };
    });
    var wrap = mEl('<div class="m-count-list"></div>');
    view.appendChild(wrap);
    var bar = mEl('<div class="m-actions"><button class="m-btn" data-all>' + cfg.verb + ' all lines</button></div>');
    view.appendChild(bar);

    function draw() {
      wrap.innerHTML = '';
      lines.forEach(function (L, i) {
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
          '  <button class="m-btn m-btn-sm" ' + (L.done ? 'disabled' : '') + '>' + (L.done ? '✓' : cfg.verb) + '</button>' +
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
      return API.post('/inventory/' + L.it.item_id + '/adjust', {
        change: cfg.sign * L.qty,
        location_id: loc.value(),
        reason: cfg.reason + ' ' + order.number,
      })
        .then(function () { L.done = true; draw(); })
        .catch(function (ex) { mToast(L.it.name + ': ' + (ex.message || 'failed'), 'err'); if (btn) btn.disabled = false; });
    }

    bar.querySelector('[data-all]').onclick = function () {
      var todo = lines.filter(function (L) { return L.it.item_id && !L.done; });
      if (!todo.length) { mToast('Nothing left to ' + cfg.verb.toLowerCase(), 'err'); return; }
      bar.querySelector('[data-all]').disabled = true;
      todo.reduce(function (p, L) { return p.then(function () { return postLine(L); }); }, Promise.resolve())
        .then(function () {
          var ok = lines.filter(function (L) { return L.done; }).length;
          mSuccess(view, {
            title: cfg.verb + ' — ' + order.number,
            lines: [ok + ' line(s) posted at ' + loc.select.options[loc.select.selectedIndex].text.split(' — ')[0]],
            actions: [
              { label: 'Back to list', onClick: function () { list(view, mode); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        });
    };
  }

  MApp.route('receive', function (view) { list(view, 'receive'); });
  MApp.route('pick', function (view) { list(view, 'pick'); });
})();
