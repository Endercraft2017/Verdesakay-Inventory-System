/* RTS clerk — ready-to-sell intake (Figma 74:*). A unit that passed final inspection waits
   "receivable" until it is recorded into a finished-goods storage location.
     74:16 queue (Ready / Issues / Recorded) · 74:68 identify · 74:104 verify · 74:145 stock
     details · 74:186 add more (same SKU + location) · 74:234 review · 74:280 existing stock
     record (duplicate) · 74:316 confirm · 74:356 recorded · 74:399 location unavailable /
     choose location · 74:442 product-data mismatch report · 74:483 finished-goods lookup
   Backend: GET /rts/queue, POST /rts/check (dry run), GET /rts/lookup; the posting is still
   POST /job-orders/:id/products-in, which re-runs the same duplicate / hold / location rules
   atomically (src/modules/manufacturing/rts.ts). Posting is online-only with an idempotency
   key — never queued. Exact receipt attempts survive restart, and site-PC saves remain
   pending until their original sync command confirms.
   A mismatch report is a production issue (category "Product-data mismatch") that holds the
   unit out of stock until it is resolved. Non-serialized batches keep a quantity screen.
   URLs: #/receiving[?tab=issues|done][&id=<jobOrderId>] · ?step=identify · ?step=lookup[&q=]
         · ?unit=<id>[&step=stock|location|group|review|dup|confirm|mismatch] · ?step=done
         · ?batch=<id> */
