/* QC and QA inspection — one engine, two desks. Figma pages:
     QC (teal)  69:16 queue · 69:68 identify · 69:104 verify · 69:145/69:197 checklist steps ·
                69:247 review · 69:286 pass · 69:323 repair · 69:364 evidence · 69:397 fail ·
                69:436 recorded · 69:478 reinspection
     QA (amber) 72:16 · 72:68 · 72:104 · 72:145/72:197 · 72:246 · 72:285 · 72:322 rectification ·
                72:363 evidence · 72:396 hold / reject · 72:435 recorded · 72:477 recheck
   Backend: GET /qc/queue?role= (units on the caller's own pass, same stage rules as the
   server), POST /job-orders/:id/units/inspect (checklist items carry Pass / Issue / N/A +
   readings; a repair carries category / station / priority), evidence photos as qc_unit
   attachments. A pass may queue offline (shown as queued, never as recorded); repair,
   rectification and fail need their evidence photo uploaded, so they need a connection.
   QA's "Hold for review" puts the unit on hold (status 'hold'); any QA inspector or a
   production.qa_review holder decides it on the Hold tab (?step=hold&unit=): pass, rectify or
   fail, with a reason (POST /job-orders/:id/units/:unitId/hold-decision). Evidence photos upload
   first (qc_unit) and go with a failing / held result as evidence_ids — the server refuses one
   from the phone without them. Formerly a hold was a repair routed to the QA manager — the unit stayed
   out of RTS and comes back on the Recheck list for the decision.
   Kept from the previous screen: parts requests on repair units, checklist assignment /
   editing (qc.configure), several-units bulk pass, the unit record.
   URLs: #/qc[?role=qa][&tab=re|done][&jo=] · &step=identify · &unit=<id>[&step=check&g=<n>|
   review|pass|repair|evidence|fail|done|parts|checklist] · &step=bulk[&jo=] */
