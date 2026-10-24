/* Parts clerk — repair-parts requests (Figma 83:*).
     83:16 queue (Pending / Shortage / Issued) · 83:68 review request + repair context · 83:158 select stock source · 83:206 pick the requested part ·
     83:295 review and confirm issue (83:247 redirects here) · 83:332 part issued · 83:375 reject · 83:416 stock unavailable ·
     83:452 revision required · 83:488 history
   Backend (/api/production): GET /repairs?status=requested, /repairs/:id/context, /repair-history;
   POST /repairs/:id/accept (issues stock; refuses a non-approved source, a pending revision, a
   different SKU or quantity — before any write), /reject, /shortage, /revision. A revision is
   approved by the requester or a supervisor, never by the clerk who proposed it. Issue and
   reject are online-only with an idempotency key: nothing is shown as issued that the server
   hasn't confirmed. This screen can't release production kits or adjust stock. An open request
   holds its part at one approved source (stock-holds.ts): "free" is what this request can take
   at a location — stock minus kit picks and other requests' holds.
   The requester (QC/QA) or a supervisor opens ?step=decide from the push to approve or reject a
   revision (POST /repairs/:id/revision/decide) — the only step open to them here.
   URLs: #/repairs[?tab=short|done] · ?step=history · ?id=<requestId>[&step=context|source|pick|
   review|confirm|done|reject|shortage|revision|decide] */
