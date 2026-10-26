/* Releasing personnel — sale-order warehouse-out (Figma 78:*).
     78:16 queue (Ready / Blocked / Completed) · 78:68 verify release authority · 78:109 scan
     units · 78:147 verify allocated unit · 78:365 release blocked (wrong serial) · 78:188
     package · 78:240 handoff details · 78:281 handoff proof · 78:317 review · 78:401 confirm ·
     78:438 recorded · 78:481 incomplete allocation
   Backend: GET /release-slips/queue | /orders/:id/context | /orders/:id/unit?code= |
   /orders/:id/verify-token; POST /orders/:id/accept-release, /orders/:id/release (allocate a
   unit / bulk quantity), /orders/:id/release-slip (warehouse-out), /release-slips/orders/:id/reports.
   The slip re-checks the token, every required package item and partial-release authority on
   the server (modules/inventory/release-auth.ts): a refusal moves no stock. Warehouse-out and
   allocation are online-only — nothing here is queued, so nothing is shown as done that the
   server hasn't confirmed. The token is never shown to the releaser: the recipient presents it.
   When they can't, a supervisor (inventory.adjust) approves releasing without it, with a reason —
   asked from here (POST /release-slips/orders/:id/override-request, pushed to supervisors) or
   decided here by a supervisor (/override). Handoff photos upload first as 'release_proof' on the
   order and go with the slip as evidence_ids — the server refuses a phone warehouse-out without one.
   URLs: #/so[?tab=blocked|done] · ?id=<orderId>[&step=scan|unit|blocked|package|handoff|override|
   proof|review|confirm|done|incomplete|report|receipt][&code=][&kind=] */
