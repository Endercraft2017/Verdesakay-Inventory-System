/* Employee reporting — Figma V2 nodes 46:721, 46:750 and 46:779.
   Identified reports use private tracked cases. Anonymous reports use the
   separate identity-free /api/anonymous-reports channel (src/core/confidential-reports.ts)
   — never authenticated messages or software bug reports, and never the offline queue. */
(function () {
  var CATEGORIES = ['Workplace concern', 'Harassment or misconduct', 'Safety risk', 'Payroll or attendance', 'Equipment or facility', 'Stock or operations', 'System support', 'Other'];
  var DESTINATIONS = [
    { value: 'hr', label: 'HR Department', match: /\b(hr|human resources|admin)\b/i },
    { value: 'management', label: 'Management', match: /manager|management|administrator/i },
    { value: 'safety', label: 'Safety', match: /safety|operations/i },
    { value: 'superior', label: 'My superior', match: /supervisor|lead|manager/i },
    { value: 'support', label: 'System support', match: /it|system|support/i }
  ];
  var DRAFT_KEY = 'vds_identified_report_draft';
  var ANON_DRAFT_KEY = 'vds_anonymous_report_draft';
  function draftKey(key) { return key === DRAFT_KEY ? key + ':' + String((MApp.getMe() || {}).id || 'guest') : key; }
  function draftStore() { return API.isSharedSession() ? sessionStorage : localStorage; }

  function shell(view, node, heading, subheading, back) {
    view.setAttribute('data-figma-node', node);
    view.innerHTML = '<section class="m-v2-page m-report-v2"><header class="m-v2-heading m-report-heading">' +
      (back ? '<button class="m-report-back" type="button" aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(subheading) + '</p></div></header><div id="m-report-body"></div></section>';
    if (back) view.querySelector('.m-report-back').onclick = back;
    return view.querySelector('#m-report-body');
  }

  function loadDraft(key) {
    try { return JSON.parse(draftStore().getItem(draftKey(key)) || '{}'); } catch (e) { return {}; }
  }

  function hub(view) {
    var ctx = reportContext();
    MApp.setTitle('Help & reporting');
    var host = shell(view, '46:721', 'Help & reporting', 'Choose the correct protected channel');
    host.innerHTML =
      '<article class="m-report-choice identified"><h2>Report with follow-up</h2>' +
        '<p>Send to HR, management, safety, your superior, or system support. Your identity allows replies and follow-up.</p>' +
        '<button class="m-v2-primary" id="m-report-known" type="button">Start report</button></article>' +
      '<article class="m-report-choice anonymous"><h2>Anonymous report</h2>' +
        '<p>A separate protected channel. Your signed-in identity must never be attached to this report.</p>' +
        '<button class="m-v2-secondary" id="m-report-anon" type="button">Continue privately</button></article>' +
      '<button class="m-report-row" id="m-report-mine" type="button"><span><b>My identified reports</b><small>Track status and follow up</small></span><i aria-hidden="true">›</i></button>' +
      '<button class="m-report-row" id="m-report-assigned" type="button"><span><b>Reports to handle</b><small>Cases sent or assigned to you</small></span><i aria-hidden="true">›</i></button>' +
      '<button class="m-report-row" id="m-report-guide" type="button"><span><b>Reporting guidance</b><small>Emergencies require immediate procedures</small></span><i aria-hidden="true">›</i></button>' +
      '<div id="m-report-sent"></div>';
    ctx.active = { kind: 'hub', host: host }; armReport(ctx);
    if (hasReportDraft(ctx)) {
      host.querySelector('#m-report-known').textContent = ctx.saved ? 'Continue saved report' : 'Continue report';
      var hint = mEl('<p class="m-report-draft-state">' + (!ctx.saved ? 'Draft storage is unavailable. Your text and evidence are available only in this open app.' : ctx.files.length ? 'Your text draft and evidence are available in this open app.' : 'Text draft available. Evidence files need reattaching after reopening.') + '</p>');
      host.querySelector('.identified').appendChild(hint);
    }
    host.querySelector('#m-report-known').onclick = function () { MApp.go('report-problem', { mode: 'identified' }); };
    host.querySelector('#m-report-anon').onclick = function () { anonymousRoute('anonymous'); };
    host.querySelector('#m-report-mine').onclick = function () { MApp.go('report-problem', { mode: 'mine' }); };
    host.querySelector('#m-report-assigned').onclick = function () { MApp.go('report-problem', { mode: 'assigned' }); };
    host.querySelector('#m-report-guide').onclick = function () { guidance(view); };

    var countPending = false, target = host.querySelector('#m-report-sent');
    async function loadCount() {
      if (countPending || !host.isConnected || !currentReport(ctx)) return;
      countPending = true; target.innerHTML = '<p class="m-report-count" role="status">Loading your report count…</p>';
      try {
        var rows = await API.get('/identified-reports'); if (!host.isConnected || !currentReport(ctx)) return;
        var reports = (rows || []).filter(function (row) { return String(row.reporter_id) === ctx.account; });
        target.innerHTML = '<p class="m-report-count">' + reports.length + ' identified report' + (reports.length === 1 ? '' : 's') + ' sent</p>';
      } catch (error) {
        if (host.isConnected && currentReport(ctx)) { target.innerHTML = '<p class="m-hint" role="status">Your report count is unavailable.</p><button class="m-v2-secondary" type="button" data-retry-count>Retry report count</button>'; target.querySelector('button').onclick = loadCount; }
      } finally { countPending = false; }
    }
    loadCount();
  }

  function selectOptions(values, current) {
    return values.map(function (value) {
      var v = typeof value === 'string' ? value : value.value;
      var label = typeof value === 'string' ? value : value.label;
      return '<option value="' + mEsc(v) + '"' + (v === current ? ' selected' : '') + '>' + mEsc(label) + '</option>';
    }).join('');
  }

  // Files stay in memory, never JSON/localStorage. A new account/sign-in gets a fresh context.
  var identifiedSession = null;
  function reportContext() {
    var account = String((MApp.getMe() || {}).id || 'guest'), token = API.getToken?.() || '', shared = API.isSharedSession();
    if (!identifiedSession || identifiedSession.account !== account || identifiedSession.token !== token || identifiedSession.shared !== shared) {
      var data = loadDraft(DRAFT_KEY); if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      identifiedSession = { account: account, token: token, shared: shared, data: data, files: [], missingEvidence: Number(data.evidence_count) || 0, version: 0, pending: null, preparing: false, active: null, cases: Object.create(null), restored: !!(data.subject || data.description || data.recipient_id || data.evidence_count), saved: !!(data.subject || data.description || data.recipient_id || data.evidence_count) };
    }
    return identifiedSession;
  }
  function currentReport(ctx) { return String((MApp.getMe() || {}).id || 'guest') === ctx.account && (API.getToken?.() || '') === ctx.token && API.isSharedSession() === ctx.shared; }
  function hasReportDraft(ctx) { return !!(ctx.data.subject || ctx.data.description || ctx.data.recipient_id || ctx.data.location || ctx.data.date || ctx.data.time || ctx.files.length || ctx.missingEvidence); }
  function reportText(ctx) {
    var data = {}; ['destination', 'recipient_id', 'category', 'subject', 'description', 'date', 'time', 'location'].forEach(function (key) { data[key] = ctx.data[key] || ''; });
    data.evidence_count = ctx.files.length || ctx.missingEvidence; return JSON.stringify(data);
  }
  function persistReport(ctx) {
    ctx.version++;
    try { draftStore().setItem(DRAFT_KEY + ':' + ctx.account, reportText(ctx)); ctx.saved = true; }
    catch (error) { ctx.saved = false; }
    return ctx.saved;
  }
  function armReport(ctx) {
    // Route changes retain the live draft/files; unloading needs a warning for memory-only work.
    mPersonalDraft.arm(function () { return false; }, function () { return ctx.preparing || !!ctx.pending || Object.keys(ctx.cases).some(function (id) { return !!ctx.cases[id].pending; }); }, { busyText: function () { return ctx.preparing ? 'Please wait for evidence preparation to finish.' : ctx.pending ? 'Please wait for report sending to finish.' : 'Please wait for the report update to finish.'; } });
  }
  window.addEventListener('beforeunload', function (event) {
    var ctx = identifiedSession;
    if (ctx && currentReport(ctx) && (ctx.pending || ctx.preparing || ctx.files.length || (!ctx.saved && hasReportDraft(ctx)) || Object.keys(ctx.cases).some(function (id) { return ctx.cases[id].pending || ctx.cases[id].reply; }))) { event.preventDefault(); event.returnValue = ''; }
  });

  function identified(view, initial) {
    var ctx = reportContext();
    if (initial) { ctx.data = { ...ctx.data, ...initial }; ctx.review = null; persistReport(ctx); }
    var draft = ctx.data;
    MApp.setTitle('Report an issue');
    var host = shell(view, '46:750', 'Report an issue', 'Your identity supports follow-up', function () { MApp.go('report-problem'); });
    ctx.active = { kind: 'form', host: host }; armReport(ctx);
    host.innerHTML =
      '<p class="m-report-notice" data-draft-restored' + (ctx.restored || ctx.missingEvidence ? '' : ' hidden') + '>Text draft restored. Evidence files are kept only while this app stays open.' + (ctx.missingEvidence && !ctx.files.length ? ' Reattach your previous evidence if it is still needed.' : '') + '</p>' +
      '<form class="m-report-form" novalidate>' +
        '<label><span>Destination *</span><select data-field="destination">' + selectOptions(DESTINATIONS, draft.destination || 'hr') + '</select></label>' +
        '<label><span>Recipient *</span><select data-field="recipient" required disabled><option value="">Loading authorized staff…</option></select></label><div data-recipient-feedback aria-live="polite"></div>' +
        '<label><span>Category *</span><select data-field="category">' + selectOptions(CATEGORIES, draft.category || CATEGORIES[0]) + '</select></label>' +
        '<label><span>Subject *</span><input data-field="subject" maxlength="140" required value="' + mEsc(draft.subject || '') + '" placeholder="Enter a clear subject"></label>' +
        '<label class="is-tall"><span>Description *</span><textarea data-field="description" maxlength="3000" rows="4" required placeholder="Describe what happened">' + mEsc(draft.description || '') + '</textarea></label>' +
        '<div class="m-report-context-grid"><label><span>Incident date</span><input data-field="date" type="date" value="' + mEsc(draft.date || '') + '"></label>' +
        '<label><span>Time</span><input data-field="time" type="time" value="' + mEsc(draft.time || '') + '"></label></div>' +
        '<label><span>Location</span><input data-field="location" maxlength="160" value="' + mEsc(draft.location || '') + '" placeholder="Optional work location"></label>' +
        '<label class="m-report-files"><span>Evidence</span><input data-files type="file" multiple accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx"><small>Up to 4 files, 5 MB each. Images may be resized before review. Choosing files replaces the current selection. Remove personal details you do not want shared.</small></label><div data-evidence-list></div>' +
        '<p class="m-error" data-report-error role="alert" tabindex="-1" hidden></p><p class="m-report-draft-state" data-draft-status role="status"></p>' +
        '<button class="m-v2-primary" type="submit">Review report</button></form>';
    var form = host.querySelector('form'), recipient = form.querySelector('[data-field="recipient"]'), destination = form.querySelector('[data-field="destination"]');
    var users = [], loadingUsers = false, directoryReady = false, desiredRecipient = String(draft.recipient_id || '');
    var submit = form.querySelector('[type="submit"]'), evidence = form.querySelector('[data-files]'), feedback = form.querySelector('[data-report-error]');
    function alive() { return host.isConnected && currentReport(ctx); }
    function fail(message, field) { feedback.textContent = message; feedback.hidden = false; if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } else feedback.focus(); }
    function collect() {
      var data = {}; form.querySelectorAll('[data-field]').forEach(function (field) { data[field.dataset.field] = field.value.trim(); });
      data.recipient_id = recipient.value; delete data.recipient; return data;
    }
    function showDraftStatus() { form.querySelector('[data-draft-status]').textContent = ctx.saved ? (ctx.shared ? 'Text draft saved for this session.' : 'Text draft saved on this device.') + (ctx.files.length ? ' Evidence stays in memory until this app closes.' : '') : 'Draft storage is unavailable. Keep this app open to retain your text and evidence.'; }
    function save(force) {
      if (!alive() || ctx.preparing) return;
      var data = collect();
      // A delayed blur/change event may arrive after evidence preparation. Only
      // actual edits invalidate the prepared review, not an unchanged field blur.
      if (!force && Object.keys(data).every(function (key) { return data[key] === (ctx.data[key] || ''); })) return;
      ctx.data = data; ctx.review = null; persistReport(ctx); showDraftStatus();
    }
    function drawFiles() {
      form.querySelector('[data-evidence-list]').innerHTML = ctx.files.map(function (file, index) { return '<div class="m-report-file-row"><span>' + mEsc(file.name) + '<small>' + mFmtBytes(file.size) + '</small></span><button class="m-v2-secondary" type="button" data-remove-evidence="' + index + '" aria-label="Remove ' + mEsc(file.name) + '">Remove</button></div>'; }).join('');
      form.querySelectorAll('[data-remove-evidence]').forEach(function (button) { button.onclick = function () { if (!alive() || ctx.preparing || ctx.pending) return; ctx.files.splice(Number(button.dataset.removeEvidence), 1); ctx.missingEvidence = 0; evidence.value = ''; drawFiles(); save(true); }; });
    }
    function fillRecipients() {
      var selected = DESTINATIONS.find(function (d) { return d.value === destination.value; });
      var ranked = users.filter(function (user) { return selected && selected.match.test([user.role, user.department_name, user.position, user.full_name].filter(Boolean).join(' ')); });
      var fallback = !ranked.length;
      if (!ranked.length) ranked = users.filter(mUsers.isSupervisor);
      if (!ranked.length) ranked = users;
      recipient.innerHTML = '<option value="">' + (ranked.length ? 'Choose a recipient…' : 'No authorized recipient available') + '</option>' + ranked.map(function (user) { return '<option value="' + mEsc(user.id) + '">' + mEsc(user.full_name) + (user.department_name ? ' — ' + mEsc(user.department_name) : '') + '</option>'; }).join('');
      recipient.value = ranked.some(function (user) { return String(user.id) === desiredRecipient; }) ? desiredRecipient : '';
      recipient.disabled = !ranked.length;
      form.querySelector('[data-recipient-feedback]').innerHTML = '<p class="m-hint">' + (!ranked.length ? 'No recipient is available. Try loading staff again.' : fallback ? 'No department match. Choose the person who should receive this report from the available staff.' : 'Choose the person who should receive this report.') + '</p>' + (!ranked.length ? '<button class="m-v2-secondary" type="button" data-retry-recipients>Retry staff list</button>' : '');
      form.querySelector('[data-retry-recipients]')?.addEventListener('click', function () { loadRecipients(true); });
    }
    async function loadRecipients(force) {
      if (loadingUsers || !alive()) return;
      loadingUsers = true; directoryReady = false; recipient.disabled = true;
      recipient.innerHTML = '<option value="">Loading authorized staff…</option>'; form.querySelector('[data-recipient-feedback]').innerHTML = '<p class="m-hint" role="status">Loading recipients…</p>';
      try { await mUsers.load(force === true); if (!alive()) return; users = mUsers.ranked().filter(function (user) { return String(user.id) !== ctx.account && user.active !== false && user.active !== 0; }); directoryReady = true; fillRecipients(); }
      catch (error) { if (alive()) { recipient.innerHTML = '<option value="">Could not load recipients</option>'; form.querySelector('[data-recipient-feedback]').innerHTML = '<p class="m-error" role="alert">' + mEsc(error.message || 'Could not load recipients.') + '</p><button class="m-v2-secondary" type="button" data-retry-recipients>Retry staff list</button>'; form.querySelector('[data-retry-recipients]').onclick = function () { loadRecipients(true); }; } }
      finally { loadingUsers = false; }
    }
    destination.onchange = function () { desiredRecipient = ''; if (directoryReady) fillRecipients(); save(); };
    recipient.onchange = function () { desiredRecipient = recipient.value; };
    form.addEventListener('input', function (event) { event.target.removeAttribute('aria-invalid'); if (event.target !== evidence) save(); });
    form.addEventListener('change', function (event) { if (event.target !== evidence) save(); });
    evidence.onchange = function () {
      if (!alive() || ctx.preparing || ctx.pending) return;
      var files = Array.from(evidence.files || []), failure = evidenceError(files, false);
      if (failure) { evidence.value = ''; fail(failure, evidence); return; }
      ctx.files = files; ctx.missingEvidence = 0; feedback.hidden = true; host.querySelector('[data-draft-restored]').hidden = true; drawFiles(); save(true);
    };
    form.onsubmit = async function (event) {
      event.preventDefault(); if (ctx.preparing || ctx.pending) return;
      feedback.hidden = true;
      var data = collect();
      if (!directoryReady || !data.recipient_id) { fail('Choose who should receive the report. Retry loading staff if the list is unavailable.', recipient.disabled ? null : recipient); return; }
      if (!data.subject) { fail('Enter a subject.', form.querySelector('[data-field="subject"]')); return; }
      if (!data.description) { fail('Describe the concern.', form.querySelector('[data-field="description"]')); return; }
      var invalid = Array.from(form.querySelectorAll('[data-field]')).find(function (field) { return !field.checkValidity(); });
      if (invalid) { fail(invalid.validationMessage, invalid); return; }
      var failure = evidenceError(ctx.files, false); if (failure) { fail(failure, evidence); return; }
      var selected = users.find(function (user) { return String(user.id) === data.recipient_id; });
      if (!selected) { fail('Choose an available recipient.', recipient); return; }
      ctx.data = data; persistReport(ctx); ctx.preparing = true; form.inert = true; submit.disabled = true; submit.textContent = 'Preparing evidence…';
      try {
        var files = await Promise.all(ctx.files.map(function (file) { return window.ImageCompress && /^image\//.test(file.type) ? ImageCompress.maybeCompress(file, { thresholdBytes: 0, maxDim: 1600, quality: 0.8 }) : file; }));
        failure = evidenceError(files, true); if (failure) throw new Error(failure);
        if (!alive()) return;
        ctx.files = files; ctx.data = data; persistReport(ctx);
        ctx.review = { ...data, recipient_name: selected.full_name + (selected.department_name ? ' — ' + selected.department_name : ''), files: files.slice() }; ctx.sendError = null;
        ctx.preparing = false; MApp.go('report-problem', { mode: 'review' });
      } catch (error) { if (alive()) { form.inert = false; fail(error.message || 'Could not prepare evidence. Your files are still here.'); } }
      finally { ctx.preparing = false; form.inert = false; submit.disabled = false; submit.textContent = 'Review report'; }
    };
    drawFiles();
    if (hasReportDraft(ctx)) { if (!ctx.saved) persistReport(ctx); showDraftStatus(); }
    else form.querySelector('[data-draft-status]').textContent = 'Text is saved as you edit. Evidence stays only in this open app.';
    loadRecipients();
  }
  function evidenceError(files, prepared) {
    if (files.length > 4) return 'Use up to 4 evidence files. Your previous selection has been kept.';
    var allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    for (var file of files) {
      if (!allowed.includes(file.type)) return 'Use JPEG, PNG, WebP, PDF or Word documents for evidence: ' + file.name;
      if (file.size > 5 * 1024 * 1024 && (prepared || !/^image\//.test(file.type))) return 'Each evidence file must be 5 MB or less: ' + file.name;
    }
    return null;
  }

  function reviewIdentified(view) {
    var ctx = reportContext(), data = ctx.review;
    if (!data) { identified(view); return; }
    MApp.setTitle('Review report');
    var host = shell(view, '46:750', 'Review report', 'Confirm the recipient and details', function () { MApp.go('report-problem', { mode: 'identified' }); });
    var destination = DESTINATIONS.find(function (d) { return d.value === data.destination; });
    host.innerHTML = '<section class="m-report-review">' +
      '<div><span>Destination</span><b>' + mEsc(destination ? destination.label : data.destination) + '</b></div>' +
      '<div><span>Recipient</span><b>' + mEsc(data.recipient_name) + '</b></div>' +
      '<div><span>Category</span><b>' + mEsc(data.category) + '</b></div>' +
      '<div><span>Subject</span><b>' + mEsc(data.subject) + '</b></div>' +
      '<div><span>Description</span><b>' + mEsc(data.description) + '</b></div>' +
      '<div><span>Incident context</span><b>' + mEsc([data.date, data.time, data.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
      '<div><span>Evidence · ' + data.files.length + ' file(s)</span><b>' + (data.files.length ? data.files.map(function (file) { return mEsc(file.name) + ' · ' + mFmtBytes(file.size); }).join('<br>') : 'No evidence attached') + '</b></div></section>' +
      '<aside class="m-report-notice">Your name is visible to the recipient and assigned handler. You can track this case in My identified reports.</aside>' +
      '<p class="m-error" data-send-error role="alert" tabindex="-1" hidden></p><p class="m-hint" data-send-status role="status"></p>' +
      '<button class="m-v2-primary" id="m-report-send" type="button">Send identified report</button><button class="m-v2-secondary m-report-edit-back" type="button" data-edit-report>Back to edit</button>';
    var send = host.querySelector('#m-report-send'), feedback = host.querySelector('[data-send-error]');
    function paint() {
      if (!host.isConnected || !currentReport(ctx)) return;
      var busy = !!ctx.pending; send.disabled = busy || ctx.review !== data; send.textContent = busy ? 'Sending…' : 'Send identified report'; host.setAttribute('aria-busy', String(busy));
      host.querySelector('[data-edit-report]').disabled = busy; view.querySelector('.m-report-back').disabled = busy;
      host.querySelector('[data-send-status]').textContent = busy ? ctx.pending.status : '';
      feedback.hidden = !ctx.sendError; feedback.textContent = ctx.sendError || '';
    }
    ctx.active = { kind: 'review', host: host, paint: paint }; armReport(ctx);
    host.querySelector('[data-edit-report]').onclick = function () { MApp.go('report-problem', { mode: 'identified' }); };
    send.onclick = async function () {
      if (!host.isConnected || ctx.review !== data || ctx.pending || ctx.preparing || !currentReport(ctx)) return;
      var op = { status: 'Sending report…' }, version = ctx.version, stored = null, store = null;
      try { store = draftStore(); stored = store.getItem(DRAFT_KEY + ':' + ctx.account); } catch (error) {}
      ctx.pending = op; ctx.sendError = null; paint();
      try {
        var failure = evidenceError(data.files, true); if (failure) throw new Error(failure);
        var formData = new FormData(); formData.append('recipient_id', data.recipient_id);
        ['category', 'subject', 'description', 'location'].forEach(function (key) { formData.append(key, data[key] || ''); });
        formData.append('incident_date', data.date || ''); formData.append('incident_time', data.time || '');
        data.files.forEach(function (file) { formData.append('files', file, file.name); });
        var created = await API.upload('/identified-reports', formData, { onProgress: function (event) {
          if (ctx.pending !== op) return;
          op.status = event.total ? 'Uploading evidence · ' + Math.min(100, Math.floor(event.loaded / event.total * 100)) + '%' : 'Sending report…';
          if (currentReport(ctx) && ctx.active?.kind === 'review') ctx.active.paint();
        } });
        if (!currentReport(ctx)) return;
        if (ctx.version === version) {
          // Another tab may have saved a newer draft under the same key while this request ran.
          var newer = null;
          try {
            var latest = store && store.getItem(DRAFT_KEY + ':' + ctx.account);
            if (store && latest === stored) store.removeItem(DRAFT_KEY + ':' + ctx.account);
            else if (latest) { newer = JSON.parse(latest); if (!newer || typeof newer !== 'object' || Array.isArray(newer)) newer = null; }
          } catch (error) {}
          ctx.data = newer || {}; ctx.files = []; ctx.missingEvidence = Number(newer?.evidence_count) || 0; ctx.review = null; ctx.saved = !!newer; ctx.restored = !!newer;
        }
        ctx.receipt = { id: created.id, number: created.number };
        var show = ctx.active?.kind === 'review' && ctx.active.host.isConnected;
        ctx.pending = null;
        if (show) MApp.go('report-problem', { mode: 'sent' });
      } catch (error) {
        ctx.sendError = (error.message || 'Could not send the report.') + ' Your text and evidence are still here. If the connection was lost, check My identified reports before retrying.';
      } finally {
        ctx.pending = null;
        if (currentReport(ctx) && ctx.active?.kind === 'review' && ctx.active.host.isConnected) { ctx.active.paint(); if (ctx.sendError) ctx.active.host.querySelector('[data-send-error]').focus(); }
      }
    };
    paint();
  }
  function identifiedReceipt(view) {
    var ctx = reportContext(), receipt = ctx.receipt;
    if (!receipt) { hub(view); return; }
    MApp.setTitle('Report sent');
    var host = shell(view, '46:750', 'Report sent', 'Your report was sent for follow-up'); ctx.active = { kind: 'receipt', host: host }; armReport(ctx);
    host.innerHTML = '<div class="m-report-receipt"><span class="m-report-success-mark" aria-hidden="true">✓</span><p class="m-report-reference">' + mEsc(receipt.number) + '</p><p>Your identity was included for follow-up. Track the status and replies in My identified reports.</p></div>' +
      '<button class="m-v2-primary" type="button" data-open-report>Open report</button><button class="m-v2-secondary m-report-edit-back" type="button" data-my-reports>My identified reports</button><button class="m-v2-secondary m-report-edit-back" type="button" data-report-hub>Reporting hub</button>';
    host.querySelector('[data-open-report]').onclick = function () { MApp.go('report-problem', { id: receipt.id }); };
    host.querySelector('[data-my-reports]').onclick = function () { MApp.go('report-problem', { mode: 'mine' }); };
    host.querySelector('[data-report-hub]').onclick = function () { MApp.go('report-problem'); };
  }

  // Private in-memory UI state only. Identity is never added to anonymous payloads or drafts.
  var anonymousSession = null;
  function anonymousContext() {
    var account = String((MApp.getMe() || {}).id || 'guest'), token = API.getToken?.() || '', shared = API.isSharedSession();
    if (!anonymousSession || anonymousSession.account !== account || anonymousSession.token !== token || anonymousSession.shared !== shared) {
      if (anonymousSession) anonymousSession.records.forEach(releaseAnonymousPhotos);
      var data = loadDraft(ANON_DRAFT_KEY);
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      anonymousSession = { account: account, token: token, shared: shared, data: data, files: [], saved: !!Object.keys(data).length, missingPhotos: Number(data.photo_count) || 0, version: 0, pending: null, preparing: null, active: null, records: [], opened: null, receipt: null };
    }
    return anonymousSession;
  }
  function currentAnonymous(ctx) {
    return anonymousSession === ctx && ctx.account === String((MApp.getMe() || {}).id || 'guest') && ctx.token === (API.getToken?.() || '') && ctx.shared === API.isSharedSession();
  }
  function releaseAnonymousPhotos(record) {
    Object.keys(record.photos).forEach(function (id) { if (record.photos[id].url) URL.revokeObjectURL(record.photos[id].url); });
    record.photos = Object.create(null);
  }
  function anonymousDraftText(ctx) {
    var data = {}; ['category', 'subject', 'details', 'date', 'location'].forEach(function (key) { data[key] = ctx.data[key] || ''; });
    data.photo_count = ctx.files.length || ctx.missingPhotos; return JSON.stringify(data);
  }
  function persistAnonymous(ctx) {
    ctx.version++;
    try { draftStore().setItem(ANON_DRAFT_KEY, anonymousDraftText(ctx)); ctx.saved = true; }
    catch (error) { ctx.saved = false; }
  }
  function anonymousBusy(ctx) { return !!(ctx.pending || ctx.preparing); }
  function armAnonymous(ctx) {
    mPersonalDraft.arm(function () { return false; }, function () { return anonymousBusy(ctx) || !!(ctx.receipt && !ctx.receipt.saved && ctx.active?.kind === 'receipt'); }, { busyText: function () {
      if (ctx.receipt && !ctx.receipt.saved) return 'Save your report number and access code, then confirm that you saved them.';
      return ctx.preparing ? 'Please wait for photo preparation to finish.' : 'Please wait for the anonymous report request to finish.';
    } });
  }
  function anonymousActive(ctx, kind, host, paint) { ctx.active = { kind: kind, host: host, paint: paint }; armAnonymous(ctx); }
  function paintAnonymous(ctx) { if (currentAnonymous(ctx) && ctx.active?.host.isConnected && ctx.active.paint) ctx.active.paint(); }
  function anonymousAlive(ctx, host) { return currentAnonymous(ctx) && host.isConnected; }
  function anonymousError(host, selector, message) {
    var target = host.querySelector(selector); if (!target) return;
    target.textContent = message || ''; target.hidden = !message;
  }
  function anonymousFeedback(ctx, selector) {
    var target = currentAnonymous(ctx) && ctx.active?.host.isConnected && ctx.active.host.querySelector(selector);
    if (target) target.focus();
  }
  function anonymousRoute(mode) { MApp.go('report-problem', { mode: mode }); }
  function validAnonymousReport(report) { return report && typeof report.number === 'string' && typeof report.status === 'string' && Array.isArray(report.messages); }
  function uncertainAnonymous(message) { var error = new Error(message); error.uncertain = true; return error; }
  window.addEventListener('beforeunload', function (event) {
    var ctx = anonymousSession;
    if (ctx && currentAnonymous(ctx) && (anonymousBusy(ctx) || ctx.files.length || (!ctx.saved && (ctx.data.details || ctx.data.subject)) || (ctx.receipt && !ctx.receipt.saved) || ctx.records.some(function (record) { return record.reply || record.files.length; }))) {
      event.preventDefault(); event.returnValue = '';
    }
  });

  /* Identity-free transport for the anonymous channel. Deliberately NOT API.post/API.upload:
     those add the bearer token (and the offline queue would persist it with an idempotency
     key). Only the ticket request is authenticated; the server keeps no link between ticket
     and user. With photos it sends multipart, each already re-encoded by scrubPhoto(). */
  function anonPost(path, body, photos) {
    var init = { method: 'POST', credentials: 'omit', cache: 'no-store' };
    if (photos && photos.length) {
      var fd = new FormData();
      Object.keys(body).forEach(function (k) { if (body[k] != null) fd.append(k, body[k]); });
      photos.forEach(function (f, i) { fd.append('photos', f, 'photo-' + (i + 1) + '.jpg'); });
      init.body = fd;
    } else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(API.base() + '/api/anonymous-reports' + path, init).catch(function () {
      throw uncertainAnonymous('Could not confirm the request. The connection may have been interrupted.');
    }).then(function (res) {
      return res.json().catch(function () { throw uncertainAnonymous('Could not read the server response.'); }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
        return data;
      });
    });
  }

  /* One of your own report photos as an object URL — same identity-free transport, with the
     number + code in the POST body rather than on an image URL (history, logs). */
  function anonPhotoUrl(c, photoId) {
    return fetch(API.base() + '/api/anonymous-reports/photo', {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: c.number, access_code: c.access_code, photo_id: photoId })
    }).then(function (res) {
      if (!res.ok) throw new Error('Photo could not be loaded');
      return res.blob();
    }).then(function (blob) { return URL.createObjectURL(blob); });
  }

  /* Redraw a picked photo into a fresh JPEG on the phone, so its location/device/time
     metadata and original filename never leave it. A PDF is drawn page by page into fresh
     JPEGs the same way (PdfPages) — one photo slot per page; the PDF file itself is never
     sent. The server strips again (defense in depth). */
  var ANON_MAX_PHOTOS = 4;
  var ANON_ACCEPT = 'image/*,application/pdf';
  function scrubPhoto(file, i, room) {
    var name = function (k) { return 'photo-' + (i + k + 1) + '.jpg'; };
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
      if (!window.PdfPages) return Promise.reject(new Error('PDFs can’t be prepared on this device.'));
      return PdfPages.toJpegs(file, { maxPages: room || 1, maxDim: 1600, quality: 0.8, name: name }).then(function (r) {
        if (r.totalPages > r.files.length) {
          mToast('Only the first ' + r.files.length + ' of ' + r.totalPages + ' pages fit — photos of the rest can go in a follow-up.', 'err');
        }
        return r.files;
      });
    }
    if (!window.ImageCompress || !ImageCompress.reencode) return Promise.reject(new Error('Photos can’t be prepared on this device.'));
    return ImageCompress.reencode(file, { maxDim: 1600, quality: 0.8, name: name(0) });
  }
  var PHOTO_NOTE = 'Location, device and time details are removed on this phone before sending, and again on the server. ' +
    'A PDF is sent as a photo of each page (one photo per page), without its file details. ' +
    'What the picture or page shows is not removed — check for names, faces, name tags, screens, reflections or a spot only you use.';
  function photoCountText(n) { return n + ' photo' + (n === 1 ? '' : 's'); }

  function anonymousPicker(ctx, owner, host, slot, onChange) {
    var preparation = null;
    var picker = mPhoto.picker({
      max: slot, initial: owner.files, prepare: scrubPhoto, accept: ANON_ACCEPT,
      canEdit: function () { return anonymousAlive(ctx, host) && picker.isConnected && !anonymousBusy(ctx); },
      onBusy: function (busy) {
        if (!currentAnonymous(ctx)) return;
        if (busy) { preparation = {}; ctx.preparing = preparation; owner.photoError = ''; ctx.review = null; }
        else if (ctx.preparing === preparation) { ctx.preparing = null; preparation = null; }
        paintAnonymous(ctx);
      },
      onError: function (error) { if (currentAnonymous(ctx)) { owner.photoError = (error.message || 'Photo could not be prepared.') + ' The file was skipped. Choose it again or continue without it.'; } },
      onChange: function (files) {
        if (!currentAnonymous(ctx) || (preparation ? ctx.preparing !== preparation : !host.isConnected || ctx.pending)) return;
        owner.files = files.slice(); onChange();
      }
    });
    return picker;
  }

  function anonymous(view) {
    var ctx = anonymousContext();
    if (ctx.receipt) { anonymousReceipt(view); return; }
    MApp.setTitle('Anonymous report');
    var draft = ctx.data;
    var host = shell(view, '46:779', 'Anonymous report', 'Separate protected reporting channel', function () { MApp.go('report-problem'); });
    host.innerHTML =
      '<aside class="m-report-anon-notice"><b>Before you continue</b><span>Your name, account, device and exact time are not stored with this report. What you write can still identify you — leave out names or details only you would know if that matters to you.</span></aside>' +
      (ctx.missingPhotos && !ctx.files.length ? '<p class="m-report-notice">Text draft restored. Reattach your previous photos or PDF pages if they are still needed.</p>' : '') +
      '<form class="m-report-form m-report-anon-form" novalidate>' +
        '<label><span>Category *</span><select data-anon="category">' + selectOptions(CATEGORIES, draft.category || CATEGORIES[0]) + '</select></label>' +
        '<label><span>Short title</span><input data-anon="subject" maxlength="160" value="' + mEsc(draft.subject || '') + '" placeholder="Optional"></label>' +
        '<label class="is-tall"><span>Report details *</span><textarea data-anon="details" rows="5" maxlength="5000" placeholder="Describe the concern (at least 10 characters)">' + mEsc(draft.details || '') + '</textarea></label>' +
        '<div class="m-report-context-grid"><label><span>Incident date</span><input data-anon="date" type="date" value="' + mEsc(draft.date || '') + '"></label>' +
        '<label><span>Location</span><input data-anon="location" maxlength="160" value="' + mEsc(draft.location || '') + '" placeholder="Optional"></label></div>' +
        '<div class="m-report-files m-anon-photos"><span>Photos or PDF pages (optional, up to ' + ANON_MAX_PHOTOS + ')</span><div data-anon-photos></div>' +
          '<small>' + mEsc(PHOTO_NOTE) + ' Photos aren’t kept in the saved draft.</small></div>' +
        '<p class="m-report-draft-state" data-anon-draft role="status"></p><p class="m-report-draft-state" data-anon-preparing role="status"></p>' +
        '<p class="m-error" data-anon-error role="alert" tabindex="-1" hidden></p><p class="m-error" data-anon-photo-error role="alert" hidden></p>' +
        '<button class="m-v2-primary" type="submit">Review anonymous report</button></form>' +
      '<div class="m-anon-clear"><button class="m-v2-secondary" type="button" data-clear-draft>Clear draft</button>' +
      '<div data-clear-confirm hidden><p class="m-report-notice">Clear this anonymous text draft and the photos selected in this app?</p><button class="m-v2-secondary" type="button" data-keep-draft>Keep draft</button><button class="m-v2-secondary" type="button" data-confirm-clear>Clear text and photos</button></div></div>' +
      '<button class="m-report-row" id="m-anon-check" type="button"><span><b>Check a report I filed</b><small>Use the report number and access code</small></span><i aria-hidden="true">›</i></button>';
    var form = host.querySelector('form');
    function alive() { return anonymousAlive(ctx, host); }
    function collect() { var data = {}; form.querySelectorAll('[data-anon]').forEach(function (field) { data[field.dataset.anon] = field.value.trim(); }); return data; }
    function save() {
      if (!alive() || ctx.pending) return;
      var data = collect();
      if (Object.keys(data).every(function (key) { return data[key] === (ctx.data[key] || ''); })) return;
      ctx.data = data; ctx.review = null; persistAnonymous(ctx); paint();
    }
    function paint() {
      if (!alive()) return;
      var busy = anonymousBusy(ctx); form.inert = !!ctx.pending;
      form.querySelector('[type="submit"]').disabled = busy;
      host.querySelector('#m-anon-check').disabled = busy;
      view.querySelector('.m-report-back').disabled = busy;
      host.querySelectorAll('.m-anon-clear button').forEach(function (button) { button.disabled = busy; });
      host.querySelector('[data-anon-photos]').inert = busy;
      host.querySelector('[data-anon-draft]').textContent = ctx.saved ? (ctx.shared ? 'Text draft saved for this session.' : 'Text draft saved on this device. Clear it when you no longer need it.') + ' Photos stay only in this open app.' : 'Your draft is in this open app. Device storage is unavailable or the draft has not been saved yet.';
      host.querySelector('[data-anon-preparing]').textContent = ctx.preparing ? 'Preparing photos and removing hidden details. Please wait before reviewing.' : photoCountText(ctx.files.length) + ' prepared.';
      anonymousError(host, '[data-anon-photo-error]', ctx.photoError);
    }
    anonymousActive(ctx, 'form', host, paint);
    var picker = anonymousPicker(ctx, ctx, host, ANON_MAX_PHOTOS, function () { ctx.missingPhotos = 0; ctx.review = null; persistAnonymous(ctx); paint(); });
    host.querySelector('[data-anon-photos]').appendChild(picker);
    form.addEventListener('input', save); form.addEventListener('change', save);
    host.querySelector('[data-clear-draft]').onclick = function () { if (alive() && !anonymousBusy(ctx)) { host.querySelector('[data-clear-confirm]').hidden = false; host.querySelector('[data-keep-draft]').focus(); } };
    host.querySelector('[data-keep-draft]').onclick = function () { host.querySelector('[data-clear-confirm]').hidden = true; host.querySelector('[data-clear-draft]').focus(); };
    host.querySelector('[data-confirm-clear]').onclick = function () {
      if (!alive() || anonymousBusy(ctx)) return;
      ctx.data = {}; ctx.files = []; ctx.missingPhotos = 0; ctx.review = null; ctx.photoError = ''; ctx.saved = false; ctx.version++;
      try { draftStore().removeItem(ANON_DRAFT_KEY); ctx.saved = false; ctx.clearError = ''; }
      catch (error) { ctx.clearError = 'The open draft was cleared, but device storage could not be cleared. Try Clear draft again.'; }
      anonymous(view);
    };
    host.querySelector('#m-anon-check').onclick = function () { if (!anonymousBusy(ctx)) anonymousRoute('anonymous-lookup'); };
    form.onsubmit = function (event) {
      event.preventDefault(); if (!alive() || !form.isConnected || anonymousBusy(ctx)) return;
      var data = collect();
      if (data.details.length < 10 || !form.checkValidity()) { anonymousError(host, '[data-anon-error]', 'Describe the concern using at least 10 characters and check the highlighted fields.'); form.querySelector('[data-anon="details"]').focus(); return; }
      save(); ctx.review = { data: { ...data }, files: ctx.files.slice() }; ctx.sendError = '';
      anonymousRoute('anonymous-review');
    };
    paint(); anonymousError(host, '[data-anon-error]', ctx.clearError);
  }

  function anonymousReview(view) {
    var ctx = anonymousContext(), review = ctx.review;
    if (ctx.receipt) { anonymousReceipt(view); return; }
    if (!review) { anonymous(view); return; }
    var data = review.data, files = review.files;
    MApp.setTitle('Review anonymous report');
    var host = shell(view, '46:779', 'Review', 'Nothing is sent until you confirm', function () { anonymousRoute('anonymous'); });
    host.innerHTML =
      '<section class="m-report-review">' +
        '<div><span>Category</span><b>' + mEsc(data.category) + '</b></div>' +
        (data.subject ? '<div><span>Title</span><b>' + mEsc(data.subject) + '</b></div>' : '') +
        '<div><span>Details</span><b>' + mEsc(data.details) + '</b></div>' +
        '<div><span>Incident context</span><b>' + mEsc([data.date, data.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
        '<div><span>Photos</span><b>' + (files.length ? photoCountText(files.length) + ' · hidden details removed' : 'None') + '</b></div></section>' +
      (files.length ? '<div class="m-thumbs" id="m-anon-review-photos"></div>' : '') +
      '<aside class="m-report-anon-notice"><b>You’ll get a report number and a one-time access code</b><span>Save both — they are the only way to see replies. The code is shown once and can’t be recovered.</span></aside>' +
      '<p class="m-error" data-anon-send-error role="alert" tabindex="-1" hidden></p><p class="m-report-draft-state" data-anon-send-status role="status"></p>' +
      '<button class="m-v2-primary" id="m-anon-send" type="button">Send anonymously</button><button class="m-v2-secondary m-report-edit-back" data-anon-edit type="button">Back to edit</button>';
    files.forEach(function (file, i) {
      var url = URL.createObjectURL(file), cell = mEl('<div class="m-thumb"><img alt="Photo ' + (i + 1) + '" /></div>');
      var img = cell.querySelector('img'); img.onload = img.onerror = function () { URL.revokeObjectURL(url); }; img.src = url;
      host.querySelector('#m-anon-review-photos').appendChild(cell);
    });
    function paint() {
      if (!anonymousAlive(ctx, host)) return;
      var busy = anonymousBusy(ctx);
      host.querySelector('#m-anon-send').disabled = busy || ctx.review !== review;
      host.querySelector('#m-anon-send').textContent = ctx.pending ? 'Sending securely…' : 'Send anonymously';
      host.querySelector('[data-anon-edit]').disabled = busy; view.querySelector('.m-report-back').disabled = busy;
      host.querySelector('[data-anon-send-status]').textContent = ctx.pending?.phase || '';
      anonymousError(host, '[data-anon-send-error]', ctx.sendError);
    }
    anonymousActive(ctx, 'review', host, paint);
    host.querySelector('[data-anon-edit]').onclick = function () { anonymousRoute('anonymous'); };
    host.querySelector('#m-anon-send').onclick = async function () {
      if (!anonymousAlive(ctx, host) || ctx.review !== review || anonymousBusy(ctx)) return;
      if (navigator.onLine === false) { ctx.sendError = 'You’re offline. Sending has not started. Your text and prepared photos are still here.'; paint(); anonymousFeedback(ctx, '[data-anon-send-error]'); return; }
      var op = { kind: 'send', phase: 'Starting secure sending…' }, version = ctx.version, store = null, stored = null, submitted = false;
      try { store = draftStore(); stored = store.getItem(ANON_DRAFT_KEY); } catch (error) {}
      ctx.pending = op; ctx.sendError = ''; paint();
      try {
        var ticket = await API.post('/anonymous-reports/ticket');
        if (!currentAnonymous(ctx)) return;
        op.phase = 'Sending report and prepared photos…'; paintAnonymous(ctx); submitted = true;
        var result = await anonPost('', { ticket: ticket.ticket, category: data.category, subject: data.subject || null, description: data.details, incident_date: data.date || null, location: data.location || null }, files);
        if (!currentAnonymous(ctx)) return;
        if (!result || typeof result.number !== 'string' || !result.number || typeof result.access_code !== 'string' || !result.access_code) throw uncertainAnonymous('The response did not contain a report number and access code.');
        if (ctx.version === version) {
          var newer = null;
          try { var latest = store && store.getItem(ANON_DRAFT_KEY); if (store && latest === stored) store.removeItem(ANON_DRAFT_KEY); else if (latest) { newer = JSON.parse(latest); if (!newer || typeof newer !== 'object' || Array.isArray(newer)) newer = null; } } catch (error) {}
          ctx.data = newer || {}; ctx.files = []; ctx.missingPhotos = Number(newer?.photo_count) || 0; ctx.saved = !!newer; ctx.review = null;
        }
        ctx.receipt = { number: result.number, access_code: result.access_code, saved: false, copying: false, feedback: '' };
        var activeReview = ctx.active?.kind === 'review' && ctx.active.host.isConnected;
        ctx.pending = null;
        if (activeReview) anonymousRoute('anonymous-sent');
      } catch (error) {
        if (currentAnonymous(ctx)) ctx.sendError = submitted && (error.uncertain || error.status >= 500) ? 'Could not confirm sending. The report may have been received, but its access code was not returned. Your text and photos are still here. Sending again may create another report.' : (error.message || 'Could not send the report.') + ' Your text and prepared photos are still here.';
      } finally {
        if (ctx.pending === op) ctx.pending = null;
        if (currentAnonymous(ctx) && ctx.active?.kind === 'review') { paintAnonymous(ctx); if (ctx.sendError) anonymousFeedback(ctx, '[data-anon-send-error]'); }
      }
    };
    paint();
  }

  function anonymousReceipt(view) {
    var ctx = anonymousContext(), receipt = ctx.receipt;
    if (!receipt) { anonymous(view); return; }
    MApp.setTitle('Report received');
    var host = shell(view, '46:779', 'Report received', 'Save these now — they are shown only once');
    host.innerHTML = '<section class="m-anon-receipt"><div><span>Report number</span><b>' + mEsc(receipt.number) + '</b></div><div><span>Access code</span><b class="m-anon-code">' + mEsc(receipt.access_code) + '</b></div></section>' +
      '<aside class="m-report-anon-notice"><b>Anyone with this code can read the replies</b><span>Write it down or keep it somewhere private. It isn’t stored on this device and can’t be recovered.</span></aside>' +
      '<button class="m-v2-primary" id="m-anon-copy" type="button">Copy number and code</button><p class="m-report-draft-state" data-copy-status role="status"></p>' +
      '<label class="m-anon-saved-code"><input type="checkbox" data-saved-code' + (receipt.saved ? ' checked' : '') + '><span>I saved my number and code somewhere private.</span></label>' +
      '<button class="m-v2-secondary" id="m-anon-done" type="button">Done</button>';
    function paint() {
      if (!anonymousAlive(ctx, host)) return;
      host.querySelector('#m-anon-copy').disabled = receipt.copying;
      host.querySelector('#m-anon-copy').textContent = receipt.copying ? 'Copying…' : 'Copy number and code';
      host.querySelector('[data-copy-status]').textContent = receipt.feedback;
      host.querySelector('#m-anon-done').disabled = !receipt.saved;
    }
    anonymousActive(ctx, 'receipt', host, paint);
    host.querySelector('[data-saved-code]').onchange = function () { if (anonymousAlive(ctx, host)) { receipt.saved = this.checked; paint(); } };
    host.querySelector('#m-anon-copy').onclick = async function () {
      if (!anonymousAlive(ctx, host) || receipt.copying) return;
      receipt.copying = true; receipt.feedback = ''; paint();
      try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText('Report ' + receipt.number + ' · code ' + receipt.access_code); receipt.feedback = 'Number and code copied. Keep them somewhere private, then confirm that you saved them.'; }
      catch (error) { receipt.feedback = 'Copy isn’t available. Write down both the number and code before continuing.'; }
      finally { receipt.copying = false; if (ctx.receipt === receipt) paintAnonymous(ctx); }
    };
    host.querySelector('#m-anon-done').onclick = function () { if (!anonymousAlive(ctx, host) || !receipt.saved) return; ctx.receipt = null; MApp.go('report-problem'); };
    paint();
  }

  function anonymousLookup(view) {
    var ctx = anonymousContext();
    if (ctx.receipt && !ctx.receipt.saved) { anonymousReceipt(view); return; }
    MApp.setTitle('Check a report');
    var host = shell(view, '46:779', 'Check a report', 'Status and replies from the case handler', function () { anonymousRoute('anonymous'); });
    host.innerHTML = '<form class="m-report-form" id="m-anon-lookup" novalidate><label><span>Report number *</span><input data-k="number" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CR-00001"></label>' +
      '<label><span>Access code *</span><span class="m-anon-code-field"><input type="password" data-k="code" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"><button class="m-v2-secondary" type="button" data-show-code aria-pressed="false">Show</button></span></label>' +
      '<p class="m-error" data-lookup-error role="alert" tabindex="-1" hidden></p><p class="m-report-draft-state" data-lookup-status role="status"></p><button class="m-v2-primary" type="submit">Open report</button></form>' +
      '<button class="m-v2-secondary" type="button" data-change-report hidden>Change report</button><div id="m-anon-result"></div>';
    var form = host.querySelector('form'), out = host.querySelector('#m-anon-result');
    var number = form.querySelector('[data-k="number"]'), code = form.querySelector('[data-k="code"]');
    function alive() { return anonymousAlive(ctx, host); }
    function selected() { return ctx.opened; }
    function paintControls() {
      if (!alive()) return;
      var record = selected(), busy = anonymousBusy(ctx);
      if (record) { number.value = record.credentials.number; code.value = record.credentials.access_code; }
      number.disabled = code.disabled = busy || !!record;
      form.querySelector('[type="submit"]').disabled = busy;
      form.querySelector('[type="submit"]').textContent = ctx.pending?.kind === 'lookup' ? 'Checking…' : record ? 'Check report status' : 'Open report';
      host.querySelector('[data-change-report]').hidden = !record; host.querySelector('[data-change-report]').disabled = busy;
      view.querySelector('.m-report-back').disabled = busy;
      host.querySelector('[data-lookup-status]').textContent = record ? 'Viewing ' + record.credentials.number + '. Your access code stays only in this open app.' : 'Use your saved number and code. They are not saved on this device.';
      var reply = out.querySelector('#m-anon-reply');
      if (reply) {
        reply.inert = !!ctx.pending;
        reply.querySelector('[type="submit"]').disabled = busy || !record.reply.trim() || record.files.length > Number(record.report.photos_remaining || 0);
        reply.querySelector('[type="submit"]').textContent = ctx.pending?.kind === 'reply' ? 'Sending…' : 'Send';
        reply.querySelectorAll('[data-anon-photos]').forEach(function (el) { el.inert = busy; });
        anonymousError(reply, '[data-reply-error]', record.error);
        anonymousError(reply, '[data-reply-photo-error]', record.photoError);
        reply.querySelector('[data-reply-status]').textContent = ctx.preparing ? 'Preparing photos and removing hidden details…' : ctx.pending?.kind === 'reply' ? 'Sending your reply…' : record.feedback || '';
      }
      out.querySelectorAll('[data-remove-photo]').forEach(function (button) { button.disabled = busy; });
    }
    function paint() { if (alive()) { renderResult(); paintControls(); } }
    anonymousActive(ctx, 'lookup', host, paint);
    host.querySelector('[data-show-code]').onclick = function () { code.type = code.type === 'password' ? 'text' : 'password'; this.textContent = code.type === 'password' ? 'Show' : 'Hide'; this.setAttribute('aria-pressed', String(code.type !== 'password')); };
    host.querySelector('[data-change-report]').onclick = function () { if (!alive() || anonymousBusy(ctx)) return; ctx.opened = null; number.value = code.value = ''; code.type = 'password'; host.querySelector('[data-show-code]').textContent = 'Show'; host.querySelector('[data-show-code]').setAttribute('aria-pressed', 'false'); anonymousError(host, '[data-lookup-error]', ''); renderResult(); paintControls(); number.focus(); };
    async function loadReport(credentials) {
      if (!alive() || anonymousBusy(ctx)) return;
      var op = { kind: 'lookup' }; ctx.pending = op; anonymousError(host, '[data-lookup-error]', ''); paintControls();
      try {
        var report = await anonPost('/lookup', credentials);
        if (!currentAnonymous(ctx)) return;
        if (!validAnonymousReport(report)) throw new Error('Could not read the report response. Try checking again.');
        var record = ctx.records.filter(function (item) { return item.credentials.number === credentials.number && item.credentials.access_code === credentials.access_code; })[0];
        if (!record) { record = { credentials: { ...credentials }, report: report, reply: '', files: [], photos: Object.create(null), version: 0, error: '', photoError: '', feedback: '' }; ctx.records.push(record); }
        record.report = report; record.feedback = 'Status refreshed. Your unsent message is unchanged.';
        ctx.opened = record;
        if (alive()) { number.value = record.credentials.number; code.value = record.credentials.access_code; code.type = 'password'; host.querySelector('[data-show-code]').textContent = 'Show'; host.querySelector('[data-show-code]').setAttribute('aria-pressed', 'false'); }
      } catch (error) { if (alive()) anonymousError(host, '[data-lookup-error]', error.message || 'Could not check the report. Your draft is still here.'); }
      finally { if (ctx.pending === op) ctx.pending = null; paintAnonymous(ctx); if (alive() && !host.querySelector('[data-lookup-error]').hidden) anonymousFeedback(ctx, '[data-lookup-error]'); }
    }
    form.onsubmit = function (event) {
      event.preventDefault(); if (!alive() || !form.isConnected || anonymousBusy(ctx)) return;
      var record = selected(), credentials = record ? record.credentials : { number: number.value.trim(), access_code: code.value.trim() };
      if (!credentials.number || !credentials.access_code) { anonymousError(host, '[data-lookup-error]', 'Enter the report number and access code.'); (credentials.number ? code : number).focus(); return; }
      loadReport(credentials);
    };
    function renderResult() {
      var record = selected();
      if (!record) { out.innerHTML = ''; return; }
      var report = record.report;
      var allPhotos = (report.photos || []).concat(...report.messages.map(function (message) { return message.photos || []; }));
      // Credentials are captured when this case is opened, never taken from edited lookup fields.
      out.innerHTML = '<section class="m-report-review"><div><span>' + mEsc(report.number) + ' · ' + mEsc(report.category) + '</span><b>' + mEsc(report.subject || 'Anonymous report') + '</b></div><div><span>Status</span><b class="m-anon-status ' + mEsc(report.status) + '">' + mEsc(report.status) + '</b></div><div><span>Filed · last update</span><b>' + mEsc(report.created_on) + ' · ' + mEsc(report.updated_on) + '</b></div>' +
        (report.photo_count ? '<div><span>Photos sent with the report</span><b>' + photoCountText(report.photo_count) + '</b></div>' : '') + '</section>' +
        (report.photo_count ? '<div class="m-thumbs" data-anon-own="report"></div>' : '') +
        (allPhotos.length ? '<p class="m-hint">You can remove your own photos until the case handler opens them. Photos already seen by a handler cannot be removed.</p>' : '<p class="m-hint">No photos attached.</p>') +
        '<div class="m-anon-thread">' + (report.messages.length ? report.messages.map(function (message) { return '<div class="m-anon-msg ' + mEsc(message.author) + '"><small>' + (message.author === 'handler' ? 'Case handler' : 'You') + ' · ' + mEsc(message.created_on) + (message.photo_count ? ' · ' + photoCountText(message.photo_count) : '') + '</small><p>' + mEsc(message.body) + '</p>' + (message.photo_count ? '<div class="m-thumbs" data-anon-own="' + mEsc(message.id) + '"></div>' : '') + '</div>'; }).join('') : '<div class="m-empty">No replies yet.</div>') + '</div>' +
        (report.status === 'closed' ? '<p class="m-report-notice">This report is closed. New replies are unavailable.' + (record.reply || record.files.length ? ' Your unsent message and photos remain in this open app for when the report is reopened.' : '') + '</p>' :
          '<form class="m-report-form" id="m-anon-reply" novalidate><label class="is-tall"><span>Add information</span><textarea rows="3" maxlength="3000" placeholder="Answer a question or add details">' + mEsc(record.reply) + '</textarea></label><p class="m-hint">Your unsent message and photos stay in this open app. Closing or reloading removes them.</p>' +
          (report.photos_remaining || record.files.length ? '<div class="m-report-files m-anon-photos"><span>Photos or PDF pages (optional)</span><div data-anon-photos></div><small>' + mEsc(PHOTO_NOTE) + '</small></div>' : '<p class="m-hint">This report has no photo slots remaining.</p>') +
          (record.files.length > Number(report.photos_remaining || 0) ? '<p class="m-error">Only ' + Number(report.photos_remaining || 0) + ' photo slots remain. Remove extra selected photos before sending.</p>' : '') +
          '<p class="m-error" data-reply-error role="alert" tabindex="-1" hidden></p><p class="m-error" data-reply-photo-error role="alert" hidden></p><p class="m-report-draft-state" data-reply-status role="status" tabindex="-1"></p><button class="m-v2-primary" type="submit">Send</button></form>');
      function fillOwn(key, list) {
        var strip = out.querySelector('[data-anon-own="' + key + '"]'); if (!strip) return;
        (list || []).forEach(function (photo, index) {
          var job = record.photos[photo.id] || (record.photos[photo.id] = {});
          var cell = mEl('<div class="m-anon-photo-cell"><button class="m-thumb m-anon-photo-open" type="button" aria-label="Open photo ' + (index + 1) + '"><img alt="Photo ' + (index + 1) + '"></button><div data-photo-feedback></div>' + (photo.removable ? '<button class="m-v2-secondary" type="button" data-remove-photo>Remove photo</button>' : '') + '</div>');
          var button = cell.querySelector('.m-anon-photo-open');
          function updatePhoto() {
            if (!anonymousAlive(ctx, host) || selected() !== record || !cell.isConnected) return;
            var img = button.querySelector('img'); img.hidden = !job.url;
            if (job.url && img.getAttribute('src') !== job.url) img.src = job.url;
            else if (!job.url) img.removeAttribute('src');
            button.disabled = !job.url;
            var feedback = cell.querySelector('[data-photo-feedback]');
            feedback.innerHTML = job.error ? '<p class="m-error" role="alert">' + mEsc(job.error) + '</p><button class="m-v2-secondary" type="button">Retry photo</button>' : job.pending ? '<span class="m-hint" role="status">Loading photo…</span>' : '';
            var retry = feedback.querySelector('button'); if (retry) retry.onclick = loadPhoto;
          }
          async function loadPhoto() {
            if (!alive() || selected() !== record || job.pending) return;
            job.pending = true; job.error = ''; updatePhoto();
            try { var url = await anonPhotoUrl(record.credentials, photo.id); if (!currentAnonymous(ctx) || !record.report.photos?.concat(...record.report.messages.map(function (message) { return message.photos || []; })).some(function (item) { return item.id === photo.id; })) { URL.revokeObjectURL(url); return; } job.url = url; }
            catch (error) { if (currentAnonymous(ctx)) job.error = 'Photo could not be loaded.'; }
            finally { job.pending = false; if (job.update) job.update(); }
          }
          job.update = updatePhoto;
          button.querySelector('img').onerror = function () { if (!alive() || !cell.isConnected) return; if (job.url) URL.revokeObjectURL(job.url); job.url = null; job.error = 'Photo could not be displayed.'; updatePhoto(); };
          button.onclick = function () { if (alive() && cell.isConnected && job.url) { if (window.PhotoViewer) PhotoViewer.open(job.url, 'Report photo'); else mPhoto.view(job.url); } };
          var remove = cell.querySelector('[data-remove-photo]');
          if (remove) remove.onclick = async function () {
            if (!alive() || !cell.isConnected || anonymousBusy(ctx)) return;
            if (!window.confirm('Remove this photo from your report? This can’t be undone.')) return;
            var op = { kind: 'remove' }; ctx.pending = op; record.error = ''; paintControls();
            try { var updated = await anonPost('/photo/remove', { ...record.credentials, photo_id: photo.id }); if (!currentAnonymous(ctx)) return; if (!validAnonymousReport(updated)) throw uncertainAnonymous('Could not read the removal response. Refresh the status before retrying.'); record.report = updated; if (job.url) URL.revokeObjectURL(job.url); delete record.photos[photo.id]; record.feedback = 'Photo removed.'; }
            catch (error) { if (currentAnonymous(ctx)) record.error = (error.message || 'Could not remove the photo.') + ' Your reply draft is still here.'; }
            finally { if (ctx.pending === op) ctx.pending = null; paintAnonymous(ctx); }
          };
          strip.appendChild(cell); updatePhoto(); if (!job.url && !job.error && !job.pending) loadPhoto();
        });
      }
      fillOwn('report', report.photos);
      report.messages.forEach(function (message) { fillOwn(message.id, message.photos); });
      var reply = out.querySelector('#m-anon-reply');
      if (!reply) return;
      var pickerHost = reply.querySelector('[data-anon-photos]');
      if (pickerHost) pickerHost.appendChild(anonymousPicker(ctx, record, host, Math.max(record.files.length, Math.min(ANON_MAX_PHOTOS, Number(report.photos_remaining) || 0)), function () { record.version++; paintControls(); }));
      reply.querySelector('textarea').oninput = function () { record.reply = this.value; record.version++; paintControls(); };
      reply.onsubmit = async function (event) {
        event.preventDefault(); if (!alive() || !reply.isConnected || selected() !== record || anonymousBusy(ctx) || record.report.status === 'closed') return;
        var body = reply.querySelector('textarea').value.trim();
        if (!body || body.length > 3000 || record.files.length > Number(record.report.photos_remaining || 0)) { record.error = 'Write a message and check the remaining photo slots.'; paintControls(); anonymousFeedback(ctx, '[data-reply-error]'); return; }
        record.reply = reply.querySelector('textarea').value;
        var version = record.version, files = record.files.slice(), op = { kind: 'reply' };
        ctx.pending = op; record.error = ''; record.feedback = ''; paintControls();
        try {
          var updated = await anonPost('/followup', { ...record.credentials, body: body }, files);
          if (!currentAnonymous(ctx)) return;
          if (!validAnonymousReport(updated)) throw uncertainAnonymous('Could not read the reply response.');
          record.report = updated; if (record.version === version) { record.reply = ''; record.files = []; } record.feedback = 'Reply sent.';
        } catch (error) { if (currentAnonymous(ctx)) record.error = error.uncertain || error.status >= 500 ? 'Could not confirm sending. Your message and photos are still here. Check the conversation before retrying; your reply may already have been received.' : (error.message || 'Could not send your reply.') + ' Your message and photos are still here.'; }
        finally { if (ctx.pending === op) ctx.pending = null; paintAnonymous(ctx); if (currentAnonymous(ctx) && ctx.opened === record) anonymousFeedback(ctx, record.error ? '[data-reply-error]' : '[data-reply-status]'); }
      };
    }
    var record = selected(); if (record) { number.value = record.credentials.number; code.value = record.credentials.access_code; }
    renderResult(); paintControls();
  }

  function identifiedList(view, assigned) {
    var ctx = reportContext();
    MApp.setTitle(assigned ? 'Reports to handle' : 'My identified reports');
    var host = shell(view, '46:721', assigned ? 'Reports to handle' : 'My identified reports', assigned ? 'Cases sent or assigned to you' : 'Reports sent with your identity', function () { MApp.go('report-problem'); });
    ctx.active = { kind: 'list', host: host }; armReport(ctx);
    var loading = false;
    async function load() {
      if (loading || !host.isConnected || !currentReport(ctx)) return;
      var restoreFocus = host.contains(document.activeElement);
      loading = true; host.setAttribute('aria-busy', 'true'); host.innerHTML = '<div class="m-hint" role="status">Loading reports…</div>';
      try {
        var rows = await API.get('/identified-reports'); if (!host.isConnected || !currentReport(ctx)) return;
        var reports = (rows || []).filter(function (row) { return assigned ? String(row.reporter_id) !== ctx.account : String(row.reporter_id) === ctx.account; });
        if (!reports.length) { host.innerHTML = '<div class="m-empty">' + (assigned ? 'No reports to handle yet.' : 'No reports here yet.') + '</div>'; return; }
        host.innerHTML = reports.map(function (row) {
          var status = String(row.status || 'new'), label = status.charAt(0).toUpperCase() + status.slice(1);
          return '<button class="m-report-row" type="button" data-report="' + mEsc(row.id) + '"><span><b>' + mEsc(row.number + ' · ' + row.subject) + '</b><small>' + mEsc((assigned ? 'Reporter · ' + (row.reporter_name || 'Former staff') : 'Recipient · ' + row.recipient_name)) + '</small>' + (assigned ? '<small>' + mEsc('Handler · ' + (row.assignee_name || row.recipient_name || 'Not assigned')) + '</small>' : '') + '<span class="m-report-status">' + mEsc(label) + '</span></span><i aria-hidden="true">›</i></button>';
        }).join('');
        host.querySelectorAll('[data-report]').forEach(function (button) { button.onclick = function () { MApp.go('report-problem', { id: button.dataset.report, from: assigned ? 'assigned' : 'mine' }); }; });
      } catch (error) {
        if (host.isConnected && currentReport(ctx)) { host.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load reports.') + '</div><button class="m-v2-secondary" type="button" data-retry-reports>Retry reports</button>'; host.querySelector('button').onclick = load; }
      } finally { loading = false; host.removeAttribute('aria-busy'); if (restoreFocus && host.isConnected) { host.tabIndex = -1; (host.querySelector('button') || host).focus(); } }
    }
    load();
  }

  // Follow-up drafts remain private to this account/sign-in and this open app.
  function identifiedDetail(view, id, origin) {
    var ctx = reportContext(), key = String(id);
    var state = ctx.cases[key] || (ctx.cases[key] = { reply: '', status: '', assignee: '', pending: null, revision: 0, errors: {}, downloads: Object.create(null) });
    var from = origin === 'assigned' ? 'assigned' : origin === 'mine' ? 'mine' : null;
    MApp.setTitle('Identified report');
    var host = shell(view, '46:721', 'Identified report', 'Status and follow-up', function () { MApp.go('report-problem', { mode: from || 'mine' }); });
    host.classList.add('m-report-case');
    ctx.active = { kind: 'detail', id: key, host: host, paint: render }; armReport(ctx);
    var loading = false, directoryLoading = false, directoryReady = false, users = [], directoryError = '';
    function alive() { return host.isConnected && currentReport(ctx); }
    function paint() { var active = ctx.active; if (currentReport(ctx) && active && active.kind === 'detail' && active.id === key && active.host.isConnected) active.paint(); }
    function label(value) { value = String(value || 'new'); return value.charAt(0).toUpperCase() + value.slice(1); }
    function errorBlock(action) { return '<p class="m-error" data-case-error="' + action + '" role="alert" tabindex="-1"' + (state.errors[action] ? '' : ' hidden') + '>' + mEsc(state.errors[action] || '') + '</p>'; }

    function directory() {
      var form = host.querySelector('#m-ir-assign'); if (!form) return;
      var select = form.querySelector('select'), feedback = form.querySelector('[data-directory-feedback]');
      var eligible = users.filter(function (user) { return String(user.id) !== String(state.report.reporter_id) && user.active !== 0 && user.active !== false; });
      if (directoryReady && !directoryLoading && !eligible.some(function (user) { return String(user.id) === state.assignee; })) state.assignee = '';
      select.innerHTML = '<option value="">' + (directoryLoading ? 'Loading staff…' : !directoryReady ? 'Directory unavailable' : 'Choose a handler') + '</option>' + eligible.map(function (user) { return '<option value="' + mEsc(user.id) + '"' + (String(user.id) === state.assignee ? ' selected' : '') + '>' + mEsc(user.full_name) + '</option>'; }).join('');
      select.disabled = !!state.pending || !directoryReady || directoryLoading;
      feedback.innerHTML = directoryError || (directoryReady && !eligible.length) ? '<p class="m-hint" role="status">' + mEsc(directoryError || 'No eligible handler is available.') + '</p><button class="m-v2-secondary" type="button" data-retry-directory>Retry staff directory</button>' : '';
      var retry = feedback.querySelector('button'); if (retry) { retry.disabled = !!state.pending; retry.onclick = function () { loadDirectory(true); }; }
      select.onchange = function () { state.assignee = select.value; controls(); };
      controls();
    }
    async function loadDirectory(force) {
      if (directoryLoading || !alive() || state.pending) return;
      var restoreFocus = force && host.contains(document.activeElement);
      directoryLoading = true; directoryError = ''; directory();
      try { await mUsers.load(force); if (!alive()) return; users = mUsers.ranked(); directoryReady = true; }
      catch (error) { if (!alive()) return; directoryReady = false; directoryError = 'Staff directory unavailable. Your reply draft is still here.'; }
      finally { directoryLoading = false; if (alive()) { directory(); if (restoreFocus) { var target = host.querySelector(directoryReady && users.length ? '#m-ir-assign select' : '[data-retry-directory]'); if (target) target.focus(); } } }
    }
    function paintEvidence() {
      var active = ctx.active; if (!currentReport(ctx) || !active || active.kind !== 'detail' || active.id !== key || !active.host.isConnected) return;
      active.host.querySelectorAll('[data-evidence]').forEach(function (button) {
        var a = (state.report.attachments || []).filter(function (item) { return String(item.id) === button.dataset.evidence; })[0]; if (!a) return;
        var job = state.downloads[a.id] || {}; button.disabled = !!job.pending; button.textContent = (job.pending ? 'Downloading… ' : '') + a.original_name;
        var error = button.parentNode.querySelector('.m-error'); if (error) error.remove();
        if (job.error) { error = document.createElement('p'); error.className = 'm-error'; error.setAttribute('role', 'alert'); error.textContent = job.error + ' Select the file to retry.'; button.parentNode.appendChild(error); }
      });
    }
    function controls() {
      var r = state.report; if (!r) return;
      var status = host.querySelector('#m-ir-status'), assign = host.querySelector('#m-ir-assign'), reply = host.querySelector('#m-ir-reply');
      host.setAttribute('aria-busy', state.pending ? 'true' : 'false');
      var back = view.querySelector('.m-report-back'); if (back) back.disabled = !!state.pending;
      if (status) { status.querySelector('[type="submit"]').textContent = state.pending === 'status' ? 'Updating status…' : 'Update status'; status.querySelector('select').disabled = !!state.pending; status.querySelector('[type="submit"]').disabled = !!state.pending || state.status === r.status; status.querySelector('[data-close-warning]').hidden = state.status !== 'closed' || r.status === 'closed'; }
      if (assign) { assign.querySelector('[type="submit"]').textContent = state.pending === 'assign' ? 'Assigning handler…' : 'Assign handler'; assign.querySelector('[type="submit"]').disabled = !!state.pending || !directoryReady || directoryLoading || !state.assignee || state.assignee === String(r.assignee_id || r.recipient_id); }
      if (reply) { reply.querySelector('[type="submit"]').textContent = state.pending === 'reply' ? 'Sending reply…' : 'Send reply'; reply.querySelector('textarea').disabled = !!state.pending; reply.querySelector('[type="submit"]').disabled = !!state.pending || !state.reply.trim(); }
    }
    async function mutate(action, payload) {
      var r = state.report;
      if (!alive() || state.pending || !r || (action !== 'reply' && !r.can_handle) || (action === 'reply' && r.status === 'closed')) return;
      var sent = state.reply; state.pending = action; state.errors[action] = ''; state.feedback = ''; state.revision++; paint();
      try {
        var updated = await API.post('/identified-reports/' + encodeURIComponent(key) + '/' + action, payload);
        if (!currentReport(ctx)) return;
        // Write endpoints return the full case without can_handle. Match the server's handler rule.
        updated.can_handle = String(updated.recipient_id) === ctx.account || String(updated.assignee_id) === ctx.account;
        state.report = updated; state.status = updated.status; if (action === 'assign') state.assignee = '';
        if (action === 'reply' && state.reply === sent) state.reply = '';
        state.feedback = action === 'reply' ? 'Reply sent.' : action === 'assign' ? 'Handler updated.' : 'Status updated.';
      } catch (error) {
        if (currentReport(ctx)) state.errors[action] = (error.message || 'The update could not be confirmed.') + (action === 'reply' ? ' Your draft is still here. Check History before retrying if the connection was interrupted.' : ' Your selection and reply draft are still here.');
      } finally {
        state.pending = null; state.revision++; paint();
        var active = ctx.active; if (currentReport(ctx) && active && active.kind === 'detail' && active.id === key && active.host.isConnected) { var target = active.host.querySelector('[data-case-error="' + action + '"]:not([hidden])') || active.host.querySelector('[data-case-feedback]'); if (target) target.focus(); }
      }
    }
    function render() {
      if (!alive() || !state.report) return;
      var r = state.report, canHandle = r.can_handle === true;
      if (!from) from = String(r.reporter_id) === ctx.account ? 'mine' : 'assigned';
      if (!state.status) state.status = r.status;
      host.innerHTML = '<section class="m-report-review"><div><span>Reference</span><b>' + mEsc(r.number) + '</b></div>' +
        '<div><span>Status</span><b>' + mEsc(label(r.status)) + '</b></div><div><span>Subject</span><b>' + mEsc(r.subject) + '</b></div>' +
        '<div><span>Category</span><b>' + mEsc(r.category) + '</b></div><div><span>Description</span><b>' + mEsc(r.description) + '</b></div>' +
        '<div><span>Incident</span><b>' + mEsc([r.incident_date, r.incident_time, r.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
        '<div><span>Handler</span><b>' + mEsc(r.assignee_name || r.recipient_name || 'Not assigned') + '</b></div></section>' +
        '<h2 class="m-report-section-title">Evidence</h2><div class="m-report-evidence">' + ((r.attachments || []).length ? r.attachments.map(function (a) {
          var job = state.downloads[a.id] || {};
          return '<div class="m-report-evidence-item"><button class="m-v2-secondary" type="button" data-evidence="' + mEsc(a.id) + '"' + (job.pending ? ' disabled' : '') + '>' + mEsc((job.pending ? 'Downloading… ' : '') + a.original_name) + '</button>' + (job.error ? '<p class="m-error" role="alert">' + mEsc(job.error) + ' Select the file to retry.</p>' : '') + '</div>';
        }).join('') : '<p class="m-hint">No evidence attached.</p>') + '</div>' +
        '<h2 class="m-report-section-title">History</h2><div class="m-report-timeline">' + ((r.events || []).length ? r.events.map(function (event) {
          return '<article><small>' + mEsc(event.created_at + ' · ' + (event.actor_name || 'Former staff') + ' · ' + label(event.kind)) + '</small><p>' + mEsc(event.body || '') + '</p></article>';
        }).join('') : '<p class="m-hint">No history entries yet.</p>') + '</div>' +
        '<p class="m-report-draft-state" data-case-feedback role="status" tabindex="-1">' + mEsc(state.pending ? state.pending === 'reply' ? 'Sending reply…' : state.pending === 'status' ? 'Updating status…' : 'Assigning handler…' : state.feedback || '') + '</p>' +
        (canHandle ? '<form class="m-report-form m-report-case-form" id="m-ir-status"><h2 class="m-report-section-title">Update status</h2><p class="m-hint">Current status · ' + mEsc(label(r.status)) + '</p><label><span>Status</span><select>' + selectOptions(['new', 'triaged', 'investigating', 'resolved', 'closed'].map(function (s) { return { value: s, label: label(s) }; }), state.status) + '</select></label><p class="m-report-notice" data-close-warning hidden>Closing stops new replies. Your unsent message remains a draft in this open app.</p>' + errorBlock('status') + '<button class="m-v2-secondary" type="submit">Update status</button></form>' +
          '<form class="m-report-form m-report-case-form" id="m-ir-assign"><h2 class="m-report-section-title">Assign handler</h2><p class="m-hint">Current handler · ' + mEsc(r.assignee_name || r.recipient_name || 'Not assigned') + '</p><label><span>New handler</span><select disabled><option value="">Loading staff…</option></select></label><div data-directory-feedback></div>' + errorBlock('assign') + '<button class="m-v2-secondary" type="submit">Assign handler</button></form>' : '') +
        (r.status !== 'closed' ? '<form class="m-report-form m-report-case-form" id="m-ir-reply"><h2 class="m-report-section-title">Follow-up message</h2><label><span>Message</span><textarea rows="3" maxlength="3000" required>' + mEsc(state.reply) + '</textarea></label><p class="m-hint">Your unsent message stays in this open app. It is not saved after closing or reloading.</p>' + errorBlock('reply') + '<button class="m-v2-primary" type="submit">Send reply</button></form>' : '<p class="m-report-notice">This report is closed. New replies are unavailable.' + (state.reply ? ' Your unsent message is retained in this open app for when the report is reopened.' : '') + '</p>');
      host.querySelectorAll('[data-evidence]').forEach(function (button) {
        button.onclick = async function () {
          if (!alive() || !button.isConnected) return;
          var a = (state.report.attachments || []).filter(function (item) { return String(item.id) === button.dataset.evidence; })[0]; if (!a) return;
          if (String(a.mime_type).indexOf('image/') === 0) { mPhoto.view(a.url); return; }
          var job = state.downloads[a.id] || (state.downloads[a.id] = {}); if (job.pending) return;
          job.pending = true; job.error = ''; paintEvidence();
          try { await API.download(a.url, a.original_name); }
          catch (error) { if (currentReport(ctx)) job.error = error.message || 'Evidence could not be downloaded.'; }
          finally { job.pending = false; paintEvidence(); }
        };
      });
      var status = host.querySelector('#m-ir-status');
      if (status) { status.querySelector('select').onchange = function () { state.status = this.value; controls(); }; status.onsubmit = function (event) { event.preventDefault(); if (status.isConnected && state.status !== state.report.status) mutate('status', { status: state.status }); }; }
      var assign = host.querySelector('#m-ir-assign');
      if (assign) assign.onsubmit = function (event) { event.preventDefault(); if (assign.isConnected && directoryReady && !directoryLoading && state.assignee && state.assignee !== String(state.report.assignee_id || state.report.recipient_id) && users.some(function (user) { return String(user.id) === state.assignee && String(user.id) !== String(state.report.reporter_id) && user.active !== 0 && user.active !== false; })) mutate('assign', { user_id: Number(state.assignee) }); };
      var reply = host.querySelector('#m-ir-reply');
      if (reply) { reply.querySelector('textarea').oninput = function () { state.reply = this.value; controls(); }; reply.onsubmit = function (event) { event.preventDefault(); if (!reply.isConnected) return; var body = reply.querySelector('textarea').value.trim(); if (body && body.length <= 3000) { state.reply = reply.querySelector('textarea').value; mutate('reply', { body: body }); } }; }
      directory(); controls();
      if (canHandle && !state.pending && !directoryReady && !directoryLoading && !directoryError) loadDirectory(false);
    }
    async function load() {
      if (loading || !alive()) return;
      var restoreFocus = host.contains(document.activeElement);
      loading = true; var revision = state.revision;
      host.innerHTML = '<div class="m-hint" role="status">Loading report…</div>';
      try {
        var report = await API.get('/identified-reports/' + encodeURIComponent(key)); if (!alive()) return;
        if (revision === state.revision) { var previous = state.report; state.report = report; if (!state.status || (previous && state.status === previous.status)) state.status = report.status; }
        render();
      } catch (error) {
        if (alive()) { host.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load this report.') + '</div><button class="m-v2-secondary" type="button" data-retry-case>Retry report</button>'; host.querySelector('button').onclick = load; }
      } finally { loading = false; if (restoreFocus && alive()) { host.tabIndex = -1; (host.querySelector('[data-retry-case]') || host).focus(); } }
    }
    load();
  }

  function guidance(view) {
    MApp.setTitle('Reporting guidance');
    var host = shell(view, '46:721', 'Reporting guidance', 'Choose the safest response for the situation', function () { hub(view); });
    host.innerHTML =
      '<article class="m-report-guide"><h2>Immediate danger or emergency</h2><p>Move to safety and contact the designated on-site responder or emergency services first. Do not wait for an in-app report.</p></article>' +
      '<article class="m-report-guide"><h2>Need a reply or formal follow-up</h2><p>Use an identified report. Track its status and replies under My identified reports.</p></article>' +
      '<article class="m-report-guide"><h2>Identity-sensitive concern</h2><p>Use the anonymous channel. You get a report number and a one-time access code to read replies; nothing about your account is stored with it.</p></article>';
  }

  MApp.route('report-problem', function (view, params) {
    if (params && params.id) { identifiedDetail(view, params.id, params.from); return; }
    if (params && params.mode === 'mine') { identifiedList(view); return; }
    if (params && params.mode === 'assigned') { identifiedList(view, true); return; }
    if (params && params.mode === 'review') { reviewIdentified(view); return; }
    if (params && params.mode === 'sent') { identifiedReceipt(view); return; }
    if (params && params.mode === 'identified') { identified(view, params.about ? { subject: params.about } : null); return; }
    if (params && params.mode === 'anonymous-review') { anonymousReview(view); return; }
    if (params && params.mode === 'anonymous-sent') { anonymousReceipt(view); return; }
    if (params && params.mode === 'anonymous-lookup') { anonymousLookup(view); return; }
    if (params && params.mode === 'anonymous') { anonymous(view); return; }
    hub(view);
  });
  MApp.route('anonymous-report', function (view, params) {
    if (params && params.check) { anonymousLookup(view); return; }
    anonymous(view);
  });
})();