(function () {
  var R = window.RoleUI;
  var MISMATCH = 'Product-data mismatch';
  var DRAFT_KEY = 'vds_rts_mismatch_';
  var draft = null;   // unsubmitted selection; immutable receipt attempts live in mRtsRecovery
  var last = null;    // last /rts/queue response
  var draftOwner = null, routeSerial = 0;

  var can = function (p) { return MApp.can(p); };
  var offline = function () { return navigator.onLine === false; };
  var go = function (extra) { MApp.go('receiving', extra || {}); };
  var page = function (view, node, title, sub) { return R.page(view, { role: 'rts', node: node, title: title, subtitle: sub }); };
  var key = function () { return 'rts-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)); };
  var label = function (u) { return u.identifier || ('UNIT-' + u.id); };

  function legacyStage(u){return u.intake_status==='cancelled'?'Intake cancelled — not RTS':u.status==='scrapped'?'Scrapped — not RTS':u.status==='passed'?'QC and QA passed — ready for receiving':u.status==='hold'?'QA hold':u.status==='failed'?'Failed inspection — not RTS':u.status==='rework'?(u.stage===0?'QC reinspection required':'QA recheck required'):u.qc_result==='pass'?'Awaiting QA':u.qa_result==='pass'?'Awaiting QC':'Awaiting QC and QA';}
  function when(ts) {
    if (!ts) return null;
    return new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : ''));
  }
  function clock(ts) {
    var d = when(ts); if (!d) return '';
    return (d.toDateString() === new Date().toDateString() ? 'today, ' : d.toLocaleDateString() + ', ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function time(ts) { var d = when(ts); return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function ago(ts) { var d = when(ts); if (!d) return ''; var m = Math.max(0, Math.round((Date.now() - d) / 60000)); return m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; }
  var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

  function loadQueue() {
    var owner = mProductionDrafts.key('rts-owner');
    return new Promise(function (resolve, reject) {
      var settled = false, timer = setTimeout(function () { settled = true; reject(new Error('RTS queue timed out. Count unknown; retry the live check.')); }, 20000);
      API.get('/rts/queue').then(function (q) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (owner !== mProductionDrafts.key('rts-owner')) { reject(new Error('Account or server changed. Reopen RTS.')); return; }
        last = q; resolve(q);
      }, function (err) { if (settled) return; settled = true; clearTimeout(timer); reject(err); });
    });
  }
  /** Storage locations that can hold ready-to-sell stock (trucks are transit, refused server-side too). */
  function storage() { return mLocations.list().filter(function (l) { return l.type !== 'truck'; }); }
  function buildTag(u) { return u.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built'; }
  function locName(id) { var l = mLocations.list().filter(function (x) { return x.id === id; })[0]; return l ? mLocations.path(l) : '—'; }
  function defaultLoc(u) {
    var s = storage();
    if (u && u.output_location_id && s.some(function (l) { return l.id === u.output_location_id; })) return u.output_location_id;
    var d = s.filter(function (l) { return l.is_default; })[0] || s[0];
    return d ? d.id : null;
  }
  function unitsOf(ids) { return ids.map(function (id) { return (last ? last.units : []).filter(function (u) { return u.id === id; })[0]; }).filter(Boolean); }
  function fail(btn, text) { return function (err) { mToast((err && err.message) || 'Failed', 'err'); if (btn) { btn.disabled = false; if (text) btn.textContent = text; } }; }

  /** Load the queue + locations, then hand the named unit (must be waiting for RTS) to fn. */
  function withUnit(view, unitId, fn) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    var hash = location.hash, owner = mProductionDrafts.key('rts-owner'), render = routeSerial;
    function current(){return location.hash===hash&&view.dataset.route==='receiving'&&render===routeSerial&&owner===mProductionDrafts.key('rts-owner');}
    Promise.all([loadQueue(), mLocations.load(true)]).then(function () {
      if (!current()) return;
      var u = last.units.filter(function (x) { return x.id === unitId; })[0];
      if (!u) {
        var body = page(view, '74:68', 'Identify finished unit', '');
        body.innerHTML = R.note('warn', 'This unit isn’t waiting for RTS recording — it may still be in inspection, or already recorded.') +
          R.actions([{ id: 'rts-look', label: 'Look it up', kind: 'primary' }, { id: 'rts-back', label: 'Back to queue', kind: 'secondary' }]);
        body.querySelector('#rts-look').onclick = function () { go({ step: 'lookup' }); };
        body.querySelector('#rts-back').onclick = function () { go(); };
        return;
      }
      if (!draft || draft.anchor !== u.id) draft = { anchor: u.id, ids: [u.id], location_id: defaultLoc(u) };
      fn(u);
    }).catch(function (err) { if(!current())return;view.innerHTML = ''; view.appendChild(R.error(err, function () { withUnit(view, unitId, fn); })); });
  }

  /* ── Queue (74:16) ─────────────────────────────────────────────────────── */
  function queue(view, tab, joFilter) {
    var body = page(view, '74:16', 'Ready-to-sell intake', 'QA-passed units waiting for stock entry');
    body.innerHTML = '<div data-recovery></div>' + R.skeleton(3);
    mRtsRecovery.cards(body.querySelector('[data-recovery]'));
    loadQueue().then(function (q) {
      if (!body.isConnected) return;
      var mine = function (x) { return !joFilter || x.job_order_id === Number(joFilter); };
      var units = q.units.filter(mine), batches = q.batches.filter(mine);
      var ready = units.filter(function (u) { return !u.hold; }), held = units.filter(function (u) { return u.hold; });
      var models = {}; ready.forEach(function (u) { models[u.product_item_id] = (models[u.product_item_id] || 0) + 1; });
      var prio = ready.filter(function (u) { return u.priority > 0; }).length;
      var n = ready.length + batches.length;
      tab = tab || 'ready';
      body.innerHTML =
        '<div data-recovery></div>' + R.hero('Awaiting RTS record', n + ' ' + (n === 1 ? 'unit' : 'units'), Object.keys(models).length + ' model' + (Object.keys(models).length === 1 ? '' : 's') + ' · ' + prio + ' priority') +
        '<div class="rk-segs" role="tablist">' +
          '<button type="button" data-tab="ready"' + (tab === 'ready' ? ' class="on"' : '') + '>Ready<b>' + n + '</b></button>' +
          '<button type="button" data-tab="issues" class="warn' + (tab === 'issues' ? ' on' : '') + '">Issues<b>' + held.length + '</b></button>' +
          '<button type="button" data-tab="done"' + (tab === 'done' ? ' class="on"' : '') + '>Recorded</button></div>' +
        '<div class="rk-list" data-list></div>' +
        (joFilter ? R.note('info', 'Showing one job order only. <button type="button" class="rk-back" data-all style="padding:0">Show all</button>') : '') +
        R.actions([{id:'rts-legacy',label:'Enter or resume pre-system unit',kind:'secondary'}, { id: 'rts-scan', label: 'Scan unit or batch', kind: 'primary' }, { id: 'rts-look', label: 'Stock lookup', kind: 'secondary' }]);
      body.querySelector('#rts-legacy').onclick=function(){go({step:'legacy'});};
      function card(attr, title, line, meta, tone) {
        return '<button type="button" class="rk-card rk-unitcard" ' + attr + '><b>' + mEsc(title) + '</b><span>' + mEsc(line) + '</span>' +
          '<small' + (tone ? ' class="' + tone + '"' : '') + '>' + mEsc(meta) + '</small><i aria-hidden="true">›</i></button>';
      }
      function paint(which) {
        var host = body.querySelector('[data-list]');
        if (which === 'done') {
          var recorded=q.recorded.filter(mine);
          host.innerHTML = recorded.length ? recorded.map(function (r) {
            return '<div class="rk-card rk-unitcard" style="cursor:default"><b>' + mEsc(r.identifier || (r.batch_number + ' · ' + r.quantity + ' pcs')) + '</b>' +
              '<span>' + mEsc(r.product_name + ' · ' + (r.location_name || '—')) + '</span><small>Ready to sell · ' + mEsc(r.receipt_number + ' · ' + time(r.created_at)) + '</small><i></i></div>';
          }).join('') : '<div class="rk-empty">Nothing recorded by you today.</div>';
          return;
        }
        if (!joFilter && which !== 'done') {
          var groups={};(which==='issues'?held:ready).concat(which==='issues'?[]:batches).forEach(function(u){var g=groups[u.job_order_id]||(groups[u.job_order_id]={u:u,count:0});g.count+=u.remaining_qty||1;});
          host.innerHTML=Object.keys(groups).map(function(id){var g=groups[id];return card('data-jo="'+id+'"',g.u.job_order_number,g.u.product_name,g.count+' eligible unit(s)'+(g.u.intake_origin==='legacy'?' · Pre-system legacy intake':''));}).join('') || '<div class="rk-empty">No ongoing job orders for RTS receiving.</div>';
          if((q.intakes||[]).length)host.innerHTML+='<h3>Pre-system intakes</h3>'+q.intakes.map(function(u){return card('data-intake="'+u.id+'"',u.number+' · '+u.identifier,u.product_name,legacyStage(u));}).join('');
          host.querySelectorAll('[data-jo]').forEach(function(b){b.onclick=function(){go({id:b.dataset.jo,tab:which});};});
          host.querySelectorAll('[data-intake]').forEach(function(b){b.onclick=function(){go({id:b.dataset.intake,step:'legacy-status'});};});return;
        }
        if (which === 'issues') {
          host.innerHTML = held.length ? held.map(function (u) {
            return card('data-unit="' + u.id + '"', label(u), u.product_name + ' · ' + u.job_order_number, 'Mismatch reported ' + ago(u.hold.created_at) + ' ago · waiting for correction', 'warn');
          }).join('') : '<div class="rk-empty">No units on hold.</div>';
        } else {
          host.innerHTML = (ready.length || batches.length) ? ready.map(function (u) {
            var meta = u.order_number ? 'Allocated order ' + u.order_number
              : models[u.product_item_id] > 1 ? 'Same model · eligible to group'
              : !u.output_location_id ? 'Awaiting finished-goods location' : 'Waiting ' + ago(u.updated_at);
            return card('data-unit="' + u.id + '"', label(u), u.product_name + ' · ' + buildTag(u) + (u.final_pass ? ' · QA passed ' + time(u.final_pass.created_at) : ''), (u.priority > 0 ? 'Priority · ' : '') + meta);
          }).join('') + batches.map(function (b) {
            return card('data-batch="' + b.id + '"', b.number, b.product_name + ' · ' + b.remaining_qty + ' to record', 'Non-serialized batch · ' + b.job_order_number);
          }).join('') : '<div class="rk-empty">Nothing waiting for stock entry. Units appear here once they pass final inspection.</div>';
        }
        Array.prototype.forEach.call(host.querySelectorAll('[data-unit]'), function (b) { b.onclick = function () { go({ unit: b.dataset.unit }); }; });
        Array.prototype.forEach.call(host.querySelectorAll('[data-batch]'), function (b) { b.onclick = function () { go({ batch: b.dataset.batch }); }; });
      }
      Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (b) {
        b.onclick = function () { Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (x) { x.classList.toggle('on', x === b); }); paint(b.dataset.tab); };
      });
      paint(tab);
      mRtsRecovery.cards(body.querySelector('[data-recovery]'));
      body.querySelector('#rts-scan').onclick = function () { go({ step: 'identify' }); };
      body.querySelector('#rts-look').onclick = function () { go({ step: 'lookup' }); };
      var all = body.querySelector('[data-all]'); if (all) all.onclick = function () { go(); };
    }).catch(function (err) { if (!body.isConnected) return; body.innerHTML = R.note('warn', 'Live RTS queue unavailable — count unknown. Saved stock entries remain available.'); body.appendChild(R.error(err, function () { queue(view, tab, joFilter); })); var recovery = document.createElement('div'); recovery.setAttribute('data-recovery', ''); body.appendChild(recovery); mRtsRecovery.cards(recovery); });
  }

  /* ── Identify (74:68) ──────────────────────────────────────────────────── */
  function identify(view) {
    var body = page(view, '74:68', 'Identify finished stock', 'Find a unit or batch; scan its attached sticker before recording');
    body.innerHTML =
      '<button type="button" class="rk-identify"><span class="frame" aria-hidden="true"></span><b>Scan the unit or batch QR label</b><small>Only QA-passed units can be recorded.</small></button>' +
      '<label class="rk-card rk-field"><small>Find a unit or batch</small><input class="rk-input" data-q placeholder="Enter serial or batch number" autocomplete="off"></label>' +
      R.actions([{ id: 'rts-find', label: 'Find unit', kind: 'primary' }, { id: 'rts-cancel', label: 'Cancel', kind: 'secondary' }]) +
      R.note('info', '<h3>Duplicate protection</h3>The app checks both workflow stage and finished-goods inventory before allowing a record.');
    Array.prototype.forEach.call(body.querySelectorAll('.rk-btn'), function (b) { b.classList.add('center'); });
    function find(code) {
      var t = String(code || '').trim().toLowerCase();
      if (!t) { mToast('Enter or scan a serial', 'err'); return; }
      loadQueue().then(function (q) {
        var hits = q.units.filter(function (u) { return ('vds:unit:'+u.id) === t || label(u).trim().toLowerCase() === t; });
        if(hits.length>1)throw new Error('Ambiguous older label. Reprint the specific unit QR from its record.');
        var hit = hits[0];
        var batchHit = q.batches.filter(function (b) { return ('vds:batch:'+b.id) === t || String(b.number).trim().toLowerCase() === t; })[0];
        if (hit && batchHit) throw new Error('Ambiguous label. Open the intended record and verify its sticker.');
        if (hit) { go({ unit: hit.id }); return; }
        if (batchHit) { go({ batch: batchHit.id }); return; }
        // Not waiting for RTS — is it already in finished goods? Then show why it can't post again.
        return API.get('/rts/lookup?q=' + encodeURIComponent(code)).then(function (r) {
          var rec = r.units.filter(function (u) { return label(u).trim().toLowerCase() === t; })[0];
          if (rec && rec.state !== 'hold') { go({ step: 'dup', found: rec.id }); return; }
          mToast('No QA-passed unit matches ' + code + ' — it may still be in inspection', 'err');
        });
      }).catch(fail());
    }
    body.querySelector('.rk-identify').onclick = function () {
      if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
      mScanner.open({ title: 'Scan the serial label', onResult: find });
    };
    body.querySelector('#rts-find').onclick = function () { find(body.querySelector('[data-q]').value); };
    body.querySelector('#rts-cancel').onclick = function () { history.back(); };
  }

  /* ── Verify (74:104) ───────────────────────────────────────────────────── */
  function verify(view, u) {
    var body = page(view, '74:104', 'Verify finished unit', 'Confirm QA approval and product identity');
    body.innerHTML =
      R.jobHead({ tone: u.hold ? '' : 'ok', number: label(u), pill: { text: u.hold ? 'On hold' : 'QA passed', tone: u.hold ? 'warn' : 'ok' },
        name: u.product_name, meta: [u.job_order_number, u.batch_identifier].filter(Boolean).join(' · ') }) +
      R.field('QA record', u.final_pass ? (u.final_pass.inspector_name || '—') + ' · Passed ' + clock(u.final_pass.created_at) : 'Passed final inspection') +
      R.field('Product code', u.sku || '—') +
      (u.hold
        ? '<div class="rk-block warn"><span class="t">! Mismatch reported</span><span>' + mEsc(u.hold.description) + '</span>' +
          '<span>The unit stays out of ready-to-sell stock until QA / inventory control resolve the report.</span></div>' +
          R.actions([{ id: 'rts-back', label: 'Back to queue', kind: 'secondary' }])
        : R.note('info', '<h3>Physical match required</h3>The model, color, serial label and included package must match this record.') +
          R.actions([{ id: 'rts-go', label: 'Confirm and continue', kind: 'primary' }, { id: 'rts-mis', label: 'Report mismatch', kind: 'secondary' }]));
    if (u.hold) { body.querySelector('#rts-back').onclick = function () { go({ tab: 'issues' }); }; return; }
    body.querySelector('#rts-go').onclick = function () { go({ unit: u.id, step: 'stock' }); };
    body.querySelector('#rts-mis').onclick = function () { go({ unit: u.id, step: 'mismatch' }); };
  }

  /* ── Stock details (74:145) ────────────────────────────────────────────── */
  function stock(view, u) {
    var body = page(view, '74:145', 'Stock details', 'Set the sellable record and storage location');
    var loc = mLocations.list().filter(function (l) { return l.id === draft.location_id; })[0];
    body.innerHTML =
      R.field('Product / SKU', (u.sku ? u.sku + ' · ' : '') + u.product_name) +
      '<button type="button" class="rk-card rk-field rk-pickrow" data-loc><small>Finished-goods location</small><b>' +
        mEsc(loc ? loc.name + ' · ' + cap(loc.type) : 'Choose a location') + '</b></button>' +
      R.field('Sellable condition', 'QA approved') +
      R.note('info', '<h3>Location validation</h3>The location must be finished-goods storage — not a truck or other transit location.') +
      R.actions([{ id: 'rts-go', label: 'Continue', kind: 'primary' }, { id: 'rts-loc', label: 'Choose location', kind: 'secondary' }]);
    var pick = function () { go({ unit: u.id, step: 'location' }); };
    body.querySelector('[data-loc]').onclick = pick;
    body.querySelector('#rts-loc').onclick = pick;
    var btn = body.querySelector('#rts-go');
    btn.onclick = function () {
      if (!draft.location_id) { pick(); return; }
      btn.disabled = true; btn.textContent = 'Checking…';
      API.post('/rts/check', { unit_ids: [u.id], location_id: draft.location_id }).then(function (r) {
        if (r.location_error) { draft.locErr = r.location_error; go({ unit: u.id, step: 'location', err: 1 }); return; }
        if (r.blockers.length) { draft.blockers = r.blockers; go({ unit: u.id, step: 'dup' }); return; }
        go({ unit: u.id, step: 'group' });
      }).catch(fail(btn, 'Continue'));
    };
  }

  /* ── Location unavailable / choose (74:399) ────────────────────────────── */
  function location(view, u, err) {
    var bad = err && draft.locErr;
    var body = page(view, '74:399', bad ? 'Location unavailable' : 'Choose location', 'Choose a valid finished-goods space');
    var sel = bad ? null : draft.location_id;
    var opts = storage().filter(function (l) { return !bad || l.id !== draft.location_id; });
    body.innerHTML =
      (bad ? '<div class="rk-block warn"><span class="t">! ' + mEsc(locName(draft.location_id)) + ' can’t take this stock</span>' +
        '<b>Required space: ' + draft.ids.length + ' unit' + (draft.ids.length === 1 ? '' : 's') + '</b><span>' + mEsc(draft.locErr) + '</span>' +
        '<span>No inventory transaction has been created.</span></div>' : '') +
      '<div class="rk-checks" data-opts></div>' +
      R.note('info', '<h3>Location integrity</h3>Do not record a temporary or production-floor location as ready-to-sell storage.') +
      R.actions([{ id: 'rts-use', label: 'Use selected location', kind: 'primary' }, { id: 'rts-cancel', label: 'Cancel', kind: 'secondary' }]);
    // A location with a capacity shows its room; one without room for this posting can't be picked.
    var need = draft.ids.length || 1;
    var room = function (l) { return l.capacity ? Math.max(0, l.capacity - (l.total_units || 0)) : null; };
    function paint() {
      body.querySelector('[data-opts]').innerHTML = opts.length ? opts.map(function (l) {
        var r = room(l), full = r !== null && r < need;
        return '<div class="rk-check-row"><button type="button"' + (full ? ' disabled' : ' data-l="' + l.id + '"') + '><span class="rk-state ' + (full ? 'issue' : l.id === sel ? 'pass' : '') + '" aria-hidden="true">' + (full ? '!' : l.id === sel ? '✓' : '○') + '</span>' +
          '<b>' + mEsc(mLocations.path(l)) + '</b><small>' + mEsc(cap(l.type) + (l.is_default ? ' · default' : '') + (u.output_location_id === l.id ? ' · job order output' : '') +
            (r === null ? '' : full ? ' · full (room for ' + r + ')' : ' · room for ' + r)) + '</small></button></div>';
      }).join('') : '<div class="rk-empty">No storage locations set up. Ask an admin to add one.</div>';
      Array.prototype.forEach.call(body.querySelectorAll('[data-l]'), function (b) { b.onclick = function () { sel = Number(b.dataset.l); paint(); }; });
    }
    paint();
    body.querySelector('#rts-cancel').onclick = function () { history.back(); };
    body.querySelector('#rts-use').onclick = function () {
      if (!sel) { mToast('Pick a location', 'err'); return; }
      draft.location_id = sel; draft.locErr = null;
      go({ unit: u.id, step: 'stock' });
    };
  }

  /* ── Add more units, same SKU + location (74:186) ──────────────────────── */
  function group(view, u) {
    var body = page(view, '74:186', 'Add more QA-passed units', 'Optional · same SKU and destination only');
    var eligible = last.units.filter(function (x) { return !x.hold && x.product_item_id === u.product_item_id && (x.build_mode || 'assembled') === (u.build_mode || 'assembled'); });
    function paint() {
      var chosen = unitsOf(draft.ids);
      var others = eligible.filter(function (x) { return draft.ids.indexOf(x.id) === -1; });
      body.innerHTML =
        R.jobHead({ tone: 'ok', number: u.sku || u.product_name, name: chosen.length + ' unit' + (chosen.length === 1 ? '' : 's') + ' selected', meta: locName(draft.location_id) }) +
        '<div class="rk-checks">' + chosen.map(function (x) {
          return '<div class="rk-check-row"><button type="button" data-rm="' + x.id + '"' + (x.id === draft.anchor ? ' disabled' : '') + '><span class="rk-state pass" aria-hidden="true">✓</span>' +
            '<b>' + mEsc(label(x)) + '</b><small>QA passed · verified' + (x.id === draft.anchor ? '' : ' · tap to remove') + '</small></button></div>';
        }).join('') + others.map(function (x) {
          return '<div class="rk-check-row"><button type="button" data-add="' + x.id + '"><span class="rk-state" aria-hidden="true">○</span>' +
            '<b>' + mEsc(label(x)) + '</b><small>Same SKU · tap to add</small></button></div>';
        }).join('') +
          '<div class="rk-check-row"><button type="button" data-scan><span class="rk-state" aria-hidden="true">○</span><b>Scan another unit</b><small>Must match SKU and selected destination</small></button></div></div>' +
        R.note('info', '<h3>Serialized separately</h3>Grouping only shares stock details. Every serial creates its own inventory transaction.') +
        R.actions([{ id: 'rts-rev', label: 'Review ' + chosen.length + ' unit' + (chosen.length === 1 ? '' : 's'), kind: 'primary' }, { id: 'rts-one', label: 'Record one only', kind: 'secondary' }]);
      Array.prototype.forEach.call(body.querySelectorAll('[data-rm]'), function (b) { b.onclick = function () { draft.ids = draft.ids.filter(function (i) { return i !== Number(b.dataset.rm); }); paint(); }; });
      Array.prototype.forEach.call(body.querySelectorAll('[data-add]'), function (b) { b.onclick = function () { draft.ids.push(Number(b.dataset.add)); paint(); }; });
      body.querySelector('[data-scan]').onclick = function () {
        if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
        mScanner.open({ title: 'Scan another unit', onResult: function (code) {
          var t = String(code || '').trim().toLowerCase();
          var hit = eligible.filter(function (x) { return ('vds:unit:'+x.id)===t || String(x.identifier || '').trim().toLowerCase() === t; })[0];
          if (!hit) { mToast(code + ': not a QA-passed unit of this SKU', 'err'); return; }
          if (draft.ids.indexOf(hit.id) === -1) draft.ids.push(hit.id);
          paint();
        } });
      };
      body.querySelector('#rts-rev').onclick = function () { go({ unit: u.id, step: 'review' }); };
      body.querySelector('#rts-one').onclick = function () { draft.ids = [draft.anchor]; go({ unit: u.id, step: 'review' }); };
    }
    paint();
  }

  /* ── Review before recording (74:234) ──────────────────────────────────── */
  function review(view, u) {
    var chosen = unitsOf(draft.ids);
    var body = page(view, '74:234', 'Review before recording', 'Confirm every unit and inventory effect');
    body.innerHTML =
      '<div class="rk-hero navy"><small>Ready-to-sell posting</small><b>' + chosen.length + ' serialized unit' + (chosen.length === 1 ? '' : 's') + '</b><span>' + mEsc(locName(draft.location_id)) + '</span></div>' +
      '<div class="rk-checks">' + chosen.map(function (x) {
        return '<div class="rk-check-row"><button type="button" disabled><span class="rk-state pass" aria-hidden="true">✓</span><b>' + mEsc(label(x)) + '</b>' +
          '<small>' + mEsc(x.job_order_number + (x.final_pass ? ' · QA passed ' + time(x.final_pass.created_at) : '')) + '</small></button></div>';
      }).join('') + '</div>' +
      '<div class="rk-card rk-field"><small>Inventory effect</small><b style="color:var(--rk-green-text)">+' + chosen.length + ' on-hand · Ready to sell</b></div>' +
      R.note('info', '<h3>Posting creates audit entries</h3>Each unit receives its own stock transaction, actor, timestamp and source QA record.') +
      R.actions([{ id: 'rts-check', label: 'Run final duplicate check', kind: 'primary' }, { id: 'rts-back', label: 'Back', kind: 'secondary' }]);
    body.querySelector('#rts-back').onclick = function () { history.back(); };
    var btn = body.querySelector('#rts-check');
    btn.onclick = function () {
      btn.disabled = true; btn.textContent = 'Checking…';
      API.post('/rts/check', { unit_ids: draft.ids, location_id: draft.location_id }).then(function (r) {
        if (r.location_error) { draft.locErr = r.location_error; go({ unit: u.id, step: 'location', err: 1 }); return; }
        if (r.blockers.length) { draft.blockers = r.blockers; go({ unit: u.id, step: 'dup' }); return; }
        go({ unit: u.id, step: 'confirm' });
      }).catch(fail(btn, 'Run final duplicate check'));
    };
  }

  /* ── Existing stock record found (74:280) ──────────────────────────────── */
  function dupView(view, b, fromScan) {
    var TITLES = { recorded: 'Duplicate serial blocked', duplicate_serial: 'Duplicate serial blocked', held: 'Unit on hold', not_ready: 'Not ready for RTS', not_found: 'Unit not found' };
    var body = page(view, '74:280', b.reason === 'held' || b.reason === 'not_ready' ? 'Unit can’t be recorded' : 'Existing stock record found',
      'This unit cannot be posted a second time');
    var ex = b.existing || {};
    body.innerHTML =
      '<div class="rk-block"><span class="t">! ' + mEsc(TITLES[b.reason] || 'Blocked') + '</span><b class="lg">' + mEsc(b.identifier || ('Unit #' + b.unit_id)) + '</b>' +
        '<span>' + mEsc(ex.location_name ? 'Already recorded in ' + ex.location_name + (ex.received_at ? ' ' + clock(ex.received_at) : '') + '.' : b.message) + '</span></div>' +
      (ex.receipt_number ? R.field('Existing transaction', ex.receipt_number + (ex.received_by_name ? ' · by ' + ex.received_by_name : '')) : '') +
      '<div class="rk-note warn"><h3>No stock change was made</h3>' + (fromScan ? 'This serial is already in finished goods.' : 'Remove this serial from the group.') +
        ' If the existing record is wrong, request a controlled correction.</div>' +
      R.actions([{ id: 'rts-rm', label: fromScan ? 'Back to queue' : 'Remove duplicate', kind: fromScan ? 'secondary' : 'danger' },
        { id: 'rts-rec', label: 'View record', kind: 'secondary' }]);
    body.querySelector('#rts-rec').onclick = function () { MApp.go('record', { unit: ex.unit_id || b.unit_id }); };
    body.querySelector('#rts-rm').onclick = function () {
      if (fromScan || !draft) { go(); return; }
      draft.ids = draft.ids.filter(function (i) { return i !== b.unit_id; });
      draft.blockers = (draft.blockers || []).filter(function (x) { return x.unit_id !== b.unit_id; });
      if (!draft.ids.length) { draft = null; go(); return; }
      if (draft.anchor === b.unit_id) draft.anchor = draft.ids[0];
      go({ unit: draft.anchor, step: draft.blockers.length ? 'dup' : 'review' });
    };
  }
  function dupFound(view, unitId) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    API.post('/rts/check', { unit_ids: [unitId] }).then(function (r) {
      if (!r.blockers.length) { go({ unit: unitId }); return; }
      dupView(view, r.blockers[0], true);
    }).catch(function (err) { view.innerHTML = ''; view.appendChild(R.error(err, function () { dupFound(view, unitId); })); });
  }

  /* ── Confirm stock entry (74:316) — online-only, idempotent ────────────── */
  function confirm(view, u) {
    var chosen = unitsOf(draft.ids);
    var body = page(view, '74:316', 'Confirm stock entry', 'This action creates finished-goods inventory');
    body.innerHTML =
      '<div class="rk-block ok"><span class="t">✓ ' + chosen.length + ' unit' + (chosen.length === 1 ? '' : 's') + ' cleared</span>' +
        '<b class="lg">' + mEsc(label(chosen[0] || u) + (chosen.length > 1 ? ' + ' + (chosen.length - 1) + ' more' : '')) + '</b>' +
        '<span style="color:var(--rk-title);font-weight:500">' + mEsc(locName(draft.location_id)) + '</span><span>Status after posting: Ready to sell</span></div>' +
      R.field('Build state', buildTag(u)) + R.field('Source', 'QA pass · ' + cap(clock((chosen[0] || u).final_pass && (chosen[0] || u).final_pass.created_at) || 'final inspection')) +
      '<div data-label-verification></div>' + R.actions([{ id: 'rts-print-labels', label: 'Print QR stickers', kind: 'secondary' }]) +
      R.check('rts-ok', 'I verified the physical unit and location') +
      R.note('info', '<h3>After confirmation</h3>Sales availability and finished-goods on-hand update from the same transaction.') +
      R.actions([{ id: 'rts-post', label: 'Record as ready to sell', kind: 'navy' }, { id: 'rts-back', label: 'Back', kind: 'secondary' }]);
    body.querySelector('#rts-back').onclick = function () { history.back(); };
    var btn = body.querySelector('#rts-post'), chk = body.querySelector('#rts-ok');
    btn.disabled = true;
    var stickers = mScanner.verification(body.querySelector('[data-label-verification]'), chosen.map(function(x){return {code:'VDS:UNIT:'+x.id,aliases:last.units.filter(function(v){return label(v).toLowerCase()===label(x).toLowerCase();}).length===1?[label(x)]:[]};}), function (ok) { btn.disabled = !chk.checked || !ok; });
    body.querySelector('#rts-print-labels').onclick = function () { Promise.all(chosen.map(function (x) { return API.get('/production/record?unit=' + x.id); })).then(mProductionPrint.printUnitRecords).catch(fail()); };
    chk.onchange = function () { btn.disabled = !chk.checked || !stickers.complete(); };
    btn.onclick = function () {
      if (!chk.checked || !stickers.complete()) { mToast('Scan every attached QR sticker first.', 'err'); return; }
      if (offline()) { mToast('You’re offline — recording stock needs a connection. Nothing was saved.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Recording…';
      body.querySelectorAll('button,input').forEach(function (el) { el.disabled = true; });
      post(chosen, btn);
    };
  }

  /** Grouping remains one exact Products In call per job order. Persist the whole
      group before the first POST so confirmations and unfinished entries survive restart. */
  function post(chosen, btn) {
    var byJo = {}, hash = location.hash, owner = mProductionDrafts.key('rts-owner');
    chosen.forEach(function (x) { (byJo[x.job_order_id] = byJo[x.job_order_id] || []).push(x); });
    var entries = Object.keys(byJo).map(function (jo) { return { jobId: Number(jo), jobNumber: byJo[jo][0].job_order_number,
      path: '/job-orders/' + jo + '/products-in', payload: { location_id: draft.location_id, unit_ids: byJo[jo].map(function (x) { return x.id; }) }, labels: byJo[jo].map(label) }; });
    if (!entries.length) { fail(btn, 'Record as ready to sell')(new Error('Select at least one unit.')); return; }
    submit('rts-unit:' + draft.anchor, entries, locName(draft.location_id), hash, owner, btn);
  }
  function submit(slot, entries, locationName, hash, owner, btn) {
    var record;
    mRtsRecovery.begin(slot, entries, locationName).then(function (created) {
      record = created.record;
      if (created.existing) return;
      return mRtsRecovery.send(record);
    }).then(function () {
      if (location.hash !== hash || owner !== mProductionDrafts.key('rts-owner')) return;
      draft = draft || {}; draft.recovery = record;
      var refused = record.operation.entries.length === 1 && record.operation.entries[0].state === 'rejected' && record.operation.entries[0].errorData;
      if (refused && refused.blockers && refused.blockers.length) {
        dupView(document.getElementById('m-view'), refused.blockers[0], true);
        var body = document.getElementById('m-view').querySelector('.rk-body');
        body.appendChild(mEl(R.actions([{ id: 'rts-review-saved', label: 'Review saved receipt', kind: 'secondary' }])));
        body.querySelector('#rts-review-saved').onclick = function () { mRtsRecovery.go(record); };
        return;
      }
      mRtsRecovery.go(record);
    }).catch(function (err) {
      if (location.hash !== hash || owner !== mProductionDrafts.key('rts-owner')) return;
      if (record) { mToast(err.message, 'err'); mRtsRecovery.go(record); }
      else { mToast(err.message || 'Unable to retain stock entry; nothing submitted.', 'err'); go(); }
    });
  }
  function doneView() { if (draft && draft.recovery) mRtsRecovery.go(draft.recovery); else go(); }

  /* ── Product-data mismatch (74:442) ────────────────────────────────────── */
  function mismatch(view, u) {
    var body = page(view, '74:442', 'Report product-data mismatch', 'Changes need controlled production identity');
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY + u.id) || '{}') || {}; } catch (ignore) {}
    var TYPES = ['Model / color does not match physical unit', 'Serial label unreadable or different', 'Wrong product code / SKU',
      'Missing accessory or package item', 'Other'];
    body.innerHTML =
      '<label class="rk-card rk-field"><small>Mismatch type</small><select data-type>' + TYPES.map(function (t) {
        return '<option' + (saved.type === t ? ' selected' : '') + '>' + mEsc(t) + '</option>'; }).join('') + '</select></label>' +
      R.field('System record', u.product_name + (u.sku ? ' · ' + u.sku : '') + ' · ' + label(u)) +
      '<label class="rk-card rk-field"><small>Physical unit</small><input class="rk-input" data-phys maxlength="200" placeholder="What the unit actually shows" value="' + mEsc(saved.phys || '') + '"></label>' +
      '<label class="rk-card rk-field"><small>Details</small><textarea rows="3" maxlength="1500" data-det placeholder="What differs, where">' + mEsc(saved.det || '') + '</textarea></label>' +
      '<div class="rk-note warn"><h3>Routes to QA and inventory control</h3>The unit stays out of ready-to-sell stock until corrected and revalidated.</div>' +
      R.actions([{ id: 'rts-send', label: 'Send mismatch report', kind: 'primary' }, { id: 'rts-save', label: 'Save draft', kind: 'secondary' }]);
    function values() {
      return { type: body.querySelector('[data-type]').value, phys: body.querySelector('[data-phys]').value.trim(), det: body.querySelector('[data-det]').value.trim() };
    }
    body.querySelector('#rts-save').onclick = function () {
      try { localStorage.setItem(DRAFT_KEY + u.id, JSON.stringify(values())); mToast('Draft saved on this device'); } catch (ignore) { mToast('Could not save the draft', 'err'); }
    };
    var btn = body.querySelector('#rts-send');
    btn.onclick = function () {
      var v = values();
      if (!v.phys || !v.det) { mToast('Describe the physical unit and what differs', 'err'); return; }
      if (offline()) { mToast('You’re offline — the report needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      API.post('/production-issues', {
        job_order_id: u.job_order_id, unit_id: u.id, category: MISMATCH, severity: 'high',
        description: v.type + ' — system: ' + u.product_name + (u.sku ? ' (' + u.sku + ')' : '') + '; physical: ' + v.phys + '. ' + v.det,
      }).then(function () {
        try { localStorage.removeItem(DRAFT_KEY + u.id); } catch (ignore) {}
        draft = null;
        mToast('Mismatch reported — the unit is on hold');
        go({ tab: 'issues' });
      }).catch(fail(btn, 'Send mismatch report'));
    };
  }

  /* ── Finished-goods lookup (74:483), read-only ─────────────────────────── */
  function lookup(view, q0) {
    var body = page(view, '74:483', 'Finished-goods lookup', 'Search recorded units and audit history');
    var status = '';
    body.innerHTML =
      '<label class="rk-card rk-field"><small>Search inventory</small><input class="rk-input" data-q placeholder="Serial, SKU, transaction or location" value="' + mEsc(q0 || '') + '" autocomplete="off"></label>' +
      '<div class="rk-segs" data-chips></div><div class="rk-list" data-list>' + R.skeleton(2) + '</div>' +
      R.note('info', '<h3>Read-only audit lookup</h3>Corrections use a controlled request so stock quantities and history stay reconciled.');
    var input = body.querySelector('[data-q]'), timer = null, seq = 0;
    function run() {
      var mine = ++seq;
      API.get('/rts/lookup?q=' + encodeURIComponent(input.value.trim()) + (status ? '&status=' + status : '')).then(function (r) {
        if (mine !== seq) return;
        body.querySelector('[data-chips]').innerHTML =
          '<button type="button" data-s="ready"' + (status === 'ready' ? ' class="on"' : '') + '>Ready to sell<b>' + r.counts.ready + '</b></button>' +
          '<button type="button" data-s="allocated" class="blue' + (status === 'allocated' ? ' on' : '') + '">Allocated<b>' + r.counts.allocated + '</b></button>' +
          '<button type="button" data-s="hold" class="warn' + (status === 'hold' ? ' on' : '') + '">On hold<b>' + r.counts.hold + '</b></button>';
        Array.prototype.forEach.call(body.querySelectorAll('[data-s]'), function (b) { b.onclick = function () { status = status === b.dataset.s ? '' : b.dataset.s; run(); }; });
        body.querySelector('[data-list]').innerHTML = r.units.length ? r.units.map(function (x) {
          var st = x.state === 'ready' ? 'Ready to sell' + (x.received_at ? ' · recorded ' + time(x.received_at) : '')
            : x.state === 'allocated' ? 'Allocated' + (x.order_number ? ' · ' + x.order_number : '') : 'On hold · mismatch reported';
          return '<button type="button" class="rk-card rk-unitcard" data-u="' + x.id + '"><b>' + mEsc(x.identifier || 'Unit #' + x.id) + '</b>' +
            '<span>' + mEsc([x.sku || x.product_name, x.location_name].filter(Boolean).join(' · ')) + '</span>' +
            '<small' + (x.state === 'hold' ? ' class="warn"' : x.state === 'allocated' ? ' class="blue"' : '') + '>' + mEsc(st) + '</small><i aria-hidden="true">›</i></button>';
        }).join('') : '<div class="rk-empty">No recorded units match.</div>';
        Array.prototype.forEach.call(body.querySelectorAll('[data-u]'), function (b) { b.onclick = function () { MApp.go('record', { unit: b.dataset.u }); }; });
      }).catch(function (err) { if (mine !== seq) return; var host = body.querySelector('[data-list]'); host.innerHTML = ''; host.appendChild(R.error(err, run)); });
    }
    input.oninput = function () { clearTimeout(timer); timer = setTimeout(run, 300); };
    run();
  }

  /* ── Non-serialized batch (kept from Products In; styled as 74:145) ────── */
  function batch(view, batchId) {
    var body = page(view, '74:145', 'Record batch', 'Non-serialized output · one quantity');
    body.innerHTML = R.skeleton(2);
    Promise.all([loadQueue(), mLocations.load(true)]).then(function () {
      if (!body.isConnected) return;
      var b = last.batches.filter(function (x) { return x.id === batchId; })[0];
      if (!b) { body.innerHTML = '<div class="rk-empty">Nothing left to record on this batch.</div>'; return; }
      var locId = defaultLoc(b);
      body.innerHTML =
        R.jobHead({ tone: 'ok', number: b.number, pill: { text: b.remaining_qty + ' left', tone: 'ok' }, name: b.product_name, meta: b.job_order_number + (b.sku ? ' · ' + b.sku : '') }) +
        '<div class="rk-stepper"><small>Quantity to record</small><div class="row"><button type="button" data-dec aria-label="Fewer">−</button>' +
          '<input type="number" min="1" max="' + b.remaining_qty + '" value="' + b.remaining_qty + '" inputmode="numeric"><button type="button" data-inc aria-label="More">+</button></div>' +
          '<p>' + b.remaining_qty + ' produced and not yet in stock</p></div>' +
        '<label class="rk-card rk-field"><small>Finished-goods location</small><select data-loc>' + storage().map(function (l) {
          return '<option value="' + l.id + '"' + (l.id === locId ? ' selected' : '') + '>' + mEsc(mLocations.path(l)) + '</option>'; }).join('') + '</select></label>' +
        '<label class="rk-card rk-field"><small>Note (optional)</small><input class="rk-input" data-note maxlength="500" placeholder="Count discrepancy, condition…"></label>' +
        R.field('Build state', buildTag(b)) + '<div data-label-verification></div>' + R.actions([{ id: 'rts-print-labels', label: 'Print batch QR sticker', kind: 'secondary' }]) + R.check('rts-ok', 'I counted the quantity and checked the location') +
        R.actions([{ id: 'rts-post', label: 'Record as ready to sell', kind: 'navy' }, { id: 'rts-back', label: 'Back', kind: 'secondary' }]);
      var input = body.querySelector('.rk-stepper input');
      var clamp = function (v) { return Math.max(1, Math.min(b.remaining_qty, v || 1)); };
      body.querySelector('[data-dec]').onclick = function () { input.value = clamp(+input.value - 1); };
      body.querySelector('[data-inc]').onclick = function () { input.value = clamp(+input.value + 1); };
      body.querySelector('#rts-back').onclick = function () { history.back(); };
      var btn = body.querySelector('#rts-post'), chk = body.querySelector('#rts-ok');
      btn.disabled = true;
      var stickers = mScanner.verification(body.querySelector('[data-label-verification]'), [{code:'VDS:BATCH:'+b.id,aliases:[b.number]}], function (ok) { btn.disabled = !chk.checked || !ok; });
      body.querySelector('#rts-print-labels').onclick = function () { API.get('/production/record?batch=' + b.id).then(mProductionPrint.printBatchRecord).catch(fail()); };
      chk.onchange = function () { btn.disabled = !chk.checked || !stickers.complete(); };
      btn.onclick = function () {
        if (!chk.checked || !stickers.complete()) { mToast('Scan the attached batch QR sticker first.', 'err'); return; }
        if (offline()) { mToast('You’re offline — recording stock needs a connection. Nothing was saved.', 'err'); return; }
        var qty = Number(input.value), loc = Number(body.querySelector('[data-loc]').value);
        if (!Number.isSafeInteger(qty) || qty <= 0 || qty > b.remaining_qty) { mToast('Enter a whole quantity from 1 to ' + b.remaining_qty + '.', 'err'); return; }
        if (!storage().some(function (l) { return l.id === loc; })) { mToast('Choose a finished-goods storage location.', 'err'); return; }
        btn.disabled = true; btn.textContent = 'Recording…';
        body.querySelectorAll('button,input,select').forEach(function (el) { el.disabled = true; });
        submit('rts-batch:' + b.id, [{ jobId: b.job_order_id, jobNumber: b.job_order_number,
          path: '/job-orders/' + b.job_order_id + '/products-in', payload: { location_id: loc, batch_id: b.id, quantity: qty,
          notes: body.querySelector('[data-note]').value.trim() || null }, labels: [b.number + ' · ' + qty + ' pcs'] }], locName(loc), location.hash, mProductionDrafts.key('rts-owner'), btn);
      };
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { batch(view, batchId); })); });
  }

  async function legacyIntake(view) {
    var hash=location.hash, s=await mWorkflow.draft('legacy-intake');
    if(hash!==location.hash)return;
    if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    var context=await API.get('/rts/legacy/context');if(hash!==location.hash||!mWorkflow.owns(s))return;
    var b=s.batch,body=page(view,'74:145','Enter pre-system unit','Existing physical unit — mandatory QC then QA before RTS');
    body.innerHTML=R.note('info','This inspection intake does not create available stock or consume a production kit. Record one physical unit per intake. After QC and QA pass, print, attach and scan its sticker at Products In.')+
      '<label class="rk-card rk-field"><small>Finished product</small><select data-legacy-product><option value="">Choose product</option>'+context.products.map(function(p){return '<option value="'+p.id+'">'+mEsc(p.name)+'</option>';}).join('')+'</select></label><div data-legacy-location></div>'+
      '<label class="rk-card rk-field"><small>Physical unit identifier</small><input data-legacy-identifier maxlength="120" placeholder="Distinct identifier physically marked on this unit"></label>'+
      '<label class="rk-card rk-field"><small>Recorded unit cost</small><input data-legacy-cost type="number" min="0" step="0.01"></label>'+
      '<label class="rk-card rk-field"><small>Why this unit predates the system</small><textarea data-legacy-note minlength="5" maxlength="1000"></textarea></label><div data-legacy-photo></div>'+
      R.check('legacy-confirm','This is an existing physical unit, not already entered in the system')+R.actions([{id:'legacy-submit',label:'Send to QC, then QA',kind:'primary'},{id:'legacy-back',label:'Back to job orders',kind:'secondary'}]);
    var product=body.querySelector('[data-legacy-product]'),identifier=body.querySelector('[data-legacy-identifier]'),cost=body.querySelector('[data-legacy-cost]'),note=body.querySelector('[data-legacy-note]');
    var loc=mLocations.select({label:'Physical storage location',locations:context.locations});body.querySelector('[data-legacy-location]').appendChild(loc.el);
    product.value=b.product_item_id||'';identifier.value=b.identifier||'';cost.value=b.unit_cost==null?'':b.unit_cost;note.value=b.notes||'';if(b.location_id)loc.select.value=b.location_id;
    if(!b.intake_key)b.intake_key='legacy-'+crypto.randomUUID();
    function collect(){b.product_item_id=Number(product.value)||null;b.identifier=identifier.value.trim();b.unit_cost=cost.value;b.notes=note.value.trim();b.location_id=Number(loc.select.value)||null;return mWorkflow.save(s);}
    var saving=Promise.resolve();function persist(){saving=saving.catch(function(){}).then(collect);saving.catch(function(e){mToast(e.message,'err');});return saving;}
    product.onchange=function(){var item=context.products.find(function(p){return p.id===Number(product.value);});cost.value=item?item.unit_cost||0:'';persist();};identifier.oninput=cost.oninput=note.oninput=loc.select.onchange=persist;
    var busy=false;var photos=mPhoto.picker({max:1,initial:s.rows.map(function(r){return r.file;}),onBusy:function(v){busy=v;body.querySelector('#legacy-submit').disabled=v;},onChange:function(files){s.rows=files.map(function(file){return {file:file,identifier:'legacy-unit.jpg'};});persist();}});body.querySelector('[data-legacy-photo]').appendChild(photos);
    body.querySelector('#legacy-back').onclick=function(){go();};
    body.querySelector('#legacy-submit').onclick=async function(){var btn=this;try{if(busy)return;btn.disabled=true;await persist();if(!b.product_item_id||!b.location_id||!b.identifier||b.notes.length<5||cost.value===''||!Number.isFinite(Number(b.unit_cost))||Number(b.unit_cost)<0)throw new Error('Choose the product and location, enter a distinct identifier, unit cost and intake reason.');if(!s.rows.length)throw new Error('Photograph this physical unit.');if(!body.querySelector('#legacy-confirm').checked)throw new Error('Confirm this unit has not already been entered.');
      body.querySelectorAll('input,textarea,select,button').forEach(function(el){el.disabled=true;});await mWorkflow.start(s,{path:'/rts/legacy',multipart:true,payload:{product_item_id:b.product_item_id,location_id:b.location_id,identifier:b.identifier,notes:b.notes,unit_cost:Number(b.unit_cost),intake_key:b.intake_key},title:'Legacy unit '+b.identifier+' — awaiting QC and QA',successLabel:'Intake confirmed — not RTS stock',role:'rts',reviewRoute:'receiving',reviewParams:{step:'legacy-status'},resultParam:'id'});mWorkflow.paint(view,s);
    }catch(e){mToast(e.message,'err');if(body.isConnected)body.querySelectorAll('input,textarea,select,button').forEach(function(el){el.disabled=false;});}};
  }
  async function legacyStatus(view,id){var q=await loadQueue();if(!view.isConnected)return;var intake=(q.intakes||[]).find(function(i){return i.id===Number(id);});var body=page(view,'74:16','Pre-system unit intake','Inspection history remains separate from manufacture');body.innerHTML=intake?R.jobHead({number:intake.number,name:intake.product_name,meta:intake.identifier})+R.field('Status',legacyStage(intake))+R.note('info','Stock becomes available only after both inspections and final Products In receipt.')+R.actions((intake.status==='passed'?[{id:'legacy-receive',label:'Open eligible units',kind:'primary'}]:[]).concat([{id:'legacy-list',label:'Back to job orders',kind:'secondary'}])):R.note('info','This intake is no longer pending. Review recorded receipts and stock history.')+R.actions([{id:'legacy-list',label:'Back to job orders',kind:'secondary'}]);body.querySelector('#legacy-list').onclick=function(){go();};var receive=body.querySelector('#legacy-receive');if(receive)receive.onclick=function(){go({id:intake.id});};}

  MApp.route('receiving', async function (view, params) {
    var render = ++routeSerial, hash = location.hash;
    params = params || {};
    if (!can('production.receive')) {
      view.innerHTML = '<div class="m-error">You don’t have permission to record ready-to-sell stock.</div>';
      return;
    }
    var owner = mProductionDrafts.key('rts-owner');
    if (draftOwner !== owner) { draft = null; last = null; draftOwner = owner; }
    var unitId = params.unit && Number(params.unit), step = params.step;
    if (step === 'recovery') return mRtsRecovery.open(view, params.record);
    if (unitId || params.batch) {
      try {
        var saved = await mRtsRecovery.saved();
        if (render !== routeSerial || location.hash !== hash || owner !== mProductionDrafts.key('rts-owner')) return;
        var existing = saved.find(function (s) { return mRtsRecovery.matches(s, [unitId], Number(params.batch) || null); });
        if (existing) { mRtsRecovery.go(existing); return; }
      } catch (err) { view.innerHTML = ''; view.appendChild(R.error(err, function () { MApp.render(); })); return; }
    }
    if (step === 'legacy' || step === 'legacy-status') { try { return await (step==='legacy'?legacyIntake(view):legacyStatus(view,params.id)); } catch(e){view.innerHTML='';view.appendChild(R.error(e,function(){MApp.render();}));return;} }
    if (step === 'identify') return identify(view);
    if (step === 'lookup') return lookup(view, params.q);
    if (step === 'done') return doneView(view);
    if (step === 'dup' && params.found) return dupFound(view, Number(params.found));
    if (params.batch) return batch(view, Number(params.batch));
    if (unitId) {
      return withUnit(view, unitId, function (u) {
        if (step !== 'mismatch' && u.hold) return verify(view, u);
        if (step === 'stock') stock(view, u);
        else if (step === 'location') location(view, u, params.err);
        else if (step === 'group') group(view, u);
        else if (step === 'review') review(view, u);
        else if (step === 'dup' && draft.blockers && draft.blockers.length) dupView(view, draft.blockers[0], false);
        else if (step === 'confirm') confirm(view, u);
        else if (step === 'mismatch') mismatch(view, u);
        else verify(view, u);
      });
    }
    // Legacy deep link #/receiving?id=<jobOrderId>: the queue for that job order.
    queue(view, params.tab, params.jo || params.id);
  });
})();
