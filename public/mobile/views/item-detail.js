/* Scan Result — scan / search an item, see its stock, and act on it via the arc menu. */
(function () {
  function detail(view, id, unit) {
    MApp.setTitle('Scan Result');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/inventory/' + id), API.get('/inventory/' + id + '/stock')])
      .then(function (r) { render(view, r[0], r[1], unit); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function icon(name) {
    var P = {
      in: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
      out: '<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M4 4h16"/>',
      transfer: '<path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/>',
      damage: '<path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
      qa: '<path d="M9 12l2 2 4-5"/><circle cx="12" cy="12" r="9"/>',
    };
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + P[name] + '</svg>';
  }

  function render(view, it, breakdown, unit) {
    if (window.mRecent) mRecent.push(it);
    view.innerHTML = '';

    view.appendChild(mEl(
      '<div class="m-sr-head"><div class="m-hint" style="margin:0">Item detail</div>' +
      '<div class="m-sr-saved">' + (navigator.onLine
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg> Synced'
        : 'Offline') + '</div></div>'
    ));

    var top = mEl(
      '<div class="m-sr-top">' +
      '<div class="m-sr-photo" data-photo>No photo</div>' +
      '<div style="min-width:0">' +
      '<div class="m-sr-name">' + mEsc(it.name) + '</div>' +
      '<div class="m-sr-sku">SKU <b>' + mEsc(it.sku || '—') + '</b>' + (it.category ? ' · ' + mEsc(it.category) : '') + '</div>' +
      '</div></div>'
    );
    view.appendChild(top);

    if (unit && unit.identifier) {
      var pill = mEl('<div class="m-sr-unit">Serialized Unit · ' + mEsc(unit.identifier) +
        ' <button aria-label="Copy"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>');
      pill.querySelector('button').onclick = function () {
        try { navigator.clipboard.writeText(unit.identifier); mToast('Copied'); } catch (e) { mToast(unit.identifier); }
      };
      view.appendChild(pill);
      view.appendChild(mEl('<div class="m-hint">' + mEsc(unit.status || '') +
        (unit.job_order_number ? ' · from ' + mEsc(unit.job_order_number) : '') + '</div>'));
    }

    var pbox = top.querySelector('[data-photo]');
    if (it.image_path) {
      API.blobUrl('/inventory/' + it.id + '/image')
        .then(function (u) { pbox.innerHTML = '<img alt="" src="' + u + '" />'; })
        .catch(function () {});
    }

    view.appendChild(mEl(
      '<div class="m-sr-nums">' +
      '<div class="m-sr-num"><span class="n">' + it.quantity + '</span><span class="l">On Hand ' + mEsc(it.unit || '') + '</span></div>' +
      '<div class="m-sr-num"><span class="n" style="' + (it.low_stock ? 'color:var(--m-danger)' : '') + '">' + it.min_quantity + '</span><span class="l">Reorder at</span></div>' +
      '</div>'
    ));

    var locs = (breakdown || []).filter(function (b) { return b.quantity !== 0; });
    if (locs.length) {
      view.appendChild(mEl('<div class="m-sectitle">Locations</div>'));
      view.appendChild(mEl('<ul class="m-kv">' + locs.map(function (b) {
        return '<li><span>' + mEsc(b.location_name) + '</span><b>' + b.quantity + '</b></li>';
      }).join('') + '</ul>'));
    }

    var hist = (it.history || []).slice(0, 3);
    if (hist.length) {
      view.appendChild(mEl('<div class="m-sectitle">Recent movement</div>'));
      var ul = mEl('<ul class="m-moves"></ul>');
      hist.forEach(function (h) {
        var cls = h.change < 0 ? 'out' : 'in';
        ul.appendChild(mEl(
          '<li><span class="m-move-d ' + cls + '">' + (h.change > 0 ? '+' : '') + h.change + '</span>' +
          '<span class="m-move-r">' + mEsc(h.reason || '—') + '</span>' +
          '<span class="m-move-t">' + mEsc((h.created_at || '').slice(0, 16).replace('T', ' ')) + '</span></li>'
        ));
      });
      view.appendChild(ul);
    }

    // ---- arc action menu ----
    var arc = mEl('<div class="m-arc"></div>');
    var ACTIONS = [
      { key: 'in', label: 'In', fn: function () { mStockMoveForm(view, { item: it, mode: 'in' }); } },
      { key: 'out', label: 'Out', fn: function () { mStockMoveForm(view, { item: it, mode: 'out' }); } },
      { key: 'transfer', label: 'Transfer', fn: function () { mTransferForm(view, it); } },
      { key: 'damage', label: 'Damage', warn: true, fn: function () { mDamageForm(view, it); } },
      { key: 'qa', label: 'QA', dim: !it.is_finished_product, fn: function () {
          if (!it.is_finished_product) { mToast('Not a finished product', 'err'); return; }
          MApp.go('qc');
        } },
    ];
    ACTIONS.forEach(function (a) {
      var b = mEl('<button class="' + (a.warn ? 'warn' : '') + '"' + (a.dim ? ' disabled' : '') +
        '><span class="ic">' + icon(a.key) + '</span>' + mEsc(a.label) + '</button>');
      b.onclick = a.fn;
      arc.appendChild(b);
    });
    view.appendChild(arc);

    // secondary chips
    var chips = mEl('<div class="m-detail-acts" style="margin-top:14px"></div>');
    [
      ['Add QR', function () { MApp.go('assign-qr', { id: it.id }); }],
      ['Add photo', function () { mPhoto.capture(it.id).then(function () { detail(view, it.id); }).catch(function () {}); }],
      ['Report problem', function () { MApp.go('report-problem', { about: it.name + (it.sku ? ' (#' + it.sku + ')' : '') }); }],
    ].forEach(function (a) {
      var b = mEl('<button class="m-chip">' + mEsc(a[0]) + '</button>');
      b.onclick = a[1];
      chips.appendChild(b);
    });
    view.appendChild(chips);
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