(function () {
  var R = window.RoleUI;
  var S = {};   // per request: { loc, scanned, qty, key, result }
  var renderSerial = 0, owner = null;
  var can = function (p) { return MApp.can(p); };
  var offline = function () { return navigator.onLine === false; };
  var go = function (extra) { MApp.go('repairs', extra || {}); };
  var page = function (view, node, title, sub) { return R.page(view, { role: 'parts', node: node, title: title, subtitle: sub }); };
  var st = function (id) { return S[id] || (S[id] = {}); };
  var short = function (s) { s = String(s || ''); return s.length > 12 ? '…' + s.slice(-7) : s; };
  var KIND = { replace: 'Repair · replace', add: 'Repair · add' };

  function when(ts) { return ts ? new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : '')) : null; }
  function clock(ts) { var d = when(ts); if (!d) return ''; return (d.toDateString() === new Date().toDateString() ? 'Today, ' : d.toLocaleDateString() + ', ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function key() { return 'rpr-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)); }
  function fail(btn, text) { return function (err) { mToast((err && err.message) || 'Failed', 'err'); if (btn) { btn.disabled = false; if (text) btn.textContent = text; } }; }
  function row(state, title, sub, attr) {
    var g = state === 'pass' ? '✓' : state === 'fail' ? '×' : state === 'warn' ? '!' : '○';
    return '<div class="rk-check-row"><button type="button"' + (attr ? ' ' + attr : ' disabled') + '><span class="rk-state ' + (state === 'warn' ? 'issue' : state) + '" aria-hidden="true">' + g + '</span>' +
      '<b>' + mEsc(title) + '</b><small>' + mEsc(sub) + '</small></button></div>';
  }

  function withRequest(view, id, fn) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    var hash = location.hash, account = mProductionDrafts.key('parts-owner'), render = renderSerial;
    function current() { return view.dataset.route === 'repairs' && hash === location.hash && render === renderSerial && account === mProductionDrafts.key('parts-owner'); }
    API.get('/production/repairs/' + id + '/context').then(function (c) { if (current()) fn(c); }).catch(function (err) {
      if (!current()) return;
      view.innerHTML = ''; view.appendChild(R.error(err, function () { withRequest(view, id, fn); }));
    });
  }

  /* ── Queue (83:16) ─────────────────────────────────────────────────────── */
  function queue(view, tab) {
    var body = page(view, '83:16', 'Parts requests', 'Repair and rework requests to process');
    body.innerHTML = R.skeleton(3);
    Promise.all([API.get('/production/repairs?status=requested'), API.get('/production/repair-history?state=blocked'), API.get('/production/repair-history?state=issued')])
      .then(function (r) {
        if (!body.isConnected) return;
        var open = r[0] || [], blockedIds = (r[1].rows || []).map(function (x) { return x.id; });
        var shortage = open.filter(function (x) { return blockedIds.indexOf(x.id) !== -1; });
        var pending = open.filter(function (x) { return blockedIds.indexOf(x.id) === -1; });
        var me = (MApp.getMe() || {}).id;
        var issued = (r[2].rows || []).filter(function (x) { return x.decided_by === me && when(x.decided_at) && when(x.decided_at).toDateString() === new Date().toDateString(); });
        tab = ['pending','short','done'].includes(tab) ? tab : pending.length ? 'pending' : shortage.length ? 'short' : 'pending';
        body.innerHTML =
          R.hero('Parts requests', open.length + ' request' + (open.length === 1 ? '' : 's'), pending.length + ' to review · ' + shortage.length + ' stock blocked') +
          '<div class="rk-segs" role="tablist">' +
            '<button type="button" data-tab="pending"' + (tab === 'pending' ? ' class="on"' : '') + '>Pending<b>' + pending.length + '</b></button>' +
            '<button type="button" data-tab="short" class="warn' + (tab === 'short' ? ' on' : '') + '">Shortage<b>' + shortage.length + '</b></button>' +
            '<button type="button" data-tab="done"' + (tab === 'done' ? ' class="on"' : '') + '>Issued</button></div>' +
          '<div class="rk-list" data-list></div>' +
          R.actions([{ id: 'rp-open', label: 'Open request', kind: 'primary' }, { id: 'rp-hist', label: 'History', kind: 'secondary' }]);
        function card(x, tone) {
          return '<button type="button" class="rk-card rk-unitcard" data-req="' + x.id + '"><b>' + mEsc(x.number) + '</b>' +
            '<span>' + mEsc((KIND[x.kind] || 'Repair') + ' · ' + short(x.unit_identifier || ('unit #' + x.unit_id)) + (x.job_order_number ? ' · ' + x.job_order_number : '')) + '</span>' +
            '<small' + (tone ? ' class="' + tone + '"' : '') + '>' + mEsc(x.component_name + ' · Qty ' + x.quantity + (tone ? ' · no approved stock' : '')) + '</small><i aria-hidden="true">›</i></button>';
        }
        function paint(which) {
          R.queueTab(body, which);
          var host = body.querySelector('[data-list]');
          var list = which === 'short' ? shortage : which === 'done' ? issued : pending;
          host.innerHTML = list.length ? list.map(function (x) { return which === 'done'
            ? '<div class="rk-card rk-unitcard" style="cursor:default"><b>' + mEsc(x.number) + '</b><span>' + mEsc((x.sku || x.component_name) + ' · Qty ' + x.quantity) + '</span><small>Issued · ' + mEsc(short(x.unit_identifier) + ' · ' + clock(x.decided_at)) + '</small><i></i></div>'
            : card(x, which === 'short' ? 'warn' : ''); }).join('')
            : '<div class="rk-empty">' + (which === 'done' ? 'Nothing issued by you today.' : which === 'short' ? 'No requests blocked by stock.' : shortage.length ? 'No requests in Pending. Open Shortage for stock-blocked requests.' : 'No parts requests waiting.') + '</div>';
          Array.prototype.forEach.call(host.querySelectorAll('[data-req]'), function (b) { b.onclick = function () { go({ id: b.dataset.req }); }; });
        }
        Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (b) {
          b.onclick = function () { Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (x) { x.classList.toggle('on', x === b); }); paint(b.dataset.tab); };
        });
        paint(tab);
        body.querySelector('#rp-open').onclick = function () { var first = pending[0] || shortage[0]; if (first) go({ id: first.id }); else mToast('No open requests'); };
        body.querySelector('#rp-hist').onclick = function () { go({ step: 'history' }); };
      }).catch(function (err) { if (!body.isConnected) return;body.innerHTML = ''; body.appendChild(R.error(err, function () { queue(view, tab); })); });
  }

  function contextChecks(c) {
    var r = c.request, u = c.unit || {}, ins = c.inspection;
    return '<div class="rk-checks">' +
      row(u.status === 'rework' ? 'pass' : 'warn', 'Unit and serial', (u.identifier || 'Unit #' + r.unit_id) + ' · ' + (u.status === 'rework' ? 'In repair' : 'status ' + (u.status || '?'))) +
      row(ins ? 'pass' : 'warn', 'Source inspection', ins ? (ins.stage === 2 ? 'QA' : 'QC') + '-' + ins.id + (ins.station ? ' · ' + ins.station : '') : 'No failed inspection found') +
      row(c.item ? 'pass' : 'fail', 'Requested part', c.item ? (c.item.sku || c.item.name) + ' · Qty ' + r.quantity : 'The requested item no longer exists') +
      row(c.duplicates.length ? 'warn' : 'pass', 'Other open requests', c.duplicates.length ? 'Also open: ' + c.duplicates.map(function (d) { return d.number; }).join(', ') : 'No duplicate active request') + '</div>';
  }

  /* ── Review request (83:68) ────────────────────────────────────────────── */
  function review(view, c) {
    var r = c.request, ins = c.inspection, pending = c.revision && c.revision.status === 'pending';
    var body = page(view, '83:68', 'Review request', 'Check the request and repair context, then choose stock');
    body.innerHTML =
      R.jobHead({ number: r.number, pill: { text: r.kind === 'replace' ? 'Replace part' : 'Add part', tone: 'muted' }, name: r.component_name,
        meta: 'Qty ' + r.quantity + (ins && ins.priority ? ' · ' + ins.priority : '') + (r.fault ? ' · fault: ' + r.fault : '') }) +
      R.field('Requested for unit', (r.unit_identifier || 'Unit #' + r.unit_id) + (r.job_order_number ? ' · ' + r.job_order_number : '')) +
      R.field('Reason', (ins && ins.remarks) || r.notes || '—') +
      (pending ? '<div class="rk-rev" role="status"><small>Revision waiting for approval — cannot issue yet</small><b>' + mEsc(c.revision.proposed_name + ' · Qty ' + c.revision.proposed_quantity) + '</b><span>' + mEsc(c.revision.reason) + '</span></div>' : '') +
      contextChecks(c) +
      (r.status === 'requested'
        ? R.actions((pending || !c.item ? [] : [{ id: 'rp-go', label: c.shortage ? 'Review stock shortage' : 'Choose stock source', kind: 'primary' }]).concat([{ id: 'rp-no', label: 'Reject request', kind: 'secondary' }]))
        : R.note('warn', 'This request is already ' + mEsc(r.status) + '.') + R.actions([{ id: 'rp-back', label: 'Back to queue', kind: 'secondary' }]));
    var g = body.querySelector('#rp-go'); if (g) g.onclick = function () { go({ id: r.id, step: c.shortage ? 'shortage' : 'source' }); };
    var n = body.querySelector('#rp-no'); if (n) n.onclick = function () { go({ id: r.id, step: 'reject' }); };
    var b = body.querySelector('#rp-back'); if (b) b.onclick = function () { go(); };
  }

  /* ── Select stock source (83:158) ──────────────────────────────────────── */
  function source(view, c) {
    var r = c.request, s = st(r.id);
    var free = function (l) { return l.free != null ? l.free : l.available; };
    var ok = function (l) { return l.approved && free(l) >= r.quantity; };
    // Start at the location already holding this request's part.
    if (!s.loc) { var held = c.hold && c.sources.filter(function (l) { return l.id === c.hold.location_id && ok(l); })[0]; var first = held || c.sources.filter(ok)[0]; s.loc = first ? first.id : null; }
    var body = page(view, '83:158', 'Select stock source', 'Choose an approved location with available stock');
    function paint() {
      var sel = c.sources.filter(function (l) { return l.id === s.loc; })[0];
      body.innerHTML =
        '<div class="rk-card rk-field"><small>' + mEsc(c.item ? c.item.sku || 'No SKU' : '') + '</small><b style="font-size:18px">' + mEsc(r.component_name) + '</b>' +
          '<span style="font-size:11px;color:var(--rk-meta)">Required: ' + r.quantity + ' unit' + (r.quantity === 1 ? '' : 's') + '</span></div>' +
        '<div class="rk-checks">' + c.sources.map(function (l) {
          var state = !l.approved ? 'fail' : free(l) >= r.quantity ? 'pass' : 'warn';
          var setAside = l.available - free(l);
          var sub = !l.approved ? 'Not an approved repair-parts source'
            : 'Available ' + l.available + (setAside > 0 ? ' · ' + setAside + ' held for others' : '') +
              (c.hold && c.hold.location_id === l.id ? ' · held for this request' : free(l) >= r.quantity ? ' · Pickable' : ' · not enough free');
          return row(state, l.name + (l.id === s.loc ? ' ✓' : ''), sub, ok(l) ? 'data-l="' + l.id + '"' : '');
        }).join('') + '</div>' +
        R.note('info', '<h3>Held, not deducted</h3>' + (c.hold ? 'This request holds ' + c.hold.quantity + ' at ' + mEsc(c.hold.location_name || 'its source') + ' so nothing else can take it. ' : '') +
          'Stock is deducted only at issue confirmation.') +
        R.actions([{ id: 'rp-go', label: sel ? 'Use ' + sel.name : 'Pick a source', kind: 'primary' }, { id: 'rp-short', label: 'Report shortage', kind: 'secondary' }]);
      Array.prototype.forEach.call(body.querySelectorAll('[data-l]'), function (b) { b.onclick = function () { s.loc = Number(b.dataset.l); paint(); }; });
      body.querySelector('#rp-go').disabled = !sel;
      body.querySelector('#rp-go').onclick = function () { go({ id: r.id, step: 'pick' }); };
      body.querySelector('#rp-short').onclick = function () { go({ id: r.id, step: 'shortage' }); };
    }
    paint();
  }

  /* ── Pick the requested part (83:206) ──────────────────────────────────── */
  function pick(view, c) {
    var r = c.request, s = st(r.id);
    if (!s.loc) { go({ id: r.id, step: 'source' }); return; }
    var src = c.sources.filter(function (l) { return l.id === s.loc; })[0] || {};
    var sku = c.item && c.item.sku;
    var body = page(view, '83:206', 'Pick the requested part', 'Scan the correct SKU from the selected bin');
    function paint(err) {
      body.innerHTML =
        '<button type="button" class="rk-identify"><span class="frame" aria-hidden="true"></span><b>Scan part or bin label</b><small>Source: ' + mEsc(src.name || '') + '</small></button>' +
        (s.scanned ? '<div class="rk-checks">' + row('pass', s.scanned, r.component_name + ' · Qty ' + r.quantity) + '</div>' : '') +
        (err ? '<div class="rk-block"><span class="t">! Different part</span><b>' + mEsc(err) + '</b><span>The request is for ' + mEsc(sku || r.component_name) + '. Use a formal revision to change it.</span></div>' : '') +
        (!sku ? R.note('warn', 'This part has no SKU to scan — confirm it by name and picked quantity.') : '') +
        '<label class="rk-card rk-field"><small>Picked quantity</small><input class="rk-input" data-qty type="number" min="1" inputmode="numeric" value="' + (s.qty || r.quantity) + '"></label>' +
        '<p class="rk-note warn" data-pick-error role="alert" hidden></p>' +
        R.note('info', '<h3>Exact-request rule</h3>A different SKU or excess quantity is blocked unless the request is formally revised.') +
        R.actions([{ id: 'rp-go', label: 'Review issue', kind: 'primary' }, { id: 'rp-rev', label: err ? 'Request revision' : 'Cancel', kind: 'secondary' }]);
      body.querySelector('.rk-identify').onclick = function () {
        if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
        mScanner.open({ title: 'Scan the part label', onResult: function (code) {
          code = String(code || '').trim();
          if (sku && code.toLowerCase() !== String(sku).toLowerCase()) { s.scanned = null; paint(code); return; }
          s.scanned = code; paint();
        } });
      };
      body.querySelector('#rp-rev').onclick = function () { if (err) go({ id: r.id, step: 'revision' }); else history.back(); };
      body.querySelector('#rp-go').onclick = function () {
        var input = body.querySelector('[data-qty]'), q = Number(input.value);
        if (sku && !s.scanned) { mToast('Scan the part label first', 'err'); return; }
        if (!input.value.trim() || !Number.isInteger(q) || q !== r.quantity) {
          var error = body.querySelector('[data-pick-error]');
          error.textContent = 'Enter the exact ' + r.quantity + ' requested. A different quantity needs an approved revision.';
          error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'rp-pick-error'); error.id = 'rp-pick-error'; input.focus(); return;
        }
        s.qty = q; go({ id: r.id, step: 'confirm' });
      };
    }
    paint();
  }

  /* ── Confirm stock issue (83:295) — online-only, idempotent ────────────── */
  function confirm(view, c) {
    var r = c.request, s = st(r.id);
    var src = c.sources.filter(function (l) { return l.id === s.loc; })[0];
    if (!src || !s.qty) { go({ id: r.id, step: 'source' }); return; }
    var body = page(view, '83:295', 'Confirm stock issue', 'Final inventory action for this request');
    body.innerHTML =
      '<div class="rk-block ok"><span class="t">✓ Ready to issue</span><b class="lg">' + mEsc(r.component_name + ' · Qty ' + r.quantity) + '</b>' +
        '<span style="color:var(--rk-title);font-weight:500">' + mEsc(r.number + ' · ' + src.name) + '</span><span>For ' + mEsc((r.unit_identifier || 'Unit #' + r.unit_id) + ' · repair') + '</span></div>' +
      R.field('Stock after issue', src.available + ' on hand → ' + (src.available - r.quantity) + ' remaining') +
      R.field('Repair handoff', (c.inspection ? (c.inspection.stage === 2 ? 'QA' : 'QC') + ' repair' : 'Repair') + (r.kind === 'replace' && r.return_to_damage ? ' · old part to damage' : '')) +
      R.check('rp-ok', 'I picked and verified the exact requested item') +
      R.note('info', '<h3>Stock changes here</h3>Confirmation deducts ' + r.quantity + ' from ' + mEsc(src.name) + ' and marks the request Issued together. The repair station can then continue.') +
      R.actions([{ id: 'rp-post', label: 'Confirm issue', kind: 'ink' }, { id: 'rp-cancel', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#rp-cancel').onclick = function () { go({ id: r.id }); };
    var btn = body.querySelector('#rp-post'), chk = body.querySelector('#rp-ok');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function () {
      if (offline()) { mToast('You’re offline — issuing stock needs a connection. Nothing was issued.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Issuing…';
      s.key = s.key || key();
      API.post('/production/repairs/' + r.id + '/accept', { from_location_id: s.loc, scanned_code: s.scanned || null, picked_quantity: s.qty },
        { idempotencyKey: s.key }).then(function (res) {
        S[r.id] = { result: { at: new Date().toISOString(), source: src.name, req: res, local: API.syncLocal(res) } };
        go({ id: r.id, step: 'done' });
      }).catch(function (err) {
        var d = err && err.data;
        if (d && (d.blocked === 'sku' || d.blocked === 'quantity')) { mToast(d.error, 'err'); go({ id: r.id, step: 'pick' }); return; }
        if (d && d.blocked === 'revision') { mToast(d.error, 'err'); go({ id: r.id }); return; }
        fail(btn, 'Confirm issue')(err);
      });
    };
  }

  /* ── Part issued (83:332) ──────────────────────────────────────────────── */
  function done(view, c) {
    var r = c.request, res = S[r.id] && S[r.id].result;
    if (!res || r.status !== 'accepted') { go({ id: r.id }); return; }
    var body = page(view, '83:332', 'Part issued', 'Stock and request records are updated');
    var me = (MApp.getMe() || {}).full_name || 'You';
    body.innerHTML =
      '<div class="rk-result' + (res.local ? ' queued' : '') + '"><i aria-hidden="true">' + (res.local ? '⏳' : '✓') + '</i><b>' + (res.local ? 'Repair part issued — on the site PC' : 'Repair part issued') + '</b><span>' + mEsc((c.item && c.item.sku ? c.item.sku : r.component_name) + ' · Qty ' + r.quantity) + '</span>' +
        '<span style="font-weight:400;color:var(--rk-meta)">For ' + mEsc(r.unit_identifier || 'unit #' + r.unit_id) + '</span></div><div data-syncw></div>' +
      R.field('Inventory transaction', r.number + ' · issued from ' + res.source) +
      R.field('Issued by', me + ' · ' + clock(res.at)) +
      R.actions([{ id: 'rp-next', label: 'Next request', kind: 'primary' }, { id: 'rp-rec', label: 'View record', kind: 'secondary' }]) +
      R.note('info', '<h3>Repair notified</h3>The repair station can continue the tracked repair; the unit can be re-inspected once no request is open.');
    body.querySelector('[data-syncw]').appendChild(R.syncWatch(res.local));
    body.querySelector('#rp-next').onclick = function () { go(); };
    body.querySelector('#rp-rec').onclick = function () { MApp.go('record', { unit: r.unit_id }); };
  }

  /* ── Reject parts request (83:375) ─────────────────────────────────────── */
  function reject(view, c) {
    var r = c.request;
    var body = page(view, '83:375', 'Reject parts request', 'A clear reason is required');
    var REASONS = ['Duplicate / invalid request', 'Wrong part requested', 'Not needed for this repair', 'Other'];
    body.innerHTML =
      R.field('Request', r.number + ' · ' + r.component_name) +
      '<label class="rk-card rk-field"><small>Rejection reason</small><select data-reason>' + REASONS.map(function (x, i) {
        return '<option' + (i === 0 && c.duplicates.length ? ' selected' : '') + '>' + mEsc(x) + '</option>'; }).join('') + '</select></label>' +
      '<label class="rk-card rk-field"><small>Details</small><textarea rows="3" maxlength="900" data-det placeholder="What the requester should know">' +
        mEsc(c.duplicates.length ? 'Another active request (' + c.duplicates.map(function (d) { return d.number; }).join(', ') + ') already covers this unit and part.' : '') + '</textarea></label>' +
      '<div class="rk-note warn"><h3>Rejection consequence</h3>No stock is deducted. The requester receives the reason.</div>' +
      R.check('rp-ok', 'I reviewed the linked unit and repair context') +
      R.actions([{ id: 'rp-post', label: 'Reject request', kind: 'danger' }, { id: 'rp-back', label: 'Back', kind: 'secondary' }]);
    body.querySelector('#rp-back').onclick = function () { history.back(); };
    var btn = body.querySelector('#rp-post'), chk = body.querySelector('#rp-ok');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function () {
      var reason = body.querySelector('[data-reason]').value, det = body.querySelector('[data-det]').value.trim();
      if (reason === 'Other' && !det) { mToast('Describe the reason', 'err'); return; }
      if (offline()) { mToast('You’re offline — rejecting needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Rejecting…';
      API.post('/production/repairs/' + r.id + '/reject', { warehouse_remarks: reason + (det ? ' — ' + det : '') }, { idempotencyKey: key() })
        .then(function () { mToast(r.number + ' rejected'); go(); }).catch(fail(btn, 'Reject request'));
    };
  }

  /* ── Requested stock unavailable (83:416) ──────────────────────────────── */
  function shortage(view, c) {
    var r = c.request;
    var body = page(view, '83:416', 'Requested stock unavailable', 'Do not substitute or partially issue informally');
    var approved = c.sources.filter(function (l) { return l.approved; });
    body.innerHTML =
      '<div class="rk-block"><span class="t">! No approved stock available</span><b class="lg">' + mEsc((c.item && c.item.sku || r.component_name) + ' · Required ' + r.quantity) + '</b>' +
        '<span>' + mEsc(approved.length ? approved.map(function (l) {
          var f = l.free != null ? l.free : l.available;
          return l.name + ': ' + f + ' free' + (l.available > f ? ' (' + (l.available - f) + ' held for others)' : '');
        }).join(' · ') : 'No approved source location') + '</span></div>' +
      '<div class="rk-note warn"><h3>No stock change occurred</h3>The request remains open and blocked until stock arrives or it is formally revised.</div>' +
      R.field('Suggested action', 'Wait for replenishment or an approved request revision') +
      R.actions([{ id: 'rp-esc', label: 'Escalate shortage', kind: 'primary' }, { id: 'rp-back', label: 'Back', kind: 'secondary' }]) +
      R.actions([{ id: 'rp-rev', label: 'Propose a revision', kind: 'secondary' }]);
    body.querySelector('#rp-back').onclick = function () { history.back(); };
    body.querySelector('#rp-rev').onclick = function () { go({ id: r.id, step: 'revision' }); };
    var btn = body.querySelector('#rp-esc');
    btn.onclick = function () {
      if (offline()) { mToast('You’re offline — escalating needs a connection.', 'err'); return; }
      btn.disabled = true;
      API.post('/production/repairs/' + r.id + '/shortage', { note: 'No approved stock for ' + r.quantity + ' × ' + r.component_name }, { idempotencyKey: key() })
        .then(function () { mToast('Shortage escalated — the request stays open'); go({ tab: 'short' }); }).catch(fail(btn));
    };
  }

  /* ── Revision required (83:452) ────────────────────────────────────────── */
  function revision(view, c) {
    var r = c.request, pend = c.revision && c.revision.status === 'pending';
    var body = page(view, '83:452', 'Revision required', 'Quantity or substitute must be approved upstream');
    var picked = null;
    body.innerHTML =
      '<div class="rk-rev"><small>Requested</small><b>' + mEsc((c.item && c.item.sku || r.component_name) + ' · Qty ' + r.quantity) + '</b>' +
        (pend ? '<span>Proposed: ' + mEsc(c.revision.proposed_name + ' · Qty ' + c.revision.proposed_quantity) + ' — waiting for approval</span>' : '<span data-prop>Proposed: same part</span>') + '</div>' +
      (pend ? '' :
        '<div class="rk-card rk-field"><small>Proposed part (leave empty to keep the same part)</small><div data-picker></div></div>' +
        '<label class="rk-card rk-field"><small>Proposed quantity</small><input class="rk-input" data-qty type="number" min="1" inputmode="numeric" value="' + r.quantity + '"></label>' +
        '<label class="rk-card rk-field"><small>Revision reason</small><textarea rows="3" maxlength="1000" data-reason placeholder="e.g. Original SKU unavailable; compatible revision proposed"></textarea></label>') +
      R.note('info', '<h3>Parts clerk cannot self-approve</h3>The requester or an authorized supervisor must approve the revised SKU / quantity before issue.') +
      R.actions(pend ? [{ id: 'rp-back', label: 'Back', kind: 'secondary' }] : [{ id: 'rp-send', label: 'Send revision request', kind: 'primary' }, { id: 'rp-back', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#rp-back').onclick = function () { history.back(); };
    if (pend) return;
    if (window.mItemPicker) {
      var pk = mItemPicker({ label: 'Part', onPick: function (it) { picked = it; body.querySelector('[data-prop]').textContent = 'Proposed: ' + (it.sku || it.name); } });
      body.querySelector('[data-picker]').appendChild(pk.el);
    }
    var btn = body.querySelector('#rp-send');
    btn.onclick = function () {
      var qty = parseInt(body.querySelector('[data-qty]').value, 10) || 0, reason = body.querySelector('[data-reason]').value.trim();
      if (!reason) { mToast('Give the revision reason', 'err'); return; }
      if (qty < 1) { mToast('Enter a quantity', 'err'); return; }
      if (offline()) { mToast('You’re offline — the revision needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      API.post('/production/repairs/' + r.id + '/revision', { component_item_id: picked ? picked.id : null, quantity: qty, reason: reason }, { idempotencyKey: key() })
        .then(function () { mToast('Revision sent for approval'); go({ id: r.id }); }).catch(fail(btn, 'Send revision request'));
    };
  }

  /* ── Approve or reject a revision (requester / supervisor; extends 83:452) ─ */
  function decide(view, c) {
    var r = c.request, v = c.revision, pend = v && v.status === 'pending';
    var me = MApp.getMe() || {};
    var body = page(view, '83:452', 'Approve revision', r.number + ' · ' + short(r.unit_identifier));
    if (!pend) {
      body.innerHTML = R.note('info', v ? 'This revision was ' + mEsc(v.status) + '.' : 'There is no revision waiting for a decision.') +
        R.actions([{ id: 'rp-back', label: 'Back', kind: 'secondary' }]);
      body.querySelector('#rp-back').onclick = function () { history.back(); };
      return;
    }
    var mine = v.proposed_by === me.id;
    body.innerHTML =
      '<div class="rk-rev"><small>Requested</small><b>' + mEsc((c.item && c.item.sku || r.component_name) + ' · Qty ' + r.quantity) + '</b>' +
        '<span>Proposed: ' + mEsc(v.proposed_name + ' · Qty ' + v.proposed_quantity) + '</span></div>' +
      R.field('Reason from ' + (v.proposed_by_name || 'the parts clerk'), v.reason) +
      (mine ? R.note('warn', 'You proposed this revision — someone else must decide it.')
        : '<label class="rk-card rk-field"><small>Note (optional)</small><textarea rows="2" maxlength="500" data-note></textarea></label>') +
      R.note('info', '<h3>Nothing moves</h3>Approving changes what the warehouse issues; the part is issued only when the parts clerk confirms it.') +
      R.actions(mine ? [{ id: 'rp-back', label: 'Back', kind: 'secondary' }]
        : [{ id: 'rp-yes', label: 'Approve revision', kind: 'primary' }, { id: 'rp-noo', label: 'Reject revision', kind: 'secondary' }]);
    var back = body.querySelector('#rp-back'); if (back) back.onclick = function () { history.back(); };
    var send = function (btn, approve) {
      if (offline()) { mToast('You’re offline — the decision needs a connection.', 'err'); return; }
      btn.disabled = true;
      var note = body.querySelector('[data-note]');
      API.post('/production/repairs/' + r.id + '/revision/decide', { approve: approve, note: note && note.value.trim() || null }, { idempotencyKey: key() })
        .then(function () { mToast(approve ? 'Revision approved' : 'Revision rejected'); go({ id: r.id, step: 'decide', t: Date.now() }); })
        .catch(fail(btn));
    };
    var yes = body.querySelector('#rp-yes'); if (yes) yes.onclick = function () { send(yes, true); };
    var no = body.querySelector('#rp-noo'); if (no) no.onclick = function () { send(no, false); };
  }

  /* ── Repair-parts history (83:488), read-only ──────────────────────────── */
  function hist(view) {
    var body = page(view, '83:488', 'Repair-parts history', 'Search requests, issues and rejection reasons');
    var state = '', seq = 0, timer = null;
    body.innerHTML =
      '<label class="rk-card rk-field"><small>Search records</small><input class="rk-input" data-q placeholder="Request, serial, job order or SKU" autocomplete="off"></label>' +
      '<div class="rk-segs" data-chips></div><div class="rk-list" data-list>' + R.skeleton(2) + '</div>' +
      R.note('info', '<h3>Read-only audit history</h3>Corrections use controlled inventory transactions; issued records are not deleted.');
    var input = body.querySelector('[data-q]');
    function run() {
      var mine = ++seq;
      API.get('/production/repair-history?q=' + encodeURIComponent(input.value.trim()) + (state ? '&state=' + state : '')).then(function (r) {
        if (mine !== seq) return;
        body.querySelector('[data-chips]').innerHTML =
          '<button type="button" data-s="issued"' + (state === 'issued' ? ' class="on"' : '') + '>Issued<b>' + r.counts.issued + '</b></button>' +
          '<button type="button" data-s="rejected" class="warn' + (state === 'rejected' ? ' on' : '') + '">Rejected<b>' + r.counts.rejected + '</b></button>' +
          '<button type="button" data-s="blocked" class="re' + (state === 'blocked' ? ' on' : '') + '">Blocked<b>' + r.counts.blocked + '</b></button>';
        Array.prototype.forEach.call(body.querySelectorAll('[data-s]'), function (b) { b.onclick = function () { state = state === b.dataset.s ? '' : b.dataset.s; run(); }; });
        body.querySelector('[data-list]').innerHTML = r.rows.length ? r.rows.map(function (x) {
          var what = x.state === 'issued' ? 'Issued' : x.state === 'rejected' ? 'Rejected · ' + (x.warehouse_remarks || '') : x.state === 'blocked' ? 'Blocked · no approved stock' : x.state === 'requested' ? 'Pending' : x.state;
          return '<button type="button" class="rk-card rk-unitcard" data-req="' + x.id + '"><b>' + mEsc(x.number) + '</b><span>' + mEsc((x.sku || x.component_name) + ' · Qty ' + x.quantity) + '</span>' +
            '<small' + (x.state === 'rejected' ? ' class="warn"' : '') + '>' + mEsc(what + ' · ' + short(x.unit_identifier)) + '</small><i aria-hidden="true">›</i></button>';
        }).join('') : '<div class="rk-empty">No matching records.</div>';
        Array.prototype.forEach.call(body.querySelectorAll('[data-req]'), function (b) { b.onclick = function () { go({ id: b.dataset.req }); }; });
      }).catch(function (err) { if (mine !== seq) return; var h = body.querySelector('[data-list]'); h.innerHTML = ''; h.appendChild(R.error(err, run)); });
    }
    input.oninput = function () { clearTimeout(timer); timer = setTimeout(run, 300); };
    run();
  }

  MApp.route('repairs', function (view, params) {
    ++renderSerial;
    var account = mProductionDrafts.key('parts-owner');
    if (owner !== account) { S = {}; owner = account; }
    params = params || {};
    var clerk = can('production.repairs');
    var decider = can('production.inspect_qc') || can('production.inspect_qa') || can('production.approve');
    if (params.id && params.step === 'decide' && (clerk || decider)) {
      // The server checks it is the requester or a supervisor, never the proposer.
      return withRequest(view, Number(params.id), function (c) { decide(view, c); });
    }
    if (!clerk) {
      view.innerHTML = '<div class="m-error">You don’t have permission to process parts requests.</div>';
      return;
    }
    if (params.step === 'history') return hist(view);
    if (!params.id) return queue(view, params.tab);
    withRequest(view, Number(params.id), function (c) {
      var step = params.step;
      if (step === 'done') return done(view, c);
      if (c.request.status !== 'requested') return review(view, c);
      if (c.revision && c.revision.status === 'pending' && !['reject','revision'].includes(step)) return review(view, c);
      if (step === 'context') review(view, c);
      else if (step === 'source') source(view, c);
      else if (step === 'pick') pick(view, c);
      else if (step === 'review') confirm(view, c);
      else if (step === 'confirm') confirm(view, c);
      else if (step === 'reject') reject(view, c);
      else if (step === 'shortage') shortage(view, c);
      else if (step === 'revision') revision(view, c);
      else review(view, c);
    });
  });
})();
