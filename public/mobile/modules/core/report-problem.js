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

  function saveDraft(key, data) {
    try { draftStore().setItem(draftKey(key), JSON.stringify(data)); } catch (e) {}
  }
  function loadDraft(key) {
    try { return JSON.parse(draftStore().getItem(draftKey(key)) || '{}'); } catch (e) { return {}; }
  }
  function clearDraft(key) {
    try { draftStore().removeItem(draftKey(key)); } catch (e) {}
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
    host.querySelector('#m-report-anon').onclick = function () { anonymous(view); };
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
      identifiedSession = { account: account, token: token, shared: shared, data: data, files: [], missingEvidence: Number(data.evidence_count) || 0, version: 0, pending: null, preparing: false, active: null, restored: !!(data.subject || data.description || data.recipient_id || data.evidence_count), saved: !!(data.subject || data.description || data.recipient_id || data.evidence_count) };
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
    mPersonalDraft.arm(function () { return false; }, function () { return ctx.preparing || !!ctx.pending; }, { busyText: function () { return ctx.preparing ? 'Please wait for evidence preparation to finish.' : 'Please wait for report sending to finish.'; } });
  }
  window.addEventListener('beforeunload', function (event) {
    var ctx = identifiedSession;
    if (ctx && currentReport(ctx) && (ctx.pending || ctx.preparing || ctx.files.length || (!ctx.saved && hasReportDraft(ctx)))) { event.preventDefault(); event.returnValue = ''; }
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
      var e = new Error('You’re offline. Nothing was sent — your draft is still on this device.'); e.offline = true; throw e;
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
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
  var anonPhotos = []; // in memory only — never in the localStorage draft
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

  function anonymous(view) {
    MApp.setTitle('Anonymous report');
    var draft = loadDraft(ANON_DRAFT_KEY);
    var host = shell(view, '46:779', 'Anonymous report', 'Separate protected reporting channel', function () { hub(view); });
    host.innerHTML =
      '<aside class="m-report-anon-notice"><b>Before you continue</b><span>Your name, account, device and exact time are not stored with this report. What you write can still identify you — leave out names or details only you would know if that matters to you.</span></aside>' +
      '<form class="m-report-form m-report-anon-form" novalidate>' +
        '<label><span>Category *</span><select data-anon="category">' + selectOptions(CATEGORIES, draft.category || CATEGORIES[0]) + '</select></label>' +
        '<label><span>Short title</span><input data-anon="subject" maxlength="160" value="' + mEsc(draft.subject || '') + '" placeholder="Optional"></label>' +
        '<label class="is-tall"><span>Report details *</span><textarea data-anon="details" rows="5" maxlength="5000" placeholder="Describe the concern (at least 10 characters)">' + mEsc(draft.details || '') + '</textarea></label>' +
        '<div class="m-report-context-grid"><label><span>Incident date</span><input data-anon="date" type="date" value="' + mEsc(draft.date || '') + '"></label>' +
        '<label><span>Location</span><input data-anon="location" maxlength="160" value="' + mEsc(draft.location || '') + '" placeholder="Optional"></label></div>' +
        '<div class="m-report-files m-anon-photos"><span>Photos or PDF pages (optional, up to ' + ANON_MAX_PHOTOS + ')</span><div data-anon-photos></div>' +
          '<small>' + mEsc(PHOTO_NOTE) + ' Photos aren’t kept in the saved draft.</small></div>' +
        '<button class="m-v2-primary" type="submit">Review anonymous report</button></form>' +
      '<button class="m-report-row" id="m-anon-check" type="button"><span><b>Check a report I filed</b><small>Use the report number and access code</small></span><i aria-hidden="true">›</i></button>';
    var form = host.querySelector('form');
    form.querySelector('[data-anon-photos]').appendChild(mPhoto.picker({
      max: ANON_MAX_PHOTOS, initial: anonPhotos, prepare: scrubPhoto, accept: ANON_ACCEPT,
      onChange: function (files) { anonPhotos = files.slice(); }
    }));
    function state() {
      var s = {};
      Array.prototype.forEach.call(form.querySelectorAll('[data-anon]'), function (field) { s[field.getAttribute('data-anon')] = String(field.value || '').trim(); });
      return s;
    }
    form.addEventListener('input', function () { saveDraft(ANON_DRAFT_KEY, state()); });
    host.querySelector('#m-anon-check').onclick = function () { anonymousLookup(view); };
    form.onsubmit = function (event) {
      event.preventDefault();
      var data = state();
      if (data.details.length < 10) { mToast('Describe the concern (at least 10 characters)', 'err'); form.querySelector('[data-anon="details"]').focus(); return; }
      anonymousReview(view, data);
    };
  }

  function anonymousReview(view, data) {
    MApp.setTitle('Review anonymous report');
    var host = shell(view, '46:779', 'Review', 'Nothing is sent until you confirm', function () { anonymous(view); });
    host.innerHTML =
      '<section class="m-report-review">' +
        '<div><span>Category</span><b>' + mEsc(data.category) + '</b></div>' +
        (data.subject ? '<div><span>Title</span><b>' + mEsc(data.subject) + '</b></div>' : '') +
        '<div><span>Details</span><b>' + mEsc(data.details) + '</b></div>' +
        '<div><span>Incident context</span><b>' + mEsc([data.date, data.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
        '<div><span>Photos</span><b>' + (anonPhotos.length ? photoCountText(anonPhotos.length) + ' · hidden details removed' : 'None') + '</b></div>' +
      '</section>' +
      (anonPhotos.length ? '<div class="m-thumbs" id="m-anon-review-photos"></div>' : '') +
      '<aside class="m-report-anon-notice"><b>You’ll get a report number and a one-time access code</b><span>Save both — they are the only way to see replies. The code is shown once and can’t be recovered.</span></aside>' +
      '<button class="m-v2-primary" id="m-anon-send" type="button">Send anonymously</button>';
    var reviewPhotos = host.querySelector('#m-anon-review-photos');
    anonPhotos.forEach(function (f, i) {
      var url = URL.createObjectURL(f);
      var cell = mEl('<div class="m-thumb"><img alt="Photo ' + (i + 1) + '" /></div>');
      cell.querySelector('img').onload = function () { URL.revokeObjectURL(url); };
      cell.querySelector('img').src = url;
      reviewPhotos.appendChild(cell);
    });
    var button = host.querySelector('#m-anon-send');
    button.onclick = function () {
      if (navigator.onLine === false) { mToast('You’re offline. Nothing was sent — your draft is still on this device.', 'err'); return; }
      button.disabled = true;
      button.textContent = 'Sending securely…';
      API.post('/anonymous-reports/ticket').then(function (t) {
        return anonPost('', {
          ticket: t.ticket, category: data.category, subject: data.subject || null, description: data.details,
          incident_date: data.date || null, location: data.location || null
        }, anonPhotos);
      }).then(function (res) {
        clearDraft(ANON_DRAFT_KEY);
        anonPhotos = [];
        anonymousReceipt(view, res);
      }).catch(function (error) {
        mToast(error.offline ? 'You’re offline. Nothing was sent — your draft is still on this device.' : (error.message || 'Could not send the report'), 'err');
        button.disabled = false;
        button.textContent = 'Send anonymously';
      });
    };
  }

  function anonymousReceipt(view, res) {
    MApp.setTitle('Report received');
    var host = shell(view, '46:779', 'Report received', 'Save these now — they are shown only once');
    host.innerHTML =
      '<section class="m-anon-receipt">' +
        '<div><span>Report number</span><b>' + mEsc(res.number) + '</b></div>' +
        '<div><span>Access code</span><b class="m-anon-code">' + mEsc(res.access_code) + '</b></div>' +
      '</section>' +
      '<aside class="m-report-anon-notice"><b>Anyone with this code can read the replies</b><span>Write it down or keep it somewhere private. It isn’t stored on this device and can’t be recovered.</span></aside>' +
      '<div class="m-anon-actions"><button class="m-v2-primary" id="m-anon-copy" type="button">Copy number and code</button>' +
      '<button class="m-v2-secondary" id="m-anon-done" type="button">Done</button></div>';
    host.querySelector('#m-anon-copy').onclick = function () {
      var text = 'Report ' + res.number + ' · code ' + res.access_code;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
        .then(function () { mToast('Copied'); }, function () { mToast('Copy isn’t available — write it down', 'err'); });
    };
    host.querySelector('#m-anon-done').onclick = function () { hub(view); };
  }

  function anonymousLookup(view) {
    MApp.setTitle('Check a report');
    var host = shell(view, '46:779', 'Check a report', 'Status and replies from the case handler', function () { anonymous(view); });
    host.innerHTML =
      '<form class="m-report-form" novalidate>' +
        '<label><span>Report number *</span><input data-k="number" autocomplete="off" placeholder="CR-00001"></label>' +
        '<label><span>Access code *</span><input data-k="code" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"></label>' +
        '<button class="m-v2-primary" type="submit">Open report</button></form><div id="m-anon-result"></div>';
    var form = host.querySelector('form');
    var out = host.querySelector('#m-anon-result');
    function creds() {
      return { number: form.querySelector('[data-k="number"]').value.trim(), access_code: form.querySelector('[data-k="code"]').value.trim() };
    }
    var photoUrls = []; // object URLs for this screen's thumbnails, revoked on each re-render
    function show(report) {
      var c = creds();
      photoUrls.forEach(function (u) { URL.revokeObjectURL(u); });
      photoUrls = [];
      var allOwn = (report.photos || []).slice();
      report.messages.forEach(function (m) { allOwn = allOwn.concat(m.photos || []); });
      var anyRemovable = allOwn.some(function (p) { return p.removable; });
      out.innerHTML =
        '<section class="m-report-review"><div><span>' + mEsc(report.number) + ' · ' + mEsc(report.category) + '</span><b>' + mEsc(report.subject || 'Anonymous report') + '</b></div>' +
        '<div><span>Status</span><b class="m-anon-status ' + mEsc(report.status) + '">' + mEsc(report.status) + '</b></div>' +
        '<div><span>Filed · last update</span><b>' + mEsc(report.created_on) + ' · ' + mEsc(report.updated_on) + '</b></div>' +
        (report.photo_count ? '<div><span>Photos sent with the report</span><b>' + photoCountText(report.photo_count) + '</b></div>' : '') + '</section>' +
        (report.photo_count ? '<div class="m-thumbs" data-anon-own="report"></div>' : '') +
        (anyRemovable ? '<p class="m-hint">You can remove a photo until the case handler opens it.</p>' : '') +
        '<div class="m-anon-thread">' + (report.messages.length ? report.messages.map(function (m) {
          return '<div class="m-anon-msg ' + mEsc(m.author) + '"><small>' + (m.author === 'handler' ? 'Case handler' : 'You') + ' · ' + mEsc(m.created_on) +
            (m.photo_count ? ' · ' + photoCountText(m.photo_count) : '') + '</small><p>' + mEsc(m.body) + '</p>' +
            (m.photo_count ? '<div class="m-thumbs" data-anon-own="' + m.id + '"></div>' : '') + '</div>';
        }).join('') : '<div class="m-empty">No replies yet.</div>') + '</div>' +
        (report.status === 'closed' ? '<div class="m-hint">This report is closed.</div>'
          : '<form class="m-report-form" id="m-anon-reply" novalidate><label class="is-tall"><span>Add information</span><textarea rows="3" maxlength="3000" placeholder="Answer a question or add details"></textarea></label>' +
            (report.photos_remaining ? '<div class="m-report-files m-anon-photos"><span>Photos or PDF pages (optional)</span><div data-anon-photos></div><small>' + mEsc(PHOTO_NOTE) + '</small></div>' : '') +
            '<button class="m-v2-primary" type="submit">Send</button></form>');
      // Your own photos: fetched with number + code in the POST body (never an image URL).
      function fillOwn(key, list) {
        var strip = out.querySelector('[data-anon-own="' + key + '"]');
        if (!strip) return;
        (list || []).forEach(function (p, i) {
          var cell = mEl('<div class="m-thumb"><button class="m-anon-photo-open" type="button" aria-label="Open photo ' + (i + 1) + '"><img alt="" /></button></div>');
          anonPhotoUrl(c, p.id).then(function (u) {
            photoUrls.push(u);
            cell.querySelector('img').src = u;
            cell.querySelector('button').onclick = function () { mPhoto.view(u); };
          }).catch(function () { cell.title = 'Photo could not be loaded'; });
          if (p.removable) {
            var x = mEl('<button class="m-thumb-x" type="button" aria-label="Remove photo ' + (i + 1) + '">×</button>');
            x.onclick = function () {
              if (!window.confirm('Remove this photo from your report? This can’t be undone.')) return;
              x.disabled = true;
              anonPost('/photo/remove', { number: c.number, access_code: c.access_code, photo_id: p.id })
                .then(function (updated) { mToast('Photo removed'); show(updated); })
                .catch(function (error) { mToast(error.message, 'err'); x.disabled = false; });
            };
            cell.appendChild(x);
          }
          strip.appendChild(cell);
        });
      }
      fillOwn('report', report.photos);
      report.messages.forEach(function (m) { fillOwn(m.id, m.photos); });
      var reply = out.querySelector('#m-anon-reply');
      var replyPhotos = reply && reply.querySelector('[data-anon-photos]')
        ? reply.querySelector('[data-anon-photos]').appendChild(mPhoto.picker({ max: Math.min(ANON_MAX_PHOTOS, report.photos_remaining), prepare: scrubPhoto, accept: ANON_ACCEPT }))
        : null;
      if (reply) reply.onsubmit = function (event) {
        event.preventDefault();
        var text = reply.querySelector('textarea').value.trim();
        if (!text) { mToast('Write a message', 'err'); return; }
        var b = reply.querySelector('button[type="submit"]'); b.disabled = true;
        anonPost('/followup', { number: c.number, access_code: c.access_code, body: text }, replyPhotos ? replyPhotos.files() : [])
          .then(show)
          .catch(function (error) { mToast(error.message, 'err'); b.disabled = false; });
      };
    }
    form.onsubmit = function (event) {
      event.preventDefault();
      var c = creds();
      if (!c.number || !c.access_code) { mToast('Enter the report number and access code', 'err'); return; }
      var b = form.querySelector('button'); b.disabled = true;
      out.innerHTML = '<div class="m-hint">Checking…</div>';
      anonPost('/lookup', c).then(show).catch(function (error) {
        out.innerHTML = '<div class="m-error">' + mEsc(error.message) + '</div>';
      }).then(function () { b.disabled = false; });
    };
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
          return '<button class="m-report-row" type="button" data-report="' + mEsc(row.id) + '"><span><b>' + mEsc(row.number + ' · ' + row.subject) + '</b><small>' + mEsc((assigned ? 'Reporter · ' + row.reporter_name : 'Recipient · ' + row.recipient_name)) + '</small><span class="m-report-status">' + mEsc(label) + '</span></span><i aria-hidden="true">›</i></button>';
        }).join('');
        host.querySelectorAll('[data-report]').forEach(function (button) { button.onclick = function () { MApp.go('report-problem', { id: button.dataset.report }); }; });
      } catch (error) {
        if (host.isConnected && currentReport(ctx)) { host.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load reports.') + '</div><button class="m-v2-secondary" type="button" data-retry-reports>Retry reports</button>'; host.querySelector('button').onclick = load; }
      } finally { loading = false; host.removeAttribute('aria-busy'); if (restoreFocus && host.isConnected) { host.tabIndex = -1; (host.querySelector('button') || host).focus(); } }
    }
    load();
  }

  function identifiedDetail(view, id) {
    MApp.setTitle('Identified report');
    var host = shell(view, '46:721', 'Identified report', 'Status and follow-up', function () { identifiedList(view); });
    host.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/identified-reports/' + id).then(function (r) {
      var canHandle = r.can_handle === true;
      host.innerHTML = '<section class="m-report-review"><div><span>Reference</span><b>' + mEsc(r.number) + '</b></div>' +
        '<div><span>Status</span><b>' + mEsc(r.status) + '</b></div><div><span>Subject</span><b>' + mEsc(r.subject) + '</b></div>' +
        '<div><span>Category</span><b>' + mEsc(r.category) + '</b></div><div><span>Description</span><b>' + mEsc(r.description) + '</b></div>' +
        '<div><span>Incident</span><b>' + mEsc([r.incident_date, r.incident_time, r.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
        '<div><span>Handler</span><b>' + mEsc(r.assignee_name || r.recipient_name) + '</b></div></section>' +
        '<div class="m-report-evidence">' + (r.attachments || []).map(function (a) { return '<button class="m-v2-secondary" type="button" data-evidence="' + a.id + '">' + mEsc(a.original_name) + '</button>'; }).join('') + '</div>' +
        '<h2 class="m-report-section-title">History</h2><div class="m-report-timeline">' + (r.events || []).map(function (event) {
          return '<article><small>' + mEsc(event.created_at + ' · ' + (event.actor_name || 'Former staff') + ' · ' + event.kind) + '</small><p>' + mEsc(event.body || '') + '</p></article>';
        }).join('') + '</div>' +
        (canHandle ? '<form class="m-report-form" id="m-ir-status"><label><span>Status</span><select>' + ['new', 'triaged', 'investigating', 'resolved', 'closed'].map(function (s) { return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label><button class="m-v2-secondary" type="submit">Update status</button></form>' +
          '<form class="m-report-form" id="m-ir-assign"><label><span>Assign handler</span><select><option value="">Loading staff…</option></select></label><button class="m-v2-secondary" type="submit">Assign</button></form>' : '') +
        (r.status !== 'closed' ? '<form class="m-report-form" id="m-ir-reply"><label><span>Follow-up message</span><textarea rows="3" maxlength="3000" required></textarea></label><button class="m-v2-primary" type="submit">Send reply</button></form>' : '');
      Array.prototype.forEach.call(host.querySelectorAll('[data-evidence]'), function (button) {
        button.onclick = function () { var a = (r.attachments || []).filter(function (item) { return String(item.id) === button.getAttribute('data-evidence'); })[0]; if (!a) return; if (String(a.mime_type).indexOf('image/') === 0) mPhoto.view(a.url); else API.download(a.url, a.original_name).catch(function (e) { mToast(e.message, 'err'); }); };
      });
      var status = host.querySelector('#m-ir-status');
      if (status) status.onsubmit = function (event) { event.preventDefault(); API.post('/identified-reports/' + id + '/status', { status: status.querySelector('select').value }).then(function () { identifiedDetail(view, id); }).catch(function (e) { mToast(e.message, 'err'); }); };
      var assign = host.querySelector('#m-ir-assign');
      if (assign) {
        mUsers.load().then(function () { assign.querySelector('select').innerHTML = mUsers.ranked().filter(function (user) { return user.id !== r.reporter_id; }).map(function (user) { return '<option value="' + user.id + '"' + (user.id === r.assignee_id ? ' selected' : '') + '>' + mEsc(user.full_name) + '</option>'; }).join(''); }).catch(function () { assign.querySelector('select').innerHTML = '<option value="">Directory unavailable</option>'; });
        assign.onsubmit = function (event) { event.preventDefault(); var userId = assign.querySelector('select').value; if (!userId) return; API.post('/identified-reports/' + id + '/assign', { user_id: Number(userId) }).then(function () { identifiedDetail(view, id); }).catch(function (e) { mToast(e.message, 'err'); }); };
      }
      var reply = host.querySelector('#m-ir-reply');
      if (reply) reply.onsubmit = function (event) { event.preventDefault(); var body = reply.querySelector('textarea').value.trim(); if (!body) return; API.post('/identified-reports/' + id + '/reply', { body: body }).then(function () { identifiedDetail(view, id); }).catch(function (e) { mToast(e.message, 'err'); }); };
    }).catch(function (e) { host.innerHTML = '<div class="m-error">' + mEsc(e.message) + '</div>'; });
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
    if (params && params.id) { identifiedDetail(view, params.id); return; }
    if (params && params.mode === 'mine') { identifiedList(view); return; }
    if (params && params.mode === 'assigned') { identifiedList(view, true); return; }
    if (params && params.mode === 'review') { reviewIdentified(view); return; }
    if (params && params.mode === 'sent') { identifiedReceipt(view); return; }
    if (params && params.mode === 'identified') { identified(view, params.about ? { subject: params.about } : null); return; }
    if (params && params.mode === 'anonymous') { anonymous(view); return; }
    hub(view);
  });
  MApp.route('anonymous-report', function (view, params) {
    if (params && params.check) { anonymousLookup(view); return; }
    anonymous(view);
  });
})();
