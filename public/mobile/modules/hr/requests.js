/* Employee requests — Figma V2 46:634, 46:663, 46:692. Drafts and cached details
   stay in memory for this account/sign-in only. Submission still uses the existing offline queue. */
(function () {
  var STATUS_CLASS = { draft: '', pending: 'warn', review: 'warn', approved: 'ok', rejected: 'bad', completed: 'ok', cancelled: '' };
  var FILTERS = ['all', 'pending', 'approved', 'rejected'];
  var TYPE_META = {
    overtime_request: { icon: '◷', guide: 'Requires supervisor approval and attendance verification.' },
    leave_request: { icon: '☼', guide: 'Your available leave balance is checked during approval.' },
    halfday_request: { icon: '◐', guide: 'Choose the date and which half of the shift is affected.' },
    undertime_request: { icon: '↙', guide: 'State the planned departure time and operational reason.' },
    offset_form: { icon: '⇄', guide: 'Identify the earned time and the date you plan to use it.' },
    time_correction: { icon: '⟳', guide: 'Give the correct punch details so HR can verify attendance.' },
    schedule_change: { icon: '▦', guide: 'Choose a published future work date and a shift. Your roster changes only after approval.' },
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


  var session = null;
  function identity() {
    var me = MApp.getMe() || {};
    return [String(me.id || 'guest'), API.getToken?.() || '', !!API.isSharedSession?.(), String(me.employee?.id || '')];
  }
  function same(ctx) { return session === ctx && JSON.stringify(identity()) === ctx.identity; }
  function context() {
    var key = JSON.stringify(identity());
    if (!session || session.identity !== key) session = { identity: key, filter: 'all', search: '', rows: null, types: null, employee: null, drafts: Object.create(null), details: Object.create(null), pending: {}, errors: {}, active: null, operation: null, revision: 0 };
    return session;
  }
  function alive(ctx, host) { return same(ctx) && host.isConnected && ctx.active?.host === host && ctx.active.hash === location.hash; }
  function activate(ctx, host, kind, paint, extra) {
    ctx.active = Object.assign({ host: host, kind: kind, paint: paint, hash: location.hash }, extra || {});
    window.mPersonalDraft?.arm(function () { return false; }, function () { return same(ctx) && !!ctx.operation; }, { busyText: function () { return 'Please wait for the request update to finish.'; } });
  }
  function paint(ctx, kinds) { if (ctx.active && (!kinds || kinds.indexOf(ctx.active.kind) >= 0) && alive(ctx, ctx.active.host)) ctx.active.paint(); }
  function canAct(ctx, host) { return alive(ctx, host) && !ctx.operation; }
  function focus(host, selector) { host.querySelector(selector)?.focus(); }
  function optionValue(option) { return option && typeof option === 'object' ? option.value ?? option.id ?? option.label ?? option.name : option; }
  function optionLabel(option) { return option && typeof option === 'object' ? option.label ?? option.name ?? optionValue(option) : option; }
  function controlFor(host, key) { return Array.from(host.querySelectorAll('[data-k]')).find(function (input) { return input.dataset.k === key; }); }
  function draftFor(ctx, type) {
    var key = String(type.id);
    return ctx.drafts[key] || (ctx.drafts[key] = { type: type, data: {}, initialized: false, edited: false, review: null, receipt: null, error: '', leaveInputs: {} });
  }
  function message(ex, fallback) { var text = String(ex?.message || fallback).trim(); return /[.!?…]$/.test(text) ? text : text + '.'; }
  function errorBlock(text) { return '<div class="m-error m-request-feedback" role="alert" tabindex="-1">' + mEsc(text) + '</div>'; }
  function displayValue(key, value, fields) {
    var field = (fields || []).find(function (f) { return f.key === key; });
    if (field && (field.type === 'select' || field.type === 'employee')) {
      var option = (field.options || []).find(function (o) { return String(optionValue(o)) === String(value); });
      if (option != null) return String(optionLabel(option));
    }
    if (key === 'leave_dates') return String(value).split(',').map(dateText).join(' · ');
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? dateText(value) : String(value);
  }
  function fieldLabel(key, fields) {
    var field = (fields || []).find(function (f) { return f.key === key; });
    return field?.label || ({ leave_dates: 'Selected leave dates', date_from: 'From date', date_to: 'Through date' })[key] || titleCase(key);
  }
  // Share in-flight reads across filters and rerenders. A late read cannot undo a confirmed write.
  function load(ctx, kind, force) {
    if (ctx.pending[kind]) return ctx.pending[kind];
    var hasValue = kind === 'employee' ? ctx.employee !== null : ctx[kind] !== null;
    if (!force && hasValue) return Promise.resolve(ctx[kind]);
    var revision = ctx.revision;
    ctx.errors[kind] = '';
    ctx.pending[kind] = Promise.resolve().then(function () {
      if (kind === 'rows') return API.get('/me/requests');
      if (kind === 'types') return API.get('/me/request-types');
      return API.get('/me');
    }).then(function (data) {
      if (!same(ctx)) return;
      if (kind !== 'rows' || revision === ctx.revision) {
        if (kind === 'employee') ctx.employee = data.employee || {};
        else ctx[kind] = data || [];
      }
    }).catch(function (ex) { if (same(ctx)) ctx.errors[kind] = message(ex, 'Could not load ' + (kind === 'rows' ? 'requests.' : 'request types.')); }).finally(function () {
      ctx.pending[kind] = null;
      paint(ctx, kind === 'employee' ? ['list', 'form'] : kind === 'types' ? ['list', 'types', 'link'] : ['list', 'detail', 'link']);
    });
    return ctx.pending[kind];
  }
  window.addEventListener('beforeunload', function (event) {
    if (session && same(session) && (session.operation || Object.values(session.drafts).some(function (d) { return d.edited && !d.receipt; }))) { event.preventDefault(); event.returnValue = ''; }
  });

  function fieldMarkup(field) {
    var label = mEsc(field.label) + (field.required ? ' *' : '');
    var key = mEsc(field.key);
    var required = field.required ? ' aria-required="true"' : '';
    if (field.type === 'checkbox') {
      return '<label data-validation-field class="m-request-check"><input type="checkbox" data-k="' + key + '"' + required + '><span>' + label + '</span></label>';
    }
    if (field.type === 'textarea') {
      return '<label data-validation-field class="m-request-field"><span>' + label + '</span><textarea data-k="' + key + '"' + required + ' rows="3"></textarea></label>';
    }
    if (field.type === 'select' || field.type === 'employee') {
      var options = (field.options || []).map(function (option) {
        var value = typeof option === 'object' ? optionValue(option) : option;
        var text = typeof option === 'object' ? optionLabel(option) : option;
        return '<option value="' + mEsc(String(value)) + '">' + mEsc(String(text)) + '</option>';
      }).join('');
      return '<label data-validation-field class="m-request-field"><span>' + label + '</span><select data-k="' + key + '"' + required + '><option value="">Choose one</option>' + options + '</select></label>';
    }
    var inputType = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : (field.type === 'time' ? 'time' : 'text'));
    return '<label data-validation-field class="m-request-field"><span>' + label + '</span><input type="' + inputType + '"' + (inputType === 'number' ? ' step="any"' : '') + ' data-k="' + key + '"' + required + '></label>';
  }

  function collect(formEl, type, autofill) {
    var data = {};
    var missing = null;
    var errors = [];
    Object.keys(autofill).forEach(function (key) { if (autofill[key]) data[key] = autofill[key]; });
    (type.fields || []).forEach(function (field) {
      if (autofill[field.key]) return;
      var input = controlFor(formEl, field.key);
      if (!input) return;
      var value = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : String(input.value || '').trim();
      if (field.required && (input.type === 'checkbox' ? !input.checked : !value)) {
        missing = missing || field.label;
        errors.push({ control: input, message: field.label + ' is required' });
      } else if (!input.validity.valid) errors.push({ control: input, message: field.label + ': ' + input.validationMessage });
      if (value) data[field.key] = value;
    });
    return { data: data, missing: missing, errors: errors };
  }


  function list(view, selectedFilter, restoreId) {
    var ctx = context(); if (ctx.operation) return;
    ctx.filter = FILTERS.indexOf(selectedFilter) >= 0 ? selectedFilter : ctx.filter;
    MApp.setTitle('Requests');
    var host = shell(view, '46:634', 'Requests', 'Track approvals and submit requests');
    function draw() {
      if (!alive(ctx, host)) return;
      var oldFocus = document.activeElement, returnFocus = host.contains(oldFocus), filter = ctx.filter;
      var focusFilter = oldFocus?.dataset.filter, focusRequest = oldFocus?.dataset.requestId, focusNew = oldFocus?.id === 'm-req-new';
      var rows = (ctx.rows || []).filter(function (r) { return filter === 'all' || (filter === 'pending' ? ['pending', 'draft', 'review'].indexOf(r.status) >= 0 : r.status === filter); });
      host.innerHTML = '<div class="m-request-actions"><button class="m-v2-primary m-request-new" id="m-req-new" type="button">＋ New request</button></div>' +
        '<div class="m-request-tabs" role="group" aria-label="Request status">' + FILTERS.map(function (name) { return '<button type="button" data-filter="' + name + '" aria-pressed="' + (filter === name) + '">' + titleCase(name) + '</button>'; }).join('') + '</div>' +
        (ctx.errors.rows ? errorBlock(ctx.errors.rows + (ctx.rows ? ' Your last loaded list is still here.' : '')) : '') +
        '<div id="m-req-list" aria-busy="' + !!ctx.pending.rows + '">' + (ctx.rows === null ? '<p class="m-hint" role="status">' + (ctx.pending.rows ? 'Loading requests…' : 'Requests could not be loaded.') + '</p>' :
          '<p class="m-request-count" role="status">' + rows.length + ' ' + (filter === 'all' ? '' : filter + ' ') + 'request' + (rows.length === 1 ? '' : 's') + ' in the latest list</p>' +
          (rows.length ? rows.map(function (r) { return '<button class="m-request-row" type="button" data-request-id="' + mEsc(r.id) + '"><span class="m-request-row-copy"><b>' + mEsc(r.form_name) + '</b><small>' + mEsc([r.number, requestSummary(r)].filter(Boolean).join(' · ')) + '</small></span><span class="m-request-state ' + (STATUS_CLASS[r.status] || '') + '">' + mEsc(statusLabel(r.status)) + '</span><span class="m-request-chevron" aria-hidden="true">›</span></button>'; }).join('') : '<div class="m-empty m-request-empty">No ' + (filter === 'all' ? '' : filter + ' ') + 'requests in the latest list.</div>')) + '</div>' +
        '<button type="button" class="m-v2-secondary" id="m-req-retry"' + (ctx.pending.rows ? ' disabled' : '') + '>' + (ctx.pending.rows ? 'Refreshing…' : ctx.errors.rows ? 'Try again' : 'Refresh requests') + '</button><div id="m-req-balance">' + leaveBalanceStrip(ctx.employee) + '</div>' +
        (ctx.types?.length ? '<aside class="m-request-types-note"><b>Forms available now</b><span>' + ctx.types.map(function (t) { return mEsc(t.name); }).join(' · ') + '</span></aside>' : '');
      host.querySelector('#m-req-new').onclick = function () { if (canAct(ctx, host)) pickType(view); };
      host.querySelectorAll('[data-filter]').forEach(function (button) { button.onclick = function () { if (canAct(ctx, host) && ctx.filter !== button.dataset.filter) { ctx.filter = button.dataset.filter; draw(); focus(host, '[data-filter="' + ctx.filter + '"]'); } }; });
      host.querySelectorAll('[data-request-id]').forEach(function (button) { button.onclick = function () { if (canAct(ctx, host)) detail(view, button.dataset.requestId); }; });
      host.querySelector('#m-req-retry').onclick = function () { if (canAct(ctx, host) && !ctx.pending.rows) { load(ctx, 'rows', true); draw(); } };
      if (restoreId) { var target = Array.from(host.querySelectorAll('[data-request-id]')).find(function (b) { return b.dataset.requestId === String(restoreId); }); if (target) { target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' }); } restoreId = null; }
      else if (returnFocus) {
        var target = focusRequest && Array.from(host.querySelectorAll('[data-request-id]')).find(function (b) { return b.dataset.requestId === focusRequest; });
        if (target) target.focus();
        else focus(host, focusFilter ? '[data-filter="' + focusFilter + '"]' : focusNew ? '#m-req-new' : '#m-req-retry');
      }
    }
    activate(ctx, host, 'list', draw);
    load(ctx, 'rows'); load(ctx, 'types'); load(ctx, 'employee'); draw();
  }

  function pickType(view) {
    var ctx = context(); if (ctx.operation) return;
    MApp.setTitle('New request');
    var host = shell(view, '46:663', 'New request', 'Choose the request that matches what you need', function () { if (canAct(ctx, host)) list(view); });
    function results() {
      var out = host.querySelector('[data-type-results]'); if (!out) return;
      var query = ctx.search.trim().toLowerCase();
      var types = (ctx.types || []).filter(function (t) { return (t.name + ' ' + (TYPE_META[t.slug]?.guide || '') + ' ' + t.slug).toLowerCase().indexOf(query) >= 0; });
      out.innerHTML = '<p class="m-request-count" role="status">' + types.length + ' form' + (types.length === 1 ? '' : 's') + ' found</p><div class="m-request-type-grid">' + types.map(function (type) {
        var meta = TYPE_META[type.slug] || { icon: '＋', guide: 'This request will be routed for the required approval.' }, draft = ctx.drafts[String(type.id)];
        return '<button class="m-request-type-card" type="button" data-type-id="' + mEsc(type.id) + '"><span class="m-request-type-icon" aria-hidden="true">' + meta.icon + '</span><span><b>' + mEsc(type.name) + '</b><small>' + mEsc(meta.guide) + '</small>' + (draft?.receipt ? '<small>' + mEsc(draft.receipt.title) + '</small>' : draft?.edited ? '<small>Draft in this open app</small>' : '') + '</span><i aria-hidden="true">›</i></button>';
      }).join('') + '</div>' + (!types.length ? '<div class="m-empty">' + (ctx.types.length ? 'No matching forms. Try another word.' : 'No request forms are set up. Ask HR for assistance.') + '</div>' + (query ? '<button type="button" class="m-v2-secondary" data-clear-search>Clear search</button>' : '') : '');
      out.querySelectorAll('[data-type-id]').forEach(function (button) { button.onclick = function () { if (canAct(ctx, host)) form(view, ctx.types.find(function (t) { return String(t.id) === button.dataset.typeId; })); }; });
      out.querySelector('[data-clear-search]')?.addEventListener('click', function () { if (!canAct(ctx, host)) return; ctx.search = ''; host.querySelector('[data-type-search]').value = ''; results(); focus(host, '[data-type-search]'); });
    }
    function draw() {
      if (!alive(ctx, host)) return;
      var focused = host.querySelector('[data-type-search]') === document.activeElement;
      host.innerHTML = (ctx.errors.types ? errorBlock(ctx.errors.types) : '') + (ctx.types === null ? '<p class="m-hint" role="status">' + (ctx.pending.types ? 'Loading request types…' : 'Request types could not be loaded.') + '</p>' : '<label class="m-request-field m-request-search"><span>Search request types</span><input type="search" data-type-search placeholder="Name or purpose" value="' + mEsc(ctx.search) + '"></label><div data-type-results></div>') +
        (ctx.errors.types ? '<button type="button" class="m-v2-secondary" id="m-type-retry"' + (ctx.pending.types ? ' disabled' : '') + '>' + (ctx.pending.types ? 'Loading…' : 'Try again') + '</button>' : '');
      host.querySelector('[data-type-search]')?.addEventListener('input', function (event) { if (canAct(ctx, host)) { ctx.search = event.target.value; results(); } });
      host.querySelector('#m-type-retry')?.addEventListener('click', function () { if (canAct(ctx, host) && !ctx.pending.types) { load(ctx, 'types', true); draw(); } });
      if (ctx.types) results(); if (focused) focus(host, '[data-type-search]');
    }
    activate(ctx, host, 'types', draw); load(ctx, 'types'); draw();
  }

  function form(view, type, prefillDate) {
    var ctx = context(); if (ctx.operation) return;
    var state = draftFor(ctx, type); state.type = type;
    if (state.receipt) { review(view, type, state); return; }
    MApp.setTitle(type.name);
    var host = shell(view, '46:663', 'New ' + type.name.toLowerCase(), 'Complete the details, then review before submitting', function () { if (canAct(ctx, host)) { remember(); pickType(view); } });
    var employee = (MApp.getMe() || {}).employee || {};
    activate(ctx, host, 'form', function () { var balance = host.querySelector('#m-req-form-balance'); if (balance) balance.innerHTML = leaveBalanceStrip(ctx.employee); });
    if (!employee.id) { host.innerHTML = '<div class="m-empty">Your account is not linked to an employee record. Ask HR to link your account before filing requests.</div>'; return; }
    var autofill = { employee_name: employee.name, name: employee.name, department: employee.department_name, position: employee.position, employee_no: employee.employee_no };
    var fields = (type.fields || []).filter(function (field) { return !autofill[field.key] && !(type.slug === 'leave_request' && ['date_from','date_to','days','leave_dates'].indexOf(field.key) >= 0); });
    var meta = TYPE_META[type.slug] || { guide: 'This request will be routed for the required approval.' };
    if (!state.initialized) {
      (type.fields || []).forEach(function (field) { if (!autofill[field.key]) state.data[field.key] = field.default ?? ''; });
      if (prefillDate) { if (type.slug === 'leave_request') Object.assign(state.data, { date_from: prefillDate, date_to: prefillDate }); else state.data[fields.some(function (f) { return f.key === 'work_date'; }) ? 'work_date' : 'date'] = prefillDate; }
      state.initialized = true;
    }
    host.innerHTML = '<button class="m-request-selected-type" type="button"><span><small>Request type</small><b>' + mEsc(type.name) + '</b></span><i aria-hidden="true">›</i></button><p class="m-request-draft-note">* Required. Other fields are optional.</p>' +
      '<form class="m-request-form" novalidate><div data-validation-summary class="m-error" role="alert" tabindex="-1" hidden></div>' + (type.slug === 'leave_request' ? LeaveDates.markup() : '') + fields.map(fieldMarkup).join('') +
      '<aside class="m-request-guidance">' + mEsc(meta.guide) + '</aside><p class="m-request-draft-note">Your draft stays in this open app when you use Back or change type. Reloading, closing or signing out clears it.</p><button class="m-v2-primary" type="submit">Review request</button></form><div id="m-req-form-balance">' + leaveBalanceStrip(ctx.employee) + '</div>';
    var formEl = host.querySelector('form'), mounting = true;
    host.querySelector('.m-request-selected-type').onclick = function () { if (canAct(ctx, host)) { remember(); pickType(view); } };
    var leavePicker = type.slug === 'leave_request' ? LeaveDates.mount(formEl, { data: state.data, onChange: function (data) { if (!mounting && canAct(ctx, host)) { Object.assign(state.data, data); state.edited = true; } }, preview: function (data) { return API.post('/me/leave-preview', data); } }) : null;
    fields.forEach(function (field) { var input = controlFor(formEl, field.key), value = state.data[field.key]; if (input && value != null) { if (input.type === 'checkbox') input.checked = value === true || value === 'Yes'; else input.value = value; } });
    Object.keys(state.leaveInputs).forEach(function (key) { var input = formEl.querySelector('[data-leave-' + key + ']'); if (input) input.value = state.leaveInputs[key]; });
    mounting = false;
    function remember() {
      if (!canAct(ctx, host)) return;
      fields.forEach(function (field) { var input = controlFor(formEl, field.key); if (input) state.data[field.key] = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : input.value; });
      if (leavePicker) { Object.assign(state.data, leavePicker.value()); ['from', 'to', 'single'].forEach(function (key) { state.leaveInputs[key] = formEl.querySelector('[data-leave-' + key + ']').value; }); }
    }
    formEl.addEventListener('input', function () { if (canAct(ctx, host)) { state.edited = true; remember(); } });
    formEl.addEventListener('change', function () { if (canAct(ctx, host)) { state.edited = true; remember(); } });
    var unavailableShift = type.slug === 'schedule_change' && !(type.fields || []).some(function (field) { return field.key === 'requested_shift_id' && field.options?.length; });
    if (unavailableShift) { formEl.insertAdjacentHTML('afterbegin', '<aside class="m-request-guidance">HR needs to configure work shifts before you can request a change.</aside>'); formEl.querySelector('[type="submit"]').disabled = true; }
    if (type.slug === 'leave_request') load(ctx, 'employee');
    formEl.onsubmit = function (event) {
      event.preventDefault(); if (!canAct(ctx, host) || unavailableShift || state.receipt) return;
      remember(); var result = collect(formEl, type, autofill);
      if (leavePicker) { Object.assign(result.data, leavePicker.value()); if (!result.data.leave_dates) result.errors.push({ control: formEl.querySelector('[data-leave-single]'), message: 'Select at least one leave date.', isValid: function () { return !!leavePicker.value().leave_dates; } }); }
      if (!FormValidation.show(formEl, result.errors, formEl.querySelector('[data-validation-summary]'))) return;
      state.review = result.data; state.error = ''; review(view, type, state);
    };
  }

  function review(view, type, state) {
    var ctx = context();
    MApp.setTitle('Review request');
    var host = shell(view, '46:663', 'Review request', 'Confirm the details before sending', function () { if (canAct(ctx, host) && !state.receipt) form(view, type); });
    function draw() {
      if (!alive(ctx, host)) return;
      var data = state.review || {}, receipt = state.receipt, pending = !!ctx.operation;
      var hiddenKeys = ['employee_name', 'name', 'department', 'position', 'employee_no'];
      var rows = Object.keys(data).filter(function (key) { return hiddenKeys.indexOf(key) < 0; });
      var back = view.querySelector('.m-request-back'); back.disabled = pending; back.hidden = !!receipt;
      host.innerHTML = (receipt ? '<section class="m-request-status"><b>' + mEsc(receipt.title) + '</b><span>' + mEsc(receipt.text) + '</span></section>' : '') +
        '<section class="m-request-review"><div class="m-request-review-type"><small>Request type</small><b>' + mEsc(type.name) + '</b></div>' + rows.map(function (key) { return '<div><span>' + mEsc(fieldLabel(key, type.fields)) + '</span><b>' + mEsc(displayValue(key, data[key], type.fields)) + '</b></div>'; }).join('') + '</section>' +
        '<aside class="m-request-guidance">Submitting sends this request to the configured approver. It does not change your schedule, attendance, or employee record until approved.</aside>' +
        (state.error ? errorBlock(state.error) : '') + (receipt?.warnings?.length ? '<aside class="m-request-guidance">' + receipt.warnings.map(mEsc).join('<br>') + '</aside>' : '') +
        (receipt ? '<p class="m-request-draft-note">' + mEsc(receipt.next) + '</p><div class="m-request-inline-actions"><button type="button" class="m-v2-primary" data-receipt-list>Back to requests</button>' + (receipt.kind === 'queued' ? '<button type="button" class="m-v2-secondary" data-receipt-queue>View Pending sync</button>' : '') + '<button type="button" class="m-v2-secondary" data-another-request>Start another request</button></div>' : '<p class="m-request-draft-note" role="status">' + (pending ? 'Submitting… Please wait before leaving or submitting again.' : 'Use Back to edit. Your details will be kept.') + '</p><button type="button" class="m-v2-primary" id="m-request-submit"' + (pending ? ' disabled' : '') + '>' + (pending ? 'Submitting…' : 'Submit request') + '</button>');
      host.querySelector('[data-receipt-list]')?.addEventListener('click', function () { if (canAct(ctx, host)) list(view, receipt.kind === 'sent' ? 'pending' : ctx.filter); });
      host.querySelector('[data-receipt-queue]')?.addEventListener('click', function () { if (canAct(ctx, host)) MApp.go('queue'); });
      host.querySelector('[data-another-request]')?.addEventListener('click', function () { if (canAct(ctx, host)) { delete ctx.drafts[String(type.id)]; form(view, type); } });
      host.querySelector('#m-request-submit')?.addEventListener('click', async function () {
        if (!canAct(ctx, host) || state.receipt) return;
        ctx.operation = { kind: 'submit', state: state }; state.error = ''; draw();
        try {
          var sent = await mSubmit('/form-records', { form_def_id: type.id, data: JSON.parse(JSON.stringify(data)), status: 'pending' }, { label: type.name + ' request' });
          if (!same(ctx)) return;
          var result = sent.response || {};
          state.receipt = sent.queued ? { kind: 'queued', title: 'Saved on this phone', text: 'Waiting to send when this phone reconnects. It has not reached the approver yet.', next: 'Open Pending sync to check delivery before filing another copy.' } : sent.local ? { kind: 'local', title: 'Saved on the site PC', text: 'The cloud has not confirmed this request yet.', next: 'Check site sync status before filing another copy.' } : { kind: 'sent', title: 'Request submitted', text: [result.number, 'Pending review'].filter(Boolean).join(' · '), next: 'You can track this request in Requests.' };
          state.receipt.warnings = result.action_warnings || []; state.edited = false;
          ctx.revision++; ctx.rows = null; ctx.errors.rows = '';
        } catch (ex) {
          if (same(ctx)) state.error = 'Submission was not confirmed. ' + message(ex, 'Please check your connection.') + ' Your details are kept here. Check Requests or Pending sync before retrying if the connection was interrupted.';
        } finally {
          ctx.operation = null;
          if (same(ctx) && ctx.active?.state === state) { paint(ctx, ['review']); focus(ctx.active.host, state.receipt ? '.m-request-status' : '.m-error'); }
        }
      });
      host.querySelector('.m-request-status')?.setAttribute('tabindex', '-1');
    }
    activate(ctx, host, 'review', draw, { state: state }); draw();
  }

  function detail(view, id) {
    var ctx = context(); id = String(id);
    if (ctx.operation && (ctx.operation.kind !== 'cancel' || ctx.operation.id !== id)) return;
    var state = ctx.details[id] || (ctx.details[id] = { confirm: false, error: '', feedback: '' });
    var host = shell(view, '46:692', 'Request details', 'Your submitted request', function () { if (canAct(ctx, host)) list(view, ctx.filter, id); });
    function draw() {
      if (!alive(ctx, host)) return;
      var r = (ctx.rows || []).find(function (row) { return String(row.id) === id; }), pending = !!ctx.operation;
      view.querySelector('.m-request-back').disabled = pending;
      if (!r) {
        host.innerHTML = (ctx.errors.rows ? errorBlock(ctx.errors.rows) : '') + '<div class="m-empty" role="status">' + (ctx.pending.rows ? 'Loading request…' : ctx.rows === null ? 'Could not load this request.' : 'This request is not in your latest request list. It may be unavailable or older than the latest 100 requests.') + '</div><button type="button" class="m-v2-secondary" data-refresh-request' + (ctx.pending.rows ? ' disabled' : '') + '>Try again</button>';
      } else {
        MApp.setTitle(r.form_name); view.querySelector('h1').textContent = r.form_name; view.querySelector('.m-request-heading p').textContent = r.number || 'Request details';
        var data = r.display_data || r.data || {}, decision = r.data?.decision_note;
        var fields = Object.keys(data).filter(function (key) { return data[key] != null && String(data[key]).trim() !== '' && typeof data[key] !== 'object' && ['decision_note', 'employee_id', 'decided_by'].indexOf(key) < 0; });
        var progress = state.localCancel && r.status === 'cancelled' ? 'Cancellation saved on the site PC · Cloud confirmation pending' : r.status === 'cancelled' ? 'Cancelled · No further approval will be requested' : r.status === 'rejected' ? 'Rejected · See the decision note when available' : r.status === 'approved' ? 'Approved · Check any instructions in the decision note' : r.status === 'completed' ? 'Completed' : ['pending', 'draft', 'review'].indexOf(r.status) >= 0 ? 'Waiting for approval' : statusLabel(r.status);
        host.innerHTML = '<section class="m-request-status ' + (STATUS_CLASS[r.status] || '') + '"><b>' + mEsc(state.localCancel && r.status === 'cancelled' ? 'Cancelled on site PC' : statusLabel(r.status)) + '</b><span>Submitted ' + mEsc(dateText(r.created_at)) + '</span></section><div class="m-request-detail-fields">' +
          (fields.length ? fields.map(function (key) { return '<div class="m-request-detail-row"><b>' + mEsc(r.display_data ? key : fieldLabel(key, r.fields)) + '</b><span>' + mEsc(displayValue(key, data[key], r.fields)) + '</span></div>'; }).join('') : '<div class="m-empty">No additional details were recorded.</div>') + '</div>' +
          (decision ? '<aside class="m-request-decision"><b>Decision note</b><span>' + mEsc(String(decision)) + '</span></aside>' : '') + '<section class="m-request-timeline"><h2>Request progress</h2><div><span class="done">✓ Submitted · ' + mEsc(dateText(r.created_at)) + '</span><span>' + mEsc(progress) + '</span></div></section>' +
          (ctx.errors.rows ? errorBlock(ctx.errors.rows + ' Last loaded details are still shown.') : '') + (state.error ? errorBlock(state.error) : '') + (state.feedback ? '<p class="m-request-feedback" role="status" tabindex="-1">' + mEsc(state.feedback) + '</p>' : '') +
          (r.status === 'pending' || r.status === 'draft' ? state.confirm ? '<section class="m-request-confirm" role="group" aria-label="Confirm cancellation"><b>Cancel ' + mEsc(r.number || 'this request') + '?</b><p>This request will no longer continue for approval.</p><div class="m-request-inline-actions"><button type="button" class="m-v2-secondary" data-cancel-confirm' + (pending || ctx.pending.rows ? ' disabled' : '') + '>' + (pending ? 'Cancelling…' : 'Yes, cancel request') + '</button><button type="button" class="m-v2-secondary" data-cancel-keep' + (pending ? ' disabled' : '') + '>Keep request</button></div></section>' : '<button type="button" class="m-v2-secondary m-request-cancel" data-cancel-start' + (ctx.pending.rows ? ' disabled' : '') + '>Cancel request</button>' : '') +
          '<button type="button" class="m-v2-secondary m-request-refresh" data-refresh-request' + (pending || ctx.pending.rows ? ' disabled' : '') + '>' + (ctx.pending.rows ? 'Refreshing…' : 'Refresh request') + '</button>';
      }
      host.querySelector('[data-refresh-request]').onclick = function () { if (canAct(ctx, host) && !ctx.pending.rows) { load(ctx, 'rows', true); draw(); } };
      host.querySelector('[data-cancel-start]')?.addEventListener('click', function () { if (canAct(ctx, host) && !ctx.pending.rows) { state.confirm = true; state.error = ''; draw(); focus(host, '[data-cancel-keep]'); } });
      host.querySelector('[data-cancel-keep]')?.addEventListener('click', function () { if (canAct(ctx, host)) { state.confirm = false; draw(); focus(host, '[data-cancel-start]'); } });
      host.querySelector('[data-cancel-confirm]')?.addEventListener('click', async function () {
        if (!canAct(ctx, host) || ctx.pending.rows || !r || ['pending', 'draft'].indexOf(r.status) < 0) return;
        ctx.operation = { kind: 'cancel', id: id }; state.error = ''; state.feedback = ''; draw();
        try {
          var result = await API.post('/me/requests/' + encodeURIComponent(id) + '/cancel');
          if (!same(ctx)) return;
          ctx.revision++; r.status = 'cancelled'; state.confirm = false;
          state.localCancel = !!API.syncLocal?.(result);
          state.feedback = state.localCancel ? 'Cancellation saved on the site PC. Cloud confirmation is pending.' : 'Request cancelled.';
        } catch (ex) { if (same(ctx)) state.error = 'Cancellation was not confirmed. ' + message(ex, 'Check your connection.') + ' Refresh the request to check its current status before retrying.'; }
        finally { ctx.operation = null; if (same(ctx) && ctx.active?.kind === 'detail' && ctx.active.id === id) { paint(ctx, ['detail']); focus(ctx.active.host, state.error ? '.m-error' : '[role="status"]'); } }
      });
    }
    activate(ctx, host, 'detail', draw, { id: id }); load(ctx, 'rows'); draw();
  }

  MApp.route('requests', function (view, params) {
    var ctx = context(); params = params || {};
    // An app rerender cannot create a second operation while a request is pending.
    if (ctx.operation) {
      if (ctx.operation.kind === 'submit') review(view, ctx.operation.state.type, ctx.operation.state);
      else detail(view, ctx.operation.id);
      return;
    }
    if (FILTERS.indexOf(params.filter) >= 0) ctx.filter = params.filter;
    if (params.id != null) { detail(view, params.id); return; }
    if (params.type) {
      var host = shell(view, '46:663', 'New request', 'Loading request type', function () { if (canAct(ctx, host)) list(view); });
      function draw() {
        if (!alive(ctx, host)) return;
        if (ctx.types !== null) {
          var type = ctx.types.find(function (candidate) { return candidate.slug === params.type; });
          if (type) form(view, type, params.date);
          else { host.innerHTML = '<div class="m-empty">This request form is no longer available. Choose another request type.</div><button class="m-v2-secondary" type="button" data-choose-type>Choose request type</button>'; host.querySelector('button').onclick = function () { if (canAct(ctx, host)) pickType(view); }; }
        } else { host.innerHTML = (ctx.errors.types ? errorBlock(ctx.errors.types) : '<p class="m-hint" role="status">Loading request type…</p>') + (ctx.errors.types ? '<button class="m-v2-secondary" type="button" data-retry-link>Try again</button>' : ''); host.querySelector('[data-retry-link]')?.addEventListener('click', function () { if (canAct(ctx, host) && !ctx.pending.types) { load(ctx, 'types', true); draw(); } }); }
      }
      activate(ctx, host, 'link', draw); load(ctx, 'types'); draw(); return;
    }
    list(view);
  });

})();
