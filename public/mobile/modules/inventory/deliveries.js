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
      '<div data-delivery-saved></div><div id="d-list"><div class="m-hint">Loading…</div></div>';
    mDeliveryRecovery.cards(view.querySelector('[data-delivery-saved]'));
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
        li.onclick = function () { MApp.go('deliveries', { id: d.id }); };
        ul.appendChild(li);
      });
      host.appendChild(ul);
    });
  }

  async function detail(view, id, step) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    var hash = location.hash, owner = mProductionDrafts.key('delivery-owner');
    function visible() { return view.isConnected && hash === location.hash && owner === mProductionDrafts.key('delivery-owner'); }
    try {
      var saved = await mDeliveryRecovery.load(Number(id));
      if (!visible()) return;
      if (saved && saved.operation.state !== 'draft') { mDeliveryRecovery.paint(view,saved); return; }
      var d = await API.get('/deliveries/' + id);
      if (!visible()) return;
      if (step === 'proof' && d.status === 'out_for_delivery') await podSheet(view,d);
      else drawDetail(view,d);
    } catch (err) { if (visible()) { view.innerHTML = ''; view.appendChild(RoleUI.error(err,function () { detail(view,id,step); })); } }
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
        mDeliveryRecovery.draft(d).then(function (s) { return mDeliveryRecovery.start(d,s,'status',{ status: 'out_for_delivery' }); })
          .then(function (s) { mDeliveryRecovery.paint(view,s); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); start.querySelector('button').disabled = false; });
      };
      view.appendChild(start);
    } else if (d.status === 'out_for_delivery') {
      var go = mEl('<div class="m-actions"><button class="m-btn">Complete delivery</button></div>');
      go.querySelector('button').onclick = function () { MApp.go('deliveries', { id: d.id, step: 'proof' }); };
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

  async function podSheet(view, d) {
    var owner = mProductionDrafts.key('delivery-owner'), hash = location.hash;
    var saved = await mDeliveryRecovery.draft(d);
    if (owner !== mProductionDrafts.key('delivery-owner') || hash !== location.hash) return;
    if (saved.operation.state !== 'draft') { mDeliveryRecovery.paint(view,saved); return; }
    var data = saved.batch;
    function persist() {
      var status = view.querySelector('[data-draft-status]'); if (status) status.textContent = 'Saving on this phone…';
      return mDeliveryRecovery.save(saved).then(function () { if (status && status.isConnected) status.textContent = 'Saved on this phone'; }).catch(function (err) { if (status && status.isConnected) status.textContent = 'Not saved — ' + err.message; mToast(err.message,'err'); throw err; });
    }
    MApp.setTitle('Complete · ' + d.number);
    view.innerHTML = '';
    var geo = data.geo;

    var box = mEl(
      '<div class="m-panel">' +
      '<p class="m-hint" data-draft-status role="status">Changes are saved on this phone</p>' +
      '<label class="m-field"><span class="m-label">Received by</span>' +
      '<input class="m-input" data-recip maxlength="160" placeholder="name of who accepted" /></label>' +
      '<div class="m-label" style="margin-top:6px">Signature</div><div data-sig></div>' +
      '<div class="m-label" style="margin-top:10px">Photos of the delivery</div><div data-photos></div>' +
      '<div class="m-actions" style="margin-top:8px"><button class="m-btn m-btn-secondary" data-geo>📍 Capture location</button></div>' +
      '<label class="m-field"><span class="m-label">Note</span><textarea class="m-input" data-note rows="2"></textarea></label>' +
      '</div>'
    );
    var sig = mSignature({ onChange: function () {
      if (sig.isEmpty()) { data.sign = null; persist().catch(function () {}); }
      else sig.toBlob(function (blob) { data.sign = blob; persist().catch(function () {}); });
    } });
    if (data.sign) box.querySelector('[data-sig]').appendChild(mEl('<p class="m-hint">Saved signature retained. Draw again to replace or Clear to remove.</p>'));
    box.querySelector('[data-sig]').appendChild(sig.el);
    var preparing = false;
    var picker = mPhoto.picker({ max: 10, initial: data.photos, onBusy: function (busy) { preparing = busy; }, onChange: function (files) { data.photos = files.slice(); persist().catch(function () {}); } });
    box.querySelector('[data-photos]').appendChild(picker);
    box.querySelector('[data-recip]').value = data.recipient || '';
    box.querySelector('[data-note]').value = data.note || '';
    box.querySelectorAll('[data-recip], [data-note]').forEach(function (input) { input.oninput = function () { data.recipient = box.querySelector('[data-recip]').value; data.note = box.querySelector('[data-note]').value; persist().catch(function () {}); }; });
    var geoBtn = box.querySelector('[data-geo]');
    if (geo.lat != null) geoBtn.textContent = '📍 Saved location captured';
    geoBtn.onclick = function () {
      if (!navigator.geolocation) { mToast('No location on this device', 'err'); return; }
      geoBtn.disabled = true; geoBtn.textContent = 'Getting location…';
      navigator.geolocation.getCurrentPosition(function (p) {
        geo.lat = p.coords.latitude; geo.lng = p.coords.longitude; persist().catch(function () {});
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
    back.querySelector('[data-back]').onclick = function () { MApp.go('deliveries', { id: d.id }); };
    view.appendChild(acts);
    view.appendChild(back);

    async function submit(outcome) {
      if (preparing) { mToast('Wait for photos to finish preparing.', 'err'); return; }
      var note = box.querySelector('[data-note]').value.trim();
      if (outcome === 'failed' && note.length < 3) { mToast('Say why it couldn’t be delivered', 'err'); return; }
      var btns = acts.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
      var payload = {
        outcome: outcome,
        recipient: box.querySelector('[data-recip]').value.trim() || null,
        note: note || null,
        lat: geo.lat, lng: geo.lng,
      };
      try {
        data.recipient = payload.recipient; data.note = payload.note; data.photos = picker.files();
        if (!sig.isEmpty()) data.sign = await new Promise(function (resolve) { sig.toBlob(resolve); });
        await persist();
        await mDeliveryRecovery.start(d,saved,'complete',payload);
        if (hash === location.hash && owner === mProductionDrafts.key('delivery-owner')) mDeliveryRecovery.paint(view,saved);
      } catch (ex) {
        mToast(ex.message || 'Could not save delivery.', 'err');
        btns.forEach(function (b) { b.disabled = false; });
      }
    }
    acts.querySelector('[data-ok]').onclick = function () { submit('delivered'); };
    acts.querySelector('[data-fail]').onclick = function () { submit('failed'); };
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
    if (!MApp.can('delivery.run') && !MApp.can('delivery.manage')) { view.innerHTML = '<div class="m-error">You do not have delivery permission.</div>'; return; }
    if (params && params.id) detail(view, params.id, params.step);
    else list(view);
  });
})();