(function () {
  var R = window.RoleUI;
  var DRAFT = 'vds_insp_draft_';
  var sess = {};     // per unit: { answers:{label:{status,value,note}}, remarks, photos, repair, reason, disposition, bulk, result }
  var cache = {};    // per role: last queue response
  var jos = {};      // job order detail by id (checklists)

  var can = function (p) { return MApp.can(p); };
  var offline = function () { return navigator.onLine === false; };

  var DESKS = {
    qc: {
      role: 'qc', nodes: { queue: '69:16', identify: '69:68', verify: '69:104', check: ['69:145', '69:197'], review: '69:247', pass: '69:286',
        repair: '69:323', evidence: '69:364', fail: '69:397', done: '69:436', recheck: '69:478' },
      queueTitle: 'Technical inspection', queueSub: 'Units waiting for technical inspection', heroLabel: 'Ready for QC', checkTitle: 'Technical checklist',
      reLabel: 'Reinspect', reMeta: 'Reinspection after repair', identifyTitle: 'Identify unit', identifyNote: 'The unit must be in the QC queue.',
      identifyInfo: ['Why identification matters', 'The serial links this inspection to production, job order, inspector and later QA result.'],
      verifyTitle: 'Verify before inspection', verifySub: 'Confirm identity and production traceability', verifyPill: 'Ready for QC',
      scopeTitle: 'Pre-check', scope: 'Match the physical serial label and confirm there is no obvious transport damage.',
      start: 'Start technical inspection', reviewTitle: 'Review result', reviewSub: 'Choose the unit’s technical disposition',
      remarksLabel: 'Final technical remarks', repairOpt: ['↻', 'Return for repair', 'Repairable defect; returns to QC afterward'],
      failOpt: ['!', 'Fail / reject unit', 'Nonconforming or unsafe for repair path'], passTitle: 'Pass technical QC',
      repairTitle: 'Repair required', repairSub: 'Describe the repair clearly for Production', categoryLabel: 'Defect category',
      instructionLabel: 'Repair instruction', stationLabel: 'Responsible station', photoLabel: 'Add close-up defect photo *',
      photoNote: 'Required before repair handoff', evidenceTitle: 'Add defect evidence', evidenceSub: 'A close-up photo is required for this result',
      evidenceFrame: ['Center the defect and keep it in focus', 'Include the affected part and nearby reference area.'],
      evidenceRules: 'At least one close-up photo. Add more angles when the location or extent is unclear.',
      failTitle: 'Fail / reject unit', failSub: 'Use only for unsafe or nonconforming output', failAlert: 'Unit will not advance',
      failConfirm: 'Confirm failed unit', doneTitle: 'Inspection recorded', recheckTitle: 'Reinspection required',
      recheckSub: 'Verify the repair and repeat affected tests', recheckPill: 'Repaired', recheckScope: 'Reinspection scope',
      recheckScopeText: 'Repeat the failed item and every safety-dependent test. Previous results remain visible.', recheckStart: 'Start reinspection',
      categories: ['Mechanical · fasteners', 'Mechanical · alignment', 'Electrical · power', 'Electrical · signal system', 'Brakes', 'Other'],
      stations: ['Assembly', 'Wiring', 'Mechanical', 'Paint', 'Other'], priorities: ['Normal', 'High', 'Urgent'],
    },
    qa: {
      role: 'qa', nodes: { queue: '72:16', identify: '72:68', verify: '72:104', check: ['72:145', '72:197'], review: '72:246', pass: '72:285',
        repair: '72:322', evidence: '72:363', fail: '72:396', done: '72:435', recheck: '72:477' },
      queueTitle: 'Final quality inspection', queueSub: 'Units waiting for QA; QC may still be pending', heroLabel: 'Ready for QA', checkTitle: 'Final-quality checklist',
      reLabel: 'Recheck', reMeta: 'Final-quality recheck', identifyTitle: 'Identify QA unit', identifyNote: 'Match the unit and job order. QC and QA may inspect in either order.',
      identifyInfo: ['Independent checks', 'QA can inspect before QC. Both checks must pass before Products In.'],
      verifyTitle: 'Verify final-quality candidate', verifySub: 'Confirm unit identity; QC may still be pending', verifyPill: 'Ready for QA',
      scopeTitle: 'QA scope', scope: 'Inspect appearance, finish, completeness, labels, accessories and final release readiness.',
      start: 'Start final inspection', reviewTitle: 'Review final quality', reviewSub: 'Choose the unit’s final-quality disposition',
      remarksLabel: 'Final QA remarks', repairOpt: ['↻', 'Return for rectification', 'Correctable finish, accessory or record issue'],
      failOpt: ['!', 'Hold / reject', 'Unsafe, major nonconformity or review needed'], passTitle: 'Pass final QA',
      repairTitle: 'Rectification required', repairSub: 'Describe what must be corrected before recheck', categoryLabel: 'Issue category',
      instructionLabel: 'Required correction', stationLabel: 'Route to', photoLabel: 'Add issue photo *',
      photoNote: 'Required for visible appearance, finish, accessory or labeling defects.', evidenceTitle: 'Add final-quality evidence',
      evidenceSub: 'Photograph the issue clearly and in context',
      evidenceFrame: ['Capture the defect and surrounding area', 'For missing documents, photograph the incomplete packet.'],
      evidenceRules: 'At least one clear photo for visible or physical issues. Written detail remains required.',
      failTitle: 'Hold / reject unit', failSub: 'Use for major nonconformity or supervisor review', failAlert: 'Unit will not enter RTS',
      failConfirm: 'Confirm hold', doneTitle: 'QA result recorded', recheckTitle: 'Final-quality recheck',
      recheckSub: 'Verify the correction without losing history', recheckPill: 'Rectified', recheckScope: 'Recheck scope',
      recheckScopeText: 'Verify the correction and any affected package items. The first QA result stays visible.', recheckStart: 'Start final recheck',
      categories: ['Paint / surface finish', 'Body panels / alignment', 'Trim / coverings', 'Documents / included items', 'Labels / serials', 'Other'],
      stations: ['RTS preparation', 'Paint', 'Assembly', 'Packaging', 'Other'], priorities: ['Before release', 'Normal', 'High'],
    },
  };

  function deskFor(params) {
    if (params && (params.role === 'qa' || params.role === 'qc')) return DESKS[params.role];
    return (can('production.inspect_qa') || can('production.qa_review')) && !can('production.inspect_qc') ? DESKS.qa : DESKS.qc;
  }
  function go(desk, extra) { var before = location.hash; MApp.go('qc', Object.assign({ role: desk.role }, extra || {})); if (location.hash === before) MApp.render(); }
  function page(view, desk, node, title, sub) { return R.page(view, { role: desk.role, node: node, title: title, subtitle: sub }); }

  function ago(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : ''));
    var m = Math.max(0, Math.round((Date.now() - d) / 60000));
    return m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
  }
  function clock(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : ''));
    return (d.toDateString() === new Date().toDateString() ? 'Today, ' : d.toLocaleDateString() + ', ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  var label = function (u) { return u.identifier || ('Unit #' + u.id); };
  var inspectionStage = function (desk, u) { return Math.max(1, Number(u.qc_stages) || 1) <= 1 ? 1 : desk.role === 'qa' ? 2 : 1; };
  var destination = function (desk, u) {
    if (Number(u.qc_stages) <= 1 || (desk.role === 'qa' ? u.qc_result : u.qa_result) === 'pass') return 'RTS recording';
    return desk.role === 'qa' ? 'QC' : 'QA';
  };

  function loadQueue(desk, force) {
    if (cache[desk.role] && !force) return Promise.resolve(cache[desk.role]);
    return API.get('/qc/queue?role=' + desk.role).then(function (q) { cache[desk.role] = q; return q; });
  }
  function loadJo(id, force) {
    if (jos[id] && !force) return Promise.resolve(jos[id]);
    return API.get('/job-orders/' + id).then(function (jo) { jos[id] = jo; return jo; });
  }
  /** The unit (from the caller's own queue) + its job order. Rejects if it's not on this desk. */
  function loadUnit(desk, unitId) {
    return loadQueue(desk, true).then(function (q) {
      var u = q.units.filter(function (x) { return x.id === unitId; })[0];
      if (!u) { var e = new Error('This unit isn’t waiting in your ' + desk.role.toUpperCase() + ' queue — it may be at another stage or already recorded.'); e.notInQueue = true; throw e; }
      return loadJo(u.job_order_id, true).then(function (jo) { return { u: u, jo: jo, q: q }; });
    });
  }
  /** Checklist items that apply to this unit's pass, grouped into steps (in order). */
  function stepsFor(desk, u, jo) {
    var items = [];
    var first = inspectionStage(desk, u) === 1, fin = inspectionStage(desk, u) === 2 || Number(u.qc_stages) <= 1;
    if (first && jo.qc_checklist_qc) jo.qc_checklist_qc.items.forEach(function (it) { items.push(Object.assign({ _list: jo.qc_checklist_qc.name }, it)); });
    if (fin && jo.qc_checklist_qa) jo.qc_checklist_qa.items.forEach(function (it) { items.push(Object.assign({ _list: jo.qc_checklist_qa.name }, it)); });
    var steps = [];
    items.forEach(function (it) {
      var name = it.group || it._list || 'Checklist';
      var s = steps.filter(function (x) { return x.name === name; })[0];
      if (!s) { s = { name: name, items: [] }; steps.push(s); }
      s.items.push(it);
    });
    return steps;
  }
  function session(unitId) {
    if (!sess[unitId]) {
      var draft = null;
      try { draft = JSON.parse(localStorage.getItem(DRAFT + unitId) || 'null'); } catch (ignore) {}
      sess[unitId] = { answers: (draft && draft.answers) || {}, remarks: (draft && draft.remarks) || '', photos: 0, evidence: [], repair: {}, reason: '', disposition: '' };
    }
    return sess[unitId];
  }
  function saveDraft(unitId) {
    var s = session(unitId);
    try { localStorage.setItem(DRAFT + unitId, JSON.stringify({ answers: s.answers, remarks: s.remarks })); mToast('Draft saved on this device'); }
    catch (ignore) { mToast('Could not save the draft on this device', 'err'); }
  }
  function clearDraft(unitId) { try { localStorage.removeItem(DRAFT + unitId); } catch (ignore) {} }
  function tally(steps, s) {
    var all = [].concat.apply([], steps.map(function (x) { return x.items; }));
    var c = { total: all.length, pass: 0, issue: 0, na: 0, open: 0, reqMissing: [] };
    all.forEach(function (it) {
      var a = s.answers[it.label];
      if (!a || !a.status) { c.open++; if (it.required) c.reqMissing.push(it.label); return; }
      c[a.status]++;
      if (it.required && a.status !== 'pass') c.reqMissing.push(it.label);
    });
    return c;
  }
  function checklistPayload(steps, s) {
    return [].concat.apply([], steps.map(function (x) { return x.items; })).map(function (it) {
      var a = s.answers[it.label] || {};
      return { label: it.label, ok: a.status === 'pass' || a.status === 'na', status: a.status || undefined, value: a.value || null, note: a.note || null };
    });
  }
  function fail(el, text) { return function (err) { mToast((err && err.message) || 'Failed', 'err'); if (el) { el.disabled = false; if (text) el.textContent = text; } }; }
  function withUnit(view, desk, unitId, fn) {
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    loadUnit(desk, unitId).then(function (d) { fn(d.u, d.jo, d.q); }).catch(function (err) {
      view.innerHTML = '';
      if (err.notInQueue) { var body = page(view, desk, desk.nodes.identify, desk.identifyTitle, ''); body.innerHTML = R.note('warn', mEsc(err.message)) + R.actions([{ id: 'qc-back', label: 'Back to queue', kind: 'secondary' }]); body.querySelector('#qc-back').onclick = function () { go(desk); }; return; }
      view.appendChild(R.error(err, function () { withUnit(view, desk, unitId, fn); }));
    });
  }

  function holdId(id) { return 'hold:' + id; }
  function loadHolds() {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('Hold list timed out. Retry the current check.')); }, 20000);
      API.get('/qc/holds').then(function (rows) { clearTimeout(timer); resolve(rows); }, function (err) { clearTimeout(timer); reject(err); });
    });
  }
  function holdVisible(view, record) {
    try { return view.isConnected && record.key === mProductionDrafts.key(holdId(record.operation.context.id) + ':action') &&
      location.hash.split('?')[0] === '#/qc' && Number(new URLSearchParams(location.hash.split('?')[1] || '').get('unit')) === record.operation.context.id &&
      new URLSearchParams(location.hash.split('?')[1] || '').get('step') === 'hold'; }
    catch (ignore) { return false; }
  }
  function sendHold(record) {
    var op = record.operation, sent = false, previous = op.state;
    if (record.key !== mProductionDrafts.key(holdId(op.context.id) + ':action')) return Promise.reject(new Error('Recover this decision using its original account.'));
    if (op.state === 'conflict' || Date.now() - op.created >= 7 * 86400000) {
      op.state = 'conflict'; op.error = 'Ask a supervisor to reconcile this attempt. Its expired or conflicting key must not be replaced to bypass recovery.';
      return mProductionDrafts.save(record);
    }
    op.state = 'sending'; op.error = null;
    return mProductionDrafts.save(record).then(function () {
      if (record.key !== mProductionDrafts.key(holdId(op.context.id) + ':action')) throw new Error('The signed-in account changed.');
      sent = true; return API.post(op.path, op.payload, { idempotencyKey: op.key });
    }).then(function (result) {
      op.state = 'confirmed'; op.local = API.syncLocal(result); op.result = result;
      return mProductionDrafts.save(record);
    }).catch(function (err) {
      op.state = !sent ? previous : (!err.status || err.status >= 500 || err.status === 429 ? 'unknown' :
        err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected');
      op.error = err.message;
      return mProductionDrafts.save(record).catch(function () { throw err; });
    });
  }
  function holdRecovery(view, desk, record) {
    if (!holdVisible(view, record)) return;
    var op = record.operation, h = op.context;
    var final = op.state === 'confirmed' && !op.local;
    var body = page(view, desk, final ? desk.nodes.done : desk.nodes.fail, final ? desk.doneTitle : 'Review held-unit decision', final ? 'Confirmed by site authority' : op.local ? 'Saved on site PC — confirmation pending' : 'Review the original attempt');
    body.innerHTML = (final ? R.result(op.payload.outcome === 'pass' ? 'Passed to Products In' : op.payload.outcome === 'rectify' ? 'Sent for rectification' : 'Unit failed', label(h), op.payload.outcome === 'pass' ? '' : op.payload.outcome === 'rectify' ? 'warn' : 'bad', op.payload.outcome === 'pass' ? '✓' : op.payload.outcome === 'rectify' ? '↻' : '!') : R.jobHead({ number: label(h), name: h.product_name, meta: h.job_order_number })) +
      R.field('Original decision', op.payload.outcome) + R.field('Original reason', op.payload.remarks) +
      (op.payload.disposition ? R.field('Disposition', op.payload.disposition) : '') +
      (op.payload.repair ? R.field('Rectification station', op.payload.repair.station || '—') : '') +
      R.note(final ? 'info' : 'warn', final ? op.payload.outcome === 'pass' ? 'Passed for Products In. Stock is added only when receiving confirms the unit.' :
        op.payload.outcome === 'rectify' ? 'Sent for correction and recheck.' : 'Failed; this unit cannot enter RTS.' :
        op.local ? 'The original decision is saved on the site PC and awaits confirmation. Do not record another decision.' :
        op.state === 'rejected' ? 'The request was refused. Reload and review the current hold before making a corrected decision.' :
        op.state === 'conflict' ? 'This attempt needs supervisor reconciliation; the original decision is retained.' :
        'A missing response does not prove failure. Retry sends the original decision, reason and key unchanged.') +
      (op.error ? R.note('warn', mEsc(op.error)) : '') +
      R.actions((!op.local && ['new', 'unknown'].indexOf(op.state) !== -1 ? [{ id: 'qc-hold-retry', label: 'Retry original', kind: 'primary' }] : [])
        .concat([{ id: 'qc-hold-back', label: op.state === 'rejected' ? 'Review current hold' : 'Back to hold queue', kind: 'secondary' }])) + '<div data-hold-sync></div>';
    var retry = body.querySelector('#qc-hold-retry');
    if (retry) retry.onclick = function () {
      if (offline()) { mToast('Reconnect before checking this decision.', 'err'); return; }
      retry.disabled = true;
      sendHold(record).then(function () { holdRecovery(view, desk, record); }).catch(function (err) { if (holdVisible(view, record)) { mToast(err.message, 'err'); holdRecovery(view, desk, record); } });
    };
    body.querySelector('#qc-hold-back').onclick = function () {
      if (final || op.state === 'rejected') {
        mProductionDrafts.remove(record).then(function () {
          if (!holdVisible(view, record)) return;
          delete cache[desk.role];
          if (op.state === 'rejected') holdDecision(view, desk, h.id); else go(desk, { tab: 'hold' });
        }).catch(function (err) { mToast(err.message, 'err'); });
      } else go(desk, { tab: 'hold' });
    };
    if (op.local) body.querySelector('[data-hold-sync]').appendChild(R.syncWatch(op.local, function (r) {
      if (!holdVisible(view, record)) return;
      if (r.state === 'confirmed') { op.local = null; op.state = 'confirmed'; mProductionDrafts.save(record).then(function () { holdRecovery(view, desk, record); }).catch(function (err) { mToast(err.message, 'err'); }); }
    }));
  }

  /* ── Queue (69:16 / 72:16) ──────────────────────────────────────────────── */
  function queue(view, desk, tab, joFilter) {
    var body = page(view, desk, desk.nodes.queue, desk.queueTitle, desk.queueSub);
    body.innerHTML = R.skeleton(3);
    var owner = mProductionDrafts.key('qa-hold-queue');
    var decide = desk.role === 'qa' && canDecideHolds();
    // Someone who only decides holds (production.qa_review) has no inspection queue of their own.
    var inspects = desk.role !== 'qa' || can('production.inspect_qa');
    Promise.all([inspects ? loadQueue(desk, true) : Promise.resolve({ units: [], completed: [] }),
      decide ? Promise.all([loadHolds().then(function (rows) { return { rows: rows }; }).catch(function (err) { return { rows: [], error: err }; }),
        mProductionDrafts.listActions('hold-decision', 'hold').then(function (saved) { return { saved: saved }; }).catch(function (err) { return { saved: [], error: err }; })]) : Promise.resolve([{ rows: [] }, { saved: [] }])]).then(function (both) {
      if (!body.isConnected || !MApp.getMe() || owner !== mProductionDrafts.key('qa-hold-queue')) return;
      var q = both[0], holds = both[1][0].rows.filter(function (h) { return !joFilter || h.job_order_id === Number(joFilter); });
      var saved = both[1][1].saved.filter(function (a) { return !joFilter || a.record.operation.context.job_order_id === Number(joFilter); });
      var holdError = both[1][0].error || both[1][1].error;
      var holdCount = holdError ? '?' : new Set(holds.map(function (h) { return h.id; }).concat(saved.map(function (a) { return a.id; }))).size;
      var units = q.units.filter(function (u) { return !joFilter || u.job_order_id === Number(joFilter); });
      var ready = units.filter(function (u) { return u.status === 'pending'; });
      var re = units.filter(function (u) { return u.status === 'rework'; });
      var prio = ready.filter(function (u) { return u.priority > 0; }).length;
      tab = tab || 'ready';
      body.innerHTML =
        R.hero(inspects ? desk.heroLabel : 'QA hold review', inspects ? ready.length + ' unit' + (ready.length === 1 ? '' : 's') : holdError ? 'Count unknown' : holdCount + ' item(s) to review',
          inspects ? prio + ' priority · ' + re.length + ' ' + (desk.role === 'qa' ? 'recheck' : 'reinspection') : 'Review decisions before Products In') +
        (holdError ? R.note('warn', 'Unable to load holds. The hold count is unknown; open On hold to retry.') : '') +
        '<div class="rk-segs" role="tablist">' +
          '<button type="button" data-tab="ready"' + (tab === 'ready' ? ' class="on"' : '') + '>Ready<b>' + ready.length + '</b></button>' +
          '<button type="button" data-tab="re" class="re' + (tab === 're' ? ' on' : '') + '">' + desk.reLabel + '<b>' + re.length + '</b></button>' +
          (decide ? '<button type="button" data-tab="hold" class="warn' + (tab === 'hold' ? ' on' : '') + '">On hold<b>' + holdCount + '</b></button>' : '') +
          '<button type="button" data-tab="done"' + (tab === 'done' ? ' class="on"' : '') + '>Completed</button></div>' +
        '<div class="rk-list" data-list></div>' +
        (joFilter ? R.note('info', 'Showing one job order only. <button type="button" class="rk-back" data-all style="padding:0">Show all</button>') : '') +
        (inspects ? R.actions([{ id: 'qc-scan', label: 'Find unit by identifier or job order', kind: 'secondary' }].concat(joFilter && ready.length > 1 ? [{ id: 'qc-bulk', label: 'Pass several', kind: 'secondary' }] : [])) : '');
      function paint(which) {
        var host = body.querySelector('[data-list]');
        if (which === 'hold') {
          var savedIds = saved.map(function (a) { return a.id; });
          var current = holds.filter(function (h) { return savedIds.indexOf(h.id) === -1; });
          host.innerHTML = (holdError ? R.note('warn', 'Unable to load holds: ' + mEsc(holdError.message) + '. Count unknown.') + R.actions([{ id: 'qc-holds-refresh', label: 'Retry hold check', kind: 'secondary' }]) : '') +
            saved.map(function (a) { var h = a.record.operation.context; return '<button type="button" class="rk-card rk-unitcard" data-hold="' + a.id + '"><b>' + mEsc(label(h)) + '</b><span>' + mEsc(h.product_name + ' · ' + h.job_order_number) + '</span><small class="warn">Review saved decision' + (a.record.operation.local ? ' · confirmation pending' : '') + '</small><i aria-hidden="true">›</i></button>'; }).join('') +
            current.map(function (h) {
              return '<button type="button" class="rk-card rk-unitcard" data-hold="' + h.id + '"><b>' + mEsc(label(h)) + '</b>' +
                '<span>' + mEsc(h.product_name + ' · ' + h.job_order_number) + '</span><small class="warn">' + mEsc('Held by ' + (h.held_by_name || '—') + ' · ' + ago(h.held_at) + ' ago') + '</small><i aria-hidden="true">›</i></button>';
            }).join('') + (!holdError && !saved.length && !current.length ? '<div class="rk-empty">No units on hold.</div>' : '');
          var refresh = host.querySelector('#qc-holds-refresh'); if (refresh) refresh.onclick = function () { queue(view, desk, 'hold', joFilter); };
          Array.prototype.forEach.call(host.querySelectorAll('[data-hold]'), function (b) { b.onclick = function () { go(desk, { unit: b.dataset.hold, step: 'hold' }); }; });
          return;
        }
        if (which === 'done') {
          var completed=q.completed.filter(function(r){return !joFilter||r.job_order_id===Number(joFilter);});
          host.innerHTML = completed.length ? completed.map(function (r) {
            return '<div class="rk-card rk-unitcard" style="cursor:default"><b>' + mEsc(r.identifier || 'Unit #' + r.unit_id) + '</b>' +
              '<span>' + mEsc(r.product_name + ' · ' + r.job_order_number) + '</span><small>' + (r.result === 'pass' ? 'Passed' : r.result === 'hold' ? 'Held for review' : 'Failed · ' + mEsc(r.disposition || '')) +
              ' · ' + mEsc(clock(r.created_at)) + '</small><i></i></div>';
          }).join('') : '<div class="rk-empty">Nothing recorded by you today.</div>';
          return;
        }
        var list = which === 're' ? re : ready;
        if (!joFilter) {
          var groups={};list.forEach(function(u){var g=groups[u.job_order_id]||(groups[u.job_order_id]={u:u,count:0});g.count++;});
          host.innerHTML=Object.keys(groups).map(function(id){var g=groups[id],u=g.u;return '<button type="button" class="rk-card rk-unitcard" data-jo="'+id+'"><b>'+mEsc(u.job_order_number)+'</b><span>'+mEsc(u.product_name)+'</span><small>'+g.count+' eligible unit(s)'+(u.intake_origin==='legacy'?' · Pre-system legacy intake':'')+'</small><i aria-hidden="true">›</i></button>';}).join('') || '<div class="rk-empty">No ongoing job orders for this inspection stage.</div>';
          host.querySelectorAll('[data-jo]').forEach(function(b){b.onclick=function(){go(desk,{jo:b.dataset.jo,tab:which});};});return;
        }

        host.innerHTML = list.length ? list.map(function (u) {
          var meta = which === 're' ? desk.reMeta + (u.open_part_requests ? ' · waiting on parts' : '')
            : (u.priority > 0 ? 'Priority · waiting ' : 'Waiting ') + ago(u.updated_at);
          var checks = Number(u.qc_stages) > 1 ? ' · QC: ' + (u.qc_result || 'pending') + ' · QA: ' + (u.qa_result || 'pending') : '';
          var line = u.product_name + ' · ' + u.job_order_number + checks;
          return '<button type="button" class="rk-card rk-unitcard" data-unit="' + u.id + '"><b>' + mEsc(label(u)) + '</b><span>' + mEsc(line) + '</span>' +
            '<small' + (which === 're' ? ' class="re"' : '') + '>' + mEsc(meta) + '</small><i aria-hidden="true">›</i></button>';
        }).join('') : '<div class="rk-empty">' + (which === 're' ? 'No units are back for ' + (desk.role === 'qa' ? 'recheck' : 'reinspection') + '.' : 'Nothing waiting for inspection.') + '</div>';
        Array.prototype.forEach.call(host.querySelectorAll('[data-unit]'), function (b) { b.onclick = function () { go(desk, { unit: b.dataset.unit }); }; });
      }
      Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (b) {
        b.onclick = function () { Array.prototype.forEach.call(body.querySelectorAll('.rk-segs button'), function (x) { x.classList.toggle('on', x === b); }); paint(b.dataset.tab); };
      });
      paint(tab);
      var scanButton = body.querySelector('#qc-scan'); if (scanButton) scanButton.onclick = function () { go(desk, { step: 'identify' }); };
      var bulk = body.querySelector('#qc-bulk'); if (bulk) bulk.onclick = function () { go(desk, { step: 'bulk', jo: joFilter || undefined }); };
      var all = body.querySelector('[data-all]'); if (all) all.onclick = function () { go(desk); };
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { queue(view, desk, tab, joFilter); })); });
  }

  /* ── Identify (69:68 / 72:68) ───────────────────────────────────────────── */
  function identify(view, desk) {
    var body = page(view, desk, desk.nodes.identify, desk.identifyTitle, 'Select a unit using its production identifier and job order');
    body.innerHTML =
      R.note('info', 'Select the Ready or Recheck card, or search below. QR stickers are normally attached later at Products In.') +
      '<label class="rk-card rk-field"><small>Production identifier or job order</small><input class="rk-input" data-q placeholder="Enter identifier or job order" autocomplete="off"></label>' +
      R.actions([{ id: 'qc-find', label: 'Find units', kind: 'primary' }, { id: 'qc-cancel', label: 'Back to queue', kind: 'secondary' }]) +
      '<div data-matches></div>' +
      R.actions([{ id: 'qc-optional-scan', label: 'Scan QR if already attached (optional)', kind: 'secondary' }]) +
      R.note('warn', 'If you cannot distinguish the physical unit, stop and resolve identification with Production before inspecting.') +
      R.note('info', '<h3>' + mEsc(desk.identifyInfo[0]) + '</h3>' + mEsc(desk.identifyInfo[1]));
    var request = 0;
    function find(code) {
      var t = String(code || '').trim().toLowerCase(), current = ++request;
      if (!t) { mToast('Enter a production identifier or job order', 'err'); return; }
      loadQueue(desk, true).then(function (q) {
        if (!body.isConnected || current !== request) return;
        var matches = q.units.filter(function (u) {
          return ('vds:unit:' + u.id) === t || String(u.id) === t.replace(/^#/, '') ||
            String(u.identifier || '').toLowerCase().indexOf(t) !== -1 || String(u.job_order_number || '').toLowerCase().indexOf(t) !== -1;
        });
        var host = body.querySelector('[data-matches]');
        host.innerHTML = matches.length ? matches.map(function (u) {
          return '<button type="button" class="rk-card rk-unitcard" data-match="' + u.id + '"><b>' + mEsc(label(u)) + '</b><span>' + mEsc(u.product_name + ' · ' + u.job_order_number) + '</span><i aria-hidden="true">›</i></button>';
        }).join('') : R.note('warn', 'No unit in your ' + desk.role.toUpperCase() + ' queue matches this search.');
        Array.prototype.forEach.call(host.querySelectorAll('[data-match]'), function (button) { button.onclick = function () { go(desk, { unit: button.dataset.match }); }; });
      }).catch(fail());
    }
    body.querySelector('#qc-optional-scan').onclick = function () {
      if (!window.mScanner) { mToast('Scanner unavailable on this device', 'err'); return; }
      mScanner.open({ title: 'Optional QR shortcut — sticker already attached', onResult: find });
    };
    body.querySelector('#qc-find').onclick = function () { find(body.querySelector('[data-q]').value); };
    body.querySelector('#qc-cancel').onclick = function () { go(desk); };
  }

  function identityKey(desk, u) { return [desk.role, u.id, u.identifier, u.job_order_id, u.stage].join(':'); }
  function identityFields(u) {
    return R.field('Production identifier', u.identifier || 'Missing — resolve with Production') +
      R.field(u.intake_origin==='legacy'?'Legacy intake':'Job order', u.job_order_number) +
      (u.intake_origin==='legacy'?R.note('info','Pre-system unit — both QC and QA are required before Products In.'): '') +
      R.check('qc-identity', 'I matched this identifier and '+(u.intake_origin==='legacy'?'legacy intake':'job order')+' to the physical unit') +
      R.note('warn', 'No QR sticker is required here. If the unit cannot be distinguished reliably, stop and resolve identification with Production.');
  }
  function bindIdentity(body, desk, u, blocked) {
    var start = body.querySelector('#qc-start'), confirm = body.querySelector('#qc-identity');
    var allowed = !blocked && !!String(u.identifier || '').trim();
    start.disabled = true;
    confirm.onchange = function () { start.disabled = !allowed || !confirm.checked; };
    start.onclick = function () {
      if (!allowed || !confirm.checked) return;
      var s = session(u.id); s.identity = identityKey(desk, u); s.bulk = null; s.bulkIds = null;
      go(desk, { unit: u.id, step: 'check', g: 0 });
    };
  }

  function issueAccess(body, desk, u) {
    var b = mEl(R.actions([{ id: 'qc-issues', label: 'Issues and photos', kind: 'secondary' }]));
    b.querySelector('#qc-issues').onclick = function () { MApp.go('unit-issues', { unit: u.id, role: desk.role }); };
    body.appendChild(b);
  }

  /* ── Verify (69:104 / 72:104) or recheck (69:478 / 72:477) ──────────────── */
  function verify(view, desk, u, jo) {
    if (u.status === 'rework') { recheck(view, desk, u, jo); return; }
    var body = page(view, desk, desk.nodes.verify, desk.verifyTitle, desk.verifySub);
    var cl = inspectionStage(desk, u) === 1 ? jo.qc_checklist_qc : jo.qc_checklist_qa;
    body.innerHTML =
      '<div class="rk-jobhead"><span class="rk-no" style="font-size:14px">' + mEsc(label(u)) + '</span><span class="rk-pill" style="background:#fff;color:' +
        (desk.role === 'qa' ? '#14803d' : 'var(--rk-chip-text)') + '">' + mEsc(desk.verifyPill) + '</span>' +
        '<span class="rk-name">' + mEsc(u.product_name) + '</span><span class="rk-meta">' + mEsc([u.job_order_number, u.team_name].filter(Boolean).join(' · ')) + '</span></div>' +
      (desk.role === 'qa' && u.last_pass
        ? R.field('QC record', (u.last_pass.inspector_name || '—') + ' · Passed ' + clock(u.last_pass.created_at).replace('Today, ', 'today, ')) +
          R.field('Technical result', u.last_pass.items + ' items passed · no open defects')
        : R.field(u.intake_origin==='legacy'?'Legacy intake recorded':'Production recorded', clock(u.created_at)) + R.field('Batch / lot', u.batch_identifier || u.batch_number || '—')) +
      identityFields(u) +
      R.note('info', '<h3>' + mEsc(desk.scopeTitle) + '</h3>' + mEsc(desk.scope)) +
      (can('qc.configure') ? '<div class="rk-card rk-field"><small>Checklist</small><b style="display:flex;justify-content:space-between;align-items:center">' +
        mEsc(cl ? cl.name : 'Default (none set)') + '<button type="button" class="rk-back" data-change style="padding:0">Change</button></b></div>' : '') +
      R.actions([{ id: 'qc-start', label: desk.start, kind: 'primary' }, { id: 'qc-wrong', label: 'Wrong unit', kind: 'secondary' }]);
    issueAccess(body, desk, u);
    bindIdentity(body, desk, u, false);
    body.querySelector('#qc-wrong').onclick = function () { go(desk, { step: 'identify' }); };
    var ch = body.querySelector('[data-change]'); if (ch) ch.onclick = function () { go(desk, { unit: u.id, step: 'checklist' }); };
  }

  function recheck(view, desk, u, jo) {
    var body = page(view, desk, desk.nodes.recheck, desk.recheckTitle, desk.recheckSub);
    var lf = u.last_fail || {};
    var failed = (lf.checklist || []).filter(function (c) { return c.status ? c.status === 'issue' : c.ok === false; });
    var blocked = u.open_part_requests > 0;
    body.innerHTML =
      '<div class="rk-rehead"><b>' + mEsc(label(u)) + '</b><span class="rk-pill">' + mEsc(desk.recheckPill) + '</span>' +
        '<span>' + mEsc((lf.repair_station ? 'Sent to ' + lf.repair_station : 'Returned for repair') + (lf.created_at ? ' · ' + ago(lf.created_at) + ' ago' : '')) + '</span>' +
        '<small>Original issue: ' + mEsc(lf.remarks || '—') + '</small></div>' +
      identityFields(u) +
      R.note('info', '<h3>' + mEsc(desk.recheckScope) + '</h3>' + mEsc(desk.recheckScopeText)) +
      (failed.length ? '<div class="rk-checks">' + failed.map(function (c) {
        return '<div class="rk-check-row"><button type="button" disabled><span class="rk-state" aria-hidden="true">○</span><b>' + mEsc(c.label) + '</b>' +
          '<small>' + mEsc(c.note ? 'Last: ' + c.note : c.value ? 'Last reading: ' + c.value : 'Repeat this check') + '</small></button></div>';
      }).join('') + '</div>' : '') +
      (blocked ? R.note('warn', '<b>Waiting on the warehouse for ' + u.open_part_requests + ' part request' + (u.open_part_requests === 1 ? '' : 's') + '</b><br>Reinspection can start once the parts are issued.') : '') +
      R.actions([{ id: 'qc-start', label: desk.recheckStart, kind: 'primary' }, { id: 'qc-hist', label: 'View history', kind: 'secondary' }]) +
      R.actions([{ id: 'qc-parts', label: 'Request a part', kind: 'secondary' }]);
    issueAccess(body, desk, u);
    bindIdentity(body, desk, u, blocked);
    body.querySelector('#qc-hist').onclick = function () { MApp.go('record', { unit: u.id }); };
    body.querySelector('#qc-parts').onclick = function () { go(desk, { unit: u.id, step: 'parts' }); };
  }

  /* ── Checklist steps (69:145 / 69:197, 72:145 / 72:197) ─────────────────── */
  function check(view, desk, u, jo, g) {
    var steps = stepsFor(desk, u, jo);
    var s = session(u.id);
    if (!steps.length) { go(desk, { unit: u.id, step: 'review' }); return; }
    g = Math.max(0, Math.min(steps.length - 1, Number(g) || 0));
    var step = steps[g];
    var q = cache[desk.role];
    var pos = q ? q.units.filter(function (x) { return x.status === u.status; }).map(function (x) { return x.id; }).indexOf(u.id) : -1;
    var total = q ? q.units.filter(function (x) { return x.status === u.status; }).length : 1;
    var body = page(view, desk, desk.nodes.check[Math.min(g, 1)], desk.checkTitle, 'Step ' + (g + 1) + ' of ' + steps.length + ' · ' + step.name.toLowerCase());
    var measures = step.items.filter(function (it) { return it.measure; });
    var checks = step.items.filter(function (it) { return !it.measure; });
    body.innerHTML =
      '<div class="rk-unitstrip"><span>' + (s.bulk ? s.bulk + ' UNITS' : 'UNIT ' + (pos + 1 || 1) + ' OF ' + Math.max(total, 1)) + '</span><b>' + mEsc(s.bulk ? u.job_order_number : label(u)) + '</b></div>' +
      '<div class="rk-checks" data-checks></div>' +
      (measures.length ? '<div class="rk-measures" data-measures></div>' : '') +
      '<div data-notice></div>' +
      R.actions([{ id: 'qc-next', label: g < steps.length - 1 ? (steps[g + 1].name.length > 16 ? 'Continue' : 'Continue to ' + steps[g + 1].name.toLowerCase()) : 'Review inspection', kind: 'primary' },
        { id: 'qc-draft', label: 'Save draft', kind: 'secondary' }]);
    var open = null;
    function paintChecks() {
      var host = body.querySelector('[data-checks]');
      host.innerHTML = checks.map(function (it, i) {
        var a = s.answers[it.label] || {};
        var st = a.status || '';
        var glyph = st === 'pass' ? '✓' : st === 'issue' ? '!' : st === 'na' ? '–' : '○';
        var sub = a.note ? a.note : it.hint ? it.hint : st === 'na' ? 'Not applicable' : it.required ? 'Required' : 'Tap to record';
        return '<div class="rk-check-row"><button type="button" data-i="' + i + '" aria-expanded="' + (open === i) + '"><span class="rk-state ' + st + '" aria-hidden="true">' + glyph + '</span>' +
          '<b>' + mEsc(it.label) + (it.required ? ' <span class="req">*</span>' : '') + '</b><small>' + mEsc(sub) + '</small></button>' +
          (open === i ? '<div class="rk-check-edit"><div class="opts">' +
            '<button type="button" class="pass' + (st === 'pass' ? ' on' : '') + '" data-set="pass">Pass</button>' +
            '<button type="button" class="issue' + (st === 'issue' ? ' on' : '') + '" data-set="issue">Issue</button>' +
            '<button type="button" class="na' + (st === 'na' ? ' on' : '') + '" data-set="na"' + (it.required ? ' disabled title="Required checks can’t be N/A"' : '') + '>N/A</button></div>' +
            '<input data-note maxlength="500" placeholder="Remarks (optional' + (st === 'issue' ? ', describe the issue' : '') + ')" value="' + mEsc(a.note || '') + '"></div>' : '') +
          '</div>';
      }).join('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-i]'), function (b) {
        b.onclick = function () { var i = Number(b.dataset.i); open = open === i ? null : i; paintChecks(); };
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-set]'), function (b) {
        b.onclick = function () {
          var it = checks[open];
          var a = s.answers[it.label] = s.answers[it.label] || {};
          a.status = b.dataset.set;
          var next = checks.findIndex(function (x, k) { return k > open && !(s.answers[x.label] && s.answers[x.label].status); });
          open = a.status === 'issue' ? open : (next === -1 ? null : next);
          paintChecks(); paintNotice();
        };
      });
      var note = host.querySelector('[data-note]');
      if (note) note.oninput = function () { var it = checks[open]; (s.answers[it.label] = s.answers[it.label] || {}).note = note.value; };
    }
    function paintMeasures() {
      var host = body.querySelector('[data-measures]');
      if (!host) return;
      host.innerHTML = measures.map(function (it, i) {
        var a = s.answers[it.label] || {};
        return '<div class="rk-card rk-field"><small>' + mEsc(it.label) + (it.required ? ' *' : '') + '</small>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:8px"><input class="rk-input" style="margin:0" data-m="' + i + '" inputmode="decimal" value="' + mEsc(a.value || '') + '" placeholder="Reading">' +
          '<span style="font-size:12px;color:var(--rk-meta)">' + mEsc(it.measure) + '</span></div>' +
          '<div class="rk-check-edit" style="padding:8px 0 0"><div class="opts">' +
            '<button type="button" class="pass' + (a.status === 'pass' ? ' on' : '') + '" data-mset="' + i + '" data-v="pass">Pass</button>' +
            '<button type="button" class="issue' + (a.status === 'issue' ? ' on' : '') + '" data-mset="' + i + '" data-v="issue">Issue</button></div></div></div>';
      }).join('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-m]'), function (inp) {
        inp.oninput = function () { var it = measures[Number(inp.dataset.m)]; (s.answers[it.label] = s.answers[it.label] || {}).value = inp.value.trim(); };
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-mset]'), function (b) {
        b.onclick = function () { var it = measures[Number(b.dataset.mset)]; (s.answers[it.label] = s.answers[it.label] || {}).status = b.dataset.v; paintMeasures(); paintNotice(); };
      });
    }
    function paintNotice() {
      var issues = step.items.filter(function (it) { return (s.answers[it.label] || {}).status === 'issue'; }).length;
      body.querySelector('[data-notice]').innerHTML = issues ? '<div class="rk-note issue"><h3>' + (desk.role === 'qa' ? 'Missing item detected' : 'Issue detected') + '</h3>' +
        (desk.role === 'qa' ? 'A rectification result requires details and a photo when the issue is physically visible.'
          : 'A defect disposition requires a close-up photo and remarks before submission.') + '</div>'
        : R.note('info', '<h3>Tap a row to record</h3>Each item stores Pass, Issue, Not applicable and optional remarks.');
    }
    paintChecks(); paintMeasures(); paintNotice();
    body.querySelector('#qc-draft').onclick = function () { saveDraft(u.id); };
    body.querySelector('#qc-next').onclick = function () {
      var missing = step.items.filter(function (it) { var a = s.answers[it.label]; return !a || !a.status; });
      if (missing.length) { mToast('Record every check first: ' + missing.map(function (m) { return m.label; }).join(', '), 'err'); return; }
      var noReading = measures.filter(function (it) { return !(s.answers[it.label] || {}).value; });
      if (noReading.length) { mToast('Enter the reading for ' + noReading[0].label, 'err'); return; }
      if (g < steps.length - 1) go(desk, { unit: u.id, step: 'check', g: g + 1 });
      else go(desk, { unit: u.id, step: 'review' });
    };
  }

  /* ── Review (69:247 / 72:246) ───────────────────────────────────────────── */
  function review(view, desk, u, jo) {
    var steps = stepsFor(desk, u, jo);
    var s = session(u.id);
    var c = tally(steps, s);
    var body = page(view, desk, desk.nodes.review, desk.reviewTitle, desk.reviewSub);
    var canPass = !c.issue && !c.reqMissing.length;
    body.innerHTML =
      '<div class="rk-card rk-summary"><small>' + (c.open ? 'Checklist in progress' : desk.role === 'qa' ? 'Final check complete' : 'Checklist complete') + '</small><b>' +
        c.pass + ' passed' + (c.issue ? ' · ' + c.issue + ' issue' + (c.issue === 1 ? '' : 's') : '') + (c.na ? ' · ' + c.na + ' N/A' : '') + (c.open ? ' · ' + c.open + ' open' : '') + '</b>' +
        (c.issue ? '<span class="rk-pill danger">' + (desk.role === 'qa' ? 'Evidence needed' : 'Photo required') + '</span>' : c.open || c.reqMissing.length ? '<span class="rk-pill warn">Incomplete</span>' : '<span class="rk-pill ok">All clear</span>') + '</div>' +
      '<label class="rk-card rk-field"><small>' + mEsc(desk.remarksLabel) + '</small><textarea rows="3" maxlength="2000" data-remarks placeholder="' +
        (c.issue ? 'Describe the issue' : 'e.g. No defects observed') + '">' + mEsc(s.remarks) + '</textarea></label>' +
      '<button type="button" class="rk-disp pass" data-d="pass"' + (canPass ? '' : ' disabled') + '><i>✓</i><b>Pass to ' + destination(desk, u) + '</b><span>' +
        (canPass ? (desk.role === 'qa' ? 'All final-quality requirements complete' : 'Available only when no open issue remains') :
          c.reqMissing.length ? 'Required checks not passed: ' + mEsc(c.reqMissing.join(', ')) : 'Resolve or route the open issue first') + '</span></button>' +
      (s.bulk ? '' :
        '<button type="button" class="rk-disp repair" data-d="repair"><i>' + desk.repairOpt[0] + '</i><b>' + desk.repairOpt[1] + '</b><span>' + desk.repairOpt[2] + '</span></button>' +
        '<button type="button" class="rk-disp fail" data-d="fail"><i>' + desk.failOpt[0] + '</i><b>' + desk.failOpt[1] + '</b><span>' + desk.failOpt[2] + '</span></button>');
    if (!s.bulk) issueAccess(body, desk, u);
    var rem = body.querySelector('[data-remarks]');
    rem.oninput = function () { s.remarks = rem.value; };
    Array.prototype.forEach.call(body.querySelectorAll('[data-d]'), function (b) {
      b.onclick = function () {
        s.remarks = rem.value.trim();
        if (b.dataset.d !== 'pass' && !s.remarks) { mToast('Describe the issue in the remarks first', 'err'); rem.focus(); return; }
        go(desk, { unit: u.id, step: b.dataset.d });
      };
    });
  }

  /* ── Pass (69:286 / 72:285) ─────────────────────────────────────────────── */
  function passView(view, desk, u, jo) {
    var s = session(u.id);
    var dest = destination(desk, u);
    var body = page(view, desk, desk.nodes.pass, desk.passTitle, 'Unit will advance to ' + (dest === 'QA' ? 'appearance QA' : dest === 'QC' ? 'functional QC' : 'RTS recording'));
    body.innerHTML =
      '<div class="rk-readyhero"><i aria-hidden="true">✓</i><b>Ready for ' + dest + '</b><strong>' + mEsc(s.bulk ? s.bulk + ' units · ' + u.job_order_number : label(u)) + '</strong>' +
        '<span>' + (desk.role === 'qa' ? 'Appearance and package complete' : 'All technical items passed') + '</span></div>' +
      '<label class="rk-card rk-field"><small>Final remarks</small><textarea rows="3" maxlength="2000" data-remarks>' + mEsc(s.remarks || (desk.role === 'qa' ? 'Unit meets final-quality requirements.' : 'No technical defects observed.')) + '</textarea></label>' +
      R.note('info', '<h3>After confirmation</h3>' + (dest === 'QA' ? 'The unit leaves QC and appears in QA for appearance and final-quality inspection.'
        : dest === 'QC' ? 'QA is recorded. The unit still needs functional QC before RTS recording.'
        : 'Both required checks are complete. The unit appears in the RTS Clerk queue for ready-to-sell recording.')) +
      R.actions([{ id: 'qc-confirm', label: 'Confirm pass to ' + dest, kind: 'primary' }, { id: 'qc-back', label: 'Back', kind: 'secondary' }]);
    body.querySelector('#qc-back').onclick = function () { history.back(); };
    var btn = body.querySelector('#qc-confirm');
    btn.onclick = function () {
      s.remarks = body.querySelector('[data-remarks]').value.trim();
      btn.disabled = true; btn.textContent = 'Recording…';
      var ids = s.bulkIds || [u.id];
      var payload = { unit_ids: ids, result: 'pass', checklist: checklistPayload(stepsFor(desk, u, jo), s), remarks: s.remarks || null };
      if (s.bulkIdentifier) payload.identifier = s.bulkIdentifier;
      record(desk, u, payload, btn, 'Confirm pass to ' + dest);
    };
  }

  function record(desk, u, payload, btn, btnText) {
    // A failing / held result carries the evidence photos uploaded for it (the server needs one per unit).
    payload.inspection_stage = inspectionStage(desk, u);
    if (payload.result === 'fail') payload.evidence_ids = session(u.id).evidence.slice();
    var actionHash=location.hash;
    mWorkflow.draft('qc').then(function(saved){
      if(actionHash!==location.hash||!mWorkflow.owns(saved))return;if(saved.operation.state!=='draft'){mWorkflow.paint(document.getElementById('m-view'),saved);return;}
      return mWorkflow.start(saved,{path:'/job-orders/'+u.job_order_id+'/units/inspect',payload:payload,title:desk.role.toUpperCase()+' inspection · '+label(u)+' · '+payload.result,successLabel:payload.result==='pass'?'Passed to '+destination(desk, u):payload.result==='repair'?'Sent for rework':'Inspection recorded',role:desk.role,node:desk.nodes.done,reviewRoute:'qc',reviewParams:{role:desk.role},reviewPath:'/qc/queue?role='+desk.role}).then(function(){clearDraft(u.id);delete cache[desk.role];delete jos[u.job_order_id];if(actionHash===location.hash&&mWorkflow.owns(saved))mWorkflow.paint(document.getElementById('m-view'),saved);});
    }).catch(fail(btn,btnText));
  }

  /* ── Repair / rectification (69:323 / 72:322) ───────────────────────────── */
  function repair(view, desk, u) {
    var s = session(u.id);
    var body = page(view, desk, desk.nodes.repair, desk.repairTitle, desk.repairSub);
    var sel = function (key, opts, v) { return '<select data-r="' + key + '">' + opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + mEsc(o) + '</option>'; }).join('') + '</select>'; };
    body.innerHTML =
      '<label class="rk-card rk-field"><small>' + mEsc(desk.categoryLabel) + '</small>' + sel('category', desk.categories, s.repair.category) + '</label>' +
      '<label class="rk-card rk-field"><small>' + mEsc(desk.instructionLabel) + '</small><textarea rows="3" maxlength="2000" data-instr>' + mEsc(s.repair.instruction || s.remarks || '') + '</textarea></label>' +
      '<div class="rk-pair"><label class="rk-card rk-field"><small>' + mEsc(desk.stationLabel) + '</small>' + sel('station', desk.stations, s.repair.station) + '</label>' +
        '<label class="rk-card rk-field"><small>Priority</small>' + sel('priority', desk.priorities, s.repair.priority) + '</label></div>' +
      '<button type="button" class="rk-photo-alert' + (s.photos ? ' done' : '') + '" data-photo><b>' + (s.photos ? '✓ ' + s.photos + ' photo' + (s.photos === 1 ? '' : 's') + ' attached' : '▣ ' + mEsc(desk.photoLabel)) + '</b><span>' + mEsc(desk.photoNote) + '</span></button>' +
      R.actions([{ id: 'qc-go', label: s.photos ? 'Send to ' + (desk.role === 'qa' ? 'rectification' : 'repair') : 'Continue with photo', kind: 'primary' },
        { id: 'qc-draft', label: 'Save draft', kind: 'secondary' }]);
    function collect() {
      ['category', 'station', 'priority'].forEach(function (k) { s.repair[k] = body.querySelector('[data-r="' + k + '"]').value; });
      s.repair.instruction = body.querySelector('[data-instr]').value.trim();
    }
    body.querySelector('[data-photo]').onclick = function () { collect(); go(desk, { unit: u.id, step: 'evidence', then: 'repair' }); };
    body.querySelector('#qc-draft').onclick = function () { collect(); saveDraft(u.id); };
    var btn = body.querySelector('#qc-go');
    btn.onclick = function () {
      collect();
      if (!s.repair.instruction) { mToast('Describe the ' + (desk.role === 'qa' ? 'correction' : 'repair'), 'err'); return; }
      if (!s.photos) { go(desk, { unit: u.id, step: 'evidence', then: 'repair' }); return; }
      if (offline()) { mToast('You’re offline — a repair handoff with evidence needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      loadJo(u.job_order_id).then(function (jo) {
        record(desk, u, { unit_ids: [u.id], result: 'fail', disposition: 'repair', remarks: s.repair.instruction,
          checklist: checklistPayload(stepsFor(desk, u, jo), s), repair: { category: s.repair.category, station: s.repair.station, priority: s.repair.priority } }, btn, 'Send to repair');
      }).catch(fail(btn, 'Send to repair'));
    };
  }

  /* ── Evidence (69:364 / 72:363) ─────────────────────────────────────────── */
  function evidence(view, desk, u, then) {
    var s = session(u.id);
    var body = page(view, desk, desk.nodes.evidence, desk.evidenceTitle, desk.evidenceSub);
    body.innerHTML =
      '<button type="button" class="rk-camera" data-cap><span class="target" aria-hidden="true"></span><b>' + mEsc(desk.evidenceFrame[0]) + '</b><small>' + mEsc(desk.evidenceFrame[1]) + '</small></button>' +
      (s.photos ? R.note('info', '<b>' + s.photos + ' photo' + (s.photos === 1 ? '' : 's') + ' attached to ' + mEsc(label(u)) + '</b>') : '') +
      '<div class="rk-note issue"><h3>Evidence rules</h3>' + mEsc(desk.evidenceRules) + '</div>' +
      R.actions([{ id: 'qc-cap', label: 'Capture photo', kind: 'primary' }, { id: 'qc-pick', label: s.photos ? 'Done' : 'Choose existing', kind: 'secondary' }]);
    Array.prototype.forEach.call(body.querySelectorAll('.rk-btn'), function (b) { b.classList.add('center'); });
    function take() {
      if (offline()) { mToast('You’re offline — evidence photos need a connection.', 'err'); return; }
      mPhoto.pickFile().then(function (file) {
        mToast('Uploading photo…');
        return mPhoto.attachBlob('qc_unit', u.id, file, file.name || 'evidence.jpg', desk.role.toUpperCase() + ' evidence');
      }).then(function (r) {
        if (r && r.id) s.evidence.push(r.id);
        s.photos++;
        mToast('Photo attached');
        go(desk, { unit: u.id, step: then || 'fail' });
      }).catch(function (err) { if (err) mToast(err.message || 'Could not attach the photo', 'err'); });
    }
    body.appendChild(mEl(R.actions([{ id: 'qc-report-evidence', label: 'Use issue-report photos', kind: 'secondary' }])));
    body.querySelector('#qc-report-evidence').onclick = function () {
      mUnitIssues.inspectionEvidence(u.id).then(function (ids) {
        if (!body.isConnected) return;
        if (!ids.length) { mToast('No unused photos uploaded by you on this unit’s issue reports.', 'err'); return; }
        s.evidence = Array.from(new Set(s.evidence.concat(ids))); s.photos = s.evidence.length;
        go(desk, { unit: u.id, step: then || 'fail' });
      }).catch(fail());
    };
    body.querySelector('[data-cap]').onclick = take;
    body.querySelector('#qc-cap').onclick = take;
    body.querySelector('#qc-pick').onclick = s.photos ? function () { go(desk, { unit: u.id, step: then || 'fail' }); } : take;
  }

  /* ── Fail / hold (69:397 / 72:396) ──────────────────────────────────────── */
  function failView(view, desk, u) {
    var s = session(u.id);
    var body = page(view, desk, desk.nodes.fail, desk.failTitle, desk.failSub);
    var outcomes = (desk.role === 'qa' ? [['hold', 'Hold for review (QA decides)']] : []).concat([
      ['scrap', 'Reject — scrap'], ['dispose', 'Reject — dispose'], ['recycle', 'Reject — recycle']]);
    body.innerHTML =
      '<div class="rk-alert"><b style="grid-column:1/-1;font-size:16px;color:#c72e1a">! ' + mEsc(desk.failAlert) + '</b>' +
        '<span style="grid-column:1/-1;font-size:12px;font-weight:600;color:var(--rk-title)">' + mEsc(label(u)) + '</span>' +
        '<span style="grid-column:1/-1">' + (desk.role === 'qa' ? 'Inventory remains blocked pending the recorded outcome.' : 'It remains traceable under the job order and QC record.') + '</span></div>' +
      (desk.role === 'qa' ? '<label class="rk-card rk-field"><small>Outcome</small><select data-out>' + outcomes.map(function (o) {
        return '<option value="' + o[0] + '"' + (s.disposition === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
        : '<label class="rk-card rk-field"><small>Disposition</small><select data-out>' + outcomes.map(function (o) {
          return '<option value="' + o[0] + '"' + (s.disposition === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>') +
      '<label class="rk-card rk-field"><small>' + (desk.role === 'qa' ? 'Reason' : 'Failure reason') + '</small><textarea rows="3" maxlength="2000" data-reason>' + mEsc(s.reason || s.remarks || '') + '</textarea></label>' +
      '<button type="button" class="rk-card rk-field" data-ev style="width:100%;text-align:left;font:inherit;cursor:pointer"><small>Evidence</small><b>' +
        (s.photos ? s.photos + ' close-up photo' + (s.photos === 1 ? '' : 's') + ' attached' : 'No photo yet — tap to add one *') + '</b></button>' +
      R.check('qc-reviewed', 'I reviewed the result and attached evidence') +
      R.actions([{ id: 'qc-confirm', label: desk.failConfirm, kind: 'danger' }, { id: 'qc-back', label: 'Back', kind: 'secondary' }]);
    var out = body.querySelector('[data-out]'), reason = body.querySelector('[data-reason]');
    var keep = function () { s.disposition = out.value; s.reason = reason.value; };
    body.querySelector('[data-ev]').onclick = function () { keep(); go(desk, { unit: u.id, step: 'evidence', then: 'fail' }); };
    body.querySelector('#qc-back').onclick = function () { keep(); history.back(); };
    var btn = body.querySelector('#qc-confirm'), chk = body.querySelector('#qc-reviewed');
    btn.disabled = true;
    chk.onchange = function () { btn.disabled = !chk.checked; };
    btn.onclick = function () {
      keep();
      var why = s.reason.trim();
      if (!why) { mToast('Give the ' + (desk.role === 'qa' ? 'reason' : 'failure reason'), 'err'); reason.focus(); return; }
      if (!s.photos) { mToast('Attach at least one close-up photo first', 'err'); return; }
      if (offline()) { mToast('You’re offline — this result needs a connection.', 'err'); return; }
      btn.disabled = true; btn.textContent = 'Recording…';
      loadJo(u.job_order_id).then(function (jo) {
        record(desk, u, {
          unit_ids: [u.id], result: 'fail', disposition: s.disposition || 'scrap', remarks: why,
          checklist: checklistPayload(stepsFor(desk, u, jo), s),
        }, btn, desk.failConfirm);
      }).catch(fail(btn, desk.failConfirm));
    };
  }

  /* ── Recorded (69:436 / 72:435) ─────────────────────────────────────────── */
  function done(view, desk, unitId) {
    var s = sess[unitId];
    var body = page(view, desk, desk.nodes.done, desk.doneTitle, 'The unit’s next destination is clear');
    if (!s || !s.result) { go(desk); return; }
    var r = s.result;
    var ident = s.identLabel || ('Unit #' + unitId);
    var title = r.queued ? 'Queued — will sync' : r.result === 'pass' ? 'Passed to ' + (s.dest || 'next stage')
      : r.disposition === 'hold' ? 'Held for review'
      : r.disposition === 'repair' ? (desk.role === 'qa' ? 'Sent to rectification' : 'Sent to repair')
      : 'Rejected · ' + r.disposition;
    // Saved only on an installed PC (X-Sync-State: local): not final until the cloud confirms.
    if (r.local) title += ' — on the site PC';
    var tone = r.queued || r.local ? 'queued' : r.result === 'pass' ? '' : r.disposition === 'repair' || r.disposition === 'hold' ? 'warn' : 'bad';
    var me = (MApp.getMe() || {}).full_name || 'You';
    body.innerHTML =
      '<div class="rk-result ' + tone + '"><i aria-hidden="true">' + (r.queued ? '⏳' : r.result === 'pass' ? '✓' : r.disposition === 'repair' ? '↻' : '!') + '</i><b>' + mEsc(title) + '</b>' +
        '<span>' + mEsc(r.count > 1 ? r.count + ' units' : ident) + '</span></div><div data-syncw></div>' +
      (r.queued ? R.note('warn', 'You’re offline. This result is queued on the phone and is <b>not recorded yet</b> — it sends automatically when you’re back online.') : '') +
      R.field('Recorded by', me + ' · ' + clock(r.at)) +
      R.field(desk.role === 'qa' ? 'Final-quality record' : 'Checklist record', r.items + ' items · ' + (r.issues ? r.issues + ' open issue' + (r.issues === 1 ? '' : 's') : 'no open defects')) +
      R.actions([{ id: 'qc-next', label: 'Inspect next unit', kind: 'primary' }, { id: 'qc-rec', label: 'View record', kind: 'secondary' }]) +
      '<div data-left></div>';
    body.querySelector('[data-syncw]').appendChild(R.syncWatch(r.local));
    body.querySelector('#qc-rec').onclick = function () { MApp.go('record', { unit: unitId }); };
    body.querySelector('#qc-next').onclick = function () {
      loadQueue(desk, true).then(function (q) {
        var next = q.units.filter(function (x) { return x.status === 'pending' && x.id !== unitId; })[0];
        delete sess[unitId];
        if (next) go(desk, { unit: next.id }); else go(desk);
      }).catch(function () { go(desk); });
    };
    loadQueue(desk, true).then(function (q) {
      var left = q.units.filter(function (x) { return x.status === 'pending'; }).length;
      body.querySelector('[data-left]').innerHTML = R.note('info', '<h3>Queue updated</h3>' + left + ' unit' + (left === 1 ? '' : 's') + ' remain ready for ' +
        (desk.role === 'qa' ? 'final-quality' : 'technical') + ' inspection.');
    }).catch(function () {});
  }

  /* ── Parts request for a repair unit (kept from the previous screen) ─────── */
  function parts(view, desk, u) {
    var body = page(view, desk, desk.nodes.recheck, 'Request a part', label(u) + ' · the warehouse issues it to the line');
    var picked = null;
    body.innerHTML =
      '<label class="rk-card rk-field"><small>Kind</small><select data-kind><option value="replace">Replace a fitted part</option><option value="add">Add a missing part</option></select></label>' +
      '<div class="rk-card rk-field"><small>Component</small><div data-picker></div><b data-picked style="font-weight:500">No component picked.</b></div>' +
      '<div class="rk-pair"><label class="rk-card rk-field"><small>Quantity</small><input class="rk-input" type="number" min="1" value="1" data-qty inputmode="numeric"></label>' +
        '<label class="rk-card rk-field"><small>Fault</small><select data-fault><option value="assembler">Assembler</option><option value="production">Production</option>' +
        '<option value="supplier">Supplier</option><option value="wear">Wear</option><option value="other">Other</option></select></label></div>' +
      R.check('qc-dmg', 'Old part goes to the damage record') +
      '<label class="rk-card rk-field"><small>Note (optional)</small><input class="rk-input" data-note maxlength="500"></label>' +
      R.actions([{ id: 'qc-send', label: 'Send request', kind: 'primary' }, { id: 'qc-back', label: 'Cancel', kind: 'secondary' }]);
    body.querySelector('#qc-dmg').checked = true;
    var picker = mItemPicker({ label: 'Component', onPick: function (it) { picked = it; body.querySelector('[data-picked]').textContent = it.name + (it.sku ? ' (#' + it.sku + ')' : ''); } });
    body.querySelector('[data-picker]').appendChild(picker.el);
    body.querySelector('#qc-back').onclick = function () { history.back(); };
    var btn = body.querySelector('#qc-send');
    btn.onclick = function () {
      if (!picked) { mToast('Pick a component', 'err'); return; }
      btn.disabled = true;
      mSubmit('/production/units/' + u.id + '/repairs', {
        kind: body.querySelector('[data-kind]').value, component_item_id: picked.id,
        quantity: parseInt(body.querySelector('[data-qty]').value, 10) || 1, fault: body.querySelector('[data-fault]').value,
        return_to_damage: body.querySelector('#qc-dmg').checked, notes: body.querySelector('[data-note]').value.trim() || null,
      }, { label: 'Part request · unit #' + u.id }).then(function (res) {
        mToast(res && res.queued ? 'Queued (offline) — not sent yet' : 'Request sent to the warehouse');
        go(desk, { unit: u.id });
      }).catch(fail(btn, 'Send request'));
    };
  }

  /* ── Pass several units with one checklist (kept from the previous screen) ─ */
  function bulk(view, desk, joId) {
    var body = page(view, desk, desk.nodes.queue, 'Pass several units', 'One checklist applied to every unit you pass');
    body.innerHTML = R.skeleton(2);
    loadQueue(desk, true).then(function (q) {
      var ready = q.units.filter(function (u) { return u.status === 'pending'; });
      var byJo = {};
      ready.forEach(function (u) { (byJo[u.job_order_id] = byJo[u.job_order_id] || []).push(u); });
      var ids = Object.keys(byJo);
      if (!joId) {
        body.innerHTML = ids.length ? '<div class="rk-list">' + ids.map(function (id) {
          var u0 = byJo[id][0];
          return R.jobCard({ id: id, number: u0.job_order_number, name: u0.product_name, pill: { text: byJo[id].length + ' ready' }, meta: 'Same checklist for every unit you pass' });
        }).join('') + '</div>' : '<div class="rk-empty">Nothing ready to pass.</div>';
        Array.prototype.forEach.call(body.querySelectorAll('[data-id]'), function (b) { b.onclick = function () { go(desk, { step: 'bulk', jo: b.dataset.id }); }; });
        return;
      }
      var list = byJo[joId] || [];
      if (!list.length) { body.innerHTML = '<div class="rk-empty">Nothing ready on this job order.</div>'; return; }
      body.innerHTML =
        '<div class="rk-stepper"><small>Units to pass</small><div class="row"><button type="button" data-dec aria-label="Fewer">−</button>' +
          '<input type="number" min="1" max="' + list.length + '" value="' + list.length + '"><button type="button" data-inc aria-label="More">+</button></div>' +
          '<p>' + list.length + ' ready on ' + mEsc(list[0].job_order_number) + '</p></div>' +
        '<div data-bulk-identities></div>' +
        '<label class="rk-card rk-field"><small>Batch / lot ID (optional, applied to all)</small><div style="display:flex;gap:8px;margin-top:8px">' +
          '<input class="rk-input" style="margin:0" data-bid autocapitalize="characters" placeholder="Leave blank to keep untracked">' +
          '<button type="button" class="rk-back" data-scan style="padding:0">Scan</button></div></label>' +
        R.note('info', 'Every unit gets the same checklist result. Units with an issue must be inspected one by one instead.') +
        R.actions([{ id: 'qc-go', label: 'Continue to checklist', kind: 'primary' }, { id: 'qc-back', label: 'Cancel', kind: 'secondary' }]);
      var input = body.querySelector('.rk-stepper input');
      function paintIdentities() { body.querySelector('[data-bulk-identities]').innerHTML = list.slice(0,Number(input.value)||0).map(function(u){return R.check('qc-match-'+u.id, 'I matched '+label(u)+' · '+u.job_order_number+' to the physical unit');}).join(''); }
      paintIdentities(); input.oninput=paintIdentities;
      var clamp = function (v) { return Math.max(1, Math.min(list.length, v || 1)); };
      body.querySelector('[data-dec]').onclick = function () { input.value = clamp(+input.value - 1); paintIdentities(); };
      body.querySelector('[data-inc]').onclick = function () { input.value = clamp(+input.value + 1); paintIdentities(); };
      body.querySelector('[data-scan]').onclick = function () { mScanner.open({ title: 'Scan batch / lot ID', onResult: function (c) { body.querySelector('[data-bid]').value = String(c || '').trim(); } }); };
      body.querySelector('#qc-back').onclick = function () { history.back(); };
      body.querySelector('#qc-go').onclick = function () {
        var n=Number(input.value);if(!input.value.trim()||!Number.isInteger(n)||n<1||n>list.length){mToast('Enter a whole quantity within this inspection stage.','err');return;}
        if(list.slice(0,n).some(function(u){return !String(u.identifier||'').trim() || !body.querySelector('#qc-match-'+u.id).checked;})){mToast('Match every selected unit identifier and job order before continuing.','err');return;}
        var first = list[0];
        var s = session(first.id); s.identity = identityKey(desk,first);
        s.bulk = n; s.bulkIds = list.slice(0, n).map(function (u) { return u.id; });
        s.bulkIdentifier = body.querySelector('[data-bid]').value.trim() || null;
        go(desk, { unit: first.id, step: 'check', g: 0 });
      };
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { bulk(view, desk, joId); })); });
  }

  /* ── Checklist assignment (qc.configure; kept from the previous screen) ──── */
  function checklistAssign(view, desk, u, jo) {
    var stage = inspectionStage(desk, u);
    var body = page(view, desk, desk.nodes.verify, 'Assign ' + (stage === 1 ? 'QC' : 'QA') + ' checklist', u.product_name);
    body.innerHTML = R.skeleton(2);
    Promise.all([API.get('/qc/checklists'), API.get('/finished-products/' + jo.product_item_id).catch(function () { return null; })]).then(function (r) {
      var all = (r[0] || []).filter(function (c) { return Number(c.stage) === stage; });
      var current = r[1] ? (stage === 1 ? r[1].qc_checklist_qc_id : r[1].qc_checklist_qa_id) : null;
      body.innerHTML = '<div class="rk-list">' + [{ id: '', name: 'Use default' }].concat(all).map(function (c) {
        return '<button type="button" class="rk-card rk-unitcard" data-cl="' + c.id + '"><b>' + mEsc(c.name) + (String(c.id) === String(current || '') ? ' ✓' : '') + '</b>' +
          '<small>' + (c.items ? c.items.length + ' checks' : c.item_count != null ? c.item_count + ' checks' : '') + (c.is_default ? ' · default' : '') + '</small><i>›</i></button>';
      }).join('') + '</div>' + R.note('info', 'Checks can carry a group (one step each) and a measurement unit — set them in the desktop checklist editor.');
      Array.prototype.forEach.call(body.querySelectorAll('[data-cl]'), function (b) {
        b.onclick = function () {
          API.patch('/finished-products/' + jo.product_item_id + '/checklist', { stage: stage, checklist_id: b.dataset.cl ? Number(b.dataset.cl) : null })
            .then(function () { mToast('Checklist assigned'); delete jos[jo.id]; go(desk, { unit: u.id }); }).catch(fail());
        };
      });
    }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { checklistAssign(view, desk, u, jo); })); });
  }

  function canDecideHolds() { return can('production.inspect_qa') || can('production.qa_review'); }

  /* ── Decide a held unit (extends 72:396) — online-only ──────────────────── */
  function holdDecision(view, desk, unitId) {
    var body = page(view, desk, desk.nodes.fail, 'Decide held unit', 'Pass, rectify or fail — with the reason');
    body.innerHTML = R.skeleton(2);
    var owner = mProductionDrafts.key(holdId(unitId) + ':action'), routeHash = location.hash;
    mProductionDrafts.loadAction(holdId(unitId)).then(function (record) {
      if (!body.isConnected || !MApp.getMe() || owner !== mProductionDrafts.key(holdId(unitId) + ':action') || location.hash !== routeHash) return;
      if (record) { holdRecovery(view, desk, record); return; }
      return loadHolds().then(function (rows) {
      if (!body.isConnected || !MApp.getMe() || owner !== mProductionDrafts.key(holdId(unitId) + ':action') || location.hash !== routeHash) return;
      var h = rows.filter(function (x) { return x.id === unitId; })[0];
      if (!h) { body.innerHTML = R.note('info', 'This unit is no longer on hold.') + R.actions([{ id: 'qc-back', label: 'Back to queue', kind: 'secondary' }]); body.querySelector('#qc-back').onclick = function () { go(desk, { tab: 'hold' }); }; return; }
      var out = 'pass', checks = h.checks || [], answers = checks.map(function (it) {
        var old = (h.checklist || []).find(function (a) { return a.label.trim().toLocaleLowerCase() === it.label.trim().toLocaleLowerCase(); }) || {};
        return { label: it.label, status: old.status || (old.ok === true ? 'pass' : old.ok === false ? 'issue' : ''), value: old.value || '', note: old.note || null };
      });
      function paint() {
        body.innerHTML =
          R.jobHead({ tone: 'warn', number: label(h), pill: { text: 'On hold', tone: 'warn' }, name: h.product_name, meta: h.job_order_number }) +
          R.field('Held by ' + (h.held_by_name || '—') + ' · ' + clock(h.held_at), h.remarks || '—') +
          (h.issues.length ? '<div class="rk-checks">' + h.issues.map(function (i) {
            return '<div class="rk-check-row"><button type="button" disabled><span class="rk-state issue" aria-hidden="true">!</span><b>' + mEsc(i.label) + '</b><small>' + mEsc(i.note || 'Issue') + '</small></button></div>';
          }).join('') + '</div>' : '') +
          '<div data-photos></div>' +
          '<div class="rk-disps">' + [['pass', '✓', 'Pass', 'Accept as is — goes on to RTS'], ['rectify', '↻', 'Rectify', 'Back for correction, then recheck'], ['fail', '!', 'Fail', 'Reject the unit']].map(function (o) {
            return '<button type="button" class="rk-disp ' + (o[0] === 'fail' ? 'fail' : o[0] === 'rectify' ? 'repair' : 'pass') + (out === o[0] ? ' on' : '') + '" data-o="' + o[0] + '"><i>' + o[1] + '</i><b>' + o[2] + '</b><span>' + o[3] + '</span></button>';
          }).join('') + '</div>' +
          (out === 'fail' ? '<label class="rk-card rk-field"><small>Disposition</small><select data-disp><option value="scrap">Scrap</option><option value="dispose">Dispose</option><option value="recycle">Recycle</option></select></label>' : '') +
          (out === 'rectify' ? '<label class="rk-card rk-field"><small>Route to</small><select data-station>' + desk.stations.map(function (x) { return '<option>' + mEsc(x) + '</option>'; }).join('') + '</select></label>' : '') +
          (out === 'pass' && checks.length ? R.section('Review final-pass checklist') + checks.map(function (it,i) {
            return '<label class="rk-card rk-field"><small>' + mEsc(it.label) + (it.required ? ' *' : '') + '</small><select data-hold-check="' + i + '">' + ['','pass','issue','na'].map(function (v) { return '<option value="' + v + '"' + (answers[i].status === v ? ' selected' : '') + '>' + (v || 'Review check') + '</option>'; }).join('') + '</select>' + (it.measure ? '<input data-hold-reading="' + i + '" maxlength="200" placeholder="' + mEsc(it.measure) + '" value="' + mEsc(answers[i].value) + '">' : '') + '</label>';
          }).join('') : '') +
          '<label class="rk-card rk-field"><small>Decision reason *</small><textarea rows="3" maxlength="2000" data-why></textarea></label>' +
          R.actions([{ id: 'qc-decide', label: out === 'pass' ? 'Pass unit' : out === 'rectify' ? 'Send to rectification' : 'Fail unit', kind: out === 'fail' ? 'danger' : 'primary' },
            { id: 'qc-back', label: 'Back', kind: 'secondary' }]);
        if (window.mPhoto && mPhoto.thumbs) body.querySelector('[data-photos]').appendChild(mPhoto.thumbs('qc_unit', h.id, {}));
        Array.prototype.forEach.call(body.querySelectorAll('[data-o]'), function (b) { b.onclick = function () { var w = body.querySelector('[data-why]').value; out = b.dataset.o; paint(); body.querySelector('[data-why]').value = w; }; });
        body.querySelector('#qc-back').onclick = function () { go(desk, { tab: 'hold' }); };
        body.querySelectorAll('[data-hold-check]').forEach(function (el) { el.onchange = function () { answers[Number(el.dataset.holdCheck)].status = el.value; checkReady(); }; });
        body.querySelectorAll('[data-hold-reading]').forEach(function (el) { el.oninput = function () { answers[Number(el.dataset.holdReading)].value = el.value.trim(); checkReady(); }; });
        var btn = body.querySelector('#qc-decide');
        function checkReady() { btn.disabled = out === 'pass' && (new Set(checks.map(function (it) { return it.label.trim().toLocaleLowerCase(); })).size !== checks.length || checks.some(function (it,i) { return it.required && answers[i].status !== 'pass' || it.measure && answers[i].status === 'pass' && !answers[i].value; })); }
        checkReady();
        btn.onclick = function () {
          var why = body.querySelector('[data-why]').value.trim();
          if (why.length < 3) { mToast('Give the reason for the decision', 'err'); return; }
          if (offline()) { mToast('You’re offline — the decision needs a connection. Nothing was recorded.', 'err'); return; }
          var d = body.querySelector('[data-disp]'), st = body.querySelector('[data-station]');
          if (out === 'pass' && (new Set(checks.map(function (it) { return it.label.trim().toLocaleLowerCase(); })).size !== checks.length || checks.some(function (it,i) { return it.required && answers[i].status !== 'pass' || it.measure && answers[i].status === 'pass' && !answers[i].value; }))) { mToast('Complete the required checks and readings before passing. Duplicate labels need a manager to correct the checklist.', 'err'); return; }
          var payload = { outcome: out, remarks: why, expected_hold_record_id: h.record_id };
          if (out === 'pass' && Array.isArray(h.checks)) payload.checklist = answers.map(function (a) { return { label: a.label, status: a.status || undefined, ok: a.status === 'pass' || a.status === 'na', value: a.value || null, note: a.note }; });
          if (d) payload.disposition = d.value;
          if (st) payload.repair = { category: 'QA hold', station: st.value, priority: 'Before release' };
          var record = { key: owner, rows: [], operation: { kind: 'hold-decision', context: JSON.parse(JSON.stringify(h)), payload: payload,
            path: '/job-orders/' + h.job_order_id + '/units/' + h.id + '/hold-decision', key: 'qa-hold-' + crypto.randomUUID(), created: Date.now(), state: 'new' } };
          body.querySelectorAll('button,input,textarea,select').forEach(function (el) { el.disabled = true; });
          sendHold(record).then(function () { holdRecovery(view, desk, record); }).catch(function (err) {
            if (!holdVisible(view, record)) return;
            mToast(err.message, 'err'); holdDecision(view, desk, unitId);
          });
        };
      }
      paint();
      });
    }).catch(function (err) { if (!body.isConnected) return; body.innerHTML = ''; body.appendChild(R.error(err, function () { holdDecision(view, desk, unitId); })); });
  }

  MApp.route('qc', async function (view, params) {
    params = params || {};
    var desk = deskFor(params);
    var canDesk = can(desk.role === 'qa' ? 'production.inspect_qa' : 'production.inspect_qc') || (desk.role === 'qa' && can('production.qa_review'));
    if (!canDesk) { view.innerHTML = '<div class="m-error">You don’t have the ' + desk.role.toUpperCase() + ' inspection permission.</div>'; return; }
    var attemptHash=location.hash;var attempt;try{attempt=await mWorkflow.load('qc');}catch(e){view.innerHTML='';view.appendChild(R.error(e,function(){MApp.render();}));return;}if(attemptHash!==location.hash)return;if(attempt&&attempt.operation.state!=='draft'){mWorkflow.paint(view,attempt);return;}
    var unitId = params.unit && Number(params.unit);
    var step = params.step;
    if (unitId && step === 'hold' && desk.role === 'qa' && canDecideHolds()) return holdDecision(view, desk, unitId);
    if (step === 'identify') return identify(view, desk);
    if (step === 'bulk') return bulk(view, desk, params.jo);
    if (unitId && step === 'done') return done(view, desk, unitId);
    if (unitId) {
      return withUnit(view, desk, unitId, function (u, jo) {
        var s = session(u.id);
        s.identLabel = label(u); s.dest = destination(desk, u);
        if (['check','review','pass','repair','evidence','fail'].indexOf(step) !== -1 && s.identity !== identityKey(desk,u)) return verify(view,desk,u,jo);
        if (step === 'check') check(view, desk, u, jo, params.g);
        else if (step === 'review') review(view, desk, u, jo);
        else if (step === 'pass') passView(view, desk, u, jo);
        else if (step === 'repair') repair(view, desk, u);
        else if (step === 'evidence') evidence(view, desk, u, params.then);
        else if (step === 'fail') failView(view, desk, u);
        else if (step === 'parts') parts(view, desk, u);
        else if (step === 'checklist' && can('qc.configure')) checklistAssign(view, desk, u, jo);
        else verify(view, desk, u, jo);
      });
    }
    // Legacy deep link #/qc?id=<jobOrderId> (e.g. job order → Inspect): the queue for that job order.
    queue(view, desk, params.tab, params.jo || params.id);
  });
})();
