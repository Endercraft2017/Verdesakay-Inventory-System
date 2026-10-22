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

  function courier(d) { return d.delivery_mode === 'courier'; }
  function state(d) {
    if (courier(d) && d.status === 'delivered') return { label: 'Picked up by courier', cls: 'ok' };
    if (courier(d) && d.status === 'pending') return { label: 'Awaiting courier pickup', cls: '' };
    return STATUS[d.status] || { label: d.status, cls: '' };
  }

  function list(view) {
    MApp.setTitle('Deliveries');
    var canAll = MApp.can('delivery.manage');
    view.innerHTML =
      (canAll ? '<div class="m-seg" id="d-scope"><button data-s="mine" class="on">Mine</button><button data-s="all">All</button></div>' : '') +
      '<div data-delivery-saved></div><div id="d-list"><div class="m-hint">Loading…</div></div>';
    if(canAll){var plan=mEl('<div class="m-actions"><button class="m-btn">Plan delivery trip</button></div>');plan.querySelector('button').onclick=function(){MApp.go('deliveries',{step:'plan'});};view.prepend(plan);}
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
        var st = state(d);
        var li = mEl(
          '<li class="m-list-row"><div><b>' + mEsc(d.customer_name || d.number) + '</b>' +
          '<span>' + mEsc(d.number) + (courier(d) ? ' · Courier: ' + mEsc(d.courier_name || 'Courier') : '') + (d.address ? ' · ' + mEsc(d.address.slice(0, 40)) : '') +
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
      if (step === 'proof' && (d.status === 'out_for_delivery' || courier(d) && d.status === 'pending')) await podSheet(view,d);
      else drawDetail(view,d);
    } catch (err) { if (visible()) { view.innerHTML = ''; view.appendChild(RoleUI.error(err,function () { detail(view,id,step); })); } }
  }

  function drawDetail(view, d) {
    MApp.setTitle(d.number);
    view.innerHTML = '';
    var st = state(d);
    view.appendChild(mEl(
      '<div class="m-panel"><div style="display:flex;justify-content:space-between;align-items:center">' +
      '<b style="font-size:16px">' + mEsc(d.customer_name || d.number) + '</b>' +
      '<span class="m-jo-status ' + st.cls + '">' + mEsc(st.label) + '</span></div>' +
      (d.address ? '<div style="margin-top:8px"><a class="m-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent(d.address) + '">📍 ' + mEsc(d.address) + '</a></div>' : '') +
      (d.contact_phone ? '<div style="margin-top:4px"><a class="m-link" href="tel:' + mEsc(d.contact_phone) + '">📞 ' + mEsc(d.contact_phone) + '</a></div>' : '') +
      (d.order_number ? '<div class="m-hint">Order ' + mEsc(d.order_number) + (d.release_slip_number?' · Slip '+mEsc(d.release_slip_number):' · Load not yet released') + '</div>' : '') +
      (courier(d) ? '<div class="m-hint">Courier: ' + mEsc(d.courier_name || 'Courier') + (d.tracking_number ? ' · Tracking: ' + mEsc(d.tracking_number) : '') + '</div>' : '') +
      (d.notes ? '<div class="m-hint">' + mEsc(d.notes) + '</div>' : '') +
      '</div>'
    ));

    if ((d.items || []).length) {
      view.appendChild(mEl('<div class="m-sectitle">This trip’s goods</div>'));
      view.appendChild(mEl('<ul class="m-kv">' + d.items.map(function (it) {
        return '<li><span>' + mEsc(it.name) + '</span><b>' + it.quantity + ' ' + mEsc(it.unit || '') + '</b></li>';
      }).join('') + '</ul>'));
    }

    if (courier(d) && d.status === 'pending') {
      view.appendChild(mEl(RoleUI.note('info', 'Record pickup only after the courier physically collects the released goods. This is not customer delivery.')));
      view.appendChild(actions([{ label: 'Record courier pickup', fn: function () { MApp.go('deliveries', { id: d.id, step: 'proof' }); } }]));
    } else if (d.status === 'pending') {
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
      view.appendChild(mEl('<div class="m-sectitle">' + (courier(d) ? 'Courier pickup record' : 'Proof of delivery') + '</div>'));
      var kv = '<li><span>Outcome</span><b>' + mEsc(st.label) + '</b></li>' +
        (d.pod_recipient ? '<li><span>' + (courier(d) ? 'Collected by' : 'Received by') + '</span><b>' + mEsc(d.pod_recipient) + '</b></li>' : '') +
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
    MApp.setTitle((courier(d) ? 'Courier pickup · ' : 'Complete · ') + d.number);
    view.innerHTML = '';
    var geo = data.geo;

    var box = mEl(
      '<div class="m-panel">' +
      '<p class="m-hint" data-draft-status role="status">Changes are saved on this phone</p>' +
      '<p class="m-hint">' + (courier(d) ? 'Courier: ' + mEsc(d.courier_name || 'Courier') + '. This records collection, not customer delivery. ' : '') + 'Name, signature, photos and location are optional.</p>' +
      (courier(d) ? '<label class="m-field"><span class="m-label">Tracking / waybill (optional)</span><input class="m-input" data-tracking maxlength="160" /></label>' : '') +
      '<label class="m-field"><span class="m-label">' + (courier(d) ? 'Courier collector (optional)' : 'Received by') + '</span>' +
      '<input class="m-input" data-recip maxlength="160" placeholder="name of who accepted" /></label>' +
      '<div class="m-label" style="margin-top:6px">Signature</div><div data-sig></div>' +
      '<div class="m-label" style="margin-top:10px">' + (courier(d) ? 'Photos of courier pickup (optional)' : 'Photos of the delivery') + '</div><div data-photos></div>' +
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
    var tracking = box.querySelector('[data-tracking]');
    if (tracking) tracking.value = data.tracking != null ? data.tracking : d.tracking_number || '';
    box.querySelectorAll('[data-recip], [data-note], [data-tracking]').forEach(function (input) { input.oninput = function () { data.recipient = box.querySelector('[data-recip]').value; data.note = box.querySelector('[data-note]').value; if (tracking) data.tracking = tracking.value; persist().catch(function () {}); }; });
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
      '<button class="m-btn" data-ok>' + (courier(d) ? 'Confirm courier pickup' : 'Delivered') + '</button>' +
      (courier(d) ? '' : '<button class="m-btn m-btn-warn" data-fail>Couldn’t deliver</button>') + '</div>');
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
      if (tracking) { payload.tracking_number = tracking.value.trim() || null; data.tracking = tracking.value; }
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
    acts.querySelector('[data-ok]').onclick = function () { submit(courier(d) ? 'courier_handoff' : 'delivered'); };
    var fail = acts.querySelector('[data-fail]'); if (fail) fail.onclick = function () { submit('failed'); };
  }

  async function planTrip(view,params){
    if(!MApp.can('delivery.manage')){view.innerHTML='<div class="m-error">Delivery planning permission is required.</div>';return;}
    var hash=location.hash,owner=mProductionDrafts.key('delivery-owner');
    view.innerHTML='<div class="m-hint">Loading dispatch context…</div>';
    try{
      var saved=await mDeliveryRecovery.draft({id:0,number:'New delivery trip'});
      if(saved.operation.state!=='draft'){mDeliveryRecovery.paint(view,saved);return;}
      var ctx=await API.get('/deliveries/planning-context');
      if(hash!==location.hash||owner!==mProductionDrafts.key('delivery-owner'))return;
      var draft=saved.batch.plan||{order_id:Number(params.order)||null,release_slip_id:Number(params.slip)||null,delivery_mode:'own'};
      MApp.setTitle('Plan delivery trip');
      view.innerHTML='<div class="m-panel"><h2>Plan delivery trip</h2><p class="m-hint">Each trip belongs to the same sales order and carries only its release slip’s goods.</p>'+
        '<label class="m-field">Sales order<select class="m-input" data-plan="order_id"><option value="">Choose sales order</option>'+ctx.orders.map(function(o){return '<option value="'+o.id+'">'+mEsc(o.number+' · '+(o.customer_name||''))+'</option>';}).join('')+'</select></label>'+
        '<label class="m-field">This trip’s release slip<select class="m-input" data-plan="release_slip_id"></select></label><div data-trip-preview></div>'+
        '<label class="m-field">Method<select class="m-input" data-plan="delivery_mode"><option value="own">Own delivery team</option><option value="courier">Courier pickup</option></select></label>'+
        '<label class="m-field">Assign driver / staff<select class="m-input" data-plan="assigned_to"><option value="">Choose staff</option>'+ctx.drivers.map(function(u){return '<option value="'+u.id+'">'+mEsc(u.full_name)+'</option>';}).join('')+'</select></label>'+
        '<label class="m-field" data-carrier>Courier company<input class="m-input" maxlength="160" data-plan="courier_name"></label>'+
        '<label class="m-field">Scheduled date<input class="m-input" type="date" data-plan="scheduled_date"></label>'+
        '<label class="m-field">Address<input class="m-input" maxlength="500" data-plan="address"></label>'+
        '<label class="m-field">Notes<textarea class="m-input" maxlength="2000" data-plan="notes"></textarea></label>'+
        '<p class="m-hint" data-plan-status>Changes are saved on this phone.</p></div>'+RoleUI.actions([{id:'plan-save',label:'Book this trip',kind:'primary'},{id:'plan-back',label:'Back to deliveries',kind:'secondary'}]);
      function field(k){return view.querySelector('[data-plan="'+k+'"]');}
      var initializing=true;
      function preview(){var o=ctx.orders.find(function(o){return o.id===Number(field('order_id').value);});var slips=o?o.slips:[],selected=initializing?draft.release_slip_id:Number(field('release_slip_id').value)||null;initializing=false;
        field('release_slip_id').innerHTML='<option value="">Await this trip’s warehouse release</option>'+slips.map(function(s){return '<option value="'+s.id+'">'+mEsc(s.number)+'</option>';}).join('');field('release_slip_id').value=selected&&slips.some(function(s){return s.id===selected;})?selected:slips.length===1&&o&&o.remaining<=0?slips[0].id:'';
        view.querySelector('[data-trip-preview]').textContent=field('release_slip_id').value?'Only goods on the selected slip belong to this trip.':'No goods have been released to this trip yet. The clerk will link its load at warehouse-out.';
        view.querySelector('[data-carrier]').hidden=field('delivery_mode').value!=='courier';
      }
      ['order_id','delivery_mode','assigned_to','courier_name','scheduled_date','address','notes'].forEach(function(k){field(k).value=draft[k]||'';});preview();
      function collect(){var p={};['order_id','release_slip_id','assigned_to','delivery_mode','courier_name','scheduled_date','address','notes'].forEach(function(k){var v=field(k).value.trim();p[k]=['order_id','release_slip_id','assigned_to'].indexOf(k)!==-1?Number(v)||null:v||null;});if(p.delivery_mode!=='courier')p.courier_name=null;return p;}
      function persist(){saved.batch.plan=collect();return mDeliveryRecovery.save(saved).then(function(){var status=view.querySelector('[data-plan-status]');if(status)status.textContent='Saved on this phone';}).catch(function(e){mToast(e.message,'err');throw e;});}
      view.querySelectorAll('[data-plan]').forEach(function(input){input.onchange=function(){if(input===field('order_id')){draft.release_slip_id=null;field('release_slip_id').value='';}preview();persist().catch(function(){});};input.oninput=function(){if(input.tagName==='INPUT'||input.tagName==='TEXTAREA')persist().catch(function(){});};});
      view.querySelector('#plan-save').onclick=async function(){var p=collect(),btn=view.querySelector('#plan-save');if(!p.order_id||!p.assigned_to){mToast('Choose the sales order and assigned driver/staff.','err');return;}if(p.delivery_mode==='courier'&&!p.courier_name){mToast('Name the courier company.','err');return;}btn.disabled=true;try{await persist();await mDeliveryRecovery.start({id:0,number:'New delivery trip',order_id:p.order_id},saved,'create',p);if(hash===location.hash)mDeliveryRecovery.paint(view,saved);}catch(e){mToast(e.message,'err');btn.disabled=false;}};
      view.querySelector('#plan-back').onclick=function(){MApp.go('deliveries');};
    }catch(e){if(hash===location.hash){view.innerHTML='';view.appendChild(RoleUI.error(e,function(){planTrip(view,params);}));}}
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
    if(params&&params.step==='plan')planTrip(view,params);
    else if (params && params.id) detail(view, params.id, params.step);
    else list(view);
  });
})();
