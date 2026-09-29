/* Warehouseman — job-order kit release. Figma page 62:*:
     62:14 Release Queue · 62:79 Verify Kit · 62:150 Confirm Release · 62:205 Short Stock
     62:264 Escalate Shortage · 62:317 Released Handoff · 62:372 Scan Shortcut
   Backend (job-orders.routes.ts, all inventory.adjust): approved drafts come from
   GET /job-orders?stage=awaiting_release, each checked with GET /:id/availability. Confirm
   runs the server's own steps in order — warehouse-accept → prepare (full pick) → release —
   each all-or-nothing, so a short kit never moves stock. A shortage escalation is a tracked
   production issue (POST /production-issues), not a loose message. Online-only: nothing here
   goes through the offline queue.
   Each step is its own URL so the header back arrow / phone back gesture walk the flow:
   #/kit-release[?tab=blocked] · ?id=<jo> (verify) · ?id=<jo>&step=confirm|blocked|report|done · ?scan=1 */
(function () {
  var R = window.RoleUI;
  var RELEASE_ICON = '/mobile/icons/v2/release-box.svg';
  var DRAFT_KEY = 'vds_kit_shortage_draft_';
  var pickShortfalls = {};
  function step(id, name) { MApp.go('kit-release', { id: id, step: name }); }

  function dueText(d) {
    if (!d) return '';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var due = new Date(d + 'T00:00:00');
    var days = Math.round((due - today) / 86400000);
    return days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days < 0 ? 'Overdue ' + (-days) + 'd' : 'Due ' + d;
  }
  function meta(jo, extra) {
    return [jo.team_name, extra || dueText(jo.due_date), jo.source_location_name].filter(Boolean).join(' · ');
  }
  function offline() { return navigator.onLine === false; }

  /* ── 62:14 Release queue ─────────────────────────────────────────────────── */
  function queue(view, tab) {
    tab = tab || 'ready';
    var body = R.page(view, { role: 'warehouse', node: '62:14', title: 'Kit releases', subtitle: 'Pick and release complete job-order kits' });
    body.innerHTML = R.skeleton(3);
    Promise.all([
      API.get('/job-orders?stage=awaiting_release'),
      API.get('/job-orders?status=released'),
    ]).then(function (res) {
      var drafts = res[0] || [];
      var released = (res[1] || []).filter(function (j) { return !j.accepted_at; });
      return Promise.all(drafts.map(function (j) {
        return API.get('/job-orders/' + j.id + '/availability')
          .then(function (a) { j._short = a.shortfalls || []; return j; })
          .catch(function () { j._short = null; return j; }); // unknown → treated as ready, re-checked on open
      })).then(function (withAvail) { return { drafts: withAvail, released: released }; });
    }).then(function (d) {
      var ready = d.drafts.filter(function (j) { return !j._short || !j._short.length; });
      var blocked = d.drafts.filter(function (j) { return j._short && j._short.length; });
      var lists = { ready: ready, blocked: blocked, released: d.released };
      body.innerHTML =
        R.hero('Action needed', ready.length ? ready.length + ' kit' + (ready.length === 1 ? '' : 's') + ' ready' : 'No kits waiting',
          blocked.length ? blocked.length + ' blocked by shortage' : '') +
        R.tabs([
          { id: 'ready', label: 'Ready', count: ready.length },
          { id: 'blocked', label: 'Blocked', count: blocked.length },
          { id: 'released', label: 'Released' },
        ], tab) + '<div class="rk-list" data-list></div>';
      function paint(which) {
        var host = body.querySelector('[data-list]');
        var rows = lists[which];
        if (!rows.length) {
          host.innerHTML = '<div class="rk-empty">' + (which === 'ready' ? 'No approved kits are waiting to be released.'
            : which === 'blocked' ? 'Nothing is blocked by a shortage.' : 'No released kits are waiting for production to accept them.') + '</div>';
          return;
        }
        host.innerHTML = rows.map(function (j) {
          if (which === 'blocked') {
            return R.jobCard({ id: j.id, number: j.number, name: j.product_name, warn: true, pill: { text: 'Blocked', tone: 'warn' },
              meta: [j.team_name, j._short.length + ' part' + (j._short.length === 1 ? '' : 's') + ' short'].filter(Boolean).join(' · ') });
          }
          if (which === 'released') {
            return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'Awaiting acceptance', tone: 'warn' },
              meta: meta(j, j.parts_slip_number ? 'Slip ' + j.parts_slip_number : '') });
          }
          return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'Ready' }, meta: meta(j) });
        }).join('');
        Array.prototype.forEach.call(host.querySelectorAll('[data-id]'), function (b) {
          b.onclick = function () {
            var id = Number(b.dataset.id);
            if (which === 'released') MApp.go('job-orders', { id: id });
            else MApp.go('kit-release', { id: id });
          };
        });
      }
      Array.prototype.forEach.call(body.querySelectorAll('.rk-tabs button'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(body.querySelectorAll('.rk-tabs button'), function (x) {
            x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b);
          });
          paint(b.dataset.tab);
        };
      });
      paint(tab);
    }).catch(function (err) {
      body.innerHTML = '';
      body.appendChild(R.error(err, function () { queue(view, tab); }));
    });
  }

  /* ── 62:79 Verify kit ────────────────────────────────────────────────────── */
  function verify(view, id) {
    var body = R.page(view, { role: 'warehouse', node: '62:79', title: 'Verify job-order kit', subtitle: 'Count the physical kit before release' });
    body.innerHTML = R.skeleton(2);
    load(id).then(function (d) {
      var jo = d.jo, av = d.av;
      if (jo.status !== 'draft') { step(jo.id, 'done'); return; }
      if (!jo.approved_at) {
        body.innerHTML = R.jobHead({ number: jo.number, name: jo.product_name, meta: meta(jo), pill: { text: 'Draft' } }) +
          R.note('warn', 'This job order has not been approved yet — it can’t be released until a production manager approves it.');
        return;
      }
      var short = av.shortfalls || [];
      body.innerHTML =
        R.jobHead({ number: jo.number, name: jo.product_name, pill: { text: 'Draft' },
          meta: [jo.team_name, 'Qty ' + jo.qty_ordered, dueText(jo.due_date)].filter(Boolean).join(' · ') }) +
        R.field('Pick from', av.source_location_name || jo.source_location_name || 'Default location') +
        R.section('Components · ' + av.lines.length + ' line' + (av.lines.length === 1 ? '' : 's')) +
        (av.lines.length
          ? R.lines(av.lines.map(function (l) {
              return { name: l.component_name, qty: Math.min(l.have, l.need) + ' / ' + l.need, ok: l.short <= 0 };
            }))
          : R.note('info', 'This job order has no components to release.')) +
        R.note('warn', 'Release is all-or-nothing. Do not hand over a partial kit.') +
        (short.length
          ? R.actions([{ id: 'kr-short', label: 'See shortage', kind: 'primary' }])
          : R.actions([{ id: 'kr-go', label: 'Release to production', kind: 'primary', icon: RELEASE_ICON }]));
      var go = body.querySelector('#kr-go');
      if (go) go.onclick = function () { step(jo.id, 'confirm'); };
      var sh = body.querySelector('#kr-short');
      if (sh) sh.onclick = function () { step(jo.id, 'blocked'); };
    }).catch(function (err) {
      body.innerHTML = '';
      body.appendChild(R.error(err, function () { verify(view, id); }));
    });
  }

  function load(id) {
    return Promise.all([API.get('/job-orders/' + id), API.get('/job-orders/' + id + '/availability')])
      .then(function (r) { return { jo: r[0], av: r[1] }; });
  }

  /* ── 62:150 Confirm release ──────────────────────────────────────────────── */
  function confirm(view, jo) {
    var body = R.page(view, { role: 'warehouse', node: '62:150', title: 'Confirm release', subtitle: 'Final check before stock is deducted' });
    body.innerHTML =
      '<div class="rk-jobhead"><span class="rk-no">' + mEsc(jo.number) + '</span><span></span>' +
        '<span class="rk-name">' + mEsc(jo.product_name + ' · ' + jo.qty_ordered + ' unit' + (jo.qty_ordered === 1 ? '' : 's')) + '</span>' +
        '<span class="rk-meta">' + mEsc(jo.source_location_name || 'Default location') + '</span></div>' +
      R.note('info', '<h3>You are about to:</h3><ul><li>Deduct every planned component</li><li>Record your name and release time</li>' +
        '<li>Hand the complete kit to Production</li><li>Wait for Production Lead acceptance</li></ul>') +
      R.check('kr-ack', 'I physically picked and counted the complete kit.') +
      '<div class="rk-note danger"><img src="/mobile/icons/v2/alert.svg" alt=""><span>Release cannot be undone from the phone.</span></div>' +
      R.actions([{ id: 'kr-confirm', label: 'Confirm release', kind: 'primary' }, { id: 'kr-back', label: 'Go back', kind: 'secondary' }]);
    var btn = body.querySelector('#kr-confirm');
    var ack = body.querySelector('#kr-ack');
    btn.disabled = true;
    ack.onchange = function () { btn.disabled = !ack.checked; };
    body.querySelector('#kr-back').onclick = function () { history.back(); };
    btn.onclick = function () {
      if (offline()) { mToast('You’re offline — releasing a kit needs a connection. Nothing was deducted.', 'err'); return; }
      btn.disabled = true;
      btn.textContent = 'Releasing…';
      // The server's own steps, in order; each is all-or-nothing and safe to repeat.
      var chain = Promise.resolve();
      if (!jo.warehouse_accepted_at) chain = chain.then(function () { return API.post('/job-orders/warehouse-accept', { job_order_ids: [jo.id] }); });
      if (!jo.prepared_at) chain = chain.then(function () { return API.post('/job-orders/prepare', { job_orders: [{ id: jo.id }] }); });
      chain.then(function () { return API.post('/job-orders/' + jo.id + '/release', {}); })
        .then(function () { step(jo.id, 'done'); })
        .catch(function (err) {
          var sf = err && err.data && err.data.shortfalls;
          if (sf && sf.length) {
            pickShortfalls[jo.id] = sf.map(function (s) { return { component_name: s.component_name, need: s.picking, have: s.available, short: s.picking - s.available }; });
            step(jo.id, 'blocked');
            return;
          }
          mToast(err.message || 'Release failed — nothing was deducted', 'err');
          btn.disabled = !ack.checked;
          btn.textContent = 'Confirm release';
        });
    };
  }

  /* ── 62:205 Release blocked ──────────────────────────────────────────────── */
  function blocked(view, jo, short) {
    var body = R.page(view, { role: 'warehouse', node: '62:205', title: 'Release blocked', subtitle: 'The kit cannot be partially released' });
    body.innerHTML =
      R.alert(short.length + ' component' + (short.length === 1 ? ' is' : 's are') + ' short', 'Stock must be corrected before retrying.') +
      R.lines(short.map(function (s) { return { name: s.component_name, qty: 'Need ' + s.need + ' · Have ' + s.have, ok: false }; }), 'No stock was deducted.') +
      R.note('info', '<h3>What to do next</h3><ol><li>Return the picked kit to its staging area.</li>' +
        '<li>Notify the planner or supervisor.</li><li>Retry only after stock is corrected.</li></ol>') +
      R.actions([{ id: 'kr-report', label: 'Report shortage', kind: 'primary' }, { id: 'kr-retry', label: 'Retry check', kind: 'secondary' }]);
    body.querySelector('#kr-report').onclick = function () { step(jo.id, 'report'); };
    body.querySelector('#kr-retry').onclick = function () { delete pickShortfalls[jo.id]; MApp.go('kit-release', { id: jo.id }); };
  }

  /* ── 62:264 Report kit shortage (tracked production issue) ───────────────── */
  function report(view, jo, short) {
    var body = R.page(view, { role: 'warehouse', node: '62:264', title: 'Report kit shortage', subtitle: 'Prefilled handoff to planning or supervision' });
    var key = DRAFT_KEY + jo.id;
    var shortText = short.map(function (s) { return s.component_name + ' — need ' + s.need + ', have ' + s.have; }).join('\n');
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(key) || 'null'); } catch (ignore) {}
    var msg = (draft && draft.message) || 'Release blocked. Please replenish or approve the required stock correction before this kit can be released.';
    var sev = (draft && draft.severity) || 'high';
    body.innerHTML =
      R.field('Send to', 'Production planner · Supervisors') +
      R.field('Linked job order', jo.number + ' · ' + jo.product_name, true) +
      '<div class="rk-card rk-field"><small>Short components</small><b style="color:var(--rk-danger-title)">' + mEsc(shortText) + '</b></div>' +
      '<label class="rk-card rk-field"><small>Message</small><textarea rows="4" maxlength="3500" data-msg>' + mEsc(msg) + '</textarea></label>' +
      '<label class="rk-card rk-field"><small>Priority</small><select data-sev>' +
        ['critical', 'high', 'normal', 'low'].map(function (s) { return '<option value="' + s + '"' + (s === sev ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + (jo.due_date ? ' · ' + dueText(jo.due_date) : '') + '</option>'; }).join('') +
      '</select></label>' +
      R.actions([{ id: 'kr-send', label: 'Send report', kind: 'primary' }, { id: 'kr-draft', label: 'Save draft', kind: 'secondary' }]);
    var msgEl = body.querySelector('[data-msg]'), sevEl = body.querySelector('[data-sev]');
    body.querySelector('#kr-draft').onclick = function () {
      try { localStorage.setItem(key, JSON.stringify({ message: msgEl.value, severity: sevEl.value })); mToast('Draft saved on this device'); }
      catch (ignore) { mToast('Could not save the draft on this device', 'err'); }
    };
    body.querySelector('#kr-send').onclick = function () {
      var text = msgEl.value.trim();
      if (!text) { mToast('Write a message for the planner', 'err'); msgEl.focus(); return; }
      if (offline()) { mToast('You’re offline — save a draft and send it when you’re back online.', 'err'); return; }
      var b = this; b.disabled = true; b.textContent = 'Sending…';
      API.post('/production-issues', {
        job_order_id: jo.id, category: 'Parts shortage', severity: sevEl.value,
        description: text + '\n\nShort components:\n' + shortText,
      }).then(function () {
        try { localStorage.removeItem(key); } catch (ignore) {}
        mToast('Shortage reported on ' + jo.number);
        MApp.go('kit-release', { tab: 'blocked' });
      }).catch(function (err) {
        mToast(err.message || 'Could not send the report', 'err');
        b.disabled = false; b.textContent = 'Send report';
      });
    };
  }

  /* ── 62:317 Kit released ─────────────────────────────────────────────────── */
  function done(view, jo) {
    var slip = null;
    var body = R.page(view, { role: 'warehouse', node: '62:317', title: 'Kit released', subtitle: 'Awaiting Production Lead acceptance' });
    var at = jo.released_at ? new Date(jo.released_at.replace(' ', 'T') + 'Z') : new Date();
    var when = (at.toDateString() === new Date().toDateString() ? 'Today' : at.toLocaleDateString()) + ' · ' +
      at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var who = jo.released_by_name || (MApp.getMe() || {}).full_name || '';
    var accepted = !!jo.accepted_at;
    body.innerHTML =
      R.success('Parts released successfully', [when, who ? 'Released by ' + who : '', (slip && slip.number) || jo.parts_slip_number ? 'Slip ' + ((slip && slip.number) || jo.parts_slip_number) : ''].filter(Boolean)) +
      '<div class="rk-card rk-field"><small>' + mEsc(jo.number) + '</small><b style="font-size:16px">' +
        mEsc(jo.product_name + ' · ' + jo.qty_ordered + ' unit' + (jo.qty_ordered === 1 ? '' : 's')) + '</b>' +
        '<span style="display:block;margin-top:8px;font-size:11px;color:var(--rk-meta)">From ' + mEsc(jo.source_location_name || 'default location') + '</span></div>' +
      R.note('info', '<h3>Next: Production acceptance</h3>Hand the complete kit to the Production Lead. Their acceptance becomes your proof of handoff.' +
        '<br><span class="rk-tag">' + (accepted ? 'Accepted by ' + mEsc(jo.accepted_by_name || 'production') : 'Awaiting acceptance') + '</span>') +
      R.actions([{ id: 'kr-queue', label: 'Back to release queue', kind: 'secondary' }, { id: 'kr-open', label: 'Open job order', kind: 'primary' }]);
    body.querySelector('#kr-queue').onclick = function () { MApp.go('kit-release'); };
    body.querySelector('#kr-open').onclick = function () { MApp.go('job-orders', { id: jo.id }); };
  }

  /* ── 62:372 Scan job order ───────────────────────────────────────────────── */
  function scan(view) {
    var body = R.page(view, { role: 'warehouse', node: '62:372', title: 'Scan job order', subtitle: 'Fast access from Warehouse Quick Orbit' });
    body.innerHTML =
      '<button type="button" class="rk-scanframe" aria-label="Open the camera to scan a job-order QR"><i></i><i></i><i></i><i></i><hr>' +
        '<p>Align the job-order QR code inside the frame</p></button>' +
      R.note('info', '<h3>No QR label?</h3>Search by job-order number instead.') +
      '<div class="rk-actions"><button type="button" class="rk-btn secondary" id="kr-search" style="flex:0 1 auto;padding:0 16px">Search job orders</button></div>';
    function lookup(code) {
      var text = String(code || '').trim().toUpperCase();
      if (!text) return;
      API.get('/job-orders?stage=awaiting_release').then(function (rows) {
        var hit = (rows || []).filter(function (j) { return String(j.number).toUpperCase() === text || text.indexOf(String(j.number).toUpperCase()) !== -1; })[0];
        if (hit) MApp.go('kit-release', { id: hit.id });
        else mToast('No kit waiting for release matches ' + code, 'err');
      }).catch(function (err) { mToast(err.message, 'err'); });
    }
    body.querySelector('.rk-scanframe').onclick = function () {
      if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
      mScanner.open({ title: 'Scan job-order QR', onResult: lookup });
    };
    body.querySelector('#kr-search').onclick = function () { MApp.go('kit-release'); };
  }

  /** Steps after verify reload the job order (and availability) from the server. */
  function withJob(view, id, name) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    load(id).then(function (d) {
      var jo = d.jo;
      var short = pickShortfalls[id] || d.av.shortfalls || [];
      if (name === 'done' || jo.status !== 'draft') done(view, jo);
      else if (name === 'confirm') confirm(view, jo);
      else if (name === 'blocked') blocked(view, jo, short);
      else if (name === 'report') report(view, jo, short);
      else verify(view, id);
    }).catch(function (err) {
      view.innerHTML = '';
      view.appendChild(R.error(err, function () { withJob(view, id, name); }));
    });
  }

  MApp.route('kit-release', function (view, params) {
    if (!MApp.can('inventory.adjust')) {
      view.innerHTML = '<div class="m-error">Releasing kits is for warehouse accounts.</div>';
      return;
    }
    var id = params && Number(params.id);
    if (params && params.scan) scan(view);
    else if (id && params.step) withJob(view, id, params.step);
    else if (id) verify(view, id);
    else queue(view, params && params.tab);
  });
})();
