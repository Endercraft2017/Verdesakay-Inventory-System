/* Check stock — scan / search an item, then see everything about it and act on it. */
(function () {
  function detail(view, id, unit) {
    MApp.setTitle('Item');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/inventory/' + id), API.get('/inventory/' + id + '/stock')])
      .then(function (r) { render(view, r[0], r[1], unit); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function render(view, it, breakdown, unit) {
    if (window.mRecent) mRecent.push(it);
    MApp.setTitle(it.name.length > 22 ? it.name.slice(0, 21) + '…' : it.name);
    view.innerHTML = '';

    var low = it.low_stock ? ' low' : '';
    var head = mEl(
      '<div class="m-detail">' +
      '  <div class="m-detail-top">' +
      '    <div class="m-detail-photo" data-photo></div>' +
      '    <div>' +
      '      <h2>' + mEsc(it.name) + '</h2>' +
      '      <div class="m-detail-sku">' + mEsc(it.sku || 'no SKU') + (it.category ? ' · ' + mEsc(it.category) : '') + '</div>' +
      '      <div class="m-detail-qty' + low + '">' + it.quantity + ' ' + mEsc(it.unit || '') +
      '        <span>reorder at ' + it.min_quantity + '</span></div>' +
      '    </div>' +
      '  </div>' +
      '</div>'
    );

    // scanned a serialized unit's QR label — show which unit it is
    if (unit && unit.identifier) {
      head.appendChild(mEl(
        '<div class="m-hint" style="margin-top:8px">Scanned unit <b>' + mEsc(unit.identifier) + '</b> · ' +
        mEsc(unit.status || '') + (unit.job_order_number ? ' · from ' + mEsc(unit.job_order_number) : '') + '</div>'
      ));
    }

    // photo
    var pbox = head.querySelector('[data-photo]');
    if (it.image_path) {
      API.blobUrl('/inventory/' + it.id + '/image')
        .then(function (u) { pbox.innerHTML = '<img alt="" src="' + u + '" />'; })
        .catch(function () { pbox.classList.add('empty'); pbox.textContent = 'No photo'; });
    } else {
      pbox.classList.add('empty');
      pbox.textContent = 'No photo';
    }

    // per-location
    var locs = (breakdown || []).filter(function (b) { return b.quantity !== 0; });
    var locHtml = locs.length
      ? '<ul class="m-kv">' + locs.map(function (b) {
          return '<li><span>' + mEsc(b.location_name) + '</span><b>' + b.quantity + '</b></li>';
        }).join('') + '</ul>'
      : '<div class="m-hint">No stock in any location.</div>';
    head.appendChild(mEl('<h3 class="m-h3">By location</h3>'));
    head.appendChild(mEl('<div>' + locHtml + '</div>'));

    // recent movements
    var hist = (it.history || []).slice(0, 8);
    if (hist.length) {
      head.appendChild(mEl('<h3 class="m-h3">Recent movements</h3>'));
      var ul = mEl('<ul class="m-moves"></ul>');
      hist.forEach(function (h) {
        var cls = h.change < 0 ? 'out' : 'in';
        ul.appendChild(mEl(
          '<li><span class="m-move-d ' + cls + '">' + (h.change > 0 ? '+' : '') + h.change + '</span>' +
          '<span class="m-move-r">' + mEsc(h.reason || '—') + '</span>' +
          '<span class="m-move-t">' + mEsc((h.created_at || '').slice(0, 16).replace('T', ' ')) + '</span></li>'
        ));
      });
      head.appendChild(ul);
    }

    // actions
    var acts = mEl('<div class="m-detail-acts"></div>');
    [
      ['Stock In', function () { mStockMoveForm(view, { item: it, mode: 'in' }); }],
      ['Stock Out', function () { mStockMoveForm(view, { item: it, mode: 'out' }); }],
      ['Transfer', function () { mTransferForm(view, it); }],
      ['Damage', function () { mDamageForm(view, it); }],
      ['Add QR', function () { MApp.go('assign-qr', { id: it.id }); }],
      ['Add photo', function () { mPhoto.capture(it.id).then(function () { detail(view, it.id); }).catch(function () {}); }],
      ['Report problem', function () { MApp.go('report-problem', { about: it.name + (it.sku ? ' (#' + it.sku + ')' : '') }); }],
    ].forEach(function (a) {
      var b = mEl('<button class="m-chip">' + mEsc(a[0]) + '</button>');
      b.onclick = a[1];
      acts.appendChild(b);
    });
    head.appendChild(acts);

    view.appendChild(head);
  }

  function start(view, params) {
    if (params && params.id) { detail(view, params.id); return; }
    MApp.setTitle('Check stock');
    view.innerHTML = '';
    var picker = mItemPicker({ label: 'Scan or search an item', onPick: function (it) { detail(view, it.id, it.unit); } });
    view.appendChild(picker.el);
    picker.focus();
  }

  MApp.route('item', function (view, params) { start(view, params); });
})();
