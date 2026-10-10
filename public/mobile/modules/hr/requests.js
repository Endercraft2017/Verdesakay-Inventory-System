/* Universal employee requests — Figma V2 nodes 46:634, 46:663 and 46:692. */
(function () {
  var STATUS_CLASS = { draft: '', pending: 'warn', review: 'warn', approved: 'ok', rejected: 'bad', completed: 'ok', cancelled: '' };
  var FILTERS = ['all', 'pending', 'approved', 'rejected'];
  var TYPE_META = {
    overtime_request: { icon: '◷', guide: 'Requires supervisor approval and attendance verification.' },
    leave_request: { icon: '☼', guide: 'Your available leave balance is checked during approval.' },
    half_day_request: { icon: '◐', guide: 'Choose the date and which half of the shift is affected.' },
    undertime_request: { icon: '↙', guide: 'State the planned departure time and operational reason.' },
    offset_request: { icon: '⇄', guide: 'Identify the earned time and the date you plan to use it.' },
    time_correction: { icon: '⟳', guide: 'Give the correct punch details so HR can verify attendance.' },
    schedule_change: { icon: '▦', guide: 'Your current roster remains active until this request is approved.' },
    information_change: { icon: '✎', guide: 'Authoritative employee information changes only after approval.' }
  };

  function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function dateText(value) {
    if (!value) return '';
    var raw = String(value);
    var date = new Date(raw.length === 10 ? raw + 'T00:00:00' : raw);
    if (isNaN(date.getTime())) return raw;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function requestSummary(r) {
    var data = r.data || {};
    var date = data.work_date || data.date || data.start_date || data.leave_date || (r.created_at || '').slice(0, 10);
    var extra = data.hours ? data.hours + ' hours' :
      (data.duration ? data.duration : (data.leave_type || data.reason || data.purpose || 'Submitted request'));
    return [dateText(date), extra].filter(Boolean).join(' · ');
  }

  function leaveBalanceStrip(emp) {
    if (!emp || emp.leave_days_per_year == null) return '';
    return '<div class="m-request-balance"><span>Available leave</span><b>' +
      mEsc(String(emp.leave_days_remaining)) + ' of ' + mEsc(String(emp.leave_days_per_year)) +
      ' days</b><small>Final eligibility is confirmed during approval.</small></div>';
  }

  function shell(view, node, heading, subheading, back) {
    view.setAttribute('data-figma-node', node);
    view.innerHTML =
      '<section class="m-v2-page m-requests-v2">' +
        '<header class="m-v2-heading m-request-heading">' +
          (back ? '<button class="m-request-back" type="button" aria-label="Back">‹</button>' : '') +
          '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(subheading) + '</p></div>' +
        '</header><div id="m-request-body"></div>' +
      '</section>';
    if (back) view.querySelector('.m-request-back').onclick = back;
    return view.querySelector('#m-request-body');
  }

  function statusLabel(status) {
    if (status === 'pending') return 'Pending review';
    if (status === 'approved') return 'Approved';
    if (status === 'rejected') return 'Rejected';
    if (status === 'completed') return 'Completed';
    if (status === 'cancelled') return 'Cancelled';
    return titleCase(status || 'draft');
  }

  function list(view, selectedFilter) {
    MApp.setTitle('Requests');
    var filter = FILTERS.indexOf(selectedFilter) >= 0 ? selectedFilter : 'all';
    var host = shell(view, '46:634', 'Requests', 'Track approvals and submit requests');
    host.innerHTML =
      '<div class="m-request-actions"><button class="m-v2-primary m-request-new" id="m-req-new" type="button">＋ New request</button></div>' +
      '<div class="m-request-tabs" role="tablist" aria-label="Request status">' +
        FILTERS.map(function (name) {
          return '<button type="button" role="tab" data-filter="' + name + '" aria-selected="' + (name === filter) + '">' + titleCase(name) + '</button>';
        }).join('') +
      '</div><div id="m-req-list"><div class="m-hint">Loading…</div></div>' +
      '<div id="m-req-balance"></div>' +
      '<aside class="m-request-types-note"><b>Available to every employee</b>' +
        '<span>Overtime · Leave · Half-day · Undertime</span>' +
        '<span>Offset · Time correction · Schedule change</span>' +
        '<span>Information change · Documents · Other</span></aside>';

    host.querySelector('#m-req-new').onclick = function () { pickType(view); };
    Array.prototype.forEach.call(host.querySelectorAll('[data-filter]'), function (button) {
      button.onclick = function () { list(view, this.getAttribute('data-filter')); };
    });

    API.get('/me').then(function (r) {
      var balance = host.querySelector('#m-req-balance');
      if (balance) balance.innerHTML = leaveBalanceStrip(r.employee);
    }).catch(function () {});

    var rowsHost = host.querySelector('#m-req-list');
    API.get('/me/requests').then(function (rows) {
      var visible = (rows || []).filter(function (r) {
        if (filter === 'all') return true;
        if (filter === 'pending') return r.status === 'pending' || r.status === 'draft' || r.status === 'review';
        return r.status === filter;
      });
      if (!visible.length) {
        rowsHost.innerHTML = '<div class="m-empty m-request-empty">No ' + (filter === 'all' ? '' : filter + ' ') + 'requests yet.</div>';
        return;
      }
      rowsHost.innerHTML = '';
      visible.forEach(function (r) {
        var button = mEl('<button class="m-request-row" type="button">' +
          '<span class="m-request-row-copy"><b>' + mEsc(r.form_name) + '</b><small>' + mEsc(requestSummary(r)) + '</small></span>' +
          '<span class="m-request-state ' + (STATUS_CLASS[r.status] || '') + '">' + mEsc(statusLabel(r.status)) + '</span>' +
          '<span class="m-request-chevron" aria-hidden="true">›</span></button>');
        button.onclick = function () { detail(view, r); };
        rowsHost.appendChild(button);
      });
    }).catch(function (ex) {
      rowsHost.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div><button class="m-v2-secondary" id="m-req-retry" type="button">Try again</button>';
      rowsHost.querySelector('#m-req-retry').onclick = function () { list(view, filter); };
    });
  }

  function detail(view, r) {
    MApp.setTitle(r.form_name);
    var host = shell(view, '46:692', r.form_name, r.number || 'Request details', function () { list(view); });
    var data = r.data || {};
    var fields = Object.keys(data).filter(function (key) {
      return data[key] != null && String(data[key]).trim() !== '' && typeof data[key] !== 'object' && ['decision_note', 'employee_id', 'decided_by'].indexOf(key) < 0;
    });
    var current = statusLabel(r.status);
    var isPending = r.status === 'pending' || r.status === 'draft' || r.status === 'review';

    host.innerHTML =
      '<section class="m-request-status ' + (STATUS_CLASS[r.status] || '') + '">' +
        '<b>' + mEsc(isPending ? 'Pending approval' : current) + '</b>' +
        '<span>Submitted ' + mEsc(dateText(r.created_at)) + '</span></section>' +
      '<div class="m-request-detail-fields">' +
        (fields.length ? fields.map(function (key) {
          return '<div class="m-request-detail-row"><b>' + mEsc(titleCase(key)) + '</b><span>' + mEsc(String(data[key])) + '</span></div>';
        }).join('') : '<div class="m-empty">No additional details were recorded.</div>') +
      '</div>' +
      (data.decision_note ? '<aside class="m-request-decision"><b>Decision note</b><span>' + mEsc(String(data.decision_note)) + '</span></aside>' : '') +
      '<section class="m-request-timeline"><h2>Approval timeline</h2><div>' +
        '<span class="done">✓ Submitted · ' + mEsc(dateText(r.created_at)) + '</span>' +
        '<span class="' + (r.status === 'approved' || r.status === 'completed' || r.status === 'rejected' ? 'done' : '') + '">○ Review · ' + mEsc(isPending ? 'Waiting' : current) + '</span>' +
        '<span class="' + (r.status === 'completed' ? 'done' : '') + '">○ Final processing</span>' +
      '</div></section>' +
      (isPending ? '<button class="m-v2-secondary m-request-cancel" type="button">Cancel request</button>' : '');

    var cancel = host.querySelector('.m-request-cancel');
    if (cancel) cancel.onclick = function () {
      if (!window.confirm('Cancel this request? It will no longer continue for approval.')) return;
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      API.post('/me/requests/' + r.id + '/cancel').then(function () {
        mToast('Request cancelled');
        list(view);
      }).catch(function (ex) {
        mToast(ex.message || 'Failed', 'err');
        cancel.disabled = false;
        cancel.textContent = 'Cancel request';
      });
    };
  }

  function pickType(view) {
    MApp.setTitle('New request');
    var host = shell(view, '46:663', 'New request', 'Choose the request that matches what you need', function () { list(view); });
    host.innerHTML = '<div class="m-request-type-loading m-hint">Loading request types…</div>';
    API.get('/me/request-types').then(function (types) {
      if (!types || !types.length) {
        host.innerHTML = '<div class="m-empty">No request forms are set up. Ask HR for assistance.</div>';
        return;
      }
      host.innerHTML = '<div class="m-request-type-grid"></div>';
      var grid = host.querySelector('.m-request-type-grid');
      types.forEach(function (type) {
        var meta = TYPE_META[type.slug] || { icon: '＋', guide: 'This request will be routed for the required approval.' };
        var button = mEl('<button class="m-request-type-card" type="button">' +
          '<span class="m-request-type-icon" aria-hidden="true">' + meta.icon + '</span>' +
          '<span><b>' + mEsc(type.name) + '</b><small>' + mEsc(meta.guide) + '</small></span><i aria-hidden="true">›</i></button>');
        button.onclick = function () { form(view, type); };
        grid.appendChild(button);
      });
    }).catch(function (ex) {
      host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div><button class="m-v2-secondary" id="m-type-retry" type="button">Try again</button>';
      host.querySelector('#m-type-retry').onclick = function () { pickType(view); };
    });
  }

  function fieldMarkup(field) {
    var label = mEsc(field.label) + (field.required ? ' *' : '');
    var key = mEsc(field.key);
    if (field.type === 'checkbox') {
      return '<label class="m-request-check"><input type="checkbox" data-k="' + key + '"><span>' + label + '</span></label>';
    }
    if (field.type === 'textarea') {
      return '<label class="m-request-field"><span>' + label + '</span><textarea data-k="' + key + '" rows="3"></textarea></label>';
    }
    if (field.type === 'select' || field.type === 'employee') {
      var options = (field.options || []).map(function (option) {
        var value = typeof option === 'object' ? (option.value || option.id || option.label || option.name) : option;
        var text = typeof option === 'object' ? (option.label || option.name || value) : option;
        return '<option value="' + mEsc(String(value)) + '">' + mEsc(String(text)) + '</option>';
      }).join('');
      return '<label class="m-request-field"><span>' + label + '</span><select data-k="' + key + '"><option value="">Choose one</option>' + options + '</select></label>';
    }
    var inputType = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : (field.type === 'time' ? 'time' : 'text'));
    return '<label class="m-request-field"><span>' + label + '</span><input type="' + inputType + '" data-k="' + key + '"></label>';
  }

  function collect(formEl, type, autofill) {
    var data = {};
    var missing = null;
    Object.keys(autofill).forEach(function (key) { if (autofill[key]) data[key] = autofill[key]; });
    (type.fields || []).forEach(function (field) {
      if (autofill[field.key]) return;
      var input = formEl.querySelector('[data-k="' + field.key + '"]');
      if (!input) return;
      var value = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : String(input.value || '').trim();
      if (field.required && !value) missing = missing || field.label;
      if (value) data[field.key] = value;
    });
    return { data: data, missing: missing };
  }

  function form(view, type, prefillDate, draft) {
    MApp.setTitle(type.name);
    var host = shell(view, '46:663', 'New ' + type.name.toLowerCase(), 'Complete the details, then review before submitting', function () { pickType(view); });
    var employee = (MApp.getMe() || {}).employee || {};
    if (!employee.id) { host.innerHTML = '<div class="m-empty">Your account is not linked to an employee record. Ask HR to link your account before filing requests.</div>'; return; }
    var autofill = { employee_name: employee.name, name: employee.name, department: employee.department_name, position: employee.position, employee_no: employee.employee_no };
    var fields = (type.fields || []).filter(function (field) { return !autofill[field.key]; });
    var meta = TYPE_META[type.slug] || { guide: 'This request will be routed for the required approval.' };

    host.innerHTML =
      '<button class="m-request-selected-type" type="button"><span><small>Request type</small><b>' + mEsc(type.name) + '</b></span><i aria-hidden="true">›</i></button>' +
      '<form class="m-request-form">' + fields.map(fieldMarkup).join('') +
        '<aside class="m-request-guidance">' + mEsc(meta.guide) + '</aside>' +
        '<button class="m-v2-primary" type="submit">Review request</button></form>' +
      '<div id="m-req-form-balance"></div>';
    host.querySelector('.m-request-selected-type').onclick = function () { pickType(view); };
    var formEl = host.querySelector('form');

    (type.fields || []).forEach(function (field) {
      var input = formEl.querySelector('[data-k="' + field.key + '"]');
      var value = draft && draft[field.key] != null ? draft[field.key] : field.default;
      if (input && value != null && value !== '') { if (input.type === 'checkbox') input.checked = value === true || value === 'Yes'; else input.value = value; }
    });
    if (prefillDate && !draft) {
      var dateInput = formEl.querySelector('[data-k="work_date"]') || formEl.querySelector('[data-k="date"]');
      if (dateInput) dateInput.value = prefillDate;
    }
    if (type.slug === 'leave_request') {
      API.get('/me').then(function (response) {
        var balance = host.querySelector('#m-req-form-balance');
        if (balance) balance.innerHTML = leaveBalanceStrip(response.employee);
      }).catch(function () {});
    }

    formEl.onsubmit = function (event) {
      event.preventDefault();
      var result = collect(formEl, type, autofill);
      if (result.missing) {
        mToast(result.missing + ' is required', 'err');
        var missingField = (type.fields || []).filter(function (field) { return field.label === result.missing; })[0];
        var input = missingField && formEl.querySelector('[data-k="' + missingField.key + '"]');
        if (input) input.focus();
        return;
      }
      review(view, type, result.data, function () { form(view, type, prefillDate, result.data); });
    };
  }

  function review(view, type, data, back) {
    MApp.setTitle('Review request');
    var host = shell(view, '46:663', 'Review request', 'Confirm the details before sending', back);
    var hiddenKeys = ['employee_name', 'name', 'department', 'position', 'employee_no'];
    var rows = Object.keys(data).filter(function (key) { return hiddenKeys.indexOf(key) < 0; });
    host.innerHTML =
      '<section class="m-request-review"><div class="m-request-review-type"><small>Request type</small><b>' + mEsc(type.name) + '</b></div>' +
        rows.map(function (key) { return '<div><span>' + mEsc(titleCase(key)) + '</span><b>' + mEsc(String(data[key])) + '</b></div>'; }).join('') +
      '</section><aside class="m-request-guidance">Submitting sends this request to the configured approver. It does not change your schedule, attendance, or employee record until approved.</aside>' +
      '<button class="m-v2-primary" id="m-request-submit" type="button">Submit request</button>';
    host.querySelector('#m-request-submit').onclick = function () {
      var button = this;
      button.disabled = true;
      button.textContent = 'Submitting…';
      API.post('/form-records', { form_def_id: type.id, data: data, status: 'pending' }).then(function () {
        mToast('Request submitted');
        list(view, 'pending');
      }).catch(function (ex) {
        mToast(ex.message || 'Failed', 'err');
        button.disabled = false;
        button.textContent = 'Submit request';
      });
    };
  }

  MApp.route('requests', function (view, params) {
    if (params && params.type) {
      API.get('/me/request-types').then(function (types) {
        var type = (types || []).filter(function (candidate) { return candidate.slug === params.type; })[0];
        if (!type) { list(view); return; }
        form(view, type, params.date);
      }).catch(function () { list(view); });
      return;
    }
    list(view);
  });
})();
