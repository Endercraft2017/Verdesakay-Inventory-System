/* Employee reporting — Figma V2 nodes 46:721, 46:750 and 46:779.
   Identified reports use the existing scoped messages API. Anonymous submission is
   intentionally blocked until an identity-free backend exists; never send it through
   authenticated messages or software bug reports. */
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

  function anonymous(view) {
    MApp.setTitle('Anonymous report');
    var draft = loadDraft(ANON_DRAFT_KEY);
    var host = shell(view, '46:779', 'Anonymous report', 'Separate protected reporting channel', function () { hub(view); });
    host.innerHTML =
      '<aside class="m-report-anon-notice"><b>Before you continue</b><span>No employee identity should be added. Attachments may contain identifying details.</span></aside>' +
      '<form class="m-report-form m-report-anon-form">' +
        '<label><span>Category</span><select data-anon="category">' + selectOptions(CATEGORIES, draft.category || CATEGORIES[0]) + '</select></label>' +
        '<label class="is-tall"><span>Report details</span><textarea data-anon="details" rows="5" maxlength="3000" placeholder="Describe the concern">' + mEsc(draft.details || '') + '</textarea></label>' +
        '<div class="m-report-context-grid"><label><span>Incident date</span><input data-anon="date" type="date" value="' + mEsc(draft.date || '') + '"></label>' +
        '<label><span>Location</span><input data-anon="location" value="' + mEsc(draft.location || '') + '" placeholder="Optional"></label></div>' +
        '<label class="m-report-files"><span>Evidence</span><input type="file" disabled><small>Attachments stay disabled until metadata stripping and isolated storage are available.</small></label>' +
        '<aside class="m-report-backend-block"><b>Secure submission is not enabled yet</b><span>The current server has no identity-free anonymous reporting endpoint. Your draft stays only on this device and is not sent through Messages or Bug Reports.</span></aside>' +
        '<button class="m-v2-primary" type="submit" disabled>Anonymous submission unavailable</button></form>';
    var form = host.querySelector('form');
    form.addEventListener('input', function () {
      var state = {};
      Array.prototype.forEach.call(form.querySelectorAll('[data-anon]'), function (field) { state[field.getAttribute('data-anon')] = field.value; });
      saveDraft(ANON_DRAFT_KEY, state);
    });
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
      '<article class="m-report-guide"><h2>Identity-sensitive concern</h2><p>Use the separate anonymous channel only after secure submission becomes available. Do not use a shared account or another employee’s identity.</p></article>';
  }

  MApp.route('report-problem', function (view, params) {
    if (params && params.mode === 'identified') { identified(view, params.about ? { subject: params.about } : null); return; }
    if (params && params.mode === 'anonymous') { anonymous(view); return; }
    hub(view);
  });
  MApp.route('anonymous-report', anonymous);
})();
