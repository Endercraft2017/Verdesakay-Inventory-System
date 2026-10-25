/* Attendance corrections: three existing screens. Drafts and receipts are memory-only,
   scoped to this employee/sign-in. Physical punches and approval rules stay on the server. */
(function () {
  var session = null;
  var FIELDS = ['work_date', 'requested_in', 'requested_out', 'reason'];
  var LABELS = { work_date: 'Work date', requested_in: 'Time in', requested_out: 'Time out', reason: 'Reason' };
  var STATUS = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
  function identity() { var me = MApp.getMe() || {}; return JSON.stringify([me.id || '', me.employee?.id || '', API.getToken?.() || '', !!API.isSharedSession?.()]); }
  function same(ctx) { return session === ctx && identity() === ctx.identity; }
  function alive(ctx) { return same(ctx) && ctx.active?.root.isConnected && ctx.active.hash === location.hash; }
  function canAct(ctx, el) { return alive(ctx) && el.isConnected && !ctx.operation; }
  function message(ex, fallback) { var s = String(ex?.message || fallback).trim(); return /[.!?…]$/.test(s) ? s : s + '.'; }
  function dateText(raw) { if (!raw) return ''; var d = new Date(raw + 'T00:00:00'); return isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function stamp(raw) { if (!raw) return ''; var value = String(raw), d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(value) ? value.replace(' ', 'T') + 'Z' : value); return isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function errorHTML(s) { return s ? '<p class="m-error m-tf-feedback" role="alert" tabindex="-1">' + mEsc(s) + '</p>' : ''; }
  function noteHTML(s) { return s ? '<p class="m-tf-feedback" role="status" tabindex="-1">' + mEsc(s) + '</p>' : ''; }
  function badge(r) { return '<span class="m-tf-state ' + mEsc(r.status) + '">' + mEsc(STATUS[r.status] || r.status) + '</span>'; }
  function requestKey() { return 'idem-' + (window.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var n = Math.random() * 16 | 0; return (c === 'x' ? n : n & 3 | 8).toString(16); })); }
  function focus(ctx, selector) { if (!alive(ctx)) return; var el = ctx.active.root.querySelector(selector); if (el) { if (!el.matches('button,input,textarea,select')) el.tabIndex = -1; el.focus({ preventScroll: true }); } }
  function dirty(ctx) { return same(ctx) && ctx.screen === 'form' && ctx.draft && !ctx.draft.receipt && FIELDS.some(function (k) { return !!String(ctx.draft.data[k] || '').trim(); }); }
  function context() {
    var key = identity();
    if (!session || session.identity !== key) {
      var previous = session;
      session = { identity: key, screen: 'list', rows: null, readJob: null, readError: '', revision: 0, details: Object.create(null), draft: null, operation: null, controllers: new Set(), active: null };
      previous?.controllers.forEach(function (c) { c.abort(); });
    }
    return session;
  }
  function mount(ctx, view) {
    var entered = !ctx.active?.root.isConnected || ctx.active.hash !== location.hash;
    if (!ctx.active?.root.isConnected || ctx.active.view !== view) {
      view.innerHTML = '<section class="m-time-fix"></section>';
      ctx.active = { root: view.firstElementChild, view: view, hash: location.hash };
    } else ctx.active.hash = location.hash;
    // A pending router confirmation belongs to the previous guard entry.
    if (ctx.draft?.leave?.done) ctx.draft.leave = null;
    window.mPersonalDraft?.arm(function () { return dirty(ctx); }, function () { return same(ctx) && !!ctx.operation; }, {
      preserveOnRender: true, busyText: function () { return 'Please wait for the correction update to finish. Do not send another copy.'; },
      confirmLeave: function (done) { if (alive(ctx) && !ctx.operation) askDiscard(ctx, done); }
    });
    return entered;
  }
  // Reads and cancellations are bounded; a correction submit lets mSubmit finish its
  // existing stable-key offline fallback after its fetch is aborted at 60 seconds.
  function request(ctx, task, ms) {
    var controller = new AbortController(); ctx.controllers.add(controller);
    return new Promise(function (resolve, reject) {
      var finished = false;
      function finish(ex, value) { if (finished) return; finished = true; clearTimeout(timer); ctx.controllers.delete(controller); controller.signal.removeEventListener('abort', aborted); if (ex) reject(ex); else resolve(value); }
      function aborted() { finish(new Error('The connection timed out or this sign-in ended.')); }
      var timer = setTimeout(function () { controller.abort(); }, ms);
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(function () { if (!same(ctx) || controller.signal.aborted) throw new Error('This sign-in ended.'); return task({ signal: controller.signal }); }).then(function (v) { finish(null, v); }, function (ex) { finish(ex); });
    });
  }
  function row(ctx, id) { return (ctx.rows || []).find(function (r) { return String(r.id) === String(id); }); }
  function detailState(ctx, id) { return ctx.details[id] || (ctx.details[id] = { id: String(id), fresh: false, confirm: false, uncertain: false, localCancel: false, error: '', feedback: '' }); }
  function load(ctx, force) {
    if (ctx.readJob) return ctx.readJob;
    if (!force && ctx.rows !== null) return Promise.resolve(true);
    var revision = ctx.revision; ctx.readError = '';
    ctx.readJob = request(ctx, function (opts) { return API.get('/me/time-corrections', opts); }, 20000).then(function (rows) {
      if (!same(ctx) || revision !== ctx.revision) return false;
      if (!Array.isArray(rows)) throw new Error('The request list could not be read.');
      ctx.rows = rows;
      Object.values(ctx.details).forEach(function (state) {
        state.fresh = true;
        if (state.uncertain) { state.uncertain = false; state.error = ''; state.feedback = 'Latest status checked. Review it before cancelling again.'; }
        if (row(ctx, state.id)?.status !== 'pending') state.confirm = false;
      });
      return true;
    }).catch(function (ex) {
      if (same(ctx)) { ctx.readError = message(ex, 'Could not load requests.'); Object.values(ctx.details).forEach(function (s) { s.fresh = false; }); if (ex.status === 401 || ex.status === 403) ctx.rows = null; }
      return false;
    }).finally(function () {
      ctx.readJob = null;
      if (same(ctx) && revision !== ctx.revision && ctx.screen !== 'form') load(ctx, true);
      if (alive(ctx) && ctx.screen !== 'form') draw(ctx);
    });
    return ctx.readJob;
  }
  function bind(ctx, selector, fn) {
    ctx.active.root.querySelectorAll(selector).forEach(function (button) { button.onclick = function () { if (canAct(ctx, button)) fn(button); }; });
  }
  function showList(ctx, restoreId, force) {
    ctx.screen = 'list'; ctx.restoreId = restoreId || null; load(ctx, !!force); draw(ctx);
  }
  function openDetail(ctx, id) {
    ctx.screen = 'detail'; ctx.detailId = String(id);
    var state = detailState(ctx, id); state.fresh = false; state.confirm = false;
    load(ctx, true); draw(ctx); focus(ctx, 'h1');
  }
  function draw(ctx) {
    if (!alive(ctx)) return;
    if (ctx.screen === 'form') drawForm(ctx);
    else if (ctx.screen === 'detail') drawDetail(ctx);
    else drawList(ctx);
  }
  function drawList(ctx) {
    MApp.setTitle('Fix a punch'); var root = ctx.active.root, old = document.activeElement, id = old?.dataset.tfId, hadFocus = root.contains(old);
    root.innerHTML = '<h1>Your requests</h1><p class="m-tf-intro">Ask HR or your department head to review a missed or incorrect punch.</p><button type="button" class="m-btn" id="m-tf-new">＋ Report a punch correction</button>' +
      '<div class="m-tf-section-line"><h2>Recent corrections</h2><button type="button" class="m-tf-text-button" data-tf-refresh' + (ctx.readError ? '' : ' hidden tabindex="-1" aria-hidden="true"') + (ctx.readJob ? ' disabled' : '') + '>' + (ctx.readJob ? 'Refreshing…' : ctx.readError ? 'Retry' : 'Refresh') + '</button></div>' +
      errorHTML(ctx.readError + (ctx.readError && ctx.rows !== null ? ' Last loaded requests are shown.' : '')) + '<div aria-busy="' + !!ctx.readJob + '">' + (ctx.rows === null ? '<p class="m-hint" role="status">' + (ctx.readJob ? 'Loading your requests…' : 'Your requests could not be loaded. Use Retry above.') + '</p>' : !ctx.rows.length ? '<div class="m-empty" role="status"><h2>No corrections yet</h2><p>Need to fix a missed or incorrect punch? Start a request above.</p></div>' : '<ul class="m-tf-requests">' + ctx.rows.map(function (r) { return '<li><button class="m-tf-request" type="button" data-tf-id="' + mEsc(r.id) + '"><span class="m-tf-row-top"><b>' + mEsc(dateText(r.work_date)) + '</b>' + badge(r) + '</span><span>' + mEsc([r.requested_in ? 'Time in · ' + r.requested_in : '', r.requested_out ? 'Time out · ' + r.requested_out : ''].filter(Boolean).join(' / ')) + '</span><small>#' + mEsc(r.id) + ' · View request <span aria-hidden="true">›</span></small></button></li>'; }).join('') + '</ul><p class="m-hint">Latest 100 requests. Open a request to check its decision or withdraw it while pending.</p>') + '</div>';
    bind(ctx, '#m-tf-new', function () { ctx.screen = 'form'; ctx.draft = { data: {}, fields: {}, error: '', leave: null, receipt: null }; draw(ctx); focus(ctx, 'h1'); });
    bind(ctx, '[data-tf-refresh]', function () { if (!ctx.readJob) { load(ctx, true); draw(ctx); } });
    window.mScreenUX?.bindRefresh(root,async function(){var ok=await load(ctx,true);return {ok:ok};},function(){return alive(ctx)&&ctx.screen==='list'&&!ctx.readJob;});
    bind(ctx, '[data-tf-id]', function (button) { openDetail(ctx, button.dataset.tfId); });
    if (ctx.restoreId || id) { var target = root.querySelector('[data-tf-id="' + (ctx.restoreId || id) + '"]'); if (target) target.focus({ preventScroll: true }); ctx.restoreId = null; }
    else if (hadFocus) focus(ctx, '[data-tf-refresh]');
  }
  function askDiscard(ctx, done) { ctx.draft.leave = { done: done }; draw(ctx); focus(ctx, '[data-tf-keep-draft]'); }
  function backFromForm(ctx) {
    if (dirty(ctx)) { askDiscard(ctx, null); return; }
    ctx.draft = null; showList(ctx, null, true); focus(ctx, 'h1');
  }
  function fieldHTML(d, key) {
    var required = key === 'work_date' || key === 'reason', id = 'm-tf-' + key, error = d.fields[key] || '';
    var attrs = ' class="m-input" id="' + id + '" data-k="' + key + '" name="' + key + '" aria-describedby="' + id + '-error' + (key === 'reason' ? ' m-tf-reason-help' : key.indexOf('requested_') === 0 ? ' m-tf-time-help' : '') + '"' + (error ? ' aria-invalid="true"' : '') + (required ? ' required' : '');
    return '<label class="m-field" for="' + id + '"><span class="m-label">' + LABELS[key] + (required ? ' *' : '') + '</span>' + (key === 'reason' ? '<textarea' + attrs + ' rows="3" minlength="3" maxlength="1000">' + mEsc(d.data[key] || '') + '</textarea>' : '<input' + attrs + ' type="' + (key === 'work_date' ? 'date' : 'time') + '" value="' + mEsc(d.data[key] || '') + '">') + '<span class="m-tf-field-error" id="' + id + '-error">' + mEsc(error) + '</span>' + (key === 'reason' ? '<small class="m-hint" id="m-tf-reason-help">Briefly explain what happened. 3–1,000 characters.</small>' : '') + '</label>';
  }
  function validate(data) {
    var errors = {}, date = new Date(String(data.work_date) + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.work_date || '') || isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== data.work_date) errors.work_date = 'Choose a valid work date.';
    if (!data.requested_in && !data.requested_out) errors.requested_in = 'Enter a time-in or a time-out.';
    ['requested_in', 'requested_out'].forEach(function (k) { if (data[k] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[k])) errors[k] = 'Enter a valid time.'; });
    var length = String(data.reason || '').trim().length;
    if (length < 3) errors.reason = 'Enter a reason of at least 3 characters.';
    else if (length > 1000) errors.reason = 'Keep the reason to 1,000 characters or fewer.';
    return errors;
  }
  function drawForm(ctx) {
    var d = ctx.draft, root = ctx.active.root, pending = !!ctx.operation;
    MApp.setTitle('Report a punch correction');
    if (d.receipt) { drawReceipt(ctx, d); return; }
    root.innerHTML = '<h1>Missed or incorrect punch</h1><p class="m-tf-intro">Use the date of the shift you want corrected. This sends a request for review.</p>' +
      '<form class="m-form" novalidate aria-busy="' + pending + '"><div data-tf-form-error>' + errorHTML(d.error) + '</div>' + FIELDS.map(function (k) { return fieldHTML(d, k); }).join('') +
      '<p class="m-hint" id="m-tf-time-help">Enter at least a time-in or a time-out. Your department head or HR will review it.</p><p class="m-hint">Offline requests wait in the phone’s sync queue. HR reviews them after they are sent.</p>' +
      (d.leave ? '<section class="m-tf-feedback" role="group" aria-label="Discard draft"><b>Discard your draft?</b><p>Your entered date, times and reason will be cleared.</p><div class="m-tf-actions"><button type="button" class="m-btn" data-tf-keep-draft>Keep editing</button><button type="button" class="m-btn m-btn-secondary" data-tf-discard>Discard draft</button></div></section>' : '') +
      (pending ? noteHTML('Submitting… Please wait before leaving or sending another copy.') : '') + '<div class="m-tf-actions"><button type="submit" class="m-btn"' + (pending ? ' disabled' : '') + '>' + (pending ? 'Submitting…' : 'Submit request') + '</button><button type="button" class="m-btn m-btn-secondary" data-tf-back' + (pending ? ' disabled' : '') + '>Back to requests</button></div></form>';
    var form = root.querySelector('form'); form.querySelectorAll('[data-k]').forEach(function (input) { input.disabled = pending; });
    form.addEventListener('input', function (event) {
      if (!canAct(ctx, form) || ctx.draft !== d) return;
      var key = event.target.dataset.k; if (!FIELDS.includes(key)) return;
      d.data[key] = event.target.value;
      var errors = validate(d.data);
      Object.keys(d.fields).forEach(function (k) { if (!errors[k]) { delete d.fields[k]; form.querySelector('[data-k="' + k + '"]').removeAttribute('aria-invalid'); form.querySelector('#m-tf-' + k + '-error').textContent = ''; } });
      if (!Object.keys(d.fields).length && d.error === 'Check the highlighted fields.') { d.error = ''; form.querySelector('[data-tf-form-error]').innerHTML = ''; }
    });
    form.onsubmit = function (event) {
      event.preventDefault(); if (!canAct(ctx, form) || ctx.draft !== d || d.receipt) return;
      FIELDS.forEach(function (k) { d.data[k] = form.querySelector('[data-k="' + k + '"]').value; });
      d.fields = validate(d.data);
      if (Object.keys(d.fields).length) { d.error = 'Check the highlighted fields.'; draw(ctx); focus(ctx, '[data-k="' + FIELDS.find(function (k) { return d.fields[k]; }) + '"]'); return; }
      submit(ctx, d);
    };
    bind(ctx, '[data-tf-back]', function () { backFromForm(ctx); });
    bind(ctx, '[data-tf-keep-draft]', function () { d.leave = null; draw(ctx); focus(ctx, '[data-k=reason]'); });
    bind(ctx, '[data-tf-discard]', function () { var done = d.leave.done; ctx.draft = null; ctx.screen = 'list'; if (done) done(); else { showList(ctx); focus(ctx, '#m-tf-new'); } });
  }
  async function submit(ctx, d) {
    var body = { work_date: d.data.work_date, requested_in: d.data.requested_in || null, requested_out: d.data.requested_out || null, reason: d.data.reason.trim() }, signature = JSON.stringify(body);
    if (d.signature !== signature) { d.signature = signature; d.key = requestKey(); }
    var op = ctx.operation = { kind: 'submit', controller: new AbortController() };
    ctx.controllers.add(op.controller); d.error = ''; d.leave = null; draw(ctx);
    var timer = setTimeout(function () { op.controller.abort(); }, 60000);
    try {
      var result = await mSubmit('/me/time-corrections', body, { label: 'Attendance correction · ' + body.work_date, idempotencyKey: d.key, signal: op.controller.signal, isCurrent: function () { return same(ctx); } });
      if (!same(ctx)) return;
      if (!result || (!result.queued && !result.response && !result.ok)) throw new Error('The submission response was incomplete.');
      ctx.revision++;
      d.receipt = result.queued ? { kind: 'queued', title: 'Saved on this phone', text: 'Saved to this phone’s queue for sending. Open Pending sync to check delivery before filing another copy.' } : result.local ? { kind: 'local', title: 'Saved on the site PC', text: 'Cloud confirmation is pending. Check site sync before filing another copy.' } : { kind: 'sent', title: 'Request submitted', text: 'Your department head or HR will review it. Your attendance changes only after approval.', id: result.response?.id };
    } catch (ex) { if (same(ctx)) d.error = 'Submission was not confirmed. ' + message(ex, 'Check your connection.') + ' Your entries are kept here. Check Requests or Pending sync before retrying after an interruption.'; }
    finally { clearTimeout(timer); ctx.controllers.delete(op.controller); if (ctx.operation === op) ctx.operation = null; if (alive(ctx) && ctx.screen === 'form' && ctx.draft === d) { draw(ctx); focus(ctx, d.error ? '[role=alert]' : 'h1'); } }
  }
  function drawReceipt(ctx, d) {
    var r = d.receipt;
    ctx.active.root.innerHTML = '<h1>' + mEsc(r.title) + '</h1>' + noteHTML(r.text) + '<ul class="m-tf-details"><li><span>Work date</span><b>' + mEsc(dateText(d.data.work_date)) + '</b></li>' + ['requested_in', 'requested_out'].filter(function (k) { return !!d.data[k]; }).map(function (k) { return '<li><span>' + LABELS[k] + '</span><b>' + mEsc(d.data[k]) + '</b></li>'; }).join('') + '</ul><div class="m-tf-actions">' +
      (r.kind === 'queued' ? '<button type="button" class="m-btn" data-tf-queue>View Pending sync</button>' : r.kind === 'sent' && r.id != null ? '<button type="button" class="m-btn" data-tf-view-created>View request</button>' : '') + '<button type="button" class="m-btn m-btn-secondary" data-tf-back>Back to requests</button></div>';
    bind(ctx, '[data-tf-queue]', function () { MApp.go('queue'); });
    bind(ctx, '[data-tf-back]', function () { ctx.draft = null; showList(ctx, null, true); focus(ctx, 'h1'); });
    bind(ctx, '[data-tf-view-created]', function () { ctx.draft = null; openDetail(ctx, r.id); });
  }
  function drawDetail(ctx) {
    var root = ctx.active.root, state = detailState(ctx, ctx.detailId), r = row(ctx, state.id), pending = !!ctx.operation;
    MApp.setTitle('Correction #' + state.id);
    var old = document.activeElement, hadFocus = root.contains(old);
    if (!r) {
      root.innerHTML = '<h1>Correction #' + mEsc(state.id) + '</h1>' + errorHTML(ctx.readError) + '<p class="m-tf-feedback" role="status">' + (ctx.readJob ? 'Loading the latest request…' : ctx.rows === null ? 'This request could not be loaded.' : 'This request is not in your latest 100 requests. It may be unavailable or older than this list.') + '</p>' + detailActions(ctx, state, null);
    } else {
      var local = state.localCancel, allowCancel = r.status === 'pending' && !state.uncertain && !local;
      var info = r.status === 'pending' ? 'Pending review. Your attendance has not been changed by this request.' : r.status === 'approved' ? 'Approved by your reviewer.' : r.status === 'rejected' ? 'This correction was not approved. Check the review note before filing another request.' : 'This request has been withdrawn.';
      root.innerHTML = '<h1>' + mEsc(dateText(r.work_date)) + '</h1><p class="m-tf-meta">Correction #' + mEsc(r.id) + ' ' + badge(r) + '</p><ul class="m-tf-details">' +
        [['Work date', dateText(r.work_date)], ['Time in', r.requested_in], ['Time out', r.requested_out], ['Submitted', stamp(r.created_at)], ['Decided by', r.decided_by_name], ['Decision date', stamp(r.decided_at)]].filter(function (pair) { return !!pair[1]; }).map(function (pair) { return '<li><span>' + pair[0] + '</span><b>' + mEsc(pair[1]) + '</b></li>'; }).join('') + '</ul><section class="m-tf-copy"><h2>Your reason</h2><p>' + mEsc(r.reason) + '</p></section>' +
        (r.decision_note ? '<section class="m-tf-copy"><h2>Review note</h2><p>' + mEsc(r.decision_note) + '</p></section>' : '') + noteHTML(info) + errorHTML(ctx.readError + (ctx.readError ? ' Last loaded details are shown. Refresh before cancelling.' : '')) + errorHTML(state.error) + noteHTML(state.feedback) +
        (state.confirm && allowCancel ? '<section class="m-tf-feedback" role="group" aria-label="Confirm cancellation"><b>Cancel correction #' + mEsc(r.id) + '?</b><p>Withdraw the request for ' + mEsc(dateText(r.work_date)) + '. This does not erase an existing punch.</p><div class="m-tf-actions"><button type="button" class="m-btn" data-tf-cancel-keep' + (pending ? ' disabled' : '') + '>Keep request</button><button type="button" class="m-btn m-btn-secondary" data-tf-cancel-confirm' + (pending || ctx.readJob || !state.fresh ? ' disabled' : '') + '>' + (pending ? 'Cancelling…' : 'Confirm cancellation') + '</button></div></section>' : '') + detailActions(ctx, state, r);
    }
    bind(ctx, '[data-tf-back]', function () { showList(ctx, state.id); });
    bind(ctx, '[data-tf-check-status]', function () { if (!ctx.readJob) { state.confirm = false; state.fresh = false; load(ctx, true); draw(ctx); } });
    bind(ctx, '[data-tf-cancel-start]', function () { if (state.fresh && !ctx.readJob && !ctx.readError && r.status === 'pending' && !state.localCancel && !state.uncertain) { state.confirm = true; state.error = ''; draw(ctx); focus(ctx, '[data-tf-cancel-keep]'); } });
    bind(ctx, '[data-tf-cancel-keep]', function () { state.confirm = false; draw(ctx); focus(ctx, '[data-tf-cancel-start]'); });
    bind(ctx, '[data-tf-cancel-confirm]', function () { if (state.confirm && state.fresh && !ctx.readJob && !ctx.readError && !state.uncertain && r?.status === 'pending') cancel(ctx, state, r); });
    if (hadFocus && !pending) focus(ctx, '[data-tf-check-status]');
  }
  function detailActions(ctx, state, r) {
    var pending = !!ctx.operation;
    return '<div class="m-tf-actions">' + (r?.status === 'pending' && !state.confirm && !state.uncertain && !state.localCancel ? '<button type="button" class="m-btn m-btn-warn" data-tf-cancel-start' + (pending || ctx.readJob || !state.fresh || ctx.readError ? ' disabled' : '') + '>Cancel request</button>' : '') +
      '<button type="button" class="m-btn m-btn-secondary" data-tf-check-status' + (pending || ctx.readJob ? ' disabled' : '') + '>' + (ctx.readJob ? 'Checking status…' : 'Check latest status') + '</button><button type="button" class="m-btn m-btn-secondary" data-tf-back' + (pending ? ' disabled' : '') + '>Back to requests</button></div>';
  }
  async function cancel(ctx, state, r) {
    var op = ctx.operation = { kind: 'cancel', id: state.id }; state.error = ''; state.feedback = ''; draw(ctx);
    try {
      var result = await request(ctx, function (opts) { return API.post('/me/time-corrections/' + encodeURIComponent(state.id) + '/cancel', undefined, opts); }, 30000);
      if (!same(ctx)) return;
      if (!result?.ok || result.status !== 'cancelled') throw new Error('The cancellation response was incomplete.');
      ctx.revision++; r.status = 'cancelled'; state.confirm = false; state.localCancel = !!API.syncLocal?.(result);
      state.feedback = state.localCancel ? 'Cancellation saved on the site PC. Cloud confirmation is pending.' : 'Request cancelled.';
    } catch (ex) { if (same(ctx)) { state.confirm = false; state.uncertain = true; state.fresh = false; state.error = 'Cancellation was not confirmed. ' + message(ex, 'Check your connection.') + ' Check the latest status before trying another cancellation.'; } }
    finally { if (ctx.operation === op) ctx.operation = null; if (alive(ctx) && ctx.screen === 'detail' && ctx.detailId === state.id) { draw(ctx); focus(ctx, state.error ? '[role=alert]' : '[role=status]'); } }
  }
  window.addEventListener('beforeunload', function (e) { if (session && same(session) && (session.operation || dirty(session))) { e.preventDefault(); e.returnValue = ''; } });
  MApp.route('time-fix', function (view) {
    var ctx = context(), entered = mount(ctx, view);
    if (!ctx.operation && ctx.screen !== 'form') { if (ctx.screen === 'detail' && entered) detailState(ctx, ctx.detailId).fresh = false; load(ctx, entered); }
    draw(ctx);
  });
})();
