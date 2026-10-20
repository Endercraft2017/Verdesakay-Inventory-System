/* Production — job orders for the Production Lead and Production Manager. Figma page 66:*:
     Lead (blue):    66:14 Job orders · 66:79 Accept parts kit · 66:133 Report kit problem
                     66:185 Active production · 66:240 Record production · 66:294 Unit details
                     66:356 Connection interrupted · 66:408 Non-serialized output · 66:462 Scrap
     Manager (purple): 66:515 Production control · 66:580 Manager actions · 66:650 Close early
   Backend (job-orders.routes.ts): accept (production.record) gates /progress and /units until
   the lead signs for the kit; serialized units go one at a time through POST /:id/units
   (identifier + photo in one multipart request — never queued offline, because the unit needs
   its server id and photo together); pause/resume/close need a reason unless the caller is
   an administrator, and land in job_order_events (GET /:id/events). A kit problem is a tracked
   production issue. Each step is its own URL so the header back arrow walks the flow:
   #/job-orders[?view=all] · ?id=<jo> · ?id=<jo>&step=problem|count|units|interrupted|output|
   scrap|manage|pause|resume|close|history */
(function () {
  var R = window.RoleUI;
  var ICON = '/mobile/icons/v2/';
  var PROBLEM_DRAFT = 'vds_kit_problem_draft_';
  // Restorable drafts include photo bytes and each immutable attempted upload.
  var sessions = {};
  var actions = {};
  var sessionOwner;
  function retryKey() { return 'production-' + crypto.randomUUID(); }
  function draftError(err) { mToast(err.message || 'Could not save this draft', 'err'); }
  function persist(s) { return mProductionDrafts.save(s); }
  function locked(r) { return !!(r.attempt && ['sending', 'unknown', 'conflict'].indexOf(r.attempt.state) !== -1); }
  function responseLabel(r) { return r.local ? 'Saved on site PC — confirmation pending' : 'Confirmed by site authority'; }

  var canAdjust = function () { return MApp.can('production.kit_release'); };
  var canRecord = function () { return MApp.can('production.record'); };
  var canManage = function () { return MApp.can('production.manage'); };
  var canPause = function () { return canManage() || MApp.can('production.pause'); };
  var canInspect = function () { return MApp.can('production.inspect_qc') || MApp.can('production.inspect_qa'); };
  var reasonRequired = function () { return (MApp.getMe() || {}).role !== 'admin'; };
  var isManager = function () { return MApp.can('production.manage'); };
  var offline = function () { return navigator.onLine === false; };
  var go = function (id, step, extra) { MApp.go('job-orders', Object.assign({ id: id, step: step }, extra || {})); };
  /** Back to the job order's own screen — re-render when that's already the current URL. */
  function reopen(id) {
    if (location.hash === '#/job-orders?id=' + id) MApp.render(); else MApp.go('job-orders', { id: id });
  }

  function leadPage(view, node, title, subtitle) {
    return R.page(view, { role: 'lead', node: node, title: title, subtitle: subtitle, label: isManager() ? 'Production manager' : null });
  }
  function managerPage(view, node, title, subtitle) {
    return R.page(view, { role: 'manager', node: node, title: title, subtitle: subtitle });
  }

  function when(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : ''));
    if (isNaN(d)) return String(ts);
    var day = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString();
    return day + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function time(ts) {
    var w = when(ts); return w.indexOf('Today, ') === 0 ? w.slice(7) : w;
  }
  function dueText(d) {
    if (!d) return '';
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var days = Math.round((new Date(d + 'T00:00:00') - t) / 86400000);
    return days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days < 0 ? 'Overdue ' + (-days) + 'd' : 'Due ' + d;
  }
  function unresolved(jo) { var s = jo.units_summary || {}; return (s.pending || 0) + (s.rework || 0) + (s.hold || 0); }
  var remaining = function (jo) { return Math.max(0, jo.qty_ordered - jo.qty_done - jo.qty_scrapped - unresolved(jo)); };
  function quantity(value) { var n = Number(value); return String(value).trim() && Number.isSafeInteger(n) && n >= 0 ? n : null; }

  // Mirrors job-orders.routes.ts needsAcceptance(): released, not yet accepted, no output yet
  // (job orders that had output before the accept step existed stay exempt).
  function awaitingAcceptance(jo) {
    if (jo.accepted_at || jo.status === 'draft') return false;
    if (['released', 'in_progress', 'paused'].indexOf(jo.status) === -1) return false;
    if ((jo.qty_done || 0) > 0 || (jo.qty_scrapped || 0) > 0) return false;
    var s = jo.units_summary;
    if (s) return !Object.keys(s).some(function (k) { return s[k] > 0; });
    return !(jo.units_pending || jo.units_rework || jo.units_passed);
  }

  function loadInto(view, id, render) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    var owner = mProductionDrafts.key(id), routeHash = location.hash;
    if (sessionOwner !== owner) { sessions = {}; actions = {}; sessionOwner = owner; }
    // Existing routes remain usable without storage, but no new upload may start until
    // its draft and key have been persisted successfully.
    Promise.all([API.get('/job-orders/' + id), sessions[id] ? Promise.resolve(sessions[id]) : mProductionDrafts.load(id).catch(function () { return null; }),
      actions[id] ? Promise.resolve(actions[id]) : mProductionDrafts.loadAction(id).catch(function () { return null; })]).then(function (both) {
      if (location.hash !== routeHash || !MApp.getMe() || mProductionDrafts.key(id) !== owner) return;
      if (both[1]) sessions[id] = both[1];
      if (both[2]) actions[id] = both[2];
      var step = new URLSearchParams(location.hash.split('?')[1] || '').get('step');
      if (actions[id] && ['manage', 'pause', 'resume', 'history', 'problem'].indexOf(step) === -1) { actionRecovery(view, both[0]); return; }
      render(both[0]);
    }).catch(function (err) {
      view.innerHTML = '';
      view.appendChild(R.error(err, function () { loadInto(view, id, render); }));
    });
  }
  function fail(btn, label) {
    return function (err) {
      mToast(err && err.offline ? 'You’re offline — this needs a connection. Nothing was saved.' : (err && err.message) || 'Failed', 'err');
      if (btn) { btn.disabled = false; if (label) btn.textContent = label; }
    };
  }
  function busy(btn, text) { btn.disabled = true; btn.textContent = text; }
  function actionVisible(jo, record) {
    try { return actions[jo.id] === record && record.key === mProductionDrafts.key(jo.id + ':action') &&
      location.hash.split('?')[0] === '#/job-orders' && new URLSearchParams(location.hash.split('?')[1] || '').get('id') === String(jo.id); }
    catch (ignore) { return false; }
  }

  function sendAction(jo, record) {
    var a = record.operation;
    if (record.key !== mProductionDrafts.key(jo.id + ':action')) return Promise.reject(new Error('Reopen this attempt with its original account.'));
    if (a.state === 'conflict' || Date.now() - a.created >= 7 * 86400000) {
      a.state = 'conflict'; a.error = 'Ask a manager to reconcile this attempt before recording it again; expired keys cannot be retried safely.';
      return persist(record).then(function () { throw new Error(a.error); });
    }
    var wasUnknown = a.state === 'unknown', sent = false;
    a.state = 'sending';
    return persist(record).then(function () {
      if (record.key !== mProductionDrafts.key(jo.id + ':action')) throw new Error('The signed-in account changed.');
      sent = true;
      return API.post(a.path, a.payload, { idempotencyKey: a.key });
    }).then(function (res) {
      a.state = 'confirmed'; a.result = res; a.local = API.syncLocal(res); a.error = null;
      return persist(record).catch(function () { mToast('Saved, but the draft confirmation could not be stored. Recovery will reuse the original key.', 'err'); }).then(function () { return res; });
    }).catch(function (err) {
      a.error = err.message || 'Could not confirm this attempt';
      a.state = !sent ? (wasUnknown ? 'unknown' : 'rejected') : networkLost(err) || err.status >= 500 || err.status === 401 || err.status === 429 ? 'unknown'
        : err.status === 409 && /save key|different request/i.test(a.error) ? 'conflict' : 'rejected';
      return persist(record).catch(function () {}).then(function () { throw err; });
    });
  }
  function submitAction(view, jo, kind, payload, button) {
    if (actions[jo.id]) { actionRecovery(view, jo); return; }
    var record = { key: mProductionDrafts.key(jo.id + ':action'), rows: [], operation: {
      kind: kind, path: '/job-orders/' + jo.id + (kind === 'approve' ? '/approve' : kind === 'accept' ? '/accept' : '/progress'),
      key: retryKey(), payload: JSON.parse(JSON.stringify(payload)), created: Date.now(), state: 'new',
      review: kind === 'approve' ? { number: jo.number, product_name: jo.product_name, qty_ordered: jo.qty_ordered, build_mode: jo.build_mode, source_location_name: jo.source_location_name || 'Default location',
        components: (jo.components || []).map(function (c) { return { component_name: c.component_name, qty_planned: c.qty_planned }; }) } : null } };
    actions[jo.id] = record;
    bodyLock(button.closest('.rk-body'));
    sendAction(jo, record).then(function () {
      if (record.operation.local) { actionRecovery(view, jo); return; }
      return mProductionDrafts.remove(record).then(function () {
        var visible = actionVisible(jo, record);
        if (actions[jo.id] === record) delete actions[jo.id];
        if (visible) { mToast(kind === 'approve' ? 'Job order approved' : kind === 'accept' ? 'Kit accepted' : 'Production result confirmed'); reopen(jo.id); }
      });
    }).catch(function () { actionRecovery(view, jo); });
  }
  function bodyLock(body) { body.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = true; }); }
  function actionRecovery(view, jo) {
    var record = actions[jo.id];
    if (!record || !actionVisible(jo, record)) return;
    var a = record.operation;
    var titles = { approve: 'Job-order approval', accept: 'Kit acceptance', output: 'Production output', scrap: 'Production scrap' };
    var state = a.state === 'confirmed' ? a.local ? 'Saved on site PC — confirmation pending' : 'Confirmed by site authority'
      : a.state === 'rejected' ? 'Request refused — review before correcting' : a.state === 'conflict' ? 'Conflict — reconciliation needed' : 'Confirmation unknown';
    var retryable = ['unknown', 'sending', 'new'].indexOf(a.state) !== -1;
    var body = a.kind === 'approve' ? managerPage(view, '66:580', titles[a.kind], state) : leadPage(view, a.kind === 'accept' ? '66:79' : a.kind === 'output' ? '66:408' : '66:462', titles[a.kind], state);
    body.innerHTML = R.field('Job order', jo.number) + R.field('Attempt status', state) +
      (a.kind === 'approve' ? R.field('Reviewed plan', 'Quantity ' + a.review.qty_ordered + ' · ' + a.review.source_location_name) +
        R.field('Reviewed build state', a.review.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built') + R.field('Original note', a.payload.notes || '—') +
        R.lines(a.review.components.map(function (c) { return { name: c.component_name, qty: c.qty_planned, ok: true }; })) : a.kind === 'accept' ? R.field('Original note', a.payload.notes || '—') : R.field('Original quantities', (a.payload.done_delta || 0) + ' finished · ' + (a.payload.scrapped_delta || 0) + ' scrapped') + R.field('Original batch / reason', a.payload.batch_label || a.payload.reason || '—')) +
      (a.error ? R.note('warn', mEsc(a.error)) : '') +
      (retryable ? R.note('warn', 'A missing response does not prove failure. This attempt is stored on this device; its original quantities, note and key will be retried unchanged.') : '') +
      '<div data-action-sync></div>' + R.actions((retryable ? [{ id: 'jo-action-retry', label: 'Retry original', kind: 'primary' }] : []).concat([{ id: 'jo-action-back', label: 'Return to job', kind: 'secondary' }]));
    if (a.local) body.querySelector('[data-action-sync]').appendChild(R.syncWatch(a.local, function (result) {
      if (result.state === 'confirmed') { a.local = null; persist(record).then(function () { if (body.isConnected) actionRecovery(view, jo); }).catch(draftError); }
    }));
    var retry = body.querySelector('#jo-action-retry');
    if (retry) retry.onclick = function () {
      if (offline()) { mToast('Reconnect before checking this attempt.', 'err'); return; }
      busy(retry, 'Checking…');
      sendAction(jo, record).then(function () { actionRecovery(view, jo); }).catch(function () { actionRecovery(view, jo); });
    };
    body.querySelector('#jo-action-back').onclick = function () {
      if (a.state === 'rejected' || a.state === 'confirmed' && !a.local) {
        mProductionDrafts.remove(record).then(function () { delete actions[jo.id]; reopen(jo.id); }).catch(draftError);
      } else MApp.go('job-orders');
    };
  }

  /* ── 66:14 Production job orders (lead board) ───────────────────────────── */
  function board(view, tab) {
    var body = leadPage(view, '66:14', 'Production job orders', 'Accept released kits and record active work');
    body.innerHTML = R.skeleton(3);
    API.get('/job-orders').then(function (rows) {
      var open = (rows || []).filter(function (j) { return ['released', 'in_progress', 'paused'].indexOf(j.status) !== -1; });
      var toAccept = open.filter(function (j) { return j.status !== 'paused' && awaitingAcceptance(j); });
      var active = open.filter(function (j) { return j.status !== 'paused' && !awaitingAcceptance(j); });
      var paused = open.filter(function (j) { return j.status === 'paused'; });
      var lists = { accept: toAccept, active: active, paused: paused };
      tab = tab || (toAccept.length ? 'accept' : 'active');
      body.innerHTML =
        R.hero('Today', toAccept.length ? toAccept.length + ' to accept' : active.length ? active.length + ' active' : 'Nothing to accept',
          active.length + ' active · ' + paused.length + ' paused') +
        R.tabs([
          { id: 'accept', label: 'To accept', count: toAccept.length },
          { id: 'active', label: 'Active', count: active.length },
          { id: 'paused', label: 'Paused', count: paused.length },
        ], tab) + '<div class="rk-list" data-list></div>';
      function paint(which) {
        var host = body.querySelector('[data-list]');
        var list = lists[which];
        if (!list.length) {
          host.innerHTML = '<div class="rk-empty">' + (which === 'accept' ? 'No released kits are waiting for you to accept.'
            : which === 'active' ? 'No job orders are in production right now.' : 'Nothing is paused.') + '</div>';
          return;
        }
        host.innerHTML = list.map(function (j) {
          if (which === 'accept') {
            return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'To accept' },
              meta: ['Released ' + time(j.released_at), j.team_name].filter(Boolean).join(' · ') });
          }
          if (which === 'paused') {
            return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'Paused', tone: 'purple' },
              meta: [j.qty_done + ' / ' + j.qty_ordered + ' recorded', j.pause_reason].filter(Boolean).join(' · ') });
          }
          return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'In progress', tone: 'ok' },
            meta: [j.qty_done + ' / ' + j.qty_ordered + ' recorded', dueText(j.due_date)].filter(Boolean).join(' · ') });
        }).join('');
        Array.prototype.forEach.call(host.querySelectorAll('[data-id]'), function (b) {
          b.onclick = function () { MApp.go('job-orders', { id: b.dataset.id }); };
        });
      }
      Array.prototype.forEach.call(body.querySelectorAll('.rk-tabs button'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(body.querySelectorAll('.rk-tabs button'), function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
          paint(b.dataset.tab);
        };
      });
      paint(tab);
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { board(view, tab); })); });
  }

  /* ── 66:515 Production control (manager exceptions) ─────────────────────── */
  function control(view) {
    var body = managerPage(view, '66:515', 'Production control', 'Exceptions and job-order health');
    body.innerHTML = R.skeleton(3);
    Promise.all([API.get('/job-orders'), MApp.can('production.approve') ? API.get('/job-orders?stage=awaiting_approval').then(function (rows) { return mProductionDrafts.approvalCount(rows); }).catch(function () { return null; }) : Promise.resolve(null)]).then(function (result) {
      if (!body.isConnected) return;
      var rows = result[0], approvals = result[1];
      var open = (rows || []).filter(function (j) { return ['released', 'in_progress', 'paused'].indexOf(j.status) !== -1; });
      var ex = [];
      open.forEach(function (j) {
        if (j.status === 'paused') ex.push({ j: j, kind: 'paused' });
        else if (j.open_issues > 0) ex.push({ j: j, kind: 'blocked' });
        else if (j.overdue) ex.push({ j: j, kind: 'overdue' });
      });
      var count = function (k) { return ex.filter(function (x) { return x.kind === k; }).length; };
      body.innerHTML =
        R.hero('Action required', ex.length ? ex.length + ' exception' + (ex.length === 1 ? '' : 's') : 'On track',
          [count('paused') + ' paused', count('overdue') + ' overdue', count('blocked') + ' kit issue' + (count('blocked') === 1 ? '' : 's')].join(' · ')) +
        '<div class="rk-list" data-list></div>' +
        R.actions((MApp.can('production.approve') ? [{ id: 'pm-approvals', label: 'Awaiting approval' + (approvals != null ? ' · ' + approvals : ''), kind: 'primary' }] : [])
          .concat([{ id: 'pm-all', label: 'View all production', kind: 'secondary' }]));
      var host = body.querySelector('[data-list]');
      host.innerHTML = ex.length ? ex.map(function (x) {
        var j = x.j;
        var pill = x.kind === 'paused' ? { text: 'Paused', tone: 'purple' } : x.kind === 'overdue' ? { text: 'Overdue', tone: 'danger' } : { text: 'Open issue', tone: 'warn' };
        var meta = x.kind === 'paused' ? ['Paused ' + time(j.paused_at), j.qty_done + '/' + j.qty_ordered + ' recorded'].join(' · ')
          : x.kind === 'overdue' ? ['Overdue', j.qty_done + '/' + j.qty_ordered + ' recorded'].join(' · ')
          : j.open_issues + ' open issue' + (j.open_issues === 1 ? '' : 's') + ' · awaiting resolution';
        return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: pill, meta: meta });
      }).join('') : '<div class="rk-empty">No paused, overdue or reported issues.</div>';
      Array.prototype.forEach.call(host.querySelectorAll('[data-id]'), function (b) {
        b.onclick = function () { go(b.dataset.id, 'manage'); };
      });
      var approval = body.querySelector('#pm-approvals');
      if (approval) approval.onclick = function () { MApp.go('job-orders', { view: 'approval' }); };
      body.querySelector('#pm-all').onclick = function () { MApp.go('job-orders', { view: 'all' }); };
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { control(view); })); });
  }

  /* ── Job order entry: pick the right screen for its state ───────────────── */
  function open1(view, id) {
    loadInto(view, id, function (jo) {
      if (jo.status === 'draft') return draftView(view, jo);
      if (awaitingAcceptance(jo) && jo.status !== 'paused' && canRecord()) return acceptKit(view, jo);
      return active(view, jo);
    });
  }

  function approvalQueue(view) {
    var body = managerPage(view, '66:515', 'Awaiting approval', 'Review production demand before warehouse picking');
    if (!MApp.can('production.approve')) { body.innerHTML = R.note('warn', 'Job-order approval requires production approval permission.'); return; }
    body.innerHTML = R.skeleton(3);
    var owner = mProductionDrafts.key('approval-list');
    Promise.all([API.get('/job-orders?stage=awaiting_approval'), mProductionDrafts.listActions('approve')]).then(function (result) {
      if (!body.isConnected || !MApp.can('production.approve') || owner !== mProductionDrafts.key('approval-list')) return;
      var saved = result[1], ids = saved.map(function (a) { return a.jobId; });
      var rows = result[0].filter(function (j) { return ids.indexOf(j.id) === -1; });
      body.innerHTML = R.hero('Review needed', rows.length + ' draft' + (rows.length === 1 ? '' : 's'), saved.length + ' saved approval(s) to review') +
        (saved.length ? R.section('Saved approvals · recovery') + '<div class="rk-list">' + saved.map(function (a) {
          var op = a.record.operation;
          return R.jobCard({ id: a.jobId, number: op.review.number, name: op.review.product_name, pill: { text: op.local ? 'Confirmation pending' : 'Review saved approval', tone: 'warn' },
            meta: 'Original reviewed plan and note retained on this phone' });
        }).join('') + '</div>' : '') +
        '<div class="rk-list">' + (rows.length ? rows.map(function (j) {
          return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: { text: 'Awaiting approval', tone: 'muted' },
            meta: ['Qty ' + j.qty_ordered, j.team_name, dueText(j.due_date), j.source_location_name].filter(Boolean).join(' · ') });
        }).join('') : '<div class="rk-empty">No draft job orders are awaiting approval.</div>') + '</div>';
      body.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { MApp.go('job-orders', { id: b.dataset.id }); }; });
    }).catch(function (err) { if (body.isConnected) { body.innerHTML = ''; body.appendChild(R.error(err, function () { approvalQueue(view); })); } });
  }

  function draftView(view, jo) {
    var approver = MApp.can('production.approve');
    var body = approver || isManager() ? managerPage(view, '66:580', 'Review job-order draft', 'Check the plan before warehouse preparation') : leadPage(view, '66:14', jo.number, 'Not released to production yet');
    body.innerHTML = R.skeleton(2);
    var owner = mProductionDrafts.key(jo.id), routeHash = location.hash;
    API.get('/job-orders/' + jo.id + '/availability').then(function (av) { paint(av); }).catch(function () { paint(null); });
    function paint(av) {
      if (!body.isConnected || !MApp.getMe() || owner !== mProductionDrafts.key(jo.id) || location.hash !== routeHash) return;
      var samePlan = av && jo.approval_revision && av.approval_revision === jo.approval_revision;
      var short = av && av.shortfalls || [];
      body.innerHTML = R.jobHead({ number: jo.number, name: jo.product_name, pill: { text: jo.approved_at ? 'Approved' : 'Awaiting approval' },
          meta: ['Qty ' + jo.qty_ordered, jo.team_name, dueText(jo.due_date)].filter(Boolean).join(' · ') }) +
        R.field('Build state', jo.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built') + R.field('Stock purpose', jo.order_id ? 'Linked sale ' + (jo.order_number || jo.order_id) : 'Independent RTS buffer') + R.field('Parts source', av && av.source_location_name || jo.source_location_name || 'Default location') +
        R.field('Finished goods location', jo.output_location_name || 'Default location') +
        R.field('Schedule / linked order', [jo.planned_start, jo.due_date, jo.work_center, jo.order_number].filter(Boolean).join(' · ') || '—') +
        R.field('Inspection stages', jo.qc_stages === 0 ? 'Bulk output · no serialized inspection' : jo.qc_stages + ' stage(s) · ' +
          [jo.qc_checklist_qc && jo.qc_checklist_qc.name, jo.qc_checklist_qa && jo.qc_checklist_qa.name].filter(Boolean).join(' · ')) +
        R.field('Planner notes', jo.notes || '—') + R.section('Planned component snapshot') +
        ((jo.components || []).length ? R.lines(jo.components.map(function (c) { return { name: c.component_name, qty: 'Need ' + c.qty_planned, detail: c.qty_per_unit + ' per unit', ok: true }; })) : R.note('info', 'No planned stock components.')) +
        R.section('Current source stock') + (av ? R.lines(av.lines.map(function (l) { return { name: l.component_name, qty: 'Free ' + l.available + ' / ' + l.need,
          detail: 'On hand ' + l.have + ' · Held ' + l.held_elsewhere + ' · Picked ' + l.picked, ok: l.short <= 0 }; })) : R.note('warn', 'Stock check unavailable. Refresh before approving.')) +
        (!samePlan && !jo.approved_at ? R.note('warn', av ? 'The plan changed while loading. Refresh and review the latest draft.' : 'Approval is unavailable until the stock review loads.') : '') +
        R.note(short.length ? 'warn' : 'info', jo.approved_at ? 'Approved — the warehouse prepares and releases the complete kit.' : short.length ?
          'Parts are short or held elsewhere. Approval can plan this demand; the warehouse must resolve the shortage before releasing a complete kit.' : 'Approval plans demand. Stock is deducted only when the warehouse releases the complete kit.') +
        (approver && !jo.approved_at && samePlan ? '<label class="rk-card rk-field"><small>Approval note (optional)</small><textarea data-approval-note maxlength="500" rows="2"></textarea></label>' +
          R.check('jo-plan-reviewed', 'I reviewed the quantity, locations and planned components.') +
          (short.length ? R.check('jo-shortage-reviewed', 'I understand the shortage needs warehouse follow-up.') : '') +
          R.actions([{ id: 'jo-approve', label: 'Approve plan', kind: 'primary' }]) : '') +
        R.actions([{ id: 'jo-refresh-draft', label: 'Refresh review', kind: 'secondary' }].concat(canAdjust() && jo.approved_at ? [{ id: 'jo-kit', label: 'Open kit release', kind: 'primary' }] : []));
      body.querySelector('#jo-refresh-draft').onclick = function () { reopen(jo.id); };
      var ap = body.querySelector('#jo-approve');
      if (ap) {
        var reviewed = body.querySelector('#jo-plan-reviewed'), shortage = body.querySelector('#jo-shortage-reviewed');
        function ready() { ap.disabled = !reviewed.checked || shortage && !shortage.checked; }
        reviewed.onchange = ready; if (shortage) shortage.onchange = ready; ready();
        ap.onclick = function () {
          if (offline()) { mToast('Reconnect before approving this plan.', 'err'); return; }
          if (!reviewed.checked || shortage && !shortage.checked) return;
          submitAction(view, jo, 'approve', { notes: body.querySelector('[data-approval-note]').value.trim() || null, expected_revision: jo.approval_revision }, ap);
        };
      }
      var kit = body.querySelector('#jo-kit'); if (kit) kit.onclick = function () { MApp.go('kit-release', { id: jo.id }); };
    }
  }

  /* ── 66:79 Accept parts kit ──────────────────────────────────────────────── */
  function acceptKit(view, jo) {
    var body = leadPage(view, '66:79', 'Accept parts kit', 'Count everything before signing the handoff');
    var comps = (jo.components || []).filter(function (c) { return c.qty_planned > 0; });
    body.innerHTML =
      R.jobHead({ number: jo.number, name: jo.product_name + ' · ' + jo.qty_ordered + ' unit' + (jo.qty_ordered === 1 ? '' : 's'), pill: { text: 'Released', tone: 'muted' },
        meta: [jo.team_name, dueText(jo.due_date)].filter(Boolean).join(' · ') }) +
      R.field('Released from warehouse', [jo.released_by_name, when(jo.released_at)].filter(Boolean).join(' · ') || '—', true) +
      R.section('Components · verify physical quantities') +
      (comps.length ? '<div class="rk-card rk-lines">' + comps.map(function (c) {
        return '<div class="rk-line"><span>' + mEsc(c.component_name) + '</span><em>' + mEsc(c.qty_planned) + '</em><span></span></div>';
      }).join('') + '</div>' : R.note('info', 'No components on this job order.')) +
      R.check('jo-counted', 'I counted the kit and it matches the list') +
      '<label class="rk-card rk-field"><small>Note (optional)</small><input class="rk-input" data-note maxlength="500" placeholder="e.g. bolts swapped for an equivalent"></label>' +
      R.actions([{ id: 'jo-accept', label: 'Accept job order', kind: 'primary' }, { id: 'jo-problem', label: 'Report kit problem', kind: 'secondary' }]);
    var btn = body.querySelector('#jo-accept'), chk = body.querySelector('#jo-counted');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function () {
      if (offline()) { mToast('You’re offline — accepting the kit needs a connection.', 'err'); return; }
      busy(btn, 'Accepting…');
      var note = body.querySelector('[data-note]').value.trim();
      submitAction(view, jo, 'accept', { notes: note || null }, btn);
    };
    body.querySelector('#jo-problem').onclick = function () { go(jo.id, 'problem'); };
  }

  /* ── 66:133 Report kit problem (tracked production issue) ───────────────── */
  var PROBLEM_TYPES = ['Missing or damaged components', 'Wrong components', 'Quantity mismatch', 'Other kit problem'];
  function problem(view, jo) {
    var body = leadPage(view, '66:133', 'Report kit problem', 'Informational report. Use Pause to stop work.');
    var key = PROBLEM_DRAFT + jo.id, draft = null;
    try { draft = JSON.parse(localStorage.getItem(key) || 'null'); } catch (ignore) {}
    body.innerHTML =
      R.field('Linked job order', jo.number + ' · ' + jo.product_name) +
      '<label class="rk-card rk-field"><small>Problem type</small><select data-type>' + PROBLEM_TYPES.map(function (t) {
        return '<option' + (draft && draft.type === t ? ' selected' : '') + '>' + mEsc(t) + '</option>'; }).join('') + '</select></label>' +
      '<label class="rk-card rk-field"><small>Details</small><textarea rows="4" maxlength="3500" data-details placeholder="Be specific: part name, quantity and condition.">' +
        mEsc((draft && draft.details) || '') + '</textarea></label>' +
      R.note('warn', '<b>Recorded on this job order</b><br>Kit acceptance is still required for output. The report itself does not pause production.') +
      R.actions([{ id: 'jo-send', label: 'Send problem report', kind: 'primary' }, { id: 'jo-draft', label: 'Save draft', kind: 'secondary' }]);
    var typeEl = body.querySelector('[data-type]'), detEl = body.querySelector('[data-details]');
    body.querySelector('#jo-draft').onclick = function () {
      try { localStorage.setItem(key, JSON.stringify({ type: typeEl.value, details: detEl.value })); mToast('Draft saved on this device'); }
      catch (ignore) { mToast('Could not save the draft on this device', 'err'); }
    };
    var send = body.querySelector('#jo-send');
    send.onclick = function () {
      var details = detEl.value.trim();
      if (details.length < 5) { mToast('Describe what is wrong: part, quantity and condition', 'err'); detEl.focus(); return; }
      if (offline()) { mToast('You’re offline — save a draft and send it when you’re back online.', 'err'); return; }
      busy(send, 'Sending…');
      API.post('/production-issues', { job_order_id: jo.id, category: typeEl.value, severity: 'high', description: details })
        .then(function () {
          try { localStorage.removeItem(key); } catch (ignore) {}
          mToast('Kit problem reported on ' + jo.number);
          reopen(jo.id);
        }).catch(fail(send, 'Send problem report'));
    };
  }

  /* ── 66:185 Active production ────────────────────────────────────────────── */
  function active(view, jo) {
    var left = remaining(jo);
    var paused = jo.status === 'paused';
    var closed = ['completed', 'cancelled'].indexOf(jo.status) !== -1;
    var body = leadPage(view, '66:185', closed ? jo.number : 'Active production',
      closed ? 'This job order is ' + jo.status : paused ? 'Paused — recording is on hold' : 'Record completed units as they leave the line');
    var serialized = jo.qc_stages > 0;
    body.innerHTML =
      R.jobHead({ number: jo.number, name: jo.product_name, tone: 'ok',
        pill: { text: paused ? 'Paused' : closed ? jo.status : 'Accepted', tone: paused ? 'purple' : 'muted' },
        meta: jo.qty_done + ' recorded · ' + left + ' remaining' + (jo.qty_scrapped ? ' · ' + jo.qty_scrapped + ' scrapped' : '') }) +
      (jo.accepted_by_name ? R.field('Accepted by production', jo.accepted_by_name + ' · ' + when(jo.accepted_at)) : '') +
      (paused ? R.note('warn', 'Paused by ' + mEsc(jo.paused_by_name || '—') + (jo.pause_reason ? ': ' + mEsc(jo.pause_reason) : '')) : '') +
      (!closed ? '<div class="rk-count"><b>' + left + '</b><span>unit' + (left === 1 ? '' : 's') + ' left</span>' +
        '<small>Next stage: ' + (serialized ? 'QC technical inspection' : 'Products In') + '</small></div>' : '') +
      '<div data-acts></div>' +
      (canInspect() && serialized && jo.units_summary && jo.units_summary.pending > 0
        ? '<button type="button" class="rk-card rk-job" data-inspect><span class="rk-no">' + jo.units_summary.pending + ' unit(s) waiting for inspection</span><span class="rk-pill">Inspect</span></button>' : '') +
      '<div class="rk-card rk-field" data-recent><small>Recent activity</small><b>Loading…</b></div>';

    if(jo.conversion_job_order_id)body.querySelector('[data-acts]').insertAdjacentHTML('beforebegin',R.note('info','Finishing conversion: the original package and QC unit already exist. Inspect that unit, then record RTS; do not add another unit or pick another BOM kit.'));
    var acts = [{id:'jo-issues',label:'Job issue reports',kind:'secondary'}];
    if(jo.conversion_job_order_id&&!closed&&(canManage()||can('production.approve')))acts.push({id:'jo-repack',label:'Return complete package to semi-built RTS',kind:'secondary'});
    var canBuild = canRecord() && !paused && !closed && !awaitingAcceptance(jo) && !jo.conversion_job_order_id;
    if (canBuild && left > 0) acts.push({ id: 'jo-record', label: 'Record production', kind: 'primary' });
    if (canBuild && serialized) acts.push({ id: 'jo-scrap', label: 'Report scrap', kind: 'secondary' });
    if (paused && canPause() && !canManage()) acts.push({ id: 'jo-resume', label: 'Resume', kind: 'primary' });
    if (!paused && !closed && canPause() && !canManage()) acts.push({ id: 'jo-pause', label: 'Pause', kind: 'secondary' });
    if (canManage() && !closed) acts.push({ id: 'jo-manage', label: 'Manager actions', kind: acts.length ? 'secondary' : 'primary' });
    if (canRecord() && sessions[jo.id]) acts.unshift({ id: 'jo-draft', label: 'Review saved draft', kind: 'primary' });
    body.querySelector('[data-acts]').innerHTML = acts.length ? R.actions(acts.slice(0, 2)) + (acts.length > 2 ? R.actions(acts.slice(2)) : '') : '';
    var on = function (sel, fn) { var el = body.querySelector(sel); if (el) el.onclick = fn; };
    on('#jo-repack',function(){go(jo.id,'repack');});
    on('#jo-issues',function(){MApp.go('unit-issues',{job:jo.id});});
    on('#jo-record', function () { go(jo.id, serialized ? 'count' : 'output'); });
    on('#jo-draft', function () { go(jo.id, 'interrupted'); });
    on('#jo-scrap', function () { go(jo.id, 'scrap'); });
    on('#jo-resume', function () { go(jo.id, 'resume'); });
    on('#jo-pause', function () { go(jo.id, 'pause'); });
    on('#jo-manage', function () { go(jo.id, 'manage'); });
    on('[data-inspect]', function () { MApp.go('qc', { id: jo.id }); });

    var recent = body.querySelector('[data-recent] b');
    if (!serialized) {
      recent.textContent = jo.qty_done || jo.qty_scrapped ? jo.qty_done + ' finished · ' + jo.qty_scrapped + ' scrapped so far' : 'No output recorded yet.';
      return;
    }
    API.get('/job-orders/' + jo.id + '/units').then(function (units) {
      var list = (units || []).slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 3);
      recent.style.fontWeight = '400';
      recent.innerHTML = list.length ? list.map(function (u) {
        return mEsc((u.identifier || 'Unit #' + u.id) + ' · ' + String(u.status || '').replace('_', ' ') + (u.created_at ? ' · ' + time(u.created_at) : ''));
      }).join('<br>') : 'No units recorded yet.';
    }).catch(function () { recent.textContent = 'Recent activity unavailable.'; });
  }

  /* ── 66:240 Record production (how many) ─────────────────────────────────── */
  function count(view, jo) {
    if (sessions[jo.id]) { go(jo.id, 'interrupted'); return; }
    if(jo.conversion_job_order_id){active(view,jo);return;}
    var left = remaining(jo);
    var body = leadPage(view, '66:240', 'Record production', 'Choose how many finished units to enter');
    if (left <= 0) { body.innerHTML = R.note('info', 'Every ordered unit is already accounted for.'); return; }
    var n = Math.min(5, left);
    body.innerHTML =
      '<div class="rk-stepper"><small>Units to record now</small><div class="row"><button type="button" data-dec aria-label="Fewer">−</button>' +
        '<input type="number" inputmode="numeric" min="1" max="' + left + '" value="' + n + '" aria-label="Units to record"><button type="button" data-inc aria-label="More">+</button></div>' +
        '<p>' + left + ' remaining on this job order</p></div>' +
      R.note('info', '<h3>For each unit you will need:</h3><ul><li>Motor or serial identifier</li><li>One clear finished-unit photo</li><li>Optional shared batch/lot label</li></ul>') +
      '<div class="rk-note danger"><img src="' + ICON + 'alert.svg" alt=""><span>This step requires a connection. Entries are saved one unit at a time.</span></div>' +
      R.actions([{ id: 'jo-continue', label: 'Continue to unit details', kind: 'primary' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    var input = body.querySelector('input');
    var clamp = function (v) { return Math.max(1, Math.min(left, v || 1)); };
    body.querySelector('[data-dec]').onclick = function () { input.value = clamp(+input.value - 1); };
    body.querySelector('[data-inc]').onclick = function () { input.value = clamp(+input.value + 1); };
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    body.querySelector('#jo-continue').onclick = function () {
      var k = quantity(input.value);
      if (k === null || k < 1 || k > left) { mToast('Enter a whole quantity within the remaining output.', 'err'); return; }
      var rows = [];
      for (var i = 0; i < k; i++) rows.push({ identifier: '', file: null, saved: false });
      var s = { key: mProductionDrafts.key(jo.id), rows: rows, batch: '' };
      var btn = body.querySelector('#jo-continue'); busy(btn, 'Saving draft…');
      persist(s).then(function () { sessions[jo.id] = s; go(jo.id, 'units'); }).catch(function (err) { draftError(err); btn.disabled = false; btn.textContent = 'Continue to unit details'; });
    };
  }

  function uploadUnit(jo, s, r) {
    if (s.key !== mProductionDrafts.key(jo.id)) return Promise.reject(new Error('Sign in with the account that entered this draft.'));
    if (r.attempt && r.attempt.state === 'conflict') return Promise.reject(new Error('This upload needs reconciliation. Ask a manager to check the unit record before recording it again.'));
    if (r.attempt && Date.now() - r.attempt.created >= 7 * 86400000) return Promise.reject(new Error('This retry is over seven days old. Ask a manager to reconcile the unit before recording it again.'));
    var previousAttempt = !!r.attempt;
    if (!r.attempt) r.attempt = { key: retryKey(), identifier: r.identifier.trim(), batch: s.batch.trim(), file: r.file, created: Date.now(), state: 'sending' };
    var a = r.attempt;
    a.state = 'sending';
    // Persist the exact request BEFORE it can reach the server. Multipart middleware
    // keys do not hash file bytes, so an uncertain attempt must never be edited.
    var started = false;
    return persist(s).then(function () {
      if (s.key !== mProductionDrafts.key(jo.id)) throw new Error('The signed-in account changed. Reopen the draft with its original account.');
      var fd = new FormData();
      fd.append('identifier', a.identifier);
      if (a.batch) fd.append('batch_label', a.batch);
      fd.append('image', a.file, a.file.name || 'unit.jpg');
      started = true;
      return API.upload('/job-orders/' + jo.id + '/units', fd, { idempotencyKey: a.key });
    }).then(function (res) {
      r.identifier = a.identifier; r.file = a.file;
      r.saved = true; r.unitId = res.id; r.local = API.syncLocal(res); a.state = 'confirmed';
      return persist(s).catch(function () { mToast('The unit was saved, but its draft confirmation could not be stored. Reopening will retry the original key safely.', 'err'); });
    }).catch(function (err) {
      if (r.saved) throw err;
      if (!started && !previousAttempt) r.attempt = null;
      else if (!started) a.state = 'unknown';
      else if (networkLost(err) || err.status >= 500 || err.status === 401) a.state = 'unknown';
      else if (err.status === 409) a.state = 'conflict';
      else if (err.status) r.attempt = null; // definitive refusal; editing starts a new request
      else a.state = 'unknown';
      return persist(s).catch(function () {}).then(function () { throw err; });
    });
  }
  var networkLost = function (err) { return !!(err && (err.offline || !err.status)); };

  /* ── 66:294 Unit details (one unit at a time) ────────────────────────────── */
  function units(view, jo, focus) {
    var s = sessions[jo.id];
    if (!s) { go(jo.id, 'count'); return; }
    var cur = focus != null ? focus : s.rows.findIndex(function (r) { return !r.saved; });
    if (cur === -1) { go(jo.id, 'interrupted'); return; }
    var n = s.rows.length;
    var body = leadPage(view, '66:294', 'Unit details', n + ' unit' + (n === 1 ? '' : 's') + ' · identifiers and photos required');
    var r = s.rows[cur];
    body.innerHTML =
      '<div class="rk-steps">' + s.rows.map(function (x, i) {
        return '<span class="' + (x.saved ? 'done' : i === cur ? 'cur' : '') + '">' + (i + 1) + '</span>';
      }).join('') + '</div>' +
      s.rows.map(function (x, i) {
        return x.saved ? '<div class="rk-card rk-unit done"><small>Unit ' + (i + 1) + '</small><img src="' + ICON + 'check-done.svg" alt="Saved">' +
          '<b>' + mEsc(x.identifier) + '</b><em>Unit #' + x.unitId + ' · ' + responseLabel(x) + '</em></div>' : '';
      }).join('') +
      '<div class="rk-card rk-unit"><small>Unit ' + (cur + 1) + ' of ' + n + '</small>' +
        '<label for="jo-ident">Identifier *</label><div class="idrow"><input id="jo-ident" value="' + mEsc(r.identifier) + '" placeholder="Scan or enter serial" autocomplete="off">' +
        '<button type="button" data-scan aria-label="Scan identifier"><img src="' + ICON + 'scan.svg" alt=""></button></div>' +
        '<button type="button" class="rk-photo' + (r.file ? ' has' : '') + '" data-photo><img src="' + ICON + 'camera.svg" alt="">' +
          (r.file ? '✓ Photo attached (retake)' : 'Take finished-unit photo *') + '</button></div>' +
      '<label class="rk-card rk-field"><small>Batch / lot (optional)</small><input class="rk-input" data-batch maxlength="80" value="' + mEsc(s.batch) + '" placeholder="Shared by these units"></label>' +
      R.actions([{ id: 'jo-save', label: cur === n - 1 || s.rows.filter(function (x) { return !x.saved; }).length === 1 ? 'Save unit' : 'Save & next unit', kind: 'primary' },
        { id: 'jo-review', label: 'Review all', kind: 'secondary' }]) +
      '<div data-review></div>';
    var ident = body.querySelector('#jo-ident');
    var isLocked = locked(r);
    ident.disabled = isLocked;
    body.querySelector('[data-batch]').disabled = isLocked;
    body.querySelector('[data-scan]').disabled = isLocked;
    body.querySelector('[data-photo]').disabled = isLocked;
    if (isLocked) body.insertAdjacentHTML('beforeend', R.note('warn', 'Confirmation unknown — the original identifier, lot and photo are locked. Resolve the original attempt before entering changes.'));
    ident.oninput = function () { r.identifier = ident.value; persist(s).catch(draftError); };
    body.querySelector('[data-batch]').oninput = function (e) { s.batch = e.target.value; persist(s).catch(draftError); };
    body.querySelector('[data-scan]').onclick = function () {
      mScanner.open({ title: 'Scan the unit’s serial / motor tag', onResult: function (c) { r.identifier = String(c || '').trim(); ident.value = r.identifier; persist(s).catch(draftError); } });
    };
    body.querySelector('[data-photo]').onclick = function () {
      mPhoto.pickFile().then(function (file) { r.file = file; return persist(s).then(function () { units(view, jo, cur); }); }).catch(draftError);
    };
    body.querySelector('#jo-review').onclick = function () {
      var host = body.querySelector('[data-review]');
      host.innerHTML = '<div class="rk-card rk-status"><small>All units</small>' + s.rows.map(function (x, i) {
        return '<div><button type="button" class="rk-back" data-row="' + i + '" style="padding:0">Unit ' + (i + 1) + '</button><span>' +
          (x.saved ? responseLabel(x) + ' · ' + mEsc(x.identifier) : locked(x) ? 'Confirmation unknown' : x.identifier && x.file ? 'Not started · ready to save' : x.identifier || x.file ? 'Incomplete' : 'Not entered') + '</span></div>';
      }).join('') + '</div>';
      Array.prototype.forEach.call(host.querySelectorAll('[data-row]'), function (b) {
        b.onclick = function () { var i = +b.dataset.row; if (!s.rows[i].saved) units(view, jo, i); };
      });
    };
    var save = body.querySelector('#jo-save');
    save.onclick = function () {
      if (!isLocked) r.identifier = ident.value;
      if (!r.identifier.trim()) { mToast('Every unit needs an identifier', 'err'); ident.focus(); return; }
      if (!r.file) { mToast('Every unit needs a photo', 'err'); return; }
      if (offline()) { go(jo.id, 'interrupted'); return; }
      busy(save, 'Saving unit ' + (cur + 1) + '…');
      ident.disabled = true;
      body.querySelector('[data-batch]').disabled = true;
      body.querySelector('[data-photo]').disabled = true;
      body.querySelector('[data-scan]').disabled = true;
      uploadUnit(jo, s, r).then(function () { units(view, jo); }).catch(function (err) {
        if (networkLost(err) || locked(r)) { go(jo.id, 'interrupted'); mToast(err.message || 'Confirmation unknown', 'err'); return; }
        mToast(err.message || 'The upload was refused', 'err');
        units(view, jo, cur);
      });
    };
  }

  /* ── 66:356 Connection interrupted ───────────────────────────────────────── */
  function interrupted(view, jo) {
    var s = sessions[jo.id];
    if (!s) { reopen(jo.id); return; }
    var saved = s.rows.filter(function (r) { return r.saved; });
    var confirmed = saved.filter(function (r) { return !r.local; });
    var pending = s.rows.filter(function (r) { return !r.saved; });
    var unknown = pending.filter(locked);
    var untouched = pending.filter(function (r) { return !locked(r); });
    var localRows = saved.filter(function (r) { return r.local; });
    var body = leadPage(view, '66:356', pending.length ? 'Connection interrupted' : 'Recording results', confirmed.length + ' confirmed · ' + unknown.length + ' confirmation unknown · ' + untouched.length + ' not started' + (localRows.length ? ' · ' + localRows.length + ' saved on site PC' : ''));
    var row = function (r, text) { return '<div><span>Unit ' + (s.rows.indexOf(r) + 1) + ' · ' + mEsc(r.identifier || 'Not entered') + '</span><span>' + mEsc(text) + '</span></div>'; };
    body.innerHTML =
      '<div class="rk-alert"><img src="' + ICON + 'alert.svg" alt=""><b>Confirmed ' + confirmed.length + ' of ' + s.rows.length + '</b>' +
        '<span>' + (unknown.length ? 'A missing response does not mean the unit was not saved. Retry the original attempt to check.' : 'Only units with a response are shown as saved.') + '</span></div>' +
      (saved.length ? '<div class="rk-card rk-status saved"><small>Saved results</small>' + saved.map(function (r) { return row(r, responseLabel(r) + ' · #' + r.unitId); }).join('') + '<div data-sync-results></div></div>' : '') +
      (unknown.length ? '<div class="rk-card rk-status"><small>Confirmation unknown</small>' + unknown.map(function (r) { return row(r, r.attempt.state === 'conflict' ? 'Conflict — manager reconciliation needed' : 'Original identifier, lot and photo retained'); }).join('') + '</div>' : '') +
      (untouched.length ? '<div class="rk-card rk-status"><small>Not started</small>' + untouched.map(function (r) { return row(r, r.file ? 'Photo and identifier retained on this device' : 'Photo still needed'); }).join('') + '</div>' : '') +
      R.note('info', 'Entries and photos are stored for this account on this device. Do not re-enter saved or uncertain units. Clearing site data removes these drafts.') +
      R.actions((pending.length ? [{ id: 'jo-retry', label: unknown.length ? 'Retry original ' + unknown.length : 'Continue ' + untouched.length, kind: 'primary' }] : []).concat([{ id: 'jo-return', label: 'Return to job', kind: 'secondary' }])) +
      (untouched.length ? R.actions([{ id: 'jo-discard', label: 'Discard unstarted entries', kind: 'secondary' }]) : '');
    localRows.forEach(function (r) {
      body.querySelector('[data-sync-results]').appendChild(R.syncWatch(r.local, function (status) {
        if (status.state !== 'confirmed' || !r.local) return;
        r.local = null;
        persist(s).then(function () { if (body.isConnected) interrupted(view, jo); }).catch(draftError);
      }));
    });
    var retry = body.querySelector('#jo-retry');
    if (retry) retry.onclick = function () {
      if (offline()) { mToast('Still offline — try again once you have a connection', 'err'); return; }
      busy(retry, 'Sending…');
      // Resolve uncertain rows first with their immutable keys; never submit confirmed rows.
      var chain = Promise.resolve();
      unknown.concat(untouched).forEach(function (r) {
        chain = chain.then(function () { if (r.identifier.trim() && r.file) return uploadUnit(jo, s, r); });
      });
      chain.then(function () { go(jo.id, 'units'); }).catch(function (err) {
        if (networkLost(err)) { interrupted(view, jo); mToast('Connection lost again', 'err'); return; }
        mToast(err.message || 'Failed', 'err'); go(jo.id, 'units');
      });
    };
    body.querySelector('#jo-return').onclick = function () {
      if (pending.length || localRows.some(function (r) { return r.local; })) { reopen(jo.id); return; }
      mProductionDrafts.remove(s).then(function () { delete sessions[jo.id]; reopen(jo.id); }).catch(draftError);
    };
    var discard = body.querySelector('#jo-discard');
    if (discard) discard.onclick = function () {
      if (!window.confirm('Discard ' + untouched.length + ' entries that were never submitted, including their photos? Saved and uncertain attempts will be kept.')) return;
      var next = Object.assign({}, s, { rows: s.rows.filter(function (r) { return r.saved || locked(r); }) });
      var write = next.rows.length ? persist(next) : mProductionDrafts.remove(s);
      write.then(function () {
        if (next.rows.length) { sessions[jo.id] = next; interrupted(view, jo); }
        else { delete sessions[jo.id]; reopen(jo.id); }
      }).catch(draftError);
    };
  }

  /* ── 66:408 Record non-serialized output ─────────────────────────────────── */
  function output(view, jo) {
    var body = leadPage(view, '66:408', 'Record non-serialized output', 'No inspection stages · output proceeds to Products In');
    body.innerHTML =
      '<label class="rk-card rk-field"><small>Finished</small><input class="rk-input" type="number" inputmode="numeric" min="0" data-done value="0"></label>' +
      '<label class="rk-card rk-field"><small>Scrapped</small><input class="rk-input" type="number" inputmode="numeric" min="0" data-scrap value="0"></label>' +
      '<label class="rk-card rk-field"><small>Batch / lot</small><input class="rk-input" data-batch maxlength="80" placeholder="auto BATCH-#####"></label>' +
      R.note('info', '<h3>Next: Products In</h3>This product has 0 inspection stages. Saving does not add stock yet.') +
      '<div class="rk-card rk-field" data-tally></div>' +
      R.actions([{ id: 'jo-save', label: 'Save progress', kind: 'primary' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    var d = body.querySelector('[data-done]'), sc = body.querySelector('[data-scrap]'), tally = body.querySelector('[data-tally]');
    function paintTally() {
      var acc = jo.qty_done + jo.qty_scrapped + unresolved(jo) + (quantity(d.value) || 0) + (quantity(sc.value) || 0);
      tally.innerHTML = '<b style="margin:0;display:flex;justify-content:space-between"><span>' + acc + ' accounted for of ' + jo.qty_ordered + ' ordered</span>' +
        '<span style="font-weight:400;color:var(--rk-meta)">' + Math.max(0, jo.qty_ordered - acc) + ' remaining</span></b>';
    }
    d.oninput = sc.oninput = paintTally; paintTally();
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    var save = body.querySelector('#jo-save');
    save.onclick = function () {
      var dn = quantity(d.value), sn = quantity(sc.value);
      if (dn === null || sn === null || dn + sn > remaining(jo)) { mToast('Enter whole non-negative quantities within the remaining output.', 'err'); return; }
      if (dn + sn < 1) { mToast('Enter finished and/or scrapped', 'err'); return; }
      if (offline()) { mToast('You’re offline — saving output needs a connection.', 'err'); return; }
      busy(save, 'Saving…');
      submitAction(view, jo, 'output', { done_delta: dn, scrapped_delta: sn, batch_label: body.querySelector('[data-batch]').value.trim() || null }, save);
    };
  }

  /* ── 66:462 Record production scrap ──────────────────────────────────────── */
  function scrap(view, jo) {
    var body = leadPage(view, '66:462', 'Record production scrap', 'Scrap is counted and never enters inspection');
    body.innerHTML =
      R.field('Job order', jo.number + ' · ' + jo.product_name) +
      '<label class="rk-card rk-field"><small>Scrapped now</small><input class="rk-input" type="number" inputmode="numeric" min="1" max="' + remaining(jo) + '" data-n value="1"></label>' +
      '<label class="rk-card rk-field"><small>Reason</small><input class="rk-input" data-reason maxlength="300" placeholder="e.g. frame damage during final assembly"></label>' +
      '<div class="rk-alert"><img src="' + ICON + 'alert.svg" alt=""><b style="font-size:13px">This unit will not enter QC</b>' +
        '<span>The quantity counts toward job-order output as scrapped and remains auditable.</span></div>' +
      R.actions([{ id: 'jo-save', label: 'Record scrap', kind: 'danger' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    var save = body.querySelector('#jo-save');
    save.onclick = function () {
      var n = quantity(body.querySelector('[data-n]').value);
      var reason = body.querySelector('[data-reason]').value.trim();
      if (n === null || n < 1 || n > remaining(jo)) { mToast('Enter a whole scrapped quantity within the remaining output.', 'err'); return; }
      if (!reason) { mToast('Give the scrap reason', 'err'); body.querySelector('[data-reason]').focus(); return; }
      if (offline()) { mToast('You’re offline — recording scrap needs a connection.', 'err'); return; }
      busy(save, 'Recording…');
      submitAction(view, jo, 'scrap', { scrapped_delta: n, reason: reason }, save);
    };
  }

  /* ── 66:580 Manager actions ──────────────────────────────────────────────── */
  function manage(view, jo) {
    var body = managerPage(view, '66:580', 'Manager actions', 'Restricted controls for ' + jo.number);
    var paused = jo.status === 'paused';
    var running = jo.status === 'released' || jo.status === 'in_progress';
    var row = function (cls, icon, title, sub) {
      return '<button type="button" class="rk-act ' + cls + '" data-act="' + cls + '"><img src="' + ICON + icon + '" alt=""><b>' + title + '</b>' +
        '<img class="go" src="' + ICON + 'open-chevron.svg" alt=""><span>' + sub + '</span></button>';
    };
    body.innerHTML =
      '<div class="rk-jobhead"><span class="rk-no">' + mEsc(jo.number) + '</span><span></span>' +
        '<span class="rk-name" style="font-size:16px">' + mEsc(jo.product_name + ' · ' + jo.qty_done + ' / ' + jo.qty_ordered + ' recorded') + '</span>' +
        '<span class="rk-meta">' + (paused ? 'Currently paused · since ' + mEsc(time(jo.paused_at)) : 'Status: ' + mEsc(String(jo.status).replace('_', ' '))) + '</span></div>' +
      '<div class="rk-card rk-acts">' +
        (paused && canPause() ? row('resume', 'act-resume.svg', 'Resume production', 'Continue recording units') : '') +
        (running && canPause() ? row('pause', 'act-pause.svg', 'Pause production', 'Temporarily stop work') : '') +
        ((running || paused) && canManage() ? row('close', 'act-close.svg', 'Close out early', 'Finish below ordered quantity') : '') +
        row('history', 'act-history.svg', 'View audit history', 'Review manager actions') +
      '</div>' +
      R.note('info', '<b>Every action requires a reason and creates an audit entry.</b>');
    Array.prototype.forEach.call(body.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () { go(jo.id, b.dataset.act); };
    });
  }

  /* Pause / resume with a reason (manager accent — same audit rules as close) */
  function reasonAction(view, jo, action) {
    var pause = action === 'pause';
    var body = managerPage(view, '66:580', pause ? 'Pause production' : 'Resume production', 'Restricted controls for ' + jo.number);
    body.innerHTML =
      R.jobHead({ number: jo.number, name: jo.product_name + ' · ' + jo.qty_done + ' / ' + jo.qty_ordered + ' recorded' }) +
      '<label class="rk-card rk-field"><small>Reason' + (reasonRequired() ? ' *' : ' (optional)') + '</small><input class="rk-input" data-reason maxlength="500" placeholder="' +
        (pause ? 'e.g. switching to a higher-priority job order' : 'e.g. rush order finished') + '"></label>' +
      R.note('info', 'This is recorded with your name and the time in the job order’s audit history.') +
      R.actions([{ id: 'jo-do', label: pause ? 'Pause production' : 'Resume production', kind: 'primary' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    var btn = body.querySelector('#jo-do');
    btn.onclick = function () {
      var reason = body.querySelector('[data-reason]').value.trim();
      if (!reason && reasonRequired()) { mToast('A reason is required', 'err'); body.querySelector('[data-reason]').focus(); return; }
      if (offline()) { mToast('You’re offline — this needs a connection.', 'err'); return; }
      busy(btn, pause ? 'Pausing…' : 'Resuming…');
      API.post('/job-orders/' + jo.id + '/' + action, { reason: reason || null })
        .then(function () { mToast(pause ? 'Paused' : 'Resumed'); reopen(jo.id); })
        .catch(fail(btn, pause ? 'Pause production' : 'Resume production'));
    };
  }

  /* ── 66:650 Close job order early ────────────────────────────────────────── */
  function closeEarly(view, jo) {
    var body = managerPage(view, '66:650', 'Close job order early', 'Manager-only irreversible exception');
    var summary = jo.units_summary || {};
    var built = (summary.pending || 0) + (summary.rework || 0) + (summary.hold || 0);
    var notMade = remaining(jo);
    body.innerHTML =
      '<div class="rk-alert"><img src="' + ICON + 'alert.svg" alt=""><b>' + notMade + ' unit' + (notMade === 1 ? '' : 's') + ' will not be produced</b>' +
        '<span>' + jo.qty_done + ' completed · ' + built + ' awaiting inspection/rework · ' + jo.qty_scrapped + ' scrap · ' + jo.qty_ordered + ' ordered<br><br>Unused reserved components will be returned.</span></div>' +
      '<label class="rk-card rk-field"><small>Reason' + (reasonRequired() ? ' *' : ' (optional)') + '</small><input class="rk-input" data-reason maxlength="500" placeholder="e.g. customer reduced the required quantity"></label>' +
      R.note('info', '<h3>Closing early will:</h3><ul><li>Stop further production recording</li><li>Return unused reserved components</li>' +
        '<li>Preserve all recorded units and audit history</li><li>Keep built units and parts requests for QC/QA, rework and receiving</li></ul>') +
      R.check('jo-reviewed', 'I reviewed the remaining quantity and effects') +
      R.actions([{ id: 'jo-close', label: 'Close job order', kind: 'danger' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    var btn = body.querySelector('#jo-close'), chk = body.querySelector('#jo-reviewed');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    btn.onclick = function () {
      var reason = body.querySelector('[data-reason]').value.trim();
      if (!reason && reasonRequired()) { mToast('A reason is required', 'err'); body.querySelector('[data-reason]').focus(); return; }
      if (offline()) { mToast('You’re offline — closing a job order needs a connection.', 'err'); return; }
      busy(btn, 'Closing…');
      API.post('/job-orders/' + jo.id + '/close', { reason: reason || null })
        .then(function () { mToast(jo.number + ' closed early'); reopen(jo.id); })
        .catch(fail(btn, 'Close job order'));
    };
  }

  /* Audit history (job_order_events) */
  function historyView(view, jo) {
    var body = managerPage(view, '66:580', 'Audit history', jo.number + ' · pause, resume and close-early decisions');
    body.innerHTML = R.skeleton(1);
    API.get('/job-orders/' + jo.id + '/events').then(function (ev) {
      body.innerHTML = ev.length ? '<div class="rk-card rk-events">' + ev.map(function (e) {
        return '<div><b>' + mEsc(String(e.action).replace('_', ' ')) + '</b> · ' + mEsc(e.actor_name || '—') +
          '<span>' + mEsc(when(e.created_at)) + (e.reason ? ' — ' + mEsc(e.reason) : '') + '</span></div>';
      }).join('') + '</div>' : '<div class="rk-empty">No pause, resume or close-early decisions yet.</div>';
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { historyView(view, jo); })); });
  }

  function repack(view,jo){
    if(!(canManage()||can('production.approve'))||!jo.conversion_job_order_id){active(view,jo);return;}
    var body=leadPage(view,'66:185','Return complete semi-built package','Only before the first inspection');body.innerHTML=R.note('warn','Repack and verify the entire original package before returning it to semi-built stock. The backend refuses this action after inspection begins.')+'<label class="rk-card rk-field"><small>Reason</small><textarea class="rk-input" data-repack-note maxlength="500"></textarea></label>'+R.check('repacked','The complete package is repacked and physically present')+R.actions([{id:'repack-save',label:'Confirm return to semi-built RTS',kind:'primary'}]);
    body.querySelector('#repack-save').onclick=async function(){var btn=this;try{var reason=body.querySelector('[data-repack-note]').value.trim();if(!reason||!body.querySelector('#repacked').checked)throw new Error('Confirm the complete repacked package and record the reason.');btn.disabled=true;var s=await mWorkflow.draft('semi-finishing');if(s.operation.state==='draft')await mWorkflow.start(s,{path:'/job-orders/'+jo.id+'/cancel',payload:{reason:reason,confirmed_repacked:true},title:'Return complete package for '+jo.number,reviewRoute:'job-orders',reviewParams:{id:jo.id},reviewPath:'/job-orders/'+jo.id});mWorkflow.paint(view,s);}catch(e){mToast(e.message,'err');btn.disabled=false;}};
  }
  var STEPS = {
    repack:repack, problem: problem, count: count, units: function (v, jo) { units(v, jo); }, interrupted: interrupted, output: output, scrap: scrap,
    manage: manage, pause: function (v, jo) { reasonAction(v, jo, 'pause'); }, resume: function (v, jo) { reasonAction(v, jo, 'resume'); },
    close: closeEarly, history: historyView,
  };

  MApp.route('job-orders', function (view, params) {
    var id = params && Number(params.id);
    if (!id && params && params.view === 'approval') { approvalQueue(view); return; }
    if (id && params.step && STEPS[params.step]) { loadInto(view, id, function (jo) { if(jo.conversion_job_order_id&&['count','units','output','scrap'].indexOf(params.step)!==-1){active(view,jo);return;}STEPS[params.step](view, jo); }); return; }
    if (id) { open1(view, id); return; }
    // Production Manager lands on exceptions; everyone else (and "View all") on the board.
    if (isManager() && !(params && params.view === 'all')) control(view);
    else board(view, params && params.tab);
  });
})();
