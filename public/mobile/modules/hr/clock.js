/* Timekeeping — Figma node 46:577 (adapted 2026-10-10: slot tiles instead of the action
   dropdown + review screen, approved by Kyle; the Figma frame still shows the old flow).
   The employee picks what they're recording — the kiosk's four slots: Time in, Afternoon out,
   Afternoon in, Time out — and the rest runs by itself: scan the office QR (GPS is fetched
   meanwhile), an auto-captured selfie, done. Re-doing a slot replaces its time and photo.
   The server stays authoritative for QR validity, GPS/geofence and where the punch lands
   (src/modules/hr/punch-holds.ts, clock.ts setSlotPunch). */
(function () {
  var ticker = null;
  var SLOTS = [
    { key: 'in', label: 'Time in', kind: 'in' },
    { key: 'lunchOut', label: 'Afternoon out', kind: 'out' },
    { key: 'lunchIn', label: 'Afternoon in', kind: 'in' },
    { key: 'out', label: 'Time out', kind: 'out' }
  ];
  var SEG_LABEL = {
    morning_in: 'Time in', lunch_out: 'Afternoon out', afternoon_in: 'Afternoon in',
    afternoon_out: 'Time out', other_in: 'Time in', other_out: 'Time out'
  };
  var WHERE_KEY = 'vds_m_clock_where'; // clock_anywhere staff: 'office' (scan QR) | 'outside'
  var SELFIE_SECONDS = 2;

  function slotDef(key) { return SLOTS.filter(function (x) { return x.key === key; })[0]; }

  function chime(kind) {
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var notes = kind === 'in' ? [523, 659, 784] : [784, 659, 523];
      notes.forEach(function (f, i) {
        var osc = ac.createOscillator(), gain = ac.createGain();
        osc.frequency.value = f; osc.type = 'sine'; osc.connect(gain); gain.connect(ac.destination);
        var at = ac.currentTime + i * .12;
        gain.gain.setValueAtTime(.0001, at);
        gain.gain.exponentialRampToValueAtTime(.25, at + .02);
        gain.gain.exponentialRampToValueAtTime(.0001, at + .18);
        osc.start(at); osc.stop(at + .2);
      });
    } catch (e) {}
  }
  function dateText(d) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  }
  function timeText(d) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  }
  function getWhere(ctx) {
    if (API.isSharedSession?.()) return ctx.where || 'office';
    try { return localStorage.getItem(WHERE_KEY + ':' + ctx.account) === 'outside' ? 'outside' : 'office'; } catch (e) { return 'office'; }
  }
  function setWhere(ctx, v) { ctx.where = v; if (API.isSharedSession?.()) return; try { localStorage.setItem(WHERE_KEY + ':' + ctx.account, v); } catch (e) {} }
  function noticeText(s, remote) {
    if (remote) return 'Outside the office: your GPS location and a selfie are kept for HR.';
    if (s.location_required) return 'Scan the office QR, then a selfie is taken. Your location is checked — time-in only works at the office.';
    return 'Scan the office QR, then a selfie is taken. Your time is the moment you scan.';
  }
  function startLiveClock(root) {
    if (ticker) clearInterval(ticker);
    function paint() {
      if (!root.isConnected) { stopTicker(); return; }
      var now = new Date();
      var time = root.querySelector('[data-live-time]');
      var date = root.querySelector('[data-live-date]');
      if (time) time.textContent = timeText(now);
      if (date) date.textContent = dateText(now);
    }
    paint();
    ticker = setInterval(paint, 1000);
  }
  function logRow(p) {
    return '<li><span><b>' + mEsc(SEG_LABEL[p.segment] || p.segment) + '</b><small>' +
      mEsc(p.source ? p.source.replace(/_/g, ' ') : 'Recorded') + '</small></span><time>' +
      mEsc(p.at || '') + '</time></li>';
  }

  var session = null, nextAttempt = 0;
  var READ_MS = 20000, SCAN_MS = 30000, UPLOAD_MS = 60000;
  function identity() { var me = MApp.getMe() || {}; return JSON.stringify([me.id || 'guest', API.getToken?.() || '', !!API.isSharedSession?.()]); }
  function same(ctx) { return session === ctx && ctx.identity === identity(); }
  function alive(ctx) { return same(ctx) && ctx.active?.root.isConnected && ctx.active.hash === location.hash; }
  function current(ctx, a) { return alive(ctx) && ctx.attempt === a; }
  function stopTicker() { if (ticker) clearInterval(ticker); ticker = null; }
  function abortJobs(owner) { owner?.controllers?.forEach(function (c) { c.abort(); }); }
  function cleanupAttempt(a) { if (!a) return; a.scanner?.close(); a.camera?.cancel?.(); abortJobs(a); a.body = null; a.hold = null; }
  function cancelAttempt(ctx, note) {
    var a = ctx.attempt; if (!a || a.phase === 'upload') return;
    ctx.attempt = null; cleanupAttempt(a); ctx.notice = note || 'Capture cancelled. No new punch was completed.';
    if (alive(ctx)) { paint(ctx); focusSlot(ctx, a.d.key); }
  }
  function depart(ctx) {
    if (!ctx.active) return;
    ctx.active = null; stopTicker();
    var a = ctx.attempt;
    if (a?.phase === 'upload') {
      a.phase = 'uncertain'; a.error = 'Recording was not confirmed before this screen closed. Check the latest record before trying another punch.';
      ctx.recovery = a;
    } else if (a?.phase !== 'uncertain') ctx.attempt = null;
    cleanupAttempt(a); abortJobs(ctx);
  }
  function context() {
    var key = identity();
    if (!session || session.identity !== key) {
      if (session) { depart(session); session.observer.disconnect(); }
      var me = MApp.getMe() || {};
      var ctx = session = { identity: key, account: String(me.id || 'guest'), active: null, status: null, statusJob: null, statusError: '', notice: '', controllers: new Set(), attempt: null, recovery: null };
      ctx.observer = new MutationObserver(function () { if (ctx.active && !alive(ctx)) depart(ctx); });
      ctx.observer.observe(document.body, { childList: true, subtree: true });
    }
    return session;
  }
  window.addEventListener('hashchange', function () { queueMicrotask(function () { if (session?.active && !alive(session)) depart(session); }); });
  window.addEventListener('beforeunload', function (event) { if (session && same(session) && session.attempt?.phase === 'upload') { event.preventDefault(); event.returnValue = ''; } });
  function mount(view) {
    var ctx = context();
    if (!ctx.active?.root.isConnected || ctx.active.hash !== location.hash) {
      stopTicker(); view.innerHTML = '<section class="m-clock-capture" data-figma-node="46:577"></section>';
      ctx.active = { root: view.firstElementChild, hash: location.hash, view: view };
      ctx.needsRefresh = true;
    }
    window.mPersonalDraft?.arm(function () { return false; }, function () { return same(ctx) && ctx.attempt?.phase === 'upload'; }, { busyText: function () { return 'Please wait for the recording result. Do not submit the punch again.'; } });
    return ctx;
  }
  function bounded(ctx, owner, task, ms) {
    var controller = new AbortController(); owner.controllers.add(controller);
    return new Promise(function (resolve, reject) {
      var settled = false, timedOut = false;
      function finish(err, data) { if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); owner.controllers.delete(controller); if (err) reject(err); else resolve(data); }
      function aborted() { var error = new Error(timedOut ? 'The connection timed out.' : 'Capture cancelled.'); error.timeout = timedOut; error.cancelled = !timedOut; finish(error); }
      var timer = setTimeout(function () { timedOut = true; controller.abort(); }, ms);
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(function () { if (!same(ctx) || controller.signal.aborted) throw new Error('Capture cancelled.'); return task({ signal: controller.signal }); }).then(function (data) { finish(null, data); }, function (err) { finish(err); });
    });
  }
  function errorText(error, fallback) { var text = String(error?.message || fallback).trim(); return /[.!?…]$/.test(text) ? text : text + '.'; }
  function errorHTML(text) { return text ? '<p class="m-error m-clock-feedback" role="alert" tabindex="-1">' + mEsc(text) + '</p>' : ''; }
  function workDate(s) { return s?.slot_date || s?.work_date || ''; }
  function displayDate(date) { if (!date) return ''; var d = new Date(date + 'T00:00:00'); return isNaN(d.getTime()) ? String(date) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function focusSlot(ctx, key) { ctx.active?.root.querySelector('[data-slot="' + key + '"]')?.focus({ preventScroll: true }); }
  function refresh(ctx, force) {
    if (ctx.statusJob || (!force && ctx.status)) return;
    ctx.statusError = '';
    ctx.statusJob = bounded(ctx, ctx, function (opts) { return API.get('/hr/clock/my-status', opts); }, READ_MS).then(function (s) { if (same(ctx)) ctx.status = s; }).catch(function (ex) {
      if (!same(ctx) || ex.cancelled) return;
      ctx.statusError = errorText(ex, 'Could not load your clock.'); if (ex.status === 401 || ex.status === 403) ctx.status = null;
    }).finally(function () { ctx.statusJob = null; if (alive(ctx) && !ctx.attempt) paint(ctx); });
  }
  function paint(ctx) {
    if (!alive(ctx)) return;
    var a = ctx.attempt;
    if (!a || a.phase === 'qr') drawDashboard(ctx);
    else if (a.phase === 'receipt') drawReceipt(ctx, a);
    else drawProgress(ctx, a);
  }
  function drawDashboard(ctx) {
    var root = ctx.active.root, s = ctx.status;
    stopTicker();
    if (!s) {
      root.innerHTML = errorHTML(ctx.statusError) + '<p class="m-hint" role="status">' + (ctx.statusJob ? 'Loading timekeeping…' : 'Your clock could not be loaded.') + '</p>' + (!ctx.statusJob ? '<button class="m-btn" data-retry>Retry</button>' : '');
      root.querySelector('[data-retry]')?.addEventListener('click', function () { if (alive(ctx) && !ctx.statusJob) { refresh(ctx, true); paint(ctx); } }); return;
    }
    var slots = s.slots || {}, day = workDate(s), earlier = day && day !== today();
    root.innerHTML = '<section class="v2-clock"><header class="v2-clock-heading"><h1>Timekeeping</h1><p>Tap what you’re recording — then scan and smile</p></header>' +
      '<section class="v2-live-time"><strong data-live-time>--:--:--</strong><p data-live-date></p><span>' + mEsc(s.slots?.out ? 'Shift completed' : s.clocked_in ? 'Clocked in' : 'Not clocked in') + '</span></section>' +
      (day ? '<p class="m-clock-work-date">' + (earlier ? 'Open shift · ' : 'Work date · ') + mEsc(displayDate(day)) + '</p>' : '') +
      (ctx.notice ? '<p class="m-clock-feedback" role="status">' + mEsc(ctx.notice) + '</p>' : '') + errorHTML(ctx.statusError + (ctx.statusError ? ' Last loaded slots are shown. Refresh before recording.' : '')) +
      (ctx.recovery ? '<div class="m-clock-feedback"><p>The last recording did not return a confirmation. Check the latest record before recording again.</p><button type="button" class="m-btn m-btn-secondary" data-open-recovery>Check latest record</button></div>' : '') +
      (s.can_clock_anywhere ? '<div class="v2-clock-where" role="group" aria-label="Where are you?"><button type="button" data-where="office">At the office</button><button type="button" data-where="outside">Outside the office</button></div>' : '') +
      '<h2>Record</h2><div class="v2-clock-slots">' + SLOTS.map(function (d) { return '<button type="button" class="v2-clock-slot' + (slots[d.key] ? ' is-filled' : '') + (s.next_slot === d.key ? ' is-next' : '') + '" data-slot="' + d.key + '"' + (ctx.statusJob || ctx.statusError || ctx.attempt || ctx.recovery ? ' disabled' : '') + '><span>' + mEsc(d.label) + (s.next_slot === d.key ? ' <i>Next</i>' : '') + '</span><b>' + mEsc(slots[d.key] || '–') + '</b></button>'; }).join('') + '</div>' +
      '<div class="v2-clock-replace" role="group" aria-label="Confirm replacement" hidden></div><section class="v2-clock-notice"><p></p></section><button type="button" class="v2-clock-fix">Fix a missed or incorrect punch on another day</button>' +
      '<h2 class="v2-clock-log-title">' + (day ? 'Shift log · ' + mEsc(displayDate(day)) : 'Today’s log') + '</h2>' + ((s.punches || []).length ? '<ul class="v2-clock-log">' + s.punches.map(logRow).join('') + '</ul>' : '<div class="v2-clock-empty"><span><b>No entries yet</b><small>Tap Time in to begin this shift’s record</small></span></div>') +
      '<button type="button" class="m-btn m-btn-secondary m-clock-refresh" data-refresh-status' + (ctx.statusJob || ctx.attempt ? ' disabled' : '') + '>' + (ctx.statusJob ? 'Refreshing…' : ctx.statusError ? 'Retry status' : 'Refresh status') + '</button></section>';
    var page = root.firstElementChild, where = s.can_clock_anywhere ? getWhere(ctx) : 'office';
    function canStart() { return alive(ctx) && !ctx.attempt && !ctx.recovery && !ctx.statusJob && !ctx.statusError; }
    function paintWhere() { page.querySelector('.v2-clock-notice p').textContent = noticeText(s, where === 'outside'); page.querySelectorAll('[data-where]').forEach(function (button) { var on = button.dataset.where === where; button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); button.disabled = !!ctx.attempt; }); }
    paintWhere();
    page.querySelectorAll('[data-where]').forEach(function (button) { button.onclick = function () { if (canStart()) { where = button.dataset.where; setWhere(ctx, where); paintWhere(); } }; });
    page.querySelector('.v2-clock-fix').onclick = function () { if (alive(ctx) && !ctx.attempt) MApp.go('time-fix'); };
    root.querySelector('[data-open-recovery]')?.addEventListener('click', function () { if (alive(ctx) && !ctx.attempt) { ctx.attempt = ctx.recovery; paint(ctx); } });
    page.querySelector('[data-refresh-status]').onclick = function () { if (alive(ctx) && !ctx.attempt && !ctx.statusJob) { refresh(ctx, true); paint(ctx); } };
    page.querySelectorAll('[data-slot]').forEach(function (tile) { tile.onclick = function () {
      if (!canStart()) return;
      var d = slotDef(tile.dataset.slot), at = slots[d.key], replace = page.querySelector('.v2-clock-replace');
      if (!at) { start(ctx, s, d, where === 'outside'); return; }
      replace.hidden = false; replace.innerHTML = '<p>Replace your <b>' + mEsc(d.label.toLowerCase()) + '</b> at ' + mEsc(at) + '? The new time and selfie replace the old ones.</p><div><button type="button" class="m-btn" data-replace>Replace</button><button type="button" class="m-btn m-btn-secondary" data-keep>Keep ' + mEsc(at) + '</button></div>';
      replace.querySelector('[data-replace]').onclick = function () { if (canStart()) start(ctx, s, d, where === 'outside'); };
      replace.querySelector('[data-keep]').onclick = function () { if (alive(ctx)) { replace.hidden = true; tile.focus(); } };
      replace.querySelector('[data-keep]').focus();
    }; });
    startLiveClock(page);
  }
  function start(ctx, s, d, remote) {
    if (!alive(ctx) || ctx.attempt || ctx.recovery || ctx.statusJob) return;
    stopTicker(); ctx.notice = '';
    var a = ctx.attempt = { id: ++nextAttempt, d: d, base: s, remote: !!(remote && s.can_clock_anywhere), phase: 'qr', error: '', controllers: new Set(), hold: null, body: null, latest: null, verified: false };
    // Location overlaps QR scanning, but cannot trigger a request after this attempt ends.
    if (a.remote || s.location_required) a.location = locate(ctx, a);
    if (a.remote) { process(ctx, a); return; }
    paint(ctx);
    var scanner = mScanner.open({ key: 'clock-' + a.id, title: 'Scan the office screen — ' + d.label, manualLabel: 'Current office code', isCurrent: function () { return current(ctx, a) && a.phase === 'qr'; }, onClose: function (reason) { if (reason !== 'result' && current(ctx, a) && a.phase === 'qr') cancelAttempt(ctx); }, onResult: function (code) {
      if (!current(ctx, a) || a.phase !== 'qr') return;
      code = String(code || '').trim(); if (!code) return;
      a.body = { code: code }; process(ctx, a);
    } });
    // Some integrations synchronously supply a code instead of showing the scanner.
    if (current(ctx, a) && a.phase === 'qr') a.scanner = scanner;
  }
  function locate(ctx, a) {
    return bounded(ctx, a, function () { return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve({ error: 'This phone can’t share its location.' }); return; }
      navigator.geolocation.getCurrentPosition(function (p) { resolve({ location: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy } }); }, function (err) { resolve({ error: err?.code === 1 ? 'Location is blocked — allow location for this site, then retry.' : 'Could not get your location — turn on GPS and retry.' }); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }); }, READ_MS + 1000).catch(function (ex) { return { error: errorText(ex, 'Could not get your location.') }; });
  }
  async function process(ctx, a) {
    if (!current(ctx, a) || a.processing) return;
    a.processing = true;
    try {
      var body = a.body || {};
      if (a.remote || a.base.location_required) {
        a.phase = 'gps'; a.error = ''; paint(ctx);
        var loc = await (a.location || (a.location = locate(ctx, a)));
        if (!current(ctx, a)) return;
        if (loc.error) { a.phase = 'gps-error'; a.error = loc.error + ' No new punch has been recorded.'; paint(ctx); return; }
        body.location = loc.location;
      }
      if (!current(ctx, a)) return;
      a.phase = 'scan'; a.error = ''; paint(ctx);
      var started = Date.now();
      var hold = await bounded(ctx, a, function (opts) { return API.post('/hr/clock/punch/scan', body, opts); }, SCAN_MS);
      if (!current(ctx, a)) return;
      if (!hold?.hold_id) throw new Error('The scan could not be confirmed. Scan the current code again.');
      a.hold = hold; a.expiresAt = started + (Number(hold.expires_in_s) || 300) * 1000; a.body = null;
      a.phase = 'selfie'; paint(ctx);
      a.camera = mSelfie.take({ key: 'clock-' + a.id, title: a.d.label + ' — selfie', note: 'Look at the camera — the photo takes itself.', auto: SELFIE_SECONDS, expiresAt: a.expiresAt, isCurrent: function () { return current(ctx, a) && a.phase === 'selfie'; } });
      var photo = await a.camera;
      if (!current(ctx, a)) return;
      if (Date.now() >= a.expiresAt) { var expired = new Error('That scan has expired — scan the office code again.'); expired.code = 'scan-expired'; throw expired; }
      a.phase = 'upload'; a.error = ''; paint(ctx);
      var fd = new FormData(); fd.append('hold_id', String(hold.hold_id)); fd.append('slot', a.d.key); fd.append('photo', photo, 'selfie.jpg');
      var r = await bounded(ctx, a, function (opts) { return API.upload('/hr/clock/punch/selfie', fd, opts); }, UPLOAD_MS);
      if (!current(ctx, a)) return;
      if (!r || typeof r.at !== 'string' || typeof r.work_date !== 'string') throw new Error('The recording response was incomplete.');
      a.receipt = r; a.local = !!API.syncLocal?.(r); a.phase = 'receipt'; a.hold = null; ctx.status = null;
      paint(ctx); chime(a.d.kind); ctx.active.root.querySelector('.m-success')?.focus();
      if (a.d.key === 'out' && !a.local) loadOT(ctx, a);
    } catch (ex) {
      if (!current(ctx, a)) return;
      if (a.phase === 'upload') { a.phase = 'uncertain'; a.error = 'Recording was not confirmed. ' + errorText(ex, 'The connection was interrupted.') + ' Check the latest record before trying another punch.'; ctx.recovery = a; a.hold = null; }
      else if (ex.message === 'cancelled') { cancelAttempt(ctx, 'Capture cancelled — a selfie is needed to finish.'); return; }
      else { a.phase = 'scan-error'; a.error = errorText(ex, 'Could not check this scan.') + ' No new punch has been recorded.'; a.hold = null; }
      paint(ctx); ctx.active.root.querySelector('[role="alert"]')?.focus();
    } finally { a.processing = false; }
  }
  function drawProgress(ctx, a) {
    stopTicker();
    var root = ctx.active.root, pending = ['gps', 'scan', 'selfie', 'upload'].indexOf(a.phase) >= 0, unknown = a.phase === 'uncertain';
    var labels = { gps: 'Checking your location…', scan: 'Checking your scan…', selfie: 'Look at the camera…', upload: 'Recording ' + a.d.label.toLowerCase() + '…' };
    root.innerHTML = '<section class="v2-clock-confirm"><h1>Timekeeping</h1><p>' + mEsc(a.d.label + (workDate(a.base) ? ' · ' + displayDate(workDate(a.base)) : '')) + '</p>' +
      '<dl><div><dt>Location</dt><dd>' + mEsc(a.phase === 'gps' ? 'Checking…' : a.phase === 'gps-error' ? 'Needs attention' : a.remote || a.base.location_required ? 'Checked for this attempt' : 'Not required for this scan') + '</dd></div><div><dt>Office code</dt><dd>' + mEsc(a.remote ? 'Outside-office permission' : a.hold ? 'Accepted · selfie required' : unknown ? 'Recording needs checking' : a.phase === 'gps' || a.phase === 'gps-error' ? 'Waiting for location' : a.phase === 'scan' ? 'Checking current code…' : 'Scan not confirmed') + '</dd></div><div><dt>Recording</dt><dd>' + mEsc(unknown ? 'Result not confirmed' : a.phase === 'upload' ? 'Sending selfie…' : 'Not complete yet') + '</dd></div></dl>' +
      (pending ? '<p class="m-clock-feedback" role="status">' + mEsc(labels[a.phase]) + '</p>' : '') + errorHTML(a.error) +
      (a.latest ? '<section class="m-clock-feedback" data-latest-clock><b>Latest record from the server</b><p>Work date · ' + mEsc(displayDate(workDate(a.latest))) + '</p><p>' + mEsc(a.d.label + ' · ' + (a.latest.slots?.[a.d.key] || 'No recorded time returned')) + '</p><p>This latest entry does not identify which upload created it. Review it before replacing a punch.</p></section>' : '') +
      (a.verifyPending ? '<p class="m-hint" role="status">Checking the latest record…</p>' : '') + '<div class="v2-clock-confirm-actions">' +
      (unknown ? '<button class="m-btn" type="button" data-check-latest' + (a.verifyPending ? ' disabled' : '') + '>' + (a.verifyPending ? 'Checking…' : 'Check latest record') + '</button><button class="m-btn m-btn-secondary" type="button" data-back-clock' + (a.verifyPending ? ' disabled' : '') + '>Back to timekeeping</button>' : !pending ? '<button class="m-btn" type="button" data-retry-capture>' + (a.phase === 'gps-error' ? 'Retry location' : a.remote ? 'Retry outside-office check' : 'Scan current code') + '</button><button class="m-btn m-btn-secondary" type="button" data-cancel-capture>Back to timekeeping</button>' : '<button class="m-btn m-btn-secondary" type="button" data-cancel-capture' + (a.phase === 'upload' ? ' disabled' : '') + '>' + (a.phase === 'upload' ? 'Please wait for the result…' : 'Cancel attempt') + '</button>') + '</div><p>Timekeeping needs a live connection. Punches are not saved in the phone’s offline queue.</p></section>';
    root.querySelector('[data-cancel-capture]')?.addEventListener('click', function () { if (current(ctx, a) && a.phase !== 'upload') cancelAttempt(ctx); });
    root.querySelector('[data-retry-capture]')?.addEventListener('click', function () {
      if (!current(ctx, a) || a.processing) return;
      if (a.phase === 'gps-error') { a.location = locate(ctx, a); process(ctx, a); }
      else { var base = a.base, d = a.d, remote = a.remote; ctx.attempt = null; cleanupAttempt(a); start(ctx, base, d, remote); }
    });
    root.querySelector('[data-back-clock]')?.addEventListener('click', function () {
      if (!current(ctx, a) || a.verifyPending) return;
      ctx.attempt = null; if (a.verified) ctx.recovery = null; cleanupAttempt(a); refresh(ctx, !ctx.status); paint(ctx);
    });
    root.querySelector('[data-check-latest]')?.addEventListener('click', function () { if (current(ctx, a)) checkLatest(ctx, a); });
  }
  async function checkLatest(ctx, a) {
    if (!current(ctx, a) || a.verifyPending) return;
    a.verifyPending = true; a.verified = false; paint(ctx);
    try {
      var s = await bounded(ctx, a, function (opts) { return API.get('/hr/clock/my-status', opts); }, READ_MS);
      if (!current(ctx, a)) return;
      a.latest = s; a.verified = true; ctx.status = s; ctx.statusError = '';
      a.error = 'The interrupted upload did not return a confirmation. Review the latest record below.';
    } catch (ex) { if (current(ctx, a)) a.error = 'Could not check the latest record. ' + errorText(ex, 'Check your connection.') + ' The recording result is still unclear. Retry this status check before another punch.'; }
    finally { a.verifyPending = false; if (current(ctx, a)) { paint(ctx); rootFocus(ctx, a.latest ? '[data-latest-clock]' : '[role="alert"]'); } }
  }
  function rootFocus(ctx, selector) { var el = ctx.active?.root.querySelector(selector); if (el) { el.tabIndex = -1; el.focus(); } }
  function drawReceipt(ctx, a) {
    stopTicker(); var root = ctx.active.root, r = a.receipt;
    if (root.dataset.receipt !== String(a.id)) {
      root.innerHTML = ''; root.dataset.receipt = String(a.id);
      var earlier = r.work_date !== today();
      mSuccess(root, { title: a.local ? a.d.label + ' saved on site PC' : a.d.label + (r.replaced ? ' updated' : ' recorded'), lines: [a.d.label + ' · ' + r.at, 'Work date · ' + displayDate(r.work_date), String(r.hours_today ?? '') + (earlier ? ' h — closes your ' + r.work_date + ' shift' : ' h for this shift')], actions: [
        { label: 'Done', onClick: function () { if (current(ctx, a)) { ctx.attempt = null; cleanupAttempt(a); MApp.go('home'); } } },
        { label: 'Today’s log', secondary: true, onClick: function () { if (current(ctx, a)) { ctx.attempt = null; cleanupAttempt(a); refresh(ctx, true); paint(ctx); } } }
      ] });
      root.querySelector('.m-success').tabIndex = -1;
      root.insertAdjacentHTML('beforeend', '<p class="m-clock-feedback" role="status">' + (a.local ? 'Saved on the site PC. Cloud confirmation is pending. Check site sync status before making another copy.' : 'Recording confirmed. Your scan time is kept; taking the selfie does not move that time.') + '</p>' + (a.d.key === 'out' ? '<section class="m-clock-ot" aria-label="Overtime follow-up"></section>' : ''));
    }
    var panel = root.querySelector('.m-clock-ot'); if (!panel) return;
    var hadFocus = panel.contains(document.activeElement), row = a.ot;
    panel.innerHTML = '<h2>Overtime follow-up</h2>' + (a.local ? '<p class="m-hint">Check overtime after the site PC record reaches the cloud.</p>' : a.otPending ? '<p class="m-hint" role="status">Checking unrecorded overtime… Your time-out result above is unchanged.</p>' : a.otError ? errorHTML('Overtime could not be checked. ' + a.otError + ' Your time-out result above is unchanged.') + '<button class="m-btn m-btn-secondary" type="button" data-retry-ot>Retry overtime check</button>' : row ? '<p class="m-clock-feedback">' + mEsc(Math.round(row.ot_minutes / 60 * 10) / 10 + ' h unrecorded overtime · ' + displayDate(r.work_date)) + '</p><button class="m-btn" type="button" data-request-ot>Request OT</button>' : '<p class="m-hint">No unrecorded overtime was returned for this work date.</p>');
    panel.querySelector('[data-retry-ot]')?.addEventListener('click', function () { if (current(ctx, a)) loadOT(ctx, a); });
    panel.querySelector('[data-request-ot]')?.addEventListener('click', function () { if (current(ctx, a)) { ctx.attempt = null; cleanupAttempt(a); MApp.go('requests', { type: 'overtime_request', date: r.work_date }); } });
    if (hadFocus) { panel.tabIndex = -1; (panel.querySelector('button') || panel).focus(); }
  }
  async function loadOT(ctx, a) {
    if (!current(ctx, a) || a.otPending || a.local) return;
    a.otPending = true; a.otError = ''; paint(ctx);
    try { var rows = await bounded(ctx, a, function (opts) { return API.get('/me/unrecorded-ot', opts); }, READ_MS); if (current(ctx, a)) a.ot = (rows || []).find(function (row) { return row.work_date === a.receipt.work_date; }) || null; }
    catch (ex) { if (current(ctx, a)) a.otError = errorText(ex, 'Check your connection.'); }
    finally { a.otPending = false; if (current(ctx, a)) paint(ctx); }
  }
  MApp.route('clock', function (view) { MApp.setTitle('Timekeeping'); var ctx = mount(view); if (!ctx.attempt && ctx.recovery) ctx.attempt = ctx.recovery; if (!ctx.attempt) refresh(ctx, ctx.needsRefresh); ctx.needsRefresh = false; paint(ctx); });

})();
