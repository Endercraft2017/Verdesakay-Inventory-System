/* Sale Order release — the warehouse releaser accepts an approved SO, scans every unit's
   printed QR label to add it to the order (and enters a quantity for non-serialized
   lines), then issues the release slip (who collected it + photos of the goods). Scanning
   is records only; issuing the slip confirms the SO, which is when stock goes out.
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
            mEsc(o.warehouse_accepted_at ? o.status : 'to accept') + '</span></div></li>'
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
    var accepted = !!order.warehouse_accepted_at;

    view.appendChild(mEl(
      '<div class="m-jo-head"><h2>' + mEsc(order.customer_name || 'Walk-in') + '</h2>' +
      '<div class="m-jo-meta">' + mEsc(order.number) + ' · <span class="m-jo-status ' +
      (order.status === 'released' ? 'completed' : 'released') + '">' + mEsc(order.status) + '</span></div>' +
      (order.release_slip_number ? '<div class="m-hint">Released on slip <b>' + mEsc(order.release_slip_number) + '</b> — stock deducted.</div>'
        : order.status === 'released' ? '<div class="m-hint">Every line is out — issue the release slip as the goods leave.</div>'
        : releasable && !accepted ? '<div class="m-hint">Accept this order to start releasing it.</div>'
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
          (releasable && accepted && !done
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

    if (releasable && !accepted) {
      var accBar = mEl('<div class="m-actions"><button class="m-btn">✅  Accept for release</button></div>');
      accBar.querySelector('button').onclick = function () {
        var b = accBar.querySelector('button');
        b.disabled = true;
        API.post('/orders/' + order.id + '/accept-release', {})
          .then(function (r) { order = r.order; items = order.items || []; mToast('Accepted'); refresh(); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); b.disabled = false; });
      };
      view.appendChild(accBar);
    }

    if (String(order.status).toLowerCase() === 'released' && !order.release_slip_id) slipForm(view, order);
    if (order.release_slip_id) {
      view.appendChild(mEl('<div class="m-label" style="margin-top:10px">Photos on slip ' + mEsc(order.release_slip_number) + '</div>'));
      view.appendChild(mPhoto.thumbs('release', order.release_slip_id, { editable: true }));
    }

    if (releasable && accepted && order.status !== 'released') {
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

  /** Release slip: who collected the goods + photos. Needs a connection (photos can't queue). */
  function slipForm(view, order) {
    var files = [];
    var box = mEl(
      '<div class="m-card" style="margin-top:12px">' +
      '<div class="m-label">Release slip</div>' +
      '<input class="m-input" data-f="collected_by" placeholder="Collected by (driver / customer rep) *" />' +
      '<input class="m-input" data-f="vehicle_plate" placeholder="Vehicle / plate no. (optional)" style="margin-top:8px" />' +
      '<input class="m-input" data-f="notes" placeholder="Notes (optional)" style="margin-top:8px" />' +
      '<div class="m-label" style="margin-top:10px">Photos of the outgoing goods *</div>' +
      '<div class="m-thumbs" data-thumbs></div>' +
      '<div class="m-actions"><button class="m-btn" data-issue>🧾  Issue release slip</button></div>' +
      '</div>'
    );
    var strip = box.querySelector('[data-thumbs]');
    function drawThumbs() {
      strip.innerHTML = '';
      files.forEach(function (f, i) {
        var cell = mEl('<div class="m-thumb"><img alt="" /></div>');
        cell.querySelector('img').src = URL.createObjectURL(f);
        var x = mEl('<button class="m-thumb-x" type="button" aria-label="Remove">×</button>');
        x.onclick = function () { files.splice(i, 1); drawThumbs(); };
        cell.appendChild(x);
        strip.appendChild(cell);
      });
      var add = mEl('<button class="m-thumb m-thumb-add" type="button">＋<span>Photo</span></button>');
      add.onclick = function () { mPhoto.pickFile().then(function (f) { files.push(f); drawThumbs(); }).catch(function () {}); };
      strip.appendChild(add);
    }
    drawThumbs();

    var btn = box.querySelector('[data-issue]');
    btn.onclick = function () {
      var val = function (k) { return box.querySelector('[data-f="' + k + '"]').value.trim(); };
      if (!val('collected_by')) { mToast('Enter who collected the goods', 'err'); return; }
      if (!files.length) { mToast('Add at least one photo of the goods', 'err'); return; }
      btn.disabled = true;
      API.post('/orders/' + order.id + '/release-slip', {
        collected_by: val('collected_by'), vehicle_plate: val('vehicle_plate') || null, notes: val('notes') || null,
      })
        .then(function (r) {
          var failed = 0;
          return files.reduce(function (p, f) {
            return p.then(function () {
              return mPhoto.attachBlob('release', r.id, f, f.name || 'photo.jpg').catch(function () { failed += 1; });
            });
          }, Promise.resolve()).then(function () {
            mToast(failed ? 'Slip issued — ' + failed + ' photo(s) failed, add them below' : 'Release slip issued', failed ? 'err' : undefined);
            detail(view, order.id);
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
    view.appendChild(box);
  }

  MApp.route('so', function (view, params) {
    if (params && params.id) detail(view, params.id);
    else list(view);
  });
})();