(function () {
  var R = window.RoleUI;
  var owner = null, renderSerial = 0;
  var S = {};   // per order: { token, tokenOk, pkg:{key:true}, seal, area, recipient, plate, photos:[], sign, key, result }
  var can = function (p) { return MApp.can(p); };
  var offline = function () { return navigator.onLine === false; };
  var go = function (extra) { MApp.go('so', extra || {}); };
  var page = function (view, node, title, sub) { return R.page(view, { role: 'releasing', node: node, title: title, subtitle: sub }); };
  var st = function (id) { return S[id] || (S[id] = { pkg: {}, photos: [], _scope: mProductionDrafts.key('release-owner') }); };
  function persist(id, state) { return mReleaseHandoff.saveDraft(id, state || st(id)); }
  function saveError(err) { mToast(err.message || 'Could not save handoff on this device.', 'err'); }
  var MODES = { pickup: 'Customer pickup', delivery: 'Delivery' };

  function when(ts) { return ts ? new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : '')) : null; }
  function time(ts) { var d = when(ts); return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function clock(ts) {
    var d = when(ts); if (!d) return '';
    return (d.toDateString() === new Date().toDateString() ? 'Today, ' : d.toLocaleDateString() + ', ') + time(ts);
  }
  function fail(btn, text) { return function (err) { mToast((err && err.message) || 'Failed', 'err'); if (btn) { btn.disabled = false; if (text) btn.textContent = text; } }; }
  function key() { return 'rel-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)); }

  function buildTag(mode) { return mode === 'semi_built' ? 'Semi-built' : mode === 'ckd_component' ? 'CKD component' : 'Fully built / standard'; }
  function physical(l) { return l.item_id && l.fulfillment_mode !== 'ckd'; }
  function manifest(c) { return c.lines.filter(function (l) { return l.fulfillment_mode === 'ckd'; }).map(function (l) { return R.field('CKD kit — components must be allocated', l.quantity + ' × ' + l.name) + R.lines(c.lines.filter(function (part) { return part.parent_order_item_id === l.id; }).map(function (part) { return { name: part.name, qty: part.quantity, ok: (part.released_qty || 0) >= part.quantity }; })); }).join(''); }
  function remaining(l) { return Math.max(0, Number(l.quantity) - Number(l.cancelled_qty||0) - Number(l.units || 0) - Number(l.released_qty || 0)); }
  function lineText(c,l) { return 'Line #' + (l.id || '?') + ' · ' + l.name + ' · ' + buildTag(l.fulfillment_mode) + (l.parent_order_item_id ? ' · Kit line #' + l.parent_order_item_id : '') +
    (l.unit_price != null ? ' · ' + (c.order.currency || 'PHP') + ' ' + Number(l.unit_price).toFixed(2) : '') + ' · ' + remaining(l) + ' remaining'; }
  function lineFree(c,l) {
    var rows=c.availability||[], a=rows.find(function(a){return a.order_item_id===l.id&&l.id!=null;});
    if(!a) a=rows.find(function(a){return a.item_id===l.item_id&&(!a.fulfillment_mode||a.fulfillment_mode===(l.fulfillment_mode||'assembled'));});
    if(!a)return 0;
    if(a.on_hand==null)return Math.max(0,Math.min(remaining(l),a.free_to_allocate));
    var poolHeld=c.lines.filter(function(x){return physical(x)&&x.item_id===l.item_id&&(x.fulfillment_mode==='semi_built')===(l.fulfillment_mode==='semi_built');})
      .reduce(function(n,x){return n+Math.max(0,held(x)-c.units.filter(function(u){return u.order_item_id===x.id&&u.pending_direct;}).length);},0);
    return Math.max(0,Math.min(remaining(l),Number(a.on_hand)-Number(a.committed_elsewhere||0)-poolHeld));
  }
  function chooseLine(view,c,code,lines,selected,render,evidence) {
    if(selected){var chosen=lines.find(function(l){return Number(l.id)===Number(selected);});if(chosen){render(chosen);return;}}
    else if(lines.length===1){render(lines[0]);return;}
    var body=allocationPage(view,'Choose sale line','The same label matches more than one sale line. Choose where this quantity belongs.');
    body.innerHTML=R.field('Scanned label',code)+R.note('info','Only lines with the same product and build state share a stock pool. Choosing a line does not reserve stock.')+
      (lines.length?lines.map(function(l){return '<button type="button" class="rk-card rk-unitcard" data-sale-line="'+l.id+'"><b>Line #'+l.id+' · '+mEsc(l.name)+'</b><span>'+mEsc(buildTag(l.fulfillment_mode)+(l.parent_order_item_id?' · Kit line #'+l.parent_order_item_id:''))+'</span><small>'+(l.unit_price!=null?'<span style="white-space:nowrap">'+mEsc((c.order.currency||'PHP')+' '+Number(l.unit_price).toFixed(2))+'</span> · ':'')+remaining(l)+' remaining</small></button>';}).join(''):R.note('warn','No matching line has remaining quantity. Refresh the order before another allocation.'))+
      R.actions([{id:'rel-line-back',label:'Back to stock review',kind:'secondary'}]);
    body.querySelectorAll('[data-sale-line]').forEach(function(b){b.onclick=function(){unit(view,c,code,b.dataset.saleLine,evidence);};});
    body.querySelector('#rel-line-back').onclick=function(){closeAllocation(view,c);};
  }
  function held(l) { return l.held_qty!=null?Number(l.held_qty):Math.max(0,Number(l.units||0)+Number(l.released_qty||0)-Number(l.dispatched_qty||0)); }
  function loadLines(c) { var s=st(c.order.id);return s.trip||c.lines.filter(physical).filter(function(l){return held(l)>0;}).map(function(l){return {order_item_id:l.id,quantity:held(l)};}); }
  function tripPackage(c) {
    var ids=loadLines(c).map(function(r){return r.order_item_id;});
    var items=c.lines.filter(function(l){return ids.indexOf(l.id)!==-1||l.fulfillment_mode==='ckd'&&c.lines.some(function(p){return p.parent_order_item_id===l.id&&ids.indexOf(p.id)!==-1;});}).map(function(l){return l.item_id;});
    return c.package.filter(function(p){return items.indexOf(p.item_id)!==-1;});
  }
  function loadCount(c){return loadLines(c).reduce(function(n,l){return n+l.quantity;},0);}
  // Every handoff entry point checks the chosen load, including bookmarks and restored drafts.
  // Extra components may stay reserved, but components on this trip must form complete kits.
  function ckdLoadProblem(c, rows) {
    var parents=c.lines.filter(function(l){return l.fulfillment_mode==='ckd';});
    rows=rows||loadLines(c);
    if(!rows.length)return 'Choose at least one reserved unit or quantity.';
    for(var i=0;i<rows.length;i++){
      var selected=rows[i],line=c.lines.find(function(l){return l.id===selected.order_item_id&&physical(l);});
      if(!line||!Number.isFinite(selected.quantity)||selected.quantity<=0||selected.quantity>held(line)+1e-9)return 'The selected load changed. Review the current reserved quantities.';
    }
    if(!parents.length)return null;
    for(var j=0;j<parents.length;j++){
      var parent=parents[j],parts=c.lines.filter(function(l){return l.parent_order_item_id===parent.id;}),counts=parts.map(function(l){var r=rows.find(function(r){return r.order_item_id===l.id;});return {ratio:l.quantity/parent.quantity,qty:r?r.quantity:0};});
      if(!counts.some(function(x){return x.qty>0;}))continue;
      if(counts.some(function(x){return !Number.isFinite(x.ratio)||x.ratio<=0;}))return 'The CKD component list changed. Refresh the order before releasing.';
      var kits=Math.min.apply(null,counts.map(function(x){return Math.floor((x.qty+1e-9)/x.ratio);}));
      if(!kits||counts.some(function(x){return Math.abs(x.qty-kits*x.ratio)>1e-9;}))return 'Choose complete CKD kits with all required components.';
    }
    if(rows.reduce(function(n,l){return n+l.quantity;},0)+1e-9<progress(c).need&&!(c.authorization.state==='valid'&&c.authorization.partial_allowed))return 'Sales must authorize this partial trip first.';
    return null;
  }

  /** Units needed / allocated across the order's stock lines. */
  function progress(c) {
    var need = 0, got = 0;
    c.lines.forEach(function (l) { if (!physical(l)) return; need += Math.max(0,Number(l.quantity)-Number(l.cancelled_qty||0)-Number(l.dispatched_qty||0)); got += held(l); });
    return { need: need, got: got, complete: need > 0 && got >= need };
  }
  /** Why this order can't be released right now (authorization), or null. */
  function authProblem(a) {
    if (!a) return null;
    if (a.state === 'revoked') return 'Authorization revoked' + (a.revoke_reason ? ' — ' + a.revoke_reason : '');
    if (a.state === 'expired') return 'Authorization expired';
    if (a.state === 'used') return 'Authorization already used';
    if(a.handoff_type==='internal'&&a.receiver_active===false)return 'Assigned staff receiver is inactive';
    if (a.state === 'none' && a.required) return 'No release authorization';
    return null;
  }
  /** A supervisor's approved override stands in for the recipient's token. */
  function overrideOk(a) { return !!(a && a.state === 'valid' && a.handoff_type!=='internal' && a.override && a.override.status === 'approved'); }
  function modeOf(c) { if(c.authorization?.handoff_type==='internal')return 'Internal staff handoff';return c.authorization && c.authorization.mode ? MODES[c.authorization.mode] : c.delivery ? 'Delivery' : 'Release'; }

  function withOrder(view, id, fn) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    var hash = location.hash, account = mProductionDrafts.key('release-owner');
    API.get('/release-slips/orders/' + id + '/context').then(function (c) { if (hash === location.hash && account === mProductionDrafts.key('release-owner')) fn(c); }).catch(function (err) {
      if (hash !== location.hash || account !== mProductionDrafts.key('release-owner')) return;
      view.innerHTML = ''; view.appendChild(R.error(err, function () { withOrder(view, id, fn); }));
    });
  }

  /* ── Queue (78:16) ─────────────────────────────────────────────────────── */
  function queue(view, tab) {
    var body = page(view, '78:16', 'Release orders', 'Accept orders, allocate stock, then confirm handoff');
    body.innerHTML = '<div data-recovery></div>' + R.skeleton(3);
    mReleaseActions.cards(body.querySelector('[data-recovery]'));
    mReleaseHandoff.cards(body);
    API.get('/release-slips/queue').then(function (q) {
      if (!body.isConnected) return;
      var rows = q.to_accept.concat(q.releasing);
      var blocked = rows.filter(function (r) { return authProblem(r.authorization) || r.open_reports > 0; });
      var available = rows.filter(function (r) { return blocked.indexOf(r) === -1; });
      var accept = available.filter(function (r) { return !r.warehouse_accepted_at; });
      var allocating = available.filter(function (r) { return r.warehouse_accepted_at && r.qty_released < r.qty_ordered; });
      var ready = available.filter(function (r) { return r.warehouse_accepted_at && r.qty_ordered > 0 && r.qty_released >= r.qty_ordered; });
      tab = ['accept','allocating','ready','blocked','done'].includes(tab) ? tab : ready.length ? 'ready' : accept.length ? 'accept' : allocating.length ? 'allocating' : blocked.length ? 'blocked' : 'ready';
      body.innerHTML =
        '<div data-recovery></div>' + R.hero('Warehouse release work', rows.length + ' order' + (rows.length === 1 ? '' : 's') + ' pending',
          ready.length + ' ready · ' + accept.length + ' to accept · ' + allocating.length + ' allocating · ' + blocked.length + ' blocked') +
        '<label class="rk-card rk-field"><small>Release stage</small><select data-release-stage>'+[['accept','To accept',accept.length],['allocating','Picking',allocating.length],['ready','Ready for handoff',ready.length],['blocked','Needs attention',blocked.length],['done','Completed',q.completed.length]].map(function(x){return '<option value="'+x[0]+'"'+(tab===x[0]?' selected':'')+'>'+x[1]+' · '+x[2]+'</option>';}).join('')+'</select></label>'+
        '<div class="rk-list" data-list></div>' +
        R.actions([{ id: 'rel-open', label: 'Open release order', kind: 'primary' }]);
      function card(r) {
        var a = r.authorization || {};
        var problem = authProblem(a) || (r.open_reports ? r.open_reports + ' open release report' + (r.open_reports === 1 ? '' : 's') : null);
        var what = (a.handoff_type==='internal'?'Internal staff handoff':a.mode ? MODES[a.mode].replace('Customer ', '').replace(/^./, function (c) { return c.toUpperCase(); }) : r.delivery ? 'Delivery' : 'Release') +
          ' · ' + (r.qty_ordered || 0) + ' ' + ((r.summary && r.summary.first_name) || 'item') + (r.summary && r.summary.lines > 1 ? ' +' + (r.summary.lines - 1) : '');
        var meta = problem ? 'Blocked · ' + problem
          : !r.warehouse_accepted_at ? 'New · accept to start'
          : r.delivery ? 'Delivery ' + r.delivery.number + (r.delivery.scheduled_date ? ' · ' + r.delivery.scheduled_date : '')
          : (r.qty_released >= r.qty_ordered ? 'Ready now' : r.qty_released + ' of ' + r.qty_ordered + ' allocated') +
            (a.override && a.override.status === 'requested' ? ' · override requested' : overrideOk(a) ? ' · override approved' : a.state === 'valid' ? a.handoff_type==='internal'?' · assigned staff must sign':' · recipient code required' : '');
        return '<button type="button" class="rk-card rk-unitcard" data-order="' + r.id + '"><b>' + mEsc(r.number) + '</b><span>' + mEsc(what) + '</span>' +
          '<small' + (problem ? ' class="warn"' : '') + '>' + mEsc(meta + ' · Ship from ' + (r.location_name || 'assigned warehouse')) + '</small><i aria-hidden="true">›</i></button>';
      }
      function paint(which) {
        R.queueTab(body, which);
        var host = body.querySelector('[data-list]');
        if (which === 'done') {
          host.innerHTML = q.completed.length ? q.completed.map(function (s) {
            return '<button type="button" class="rk-card rk-unitcard" data-slip="' + s.id + '" data-order="' + s.order_id + '"><b>' + mEsc(s.order_number) + '</b>' +
              '<span>' + mEsc((s.handoff_type==='internal'?'Internal staff handoff':s.mode ? MODES[s.mode] : 'Released') + ' · ' + (s.customer_name || '')) + '</span><small>' + mEsc(s.number + ' · ' + time(s.released_at)) + '</small><i aria-hidden="true">›</i></button>';
          }).join('') : '<div class="rk-empty">Nothing released by you today.</div>';
          Array.prototype.forEach.call(host.querySelectorAll('[data-slip]'), function (b) { b.onclick = function () { go({ id: b.dataset.order, step: 'receipt', slip:b.dataset.slip }); }; });
          return;
        }
        var list = which === 'blocked' ? blocked : which === 'accept' ? accept : which === 'allocating' ? allocating : ready;
        host.innerHTML = list.length ? list.map(card).join('') : '<div class="rk-empty">' + (which === 'blocked' ? 'No blocked releases.' : which === 'accept' ? 'No orders waiting for warehouse acceptance.' : which === 'allocating' ? 'No orders waiting for allocation.' : 'No orders ready for handoff. Check To accept or Allocating for earlier work.') + '</div>';
        Array.prototype.forEach.call(host.querySelectorAll('[data-order]'), function (b) { b.onclick = function () { go({ id: b.dataset.order }); }; });
      }
      body.querySelector('[data-release-stage]').onchange=function(){paint(this.value);};
      paint(tab);
      mReleaseActions.cards(body.querySelector('[data-recovery]'));
    mReleaseHandoff.cards(body);
      body.querySelector('#rel-open').onclick = function () {
        var find = function (code) {
          var t = String(code || '').trim().toLowerCase();
          var hit = rows.filter(function (r) { return String(r.number).toLowerCase() === t; })[0];
          if (hit) go({ id: hit.id }); else mToast('No releasable order ' + code, 'err');
        };
        if (window.mScanner) mScanner.open({ title: 'Scan the release order number', onResult: find });
        else if (ready[0]) go({ id: ready[0].id });
      };
    }).catch(function (err) { if (!body.isConnected) return; body.innerHTML = '<div data-recovery></div>' + R.note('warn','Release queue unavailable — count unknown.'); mReleaseActions.cards(body.querySelector('[data-recovery]'));
    mReleaseHandoff.cards(body); body.appendChild(R.error(err, function () { queue(view, tab); })); });
  }

  /* ── Verify release authority (78:68) ──────────────────────────────────── */
  // Shared warehouse presentation; operational handlers continue to own every write.
  function releaseLayout(body) {
    body.closest('.rk-page').classList.add('m-so-release');
    var actions = body.querySelector('.m-so-actions');
    window.mQuickOrbit?.setAvoidance?.(actions);
    window.mReadScope?.create(body, function () { window.mQuickOrbit?.setAvoidance?.(null); window.mQuickOrbit?.focusTask?.(null); });
  }
  function releaseDisclosure(label, content, extra) {
    return '<details class="m-so-disclosure"' + (extra || '') + '><summary>' + mEsc(label) + '<span aria-hidden="true">›</span></summary><div>' + content + '</div></details>';
  }
  function releaseOrder(c, status, tone) {
    return '<section class="m-so-order" aria-label="Sales order"><div class="m-so-order-top"><b>' + mEsc(c.order.number) + '</b><span class="m-so-status ' + (tone || '') + '">' + mEsc(status) + '</span></div>' +
      '<h2>' + mEsc(c.order.customer_name || 'Sales order') + '</h2><div class="m-so-order-meta"><span>' + mEsc(modeOf(c)) + '</span><span>From ' + mEsc(c.order.location_name || 'Warehouse #' + c.order.location_id) + '</span></div></section>';
  }
  function authority(view, c) {
    var a = c.authorization, problem = authProblem(a);
    if (!problem && c.order.warehouse_accepted_at) return scan(view, c);
    var body = page(view, '78:68', 'Review release', '');
    var status = a.state === 'valid' ? 'Authorized' : a.state === 'none' ? (a.required ? 'Needs authorization' : 'Authorization not required') : a.state.charAt(0).toUpperCase() + a.state.slice(1);
    var action = c.order.warehouse_accepted_at ? 'Start picking' : 'Accept & start picking';
    body.innerHTML = releaseOrder(c, status, problem ? a.state === 'none' ? 'pending' : 'attention' : a.state === 'valid' ? 'confirmed' : '') +
      '<p class="m-so-intro">Check the order and recipient.</p>' +
      (problem ? '<div class="m-so-notice ' + (a.state === 'none' ? 'pending' : 'attention') + '" role="status"><b>' + mEsc(problem) + '</b><p>Sales must issue a valid authorization before this release can continue. Nothing has moved.</p></div>' : '') +
      (c.reports.length ? '<div class="m-so-notice pending" role="status"><b>' + c.reports.length + ' open release report' + (c.reports.length === 1 ? '' : 's') + '</b><p>' + mEsc(c.reports[0].description) + '</p></div>' : '') +
      '<section class="m-so-card" aria-labelledby="rel-details-title"><h2 id="rel-details-title">Release details</h2><dl class="m-so-details">' +
      (a.state !== 'none' ? '<div><dt>Approved recipient</dt><dd>' + mEsc(a.recipient_name) + (a.id_reference ? '<small>ID reference ' + mEsc(a.id_reference) + '</small>' : '') + '</dd></div>' +
        '<div><dt>'+(a.handoff_type==='internal'?'Acknowledgment':'Release token')+'</dt><dd>' + mEsc(a.handoff_type==='internal'?'Assigned staff receiver must sign':a.token_hint) + '<small>Valid until ' + mEsc(clock(a.valid_until)) + '</small></dd></div>' :
        '<div><dt>Authorization</dt><dd>' + (a.required ? 'Not issued yet' : 'Not required by company policy') + '<small>' + (a.required ? 'Ask Sales to issue the release authorization.' : 'Record the recipient at handoff.') + '</small></dd></div>') +
      '</dl></section>' +
      '<div class="m-so-actions">' + R.actions(problem ? [{ id: 'rel-report', label: 'Report authorization issue', kind: 'primary' }, { id: 'rel-back', label: 'Back to release queue', kind: 'secondary' }]
        : [{ id: 'rel-go', label: action, kind: 'primary' }, { id: 'rel-report', label: 'Report an issue', kind: 'secondary' }]) + '</div>' +
      releaseDisclosure('Privacy & release rules', '<p>Contact numbers and unrelated personal data stay private. The release token remains masked.</p><p>Starting preparation does not deduct stock. Warehouse-out keeps its separate recipient, package and confirmation checks.</p>');
    body.querySelector('#rel-report').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'authorization' }); };
    var back = body.querySelector('#rel-back'); if (back) back.onclick = function () { go({ tab: 'blocked' }); };
    var btn = body.querySelector('#rel-go');
    if (btn) btn.onclick = function () {
      if (c.order.warehouse_accepted_at) { go({ id: c.order.id, step: 'scan' }); return; }
      if (offline()) { mToast('You’re offline — accepting the order needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Accepting…';
      mReleaseActions.start(c, 'accept', '/orders/' + c.order.id + '/accept-release', {}, 'Accept warehouse release order').catch(fail(btn, action));
    };
    releaseLayout(body);
  }

  // The selected stock stays in this workspace. Scan evidence is ephemeral: it
  // never enters a URL, draft or API payload and cannot survive a refreshed context.
  function allocationPage(view,title,sub) {
    if (!view.dataset.releaseInline) return page(view,'78:147',title,sub);
    view.hidden=false;
    window.mQuickOrbit?.focusTask?.(view);
    view.innerHTML='<div class="m-so-allocation"><h2 tabindex="-1">'+mEsc(title)+'</h2><p class="m-so-inline-note">'+mEsc(sub)+'</p><div data-allocation-body></div></div>';
    view.scrollIntoView({block:'nearest',behavior:'instant'});
    view.querySelector('h2').focus({preventScroll:true});
    requestAnimationFrame(function(){if(view.isConnected&&!view.hidden){view.scrollIntoView({block:'start',behavior:'instant'});window.mQuickOrbit?.setAvoidance?.(view.querySelector('.rk-actions'));}});
    return view.querySelector('[data-allocation-body]');
  }
  function closeAllocation(view,c) {
    if(!view.dataset.releaseInline){go({id:c.order.id,step:'scan'});return;}
    if(view._contextStale){go({id:c.order.id,step:'scan',t:Date.now()});return;}
    window.mQuickOrbit?.focusTask?.(null);window.mQuickOrbit?.setAvoidance?.(view.closest('.rk-body')?.querySelector('.m-so-actions'));view.hidden=true;view.replaceChildren();view._generation=(view._generation||0)+1;
    view.closest('.rk-body').querySelector('.m-so-scan')?.focus({preventScroll:true});
  }
  function scanContext(c) { return JSON.stringify([c.order.id,c.order.location_id,c.order.warehouse_accepted_at,c.authorization, c.lines.map(function(l){return [l.id,l.item_id,l.fulfillment_mode,l.parent_order_item_id,l.quantity,l.cancelled_qty,l.dispatched_qty,l.held_qty,l.released_qty];})]); }
  function evidenceCurrent(view,c,e) { return !!e && view.isConnected && e.context===c && !e.revoked && e.signature===scanContext(c) && e.owner===mProductionDrafts.key('release-owner') && e.hash===location.hash; }
  function evidenceOptions(view,c,e) {
    return {initial:evidenceCurrent(view,c,e)&&Date.now()-e.capturedAt<300000?e:null,maxAge:300000,isCurrent:function(){return view.isConnected&&(!e||evidenceCurrent(view,c,e));},reason:function(){return e?.source==='camera'?(Date.now()-e.capturedAt>=300000?'Earlier scan expired. Scan the attached label again.':'This code finds the product. Scan this specific unit or batch label to verify it.'):'Code entered manually. Scan the attached physical label before allocating.';}};
  }
  function required(l) { return Math.max(0,Number(l.quantity)-Number(l.cancelled_qty||0)-Number(l.dispatched_qty||0)); }
  function kitProgress(c,parent) {
    var parts=c.lines.filter(function(l){return l.parent_order_item_id===parent.id;}),valid=parent.quantity>0&&parts.length>0&&parts.every(function(l){return l.quantity>0;});
    return {parts:parts,need:required(parent),got:valid?Math.min(required(parent),Math.min.apply(null,parts.map(function(l){return Math.floor((held(l)+1e-9)/(l.quantity/parent.quantity));}))):0};
  }
  function paged(body,rows,renderRow,label,bind) {
    var limit=12,index=0;
    body.innerHTML='<label class="m-so-search">Find '+mEsc(label)+'<input class="rk-input" type="search" placeholder="Name, SKU or line number"></label><p class="m-so-inline-note" role="status" data-page-count></p><div data-page-rows></div><div class="rk-actions"><button type="button" class="rk-btn secondary" data-prev>Previous</button><button type="button" class="rk-btn secondary" data-next>Next</button></div>';
    function paint(){var q=body.querySelector('input').value.trim().toLowerCase(),filtered=rows.filter(function(l){return !q||(l.name+' '+(l.sku||'')+' '+l.id).toLowerCase().includes(q);});index=Math.min(index,Math.max(0,Math.ceil(filtered.length/limit)-1));body.querySelector('[data-page-count]').textContent=filtered.length?'Showing '+(index*limit+1)+'–'+Math.min(filtered.length,(index+1)*limit)+' of '+filtered.length:'No matching '+label;body.querySelector('[data-page-rows]').innerHTML=filtered.slice(index*limit,(index+1)*limit).map(renderRow).join('');body.querySelector('[data-prev]').disabled=index===0;body.querySelector('[data-next]').disabled=(index+1)*limit>=filtered.length;if(bind)bind();}
    body.querySelector('input').oninput=function(){index=0;paint();};body.querySelector('[data-prev]').onclick=function(){index--;paint();};body.querySelector('[data-next]').onclick=function(){index++;paint();};paint();
  }
  function scan(view, c) {
    var p=progress(c),lines=c.lines.filter(physical),parents=c.lines.filter(function(l){return l.fulfillment_mode==='ckd';}),top=c.lines.filter(function(l){return l.fulfillment_mode==='ckd'||physical(l)&&!l.parent_order_item_id;});
    var body=page(view,'78:109','Prepare items','');
    var ready=top.filter(function(l){var k=l.fulfillment_mode==='ckd'?kitProgress(c,l):null;return k?k.got>=k.need:held(l)>=required(l);}).length;
    var shared=lines.some(function(l,i){return lines.some(function(x,j){return i!==j&&l.item_id===x.item_id&&(l.fulfillment_mode==='semi_built')===(x.fulfillment_mode==='semi_built');});});
    function stockCard(l){var u=l.unit?' '+mEsc(l.unit):'',n=required(l),h=held(l),free=lineFree(c,l),short=free<n-h;
      return '<article class="m-so-stock-line'+(short?' has-shortage':'')+'" data-release-line="'+l.id+'"><div class="m-so-item-heading"><h3>'+mEsc(l.name)+'</h3>'+(h>=n?'<span class="m-so-status confirmed">Allocated</span>':'')+'</div><p class="m-so-item-meta">'+mEsc(l.sku||'')+' · Line #'+l.id+' · '+mEsc(buildTag(l.fulfillment_mode))+'</p><div class="m-so-item-progress"><p><strong>'+h+'<span> / '+n+u+'</span></strong><small>allocated</small></p><span class="m-so-available">'+(l.serialized?'Verify each serial':'Up to <b>'+free+u+'</b> available')+'</span></div>'+(short?'<p class="m-so-shortage">'+(n-h)+u+' still needed; '+free+u+' available.</p>':'')+(h<n?'<button type="button" class="rk-btn secondary m-ux-action" data-line="'+l.id+'" data-bulk="'+l.item_id+'">Scan label</button>':'')+'</article>';
    }
    function kitCard(parent){var k=kitProgress(c,parent),missing=k.parts.filter(function(l){return held(l)<required(l);}),short=k.parts.filter(function(l){return lineFree(c,l)<required(l)-held(l);});
      return '<section class="m-so-kit" data-kit="'+parent.id+'"><div class="m-so-item-heading"><h2>'+mEsc(parent.name)+'</h2><span class="m-so-status '+(k.got>=k.need?'confirmed':'')+'">CKD kit</span></div><p class="m-so-item-meta">Kit line #'+parent.id+' · '+k.parts.length+' component lines</p><div class="m-so-item-progress"><p><strong>'+k.got+'<span> / '+k.need+' kits</span></strong><small>fully allocated</small></p></div>'+(short.length?'<p class="m-so-shortage">'+short.length+' component line'+(short.length===1?'':'s')+' short. Complete kits cannot be allocated yet.</p>':'<p class="m-so-inline-note">'+missing.length+' component lines still need allocation.</p>')+(c.kit_manifest_proposal?'<button type="button" class="rk-btn secondary" data-kit-scan="'+parent.id+'">Scan prepared kit</button><p class="m-so-inline-note">Prepared-kit labels · simulated proposal</p>':'<p class="m-so-inline-note">No verified prepared-kit label record is available. Prepare loose components below.</p>')+releaseDisclosure('Prepare loose components · '+k.parts.length,'<div data-components="'+parent.id+'"></div>')+'</section>';
    }
    body.innerHTML=releaseOrder(c,c.authorization.state==='valid'?'Authorized':'Authorization not required','confirmed')+'<p class="m-so-recipient">'+mEsc(c.authorization.recipient_name?'For '+c.authorization.recipient_name:'Record recipient at handoff')+'</p>'+releaseDisclosure('Recipient & release details','<dl class="m-so-details"><div><dt>Approved recipient</dt><dd>'+mEsc(c.authorization.recipient_name||'Record at handoff')+'</dd></div><div><dt>'+(c.authorization.handoff_type==='internal'?'Acknowledgment':'Release token')+'</dt><dd>'+mEsc(c.authorization.handoff_type==='internal'?'Assigned staff receiver must sign':c.authorization.token_hint||'Not required')+'<small>'+mEsc(c.authorization.valid_until?'Valid until '+clock(c.authorization.valid_until):'')+'</small></dd></div></dl><p>Allocation holds stock. Recipient and package checks still apply at handoff.</p>')+
      (c.reports.length?'<div class="m-so-notice pending" role="status"><b>'+c.reports.length+' open release reports</b><p>'+mEsc(c.reports[0].description)+'</p></div>':'')+
      (st(c.order.id).scanNotice?'<p class="m-so-scan-notice" data-scan-result role="status">'+mEsc(st(c.order.id).scanNotice)+'</p>':'')+'<section class="m-so-picking-head" aria-label="Order picking progress"><p><strong>'+ready+' / '+top.length+'</strong> sale lines ready'+(parents.length?' · CKD counted as kits':'')+'</p><progress max="'+Math.max(1,top.length)+'" value="'+ready+'" aria-label="Sale lines fully allocated"></progress></section><button type="button" class="rk-identify rk-btn '+(p.complete?'secondary':'primary')+' m-so-scan m-ux-action"><img src="/mobile/icons/v2/scan.svg" alt=""><span><b>'+ (c.kit_manifest_proposal?'Scan stock or kit label':'Scan stock label') +'</b><small>Scan once, check quantity, allocate</small></span></button><div data-release-inline="true" hidden></div>'+
      (shared?'<p class="m-so-inline-note">Shared parts draw from one stock pool. Each kit keeps its own allocation.</p>':'')+'<div class="m-so-lines">'+top.map(function(l){return l.fulfillment_mode==='ckd'?kitCard(l):stockCard(l);}).join('')+'</div>'+
      (c.units.length?releaseDisclosure('Allocated serials · '+c.units.length,c.units.map(function(u){return R.field('Line #'+u.order_item_id,u.identifier+' · '+u.status);}).join('')):'')+
      ((c.batch_allocations||[]).length?releaseDisclosure('Allocated batches',c.batch_allocations.map(function(a){return R.field(a.batch_number+' · Line #'+a.order_item_id,a.quantity+' allocated');}).join('')):'')+
      '<div class="m-so-actions">'+R.actions([{id:'rel-go',label:p.complete?'Continue to package check':'Review missing items',kind:p.complete?'primary':'secondary'}])+'<p class="m-so-inline-note">Allocation holds stock. The release slip records warehouse-out.</p></div>'+
      releaseDisclosure('Other picking options',R.actions([{id:'rel-man',label:'Enter a stock code',kind:'secondary'},{id:'rel-load',label:'Choose vehicle load',kind:'secondary'},{id:'rel-correct',label:'Correct held allocation',kind:'secondary'},{id:'rel-report',label:'Report an issue',kind:'secondary'}])+'<label class="m-so-manual" data-manual hidden><span>Stock code</span><span><input class="rk-input" data-code placeholder="Item, batch or serial code"><button type="button" class="rk-btn secondary m-ux-action" data-find>Check code</button></span></label>')+
      releaseDisclosure('Stock by location & commitments','<div data-stock-context></div>');
    var slot=body.querySelector('[data-release-inline]');slot.dataset.releaseInline='true';
    function check(code,metadata,line){if(!slot.isConnected)return;delete st(c.order.id).scanNotice;body.querySelector('[data-scan-result]')?.remove();code=String(code||'').trim();if(!code){mToast('Enter or scan a stock code','err');return;}var evidence={code:code,source:metadata?.source||'manual',parent:metadata?.parent,capturedAt:metadata?.capturedAt||Date.now(),context:c,signature:scanContext(c),owner:mProductionDrafts.key('release-owner'),hash:location.hash};
      if(c.kit_manifest_proposal&&window.mPreparedKitReview?.open({slot:slot,context:c,code:code,evidence:evidence,current:function(){return evidenceCurrent(slot,c,evidence);},page:allocationPage,close:function(){closeAllocation(slot,c);}}))return;
      unit(slot,c,code,line,evidence);
    }
    body.querySelector('.m-so-scan').onclick=function(){mScanner.open({title:'Scan the attached stock or prepared-kit label',allowManual:false,onResult:check});};
    body.addEventListener('click',function(e){var b=e.target.closest('[data-bulk],[data-kit-scan]');if(!b)return;var selected=b.dataset.line;mScanner.open({title:b.hasAttribute('data-kit-scan')?'Scan this prepared kit label':'Scan the attached stock label',allowManual:false,onResult:function(code,meta){if(b.dataset.kitScan&&window.mPreparedKitReview)meta=Object.assign({},meta,{parent:Number(b.dataset.kitScan)});check(code,meta,selected);}});});
    body.querySelectorAll('[data-components]').forEach(function(host){host.closest('details').addEventListener('toggle',function(){if(this.open&&!host.children.length){var parent=Number(host.dataset.components);paged(host,lines.filter(function(l){return l.parent_order_item_id===parent;}),stockCard,'components');}});});
    var context=body.querySelector('[data-stock-context]');context.closest('details').addEventListener('toggle',function(){if(this.open&&!context.children.length)paged(context,lines,function(l){var a=(c.availability||[]).find(function(a){return a.order_item_id===l.id;});return '<section class="m-so-stock-detail"><h3>'+mEsc(l.name)+' · Line #'+l.id+'</h3><p>On hand here: '+mEsc(a?.on_hand??'Unavailable')+' '+mEsc(l.unit||'')+' · Other sales / holds: '+mEsc(a?.committed_elsewhere??'Unavailable')+' · Elsewhere: '+mEsc(a?.elsewhere_on_hand??'Unavailable')+'</p></section>';},'stock lines');});
    body.querySelector('#rel-man').onclick=function(){var m=body.querySelector('[data-manual]');m.hidden=false;m.querySelector('input').focus();};body.querySelector('[data-find]').onclick=function(){check(body.querySelector('[data-code]').value);};body.querySelector('[data-code]').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();check(this.value);}};
    body.querySelector('#rel-correct').onclick=function(){go({id:c.order.id,step:'correct'});};body.querySelector('#rel-load').onclick=function(){go({id:c.order.id,step:'trip'});};body.querySelector('#rel-report').onclick=function(){go({id:c.order.id,step:'report'});};
    body.querySelector('#rel-go').onclick=function(){if(p.complete){go({id:c.order.id,step:'package'});return;}var missing=body.querySelector('.has-shortage,.m-so-kit,.m-so-stock-line');if(missing){missing.scrollIntoView({block:'start',behavior:'instant'});missing.tabIndex=-1;missing.focus({preventScroll:true});}};
    releaseLayout(body);
  }

  function bulkLabel(view,c,stock,isBatch,line,evidence) {
    var itemId=isBatch?stock.product_item_id:stock.id;
    if(!line){blockedView(view,c,'',{state:'wrong_product'});return;}
    var available=Math.max(0,Math.min(stock.available,lineFree(c,line),remaining(line)));
    var balance=isBatch?(stock.balances||[]).find(function(b){return b.location_id===c.order.location_id;}):null;
    var body=allocationPage(view,'Allocate '+(isBatch?'batch':'stock'),'Check the quantity for this exact sale line. Allocation holds stock; it does not record warehouse-out.');
    body.innerHTML='<div class="m-so-item-heading"><h3>'+mEsc(isBatch?stock.product_name:stock.name)+'</h3><span class="m-so-status" data-label-state>Check label</span></div><p class="m-so-item-meta">'+mEsc(isBatch?stock.number:stock.code)+' · Line #'+line.id+' · '+mEsc(buildTag(line.fulfillment_mode))+'</p><p class="m-so-inline-note">'+mEsc(c.order.number)+' · '+mEsc(c.order.location_name||'Warehouse #'+c.order.location_id)+' · '+held(line)+' / '+required(line)+' '+mEsc(line.unit||'')+' allocated</p><label class="m-so-qty">Allocate quantity <span><input class="rk-input" data-label-qty type="number" min="0" step="any" max="'+available+'" value="'+available+'" inputmode="decimal"><small>'+mEsc(line.unit||'')+'</small></span></label><p class="m-so-inline-note" data-current-limit>Up to '+available+' '+mEsc(line.unit||'')+' available for this line.</p>'+(isBatch?'<dl class="m-so-details m-so-batch-balance"><div><dt>Batch available here</dt><dd data-batch-free>'+mEsc(balance?.available??available)+' '+mEsc(line.unit||'')+'</dd></div><div><dt>Still needed on this line</dt><dd data-batch-needed>'+remaining(line)+' '+mEsc(line.unit||'')+'</dd></div></dl>':'')+'<div data-label-verification></div><p id="rel-allocation-error" class="m-ux-inline-error" role="alert" hidden></p>'+R.actions([{id:'rel-label-ok',label:'Allocate to sales order',kind:'primary'},{id:'rel-label-back',label:'Cancel',kind:'secondary'}]);
    var btn=body.querySelector('#rel-label-ok'),input=body.querySelector('[data-label-qty]'),error=body.querySelector('#rel-allocation-error'),busy=false,gate;
    function reason(){if(!can('orders.release'))return 'Your account cannot allocate sales stock. Ask an authorized warehouse clerk.';if(authProblem(c.authorization))return authProblem(c.authorization)+'. Ask Sales to renew it.';if(!c.order.warehouse_accepted_at)return 'Accept this warehouse order before allocating.';if(view._contextStale)return 'This order changed while you were counting. Cancel and review current picking before another allocation.';if(!gate?.complete())return 'Scan the matching attached stock label to verify this item. Manual entry or an expired scan cannot verify it.';if(available<=0)return 'No free stock remains for this line. Review its stock availability.';var q=Number(input.value);if(!Number.isFinite(q)||q<=0||q>available)return 'Enter a quantity above zero and no greater than '+available+' '+(line.unit||'')+'.';if(offline())return 'Reconnect before allocating. Your quantity has not been submitted.';return '';}
    function sync(){var why=reason();btn.setAttribute('aria-disabled',String(!!why));body.querySelector('[data-label-state]').textContent=gate?.complete()?'Label verified':'Label needed';if(!why){error.hidden=true;error.textContent='';btn.classList.remove('m-ux-rejected');input.removeAttribute('aria-invalid');}else if(!error.hidden)error.textContent=why;}
    gate=mScanner.verification(body.querySelector('[data-label-verification]'),[isBatch?{code:'VDS:BATCH:'+stock.id,aliases:[stock.number]}:stock.code],function(){queueMicrotask(sync);},evidenceOptions(view,c,evidence));sync();input.oninput=sync;
    body.querySelector('#rel-label-back').onclick=function(){if(!busy)closeAllocation(view,c);};
    btn.onclick=async function(event){
      if(busy)return;gate.refresh();var why=reason();if(why){input.setAttribute('aria-invalid',String(!Number.isFinite(Number(input.value))||Number(input.value)<=0||Number(input.value)>available));mScreenUX.reject(btn,error,why,event);return;}
      busy=true;var qty=Number(input.value),unlock=lockPicking(view),hash=location.hash;
      try{
        if(isBatch){
          btn.textContent='Checking batch…';
          var reads=await Promise.all([API.get('/release-slips/orders/'+c.order.id+'/unit?code='+encodeURIComponent('VDS:BATCH:'+stock.id)),API.get('/release-slips/orders/'+c.order.id+'/context')]);
          if(!body.isConnected||hash!==location.hash)return;
          var current=reads[1],lookup=reads[0],latestLine=current.lines.find(function(l){return l.id===line.id&&l.item_id===itemId;});
          if(scanContext(current)!==scanContext(c)||!latestLine){view._contextStale=true;if(evidence)evidence.revoked=true;throw Error('This order changed while you were counting. Cancel and review current picking before another allocation.');}
          if(!lookup.batch||lookup.batch.id!==stock.id||!['batch_available','batch_unavailable'].includes(lookup.state))throw Error('This batch no longer matches the sale line. Cancel and rescan the correct batch.');
          var latestBalance=(lookup.batch.balances||[]).find(function(b){return b.location_id===current.order.location_id;});
          available=Math.max(0,Math.min(lookup.batch.available,lineFree(current,latestLine),remaining(latestLine)));
          if(!Number.isFinite(available))throw Error('Current batch stock could not be verified. Cancel and check stock again.');
          input.max=String(available);
          body.querySelector('[data-current-limit]').textContent='Up to '+available+' '+(line.unit||'')+' available for this line.';
          body.querySelector('[data-batch-free]').textContent=(latestBalance?.available??available)+' '+(line.unit||'');body.querySelector('[data-batch-needed]').textContent=remaining(latestLine)+' '+(line.unit||'');
          if(qty>available)throw Error('Only '+available+' '+(line.unit||'')+' can now be allocated from this batch. Enter that amount or less; nothing was added.');
        }
        if(!body.isConnected||hash!==location.hash)return;
        var allocation={item_id:itemId,quantity:qty,order_item_id:line.id};if(isBatch)allocation.batch_id=stock.id;
        btn.textContent='Allocating…';
        await mReleaseActions.start(c,'allocate','/orders/'+c.order.id+'/release',{bulk:[allocation]},'Allocate '+qty+' from '+(isBatch?stock.number:stock.code)+' · '+lineText(c,line));
      }catch(err){if(body.isConnected){busy=false;unlock();btn.textContent='Allocate to sales order';sync();mScreenUX.reject(btn,error,err.message||'Could not save the allocation. Review the original attempt.',event);}}
    };

  }

  function lockPicking(view){var root=view.closest('.rk-body')||view,controls=Array.from(root.querySelectorAll('button,input,select')).map(function(el){var disabled=el.disabled;el.disabled=true;return {el:el,disabled:disabled};});return function(){controls.forEach(function(x){if(x.el.isConnected)x.el.disabled=x.disabled;});};}
  function scanFeedback(view,c,title,message,evidence,red){
    var body=allocationPage(view,title,'');
    body.innerHTML='<p id="rel-scan-feedback" class="'+(red?'m-ux-inline-error':'m-so-inline-note')+'" role="'+(red?'alert':'status')+'">'+mEsc(message)+'</p><button type="button" class="rk-btn secondary" data-scan-return>Back to picking</button>';
    body.querySelector('[data-scan-return]').onclick=function(){closeAllocation(view,c);};
    var panel=body.closest('.m-so-allocation')||body;panel.tabIndex=-1;
    if(red)mScreenUX.reject(panel,body.querySelector('#rel-scan-feedback'),message,{detail:evidence?.source==='camera'&&document.documentElement.dataset.inputMethod!=='keyboard'?1:0});
  }
  function addSingleUnit(view,c,u,line,evidence){
    if(view._addingUnit)return;
    var why=offline()?'Reconnect before adding this unit. Nothing has been added.':!can('orders.release')?'Your account cannot allocate this unit. Ask an authorized warehouse clerk.':remaining(line)<1?'This sale line is already complete. Review current picking.':lineFree(c,line)<1?'No free unit remains for this sale line. Review its stock availability.':null;
    if(why){scanFeedback(view,c,'Unit not added',why,evidence,true);return;}
    view._addingUnit=true;
    var body=allocationPage(view,'Adding 1 unit','Checking this unique unit against the exact sale line.');
    body.innerHTML='<p role="status">'+mEsc(u.identifier||'Unit #'+u.id)+' · '+mEsc(c.order.number)+' · Line #'+line.id+'</p>';
    var unlock=lockPicking(view);
    mReleaseActions.start(c,'allocate','/orders/'+c.order.id+'/release',{codes:['VDS:UNIT:'+u.id],order_item_id:line.id},'Add 1 unit '+(u.identifier||'UNIT-'+u.id)+' · '+lineText(c,line),{confirmed:function(){st(c.order.id).scanNotice='Added 1 unit · '+(u.identifier||'UNIT-'+u.id);}}).catch(function(err){view._addingUnit=false;unlock();if(view.isConnected)scanFeedback(view,c,'Unit not added',err.message||'Review the original allocation before retrying.',evidence,true);});
  }

  /* ── Verify allocated unit (78:147) / release blocked (78:365) ─────────── */
  function unit(view, c, code, selected, evidence) {
    delete view._contextStale;view._addingUnit=false;
    view.hidden=false;view.innerHTML = '<div role="status">Checking stock label…</div>';
    var generation=view._generation=(view._generation||0)+1;
    var requestHash=location.hash,requestScope=mProductionDrafts.key('release-owner');
    API.get('/release-slips/orders/' + c.order.id + '/unit?code=' + encodeURIComponent(code)).then(function (r) {
      var hash=location.hash, scope=mProductionDrafts.key('release-owner');
      if(hash!==requestHash||scope!==requestScope||!view.isConnected||view._generation!==generation)return;
      if (['batch_available','bulk_available','line_required'].indexOf(r.state)!==-1) {
        var stock=r.batch||r.stock, isBatch=!!r.batch;
        var choices=c.lines.filter(function(l){return physical(l)&&remaining(l)>0&&(r.matching_lines?r.matching_lines.some(function(m){return Number(m.order_item_id)===Number(l.id);}):l.item_id===(isBatch?stock.product_item_id:stock.id)&&(l.fulfillment_mode==='semi_built')===(stock.build_mode==='semi_built'));});
        chooseLine(view,c,code,choices,selected,function(line){
          var target=stock||{id:line.item_id,name:line.name,code:code,build_mode:line.fulfillment_mode,available:lineFree(c,line)};
          bulkLabel(view,c,target,isBatch,line,evidence);
        },evidence);return;
      }
      if (r.state !== 'allocated' && r.state !== 'available') { blockedView(view, c, code, r, evidence); return; }
      if (location.hash.split('?')[0] !== '#/so' || Number(new URLSearchParams(location.hash.split('?')[1]).get('id')) !== c.order.id) return;
      var u = r.unit, p = progress(c);
      if(r.state==='allocated'){scanFeedback(view,c,'Unit already added','Unit '+(u.identifier||'#'+u.id)+' is already allocated to '+c.order.number+'. This scan did not add another unit.',evidence,false);return;}
      if(u.status==='sold'&&c.outstanding>0){blockedView(view,c,code,{state:'unavailable',unit:u});return;}
      if (!c.lines.some(function (l) { return physical(l) && l.item_id === u.product_item_id; })) { blockedView(view,c,code,{ state: 'wrong_product', error: 'Allocate the CKD component lines, not the assembled parent product.', unit: u }); return; }
      if (!c.lines.some(function (l) { return physical(l) && l.item_id === u.product_item_id && (l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled') === (u.build_mode || 'assembled'); })) { blockedView(view,c,code,{ state: 'wrong_build', unit: u }); return; }
      if (u.location_id != null && c.order.location_id != null && u.location_id !== c.order.location_id) { blockedView(view,c,code,{ state: 'refused', error: 'Unit is at a different warehouse. Transfer it before allocating.', unit: u }); return; }
      var assigned=c.units.find(function(x){return x.id===u.id;});
      var choices=c.lines.filter(function(l){return physical(l)&&l.item_id===u.product_item_id&&(l.fulfillment_mode==='semi_built')===(u.build_mode==='semi_built')&&(r.state==='allocated'?assigned&&assigned.order_item_id?l.id===assigned.order_item_id:true:remaining(l)>0);});
      chooseLine(view,c,code,choices,selected,function(line){
      var identity=['VDS:UNIT:'+u.id,u.identifier||'UNIT-'+u.id];
      if(evidenceCurrent(view,c,evidence)&&evidence.source==='camera'&&Date.now()-evidence.capturedAt<300000&&identity.some(function(code){return code.toLowerCase()===evidence.code.toLowerCase();})){addSingleUnit(view,c,u,line,evidence);return;}
      var body = allocationPage(view, 'Allocate unit', 'Match model, serial and visible condition to this sale line.');
      var idx = c.units.map(function (x) { return x.id; }).indexOf(u.id);
      body.innerHTML =
        R.jobHead({ tone: 'ok', number: u.identifier, pill: { text: r.state === 'allocated' ? 'Allocated' : 'Ready to sell', tone: 'ok' }, name: u.product_name,
          meta: u.location_name || '' }) +
        R.field('Sale line',lineText(c,line)) + R.field('Build state', buildTag(u.build_mode)) + R.field('Ship from', c.order.location_name || 'Warehouse #' + c.order.location_id) + R.field('Stock transaction', u.receipt_number || '—') +
        R.field('This sale line', held(line) + ' / ' + required(line) + ' ' + (line.unit || 'units') + ' allocated') +
        '<div data-label-verification></div><p id="rel-unit-error" class="m-ux-inline-error" role="alert" hidden></p>' + R.note('info', '<h3>Physical check</h3>Confirm model, color, serial label and visible condition before removing the unit.') +
        R.actions([{ id: 'rel-ok', label: 'Add 1 unit', kind: 'primary' }, { id: 'rel-mis', label: 'Mismatch', kind: 'secondary' }]);
      body.querySelector('#rel-mis').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'unit_mismatch', code: code }); };
      var btn = body.querySelector('#rel-ok');
      var busy=false, unitError=body.querySelector('#rel-unit-error');
      var sticker = mScanner.verification(body.querySelector('[data-label-verification]'), [{code:'VDS:UNIT:'+u.id,aliases:[u.identifier || ('UNIT-' + u.id)]}], function (ok) { btn.setAttribute('aria-disabled',String(!ok));if(ok){unitError.hidden=true;btn.classList.remove('m-ux-rejected');queueMicrotask(function(){if(body.isConnected)addSingleUnit(view,c,u,line,{source:'camera'});});} }, evidenceOptions(view,c,evidence));
      btn.onclick = function (event) {
        if (busy) return;
        sticker.refresh();
        if (!sticker.complete()) { mScreenUX.reject(btn,unitError,'Scan this unit’s attached serial label. A general product code or manual entry does not verify this physical unit.',event); return; }
        if (r.state === 'allocated') { go({ id: c.order.id, step: 'scan' }); return; }
        if (offline()) { mToast('You’re offline — allocation needs a connection.', 'err'); return; }
        busy=true;addSingleUnit(view,c,u,line,{source:'camera'});
      };
      },evidence);
    }).catch(function (err) { if(location.hash!==requestHash||requestScope!==mProductionDrafts.key('release-owner')||!view.isConnected||view._generation!==generation)return; view.innerHTML = ''; view.appendChild(R.error(err, function () { unit(view, c, code, selected, evidence); })); });
  }
  function blockedView(view, c, code, r, evidence) {
    if(view.dataset.releaseInline){
      var message=r.state==='other_order'?'Unit '+(r.unit?.identifier||code)+' is allocated to '+(r.unit?.order_number||'another sales order')+'. It cannot be added to '+c.order.number+'. Ask an authorized clerk to resolve the existing allocation.':r.state==='batch_unavailable'?'This batch has no free quantity at the ship-from warehouse. Nothing was added.':r.error||'This label does not match available stock for the selected sale line. No inventory movement occurred.';
      scanFeedback(view,c,r.state==='other_order'?'Unit allocated elsewhere':'Label cannot be allocated',message,evidence,true);return;
    }
    var body = page(view, '78:365', 'Release blocked', 'Resolve the mismatch before warehouse-out');
    var TEXT = {
      other_order: ['Serial is not allocated', 'Allocated to ' + ((r.unit && r.unit.order_number) || 'another order') + ', not this order.'],
      batch_unavailable: ['Batch unavailable', 'No free tracked quantity from this batch is available at this sale’s ship-from location.'],
      batch_label_required: ['Scan the batch sticker', 'This product has batch stock. Scan the specific batch QR, rather than its general product code.'],
      wrong_build: ['Wrong build state', 'This serial is ' + buildTag(r.unit && r.unit.build_mode) + '; select a unit matching the sale line.'],
      wrong_product: ['Wrong product', (r.unit ? r.unit.product_name : 'This unit') + ' is not on ' + c.order.number + '.'],
      not_found: ['Stock label not found', 'No item, batch or unit matches this label.'],
      unavailable: ['Unit not available', 'This unit is ' + (r.unit ? r.unit.status : 'not in stock') + ' — it can’t leave as ready-to-sell stock.'],
      refused: ['Allocation refused', r.error || 'The server refused this unit.'],
    }[r.state] || ['Blocked', ''];
    var expected = c.lines.filter(function (l) { return physical(l) && (l.units || 0) + (l.released_qty || 0) < l.quantity; });
    body.innerHTML =
      '<div class="rk-block"><span class="t">! ' + mEsc(TEXT[0]) + '</span><b class="lg">' + mEsc(code) + '</b><span>' + mEsc(TEXT[1]) + '</span></div>' +
      '<div class="rk-note warn"><h3>No inventory movement occurred</h3>Return the unit to its location. Allocation changes require Sales or authorized management.</div>' +
      R.field('Expected unit', expected.length ? expected.map(function (l) { return l.name + ' (' + (l.quantity - (l.units || 0) - (l.released_qty || 0)) + ' to go)'; }).join(', ') : 'All units allocated') +
      R.actions([{ id: 'rel-again', label: 'Scan correct unit', kind: 'primary' }, { id: 'rel-rep', label: 'Report block', kind: 'secondary' }]);
    body.querySelector('#rel-again').onclick = function () { go({ id: c.order.id, step: 'scan' }); };
    body.querySelector('#rel-rep').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'unit_mismatch', code: code }); };
  }

  /* ── Verify release package (78:188) ───────────────────────────────────── */
  function pkg(view, c) {
    var s = st(c.order.id), packages=tripPackage(c);
    var body = page(view, '78:188', 'Verify release package', 'Confirm everything leaves with the unit');
    var k = function (p) { return p.item_id + '|' + p.label; };
    function paint() {
      var missing = packages.filter(function (p) { return p.required && !s.pkg[k(p)]; });
      body.innerHTML =
        (packages.length ? '<div class="rk-checks">' + packages.map(function (p, i) {
          var on = !!s.pkg[k(p)];
          return '<div class="rk-check-row"><button type="button" role="checkbox" aria-checked="' + on + '" aria-label="' + mEsc(p.label + ' · ' + p.item_name + (p.required ? ' · required' : ' · optional')) + '" data-p="' + i + '"><span class="rk-state ' + (on ? 'pass' : '') + '" aria-hidden="true">' + (on ? '✓' : '○') + '</span>' +
            '<b>' + mEsc(p.label) + (p.required ? ' <span class="req">*</span>' : '') + '</b><small>' + mEsc(p.item_name + (on ? ' · confirmed' : ' · tap to confirm')) + '</small></button></div>';
        }).join('') + '</div>' : R.note('info', 'No package checklist is set for these products. Confirm the unit leaves complete; Sales or production can add a checklist.')) +
        '<label class="rk-card rk-field"><small>Package seal / tag</small><input class="rk-input" data-seal maxlength="80" placeholder="Optional" value="' + mEsc(s.seal || '') + '"></label>' +
        R.note('info', '<h3>Nothing is implied</h3>Every required item is confirmed explicitly before handoff.') +
        R.actions([{ id: 'rel-go', label: 'Continue to handoff', kind: 'primary' }, { id: 'rel-miss', label: 'Report missing', kind: 'secondary' }]);
      Array.prototype.forEach.call(body.querySelectorAll('[data-p]'), function (b) {
        b.onclick = function () { var p = packages[Number(b.dataset.p)]; s.pkg[k(p)] = !s.pkg[k(p)]; s.seal = body.querySelector('[data-seal]').value; persist(c.order.id, s).catch(saveError); paint(); body.querySelector('[data-p="'+b.dataset.p+'"]').focus({preventScroll:true}); };
      });
      body.querySelector('#rel-go').disabled = missing.length > 0;
      body.querySelector('#rel-go').onclick = function () { s.seal = body.querySelector('[data-seal]').value.trim(); persist(c.order.id, s).then(function () { go({ id: c.order.id, step: 'handoff' }); }).catch(saveError); };
      body.querySelector('#rel-miss').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'package_missing' }); };
    }
    paint();
  }

  /* ── Handoff details (78:240) ──────────────────────────────────────────── */
  function handoff(view,c) {
    var s=st(c.order.id),a=c.authorization,hasAuth=a.state==='valid',internal=a.handoff_type==='internal';
    var body=page(view,'78:240','Complete handoff','Verify the receiver and record the physical handoff');
    window.mQuickOrbit?.focusTask?.(body);
    body.innerHTML=releaseOrder(c,'Ready for handoff','confirmed')+
      R.section('Receiver')+
      (hasAuth?R.field(internal?'Assigned staff receiver':'Approved recipient',a.recipient_name+(a.id_reference?' · ID reference '+a.id_reference:''))+
        (internal?R.note('info','The assigned staff receiver must sign below. No release code is required.'):
         overrideOk(a)&&!s.tokenOk?R.note('info','Supervisor code exception approved by '+mEsc(a.override.decided_by_name||'supervisor')+'. Match the approved recipient. The reason stays on the receipt.'):
         s.tokenOk?'<p class="m-hint" role="status" data-code-verified>Release code verified for this order.</p>':
         '<label class="rk-card rk-field"><small>Release code presented by recipient *</small><input class="rk-input" data-token autocomplete="off" maxlength="40" value="'+mEsc(s.token||'')+'"></label><button type="button" class="rk-btn secondary" data-verify>Verify release code</button><button type="button" class="rk-back" data-notoken>Recipient cannot present the code</button><p id="rel-code-error" class="m-ux-inline-error" role="alert" hidden></p>'):
        '<label class="rk-card rk-field"><small>Receiver name *</small><input class="rk-input" data-recipient maxlength="160" value="'+mEsc(s.recipient||'')+'"></label>')+
      (a.mode==='delivery'||!a.mode&&c.delivery?'<label class="rk-card rk-field"><small>Vehicle / plate no.</small><input class="rk-input" data-plate maxlength="40" value="'+mEsc(s.plate||'')+'"></label>':'')+
      '<label class="rk-card rk-field"><small>Handoff area · optional</small><input class="rk-input" data-area maxlength="80" value="'+mEsc(s.area||a.handoff_area||'')+'" placeholder="e.g. Release Bay 1"></label>'+
      '<section class="m-flow-section" data-evidence></section>'+
      '<p id="rel-handoff-error" class="m-ux-inline-error" role="alert" hidden></p>'+
      R.actions([{id:'rel-go',label:'Review warehouse-out',kind:'primary'},{id:'rel-no',label:'Report handoff problem',kind:'secondary'}]);
    var error=body.querySelector('#rel-handoff-error'),button=body.querySelector('#rel-go'),evidence=handoffEvidence(body.querySelector('[data-evidence]'),c,s);
    function keep(){s.area=body.querySelector('[data-area]').value.trim();var rc=body.querySelector('[data-recipient]'),pl=body.querySelector('[data-plate]');if(rc)s.recipient=rc.value.trim();if(pl)s.plate=pl.value.trim();}
    body.querySelectorAll('[data-area],[data-recipient],[data-plate],[data-token]').forEach(function(input){input.oninput=function(){keep();if(input.hasAttribute('data-token'))s.token=input.value.trim().toUpperCase();persist(c.order.id,s).catch(saveError);};});
    var verify=body.querySelector('[data-verify]'),codeError=body.querySelector('#rel-code-error')||error;
    if(verify)verify.onclick=async function(event){
      var token=body.querySelector('[data-token]').value.trim().toUpperCase();
      if(!token){mScreenUX.reject(verify,codeError,'Enter the release code provided by Sales to the approved recipient.',event);return;}
      verify.disabled=true;keep();try{var result=await API.get('/release-slips/orders/'+c.order.id+'/verify-token?token='+encodeURIComponent(token));if(!body.isConnected)return;if(!result.ok){verify.disabled=false;mScreenUX.reject(verify,codeError,result.error+' Ask the recipient to check the Sales message, or request a supervisor exception.',event);return;}s.token=token;s.tokenOk=true;await persist(c.order.id,s);if(body.isConnected)handoff(view,c);}catch(err){if(body.isConnected){verify.disabled=false;mScreenUX.reject(verify,codeError,err.message+' Reconnect and verify the same code.',event);}}
    };
    var noCode=body.querySelector('[data-notoken]');if(noCode)noCode.onclick=function(){keep();persist(c.order.id,s).then(function(){go({id:c.order.id,step:'override'});}).catch(saveError);};
    body.querySelector('#rel-no').onclick=function(){keep();persist(c.order.id,s).then(function(){go({id:c.order.id,step:'report',kind:'identity'});}).catch(saveError);};
    button.onclick=async function(event){try{
      keep();if(hasAuth&&!internal&&!s.tokenOk&&!overrideOk(a))throw Error('Verify the recipient’s release code, or obtain an approved supervisor exception.');
      if(!hasAuth&&!s.recipient)throw Error('Enter the name of the person receiving the goods.');
      await evidence.validate();await persist(c.order.id,s);if(body.isConnected)go({id:c.order.id,step:'confirm'});
    }catch(err){mScreenUX.reject(button,error,err.message,event);}};
  }
  function handoffEvidence(host,c,s) {
    host.innerHTML=R.section('Photo and signed acknowledgment')+
      '<button type="button" class="rk-btn secondary" data-cap>Add handoff photo</button><p class="m-hint">Show the goods and label. Avoid unrelated people or full IDs.</p><div class="rk-thumbs" data-thumbs></div>'+
      '<div class="rk-sign"><small>'+mEsc(c.authorization.handoff_type==='internal'?'Signature · '+c.authorization.recipient_name:'Recipient signature')+'</small><div data-sign></div></div>'+
      '<button type="button" class="rk-btn secondary" data-clear-evidence>Retake photo and signature</button>';
    var sig=window.mSignature?mSignature({onChange:function(){if(!host.isConnected)return;if(sig.isEmpty()){s.sign=null;persist(c.order.id,s).catch(saveError);}else sig.toBlob(function(blob){if(host.isConnected){s.sign=blob;persist(c.order.id,s).catch(saveError);}});}}):null,urls=[];
    if(s.sign)host.querySelector('[data-sign]').appendChild(mEl('<p class="m-hint">Saved receiver signature retained. Draw again to replace it.</p>'));
    if(sig)host.querySelector('[data-sign]').appendChild(sig.el);
    function thumbs(){urls.forEach(function(url){URL.revokeObjectURL(url);});urls=[];host.querySelector('[data-thumbs]').innerHTML=s.photos.map(function(file,i){var url=URL.createObjectURL(file);urls.push(url);return '<span><img alt="Handoff photo '+(i+1)+'" src="'+url+'"><button type="button" data-x="'+i+'" aria-label="Remove handoff photo '+(i+1)+'">×</button></span>';}).join('');host.querySelectorAll('[data-x]').forEach(function(b){b.onclick=function(){s.photos.splice(Number(b.dataset.x),1);persist(c.order.id,s).catch(saveError);thumbs();};});}
    thumbs();host.querySelector('[data-cap]').onclick=async function(){try{var file=await mPhoto.pickFile({isCurrent:function(){return host.isConnected;}});if(!host.isConnected)return;if(s.photos.length>=19)throw Error('Keep at most 19 handoff photos.');s.photos.push(file);await persist(c.order.id,s);if(host.isConnected)thumbs();}catch(err){if(host.isConnected&&!err.cancelled)mToast(err.message,'err');}};
    host.querySelector('[data-clear-evidence]').onclick=function(){s.photos=[];s.sign=null;if(sig)sig.clear();host.querySelector('[data-sign] .m-hint')?.remove();persist(c.order.id,s).catch(saveError);thumbs();};
    return {validate:async function(){if(!s.photos.length)throw Error('Add at least one photo of the goods at handoff.');if(!sig)throw Error('The signature pad is unavailable. Reload this saved handoff before continuing.');if(!sig.isEmpty())s.sign=await new Promise(function(resolve){sig.toBlob(resolve);});if(!s.sign)throw Error('Ask the receiver to sign the acknowledgment.');}};
  }
  /* ── Release without the token: supervisor override (extends 78:240) ────── */
  function override(view, c) {
    var a = c.authorization, ov = a.override, sup = can('orders.override_release');
    var status = ov ? ov.status : null;
    var body = page(view, '78:240', 'Release without token', 'A supervisor approves it, with a reason');
    window.mQuickOrbit?.focusTask?.(body);
    if(a.handoff_type==='internal'){
      body.innerHTML=R.field('Assigned staff receiver',a.recipient_name)+R.note('warn','Internal handoffs require the assigned staff receiver’s signature. A code exception cannot replace that acknowledgment. Ask Sales to correct the assignment if needed.')+R.actions([{id:'rel-internal-back',label:'Back to handoff',kind:'primary'},{id:'rel-internal-report',label:'Report receiver issue',kind:'secondary'}]);
      body.querySelector('#rel-internal-back').onclick=function(){go({id:c.order.id,step:'handoff'});};body.querySelector('#rel-internal-report').onclick=function(){go({id:c.order.id,step:'report',kind:'identity'});};return;
    }
    var reasonBox = function (label, ph) {
      return '<label class="rk-card rk-field"><small>' + mEsc(label) + ' *</small><textarea rows="3" maxlength="500" data-reason placeholder="' + mEsc(ph) + '"></textarea></label>';
    };
    var html = R.field('Approved recipient', a.recipient_name + (a.id_reference ? ' · ID reference ' + a.id_reference : ''));
    var acts;
    if (status === 'approved') {
      html += '<div class="rk-block ok"><span class="t">✓ Override approved</span><b>' + mEsc(ov.decided_by_name || 'Supervisor') + '</b><span>' + mEsc(ov.decision_note || ov.reason) + '</span></div>';
      acts = [{ id: 'rel-cont', label: 'Continue handoff', kind: 'primary' }];
    } else if (status === 'requested' && !sup) {
      html += '<div class="rk-block warn"><span class="t">! Waiting for a supervisor</span><b>' + mEsc(ov.requested_by_name || 'Requested') + '</b><span>' + mEsc(ov.reason) + '</span></div>' +
        R.note('info', 'Supervisors were notified. Keep the goods staged — nothing has moved.');
      acts = [{ id: 'rel-check', label: 'Check again', kind: 'primary' }, { id: 'rel-back', label: 'Back', kind: 'secondary' }];
    } else if (status === 'requested') {
      html += R.field('Requested by ' + (ov.requested_by_name || 'releaser'), ov.reason) + reasonBox('Your reason', 'e.g. ID checked in person against the order');
      acts = [{ id: 'rel-approve', label: 'Approve override', kind: 'primary' }, { id: 'rel-decline', label: 'Decline', kind: 'secondary' }];
    } else {
      if (status === 'declined') html += R.note('warn', '<b>Declined by ' + mEsc(ov.decided_by_name || 'a supervisor') + '</b> — ' + mEsc(ov.decision_note || ''));
      html += reasonBox('Why can’t the token be presented?', 'e.g. Recipient lost the token message');
      acts = sup ? [{ id: 'rel-approve', label: 'Approve override', kind: 'primary' }, { id: 'rel-back', label: 'Back', kind: 'secondary' }]
        : [{ id: 'rel-ask', label: 'Ask a supervisor', kind: 'primary' }, { id: 'rel-back', label: 'Back', kind: 'secondary' }];
    }
    body.innerHTML = html + '<p id="rel-override-error" class="m-ux-inline-error" role="alert" hidden></p>'+R.note('info', '<h3>Only the token is waived</h3>The recipient still has to match the approved name' + (a.id_reference ? ' and masked ID reference' : '') + '. The reason is recorded on the release slip.') + R.actions(acts);
    var on = function (id, fn) { var b = body.querySelector('#' + id); if (b) b.onclick = fn; };
    var reason = function () { var t = body.querySelector('[data-reason]'); return t ? t.value.trim() : ''; };
    var send = function (btn, path, payload, label, then) {
      if (offline()) { mScreenUX.reject(btn,body.querySelector('#rel-override-error'),'Reconnect to request or decide this code exception. Keep the goods staged.'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      API.post('/release-slips/orders/' + c.order.id + path, payload, { idempotencyKey: key() }).then(then).catch(function(err){btn.disabled=false;btn.textContent=label;mScreenUX.reject(btn,body.querySelector('#rel-override-error'),err.message+' Review with Sales or a supervisor before handoff.');});
    };
    on('rel-cont', function () { go({ id: c.order.id, step: 'handoff' }); });
    on('rel-back', function () { go({ id: c.order.id, step: 'handoff' }); });
    on('rel-check', function () { go({ id: c.order.id, step: 'override', t: Date.now() }); });
    on('rel-ask', function (event) {
      if (reason().length < 5) { mScreenUX.reject(this,body.querySelector('#rel-override-error'),'Explain why the recipient cannot present the code (at least 5 characters).',event); return; }
      send(this, '/override-request', { reason: reason() }, 'Ask a supervisor', function () { mToast('Supervisors notified'); go({ id: c.order.id, step: 'override', t: Date.now() }); });
    });
    on('rel-approve', function (event) {
      if (reason().length < 5) { mScreenUX.reject(this,body.querySelector('#rel-override-error'),'Record the reason for this supervisor exception (at least 5 characters).',event); return; }
      send(this, '/override', { approve: true, reason: reason() }, 'Approve override', function () { mToast('Override approved'); go({ id: c.order.id, step: 'handoff' }); });
    });
    on('rel-decline', function (event) {
      if (reason().length < 5) { mScreenUX.reject(this,body.querySelector('#rel-override-error'),'Record the reason for declining (at least 5 characters).',event); return; }
      send(this, '/override', { approve: false, reason: reason() }, 'Decline', function () { mToast('Override declined'); go({ id: c.order.id, step: 'override', t: Date.now() }); });
    });
  }

  /* ── Capture handoff proof (78:281) ────────────────────────────────────── */
  function proof(view,c){handoff(view,c);}
  function review(view,c){confirm(view,c,!!st(c.order.id).partial);}

  function reviewLoad(host,c,rows){
    function line(row){return c.lines.find(function(l){return l.id===row.order_item_id;});}
    function display(row){var l=line(row);return {name:'Line #'+l.id+' · '+l.name,qty:row.quantity+' '+(l.unit||'pcs'),detail:buildTag(l.fulfillment_mode),ok:true};}
    host.innerHTML=R.lines(rows.filter(function(row){return !line(row)?.parent_order_item_id;}).map(display));
    c.lines.filter(function(l){return l.fulfillment_mode==='ckd';}).forEach(function(parent){var selected=rows.filter(function(row){return line(row)?.parent_order_item_id===parent.id;});if(!selected.length)return;var first=selected[0],kits=Math.round(first.quantity/(line(first).quantity/parent.quantity)),details=mEl('<details class="rk-card"><summary>'+mEsc(parent.name)+' · '+kits+(kits===1?' complete kit':' complete kits')+'<small>'+selected.length+' component lines · view quantities</small></summary><div data-parts></div></details>'),shown=0;
      function more(){var batch=selected.slice(shown,shown+12);shown+=batch.length;details.querySelector('[data-parts]').insertAdjacentHTML('beforeend',R.lines(batch.map(display)));details.querySelector('button')?.remove();if(shown<selected.length){var button=mEl('<button type="button" class="rk-btn secondary">Show next 12 component lines</button>');button.onclick=more;details.appendChild(button);}}
      details.ontoggle=function(){if(details.open&&!shown)more();};host.appendChild(details);
    });
  }

  /* ── Confirm physical release (78:401) — online-only, idempotent ───────── */
  function confirm(view, c, partial) {
    var s = st(c.order.id), a = c.authorization;
    if (!s.photos.length || !s.sign || (a.state === 'valid' && a.handoff_type!=='internal' && !s.tokenOk && !overrideOk(a))) { go({ id: c.order.id, step: 'handoff' }); return; }
    var body = page(view, '78:401', 'Review and release', 'Check this trip before confirming warehouse-out');
    var rows=loadLines(c),packageRows=tripPackage(c),missing=packageRows.filter(function(p){return p.required&&!s.pkg[p.item_id+'|'+p.label];});
    body.innerHTML=releaseOrder(c,'Final review','confirmed')+
      R.field(a.handoff_type==='internal'?'Assigned staff receiver':'Receiver',a.state==='valid'?a.recipient_name:s.recipient)+
      R.field('Authorization',a.handoff_type==='internal'?'Assigned staff · signed acknowledgment':s.tokenOk?'Recipient code verified':overrideOk(a)?'Supervisor code exception approved':'Not required by company policy')+
      R.section('Leaving on this trip')+'<div data-review-load></div>'+
      R.field('Package and evidence',packageRows.filter(function(p){return s.pkg[p.item_id+'|'+p.label];}).length+' package checks · '+s.photos.length+' handoff photo'+(s.photos.length===1?'':'s')+' · receiver signature saved')+
      (s.partial||partial?R.note('warn','This is a partial trip. Unloaded goods stay on this sales order for another trip.'):'')+
      (missing.length?R.note('warn','Package checks changed. Return to the package checklist before release.'):'')+
      R.check('rel-ok', 'Physical handoff is complete') +
      R.note('info', '<h3>This records warehouse-out</h3>Stock quantity, unit stage, release order and audit history update together.') +
      R.actions([{ id: 'rel-post', label: 'Confirm warehouse-out', kind: 'ink' }, { id: 'rel-cancel', label: 'Cancel', kind: 'secondary' }]);
    reviewLoad(body.querySelector('[data-review-load]'),c,rows);
    body.querySelector('#rel-cancel').onclick = function () { go({ id: c.order.id }); };
    var btn = body.querySelector('#rel-post'), chk = body.querySelector('#rel-ok');
    body.querySelector('#rel-cancel').textContent='Back to handoff';
    body.querySelector('#rel-cancel').onclick=function(){go({id:c.order.id,step:'handoff'});};
    window.mQuickOrbit?.focusTask?.(body);
    if(missing.length){var fix=mEl('<button type="button" class="rk-btn secondary">Review package checklist</button>');fix.onclick=function(){go({id:c.order.id,step:'package'});};body.appendChild(fix);}
    var err=mEl('<p id="rel-confirm-error" class="m-ux-inline-error" role="alert" hidden></p>');btn.parentElement.before(err);
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function (event) {
      if(missing.length){mScreenUX.reject(btn,err,'Complete the required package checks before warehouse-out.',event);return;}
      if (offline()) { mScreenUX.reject(btn,err,'Reconnect before confirming warehouse-out. Your handoff evidence is saved.',event); return; }
      btn.disabled = true; btn.textContent = 'Recording…';
      var payload = {
        previous_slip_id:c.slip?c.slip.id:null,
        lines:s.trip||undefined,
        collected_by: a.state === 'valid' ? a.recipient_name : s.recipient, vehicle_plate: s.plate || null,
        authorization_token: s.tokenOk ? s.token : null,
        handoff_type:a.handoff_type||'external',authorization_id:a.state==='valid'?a.id:undefined,receiver_user_id:a.handoff_type==='internal'?a.receiver_user_id:undefined,
        seal_tag: s.seal || null, handoff_area: s.area || null, acknowledged: !!s.sign,
        package: tripPackage(c).map(function (p) { return { item_id: p.item_id, label: p.label, ok: !!s.pkg[p.item_id + '|' + p.label] }; }),
      };
      mReleaseHandoff.start(c, s, payload).then(function () {
        go({ id: c.order.id, step: 'handoff-recovery' });
      }).catch(fail(btn, 'Confirm warehouse-out'));
    };
  }

  /* ── Release recorded (78:438) ─────────────────────────────────────────── */
  function done(view, c) { receipt(view, c); }
  function receipt(view, c, slipId) {
    if (!c.slip) { go({ id: c.order.id }); return; }
    var body = page(view, '78:438', 'Release receipt', c.order.number);
    body.innerHTML = R.skeleton(2);
    API.get('/release-slips/' + (slipId||c.slip.id)).then(function (sl) {
      body.innerHTML =
        R.field('Release slip', sl.number + ' · ' + clock(sl.released_at)) +
        R.field(sl.handoff_type==='internal'?'Assigned staff receiver':'Collected by', (sl.approved_receiver_name || sl.collected_by || '—') + (sl.vehicle_plate ? ' · ' + sl.vehicle_plate : '')) +
        R.field('Handoff record',sl.handoff_type==='internal'?'Internal staff handoff · '+(sl.signature_attachment_id&&sl.acknowledged?'signed acknowledgment retained':'signature record unavailable'):'External collection'+(sl.override_reason?' · supervisor code exception recorded':''))+
        (sl.override_reason?R.field('Supervisor exception',sl.override_reason+' · '+(sl.override_by_name||'Supervisor')):'')+
        (sl.signature_attachment_id?'<button type="button" class="rk-btn secondary" data-view-signature>View signed acknowledgment</button>':'')+
        R.section('Goods on this slip')+
        (c.slip.backorder_number ? R.field('Backorder', c.slip.backorder_number) : '') +
        R.lines((sl.items || []).map(function (i) { return { name: i.name + (i.unit_identifiers ? ' — ' + i.unit_identifiers : ''), qty: i.quantity + (i.unit ? ' ' + i.unit : ''), ok: true }; })) +
        '<div data-photos></div>' +
        R.note('info',c.outstanding>0?'More goods remain on '+mEsc(c.order.number)+'. Review their held and unallocated quantities before the next trip.':'All non-cancelled stock quantities on this order have a warehouse-out record.')+R.actions([{ id: 'rel-back', label: 'Back to queue', kind: 'secondary' }].concat(c.outstanding>0?[{id:'rel-next-trip',label:'Review remaining order',kind:'primary'}]:[]).concat(can('delivery.manage')?[{id:'rel-plan-delivery',label:'Plan delivery for this slip',kind:'secondary'}]:[]));
      var signature=body.querySelector('[data-view-signature]');if(signature)signature.onclick=function(){mPhoto.view('/attachments/'+sl.signature_attachment_id+'/image');};
      if (mPhoto.thumbs) body.querySelector('[data-photos]').appendChild(mPhoto.thumbs('release', sl.id, { editable: false }));
      body.querySelector('#rel-back').onclick = function () { go({ tab: 'done' }); };var plan=body.querySelector('#rel-plan-delivery');if(plan)plan.onclick=function(){MApp.go('deliveries',{step:'plan',order:c.order.id,slip:sl.id});};if(can('returns.receive')){var ret=document.createElement('button');ret.className='rk-btn secondary';ret.textContent='Receive customer return';ret.onclick=function(){MApp.go('returns',{slip:sl.id});};body.appendChild(ret);}var next=body.querySelector('#rel-next-trip');if(next)next.onclick=function(){delete S[c.order.id];go({id:c.order.id});};
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { receipt(view, c); })); });
  }

  /* ── Incomplete allocation (78:481) ────────────────────────────────────── */
  function incomplete(view,c) {
    var p=progress(c),allowed=c.authorization.state==='valid'&&c.authorization.partial_allowed;
    var body=page(view,'78:481','Partial vehicle load','Keep the remainder reserved on this sales order');
    body.innerHTML=R.field('Ready in warehouse',p.got+' of '+p.need+' outstanding')+
      R.note('info','Goods that do not leave remain held for this customer. Each trip gets its own release slip and delivery record.')+
      R.field('Partial-release authority',allowed?'Approved by Sales':'Sales authorization required')+
      R.actions((allowed&&p.got>0?[{id:'rel-part',label:'Choose this trip’s load',kind:'primary'}]:[{id:'rel-req',label:'Request authorization',kind:'primary'}]).concat([{id:'rel-back',label:'Back to stock review',kind:'secondary'}]));
    var part=body.querySelector('#rel-part');if(part)part.onclick=function(){go({id:c.order.id,step:'trip'});};
    var req=body.querySelector('#rel-req');if(req)req.onclick=function(){go({id:c.order.id,step:'report',kind:'partial_request'});};
    body.querySelector('#rel-back').onclick=function(){go({id:c.order.id,step:'scan'});};
  }
  function correct(view,c){
    var body=page(view,'78:109','Correct held allocation','Already-shipped goods cannot be undone');
    body.innerHTML=R.note('info','Remove only an incorrect warehouse allocation. The customer’s remaining demand stays committed to this sales order.')+
      c.units.filter(function(u){return u.status==='reserved';}).map(function(u){return '<label class="rk-card rk-check-row"><input type="checkbox" data-undo-unit="'+u.id+'">'+mEsc(u.identifier||'Unit #'+u.id)+' · line #'+u.order_item_id+'</label>';}).join('')+
      c.lines.filter(physical).map(function(l){var lots=(c.batch_allocations||[]).filter(function(a){return a.order_item_id===l.id&&a.state==='reserved';});var lotFields=lots.map(function(a){return '<label class="rk-card rk-field"><small>'+mEsc(a.batch_number)+' · line #'+l.id+' · '+a.quantity+' held</small><input class="rk-input" type="number" min="0" max="'+a.quantity+'" step="any" value="0" data-undo-line="'+l.id+'" data-allocation="'+a.id+'"></label>';}).join('');var bulk=Math.max(0,Number(l.released_qty||0)-Number(l.dispatched_bulk_qty||0)-lots.reduce(function(n,a){return n+a.quantity;},0));return lotFields+(bulk?'<label class="rk-card rk-field"><small>Line #'+l.id+' · '+mEsc(l.name)+' · '+bulk+' untracked held</small><input class="rk-input" type="number" min="0" max="'+bulk+'" step="any" value="0" data-undo-line="'+l.id+'"></label>':'');}).join('')+
      '<label class="rk-check-row"><input type="checkbox" id="undo-reviewed"> I checked the exact serials, sale lines and quantities.</label>'+R.actions([{id:'undo-save',label:'Remove selected allocation',kind:'primary'},{id:'undo-back',label:'Back to stock review',kind:'secondary'}]);
    body.querySelector('#undo-back').onclick=function(){go({id:c.order.id,step:'scan'});};
    body.querySelector('#undo-save').onclick=function(){try{
      if(!body.querySelector('#undo-reviewed').checked)throw new Error('Review and confirm the correction first.');
      var ids=Array.prototype.map.call(body.querySelectorAll('[data-undo-unit]:checked'),function(e){return Number(e.dataset.undoUnit);}),bulk=[];
      body.querySelectorAll('[data-undo-line]').forEach(function(e){var n=Number(e.value),l=c.lines.find(function(l){return l.id===Number(e.dataset.undoLine);});if(!e.value.trim()||!Number.isFinite(n)||n<0||n>Number(e.max))throw new Error('Use a quantity within the current held amount.');if(n)bulk.push({item_id:l.item_id,order_item_id:l.id,quantity:n,allocation_id:e.dataset.allocation?Number(e.dataset.allocation):undefined,untracked:!e.dataset.allocation});});
      if(!ids.length&&!bulk.length)throw new Error('Select a held allocation to correct.');
      body.querySelector('#undo-save').disabled=true;mReleaseActions.start(c,'unreserve','/orders/'+c.order.id+'/release/unreserve',{unit_ids:ids,bulk:bulk},'Remove reviewed held allocation; shipped goods stay unchanged').catch(function(e){mToast(e.message,'err');body.querySelector('#undo-save').disabled=false;});
    }catch(e){mToast(e.message,'err');}};
  }
  function tripLoad(view,c) {
    var s=st(c.order.id),body=page(view,'78:481','Choose this trip’s load','Select from the stock already held for this order');
    window.mQuickOrbit?.focusTask?.(body);
    var saved=s.trip,previous=c.slip?c.slip.id:null;
    if(s.tripPrevious!==undefined&&s.tripPrevious!==previous){saved=null;s.trip=null;}
    s.tripPrevious=previous;
    body.innerHTML=releaseOrder(c,'Choose load','pending')+'<p class="m-hint">Already shipped is recorded stock-out. Held is still in the warehouse. Only the selected load leaves on this trip.</p>'+R.note('info','Unloaded goods stay reserved and unavailable to other sales. Release complete CKD kits only.')+
      c.lines.filter(physical).map(function(l){
        var choice=saved&&saved.find(function(x){return x.order_item_id===l.id;});
        var units=c.units.filter(function(u){return u.order_item_id===l.id&&(u.status==='reserved'||u.pending_direct);});
        var lots=(c.batch_allocations||[]).filter(function(a){return a.order_item_id===l.id&&a.state==='reserved';});
        var untracked=Math.max(0,held(l)-units.length-lots.reduce(function(n,a){return n+a.quantity;},0));
        return '<section class="rk-card rk-field" data-load-line="'+l.id+'"><b>'+mEsc('Line #'+l.id+' · '+l.name+' · '+buildTag(l.fulfillment_mode))+'</b><small>'+Number(l.dispatched_qty||0)+' '+mEsc(l.unit||'pcs')+' shipped · '+Math.max(0,held(l)-units.filter(function(u){return u.pending_direct;}).length)+' held here'+(units.some(function(u){return u.pending_direct;})?' · direct stock-out awaiting slip':'')+'</small>'+
          units.map(function(u){return '<label class="rk-check-row"><input type="checkbox" data-load-unit="'+u.id+'" '+(u.pending_direct?'checked disabled':!saved||choice&&choice.unit_ids&&choice.unit_ids.indexOf(u.id)!==-1?'checked':'')+'>'+mEsc((u.identifier||'Unit #'+u.id)+(u.pending_direct?' · stock already removed; required on this slip':''))+'</label>';}).join('')+
          lots.map(function(a){var picked=choice&&choice.batches&&choice.batches.find(function(b){return b.allocation_id===a.id;});return '<label><small>This trip · '+mEsc(a.batch_number)+' · up to '+a.quantity+'</small><input class="m-input m-flow-quantity" type="number" min="0" max="'+a.quantity+'" step="any" inputmode="decimal" data-load-batch="'+a.id+'" value="'+(saved?(picked?picked.quantity:0):a.quantity)+'"></label>';}).join('')+
          (untracked>0?'<label><small>This trip · up to '+untracked+'</small><input class="m-input m-flow-quantity" type="number" min="0" max="'+untracked+'" step="any" inputmode="decimal" data-load-bulk value="'+(saved?Math.max(0,(choice?choice.quantity:0)-(choice&&choice.unit_ids?choice.unit_ids.length:0)-(choice&&choice.batches?choice.batches.reduce(function(n,b){return n+b.quantity;},0):0)):untracked)+'"></label>':'')+'<p class="m-hint" data-load-counts aria-live="polite"></p></section>';
      }).join('')+'<p id="rel-trip-error" class="m-ux-inline-error" role="alert" hidden></p>'+R.actions([{id:'trip-continue',label:'Use this load',kind:'primary'},{id:'trip-back',label:'Back to stock review',kind:'secondary'}]);
    function updateLoad(){body.querySelectorAll('[data-load-line]').forEach(function(box){var line=c.lines.find(function(l){return l.id===Number(box.dataset.loadLine);}),picked=box.querySelectorAll('[data-load-unit]:checked').length;box.querySelectorAll('input[type=number]').forEach(function(input){picked+=Number(input.value)||0;});var unit=line.unit||'pcs',left=Math.max(0,line.quantity-(line.cancelled_qty||0)-(line.dispatched_qty||0));box.querySelector('[data-load-counts]').textContent=picked+' '+unit+' selected for this trip · '+Math.max(0,held(line)-picked)+' held for later · '+Math.max(0,left-picked)+' still to ship after this trip';});}
    body.querySelectorAll('[data-load-line] input').forEach(function(input){input.oninput=updateLoad;input.onchange=updateLoad;});updateLoad();
    function collect(){
      var rows=[];
      body.querySelectorAll('[data-load-line]').forEach(function(box){var ids=Array.prototype.map.call(box.querySelectorAll('[data-load-unit]:checked'),function(e){return Number(e.dataset.loadUnit);});var batches=[],qty=ids.length;
        box.querySelectorAll('input[type=number]').forEach(function(e){var n=Number(e.value);if(e.value.trim()===''||!Number.isFinite(n)||n<0||n>Number(e.max))throw new Error('Enter quantities within the reserved load.');qty+=n;if(e.dataset.loadBatch&&n>0)batches.push({allocation_id:Number(e.dataset.loadBatch),quantity:n});});
        if(qty>0)rows.push({order_item_id:Number(box.dataset.loadLine),quantity:qty,unit_ids:ids,batches:batches});
      });
      return rows;
    }
    body.querySelector('#trip-continue').onclick=function(event){try{
      var rows=collect(),total=rows.reduce(function(n,l){return n+l.quantity;},0),p=progress(c);
      if(!total)throw new Error('Choose at least one reserved unit or quantity.');
      if(total+1e-9<p.need&&!(c.authorization.state==='valid'&&c.authorization.partial_allowed))throw new Error('Sales must authorize this partial trip first.');
      var problem=ckdLoadProblem(c,rows);if(problem)throw new Error(problem);
      s.trip=rows;s.partial=total+1e-9<p.need;persist(c.order.id,s).then(function(){go({id:c.order.id,step:'package'});}).catch(saveError);
    }catch(e){mScreenUX.reject(this,body.querySelector('#rel-trip-error'),e.message,event);}};
    body.querySelector('#trip-back').onclick=function(){go({id:c.order.id,step:'scan'});};
  }

  /* ── Report a release problem to Sales ─────────────────────────────────── */
  async function report(view,c,kind,code) {
    var meta={authorization:['Report authorization issue','Sales must review the authorization.'],unit_mismatch:['Report wrong unit','Sales reviews the exact stock identity.'],package_missing:['Report missing item','Sales resolves the shortage before handoff.'],identity:['Cannot verify receiver','Sales confirms the receiver; only an external code can use a supervisor exception.'],partial_request:['Request partial trip','Sales must issue authorization allowing partial trips.']}[kind]||['Report release issue','Sales reviews this order.'];
    var body=page(view,'78:68',meta[0],c.order.number);window.mQuickOrbit?.focusTask?.(body);
    try{
      var saved=await mWorkflow.draft('release-report-'+c.order.id+'-'+(kind||'other'));if(!body.isConnected)return;if(saved.operation.state!=='draft')return mWorkflow.paint(view,saved);
      body.innerHTML=(code?R.field('Scanned unit',code):'')+R.field('Next owner',meta[1])+
        '<label class="rk-card rk-field"><small>What happened? *</small><textarea rows="4" maxlength="1500" data-desc>'+mEsc(saved.batch.description||'')+'</textarea></label>'+
        R.note('warn','Keep the goods staged. Sending a report does not move stock or authorize release.')+
        '<p id="rel-report-error" class="m-ux-inline-error" role="alert" hidden></p>'+R.actions([{id:'rel-send',label:'Send report to Sales',kind:'primary'},{id:'rel-cancel',label:'Back to order',kind:'secondary'}]);
      body.querySelector('[data-desc]').oninput=function(){saved.batch.description=this.value;mWorkflow.save(saved).catch(saveError);};
      body.querySelector('#rel-cancel').onclick=function(){go({id:c.order.id});};
      body.querySelector('#rel-send').onclick=async function(event){if(this.disabled)return;var button=this,error=body.querySelector('#rel-report-error');try{
        var description=body.querySelector('[data-desc]').value.trim();if(!description)throw Error('Describe the problem so Sales can resolve this order.');if(offline())throw Error('Reconnect to send this report. Your description is saved; keep the goods staged.');
        button.disabled=true;saved.batch.description=description;await mWorkflow.save(saved);await mWorkflow.start(saved,{path:'/release-slips/orders/'+c.order.id+'/reports',payload:{kind:kind||'other',description:description,unit_identifier:code||null},title:'Report for '+c.order.number,role:'releasing',reviewRoute:'so',reviewParams:{tab:'blocked'}});if(body.isConnected)mWorkflow.paint(view,saved);
      }catch(err){button.disabled=false;mScreenUX.reject(button,error,err.message,event);}};
    }catch(err){if(body.isConnected){body.replaceChildren(R.error(err,function(){report(view,c,kind,code);}));}}
  }

  MApp.route('so', async function (view, params) {
    var render = ++renderSerial, hash = location.hash;
    params = params || {};
    if (!can('orders.release')) {
      view.innerHTML = '<div class="m-error">You don’t have permission to release sale orders.</div>';
      return;
    }
    var account = mProductionDrafts.key('release-owner');
    if (owner !== account) { S = {}; owner = account; }
    if (!params.id) return queue(view, params.tab);
    try {
      var handoffSaved = await mReleaseHandoff.load(Number(params.id));
      if (render !== renderSerial || hash !== location.hash || account !== mProductionDrafts.key('release-owner')) return;
      if (handoffSaved && handoffSaved.operation.state !== 'draft') {
        mReleaseHandoff.paint(view, handoffSaved); return;
      }
      if (handoffSaved && !S[params.id]) S[params.id] = handoffSaved.batch;
      var saved = await mReleaseActions.load(Number(params.id));
      if (render !== renderSerial || hash !== location.hash || account !== mProductionDrafts.key('release-owner')) return;
      if (saved) {
        if (params.step !== 'recovery') { go({ id: params.id, step: 'recovery' }); return; }
        mReleaseActions.paint(view,saved); return;
      }
    } catch (err) { view.innerHTML = ''; view.appendChild(R.error(err, function () { MApp.render(); })); return; }
    withOrder(view, Number(params.id), function (c) {
      var step = params.step, state=st(c.order.id), base=c.slip?c.slip.id:null;
      // A resolved earlier trip must never donate its load, photos or signature to the next.
      // Unknown attempts were intercepted above and retain their original immutable payload.
      if(state.tripBase!==undefined&&state.tripBase!==base) { delete S[c.order.id]; state=st(c.order.id); }
      state.tripBase=base;
      if(state.authorizationBase!==undefined&&state.authorizationBase!==(c.authorization.id||null)){state.token=null;state.tokenOk=false;state.sign=null;}
      state.authorizationBase=c.authorization.id||null;
      // Released: only the result / receipt (its authorization now reads "used").
      if(c.slip&&(step==='receipt'||step==='done'||c.outstanding===0||c.outstanding==null))return receipt(view,c,params.slip);

      if (!step) return authority(view, c);
      if (authProblem(c.authorization) && step !== 'report') return authority(view, c);
      if (!c.order.warehouse_accepted_at && step !== 'report' && step !== 'receipt') return authority(view,c);
      if(['package','handoff','override','proof','review','confirm'].indexOf(step)!==-1){
        var loadError=ckdLoadProblem(c);
        if(loadError){tripLoad(view,c);view.querySelector('.rk-body').insertAdjacentHTML('afterbegin',R.note('warn',mEsc(loadError)));return;}
      }
      if(step==='correct')correct(view,c);
      else if(step==='trip')tripLoad(view,c);
      else if (step === 'scan') scan(view, c);
      else if (step === 'unit') unit(view, c, params.code || '',params.line);
      else if (step === 'blocked') blockedView(view, c, params.code || '', { state: 'not_found' });
      else if (step === 'package') pkg(view, c);
      else if (step === 'handoff') handoff(view, c);
      else if (step === 'override') override(view, c);
      else if (step === 'proof') proof(view, c);
      else if (step === 'review') review(view, c);
      else if (step === 'confirm') confirm(view, c, !!st(c.order.id).partial);
      else if (step === 'done') done(view, c);
      else if (step === 'receipt') receipt(view, c);
      else if (step === 'incomplete') incomplete(view, c);
      else if (step === 'report') report(view, c, params.kind || 'other', params.code);
      else authority(view, c);
    });
  });
})();
