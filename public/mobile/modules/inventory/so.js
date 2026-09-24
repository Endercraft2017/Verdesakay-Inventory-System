/* Sale Order release — the warehouse releaser opens an approved SO, scans every unit's
   printed QR label to add it to the order (and enters a quantity for non-serialized
   lines). Records only: stock is drawn down later when the SO is confirmed/completed.
   #/so  → list of approved / released SOs   ·   #/so?id=<id>  → release screen */
(function () {
  var RELEASABLE = ['approved', 'released'];

  function list(view) {
    MApp.setTitle('Release orders');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/orders?type=sale')
      .then(function (rows) {
        view.innerHTML = '';
        var open = (rows || []).filter(function (o) { return RELEASABLE.indexOf(String(o.status).toLowerCase()) !== -1; });
        if (!open.length) {
          view.appendChild(mEl('<div class="m-empty">No approved sale orders to release.</div>'));
          view.appendChild(mEl('<div class="m-hint">A sale order shows up here once someone moves it to <b>approved</b>.</div>'));
          return;
        }
        var ul = mEl('<ul class="m-list"></ul>');
        open.forEach(function (o) {
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(o.number) + '</b>' +
            '<span>' + mEsc(o.customer_name || 'walk-in') + '</span></div>' +
            '<div class="m-list-qty"><span class="m-jo-status ' + (o.status === 'released' ? 'completed' : 'released') + '">' +
            mEsc(o.status) + '</span></div></li>'
          );
          li.onclick = function () { MApp.go('so', { id: o.id }); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function detail(view, id) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/orders/' + id)
      .then(function (o) { render(view, o); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function covered(l) {
    return Math.max(Number(l.allocated_qty || 0) + Number(l.reserved_qty || 0), Number(l.released_qty || 0));
  }

  function render(view, order) {
    MApp.setTitle(order.number);
    view.innerHTML = '';
    if (!MApp.can('inventory.adjust') && !MApp.can('orders.release')) {
      view.appendChild(mEl('<div class="m-hint">You don\'t have permission to release sale orders.</div>'));
      var backBar = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary">Back to list</button></div>');
      backBar.querySelector('button').onclick = function () { MApp.go('so'); };
      view.appendChild(backBar);
      return;
    }
    var releasable = RELEASABLE.indexOf(String(order.status).toLowerCase()) !== -1;

    view.appendChild(mEl(
      '<div class="m-jo-head"><h2>' + mEsc(order.customer_name || 'Walk-in') + '</h2>' +
      '<div class="m-jo-meta">' + mEsc(order.number) + ' · <span class="m-jo-status ' +
      (order.status === 'released' ? 'completed' : 'released') + '">' + mEsc(order.status) + '</span></div>' +
      (order.status === 'released' ? '<div class="m-hint">Fully released — hand off to delivery.</div>'
        : !releasable ? '<div class="m-hint">This order isn’t in a releasable state.</div>' : '') +
      '</div>'
    ));

    var items = order.items || [];
    var body = mEl('<div class="m-count-list"></div>');
    view.appendChild(body);

    function drawLines() {
      body.innerHTML = '';
      items.forEach(function (l) {
        if (!l.item_id) {
          body.appendChild(mEl('<div class="m-count-row muted"><div class="m-count-name"><b>' +
            mEsc(l.name) + '</b><span>free-text line — nothing to release</span></div></div>'));
          return;
        }
        var got = covered(l), need = Number(l.quantity) || 0;
        var done = got >= need;
        var row = mEl(
          '<div class="m-count-row' + (done ? ' done' : '') + '">' +
          '<div class="m-count-name"><b>' + mEsc(l.name) + (done ? ' ✓' : '') + '</b>' +
          '<span>' + got + ' / ' + need + ' released' +
          (Number(l.allocated_qty || 0) ? ' · ' + l.allocated_qty + ' shipped' : '') + '</span></div>' +
          (releasable && !done
            ? '<input type="number" inputmode="numeric" class="m-input m-count-in" value="0" min="0" style="width:64px" />' +
              '<button class="m-btn m-btn-sm" data-bulk>Release</button>'
            : '') +
          '</div>'
        );
        var bb = row.querySelector('[data-bulk]');
        if (bb) bb.onclick = function () {
          var q = parseInt(row.querySelector('input').value, 10) || 0;
          if (q < 1) { mToast('Enter a quantity', 'err'); return; }
          bb.disabled = true;
          mSubmit('/orders/' + order.id + '/release', { bulk: [{ item_id: l.item_id, quantity: q }] },
            { label: 'Release ' + order.number + ' — ' + l.name + ' ×' + q })
            .then(function (r) {
              if (r && r.response && r.response.order) { order = r.response.order; items = order.items || []; }
              else order.items = items; // offline-queued — optimistic bump
              if (r && r.queued) l.released_qty = Math.min(need, Number(l.released_qty || 0) + q);
              mToast(r && r.queued ? 'Queued (offline)' : 'Released'); refresh();
            })
            .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); bb.disabled = false; });
        };
        body.appendChild(row);
      });
    }
    drawLines();

    function refresh() { render(view, order); }

    if (releasable && order.status !== 'released') {
      var scanBtn = mEl('<div class="m-actions"><button class="m-btn">📷  Scan units to release</button></div>');
      var tally = mEl('<div class="m-hint" data-tally></div>');
      var n = 0;
      scanBtn.querySelector('button').onclick = function () {
        n = 0;
        var scanner = mScanner.open({
          title: 'Scan each unit label',
          continuous: true,
          onResult: function (code) {
            mSubmit('/orders/' + order.id + '/release', { codes: [String(code).trim()] },
              { label: 'Release ' + order.number + ' — ' + code })
              .then(function (r) {
                n += 1;
                tally.textContent = n + ' unit(s) scanned this session';
                if (r && r.response && r.response.order) {
                  order = r.response.order; items = order.items || [];
                  drawLines();
                  if (String(order.status).toLowerCase() === 'released') {
                    mToast('Order fully released');
                    try { scanner.close(); } catch (e) { /* ignore */ }
                  }
                } else if (r && r.queued) {
                  mToast('Queued (offline)');
                }
              })
              .catch(function (ex) { mToast(ex.message || code + ': rejected', 'err'); });
          },
        });
      };
      view.appendChild(scanBtn);
      view.appendChild(tally);
    }

    var acts = mEl('<div class="m-actions"></div>');
    var back = mEl('<button class="m-btn m-btn-secondary">Back to list</button>');
    back.onclick = function () { MApp.go('so'); };
    acts.appendChild(back);
    view.appendChild(acts);
  }

  MApp.route('so', function (view, params) {
    if (params && params.id) detail(view, params.id);
    else list(view);
  });
})();
