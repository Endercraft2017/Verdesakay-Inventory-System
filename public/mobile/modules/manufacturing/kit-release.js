/* Warehouseman — job-order kit release. Figma page 62:*:
     62:14 Release Queue · 62:79 Verify Kit · 62:150 Confirm Release · 62:205 Short Stock
     62:264 Escalate Shortage · 62:317 Released Handoff · 62:372 Scan Shortcut
   Backend (job-orders.routes.ts, all inventory.adjust): approved drafts come from
   GET /job-orders?stage=awaiting_release, each checked with GET /:id/availability. The phone
   exposes warehouse-accept → prepare (partial or full counts) → release separately —
   each independent: acceptance and picks can save before release fails. A shortage escalation is a tracked
   production issue (POST /production-issues), not a loose message. Online-only: nothing here
   goes through the offline queue.
   Each step is its own URL so the header back arrow / phone back gesture walk the flow:
   #/kit-release[?tab=blocked] · ?id=<jo> (verify) · ?id=<jo>&step=confirm|blocked|report|done · ?scan=1 */
(function () {
  var R = window.RoleUI;
  var RELEASE_ICON = '/mobile/icons/v2/release-box.svg';
  var DRAFT_KEY = 'vds_kit_shortage_draft_';
  var rendering = 0;
  // All three stages use account/tenant-scoped, revision-checked durable attempts.
  function actionId(id) { return 'kit:' + id; }
  function live(view, record) {
    return !!MApp.getMe() && view.isConnected && /^#\/kit-release(?:\?|$)/.test(location.hash) && mProductionDrafts.key(actionId(record.jobId)) === record.key &&
      Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id')) === record.jobId;
  }
  function stageLabel(jo, av) {
    if (jo.status !== 'draft') return jo.status;
    if (!jo.approved_at) return 'Awaiting approval';
    if (!jo.warehouse_accepted_at) return 'Awaiting warehouse';
    if (jo.prepared_at) return av && av.releasable ? 'Ready to release' : 'Fully picked';
    return av && av.lines.some(function (l) { return l.picked > 0; }) ? 'Partially picked' : 'Accepted · not picked';
  }
  function released(jo) {
    return !!(jo.released_at && jo.parts_slip_number && ['released', 'in_progress', 'paused', 'completed'].indexOf(jo.status) !== -1);
  }
  function stockText(l) {
    return 'Need ' + l.need + ' · Picked ' + (l.picked || 0) + ' · On hand ' + l.have +
      ' · Held ' + l.held_elsewhere + ' · Free ' + l.available;
  }
  function stockLines(lines) {
    return R.lines(lines.map(function (l) { return { name: l.component_name, qty: 'Picked ' + (l.picked || 0) + ' / ' + l.need, detail: 'On hand ' + l.have + ' · Held ' + l.held_elsewhere + ' · Free ' + l.available, ok: l.short <= 0 }; }));
  }
  function status(view, jo) {
    var body = R.page(view, { role: 'warehouse', node: '62:317', title: 'Job-order status', subtitle: 'Review the current record' });
    body.innerHTML = R.jobHead({ number: jo.number, name: jo.product_name, pill: { text: jo.status } }) +
      R.field('Parts slip', jo.parts_slip_number || 'None') +
      R.note('info', 'The current job-order status is ' + mEsc(jo.status) + '.') +
      R.actions([{ id: 'kr-queue', label: 'Back to release queue', kind: 'secondary' }]);
    body.querySelector('#kr-queue').onclick = function () { MApp.go('kit-release'); };
  }
  function guarded(view, record, fn) { if (live(view, record)) fn(); }
  function send(record) {
    var op = record.operation;
    if (record.key !== mProductionDrafts.key(actionId(record.jobId))) return Promise.reject(new Error('Sign in to the original account to recover this action.'));
    if (Date.now() - op.created >= 7 * 86400000 || op.state === 'conflict') {
      op.state = 'conflict'; op.error = 'This attempt needs reconciliation with the supervisor. Do not repeat the action with a new key.';
      return mProductionDrafts.save(record);
    }
    var started = false, previous = op.state;
    op.state = 'sending'; op.error = '';
    return mProductionDrafts.save(record).then(function () {
      started = true;
      return API.post(op.path, op.payload, { idempotencyKey: op.key });
    }).then(function (result) {
      op.state = 'confirmed'; op.local = API.syncLocal(result); op.result = result;
      return mProductionDrafts.save(record);
    }).catch(function (err) {
      // Once sent, loss of response means unknown, including a failed acknowledgement save.
      op.state = !started ? previous : (!err.status || err.status >= 500 || err.status === 429 ? 'unknown' : 'rejected');
      if (err.status === 409 && /save key|different request|idempotency/i.test(err.message)) op.state = 'conflict';
      op.error = err.message;
      op.shortfalls = err.data && err.data.shortfalls || null;
      return mProductionDrafts.save(record).catch(function () { throw err; });
    });
  }
  function recovery(view, d, record) {
    var op = record.operation;
    var body = R.page(view, { role: 'warehouse', node: '62:150', title: 'Review warehouse action', subtitle: 'Recover the original ' + op.kind + ' attempt' });
    body.innerHTML = R.jobHead({ number: d.jo.number, name: d.jo.product_name, pill: { text: stageLabel(d.jo, d.av) } }) +
      R.field('Current record', [d.jo.warehouse_accepted_at ? 'Warehouse accepted' : 'Not accepted', d.jo.prepared_at ? 'Fully picked' : 'Not fully picked', d.jo.parts_slip_number || 'No release slip'].join(' · ')) +
      (d.av ? stockLines(d.av.lines) : R.note('warn', 'Availability unknown. Refresh before making any new stock decision.')) +
      (op.kind === 'pick' ? R.field('Original picked counts', op.payload.job_orders[0].lines.map(function (l) { return '#' + l.component_item_id + ': ' + l.qty_picked; }).join(' · ')) : '') +
      R.note(op.state === 'confirmed' && !op.local ? 'info' : 'warn', op.local ? 'Saved on the site PC; awaiting confirmation. Do not hand over the kit yet.' :
        op.state === 'confirmed' ? 'Confirmed by site authority.' : op.state === 'rejected' ? 'The action was refused. Review the current stages and stock before correcting it.' :
        op.state === 'conflict' ? 'Needs supervisor reconciliation. The original attempt is retained.' : 'The response was interrupted. Earlier stages may have saved. Retry checks the original action with its original key.') +
      (op.shortfalls ? R.lines(op.shortfalls.map(function (l) { return { name: l.component_name, qty: l.picking != null ? 'Picking ' + l.picking + ' · Free ' + l.available : stockText(l), ok: false }; })) : '') +
      (op.error ? R.note('warn', mEsc(op.error)) : '') +
      R.actions((!op.local && (op.state === 'unknown' || op.state === 'new') ? [{ id: 'kr-retry-action', label: 'Retry original', kind: 'primary' }] : [])
        .concat([{ id: 'kr-review', label: op.state === 'rejected' || op.state === 'confirmed' && !op.local ? 'Review kit' : 'Back to queue', kind: 'secondary' }]));
    var retry = body.querySelector('#kr-retry-action');
    if (retry) retry.onclick = function () {
      retry.disabled = true;
      send(record).then(function () { guarded(view, record, function () { withJob(view, record.jobId); }); })
        .catch(function (err) { guarded(view, record, function () { mToast(err.message, 'err'); recovery(view, d, record); }); });
    };
    body.querySelector('#kr-review').onclick = function () {
      if (op.state === 'rejected' || op.state === 'confirmed' && !op.local) {
        mProductionDrafts.remove(record).then(function () { guarded(view, record, function () { MApp.go('kit-release', { id: record.jobId }); if (!new URLSearchParams(location.hash.split('?')[1] || '').get('step')) withJob(view, record.jobId); }); })
          .catch(function (err) { mToast(err.message, 'err'); });
      } else MApp.go('kit-release');
    };
    if (op.local) body.appendChild(R.syncWatch(op.local, function (r) {
      if (!live(view, record)) return;
      if (r.state === 'confirmed') { op.local = null; op.state = 'confirmed'; mProductionDrafts.save(record).then(function () { guarded(view, record, function () { withJob(view, record.jobId); }); }).catch(function (err) { mToast(err.message, 'err'); }); }
    }));
  }
  function submit(view, jo, kind, path, payload) {
    var record = { key: mProductionDrafts.key(actionId(jo.id)), jobId: jo.id, rows: [], operation: {
      kind: kind, path: path, payload: JSON.parse(JSON.stringify(payload)), key: 'kit-' + crypto.randomUUID(), created: Date.now(), state: 'new' } };
    Array.prototype.forEach.call(view.querySelectorAll('input,button'), function (el) { el.disabled = true; });
    send(record).then(function () { guarded(view, record, function () { withJob(view, jo.id); }); })
      .catch(function (err) { guarded(view, record, function () { mToast(err.message, 'err'); withJob(view, jo.id); }); });
  }
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
    var render = ++rendering;
    tab = tab || 'ready';
    var body = R.page(view, { role: 'warehouse', node: '62:14', title: 'Kit releases', subtitle: 'Pick and release complete job-order kits' });
    body.innerHTML = R.skeleton(3);
    Promise.all([
      API.get('/job-orders?stage=awaiting_release'),
      API.get('/job-orders?status=released'),
    ]).then(function (res) {
      var drafts = res[0] || [];
      var released = (res[1] || []).filter(function (j) { return !j.accepted_at; });
      return Promise.all(drafts.concat(released).map(function (j) {
        return Promise.all([
          j.status === 'draft' ? API.get('/job-orders/' + j.id + '/availability').catch(function () { return null; }) : Promise.resolve(null),
          mProductionDrafts.load(actionId(j.id)),
        ]).then(function (r) { j._av = r[0]; j._short = r[0] ? r[0].shortfalls || [] : null; j._pending = r[1]; return j; });
      })).then(function () { return { drafts: drafts, released: released }; });
    }).then(function (d) {
      if (render !== rendering || !body.isConnected) return;
      var ready = d.drafts.filter(function (j) { return !j._pending && j._av && j._av.releasable; });
      var preparing = d.drafts.filter(function (j) { return !j._pending && j._av && !j._av.releasable && !j._short.length; });
      var unknown = d.drafts.concat(d.released).filter(function (j) { return j._pending || (j.status === 'draft' && !j._av); });
      var blocked = d.drafts.filter(function (j) { return !j._pending && j._short && j._short.length; });
      var lists = { ready: ready, preparing: preparing, unknown: unknown, blocked: blocked, released: d.released.filter(function (j) { return !j._pending; }) };
      body.innerHTML =
        R.hero('Action needed', ready.length ? ready.length + ' kit' + (ready.length === 1 ? '' : 's') + ' ready' : 'No kits ready',
          blocked.length ? blocked.length + ' blocked by shortage' : '') +
        R.tabs([
          { id: 'ready', label: 'Ready', count: ready.length },
          { id: 'preparing', label: 'Picking', count: preparing.length },
          { id: 'blocked', label: 'Blocked', count: blocked.length },
          { id: 'unknown', label: 'Review', count: unknown.length },
          { id: 'released', label: 'Released' },
        ], tab) + '<div class="rk-list" data-list></div>';
      function paint(which) {
        var host = body.querySelector('[data-list]');
        var rows = lists[which] || [];
        if (!rows.length) {
          host.innerHTML = '<div class="rk-empty">' + (which === 'ready' ? 'No approved kits are waiting to be released.'
            : which === 'blocked' ? 'Nothing is blocked by a shortage.' : which === 'preparing' ? 'No kits are waiting for picking.' : which === 'unknown' ? 'All stock checks completed.' : 'No released kits are waiting for production to accept them.') + '</div>';
          return;
        }
        host.innerHTML = rows.map(function (j) {
          if (which === 'unknown' || which === 'preparing') {
            return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: which === 'unknown' ? (j._pending ? 'Review saved action' : 'Availability unknown') : stageLabel(j, j._av), tone: 'warn' },
              meta: which === 'unknown' ? (j._pending ? 'Open to recover or review the original action' : 'Open to retry the stock check') : meta(j) });
          }
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
            if (which === 'released') MApp.go('kit-release', { id: id, step: 'done' });
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
  function verify(view, d) {
    var jo = d.jo, av = d.av;
    var body = R.page(view, { role: 'warehouse', node: '62:79', title: 'Verify job-order kit', subtitle: 'Count the physical kit before release' });
    body.innerHTML = R.jobHead({ number: jo.number, name: jo.product_name, pill: { text: stageLabel(jo, av) }, meta: meta(jo) }) +
      R.field('Pick from', jo.source_location_name || 'Default location');
    if (!jo.approved_at) { body.innerHTML += R.note('warn', 'A production manager must approve this job order first.'); return; }
    if (!av) {
      body.innerHTML += R.note('warn', 'Availability unknown. No release decision can be made until stock is checked.') + R.actions([{ id: 'kr-refresh', label: 'Retry stock check', kind: 'primary' }]);
      body.querySelector('#kr-refresh').onclick = function () { withJob(view, jo.id); }; return;
    }
    body.innerHTML += R.section('Components · ' + av.lines.length + ' lines') + stockLines(av.lines) +
      R.note('warn', 'Picking reserves parts; it does not deduct stock. Release is all-or-nothing. Do not hand over a partial kit.');
    if (!jo.warehouse_accepted_at) {
      body.innerHTML += R.actions([{ id: 'kr-accept', label: 'Accept for picking', kind: 'primary' }]);
      body.querySelector('#kr-accept').onclick = function () { submit(view, jo, 'acceptance', '/job-orders/warehouse-accept', { job_order_ids: [jo.id] }); };
      return;
    }
    body.innerHTML += av.lines.map(function (l) {
      return '<label class="rk-card rk-field"><small>' + mEsc(l.component_name + ' · need ' + l.need + ' · free ' + l.available) + '</small>' +
        '<input type="number" inputmode="numeric" min="0" max="' + l.need + '" step="1" data-pick="' + l.component_item_id + '" aria-label="Picked ' + mEsc(l.component_name) + '" value="' + (l.picked || 0) + '"></label>';
    }).join('') + (av.supply_planning_order?R.note('info','Supply is planned by Sales on '+mEsc(av.supply_planning_order.number||'the linked sales order')+'. Do not create duplicate procurement here.'): (av.linked_purchase_orders||[]).length?R.note('info','Pending purchase supply: '+mEsc(av.linked_purchase_orders.map(function(p){return p.number;}).join(', '))+'. It is not on-hand until received into this source location.'):'')+ R.actions([{ id: 'kr-save-pick', label: 'Save picked counts', kind: 'secondary' }]) +
      (av.shortfalls.length ? R.actions([{ id: 'kr-short', label: 'See shortage', kind: 'secondary' }]) : '') +
      (av.releasable ? R.actions([{ id: 'kr-go', label: 'Release to production', kind: 'primary', icon: RELEASE_ICON }]) : R.note('info', 'Save the complete picked counts to enable release.'));
    body.querySelector('#kr-save-pick').onclick = function () {
      var lines = [], invalid = false;
      Array.prototype.forEach.call(body.querySelectorAll('[data-pick]'), function (el) {
        var line = av.lines.find(function (l) { return l.component_item_id === Number(el.dataset.pick); });
        var n = el.value.trim() === '' ? NaN : Number(el.value);
        if (!Number.isSafeInteger(n) || n < 0 || n > line.need || n > line.available) invalid = true;
        lines.push({ component_item_id: line.component_item_id, qty_picked: n });
      });
      if (invalid) { mToast('Use whole picked counts between zero and the needed/free quantity.', 'err'); return; }
      submit(view, jo, 'pick', '/job-orders/prepare', { job_orders: [{ id: jo.id, lines: lines }] });
    };
    var go = body.querySelector('#kr-go');
    if (go) go.onclick = function () { step(jo.id, 'confirm'); };
    var savePick = body.querySelector('#kr-save-pick');
    function updatePickActions() {
      var changed = Array.prototype.some.call(body.querySelectorAll('[data-pick]'), function (input) {
        var line = av.lines.find(function (l) { return l.component_item_id === Number(input.dataset.pick); });
        return input.value.trim() === '' || Number(input.value) !== (line.picked || 0);
      });
      savePick.disabled = !changed && !(av.lines.length === 0 && !jo.prepared_at);
      if (go) go.disabled = changed;
    }
    Array.prototype.forEach.call(body.querySelectorAll('[data-pick]'), function (el) {
      el.oninput = updatePickActions;
    });
    updatePickActions();
    var sh = body.querySelector('#kr-short');
    if (sh) sh.onclick = function () { step(jo.id, 'blocked'); };
  }
  function load(id) {
    return Promise.all([API.get('/job-orders/' + id), API.get('/job-orders/' + id + '/availability').catch(function () { return null; }), mProductionDrafts.load(actionId(id))])
      .then(function (r) { return { jo: r[0], av: r[1], record: r[2] }; });
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
      if (offline()) { mToast('You’re offline — releasing a kit needs a connection.', 'err'); return; }
      if (!ack.checked) return;
      btn.disabled = true;
      ack.disabled = true;
      body.querySelector('#kr-back').disabled = true;
      var owner = mProductionDrafts.key(actionId(jo.id)), routeHash = location.hash;
      // One physical action, after separately confirmed acceptance and picked counts.
      load(jo.id).then(function (d) {
        if (!MApp.getMe() || owner !== mProductionDrafts.key(actionId(jo.id)) || location.hash !== routeHash) return;
        if (d.record || !d.av || !d.av.releasable || !ack.checked) { withJob(view, jo.id, 'confirm'); return; }
        submit(view, d.jo, 'release', '/job-orders/' + jo.id + '/release', {});
      }).catch(function (err) { mToast(err.message, 'err'); btn.disabled = !ack.checked; ack.disabled = false; body.querySelector('#kr-back').disabled = false; });
    };
  }

  /* ── 62:205 Release blocked ──────────────────────────────────────────────── */
  function blocked(view, jo, short) {
    var body = R.page(view, { role: 'warehouse', node: '62:205', title: 'Release blocked', subtitle: 'The kit cannot be partially released' });
    body.innerHTML =
      R.alert(short.length + ' component' + (short.length === 1 ? ' is' : 's are') + ' short', 'Check missing stock and commitments before retrying.') +
      R.lines(short.map(function (s) { return { name: s.component_name, qty: 'Need ' + s.need + ' · Free ' + s.available, detail: 'On hand ' + s.have + ' · Held ' + s.held_elsewhere + ' · Picked ' + (s.picked || 0), ok: false }; }), 'No release slip has been confirmed. Acceptance and picked counts may already be saved.') +
      R.note('info', '<h3>What to do next</h3><ol><li>Keep the picked kit in its staging area.</li>' +
        '<li>Notify the planner or supervisor.</li><li>If on-hand is adequate but free stock is short, ask for a commitment review. Replenish physically missing stock.</li></ol>') +
      R.actions([{ id: 'kr-report', label: 'Report shortage', kind: 'primary' }, { id: 'kr-retry', label: 'Retry check', kind: 'secondary' }]);
    body.querySelector('#kr-report').onclick = function () { step(jo.id, 'report'); };
    body.querySelector('#kr-retry').onclick = function () { MApp.go('kit-release', { id: jo.id }); };
  }

  /* ── 62:264 Report kit shortage (tracked production issue) ───────────────── */
  function report(view, jo, short) {
    var body = R.page(view, { role: 'warehouse', node: '62:264', title: 'Report kit shortage', subtitle: 'Prefilled handoff to planning or supervision' });
    var key = DRAFT_KEY + mProductionDrafts.key(actionId(jo.id));
    var shortText = short.map(function (s) { return s.component_name + ' — ' + stockText(s); }).join('\n');
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(key) || 'null'); } catch (ignore) {}
    var msg = (draft && draft.message) || 'Release blocked at ' + (jo.source_location_name || 'default location') + '. Please review stock and existing commitments before this kit can be released.';
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
    var render = ++rendering, owner = mProductionDrafts.key(actionId(id)), routeHash = location.hash;
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    load(id).then(function (d) {
      if (render !== rendering || location.hash !== routeHash || !MApp.getMe() || owner !== mProductionDrafts.key(actionId(id))) return;
      var jo = d.jo;
      if (d.record) { d.record.jobId = jo.id; recovery(view, d, d.record); return; }
      if (released(jo)) { done(view, jo); return; }
      if (jo.status !== 'draft') { status(view, jo); return; }
      if (!d.av || !jo.approved_at) { verify(view, d); return; }
      var short = d.av.shortfalls || [];
      if (name === 'confirm' && d.av.releasable) confirm(view, jo);
      else if ((name === 'confirm' && short.length) || name === 'blocked') blocked(view, jo, short);
      else if (name === 'report') report(view, jo, short);
      else verify(view, d);
    }).catch(function (err) {
      view.innerHTML = '';
      view.appendChild(R.error(err, function () { withJob(view, id, name); }));
    });
  }

  MApp.route('kit-release', function (view, params) {
    rendering++;
    if (!MApp.can('production.kit_release')) {
      view.innerHTML = '<div class="m-error">Releasing kits is for warehouse accounts.</div>';
      return;
    }
    var id = params && Number(params.id);
    if (params && params.scan) scan(view);
    else if (id && params.step) withJob(view, id, params.step);
    else if (id) withJob(view, id);
    else queue(view, params && params.tab);
  });
})();
