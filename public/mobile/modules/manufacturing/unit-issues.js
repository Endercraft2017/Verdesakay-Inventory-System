/* Separate issue reports on a produced unit. Each report owns its photos. Durable
   account/server-scoped drafts retain compressed bytes and immutable retry keys.
   Reporting is informational; inspection disposition controls advancement. */
(function () {
  var R = RoleUI, renderSerial = 0;
  var canReport = function () { return ['inventory.adjust', 'production.record', 'production.inspect_qc', 'production.inspect_qa', 'production.approve', 'production.manage', 'production.receive'].some(MApp.can); };
  function id(unit, draft) { return 'issue:' + unit + (draft ? ':' + draft : ''); }
  function route(unit, role, extra) { MApp.go('unit-issues', Object.assign({ unit: unit, role: role }, extra || {})); }
  function label(u) { return u.identifier || 'Unit #' + u.id; }
  function page(view, ctx, title) { return R.page(view, { role: ctx.role, node: ctx.role === 'qa' ? '72:363' : '69:364', title: title, subtitle: label(ctx.unit) + ' · ' + ctx.jo.number }); }
  function visible(ctx, s) {
    try { return s.key === mProductionDrafts.key(id(ctx.unit.id, s.operation.draftId) + ':action') && location.hash.split('?')[0] === '#/unit-issues' && Number(new URLSearchParams(location.hash.split('?')[1] || '').get('unit')) === ctx.unit.id && new URLSearchParams(location.hash.split('?')[1] || '').get('draft') === s.operation.draftId; } catch (e) { return false; }
  }
  function active(ctx) { try { return MApp.getMe() && ctx.owner === mProductionDrafts.key(id(ctx.unit.id) + ':action') && location.hash.split('?')[0] === '#/unit-issues' && Number(new URLSearchParams(location.hash.split('?')[1] || '').get('unit')) === ctx.unit.id; } catch (e) { return false; } }
  function owns(i) { var p = MApp.getMe() || {}; return i.reported_by === p.id || ['inventory.adjust', 'production.approve', 'production.manage'].some(MApp.can); }
  function pending(s) { return s.operation.local || s.rows.some(function (r) { return r.local; }); }
  function completed(s) { return s.operation.state === 'confirmed' && s.rows.every(function (r) { return r.saved && !r.local; }) && !s.operation.local; }
  function persist(s) { return mProductionDrafts.save(s); }
  function error(err) { mToast(err.message || 'Could not save the report draft', 'err'); }
  function stopped(op) { return op.state === 'conflict' || op.created && Date.now() - op.created >= 7 * 86400000; }
  function classify(err) { return !err.status || err.status >= 500 || err.status === 429 ? 'unknown' : err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected'; }

  async function send(ctx, s) {
    var op = s.operation;
    if (!visible(ctx, s)) throw new Error('Recover this report using its original account and unit.');
    if (stopped(op) || s.rows.some(function (r) { return r.attempt && stopped(r.attempt); })) { op.state = 'conflict'; op.error = 'Ask a supervisor to reconcile this expired or conflicting attempt. Do not replace its key.'; await persist(s); return; }
    if (op.state !== 'confirmed') {
      op.state = 'sending'; op.error = null;
      await persist(s); // storage is required before any mutation
      try {
        var res = await API[op.method || 'post'](op.path, op.payload, { idempotencyKey: op.key });
        op.issueId = res.id; op.state = 'confirmed'; op.local = API.syncLocal(res);
        await persist(s);
      } catch (err) { op.state = classify(err); op.error = err.message; await persist(s); return; }
    }
    if (op.local) return;
    for (var r of s.rows) {
      if (r.saved) { if (r.local) return; continue; }
      if (!r.attempt) r.attempt = { key: 'issue-photo-' + crypto.randomUUID(), created: Date.now(), filename: r.file.name || 'issue.jpg', caption: op.doc.category + ' · ' + r.identifier, refId: op.issueId, state: 'new' };
      r.attempt.state = 'sending'; r.attempt.error = null;
      await persist(s);
      try {
        var fd = new FormData(); fd.append('kind', 'production_issue'); fd.append('ref_id', String(r.attempt.refId)); fd.append('caption', r.attempt.caption); fd.append('image', r.file, r.attempt.filename);
        var photo = await API.upload('/attachments', fd, { idempotencyKey: r.attempt.key });
        r.saved = true; r.unitId = photo.id; r.local = API.syncLocal(photo); r.attempt.state = 'confirmed'; await persist(s);
      } catch (err) { r.attempt.state = classify(err); r.attempt.error = err.message; await persist(s); return; }
      if (r.local) return;
    }
  }

  function progress(view, ctx, s) {
    if (!visible(ctx, s)) return;
    var op = s.operation, final = completed(s), refused = op.state === 'rejected' || s.rows.some(function (r) { return r.attempt && r.attempt.state === 'rejected'; });
    var conflict = op.state === 'conflict' || s.rows.some(function (r) { return r.attempt && r.attempt.state === 'conflict'; });
    var body = page(view, ctx, final ? 'Issue report confirmed' : 'Review issue submission');
    body.innerHTML = R.field('Issue', op.doc.category) + R.field('Description', op.doc.description) +
      R.field('Report status', op.local ? 'Saved on site PC — confirmation pending' : op.state === 'confirmed' ? 'Report confirmed' : op.state === 'rejected' ? 'Report refused — review before correcting' : 'Report confirmation unknown') +
      (s.rows.length ? R.lines(s.rows.map(function (r) { return { name: r.identifier, qty: r.local ? 'Confirmation pending' : r.saved ? 'Confirmed' : r.attempt ? r.attempt.state : 'Not started', ok: !!r.saved }; })) : R.note('info', 'No photos on this report.')) +
      (op.error ? R.note('warn', mEsc(op.error)) : '') + s.rows.filter(function (r) { return r.attempt && r.attempt.error; }).map(function (r) { return R.note('warn', mEsc(r.attempt.error)); }).join('') +
      R.note(final ? 'info' : 'warn', final ? 'This report and its selected photos are confirmed. Record the inspection disposition separately.' : conflict ? 'Supervisor reconciliation is required; the original attempt is retained.' : pending(s) ? 'Waiting for site-PC confirmation. Do not submit another copy.' : refused ? 'Review the refusal before making a corrected attempt.' : 'The exact report and photo bytes are retained. Continue reuses attempted keys and skips confirmed photos.') +
      R.actions((!final && !pending(s) && !refused && !conflict ? [{ id: 'ui-retry', label: 'Continue original', kind: 'primary' }] : [])
        .concat(refused && op.state === 'rejected' ? [{ id: 'ui-correct', label: 'Review report', kind: 'secondary' }] : [])
        .concat(refused && op.state === 'confirmed' ? [{ id: 'ui-correct-photos', label: 'Review refused photos', kind: 'secondary' }] : [])
        .concat([{ id: 'ui-back', label: 'Back to issues', kind: 'secondary' }].concat(final ? [{ id: 'ui-another', label: 'Add another issue', kind: 'primary' }] : []))) + '<div data-sync></div>';
    var retry = body.querySelector('#ui-retry'); if (retry) retry.onclick = function () { retry.disabled = true; send(ctx, s).then(function () { progress(view, ctx, s); }).catch(function (err) { error(err); progress(view, ctx, s); }); };
    var correct = body.querySelector('#ui-correct'); if (correct) correct.onclick = function () { op.state = 'draft'; delete op.key; delete op.payload; delete op.created; persist(s).then(function () { form(view, ctx, s); }).catch(error); };
    var photos = body.querySelector('#ui-correct-photos'); if (photos) photos.onclick = function () {
      API.get('/production-issues/' + op.issueId).then(function (i) {
        if (i.status !== 'open') throw new Error('Reopen this report before adding photos.');
        s.rows.forEach(function (r) { if (r.attempt && r.attempt.state === 'rejected') r.attempt = null; });
        op.mode = 'photos'; op.state = 'draft'; persist(s).then(function () { form(view, ctx, s); }).catch(error);
      }).catch(error);
    };
    body.querySelector('#ui-back').onclick = function () {
      if (final) mProductionDrafts.remove(s).then(function () { if (visible(ctx, s)) { route(ctx.unit.id, ctx.role); open(view, { unit: ctx.unit.id, role: ctx.role }); } }).catch(error);
      else route(ctx.unit.id, ctx.role);
    };
    var another = body.querySelector('#ui-another'); if (another) another.onclick = function () { mProductionDrafts.remove(s).then(function () { if (visible(ctx, s)) { start(ctx); } }).catch(error); };
    if (refused && op.state === 'confirmed' && !pending(s) && !s.rows.some(function (r) { return r.attempt && ['unknown','sending','conflict'].indexOf(r.attempt.state) !== -1; })) {
      body.appendChild(mEl(R.actions([{ id: 'ui-discard-photos', label: 'Discard refused / unsent photos', kind: 'secondary' }])));
      body.querySelector('#ui-discard-photos').onclick = function () { mProductionDrafts.remove(s).then(function () { if (visible(ctx, s)) { route(ctx.unit.id, ctx.role); open(view, { unit: ctx.unit.id, role: ctx.role }); } }).catch(error); };
    }
    var locals = [{ command: op.local, clear: function () { op.local = null; } }].concat(s.rows.map(function (r) { return { command: r.local, clear: function () { r.local = null; } }; }));
    locals.filter(function (l) { return l.command; }).forEach(function (l) { body.querySelector('[data-sync]').appendChild(R.syncWatch(l.command, function (r) { if (r.state === 'confirmed' && visible(ctx, s)) { l.clear(); persist(s).then(function () { progress(view, ctx, s); }).catch(error); } })); });
  }

  function fresh(ctx, issue, mode) {
    var draftId = crypto.randomUUID();
    return { key: mProductionDrafts.key(id(ctx.unit.id, draftId) + ':action'), rows: [], operation: { kind: 'unit-issue', draftId: draftId, state: 'draft', mode: mode || 'create', issueId: issue && issue.id,
      context: { unitId: ctx.unit.id, jobId: ctx.jo.id, identifier: label(ctx.unit), product_name: ctx.unit.product_name || ctx.jo.product_name, job_order_number: ctx.jo.number, role: ctx.role }, doc: { category: issue ? issue.category : 'Chassis', severity: issue ? issue.severity : 'normal', description: issue ? issue.description : '', visible: !issue } } };
  }
  function start(ctx, issue, mode) {
    if (!active(ctx)) return Promise.resolve();
    var draft = fresh(ctx, issue, mode), hash = location.hash;
    return persist(draft).then(function () { if (active(ctx) && location.hash === hash) route(ctx.unit.id, ctx.role, { draft: draft.operation.draftId }); }).catch(error);
  }
  function form(view, ctx, s) {
    if (!visible(ctx, s)) return;
    var op = s.operation, photoOnly = op.mode === 'photos';
    var body = page(view, ctx, photoOnly ? 'Add issue photos' : op.mode === 'edit' ? 'Edit issue report' : 'Report a separate issue');
    body.innerHTML = (ctx.cached ? R.note('warn', 'Using the saved unit details. Edit drafts here, then reconnect and reopen this unit before submitting.') : '') + R.note('info', 'Create a separate report for each issue. Its photos stay linked to that report.') +
      (photoOnly ? R.field('Issue', op.doc.category) + R.field('Description', op.doc.description) :
        '<label class="rk-card rk-field"><small>Affected area *</small><input data-area maxlength="80" list="ui-areas" value="' + mEsc(op.doc.category) + '"><datalist id="ui-areas"><option value="Chassis"><option value="Fairings"><option value="Paint"><option value="Electrical"><option value="Mechanical"><option value="Documents"><option value="Other"></datalist></label>' +
        '<label class="rk-card rk-field"><small>Description *</small><textarea data-description maxlength="4000" rows="3">' + mEsc(op.doc.description) + '</textarea></label>' +
        '<label class="rk-card rk-field"><small>Severity</small><select data-severity>' + ['low','normal','high','critical'].map(function (v) { return '<option' + (op.doc.severity === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label>' +
        R.check('ui-visible', 'Visible defect — add at least one photo')) + '<div data-photos></div><small data-draft-status>Draft retained on this phone</small>' +
      R.actions([{ id: 'ui-send', label: photoOnly ? 'Upload selected photos' : 'Send report', kind: 'primary' }, { id: 'ui-list', label: 'Back to issues', kind: 'secondary' }, { id: 'ui-discard-draft', label: 'Discard this draft', kind: 'secondary' }]);
    function collect() { if (!photoOnly) { op.doc.category = body.querySelector('[data-area]').value.trim(); op.doc.description = body.querySelector('[data-description]').value; op.doc.severity = body.querySelector('[data-severity]').value; op.doc.visible = body.querySelector('#ui-visible').checked; } }
    function saveDraft() { body.querySelector('[data-draft-status]').textContent = 'Saving draft…'; return persist(s).then(function () { if (body.isConnected) body.querySelector('[data-draft-status]').textContent = 'Draft saved on this phone'; }).catch(error); }
    if (!photoOnly) { body.querySelector('#ui-visible').checked = op.doc.visible; body.querySelectorAll('input,textarea,select').forEach(function (el) { el.oninput = function () { collect(); saveDraft(); }; el.onchange = el.oninput; }); }
    var editable = s.rows.filter(function (r) { return !r.saved; });
    var picker = mPhoto.picker({ max: 12, onBusy: function (busy) { body.querySelectorAll('#ui-send,#ui-list,#ui-discard-draft').forEach(function (b) { b.disabled = busy; }); if (busy) body.querySelector('[data-draft-status]').textContent = 'Preparing photos…'; }, initial: editable.map(function (r) { return r.file; }), onChange: function (files) { if (!body.isConnected || !visible(ctx, s) || op.state !== 'draft') return; collect(); s.rows = s.rows.filter(function (r) { return r.saved; }).concat(files.map(function (f, n) { return editable.find(function (r) { return r.file === f; }) || { identifier: 'Photo ' + (n + 1), file: f, saved: false }; })); saveDraft(); } });
    body.querySelector('[data-photos]').appendChild(picker);
    body.querySelector('#ui-discard-draft').onclick = function () { mProductionDrafts.remove(s).then(function () { if (visible(ctx, s)) { route(ctx.unit.id, ctx.role); open(view, { unit: ctx.unit.id, role: ctx.role }); } }).catch(error); };
    body.querySelector('#ui-list').onclick = function () { collect(); persist(s).then(function () { route(ctx.unit.id, ctx.role); }).catch(error); };
    body.querySelector('#ui-send').onclick = function () {
      collect();
      if (!photoOnly && (!op.doc.category || !op.doc.description.trim())) { mToast('Choose an area and describe the issue.', 'err'); return; }
      if ((photoOnly || op.doc.visible) && !s.rows.some(function (r) { return r.file; })) { mToast('Add a photo for this visible issue.', 'err'); return; }
      if (ctx.cached || navigator.onLine === false) { mToast('Draft retained. Reconnect and reopen the unit to submit the report and photos.', 'err'); persist(s).catch(error); return; }
      op.payload = op.mode === 'edit' ? { category: op.doc.category, severity: op.doc.severity, description: op.doc.description.trim() } : { job_order_id: ctx.jo.id, unit_id: ctx.unit.id, category: op.doc.category, severity: op.doc.severity, description: op.doc.description.trim() };
      op.path = op.mode === 'edit' ? '/production-issues/' + op.issueId : '/production-issues'; op.method = op.mode === 'edit' ? 'put' : 'post';
      op.key = 'unit-issue-' + crypto.randomUUID(); op.created = Date.now(); op.state = photoOnly ? 'confirmed' : 'new';
      body.querySelectorAll('button,input,textarea,select').forEach(function (el) { el.disabled = true; });
      send(ctx, s).then(function () { progress(view, ctx, s); }).catch(function (err) { error(err); if (visible(ctx, s)) progress(view, ctx, s); });
    };
  }

  function list(view, ctx, saved) {
    var body = page(view, ctx, 'Unit issues and photos'); body.innerHTML = R.skeleton(2);
    function paint(rows, err) {
      if (!body.isConnected || !active(ctx)) return;
      body.innerHTML = (err ? R.note('warn', 'Unable to load live reports. Saved drafts are retained below; reconnect to check reported issues.') : '') + R.note('info', 'Reports record individual findings. The inspection disposition controls whether this unit advances.') +
        (canReport() ? R.actions([{ id: 'ui-new', label: 'Add issue report', kind: 'primary' }]) : '') +
        (saved.length ? R.section('Saved drafts and submissions') + '<div data-saved>' + saved.map(function (s) { return R.jobCard({ id: s.operation.draftId, number: s.operation.doc.category, name: s.operation.doc.description || 'Unsent draft', pill: { text: s.operation.state === 'draft' ? 'Draft' : 'Review submission', tone: 'warn' }, meta: s.rows.length + ' selected photo(s)' }); }).join('') + '</div>' : '') +
        R.section('Reported issues') + '<div data-reports>' + (rows && rows.length ? rows.map(function (i) { return R.jobCard({ id: i.id, number: i.category, name: i.description, pill: { text: i.status, tone: i.status === 'open' ? 'warn' : '' }, meta: i.severity + ' · ' + i.photo_count + ' photo(s) · ' + (i.reported_by_name || '—') }); }).join('') : '<div class="rk-empty">' + (err ? 'Reported issues unknown — reconnect and retry.' : 'No issue reports on this unit.') + '</div>') + '</div>' +
        R.actions([{ id: 'ui-unit', label: 'Back to unit', kind: 'secondary' }]);
      var add = body.querySelector('#ui-new'); if (add) add.onclick = function () { start(ctx); };
      body.querySelectorAll('[data-saved] [data-id]').forEach(function (b) { b.onclick = function () { route(ctx.unit.id, ctx.role, { draft: b.dataset.id }); }; });
      body.querySelectorAll('[data-reports] [data-id]').forEach(function (b) { b.onclick = function () { route(ctx.unit.id, ctx.role, { issue: b.dataset.id }); }; });
      body.querySelector('#ui-unit').onclick = function () { MApp.go('record', { unit: ctx.unit.id }); };
      if (err) body.appendChild(R.error(err, function () { open(view, { unit: ctx.unit.id, role: ctx.role }); }));
    }
    API.get('/production-issues?job_order_id=' + ctx.jo.id + '&unit_id=' + ctx.unit.id).then(function (rows) { paint(rows); }).catch(function (err) { paint(null, err); });
  }
  function detail(view, ctx, issueId, saved) {
    var body = page(view, ctx, 'Issue report'); body.innerHTML = R.skeleton(2);
    API.get('/production-issues/' + issueId).then(function (i) {
      if (!body.isConnected || !active(ctx)) return;
      if (i.unit_id !== ctx.unit.id || i.job_order_id !== ctx.jo.id) throw new Error('This report belongs to a different unit.');
      body.innerHTML = R.field('Affected area', i.category) + R.field('Description', i.description) + R.field('Status / severity', i.status + ' · ' + i.severity) +
        R.field('Reported by', i.reported_by_name || '—') + (i.resolution ? R.field('Resolution', i.resolution) : '') + '<div data-report-photos></div>' +
        (owns(i) && canReport() && !saved.some(function (s) { return s.operation.issueId === i.id; }) ? R.actions((i.status === 'open' ? [{ id: 'ui-edit', label: 'Edit report', kind: 'secondary' }, { id: 'ui-add-photos', label: 'Add photos', kind: 'secondary' }, { id: 'ui-resolve', label: 'Resolve issue', kind: 'primary' }] : [{ id: 'ui-reopen', label: 'Reopen issue', kind: 'secondary' }])) : '') +
        R.actions([{ id: 'ui-list', label: 'Back to issues', kind: 'secondary' }]);
      body.querySelector('[data-report-photos]').appendChild(mPhoto.thumbs('production_issue', i.id, {}));
      body.querySelector('#ui-list').onclick = function () { route(ctx.unit.id, ctx.role); };
      [['ui-edit','edit'], ['ui-add-photos','photos']].forEach(function (a) { var b = body.querySelector('#' + a[0]); if (b) b.onclick = function () { start(ctx, i, a[1]); }; });
      ['resolve','reopen'].forEach(function (action) {
        var b = body.querySelector('#ui-' + action); if (!b) return;
        b.onclick = function () {
          var actionBody = page(view, ctx, action === 'resolve' ? 'Resolve issue report' : 'Reopen issue report');
          actionBody.innerHTML = R.field('Issue', i.category) + R.field('Description', i.description) +
            (action === 'resolve' ? '<label class="rk-card rk-field"><small>Resolution (optional)</small><textarea data-resolution maxlength="2000" rows="3"></textarea></label>' : R.note('info', 'The report will be open again.')) +
            R.actions([{ id: 'ui-confirm-action', label: action === 'resolve' ? 'Confirm resolution' : 'Confirm reopen', kind: 'primary' }, { id: 'ui-cancel-action', label: 'Back to report', kind: 'secondary' }]);
          actionBody.querySelector('#ui-cancel-action').onclick = function () { detail(view, ctx, i.id, saved); };
          actionBody.querySelector('#ui-confirm-action').onclick = function () {
            var draft = fresh(ctx, i, action), op = draft.operation; op.state = 'new'; op.path = '/production-issues/' + i.id + '/' + action;
            op.payload = action === 'resolve' ? { resolution: actionBody.querySelector('[data-resolution]').value.trim() || null } : {}; op.key = 'unit-issue-' + crypto.randomUUID(); op.created = Date.now();
            actionBody.querySelectorAll('button,textarea').forEach(function (el) { el.disabled = true; });
            persist(draft).then(function () { route(ctx.unit.id, ctx.role, { draft: op.draftId }); }).catch(error);
          };
        };
      });
    }).catch(function (err) { if (!body.isConnected) return; body.innerHTML = ''; body.appendChild(R.error(err, function () { detail(view, ctx, issueId, saved); })); });
  }
  function open(view, params) {
    var render = ++renderSerial;
    if (!Number(params.unit)) {
      var role = params.role === 'qa' || MApp.can('production.inspect_qa') ? 'qa' : 'qc';
      var body = R.page(view, { role: role, node: role === 'qa' ? '72:104' : '69:104', title: 'Saved unit issue reports', subtitle: 'Resume reports and photos retained on this phone' });
      body.innerHTML = R.skeleton(2);
      var savedOwner = mProductionDrafts.key('issue-list');
      mProductionDrafts.listActions('unit-issue', 'issue').then(function (saved) {
        if (render !== renderSerial || !body.isConnected || !MApp.getMe() || savedOwner !== mProductionDrafts.key('issue-list')) return;
        body.innerHTML = saved.length ? saved.map(function (a) { var c = a.record.operation.context; return R.jobCard({ id: a.record.operation.draftId, number: c.identifier, name: a.record.operation.doc.category, pill: { text: 'Review saved report', tone: 'warn' }, meta: c.job_order_number }); }).join('') : R.note('info', 'No saved report drafts. Open a unit in QC or QA to report an issue.');
        body.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { var s = saved.find(function (a) { return a.record.operation.draftId === b.dataset.id; }); route(s.id, role, { draft: b.dataset.id }); }; });
      }).catch(function (err) { body.innerHTML = ''; body.appendChild(R.error(err, function () { open(view, params); })); });
      return;
    }
    var unitId = Number(params.unit), role = params.role === 'qa' ? 'qa' : 'qc';
    var owner = mProductionDrafts.key(id(unitId) + ':action'), hash = location.hash;
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    Promise.all([API.get('/production/record?unit=' + unitId).catch(function (err) { return { readError: err }; }), mProductionDrafts.listActions('unit-issue', 'issue')]).then(function (both) {
      if (render !== renderSerial || location.hash !== hash || !MApp.getMe() || owner !== mProductionDrafts.key(id(unitId) + ':action')) return;
      var d = both[0], saved = both[1].filter(function (a) { return a.id === unitId; }).map(function (a) { return a.record; }), cached = false;
      if (d.readError) {
        if (!saved.length || d.readError.status && d.readError.status < 500) throw d.readError;
        var c = saved[0].operation.context;
        d = { unit: { id: c.unitId, identifier: c.identifier, product_name: c.product_name }, job_order: { id: c.jobId, number: c.job_order_number, product_name: c.product_name } }; cached = true;
      }
      var ctx = { unit: d.unit, jo: d.job_order, role: role, owner: owner, cached: cached };
      if (!ctx.unit || ctx.unit.id !== unitId) throw new Error('Unit not found.');
      if (params.issue) return detail(view, ctx, Number(params.issue), saved);
      if (params.draft) {
        var s = saved.find(function (r) { return r.operation.draftId === params.draft; });
        if (!s) { list(view, ctx, saved); return; }
        if (s.operation.state === 'draft') form(view, ctx, s);
        else if (s.operation.state === 'new') send(ctx, s).then(function () { progress(view, ctx, s); }).catch(function (err) { error(err); progress(view, ctx, s); });
        else progress(view, ctx, s);
        return;
      }
      if (params.step === 'new' && canReport()) { start(ctx); return; }
      list(view, ctx, saved);
    }).catch(function (err) { if (render !== renderSerial || location.hash !== hash) return; view.innerHTML = ''; view.appendChild(R.error(err, function () { open(view, params); })); });
  }
  async function inspectionEvidence(unitId) {
    var reports = await API.get('/production-issues?unit_id=' + unitId);
    var photos = await Promise.all(reports.map(function (i) { return API.get('/attachments?kind=production_issue&ref_id=' + i.id); }));
    return photos.flat().filter(function (p) { return p.inspection_available; }).map(function (p) { return p.id; });
  }
  window.mUnitIssues = { open: open, inspectionEvidence: inspectionEvidence };
  MApp.route('unit-issues', function (view, params) { open(view, params || {}); });
})();
