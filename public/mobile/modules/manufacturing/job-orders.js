/* Production — job orders for the Production Lead and Production Manager. Figma page 66:*:
     Lead (blue):    66:14 Job orders · 66:79 Accept parts kit · 66:133 Report kit problem
                     66:185 Active production · 66:240 Record production · 66:294 Unit details
                     66:356 Connection interrupted · 66:408 Non-serialized output · 66:462 Scrap
     Manager (purple): 66:515 Production control · 66:580 Manager actions · 66:650 Close early
   Backend (job-orders.routes.ts): accept (production.record) gates /progress and /units until
   the lead signs for the kit; serialized units go one at a time through POST /:id/units
   (identifier + photo in one multipart request — never queued offline, because the unit needs
   its server id and photo together); pause/resume/close need a reason unless the caller holds
   inventory.adjust, and land in job_order_events (GET /:id/events). A kit problem is a tracked
   production issue. Each step is its own URL so the header back arrow walks the flow:
   #/job-orders[?view=all] · ?id=<jo> · ?id=<jo>&step=problem|count|units|interrupted|output|
   scrap|manage|pause|resume|close|history */
(function () {
  var R = window.RoleUI;
  var ICON = '/mobile/icons/v2/';
  var PROBLEM_DRAFT = 'vds_kit_problem_draft_';
  // Units being entered, per job order: { rows: [{ identifier, file, saved }], batch }. Memory
  // only — photos are File objects and never touch storage; leaving the app drops unsent rows.
  var sessions = {};

  var canAdjust = function () { return MApp.can('inventory.adjust'); };
  var canRecord = function () { return canAdjust() || MApp.can('production.record'); };
  var canManage = function () { return canAdjust() || MApp.can('production.manage'); };
  var canPause = function () { return canManage() || MApp.can('production.pause'); };
  var canInspect = function () { return canAdjust() || MApp.can('production.inspect_qc') || MApp.can('production.inspect_qa'); };
  var reasonRequired = function () { return !canAdjust(); };
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
  var remaining = function (jo) { return Math.max(0, jo.qty_ordered - jo.qty_done - jo.qty_scrapped); };

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
    API.get('/job-orders/' + id).then(function (jo) { render(jo); }).catch(function (err) {
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
    API.get('/job-orders').then(function (rows) {
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
        R.actions([{ id: 'pm-all', label: 'View all production', kind: 'secondary' }]);
      var host = body.querySelector('[data-list]');
      host.innerHTML = ex.length ? ex.map(function (x) {
        var j = x.j;
        var pill = x.kind === 'paused' ? { text: 'Paused', tone: 'purple' } : x.kind === 'overdue' ? { text: 'Overdue', tone: 'danger' } : { text: 'Blocked', tone: 'warn' };
        var meta = x.kind === 'paused' ? ['Paused ' + time(j.paused_at), j.qty_done + '/' + j.qty_ordered + ' recorded'].join(' · ')
          : x.kind === 'overdue' ? ['Overdue', j.qty_done + '/' + j.qty_ordered + ' recorded'].join(' · ')
          : j.open_issues + ' open issue' + (j.open_issues === 1 ? '' : 's') + ' · awaiting resolution';
        return R.jobCard({ id: j.id, number: j.number, name: j.product_name, pill: pill, meta: meta });
      }).join('') : '<div class="rk-empty">No paused, overdue or blocked job orders.</div>';
      Array.prototype.forEach.call(host.querySelectorAll('[data-id]'), function (b) {
        b.onclick = function () { go(b.dataset.id, 'manage'); };
      });
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

  // A draft is the warehouse's (kit release) or the approver's business, not the line's.
  function draftView(view, jo) {
    var body = leadPage(view, '66:14', jo.number, 'Not released to production yet');
    body.innerHTML = R.jobHead({ number: jo.number, name: jo.product_name, pill: { text: 'Draft' }, meta: [jo.team_name, dueText(jo.due_date)].filter(Boolean).join(' · ') }) +
      R.note('info', !jo.approved_at ? 'Waiting for a production manager to approve it.' : 'Approved — the warehouse is preparing and releasing the parts kit.') +
      '<div data-acts></div>';
    var acts = [];
    if (MApp.can('production.approve') && !jo.approved_at) acts.push({ id: 'jo-approve', label: 'Approve', kind: 'primary' });
    if (canAdjust() && jo.approved_at) acts.push({ id: 'jo-kit', label: 'Open kit release', kind: 'primary' });
    body.querySelector('[data-acts]').innerHTML = acts.length ? R.actions(acts) : '';
    var ap = body.querySelector('#jo-approve');
    if (ap) ap.onclick = function () {
      busy(ap, 'Approving…');
      API.post('/job-orders/' + jo.id + '/approve', {}).then(function () { MApp.render(); }).catch(fail(ap, 'Approve'));
    };
    var kit = body.querySelector('#jo-kit');
    if (kit) kit.onclick = function () { MApp.go('kit-release', { id: jo.id }); };
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
      API.post('/job-orders/' + jo.id + '/accept', { notes: note || null })
        .then(function () { mToast('Kit accepted — you can record production now'); reopen(jo.id); })
        .catch(fail(btn, 'Accept job order'));
    };
    body.querySelector('#jo-problem').onclick = function () { go(jo.id, 'problem'); };
  }

  /* ── 66:133 Report kit problem (tracked production issue) ───────────────── */
  var PROBLEM_TYPES = ['Missing or damaged components', 'Wrong components', 'Quantity mismatch', 'Other kit problem'];
  function problem(view, jo) {
    var body = leadPage(view, '66:133', 'Report kit problem', 'Production stays blocked until Warehouse resolves it');
    var key = PROBLEM_DRAFT + jo.id, draft = null;
    try { draft = JSON.parse(localStorage.getItem(key) || 'null'); } catch (ignore) {}
    body.innerHTML =
      R.field('Linked job order', jo.number + ' · ' + jo.product_name) +
      '<label class="rk-card rk-field"><small>Problem type</small><select data-type>' + PROBLEM_TYPES.map(function (t) {
        return '<option' + (draft && draft.type === t ? ' selected' : '') + '>' + mEsc(t) + '</option>'; }).join('') + '</select></label>' +
      '<label class="rk-card rk-field"><small>Details</small><textarea rows="4" maxlength="3500" data-details placeholder="Be specific: part name, quantity and condition.">' +
        mEsc((draft && draft.details) || '') + '</textarea></label>' +
      R.note('warn', '<b>Routes to Warehouse + Production Manager</b><br>Recording remains locked until you accept the kit.') +
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

    var acts = [];
    var canBuild = canRecord() && !paused && !closed && !awaitingAcceptance(jo);
    if (canBuild && left > 0) acts.push({ id: 'jo-record', label: 'Record production', kind: 'primary' });
    if (canBuild && serialized) acts.push({ id: 'jo-scrap', label: 'Report scrap', kind: 'secondary' });
    if (paused && canPause() && !canManage()) acts.push({ id: 'jo-resume', label: 'Resume', kind: 'primary' });
    if (!paused && !closed && canPause() && !canManage()) acts.push({ id: 'jo-pause', label: 'Pause', kind: 'secondary' });
    if (canManage() && !closed) acts.push({ id: 'jo-manage', label: 'Manager actions', kind: acts.length ? 'secondary' : 'primary' });
    body.querySelector('[data-acts]').innerHTML = acts.length ? R.actions(acts.slice(0, 2)) + (acts.length > 2 ? R.actions(acts.slice(2)) : '') : '';
    var on = function (sel, fn) { var el = body.querySelector(sel); if (el) el.onclick = fn; };
    on('#jo-record', function () { go(jo.id, serialized ? 'count' : 'output'); });
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
    var left = remaining(jo);
    var body = leadPage(view, '66:240', 'Record production', 'Choose how many finished units to enter');
    if (left <= 0) { body.innerHTML = R.note('info', 'Every ordered unit is already accounted for.'); return; }
    var n = Math.min(5, left);
    body.innerHTML =
      '<div class="rk-stepper"><small>Units to record now</small><div class="row"><button type="button" data-dec aria-label="Fewer">−</button>' +
        '<input type="number" inputmode="numeric" min="1" max="' + left + '" value="' + n + '" aria-label="Units to record"><button type="button" data-inc aria-label="More">+</button></div>' +
        '<p>' + left + ' remaining on this job order</p></div>' +
      R.note('info', '<h3>For each unit you will need:</h3><ul><li>Unique motor or serial identifier</li><li>One clear finished-unit photo</li><li>Optional shared batch/lot label</li></ul>') +
      '<div class="rk-note danger"><img src="' + ICON + 'alert.svg" alt=""><span>This step requires a connection. Entries are saved one unit at a time.</span></div>' +
      R.actions([{ id: 'jo-continue', label: 'Continue to unit details', kind: 'primary' }, { id: 'jo-cancel', label: 'Cancel', kind: 'secondary' }]);
    var input = body.querySelector('input');
    var clamp = function (v) { return Math.max(1, Math.min(left, v || 1)); };
    body.querySelector('[data-dec]').onclick = function () { input.value = clamp(+input.value - 1); };
    body.querySelector('[data-inc]').onclick = function () { input.value = clamp(+input.value + 1); };
    input.onchange = function () { input.value = clamp(parseInt(input.value, 10)); };
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    body.querySelector('#jo-continue').onclick = function () {
      var k = clamp(parseInt(input.value, 10));
      var rows = [];
      for (var i = 0; i < k; i++) rows.push({ identifier: '', file: null, saved: false });
      sessions[jo.id] = { rows: rows, batch: (sessions[jo.id] && sessions[jo.id].batch) || '' };
      go(jo.id, 'units');
    };
  }

  function uploadUnit(jo, s, r) {
    var fd = new FormData();
    fd.append('identifier', r.identifier.trim());
    if (s.batch.trim()) fd.append('batch_label', s.batch.trim());
    fd.append('image', r.file, r.file.name || 'unit.jpg');
    return API.upload('/job-orders/' + jo.id + '/units', fd).then(function () { r.saved = true; });
  }
  var networkLost = function (err) { return !!(err && (err.offline || !err.status)); };

  /* ── 66:294 Unit details (one unit at a time) ────────────────────────────── */
  function units(view, jo, focus) {
    var s = sessions[jo.id];
    if (!s) { go(jo.id, 'count'); return; }
    var cur = focus != null ? focus : s.rows.findIndex(function (r) { return !r.saved; });
    if (cur === -1) { delete sessions[jo.id]; mToast('All units recorded'); reopen(jo.id); return; }
    var n = s.rows.length;
    var body = leadPage(view, '66:294', 'Unit details', n + ' unit' + (n === 1 ? '' : 's') + ' · identifiers and photos required');
    var r = s.rows[cur];
    body.innerHTML =
      '<div class="rk-steps">' + s.rows.map(function (x, i) {
        return '<span class="' + (x.saved ? 'done' : i === cur ? 'cur' : '') + '">' + (i + 1) + '</span>';
      }).join('') + '</div>' +
      s.rows.map(function (x, i) {
        return x.saved ? '<div class="rk-card rk-unit done"><small>Unit ' + (i + 1) + '</small><img src="' + ICON + 'check-done.svg" alt="Saved">' +
          '<b>' + mEsc(x.identifier) + '</b><em>✓ Photo attached · saved</em></div>' : '';
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
    ident.oninput = function () { r.identifier = ident.value; };
    body.querySelector('[data-batch]').oninput = function (e) { s.batch = e.target.value; };
    body.querySelector('[data-scan]').onclick = function () {
      mScanner.open({ title: 'Scan the unit’s serial / motor tag', onResult: function (c) { r.identifier = String(c || '').trim(); ident.value = r.identifier; } });
    };
    body.querySelector('[data-photo]').onclick = function () {
      mPhoto.pickFile().then(function (file) { r.file = file; units(view, jo, cur); }).catch(function () {});
    };
    body.querySelector('#jo-review').onclick = function () {
      var host = body.querySelector('[data-review]');
      host.innerHTML = '<div class="rk-card rk-status"><small>All units</small>' + s.rows.map(function (x, i) {
        return '<div><button type="button" class="rk-back" data-row="' + i + '" style="padding:0">Unit ' + (i + 1) + '</button><span>' +
          (x.saved ? 'Saved · ' + mEsc(x.identifier) : x.identifier && x.file ? 'Ready to save' : x.identifier || x.file ? 'Incomplete' : 'Not entered') + '</span></div>';
      }).join('') + '</div>';
      Array.prototype.forEach.call(host.querySelectorAll('[data-row]'), function (b) {
        b.onclick = function () { var i = +b.dataset.row; if (!s.rows[i].saved) units(view, jo, i); };
      });
    };
    var save = body.querySelector('#jo-save');
    save.onclick = function () {
      r.identifier = ident.value;
      if (!r.identifier.trim()) { mToast('Every unit needs an identifier', 'err'); ident.focus(); return; }
      if (!r.file) { mToast('Every unit needs a photo', 'err'); return; }
      if (offline()) { go(jo.id, 'interrupted'); return; }
      busy(save, 'Saving unit ' + (cur + 1) + '…');
      uploadUnit(jo, s, r).then(function () { units(view, jo); }).catch(function (err) {
        if (networkLost(err)) { go(jo.id, 'interrupted'); return; }
        fail(save, 'Save & next unit')(err);
      });
    };
  }

  /* ── 66:356 Connection interrupted ───────────────────────────────────────── */
  function interrupted(view, jo) {
    var s = sessions[jo.id];
    if (!s) { reopen(jo.id); return; }
    var saved = s.rows.filter(function (r) { return r.saved; });
    var pending = s.rows.filter(function (r) { return !r.saved; });
    var body = leadPage(view, '66:356', 'Connection interrupted', saved.length + ' of ' + s.rows.length + ' units were recorded successfully');
    body.innerHTML =
      '<div class="rk-alert"><img src="' + ICON + 'alert.svg" alt=""><b>Recorded ' + saved.length + ' of ' + s.rows.length + '</b>' +
        '<span>Connection was lost during Unit ' + (saved.length + 1) + '.<br><b style="font-size:10px">Saved units were removed from this form.</b></span></div>' +
      (saved.length ? '<div class="rk-card rk-status saved"><small>Saved on server</small>' + saved.map(function (r) {
        return '<div><span>Unit ' + (s.rows.indexOf(r) + 1) + '  ' + mEsc(r.identifier) + '</span><span>✓</span></div>'; }).join('') + '</div>' : '') +
      '<div class="rk-card rk-status"><small>Still to send</small>' + pending.map(function (r) {
        return '<div><span>Unit ' + (s.rows.indexOf(r) + 1) + '</span><span>' + (r.identifier && r.file ? 'Identifier + photo kept on this screen' : 'Not entered yet') + '</span></div>';
      }).join('') + (saved.length ? '<p class="warn">Do not re-enter Unit' + (saved.length === 1 ? ' 1' : 's 1–' + saved.length) + '.</p>' : '') + '</div>' +
      R.actions([{ id: 'jo-retry', label: 'Retry remaining ' + pending.length, kind: 'primary' }, { id: 'jo-return', label: 'Return to job', kind: 'secondary' }]);
    var retry = body.querySelector('#jo-retry');
    retry.onclick = function () {
      if (offline()) { mToast('Still offline — try again once you have a connection', 'err'); return; }
      busy(retry, 'Sending…');
      // Only rows that are complete; the server never sees a row twice because saved rows are skipped.
      var chain = Promise.resolve();
      pending.forEach(function (r) {
        chain = chain.then(function () { if (r.identifier.trim() && r.file) return uploadUnit(jo, s, r); });
      });
      chain.then(function () { go(jo.id, 'units'); }).catch(function (err) {
        if (networkLost(err)) { interrupted(view, jo); mToast('Connection lost again', 'err'); return; }
        mToast(err.message || 'Failed', 'err'); go(jo.id, 'units');
      });
    };
    body.querySelector('#jo-return').onclick = function () { reopen(jo.id); };
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
      var acc = jo.qty_done + jo.qty_scrapped + (parseInt(d.value, 10) || 0) + (parseInt(sc.value, 10) || 0);
      tally.innerHTML = '<b style="margin:0;display:flex;justify-content:space-between"><span>' + acc + ' accounted for of ' + jo.qty_ordered + ' ordered</span>' +
        '<span style="font-weight:400;color:var(--rk-meta)">' + Math.max(0, jo.qty_ordered - acc) + ' remaining</span></b>';
    }
    d.oninput = sc.oninput = paintTally; paintTally();
    body.querySelector('#jo-cancel').onclick = function () { history.back(); };
    var save = body.querySelector('#jo-save');
    save.onclick = function () {
      var dn = parseInt(d.value, 10) || 0, sn = parseInt(sc.value, 10) || 0;
      if (dn + sn < 1) { mToast('Enter finished and/or scrapped', 'err'); return; }
      if (offline()) { mToast('You’re offline — saving output needs a connection.', 'err'); return; }
      busy(save, 'Saving…');
      API.post('/job-orders/' + jo.id + '/progress', { done_delta: dn, scrapped_delta: sn, batch_label: body.querySelector('[data-batch]').value.trim() || null })
        .then(function () { mToast('Progress saved'); reopen(jo.id); }).catch(fail(save, 'Save progress'));
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
      var n = parseInt(body.querySelector('[data-n]').value, 10) || 0;
      var reason = body.querySelector('[data-reason]').value.trim();
      if (n < 1) { mToast('Enter a scrapped quantity', 'err'); return; }
      if (!reason) { mToast('Give the scrap reason', 'err'); body.querySelector('[data-reason]').focus(); return; }
      if (offline()) { mToast('You’re offline — recording scrap needs a connection.', 'err'); return; }
      busy(save, 'Recording…');
      API.post('/job-orders/' + jo.id + '/progress', { scrapped_delta: n, reason: reason })
        .then(function () { mToast(n + ' scrapped'); reopen(jo.id); }).catch(fail(save, 'Record scrap'));
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
    var notMade = remaining(jo);
    body.innerHTML =
      '<div class="rk-alert"><img src="' + ICON + 'alert.svg" alt=""><b>' + notMade + ' unit' + (notMade === 1 ? '' : 's') + ' will not be produced</b>' +
        '<span>' + jo.qty_done + ' completed · ' + jo.qty_scrapped + ' scrap · ' + jo.qty_ordered + ' ordered<br><br>Unused reserved components will be returned.</span></div>' +
      '<label class="rk-card rk-field"><small>Reason' + (reasonRequired() ? ' *' : ' (optional)') + '</small><input class="rk-input" data-reason maxlength="500" placeholder="e.g. customer reduced the required quantity"></label>' +
      R.note('info', '<h3>Closing early will:</h3><ul><li>Stop further production recording</li><li>Return unused reserved components</li>' +
        '<li>Preserve all recorded units and audit history</li><li>Leave produced units to continue through QC</li></ul>') +
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

  var STEPS = {
    problem: problem, count: count, units: function (v, jo) { units(v, jo); }, interrupted: interrupted, output: output, scrap: scrap,
    manage: manage, pause: function (v, jo) { reasonAction(v, jo, 'pause'); }, resume: function (v, jo) { reasonAction(v, jo, 'resume'); },
    close: closeEarly, history: historyView,
  };

  MApp.route('job-orders', function (view, params) {
    var id = params && Number(params.id);
    if (id && params.step && STEPS[params.step]) { loadInto(view, id, function (jo) { STEPS[params.step](view, jo); }); return; }
    if (id) { open1(view, id); return; }
    // Production Manager lands on exceptions; everyone else (and "View all") on the board.
    if (isManager() && !(params && params.view === 'all')) control(view);
    else board(view, params && params.tab);
  });
})();
