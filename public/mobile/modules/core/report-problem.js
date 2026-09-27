/* Employee reporting — Figma V2 nodes 46:721, 46:750 and 46:779.
   Identified reports use the existing scoped messages API. Anonymous reports use the
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

  function shell(view, node, heading, subheading, back) {
    view.setAttribute('data-figma-node', node);
    view.innerHTML = '<section class="m-v2-page m-report-v2"><header class="m-v2-heading m-report-heading">' +
      (back ? '<button class="m-report-back" type="button" aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(subheading) + '</p></div></header><div id="m-report-body"></div></section>';
    if (back) view.querySelector('.m-report-back').onclick = back;
    return view.querySelector('#m-report-body');
  }

  function saveDraft(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
  }
  function loadDraft(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function clearDraft(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function hub(view) {
    MApp.setTitle('Help & reporting');
    var host = shell(view, '46:721', 'Help & reporting', 'Choose the correct protected channel');
    host.innerHTML =
      '<article class="m-report-choice identified"><h2>Report with follow-up</h2>' +
        '<p>Send to HR, management, safety, your superior, or system support. Your identity allows replies and follow-up.</p>' +
        '<button class="m-v2-primary" id="m-report-known" type="button">Start report</button></article>' +
      '<article class="m-report-choice anonymous"><h2>Anonymous report</h2>' +
        '<p>A separate protected channel. Your signed-in identity must never be attached to this report.</p>' +
        '<button class="m-v2-secondary" id="m-report-anon" type="button">Continue privately</button></article>' +
      '<button class="m-report-row" id="m-report-mine" type="button"><span><b>My identified reports</b><small>Review reports and continue follow-up in Inbox</small></span><i aria-hidden="true">›</i></button>' +
      '<button class="m-report-row" id="m-report-guide" type="button"><span><b>Reporting guidance</b><small>Emergencies require immediate procedures</small></span><i aria-hidden="true">›</i></button>' +
      '<div id="m-report-sent"></div>';
    host.querySelector('#m-report-known').onclick = function () { identified(view); };
    host.querySelector('#m-report-anon').onclick = function () { anonymous(view); };
    host.querySelector('#m-report-mine').onclick = function () { identifiedList(view); };
    host.querySelector('#m-report-guide').onclick = function () { guidance(view); };

    API.get('/messages?box=sent').then(function (rows) {
      var reports = (rows || []).filter(function (row) { return String(row.subject || '').indexOf('[EMPLOYEE REPORT]') === 0; });
      var target = host.querySelector('#m-report-sent');
      if (target && reports.length) target.innerHTML = '<p class="m-report-count">' + reports.length + ' identified report' + (reports.length === 1 ? '' : 's') + ' sent</p>';
    }).catch(function () {});
  }

  function selectOptions(values, current) {
    return values.map(function (value) {
      var v = typeof value === 'string' ? value : value.value;
      var label = typeof value === 'string' ? value : value.label;
      return '<option value="' + mEsc(v) + '"' + (v === current ? ' selected' : '') + '>' + mEsc(label) + '</option>';
    }).join('');
  }

  function identified(view, initial) {
    MApp.setTitle('Report an issue');
    var draft = initial || loadDraft(DRAFT_KEY);
    var host = shell(view, '46:750', 'Report an issue', 'Your identity supports follow-up', function () { hub(view); });
    host.innerHTML =
      '<form class="m-report-form">' +
        '<label><span>Destination *</span><select data-field="destination">' + selectOptions(DESTINATIONS, draft.destination || 'hr') + '</select></label>' +
        '<label><span>Recipient *</span><select data-field="recipient"><option value="">Loading authorized staff…</option></select></label>' +
        '<label><span>Category *</span><select data-field="category">' + selectOptions(CATEGORIES, draft.category || CATEGORIES[0]) + '</select></label>' +
        '<label><span>Subject *</span><input data-field="subject" maxlength="140" value="' + mEsc(draft.subject || '') + '" placeholder="Enter a clear subject"></label>' +
        '<label class="is-tall"><span>Description *</span><textarea data-field="description" maxlength="3000" rows="4" placeholder="Describe what happened">' + mEsc(draft.description || '') + '</textarea></label>' +
        '<div class="m-report-context-grid"><label><span>Incident date</span><input data-field="date" type="date" value="' + mEsc(draft.date || '') + '"></label>' +
        '<label><span>Time</span><input data-field="time" type="time" value="' + mEsc(draft.time || '') + '"></label></div>' +
        '<label><span>Location</span><input data-field="location" maxlength="160" value="' + mEsc(draft.location || '') + '" placeholder="Optional work location"></label>' +
        '<label class="m-report-files"><span>Evidence</span><input data-files type="file" multiple accept="image/*,.pdf,.doc,.docx"><small>Up to 10 files. Remove personal details you do not want shared.</small></label>' +
        '<button class="m-v2-primary" type="submit">Review report</button></form>';
    var form = host.querySelector('form');
    var recipient = form.querySelector('[data-field="recipient"]');
    var destination = form.querySelector('[data-field="destination"]');
    var users = [];

    function fillRecipients() {
      var selected = DESTINATIONS.filter(function (d) { return d.value === destination.value; })[0];
      var ranked = users.filter(function (user) {
        var haystack = [user.role, user.department_name, user.position, user.full_name].filter(Boolean).join(' ');
        return selected && selected.match.test(haystack);
      });
      if (!ranked.length) ranked = users.filter(mUsers.isSupervisor);
      if (!ranked.length) ranked = users;
      recipient.innerHTML = ranked.length ? ranked.map(function (user) {
        return '<option value="' + user.id + '"' + (String(user.id) === String(draft.recipient_id || '') ? ' selected' : '') + '>' +
          mEsc(user.full_name) + (user.department_name ? ' — ' + mEsc(user.department_name) : '') + '</option>';
      }).join('') : '<option value="">No authorized recipient available</option>';
    }

    mUsers.load().then(function () { users = mUsers.ranked(); fillRecipients(); })
      .catch(function () { recipient.innerHTML = '<option value="">Could not load recipients</option>'; });
    destination.onchange = fillRecipients;

    form.addEventListener('input', function () {
      var state = {};
      Array.prototype.forEach.call(form.querySelectorAll('[data-field]'), function (field) { state[field.getAttribute('data-field')] = field.value; });
      state.recipient_id = recipient.value;
      saveDraft(DRAFT_KEY, state);
    });

    form.onsubmit = function (event) {
      event.preventDefault();
      var data = {};
      Array.prototype.forEach.call(form.querySelectorAll('[data-field]'), function (field) { data[field.getAttribute('data-field')] = String(field.value || '').trim(); });
      data.recipient_id = recipient.value;
      if (!data.recipient_id) { mToast('Choose who should receive the report', 'err'); recipient.focus(); return; }
      if (!data.subject) { mToast('Enter a subject', 'err'); form.querySelector('[data-field="subject"]').focus(); return; }
      if (!data.description) { mToast('Describe the concern', 'err'); form.querySelector('[data-field="description"]').focus(); return; }
      data.files = form.querySelector('[data-files]').files;
      reviewIdentified(view, data, function () { identified(view, data); });
    };
  }

  function reviewIdentified(view, data, back) {
    MApp.setTitle('Review report');
    var host = shell(view, '46:750', 'Review report', 'Confirm the destination and details', back);
    var destination = DESTINATIONS.filter(function (d) { return d.value === data.destination; })[0];
    host.innerHTML =
      '<section class="m-report-review">' +
        '<div><span>Destination</span><b>' + mEsc(destination ? destination.label : data.destination) + '</b></div>' +
        '<div><span>Category</span><b>' + mEsc(data.category) + '</b></div>' +
        '<div><span>Subject</span><b>' + mEsc(data.subject) + '</b></div>' +
        '<div><span>Description</span><b>' + mEsc(data.description) + '</b></div>' +
        '<div><span>Incident context</span><b>' + mEsc([data.date, data.time, data.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
        '<div><span>Evidence</span><b>' + ((data.files && data.files.length) || 0) + ' file(s)</b></div>' +
      '</section><aside class="m-report-notice">Your name and account are included so the recipient can follow up. This sends as an internal report message.</aside>' +
      '<button class="m-v2-primary" id="m-report-send" type="button">Send identified report</button>';
    host.querySelector('#m-report-send').onclick = function () {
      var button = this;
      button.disabled = true;
      button.textContent = 'Sending…';
      var body = data.description;
      var context = [data.date && 'Date: ' + data.date, data.time && 'Time: ' + data.time, data.location && 'Location: ' + data.location].filter(Boolean);
      if (context.length) body += '\n\nIncident context\n' + context.join('\n');
      body += '\n\nCategory: ' + data.category + '\n— identified employee report';
      var formData = new FormData();
      formData.append('recipient_id', data.recipient_id);
      formData.append('subject', '[EMPLOYEE REPORT] ' + data.category + ' — ' + data.subject);
      formData.append('body', body);
      for (var i = 0; data.files && i < data.files.length; i += 1) formData.append('files', data.files[i], data.files[i].name);
      API.upload('/messages', formData).then(function () {
        clearDraft(DRAFT_KEY);
        mSuccess(view, {
          title: 'Report sent',
          lines: ['Your identity was included for follow-up.', 'Open Inbox to view replies and continue the conversation.'],
          actions: [
            { label: 'Open Inbox', onClick: function () { MApp.go('inbox'); } },
            { label: 'Reporting hub', secondary: true, onClick: function () { hub(view); } }
          ]
        });
      }).catch(function (error) {
        mToast(error.message || 'Could not send report', 'err');
        button.disabled = false;
        button.textContent = 'Send identified report';
      });
    };
  }

  /* Identity-free transport for the anonymous channel. Deliberately NOT API.post: that adds
     the bearer token (and the offline queue would persist it with an idempotency key). Only
     the ticket request is authenticated; the server keeps no link between ticket and user. */
  function anonPost(path, body) {
    return fetch('/api/anonymous-reports' + path, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).catch(function () {
      var e = new Error('You’re offline. Nothing was sent — your draft is still on this device.'); e.offline = true; throw e;
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
        return data;
      });
    });
  }

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
        '<aside class="m-report-backend-block"><b>No attachments on this channel</b><span>Photos and files carry hidden details (device, place, time) that can identify you. Describe the evidence instead; the case handler can ask for more through your follow-up code.</span></aside>' +
        '<button class="m-v2-primary" type="submit">Review anonymous report</button></form>' +
      '<button class="m-report-row" id="m-anon-check" type="button"><span><b>Check a report I filed</b><small>Use the report number and access code</small></span><i aria-hidden="true">›</i></button>';
    var form = host.querySelector('form');
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
      '</section>' +
      '<aside class="m-report-anon-notice"><b>You’ll get a report number and a one-time access code</b><span>Save both — they are the only way to see replies. The code is shown once and can’t be recovered.</span></aside>' +
      '<button class="m-v2-primary" id="m-anon-send" type="button">Send anonymously</button>';
    var button = host.querySelector('#m-anon-send');
    button.onclick = function () {
      if (navigator.onLine === false) { mToast('You’re offline. Nothing was sent — your draft is still on this device.', 'err'); return; }
      button.disabled = true;
      button.textContent = 'Sending securely…';
      API.post('/anonymous-reports/ticket').then(function (t) {
        return anonPost('', {
          ticket: t.ticket, category: data.category, subject: data.subject || null, description: data.details,
          incident_date: data.date || null, location: data.location || null
        });
      }).then(function (res) {
        clearDraft(ANON_DRAFT_KEY);
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
    function show(report) {
      var c = creds();
      out.innerHTML =
        '<section class="m-report-review"><div><span>' + mEsc(report.number) + ' · ' + mEsc(report.category) + '</span><b>' + mEsc(report.subject || 'Anonymous report') + '</b></div>' +
        '<div><span>Status</span><b class="m-anon-status ' + mEsc(report.status) + '">' + mEsc(report.status) + '</b></div>' +
        '<div><span>Filed · last update</span><b>' + mEsc(report.created_on) + ' · ' + mEsc(report.updated_on) + '</b></div></section>' +
        '<div class="m-anon-thread">' + (report.messages.length ? report.messages.map(function (m) {
          return '<div class="m-anon-msg ' + mEsc(m.author) + '"><small>' + (m.author === 'handler' ? 'Case handler' : 'You') + ' · ' + mEsc(m.created_on) + '</small><p>' + mEsc(m.body) + '</p></div>';
        }).join('') : '<div class="m-empty">No replies yet.</div>') + '</div>' +
        (report.status === 'closed' ? '<div class="m-hint">This report is closed.</div>'
          : '<form class="m-report-form" id="m-anon-reply" novalidate><label class="is-tall"><span>Add information</span><textarea rows="3" maxlength="3000" placeholder="Answer a question or add details"></textarea></label>' +
            '<button class="m-v2-primary" type="submit">Send</button></form>');
      var reply = out.querySelector('#m-anon-reply');
      if (reply) reply.onsubmit = function (event) {
        event.preventDefault();
        var text = reply.querySelector('textarea').value.trim();
        if (!text) { mToast('Write a message', 'err'); return; }
        var b = reply.querySelector('button'); b.disabled = true;
        anonPost('/followup', { number: c.number, access_code: c.access_code, body: text })
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

  function identifiedList(view) {
    MApp.setTitle('My identified reports');
    var host = shell(view, '46:721', 'My identified reports', 'Reports sent with your identity', function () { hub(view); });
    host.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/messages?box=sent').then(function (rows) {
      var reports = (rows || []).filter(function (row) { return String(row.subject || '').indexOf('[EMPLOYEE REPORT]') === 0; });
      if (!reports.length) { host.innerHTML = '<div class="m-empty">You have not sent an identified report yet.</div>'; return; }
      host.innerHTML = reports.map(function (row) {
        return '<button class="m-report-row" type="button" data-user="' + row.other_id + '"><span><b>' +
          mEsc(String(row.subject).replace('[EMPLOYEE REPORT] ', '')) + '</b><small>Sent ' + mEsc(String(row.created_at || '').slice(0, 16)) +
          ' · ' + mEsc(row.other_name || 'Recipient') + '</small></span><i aria-hidden="true">›</i></button>';
      }).join('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-user]'), function (button) {
        button.onclick = function () { MApp.go('inbox', { user: this.getAttribute('data-user') }); };
      });
    }).catch(function (error) { host.innerHTML = '<div class="m-error">' + mEsc(error.message) + '</div>'; });
  }

  function guidance(view) {
    MApp.setTitle('Reporting guidance');
    var host = shell(view, '46:721', 'Reporting guidance', 'Choose the safest response for the situation', function () { hub(view); });
    host.innerHTML =
      '<article class="m-report-guide"><h2>Immediate danger or emergency</h2><p>Move to safety and contact the designated on-site responder or emergency services first. Do not wait for an in-app report.</p></article>' +
      '<article class="m-report-guide"><h2>Need a reply or formal follow-up</h2><p>Use an identified report. The recipient can ask questions, provide updates, and continue the conversation in Inbox.</p></article>' +
      '<article class="m-report-guide"><h2>Identity-sensitive concern</h2><p>Use the anonymous channel. You get a report number and a one-time access code to read replies; nothing about your account is stored with it.</p></article>';
  }

  MApp.route('report-problem', function (view, params) {
    if (params && params.mode === 'identified') { identified(view, params.about ? { subject: params.about } : null); return; }
    if (params && params.mode === 'anonymous') { anonymous(view); return; }
    hub(view);
  });
  MApp.route('anonymous-report', function (view, params) {
    if (params && params.check) { anonymousLookup(view); return; }
    anonymous(view);
  });
})();
