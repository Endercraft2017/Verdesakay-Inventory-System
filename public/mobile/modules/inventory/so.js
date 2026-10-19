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
  function chooseLine(view,c,code,lines,selected,render) {
    if(selected){var chosen=lines.find(function(l){return Number(l.id)===Number(selected);});if(chosen){render(chosen);return;}}
    else if(lines.length===1){render(lines[0]);return;}
    var body=page(view,'78:147','Choose sale line','Match the scanned stock to the exact commercial line');
    body.innerHTML=R.field('Scanned label',code)+R.note('info','Only lines with the same product and build state share a stock pool. Choosing a line does not reserve stock.')+
      (lines.length?lines.map(function(l){return '<button type="button" class="rk-card rk-unitcard" data-sale-line="'+l.id+'"><b>Line #'+l.id+' · '+mEsc(l.name)+'</b><span>'+mEsc(buildTag(l.fulfillment_mode)+(l.parent_order_item_id?' · Kit line #'+l.parent_order_item_id:''))+'</span><small>'+(l.unit_price!=null?'<span style="white-space:nowrap">'+mEsc((c.order.currency||'PHP')+' '+Number(l.unit_price).toFixed(2))+'</span> · ':'')+remaining(l)+' remaining</small></button>';}).join(''):R.note('warn','No matching line has remaining quantity. Refresh the order before another allocation.'))+
      R.actions([{id:'rel-line-back',label:'Back to stock review',kind:'secondary'}]);
    body.querySelectorAll('[data-sale-line]').forEach(function(b){b.onclick=function(){go({id:c.order.id,step:'unit',code:code,line:b.dataset.saleLine});};});
    body.querySelector('#rel-line-back').onclick=function(){go({id:c.order.id,step:'scan'});};
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
    if(!parents.length)return null;
    rows=rows||loadLines(c);
    if(!rows.length)return 'Choose at least one reserved unit or quantity.';
    for(var i=0;i<rows.length;i++){
      var selected=rows[i],line=c.lines.find(function(l){return l.id===selected.order_item_id&&physical(l);});
      if(!line||!Number.isFinite(selected.quantity)||selected.quantity<=0||selected.quantity>held(line)+1e-9)return 'The selected load changed. Review the current reserved quantities.';
    }
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
    if (a.state === 'none' && a.required) return 'No release authorization';
    return null;
  }
  /** A supervisor's approved override stands in for the recipient's token. */
  function overrideOk(a) { return !!(a && a.state === 'valid' && a.override && a.override.status === 'approved'); }
  function modeOf(c) { return c.authorization && c.authorization.mode ? MODES[c.authorization.mode] : c.delivery ? 'Delivery' : 'Release'; }

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
    var body = page(view, '78:16', 'Release orders', 'Allocated units ready for handoff');
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
      var count = function (m) { return ready.filter(function (r) { return r.authorization && r.authorization.mode === m; }).length; };
      tab = tab || 'ready';
      body.innerHTML =
        '<div data-recovery></div>' + R.hero('Ready for handoff', ready.length + ' release' + (ready.length === 1 ? '' : 's'), count('delivery') + ' delivery · ' + count('pickup') + ' pickup') +
        '<div class="rk-segs" role="tablist">' +
          '<button type="button" data-tab="accept"' + (tab === 'accept' ? ' class="on"' : '') + '>To accept<b>' + accept.length + '</b></button>' +
          '<button type="button" data-tab="allocating"' + (tab === 'allocating' ? ' class="on"' : '') + '>Allocating<b>' + allocating.length + '</b></button>' +
          '<button type="button" data-tab="ready" class="blue' + (tab === 'ready' ? ' on' : '') + '">Ready<b>' + ready.length + '</b></button>' +
          '<button type="button" data-tab="blocked" class="warn' + (tab === 'blocked' ? ' on' : '') + '">Blocked<b>' + blocked.length + '</b></button>' +
          '<button type="button" data-tab="done"' + (tab === 'done' ? ' class="on"' : '') + '>Completed</button></div>' +
        '<div class="rk-list" data-list></div>' +
        R.actions([{ id: 'rel-open', label: 'Open release order', kind: 'primary' }]);
      function card(r) {
        var a = r.authorization || {};
        var problem = authProblem(a) || (r.open_reports ? r.open_reports + ' open release report' + (r.open_reports === 1 ? '' : 's') : null);
        var what = (a.mode ? MODES[a.mode].replace('Customer ', '').replace(/^./, function (c) { return c.toUpperCase(); }) : r.delivery ? 'Delivery' : 'Release') +
          ' · ' + (r.qty_ordered || 0) + ' ' + ((r.summary && r.summary.first_name) || 'item') + (r.summary && r.summary.lines > 1 ? ' +' + (r.summary.lines - 1) : '');
        var meta = problem ? 'Blocked · ' + problem
          : !r.warehouse_accepted_at ? 'New · accept to start'
          : r.delivery ? 'Delivery ' + r.delivery.number + (r.delivery.scheduled_date ? ' · ' + r.delivery.scheduled_date : '')
          : (r.qty_released >= r.qty_ordered ? 'Ready now' : r.qty_released + ' of ' + r.qty_ordered + ' allocated') +
            (a.override && a.override.status === 'requested' ? ' · override requested' : overrideOk(a) ? ' · override approved' : a.state === 'valid' ? ' · token issued' : '');
        return '<button type="button" class="rk-card rk-unitcard" data-order="' + r.id + '"><b>' + mEsc(r.number) + '</b><span>' + mEsc(what) + '</span>' +
          '<small' + (problem ? ' class="warn"' : '') + '>' + mEsc(meta + ' · Ship from ' + (r.location_name || 'assigned warehouse')) + '</small><i aria-hidden="true">›</i></button>';
      }
      function paint(which) {
        var host = body.querySelector('[data-list]');
        if (which === 'done') {
          host.innerHTML = q.completed.length ? q.completed.map(function (s) {
            return '<button type="button" class="rk-card rk-unitcard" data-slip="' + s.id + '" data-order="' + s.order_id + '"><b>' + mEsc(s.order_number) + '</b>' +
              '<span>' + mEsc((s.mode ? MODES[s.mode] : 'Released') + ' · ' + (s.customer_name || '')) + '</span><small>' + mEsc(s.number + ' · ' + time(s.released_at)) + '</small><i aria-hidden="true">›</i></button>';
          }).join('') : '<div class="rk-empty">Nothing released by you today.</div>';
          Array.prototype.forEach.call(host.querySelectorAll('[data-slip]'), function (b) { b.onclick = function () { go({ id: b.dataset.order, step: 'receipt', slip:b.dataset.slip }); }; });
          return;
        }
        var list = which === 'blocked' ? blocked : which === 'accept' ? accept : which === 'allocating' ? allocating : ready;
        host.innerHTML = list.length ? list.map(card).join('') : '<div class="rk-empty">' + (which === 'blocked' ? 'No blocked releases.' : 'No sale orders waiting for release.') + '</div>';
        Array.prototype.forEach.call(host.querySelectorAll('[data-order]'), function (b) { b.onclick = function () { go({ id: b.dataset.order }); }; });
      }
      Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (b) {
        b.onclick = function () { Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (x) { x.classList.toggle('on', x === b); }); paint(b.dataset.tab); };
      });
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
  function authority(view, c) {
    var a = c.authorization, p = progress(c), problem = authProblem(a);
    var body = page(view, '78:68', 'Verify release authority', 'Confirm order, mode and authorization');
    var pill = a.state === 'valid' ? { text: 'Authorized', tone: 'ok' } : a.state === 'none' ? { text: 'Not required', tone: 'muted' }
      : { text: a.state === 'none' ? 'No authorization' : a.state.charAt(0).toUpperCase() + a.state.slice(1), tone: 'warn' };
    if (a.state === 'none' && a.required) pill = { text: 'No authorization', tone: 'warn' };
    body.innerHTML =
      R.jobHead({ number: c.order.number, pill: pill, name: modeOf(c), meta: p.need + ' unit' + (p.need === 1 ? '' : 's') + ' · ' + (c.lines[0] ? c.lines[0].name : '') + (c.order.customer_name ? ' · ' + c.order.customer_name : '') }) +
      (a.state !== 'none'
        ? R.field('Approved recipient', a.recipient_name + (a.id_reference ? ' · ID reference ' + a.id_reference : '')) +
          R.field('Release token', a.token_hint + ' · valid until ' + time(a.valid_until))
        : R.field('Authorization', a.required ? 'Required — none issued yet' : 'Not required by company policy · recipient recorded at handoff')) +
      (problem ? '<div class="rk-block warn"><span class="t">! ' + mEsc(problem) + '</span><span>Sales must issue a valid authorization before warehouse-out. Nothing has moved.</span></div>' : '') +
      (c.reports.length ? R.note('warn', '<b>' + c.reports.length + ' open release report' + (c.reports.length === 1 ? '' : 's') + '</b> — ' + mEsc(c.reports[0].description)) : '') +
      R.note('info', '<h3>Privacy protected</h3>Contact numbers and unrelated personal data are not displayed to releasing staff.') +
      R.actions(problem ? [{ id: 'rel-report', label: 'Report issue', kind: 'primary' }, { id: 'rel-back', label: 'Back', kind: 'secondary' }]
        : [{ id: 'rel-go', label: 'Begin unit verification', kind: 'primary' }, { id: 'rel-report', label: 'Report issue', kind: 'secondary' }]);
    body.querySelector('#rel-report').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'authorization' }); };
    var back = body.querySelector('#rel-back'); if (back) back.onclick = function () { go({ tab: 'blocked' }); };
    var btn = body.querySelector('#rel-go');
    if (btn) btn.onclick = function () {
      if (c.order.warehouse_accepted_at) { go({ id: c.order.id, step: 'scan' }); return; }
      if (offline()) { mToast('You’re offline — accepting the order needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Accepting…';
      mReleaseActions.start(c, 'accept', '/orders/' + c.order.id + '/accept-release', {}, 'Accept warehouse release order').catch(fail(btn, 'Begin unit verification'));
    };
  }

  /* ── Scan physical units (78:109) ──────────────────────────────────────── */
  function scan(view, c) {
    var p = progress(c);
    var body = page(view, '78:109', 'Scan physical units', 'Every serial must match this release order');
    function free(l) { return lineFree(c,l); }
    var bulk = c.lines.filter(function (l) { return physical(l) && !l.serialized && (l.released_qty || 0) < l.quantity; });
    body.innerHTML =
      manifest(c) + R.note('info','Stock shown below is read-only. Planned production is not on-hand inventory; receive it at the ship-from warehouse before allocating.')+(c.availability||[]).map(function(a){var line=c.lines.find(function(l){return l.id===a.order_item_id;});return R.field('Stock context · '+(line?line.name:'#'+a.item_id),'Here '+Number(a.on_hand||0)+' · Other sales/holds '+Number(a.committed_elsewhere||0)+' (kits '+Number(a.kit_held||0)+', repairs '+Number(a.repair_held||0)+') · Elsewhere '+Number(a.elsewhere_on_hand||0)+(a.linked_job_orders&&a.linked_job_orders.length?' · Production planned '+a.linked_job_orders.reduce(function(n,j){return n+j.remaining;},0):''));}).join('')+c.lines.filter(physical).map(function(l){return R.field('Sale line',lineText(c,l));}).join('') + '<button type="button" class="rk-identify"><span class="frame" aria-hidden="true"></span><b>Scan the unit serial label</b><small>' + p.got + ' of ' + p.need + ' allocated units ready</small></button>' +
      '<label class="rk-card rk-field" data-manual hidden><small>Serial (manual)</small><div class="rk-search"><input class="rk-input" style="margin:0" data-code placeholder="Type the serial"><button type="button" class="rk-back" data-find style="padding:0">Check</button></div></label>' +
      (c.units.length ? '<div class="rk-checks">' + c.units.filter(function(u){return u.status!=='sold'||u.pending_direct;}).map(function (u) {
        return '<div class="rk-check-row"><button type="button" data-unit="' + mEsc(u.identifier || '') + '"><span class="rk-state pass" aria-hidden="true">✓</span><b>' + mEsc(u.identifier || 'Unit #' + u.id) + '</b>' +
          '<small>Line #' + mEsc(u.order_item_id || '—') + ' · Allocated · Ready to sell' + (u.location_name ? ' · ' + mEsc(u.location_name) : '') + '</small></button></div>';
      }).join('') + '</div>' : '') +
      bulk.map(function (l) {
        return '<div class="rk-card rk-field"><small>' + mEsc(l.name) + ' · ' + buildTag(l.fulfillment_mode) + ' · non-serialized</small><div class="rk-qtyrow" style="margin-top:8px"><span>' + (l.released_qty || 0) + ' of ' + l.quantity + ' allocated · ' + free(l) + ' free here</span>' +
          '<span class="rk-search"><input class="rk-input" style="margin:0;width:70px" readonly aria-label="Free quantity; scan a label to choose allocation" type="number" min="0" step="any" max="' + free(l) + '" inputmode="decimal" data-line="' + l.id + '" data-qty="' + l.item_id + '" value="' + free(l) + '">' +
          '<button type="button" class="rk-back" data-line="' + l.id + '" data-bulk="' + l.item_id + '"' + (free(l) <= 0 ? ' disabled' : '') + ' style="padding:0">Add</button></span></div></div>';
      }).join('') +
      (c.batch_allocations || []).map(function(a){return R.field(a.batch_number+' · Line #'+(a.order_item_id||'—')+' · '+a.state,a.quantity+' allocated');}).join('') + R.field('Ship from', c.order.location_name || 'Warehouse #' + c.order.location_id) + R.note('info', '<h3>Allocation check</h3>Free quantities for repeated product/build lines share one stock pool; do not add them together. A unit assigned to another order cannot be substituted without approval.') +
      R.actions([{ id: 'rel-go', label: 'Continue', kind: 'primary' }, {id:'rel-load',label:'Choose vehicle load',kind:'secondary'}, { id: 'rel-man', label: 'Scan manually', kind: 'secondary' }]);
    var check = function (code) {
      code = String(code || '').trim();
      if (!code) { mToast('Enter or scan a serial', 'err'); return; }
      go({ id: c.order.id, step: 'unit', code: code });
    };
    body.querySelector('.rk-identify').onclick = function () {
      if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
      mScanner.open({ title: 'Scan the unit or batch QR label', allowManual: false, onResult: check });
    };
    body.querySelector('#rel-man').onclick = function () { var m = body.querySelector('[data-manual]'); m.hidden = false; m.querySelector('input').focus(); };
    body.querySelector('[data-find]').onclick = function () { check(body.querySelector('[data-code]').value); };
    Array.prototype.forEach.call(body.querySelectorAll('[data-unit]'), function (b) { b.onclick = function () { if (b.dataset.unit) check(b.dataset.unit); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-bulk]'), function (b) {
      b.textContent = 'Scan label';
      b.onclick = function () {
        mScanner.open({ title: 'Scan the attached batch or item QR sticker', allowManual: false, onResult: check });
      };
    });
    var correction=document.createElement('button');correction.type='button';correction.className='rk-btn secondary';correction.id='rel-correct';correction.textContent='Correct held allocation';body.appendChild(correction);correction.onclick=function(){go({id:c.order.id,step:'correct'});};
    body.querySelector('#rel-load').onclick=function(){go({id:c.order.id,step:'trip'});};
    body.querySelector('#rel-go').onclick = function () {
      go({ id: c.order.id, step: p.complete ? 'package' : 'incomplete' });
    };
  }

  function bulkLabel(view,c,stock,isBatch,line) {
    var itemId=isBatch?stock.product_item_id:stock.id;
    if(!line){blockedView(view,c,'',{state:'wrong_product'});return;}
    var available=Math.max(0,Math.min(stock.available,line.quantity-(line.released_qty||0)));
    var body=page(view,'78:147',isBatch?'Verify batch allocation':'Verify item allocation','Scan the attached sticker and count the stock for this sale');
    body.innerHTML=R.jobHead({number:isBatch?stock.number:stock.code,name:isBatch?stock.product_name:stock.name,meta:c.order.number})+
      R.field('Sale line',lineText(c,line))+R.field('Build state',buildTag(line.fulfillment_mode))+R.field('Ship from',c.order.location_name||'Warehouse #'+c.order.location_id)+
      R.field(isBatch?'Free in this batch for this sale':'Free for this sale',String(available))+
      '<label class="rk-card rk-field"><small>Quantity for '+mEsc(c.order.number)+'</small><input class="rk-input" data-label-qty type="number" min="0" step="any" max="'+available+'" value="'+available+'" inputmode="decimal"></label><div data-label-verification></div>'+
      R.actions([{id:'rel-label-ok',label:'Allocate to sales order',kind:'primary'},{id:'rel-label-back',label:'Back',kind:'secondary'}]);
    var btn=body.querySelector('#rel-label-ok');btn.disabled=true;
    var gate=mScanner.verification(body.querySelector('[data-label-verification]'),[isBatch?{code:'VDS:BATCH:'+stock.id,aliases:[stock.number]}:stock.code],function(ok){btn.disabled=!ok||available<=0;});
    body.querySelector('#rel-label-back').onclick=function(){go({id:c.order.id,step:'scan'});};
    btn.onclick=function(){
      if(!gate.complete())return;
      var qty=Number(body.querySelector('[data-label-qty]').value);
      if(!Number.isFinite(qty)||qty<=0||qty>available){mToast('Enter a positive quantity within the displayed free stock.','err');return;}
      if(offline()){mToast('Allocation needs a connection.','err');return;}
      var allocation={item_id:itemId,quantity:qty};if(line.id!=null)allocation.order_item_id=line.id;if(isBatch)allocation.batch_id=stock.id;
      btn.disabled=true;body.querySelectorAll('button,input').forEach(function(el){el.disabled=true;});
      mReleaseActions.start(c,'allocate','/orders/'+c.order.id+'/release',{bulk:[allocation]},'Allocate '+qty+' from '+(isBatch?stock.number:stock.code)+' · '+lineText(c,line)).catch(fail(btn));
    };
  }

  /* ── Verify allocated unit (78:147) / release blocked (78:365) ─────────── */
  function unit(view, c, code, selected) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    var requestHash=location.hash,requestScope=mProductionDrafts.key('release-owner');
    API.get('/release-slips/orders/' + c.order.id + '/unit?code=' + encodeURIComponent(code)).then(function (r) {
      var hash=location.hash, scope=mProductionDrafts.key('release-owner');
      if(hash!==requestHash||scope!==requestScope||!view.isConnected)return;
      if (['batch_available','bulk_available','line_required'].indexOf(r.state)!==-1) {
        var stock=r.batch||r.stock, isBatch=!!r.batch;
        var choices=c.lines.filter(function(l){return physical(l)&&remaining(l)>0&&(r.matching_lines?r.matching_lines.some(function(m){return Number(m.order_item_id)===Number(l.id);}):l.item_id===(isBatch?stock.product_item_id:stock.id)&&(l.fulfillment_mode==='semi_built')===(stock.build_mode==='semi_built'));});
        chooseLine(view,c,code,choices,selected,function(line){
          var target=stock||{id:line.item_id,name:line.name,code:code,build_mode:line.fulfillment_mode,available:lineFree(c,line)};
          bulkLabel(view,c,target,isBatch,line);
        });return;
      }
      if (r.state !== 'allocated' && r.state !== 'available') { blockedView(view, c, code, r); return; }
      if (location.hash.split('?')[0] !== '#/so' || Number(new URLSearchParams(location.hash.split('?')[1]).get('id')) !== c.order.id) return;
      var u = r.unit, p = progress(c);
      if(u.status==='sold'&&c.outstanding>0){blockedView(view,c,code,{state:'unavailable',unit:u});return;}
      if (!c.lines.some(function (l) { return physical(l) && l.item_id === u.product_item_id; })) { blockedView(view,c,code,{ state: 'wrong_product', error: 'Allocate the CKD component lines, not the assembled parent product.', unit: u }); return; }
      if (!c.lines.some(function (l) { return physical(l) && l.item_id === u.product_item_id && (l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled') === (u.build_mode || 'assembled'); })) { blockedView(view,c,code,{ state: 'wrong_build', unit: u }); return; }
      if (u.location_id != null && c.order.location_id != null && u.location_id !== c.order.location_id) { blockedView(view,c,code,{ state: 'refused', error: 'Unit is at a different warehouse. Transfer it before allocating.', unit: u }); return; }
      var assigned=c.units.find(function(x){return x.id===u.id;});
      var choices=c.lines.filter(function(l){return physical(l)&&l.item_id===u.product_item_id&&(l.fulfillment_mode==='semi_built')===(u.build_mode==='semi_built')&&(r.state==='allocated'?assigned&&assigned.order_item_id?l.id===assigned.order_item_id:true:remaining(l)>0);});
      chooseLine(view,c,code,choices,selected,function(line){
      var body = page(view, '78:147', 'Verify allocated unit', 'Match the physical unit and stock record');
      var idx = c.units.map(function (x) { return x.id; }).indexOf(u.id);
      body.innerHTML =
        R.jobHead({ tone: 'ok', number: u.identifier, pill: { text: r.state === 'allocated' ? 'Allocated' : 'Ready to sell', tone: 'ok' }, name: u.product_name,
          meta: u.location_name || '' }) +
        R.field('Sale line',lineText(c,line)) + R.field('Build state', buildTag(u.build_mode)) + R.field('Ship from', c.order.location_name || 'Warehouse #' + c.order.location_id) + R.field('Stock transaction', u.receipt_number || '—') +
        R.field('Allocated to', c.order.number + ' · ' + (r.state === 'allocated' ? (idx + 1) + ' of ' + p.need : 'will be ' + (p.got + 1) + ' of ' + p.need)) +
        '<div data-label-verification></div>' + R.note('info', '<h3>Physical check</h3>Confirm model, color, serial label and visible condition before removing the unit.') +
        R.actions([{ id: 'rel-ok', label: 'Confirm unit', kind: 'primary' }, { id: 'rel-mis', label: 'Mismatch', kind: 'secondary' }]);
      body.querySelector('#rel-mis').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'unit_mismatch', code: code }); };
      var btn = body.querySelector('#rel-ok');
      btn.disabled = true;
      var sticker = mScanner.verification(body.querySelector('[data-label-verification]'), [{code:'VDS:UNIT:'+u.id,aliases:[u.identifier || ('UNIT-' + u.id)]}], function (ok) { btn.disabled = !ok; });
      btn.onclick = function () {
        if (!sticker.complete()) { mToast('Scan the attached QR sticker first.', 'err'); return; }
        if (r.state === 'allocated') { go({ id: c.order.id, step: 'scan' }); return; }
        if (offline()) { mToast('You’re offline — allocation needs a connection.', 'err'); return; }
        btn.disabled = true; btn.textContent = 'Allocating…';
        body.querySelectorAll('button').forEach(function (el) { el.disabled = true; });
        mReleaseActions.start(c, 'allocate', '/orders/' + c.order.id + '/release', Object.assign({ codes: ['VDS:UNIT:' + u.id] },line.id!=null?{order_item_id:line.id}:{}), 'Allocate ' + (u.identifier || ('UNIT-' + u.id))+' · '+lineText(c,line)).catch(fail(btn,'Confirm unit'));
      };
      });
    }).catch(function (err) { if(location.hash!==requestHash||requestScope!==mProductionDrafts.key('release-owner'))return; view.innerHTML = ''; view.appendChild(R.error(err, function () { unit(view, c, code, selected); })); });
  }
  function blockedView(view, c, code, r) {
    var body = page(view, '78:365', 'Release blocked', 'Resolve the mismatch before warehouse-out');
    var TEXT = {
      other_order: ['Serial is not allocated', 'Allocated to ' + ((r.unit && r.unit.order_number) || 'another order') + ', not this order.'],
      batch_unavailable: ['Batch unavailable', 'No free tracked quantity from this batch is available at this sale’s ship-from location.'],
      batch_label_required: ['Scan the batch sticker', 'This product has batch stock. Scan the specific batch QR, rather than its general product code.'],
      wrong_build: ['Wrong build state', 'This serial is ' + buildTag(r.unit && r.unit.build_mode) + '; select a unit matching the sale line.'],
      wrong_product: ['Wrong product', (r.unit ? r.unit.product_name : 'This unit') + ' is not on ' + c.order.number + '.'],
      not_found: ['Serial not found', 'No finished unit carries this label.'],
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
          return '<div class="rk-check-row"><button type="button" data-p="' + i + '"><span class="rk-state ' + (on ? 'pass' : '') + '" aria-hidden="true">' + (on ? '✓' : '○') + '</span>' +
            '<b>' + mEsc(p.label) + (p.required ? ' <span class="req">*</span>' : '') + '</b><small>' + mEsc(p.item_name + (on ? ' · confirmed' : ' · tap to confirm')) + '</small></button></div>';
        }).join('') + '</div>' : R.note('info', 'No package checklist is set for these products. Confirm the unit leaves complete; Sales or production can add a checklist.')) +
        '<label class="rk-card rk-field"><small>Package seal / tag</small><input class="rk-input" data-seal maxlength="80" placeholder="Optional" value="' + mEsc(s.seal || '') + '"></label>' +
        R.note('info', '<h3>Nothing is implied</h3>Every required item is confirmed explicitly before handoff.') +
        R.actions([{ id: 'rel-go', label: 'Continue to handoff', kind: 'primary' }, { id: 'rel-miss', label: 'Report missing', kind: 'secondary' }]);
      Array.prototype.forEach.call(body.querySelectorAll('[data-p]'), function (b) {
        b.onclick = function () { var p = packages[Number(b.dataset.p)]; s.pkg[k(p)] = !s.pkg[k(p)]; s.seal = body.querySelector('[data-seal]').value; persist(c.order.id, s).catch(saveError); paint(); };
      });
      body.querySelector('#rel-go').disabled = missing.length > 0;
      body.querySelector('#rel-go').onclick = function () { s.seal = body.querySelector('[data-seal]').value.trim(); persist(c.order.id, s).then(function () { go({ id: c.order.id, step: 'handoff' }); }).catch(saveError); };
      body.querySelector('#rel-miss').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'package_missing' }); };
    }
    paint();
  }

  /* ── Handoff details (78:240) ──────────────────────────────────────────── */
  function handoff(view, c) {
    var s = st(c.order.id), a = c.authorization, hasAuth = a.state === 'valid';
    var body = page(view, '78:240', 'Handoff details', 'Verify who or what receives the unit');
    body.innerHTML =
      R.field('Release mode', modeOf(c)) +
      (hasAuth
        ? R.field('Approved recipient', a.recipient_name + (a.id_reference ? ' · ID reference ' + a.id_reference : '')) +
          (overrideOk(a) && !s.tokenOk
            ? '<div class="rk-card rk-field"><small>Token verification</small><b style="color:#14803d">Supervisor override · ' + mEsc(a.override.decided_by_name || 'approved') + '</b>' +
              '<span>' + mEsc(a.override.decision_note || a.override.reason) + '</span></div>'
            : '<div class="rk-card rk-field"><small>Token verification</small>' + (s.tokenOk
              ? '<b style="color:#14803d">' + mEsc(s.token) + ' · Valid</b>'
              : '<div class="rk-search" style="margin-top:8px"><input class="rk-input" style="margin:0;text-transform:uppercase" data-token placeholder="Token the recipient presents" autocomplete="off">' +
                '<button type="button" class="rk-back" data-verify style="padding:0">Verify</button></div>' +
                '<button type="button" class="rk-back" data-notoken style="padding:0;margin-top:10px">' +
                  (a.override && a.override.status === 'requested' ? 'Override requested — check status' : 'Recipient can’t present the token') + '</button>') + '</div>')
        : '<label class="rk-card rk-field"><small>' + (c.authorization.mode === 'delivery' || c.delivery ? 'Driver / receiver' : 'Recipient name') + ' *</small><input class="rk-input" data-recipient maxlength="160" value="' + mEsc(s.recipient || '') + '"></label>') +
      (modeOf(c) === 'Delivery' ? '<label class="rk-card rk-field"><small>Vehicle / plate no.</small><input class="rk-input" data-plate maxlength="40" value="' + mEsc(s.plate || '') + '"></label>' : '') +
      '<label class="rk-card rk-field"><small>Handoff area</small><input class="rk-input" data-area maxlength="80" value="' + mEsc(s.area || (a.handoff_area || '')) + '" placeholder="e.g. Release Bay 1"></label>' +
      R.note('info', '<h3>Identity rule</h3>Match the approved name' + (a.id_reference ? ', masked ID reference' : '') + (hasAuth ? ' and token' : '') + '. Do not record unnecessary personal data.') +
      R.actions([{ id: 'rel-go', label: 'Continue to proof', kind: 'primary' }, { id: 'rel-no', label: 'Cannot verify', kind: 'secondary' }]);
    var keep = function () {
      var area = body.querySelector('[data-area]'); s.area = area.value.trim();
      var rc = body.querySelector('[data-recipient]'); if (rc) s.recipient = rc.value.trim();
      var pl = body.querySelector('[data-plate]'); if (pl) s.plate = pl.value.trim();
    };
    body.querySelectorAll('[data-area], [data-recipient], [data-plate]').forEach(function (input) { input.oninput = function () { keep(); persist(c.order.id, s).catch(saveError); }; });
    var vb = body.querySelector('[data-verify]');
    if (vb) vb.onclick = function () {
      var t = body.querySelector('[data-token]').value.trim().toUpperCase();
      if (!t) { mToast('Enter the token the recipient presents', 'err'); return; }
      vb.disabled = true; keep();
      API.get('/release-slips/orders/' + c.order.id + '/verify-token?token=' + encodeURIComponent(t)).then(function (r) {
        if (!r.ok) { mToast(r.error, 'err'); vb.disabled = false; return; }
        s.token = t; s.tokenOk = true; persist(c.order.id, s).then(function () { handoff(view, c); }).catch(saveError);
      }).catch(fail(vb));
    };
    var nt = body.querySelector('[data-notoken]');
    if (nt) nt.onclick = function () { keep(); go({ id: c.order.id, step: 'override' }); };
    body.querySelector('#rel-no').onclick = function () { go({ id: c.order.id, step: 'report', kind: 'identity' }); };
    body.querySelector('#rel-go').onclick = function () {
      keep();
      if (hasAuth && !s.tokenOk && !overrideOk(a)) { mToast('Verify the recipient’s token first', 'err'); return; }
      if (!hasAuth && !s.recipient) { mToast('Enter who receives the goods', 'err'); return; }
      persist(c.order.id, s).then(function () { go({ id: c.order.id, step: 'proof' }); }).catch(saveError);
    };
  }

  /* ── Release without the token: supervisor override (extends 78:240) ────── */
  function override(view, c) {
    var a = c.authorization, ov = a.override, sup = can('inventory.adjust');
    var status = ov ? ov.status : null;
    var body = page(view, '78:240', 'Release without token', 'A supervisor approves it, with a reason');
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
    body.innerHTML = html + R.note('info', '<h3>Only the token is waived</h3>The recipient still has to match the approved name' + (a.id_reference ? ' and masked ID reference' : '') + '. The reason is recorded on the release slip.') + R.actions(acts);
    var on = function (id, fn) { var b = body.querySelector('#' + id); if (b) b.onclick = fn; };
    var reason = function () { var t = body.querySelector('[data-reason]'); return t ? t.value.trim() : ''; };
    var send = function (btn, path, payload, label, then) {
      if (offline()) { mToast('You’re offline — the override needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      API.post('/release-slips/orders/' + c.order.id + path, payload, { idempotencyKey: key() }).then(then).catch(fail(btn, label));
    };
    on('rel-cont', function () { go({ id: c.order.id, step: 'handoff' }); });
    on('rel-back', function () { go({ id: c.order.id, step: 'handoff' }); });
    on('rel-check', function () { go({ id: c.order.id, step: 'override', t: Date.now() }); });
    on('rel-ask', function () {
      if (reason().length < 5) { mToast('Say why the token can’t be presented', 'err'); return; }
      send(this, '/override-request', { reason: reason() }, 'Ask a supervisor', function () { mToast('Supervisors notified'); go({ id: c.order.id, step: 'override', t: Date.now() }); });
    });
    on('rel-approve', function () {
      if (reason().length < 5) { mToast('Give the reason for the override', 'err'); return; }
      send(this, '/override', { approve: true, reason: reason() }, 'Approve override', function () { mToast('Override approved'); go({ id: c.order.id, step: 'handoff' }); });
    });
    on('rel-decline', function () {
      if (reason().length < 5) { mToast('Give the reason for declining', 'err'); return; }
      send(this, '/override', { approve: false, reason: reason() }, 'Decline', function () { mToast('Override declined'); go({ id: c.order.id, step: 'override', t: Date.now() }); });
    });
  }

  /* ── Capture handoff proof (78:281) ────────────────────────────────────── */
  function proof(view, c) {
    var s = st(c.order.id);
    var body = page(view, '78:281', 'Capture handoff proof', 'Record only evidence required by policy');
    var sig = window.mSignature ? mSignature({ onChange: function () {
      if (sig.isEmpty()) { s.sign = null; persist(c.order.id, s).catch(saveError); }
      else sig.toBlob(function (b) { s.sign = b; persist(c.order.id, s).catch(saveError); });
    } }) : null;
    body.innerHTML =
      '<button type="button" class="rk-camera rel" data-cap><span class="target" aria-hidden="true"></span><b>Unit and release-bay proof</b><small>Avoid capturing unrelated people or documents.</small></button>' +
      '<div class="rk-thumbs" data-thumbs></div>' +
      '<div class="rk-sign"><small>Recipient acknowledgement</small><div data-sign></div></div>' +
      R.note('info', '<h3>Privacy-minimized evidence</h3>Capture the unit, serial context and handoff — not phone screens, full IDs or bystanders.') +
      R.actions([{ id: 'rel-go', label: 'Capture and continue', kind: 'primary' }, { id: 'rel-retake', label: 'Retake', kind: 'secondary' }]);
    if (s.sign) body.querySelector('[data-sign]').appendChild(mEl('<p class="m-hint">Saved recipient signature retained. Draw again to replace it, or Retake to clear.</p>'));
    if (sig) body.querySelector('[data-sign]').appendChild(sig.el);
    function thumbs() {
      body.querySelector('[data-thumbs]').innerHTML = s.photos.map(function (f, i) {
        return '<span><img alt="" src="' + URL.createObjectURL(f) + '"><button type="button" data-x="' + i + '" aria-label="Remove">×</button></span>';
      }).join('');
      Array.prototype.forEach.call(body.querySelectorAll('[data-x]'), function (b) { b.onclick = function () { s.photos.splice(Number(b.dataset.x), 1); persist(c.order.id, s).catch(saveError); thumbs(); }; });
    }
    thumbs();
    body.querySelector('[data-cap]').onclick = function () {
      mPhoto.pickFile().then(function (f) { if (s.photos.length >= 19) { mToast('Keep at most 19 handoff photos.', 'err'); return; } s.photos.push(f); persist(c.order.id, s).then(thumbs).catch(saveError); }).catch(function () {});
    };
    body.querySelector('#rel-retake').onclick = function () { s.photos = []; s.sign = null; if (sig) sig.clear(); persist(c.order.id, s).catch(saveError); thumbs(); };
    body.querySelector('#rel-go').onclick = function () {
      if (!s.photos.length) { mToast('Add at least one photo of the unit at handoff', 'err'); return; }
      if (sig && sig.isEmpty() && !s.sign) { mToast('Ask the recipient to sign', 'err'); return; }
      if (sig && !sig.isEmpty()) sig.toBlob(function (b) { s.sign = b; persist(c.order.id, s).then(function () { go({ id: c.order.id, step: 'review' }); }).catch(saveError); });
      else persist(c.order.id, s).then(function () { go({ id: c.order.id, step: 'review' }); }).catch(saveError);
    };
  }

  /* ── Review warehouse-out (78:317) ─────────────────────────────────────── */
  function review(view, c) {
    var s = st(c.order.id), a = c.authorization, p = progress(c);
    var body = page(view, '78:317', 'Review warehouse-out', 'Confirm authorization, unit and handoff');
    var row = function (t, sub) { return '<div class="rk-check-row"><button type="button" disabled><span class="rk-state pass" aria-hidden="true">✓</span><b>' + mEsc(t) + '</b><small>' + mEsc(sub) + '</small></button></div>'; };
    var pkgN = tripPackage(c).filter(function (x) { return s.pkg[x.item_id + '|' + x.label]; }).length;
    body.innerHTML =
      '<div class="rk-hero"><small>Warehouse-out review</small><b>' + loadCount(c) + ' unit' + (loadCount(c) === 1 ? '' : 's') + '</b><span>' + mEsc(modeOf(c) + (s.area ? ' · ' + s.area : '')) + '</span></div>' +
      '<div class="rk-checks">' +
        row('Authorization', c.order.number + ' · ' + (a.state !== 'valid' ? 'Not required' : s.tokenOk ? 'Token verified' : overrideOk(a) ? 'Supervisor override' : 'Valid')) +
        row('Unit and package', (c.units.length ? 'Serial' + (c.units.length === 1 ? '' : 's') : 'Quantities') + (pkgN ? ' and ' + pkgN + ' package item' + (pkgN === 1 ? '' : 's') : '') + ' verified') +
        row('Handoff evidence', s.photos.length + ' photo' + (s.photos.length === 1 ? '' : 's') + (s.sign ? ' and acknowledgement' : '') + ' attached') +
      '</div>' +
      '<div class="rk-note warn"><h3>Inventory effect</h3>The unit' + (p.got === 1 ? '' : 's') + ' leave' + (p.got === 1 ? 's' : '') + ' stock and become' + (p.got === 1 ? 's' : '') + ' Released. This cannot be undone by deleting history.</div>' +
      R.actions([{ id: 'rel-go', label: 'Continue to confirmation', kind: 'primary' }, { id: 'rel-back', label: 'Back', kind: 'secondary' }]);
    body.querySelector('#rel-back').onclick = function () { history.back(); };
    body.querySelector('#rel-go').onclick = function () { go({ id: c.order.id, step: 'confirm' }); };
  }

  /* ── Confirm physical release (78:401) — online-only, idempotent ───────── */
  function confirm(view, c, partial) {
    var s = st(c.order.id), a = c.authorization;
    if (!s.photos.length || !s.sign || (a.state === 'valid' && !s.tokenOk && !overrideOk(a))) { go({ id: c.order.id, step: !s.photos.length || !s.sign ? 'proof' : 'handoff' }); return; }
    var body = page(view, '78:401', 'Confirm physical release', 'Final irreversible inventory action');
    var selected=loadLines(c).reduce(function(ids,l){return ids.concat(l.unit_ids||[]);},[]);
    var first = c.units.find(function(u){return u.status!=='sold'&&(!s.trip||selected.indexOf(u.id)!==-1);});
    body.innerHTML =
      '<div class="rk-block ok"><span class="t">✓ Ready to release</span><b class="lg">' + mEsc(first ? first.identifier + (c.units.length > 1 ? ' + ' + (c.units.length - 1) + ' more' : '') : c.lines[0].name) + '</b>' +
        '<span style="color:var(--rk-title);font-weight:500">' + mEsc(c.order.number + ' · ' + modeOf(c)) + '</span><span>' + mEsc((first && first.location_name ? first.location_name : 'Stock') + ' → Released') + '</span></div>' +
      (partial ? R.note('warn', '<b>Partial release.</b> Unloaded goods remain reserved on this sales order for another trip.') : '') +
      R.check('rel-ok', 'Physical handoff is complete') +
      R.note('info', '<h3>This records warehouse-out</h3>Stock quantity, unit stage, release order and audit history update together.') +
      R.actions([{ id: 'rel-post', label: 'Confirm warehouse-out', kind: 'ink' }, { id: 'rel-cancel', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#rel-cancel').onclick = function () { go({ id: c.order.id }); };
    var btn = body.querySelector('#rel-post'), chk = body.querySelector('#rel-ok');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function () {
      if (offline()) { mToast('You’re offline — warehouse-out needs a connection. Nothing was released.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Recording…';
      var payload = {
        previous_slip_id:c.slip?c.slip.id:null,
        lines:s.trip||undefined,
        collected_by: a.state === 'valid' ? a.recipient_name : s.recipient, vehicle_plate: s.plate || null,
        authorization_token: s.tokenOk ? s.token : null, seal_tag: s.seal || null, handoff_area: s.area || null, acknowledged: !!s.sign,
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
        R.field('Collected by', (sl.collected_by || '—') + (sl.vehicle_plate ? ' · ' + sl.vehicle_plate : '')) +
        (c.slip.backorder_number ? R.field('Backorder', c.slip.backorder_number) : '') +
        R.lines((sl.items || []).map(function (i) { return { name: i.name + (i.unit_identifiers ? ' — ' + i.unit_identifiers : ''), qty: i.quantity + (i.unit ? ' ' + i.unit : ''), ok: true }; })) +
        '<div data-photos></div>' +
        R.note('info','Any unshipped remainder stays held on '+mEsc(c.order.number)+'.')+R.actions([{ id: 'rel-back', label: 'Back to queue', kind: 'secondary' }].concat(c.outstanding>0?[{id:'rel-next-trip',label:'Review remaining order',kind:'primary'}]:[]).concat(can('delivery.manage')?[{id:'rel-plan-delivery',label:'Plan delivery for this slip',kind:'secondary'}]:[]));
      if (mPhoto.thumbs) body.querySelector('[data-photos]').appendChild(mPhoto.thumbs('release', sl.id, { editable: false }));
      body.querySelector('#rel-back').onclick = function () { go({ tab: 'done' }); };var plan=body.querySelector('#rel-plan-delivery');if(plan)plan.onclick=function(){MApp.go('deliveries',{step:'plan',order:c.order.id,slip:sl.id});};if(can('inventory.adjust')||can('orders.release')){var ret=document.createElement('button');ret.className='rk-btn secondary';ret.textContent='Receive customer return';ret.onclick=function(){MApp.go('returns',{slip:sl.id});};body.appendChild(ret);}var next=body.querySelector('#rel-next-trip');if(next)next.onclick=function(){delete S[c.order.id];go({id:c.order.id});};
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
    var s=st(c.order.id),body=page(view,'78:481','Choose vehicle load','Count only what leaves on this trip');
    var saved=s.trip,previous=c.slip?c.slip.id:null;
    if(s.tripPrevious!==undefined&&s.tripPrevious!==previous){saved=null;s.trip=null;}
    s.tripPrevious=previous;
    body.innerHTML=R.note('info','Unloaded goods stay reserved and unavailable to other sales. Release complete CKD kits only.')+
      c.lines.filter(physical).map(function(l){
        var choice=saved&&saved.find(function(x){return x.order_item_id===l.id;});
        var units=c.units.filter(function(u){return u.order_item_id===l.id&&(u.status==='reserved'||u.pending_direct);});
        var lots=(c.batch_allocations||[]).filter(function(a){return a.order_item_id===l.id&&a.state==='reserved';});
        var untracked=Math.max(0,held(l)-units.length-lots.reduce(function(n,a){return n+a.quantity;},0));
        return '<section class="rk-card rk-field" data-load-line="'+l.id+'"><b>'+mEsc(lineText(c,l).replace(/ remaining$/,' to allocate'))+'</b><small>'+Number(l.dispatched_qty||0)+' shipped · '+Math.max(0,held(l)-units.filter(function(u){return u.pending_direct;}).length)+' held here'+(units.some(function(u){return u.pending_direct;})?' · direct stock-out awaiting slip':'')+'</small>'+
          units.map(function(u){return '<label class="rk-check-row"><input type="checkbox" data-load-unit="'+u.id+'" '+(u.pending_direct?'checked disabled':!saved||choice&&choice.unit_ids&&choice.unit_ids.indexOf(u.id)!==-1?'checked':'')+'>'+mEsc((u.identifier||'Unit #'+u.id)+(u.pending_direct?' · stock already removed; required on this slip':''))+'</label>';}).join('')+
          lots.map(function(a){var picked=choice&&choice.batches&&choice.batches.find(function(b){return b.allocation_id===a.id;});return '<label><small>'+mEsc(a.batch_number)+' · reserved '+a.quantity+'</small><input class="rk-input" type="number" min="0" max="'+a.quantity+'" step="any" inputmode="decimal" data-load-batch="'+a.id+'" value="'+(saved?(picked?picked.quantity:0):a.quantity)+'"></label>';}).join('')+
          (untracked>0?'<label><small>Other reserved quantity · '+untracked+'</small><input class="rk-input" type="number" min="0" max="'+untracked+'" step="any" inputmode="decimal" data-load-bulk value="'+(saved?Math.max(0,(choice?choice.quantity:0)-(choice&&choice.unit_ids?choice.unit_ids.length:0)-(choice&&choice.batches?choice.batches.reduce(function(n,b){return n+b.quantity;},0):0)):untracked)+'"></label>':'')+'</section>';
      }).join('')+R.actions([{id:'trip-continue',label:'Use this load',kind:'primary'},{id:'trip-back',label:'Back to stock review',kind:'secondary'}]);
    function collect(){
      var rows=[];
      body.querySelectorAll('[data-load-line]').forEach(function(box){var ids=Array.prototype.map.call(box.querySelectorAll('[data-load-unit]:checked'),function(e){return Number(e.dataset.loadUnit);});var batches=[],qty=ids.length;
        box.querySelectorAll('input[type=number]').forEach(function(e){var n=Number(e.value);if(e.value.trim()===''||!Number.isFinite(n)||n<0||n>Number(e.max))throw new Error('Enter quantities within the reserved load.');qty+=n;if(e.dataset.loadBatch&&n>0)batches.push({allocation_id:Number(e.dataset.loadBatch),quantity:n});});
        if(qty>0)rows.push({order_item_id:Number(box.dataset.loadLine),quantity:qty,unit_ids:ids,batches:batches});
      });
      return rows;
    }
    body.querySelector('#trip-continue').onclick=function(){try{
      var rows=collect(),total=rows.reduce(function(n,l){return n+l.quantity;},0),p=progress(c);
      if(!total)throw new Error('Choose at least one reserved unit or quantity.');
      if(total+1e-9<p.need&&!(c.authorization.state==='valid'&&c.authorization.partial_allowed))throw new Error('Sales must authorize this partial trip first.');
      var problem=ckdLoadProblem(c,rows);if(problem)throw new Error(problem);
      s.trip=rows;s.partial=total+1e-9<p.need;persist(c.order.id,s).then(function(){go({id:c.order.id,step:'package'});}).catch(saveError);
    }catch(e){mToast(e.message,'err');}};
    body.querySelector('#trip-back').onclick=function(){go({id:c.order.id,step:'scan'});};
  }

  /* ── Report a release problem to Sales ─────────────────────────────────── */
  function report(view, c, kind, code) {
    var META = {
      authorization: ['78:68', 'Report authorization issue', 'Sales sees this on the sale order'],
      unit_mismatch: ['78:365', 'Report block', 'Wrong or unexpected unit'],
      package_missing: ['78:188', 'Report missing item', 'The unit stays staged until resolved'],
      identity: ['78:240', 'Cannot verify recipient', 'Do not hand over the goods'],
      partial_request: ['78:481', 'Request partial release', 'Sales decides and issues an authorization'],
    }[kind] || ['78:68', 'Report issue', ''];
    var body = page(view, META[0], META[1], META[2]);
    body.innerHTML =
      (code ? R.field('Unit', code) : '') +
      '<label class="rk-card rk-field"><small>What happened</small><textarea rows="4" maxlength="1500" data-desc placeholder="Describe it for Sales"></textarea></label>' +
      '<div class="rk-note warn"><h3>Nothing moves</h3>Reporting records the problem only. The order stays in the queue as blocked until Sales resolves it.</div>' +
      R.actions([{ id: 'rel-send', label: 'Send report', kind: 'primary' }, { id: 'rel-cancel', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#rel-cancel').onclick = function () { history.back(); };
    var btn = body.querySelector('#rel-send');
    btn.onclick = function () {
      var d = body.querySelector('[data-desc]').value.trim();
      if (!d) { mToast('Describe the problem', 'err'); return; }
      if (offline()) { mToast('You’re offline — the report needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      API.post('/release-slips/orders/' + c.order.id + '/reports', { kind: kind, description: d, unit_identifier: code || null }, { idempotencyKey: key() })
        .then(function () { mToast('Reported to Sales'); go({ tab: 'blocked' }); }).catch(fail(btn, 'Send report'));
    };
  }

  MApp.route('so', async function (view, params) {
    var render = ++renderSerial, hash = location.hash;
    params = params || {};
    if (!can('inventory.adjust') && !can('orders.release')) {
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
