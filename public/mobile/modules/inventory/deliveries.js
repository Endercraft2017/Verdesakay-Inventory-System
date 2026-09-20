/* Deliveries — a driver's drops for the day + proof of delivery (recipient,
   signature, GPS, photos). Gated by delivery.run / delivery.manage. */
(function () {
  var STATUS = {
    pending: { label: 'Pending', cls: '' },
    out_for_delivery: { label: 'Out for delivery', cls: 'warn' },
    delivered: { label: 'Delivered', cls: 'ok' },
    failed: { label: 'Failed', cls: 'bad' },
    cancelled: { label: 'Cancelled', cls: '' },
  };

  function list(view) {
    MApp.setTitle('Deliveries');
    var canAll = MApp.can('delivery.manage');
    view.innerHTML =
      (canAll ? '<div class="m-seg" id="d-scope"><button data-s="mine" class="on">Mine</button><button data-s="all">All</button></div>' : '') +
      '<div id="d-list"><div class="m-hint">Loading…</div></div>';
    var scope = 'mine';
    var host = view.querySelector('#d-list');
    if (canAll) {
      view.querySelectorAll('#d-scope button').forEach(function (b) {
        b.onclick = function () {
          view.querySelectorAll('#d-scope button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on'); scope = b.dataset.s; loadList();
        };
      });
    }
    function loadList() {
      host.innerHTML = '<div class="m-hint">Loading…</div>';
      API.get('/deliveries' + (scope === 'mine' ? '?mine=1' : ''))
        .then(function (rows) { drawList(host, view, rows); })
        .catch(function (ex) { host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
    }
    loadList();
  }

  function drawList(host, view, rows) {
    host.innerHTML = '';
    if (!rows.length) { host.appendChild(mEl('<div class="m-stack-empty">No deliveries.</div>')); return; }
    var groups = [
      ['Out for delivery', rows.filter(function (r) { return r.status === 'out_for_delivery'; })],
      ['To do', rows.filter(function (r) { return r.status === 'pending'; })],
      ['Done', rows.filter(function (r) { return ['delivered', 'failed', 'cancelled'].indexOf(r.status) !== -1; })],
    ];
    groups.forEach(function (g) {
      if (!g[1].length) return;
      host.appendChild(mEl('<div class="m-sectitle">' + g[0] + '</div>'));
      var ul = mEl('<ul class="m-list"></ul>');
      g[1].forEach(function (d) {
        var st = STATUS[d.status] || { label: d.status, cls: '' };
        var li = mEl(
          '<li class="m-list-row"><div><b>' + mEsc(d.customer_name || d.number) + '</b>' +
          '<span>' + mEsc(d.number) + (d.address ? ' · ' + mEsc(d.address.slice(0, 40)) : '') +
          (d.item_count ? ' · ' + d.item_count + ' line(s)' : '') + '</span></div>' +
          '<div class="m-list-qty"><span class="m-jo-status ' + st.cls + '">' + mEsc(st.label) + '</span></div></li>'
        );
        li.onclick = function () { detail(view, d.id); };
        ul.appendChild(li);
      });
      host.appendChild(ul);
    });
  }

  function detail(view, id) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/deliveries/' + id)
      .then(function (d) { drawDetail(view, d); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function drawDetail(view, d) {
    MApp.setTitle(d.number);
    view.innerHTML = '';
    var st = STATUS[d.status] || { label: d.status, cls: '' };
    view.appendChild(mEl(
      '<div class="m-panel"><div style="display:flex;justify-content:space-between;align-items:center">' +
      '<b style="font-size:16px">' + mEsc(d.customer_name || d.number) + '</b>' +
      '<span class="m-jo-status ' + st.cls + '">' + mEsc(st.label) + '</span></div>' +
      (d.address ? '<div style="margin-top:8px"><a class="m-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(d.address) + '">📍 ' + mEsc(d.address) + '</a></div>' : '') +
      (d.contact_phone ? '<div style="margin-top:4px"><a class="m-link" href="tel:' + mEsc(d.contact_phone) + '">📞 ' + mEsc(d.contact_phone) + '</a></div>' : '') +
      (d.order_number ? '<div class="m-hint">Order ' + mEsc(d.order_number) + '</div>' : '') +
      (d.notes ? '<div class="m-hint">' + mEsc(d.notes) + '</div>' : '') +
      '</div>'
    ));

    if ((d.items || []).length) {
      view.appendChild(mEl('<div class="m-sectitle">To load</div>'));
      view.appendChild(mEl('<ul class="m-kv">' + d.items.map(function (it) {
        return '<li><span>' + mEsc(it.name) + '</span><b>' + it.quantity + ' ' + mEsc(it.unit || '') + '</b></li>';
      }).join('') + '</ul>'));
    }

    if (d.status === 'pending') {
      var start = mEl('<div class="m-actions"><button class="m-btn">Start delivery</button></div>');
      start.querySelector('button').onclick = function () {
        start.querySelector('button').disabled = true;
        API.post('/deliveries/' + d.id + '/status', { status: 'out_for_delivery' })
          .then(function () { detail(view, d.id); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); start.querySelector('button').disabled = false; });
      };
      view.appendChild(start);
    } else if (d.status === 'out_for_delivery') {
      var go = mEl('<div class="m-actions"><button class="m-btn">Complete delivery</button></div>');
      go.querySelector('button').onclick = function () { podSheet(view, d); };
      view.appendChild(go);
    } else {
      // POD summary
      view.appendChild(mEl('<div class="m-sectitle">Proof of delivery</div>'));
      var kv = '<li><span>Outcome</span><b>' + mEsc(st.label) + '</b></li>' +
        (d.pod_recipient ? '<li><span>Received by</span><b>' + mEsc(d.pod_recipient) + '</b></li>' : '') +
        (d.delivered_at ? '<li><span>When</span><b>' + mEsc(d.delivered_at.slice(0, 16).replace('T', ' ')) + '</b></li>' : '') +
        (d.delivered_by_name ? '<li><span>By</span><b>' + mEsc(d.delivered_by_name) + '</b></li>' : '') +
        (d.pod_note ? '<li><span>Note</span><b>' + mEsc(d.pod_note) + '</b></li>' : '');
      view.appendChild(mEl('<ul class="m-kv">' + kv + '</ul>'));
      if (d.pod_lat != null && d.pod_lng != null) {
        view.appendChild(mEl('<div><a class="m-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
          d.pod_lat + ',' + d.pod_lng + '">📍 View drop location</a></div>'));
      }
      if (d.signature_url) {
        var sig = mEl('<div class="m-sign-view"><img alt="signature" /></div>');
        API.blobUrl(d.signature_url).then(function (u) { sig.querySelector('img').src = u; }).catch(function () {});
        view.appendChild(sig);
      }
      view.appendChild(mPhoto.thumbs('delivery', d.id, { editable: false }));
    }

    view.appendChild(actions([{ label: 'Back to list', fn: function () { list(view); }, secondary: true }]));
  }

  function podSheet(view, d) {
    MApp.setTitle('Complete · ' + d.number);
    view.innerHTML = '';
    var geo = { lat: null, lng: null };

    var box = mEl(
      '<div class="m-panel">' +
      '<label class="m-field"><span class="m-label">Received by</span>' +
      '<input class="m-input" data-recip maxlength="160" placeholder="name of who accepted" /></label>' +
      '<div class="m-label" style="margin-top:6px">Signature</div><div data-sig></div>' +
      '<div class="m-label" style="margin-top:10px">Photos of the delivery</div><div data-photos></div>' +
      '<div class="m-actions" style="margin-top:8px"><button class="m-btn m-btn-secondary" data-geo>📍 Capture location</button></div>' +
      '<label class="m-field"><span class="m-label">Note</span><textarea class="m-input" data-note rows="2"></textarea></label>' +
      '</div>'
    );
    var sig = mSignature();
    box.querySelector('[data-sig]').appendChild(sig.el);
    box.querySelector('[data-photos]').appendChild(mPhoto.thumbs('delivery', d.id, { editable: true }));
    var geoBtn = box.querySelector('[data-geo]');
    geoBtn.onclick = function () {
      if (!navigator.geolocation) { mToast('No location on this device', 'err'); return; }
      geoBtn.disabled = true; geoBtn.textContent = 'Getting location…';
      navigator.geolocation.getCurrentPosition(function (p) {
        geo.lat = p.coords.latitude; geo.lng = p.coords.longitude;
        geoBtn.textContent = '📍 Location captured (±' + Math.round(p.coords.accuracy) + 'm)';
        geoBtn.disabled = false;
      }, function () {
        mToast('Could not get location', 'err');
        geoBtn.textContent = '📍 Capture location'; geoBtn.disabled = false;
      }, { enableHighAccuracy: true, timeout: 10000 });
    };
    view.appendChild(box);

    var acts = mEl('<div class="m-actions">' +
      '<button class="m-btn" data-ok>Delivered</button>' +
      '<button class="m-btn m-btn-warn" data-fail>Couldn’t deliver</button></div>');
    var back = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary" data-back>Cancel</button></div>');
    back.querySelector('[data-back]').onclick = function () { detail(view, d.id); };
    view.appendChild(acts);
    view.appendChild(back);

    function submit(outcome) {
      var note = box.querySelector('[data-note]').value.trim();
      if (outcome === 'failed' && note.length < 3) { mToast('Say why it couldn’t be delivered', 'err'); return; }
      var btns = acts.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
      var payload = {
        outcome: outcome,
        recipient: box.querySelector('[data-recip]').value.trim() || null,
        note: note || null,
        lat: geo.lat, lng: geo.lng,
      };
      var chain = Promise.resolve(null);
      if (!sig.isEmpty()) {
        chain = new Promise(function (resolve) { sig.toBlob(resolve); })
          .then(function (blob) { return mPhoto.attachBlob('signature', d.id, blob, 'signature.png'); })
          .then(function (r) { payload.signature_attachment_id = r.id; });
      }
      chain
        .then(function () { return API.post('/deliveries/' + d.id + '/complete', payload); })
        .then(function (r) {
          var lines = [d.number + (d.customer_name ? ' · ' + d.customer_name : '')];
          var acts = [
            { label: 'Back to list', onClick: function () { list(view); } },
            { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
          ];
          var ord = r && r.order;
          if (ord) {
            lines.push('Sale order ' + ord.number + ' is still ' + ord.status + '.');
            acts.unshift({
              label: 'Mark ' + ord.number + ' completed',
              onClick: function () { completeOrder(view, ord, d); },
            });
          }
          mSuccess(view, {
            title: outcome === 'delivered' ? 'Delivered' : 'Marked not delivered',
            lines: lines,
            actions: acts,
          });
        })
        .catch(function (ex) {
          mToast(ex && ex.offline ? 'Connect to record the delivery' : (ex.message || 'Failed'), 'err');
          btns.forEach(function (b) { b.disabled = false; });
        });
    }
    acts.querySelector('[data-ok]').onclick = function () { submit('delivered'); };
    acts.querySelector('[data-fail]').onclick = function () { submit('failed'); };
  }

  // Post-delivery: mark the dropped sale order completed (ships remaining stock via the
  // server's fulfil hook). A stock shortfall comes back 409 — offer to force a backorder.
  function completeOrder(view, ord, d, force) {
    view.innerHTML = '<div class="m-hint">Completing ' + mEsc(ord.number) + '…</div>';
    API.post('/orders/' + ord.id + '/status', force ? { status: 'completed', force: true } : { status: 'completed' })
      .then(function () {
        mSuccess(view, {
          title: ord.number + ' completed',
          lines: [(d.customer_name || '') + ' · delivery ' + d.number + ' done'],
          actions: [
            { label: 'Back to list', onClick: function () { list(view); } },
            { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
          ],
        });
      })
      .catch(function (ex) {
        if (ex && ex.status === 409 && ex.data && ex.data.availability) {
          var n = ex.data.availability.short_lines || 0;
          mSuccess(view, {
            title: 'Stock is short',
            lines: [n + ' line(s) on ' + ord.number + " aren't covered by stock.",
              'Complete anyway to ship as a backorder (stock may go negative).'],
            actions: [
              { label: 'Complete as backorder', onClick: function () { completeOrder(view, ord, d, true); } },
              { label: 'Leave it for now', secondary: true, onClick: function () { list(view); } },
            ],
          });
          return;
        }
        mToast((ex && ex.message) || 'Could not complete the order', 'err');
        list(view);
      });
  }

  function actions(items) {
    var bar = mEl('<div class="m-actions"></div>');
    items.forEach(function (i) {
      var b = mEl('<button class="m-btn ' + (i.secondary ? 'm-btn-secondary' : '') + '">' + mEsc(i.label) + '</button>');
      b.onclick = i.fn;
      bar.appendChild(b);
    });
    return bar;
  }

  MApp.route('deliveries', function (view, params) {
    if (params && params.id) detail(view, params.id);
    else list(view);
  });
})();
