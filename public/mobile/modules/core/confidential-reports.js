/* Anonymous case handling. reports.confidential is required on both client and server.
   Reporter identity/access codes never enter this handler UI. Queue status is kept in the
   route; unsent handler replies stay only in this account/sign-in's open app. */
(function () {
  var STATUSES = ['new', 'triaged', 'investigating', 'resolved', 'closed'];
  var session = null;
  function label(value) { value = String(value || 'new'); return value.charAt(0).toUpperCase() + value.slice(1); }
  function filterValue(value) { return STATUSES.indexOf(value) !== -1 ? value : 'open'; }
  function sameSession(ctx) {
    return session === ctx && ctx.account === String((MApp.getMe() || {}).id || 'guest') && ctx.token === (API.getToken?.() || '') && ctx.shared === !!API.isSharedSession?.();
  }
  function current(ctx) { return sameSession(ctx) && MApp.can('reports.confidential'); }
  function closeViewer(ctx, id) {
    if (ctx.viewer && (id === undefined || ctx.viewer.id === id)) { if (ctx.viewer.overlay.isConnected) ctx.viewer.overlay.querySelector('[data-close]')?.click(); ctx.viewer = null; }
  }
  function releasePhotos(ctx, state) {
    closeViewer(ctx, state.id);
    Object.keys(state.photos).forEach(function (key) { var job = state.photos[key]; if (job.url) URL.revokeObjectURL(job.url); });
    state.photos = Object.create(null);
  }
  function dispose(ctx) { if (ctx) { closeViewer(ctx); Object.keys(ctx.cases).forEach(function (id) { releasePhotos(ctx, ctx.cases[id]); }); } }
  function context() {
    var account = String((MApp.getMe() || {}).id || 'guest'), token = API.getToken?.() || '', shared = !!API.isSharedSession?.();
    if (!session || session.account !== account || session.token !== token || session.shared !== shared) {
      dispose(session); session = { account: account, token: token, shared: shared, cases: Object.create(null), queues: Object.create(null), filter: 'open', active: null, viewer: null };
    }
    return session;
  }
  function busy(ctx) { return Object.keys(ctx.cases).some(function (id) { return !!ctx.cases[id].pending; }); }
  function activate(ctx, entry) {
    ctx.active = entry;
    mPersonalDraft.arm(function () { return false; }, function () { return busy(ctx); }, { busyText: function () { return 'Please wait for the case update to finish.'; } });
  }
  function paintActive(ctx) {
    if (!sameSession(ctx)) return;
    if (!MApp.can('reports.confidential')) {
      if (ctx.active?.host.isConnected) ctx.active.host.innerHTML = '<div class="m-error" role="alert">You don’t have access to anonymous reports.</div>';
      dispose(ctx); session = null; return;
    }
    if (ctx.active?.host.isConnected) {
      if (ctx.viewer?.overlay.isConnected && ctx.viewer.id === ctx.active.id) { ctx.active.needsPaint = true; return; }
      ctx.active.paint();
    }
  }
  function focusFeedback(ctx, id, selector) {
    if (current(ctx) && ctx.active?.id === id && ctx.active.host.isConnected) ctx.active.host.querySelector(selector)?.focus();
  }
  window.addEventListener('beforeunload', function (event) {
    var ctx = session;
    if (ctx && current(ctx) && (busy(ctx) || Object.keys(ctx.cases).some(function (id) { return !!ctx.cases[id].reply; }))) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('hashchange', function () {
    queueMicrotask(function () { var ctx = session; if (ctx?.active?.kind === 'detail' && !ctx.active.host.isConnected) releasePhotos(ctx, ctx.cases[ctx.active.id]); });
  });

  function shell(view, heading, sub, back) {
    view.innerHTML = '<section class="m-v2-page m-report-v2 m-cr-page"><header class="m-v2-heading m-report-heading">' +
      (back ? '<button class="m-report-back" type="button" aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(sub) + '</p></div></header><div id="m-cr-body"></div></section>';
    if (back) view.querySelector('.m-report-back').onclick = back;
    return view.querySelector('#m-cr-body');
  }

  function list(view, filter) {
    var ctx = context(); filter = filterValue(filter || ctx.filter); ctx.filter = filter;
    if (ctx.active?.kind === 'detail') releasePhotos(ctx, ctx.cases[ctx.active.id]);
    MApp.setTitle('Anonymous reports');
    var host = shell(view, 'Anonymous reports', 'No reporter identity is stored for these cases');
    host.innerHTML = '<div class="m-cr-filter" role="group" aria-label="Case status">' + ['open'].concat(STATUSES).map(function (value) {
      return '<button type="button" data-status="' + value + '" aria-pressed="' + (value === filter) + '"' + (value === filter ? ' class="on"' : '') + '>' + label(value) + '</button>';
    }).join('') + '</div><p class="m-hint">Opening a case marks its attached photos as seen by a handler. The reporter can no longer remove those photos.</p><div data-cr-list></div>';
    host.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    var out = host.querySelector('[data-cr-list]'), loading = false;
    activate(ctx, { kind: 'list', host: host, paint: function () {} });
    host.querySelectorAll('[data-status]').forEach(function (button) { button.onclick = function () { if (current(ctx) && host.isConnected && button.dataset.status !== filter) MApp.go('confidential-reports', { status: button.dataset.status }); }; });
    async function load() {
      if (loading || !current(ctx) || !host.isConnected) return;
      var restoreFocus = out.contains(document.activeElement); loading = true;
      out.setAttribute('aria-busy', 'true'); out.innerHTML = '<div class="m-hint" role="status">Loading reports…</div>';
      var job = ctx.queues[filter] || (ctx.queues[filter] = {});
      if (!job.pending) {
        job.pending = Promise.resolve().then(function () { return API.get('/confidential-reports' + (filter === 'open' ? '' : '?status=' + filter)); }).finally(function () { job.pending = null; });
      }
      try {
        var rows = await job.pending; if (!current(ctx) || !host.isConnected) return;
        var reports = (rows || []).filter(function (row) { return filter === 'open' ? row.status !== 'resolved' && row.status !== 'closed' : row.status === filter; });
        out.innerHTML = reports.length ? reports.map(function (row) {
          return '<button class="m-report-row" type="button" data-case="' + mEsc(row.id) + '"><span><b>' + mEsc(row.number + ' · ' + (row.subject || row.category)) + '</b><small>' + mEsc(row.category + ' · updated ' + row.updated_on + (row.reporter_replies ? ' · ' + row.reporter_replies + ' reporter message' + (row.reporter_replies === 1 ? '' : 's') : '') + (row.photo_count ? ' · ' + row.photo_count + ' photo' + (row.photo_count === 1 ? '' : 's') : '')) + '</small><span class="m-report-status">' + mEsc(label(row.status)) + '</span></span><i aria-hidden="true">›</i></button>';
        }).join('') : '<div class="m-empty">No ' + mEsc(filter) + ' reports.</div>';
        out.querySelectorAll('[data-case]').forEach(function (button) { button.onclick = function () { if (current(ctx) && button.isConnected) MApp.go('confidential-reports', { id: button.dataset.case, status: filter }); }; });
      } catch (error) {
        if (current(ctx) && host.isConnected) { out.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.offline ? 'You’re offline — reports can’t be loaded.' : error.message || 'Could not load reports.') + '</div><button class="m-v2-secondary" type="button" data-retry-queue>Retry reports</button>'; out.querySelector('button').onclick = load; }
      } finally {
        loading = false; out.removeAttribute('aria-busy');
        if (restoreFocus && current(ctx) && host.isConnected) { out.tabIndex = -1; (out.querySelector('button') || out).focus(); }
        if (sameSession(ctx) && !MApp.can('reports.confidential')) paintActive(ctx);
      }
    }
    load();
  }

  function detail(view, id, filter) {
    var ctx = context(), key = String(id); filter = filterValue(filter || ctx.filter); ctx.filter = filter;
    if (ctx.active?.kind === 'detail' && ctx.active.id !== key) releasePhotos(ctx, ctx.cases[ctx.active.id]);
    var state = ctx.cases[key] || (ctx.cases[key] = { id: key, report: null, selected: '', reply: '', replyVersion: 0, revision: 0, pending: null, loadJob: null, errors: {}, feedback: {}, photos: Object.create(null) });
    MApp.setTitle('Anonymous report');
    var host = shell(view, 'Anonymous report', 'Reply through the reporter’s access code only', function () { MApp.go('confidential-reports', { status: filter }); });
    function alive() { return current(ctx) && host.isConnected; }
    activate(ctx, { kind: 'detail', id: key, host: host, paint: render });
    function errorBlock(action) { return '<p class="m-error" data-cr-error="' + action + '" role="alert" tabindex="-1"' + (state.errors[action] ? '' : ' hidden') + '>' + mEsc(state.errors[action] || '') + '</p>'; }
    function feedback(action) { return '<p class="m-report-draft-state" data-cr-feedback="' + action + '" role="status" tabindex="-1">' + mEsc(state.pending === action ? action === 'status' ? 'Updating status…' : 'Sending reply…' : state.feedback[action] || '') + '</p>'; }
    function controls() {
      if (!alive()) return;
      view.querySelector('.m-report-back').disabled = !!state.pending;
      host.querySelectorAll('[data-refresh-case]').forEach(function (button) { button.disabled = !!state.pending || !!state.loadJob; button.textContent = state.loadJob ? 'Refreshing case…' : state.report ? state.loadError ? 'Retry case' : 'Refresh case' : 'Retry case'; });
      var status = host.querySelector('#m-cr-status'), reply = host.querySelector('#m-cr-reply');
      if (status) { status.querySelector('select').disabled = !!state.pending; status.querySelector('[type="submit"]').disabled = !!state.pending || state.selected === state.report.status; status.querySelector('[type="submit"]').textContent = state.pending === 'status' ? 'Updating status…' : 'Update status'; status.querySelector('[data-close-warning]').hidden = state.selected !== 'closed'; }
      if (reply) { reply.querySelector('textarea').disabled = !!state.pending; reply.querySelector('[type="submit"]').disabled = !!state.pending || !state.reply.trim(); reply.querySelector('[type="submit"]').textContent = state.pending === 'reply' ? 'Sending…' : 'Send reply'; }
    }
    function render() {
      if (!alive()) return;
      if (ctx.viewer?.id === key && ctx.viewer.overlay.isConnected) { ctx.active.needsPaint = true; return; }
      var focus = document.activeElement, selector = null, selection = null;
      if (host.contains(focus)) {
        if (focus.matches('#m-cr-reply textarea')) { selector = '#m-cr-reply textarea'; selection = [focus.selectionStart, focus.selectionEnd]; }
        else if (focus.matches('#m-cr-status select')) selector = '#m-cr-status select';
        else if (focus.dataset.crError) selector = '[data-cr-error="' + focus.dataset.crError + '"]';
        else if (focus.dataset.crFeedback) selector = '[data-cr-feedback="' + focus.dataset.crFeedback + '"]';
      }
      var r = state.report;
      var loadStatus = (state.loadJob ? '<p class="m-hint" role="status">' + (r ? 'Refreshing case…' : 'Loading report…') + '</p>' : '') + (state.loadError ? '<p class="m-error" data-cr-load-error role="alert">' + mEsc(state.loadError) + (r ? ' Your reply and last loaded case details are still here.' : '') + '</p>' : '') + (r || state.loadError ? '<button class="m-v2-secondary m-cr-refresh" type="button" data-refresh-case>Refresh case</button>' : '');
      if (!r) { host.innerHTML = loadStatus; host.querySelector('[data-refresh-case]')?.addEventListener('click', function () { load(); }); controls(); return; }
      host.innerHTML = '<span class="m-report-status m-cr-status-badge">' + mEsc(label(r.status)) + '</span><section class="m-report-review">' +
        '<div><span>' + mEsc(r.number) + '</span><b>' + mEsc(r.subject || r.category) + '</b></div><div><span>Category</span><b>' + mEsc(r.category) + '</b></div><div><span>Incident</span><b>' + mEsc([r.incident_date, r.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div><div><span>Filed · updated</span><b>' + mEsc(r.created_on) + ' · ' + mEsc(r.updated_on) + '</b></div></section>' +
        '<p class="m-cr-detail">' + mEsc(r.description) + '</p>' + loadStatus + '<h2 class="m-report-section-title">Report evidence</h2>' +
        ((r.attachments || []).length ? '<div class="m-thumbs" data-cr-photos="report"></div>' : '<p class="m-hint">No photos attached to the report.</p>') +
        '<form class="m-report-form m-cr-case-form" id="m-cr-status" novalidate><h2 class="m-report-section-title">Update status</h2><p class="m-hint">Current status · ' + mEsc(label(r.status)) + '</p><label><span>Status</span><select>' + STATUSES.map(function (value) { return '<option value="' + value + '"' + (value === state.selected ? ' selected' : '') + '>' + label(value) + '</option>'; }).join('') + '</select></label><p class="m-report-anon-notice" data-close-warning hidden>Closing stops new reporter messages. Handler replies remain available.</p>' + errorBlock('status') + feedback('status') + '<button class="m-v2-secondary" type="submit">Update status</button></form>' +
        '<h2 class="m-report-section-title">Conversation</h2><div class="m-anon-thread">' + (r.messages.length ? r.messages.map(function (message) { return '<div class="m-anon-msg ' + mEsc(message.author) + '"><small>' + (message.author === 'handler' ? mEsc(message.handler_name || 'Case handler') : 'Reporter') + ' · ' + mEsc(message.created_on) + '</small><p>' + mEsc(message.body) + '</p>' + ((message.attachments || []).length ? '<div class="m-thumbs" data-cr-photos="' + mEsc(message.id) + '"></div>' : '') + '</div>'; }).join('') : '<div class="m-empty">No messages yet. The reporter sees replies when they check with their access code.</div>') + '</div>' +
        '<form class="m-report-form m-cr-case-form" id="m-cr-reply" novalidate><label class="is-tall"><span>Reply to reporter</span><textarea rows="3" maxlength="3000" placeholder="The reporter sees this as “Case handler”">' + mEsc(state.reply) + '</textarea></label><p class="m-hint">Your unsent reply stays in this open app. Closing or reloading removes it. The reporter sees your reply as “Case handler” when they check with their number and access code.</p>' + errorBlock('reply') + feedback('reply') + '<button class="m-v2-primary" type="submit">Send reply</button></form>';
      host.querySelector('[data-refresh-case]').onclick = function () { load(); };
      fillPhotos('report', r.attachments || []);
      r.messages.forEach(function (message) { fillPhotos(message.id, message.attachments || []); });
      var status = host.querySelector('#m-cr-status'), reply = host.querySelector('#m-cr-reply');
      status.querySelector('select').onchange = function () { if (alive() && status.isConnected && !state.pending) { state.selected = this.value; controls(); } };
      status.onsubmit = function (event) { event.preventDefault(); if (status.isConnected && state.selected !== state.report.status) mutate('status', { status: state.selected }); };
      reply.querySelector('textarea').oninput = function () { if (alive() && reply.isConnected) { state.reply = this.value; state.replyVersion++; controls(); } };
      reply.onsubmit = function (event) { event.preventDefault(); if (!reply.isConnected) return; var body = reply.querySelector('textarea').value.trim(); if (!body || body.length > 3000) return; state.reply = reply.querySelector('textarea').value; mutate('reply', { body: body }); };
      controls();
      if (selector) { var next = host.querySelector(selector); if (next && !next.disabled && !next.hidden) { next.focus({ preventScroll: true }); if (selection) next.setSelectionRange(selection[0], selection[1]); } }
    }
    function fillPhotos(group, photos) {
      var strip = host.querySelector('[data-cr-photos="' + group + '"]'); if (!strip) return;
      photos.forEach(function (photo, index) {
        var photoKey = String(photo.id), job = state.photos[photoKey];
        if (job && job.source !== photo.url) { if (job.url) URL.revokeObjectURL(job.url); job = null; }
        if (!job) job = state.photos[photoKey] = { source: photo.url, url: null, pending: false, error: '' };
        var cell = mEl('<div class="m-cr-photo-cell"><button class="m-thumb" type="button" data-open-cr-photo aria-label="Open photo ' + (index + 1) + '"><img alt="Photo ' + (index + 1) + '" hidden></button><div data-photo-feedback></div></div>');
        var button = cell.querySelector('button'), image = cell.querySelector('img');
        function update() {
          if (!alive() || !cell.isConnected || state.photos[photoKey] !== job) return;
          image.hidden = !job.url; if (job.url && image.getAttribute('src') !== job.url) image.src = job.url; else if (!job.url) image.removeAttribute('src');
          button.disabled = !job.url;
          var feedbackBox = cell.querySelector('[data-photo-feedback]');
          feedbackBox.innerHTML = job.error ? '<p class="m-error" role="alert">' + mEsc(job.error) + '</p><button class="m-v2-secondary" type="button" data-retry-cr-photo>Retry photo</button>' : job.pending ? '<p class="m-hint" role="status">Loading photo…</p>' : '';
          feedbackBox.querySelector('button')?.addEventListener('click', loadPhoto);
        }
        async function loadPhoto() {
          if (!alive() || !cell.isConnected || job.pending || state.photos[photoKey] !== job) return;
          job.pending = true; job.error = ''; update();
          try {
            var url = await API.blobUrl(photo.url);
            if (!current(ctx) || state.photos[photoKey] !== job) { URL.revokeObjectURL(url); return; }
            job.url = url;
          } catch (error) { if (current(ctx) && state.photos[photoKey] === job) job.error = error.message || 'Photo could not be loaded.'; }
          finally { job.pending = false; job.update?.(); if (sameSession(ctx) && !MApp.can('reports.confidential')) paintActive(ctx); }
        }
        job.update = update;
        image.onerror = function () { if (!alive() || !cell.isConnected || !job.url) return; URL.revokeObjectURL(job.url); job.url = null; job.error = 'Photo could not be displayed.'; update(); };
        button.setAttribute('data-cr-photo-id', photoKey);
        button.onclick = function () {
          if (!alive() || !button.isConnected || !job.url) return;
          var overlay = PhotoViewer.open(job.url, 'Report photo ' + (index + 1) + ' · ' + state.report.number);
          if (ctx.viewer?.overlay === overlay) return;
          ctx.viewer = { id: key, overlay: overlay };
          var observer = new MutationObserver(function () {
            if (overlay.isConnected) return;
            observer.disconnect();
            if (ctx.viewer?.overlay !== overlay) return;
            ctx.viewer = null;
            if (current(ctx) && ctx.active?.id === key && ctx.active.host.isConnected) {
              if (ctx.active.needsPaint) { ctx.active.needsPaint = false; paintActive(ctx); }
              ctx.active.host.querySelector('[data-cr-photo-id="' + photoKey + '"]')?.focus();
            }
          });
          observer.observe(document.body, { childList: true });
        };
        strip.appendChild(cell); update(); if (!job.pending && !job.error && !job.url) loadPhoto();
      });
    }
    async function load() {
      if (!alive() || state.pending) return;
      if (!state.loadJob) {
        var revision = state.revision, previous = state.report;
        state.loadError = '';
        state.loadJob = Promise.resolve().then(function () { return API.get('/confidential-reports/' + encodeURIComponent(key)); }).then(function (report) {
          if (!current(ctx) || state.revision !== revision) return;
          if (!report || !Array.isArray(report.messages) || STATUSES.indexOf(report.status) === -1) throw new Error('Could not read this case. Try again.');
          state.report = report;
          if (!state.selected || (previous && state.selected === previous.status)) state.selected = report.status;
          var ids = (report.attachments || []).concat(...report.messages.map(function (message) { return message.attachments || []; })).map(function (photo) { return String(photo.id); });
          Object.keys(state.photos).forEach(function (id) { if (ids.indexOf(id) === -1) { if (state.photos[id].url) URL.revokeObjectURL(state.photos[id].url); delete state.photos[id]; } });
        }).catch(function (error) {
          if (!current(ctx) || state.revision !== revision) return;
          state.loadError = error.message || 'Could not load this case.';
          if (error.status === 403 || error.status === 404) { state.report = null; releasePhotos(ctx, state); }
        }).finally(function () { state.loadJob = null; if (ctx.active?.id === key) paintActive(ctx); });
      }
      render(); await state.loadJob;
    }
    async function mutate(action, body) {
      if (!alive() || state.pending || !state.report) return;
      var version = state.replyVersion; state.pending = action; state.revision++; state.errors[action] = ''; state.feedback[action] = ''; render();
      try {
        var result = await API.post('/confidential-reports/' + encodeURIComponent(key) + '/' + action, body);
        if (!current(ctx)) return;
        if (action === 'status') {
          if (!result || result.ok !== true || STATUSES.indexOf(result.status) === -1) throw new Error('Could not confirm the status response. Refresh the case before retrying.');
          state.report = { ...state.report, status: result.status }; state.selected = result.status; state.feedback.status = 'Status updated.';
        } else {
          if (!result || !Array.isArray(result.messages) || STATUSES.indexOf(result.status) === -1) throw new Error('Could not confirm the reply response.');
          var oldStatus = state.report.status; state.report = result; if (state.selected === oldStatus) state.selected = result.status;
          if (state.replyVersion === version) state.reply = ''; state.feedback.reply = 'Reply sent.';
        }
      } catch (error) {
        if (current(ctx)) {
          state.errors[action] = (error.message || 'Could not confirm the update.') + (action === 'reply' ? ' Your reply is still here. Check the conversation before retrying if the connection was interrupted.' : ' Your selection and unsent reply are still here. Refresh the case before retrying if the connection was interrupted.');
          if (error.status === 403 || error.status === 404) { state.loadError = error.message; state.report = null; releasePhotos(ctx, state); }
        }
      } finally {
        state.pending = null; state.revision++; if (ctx.active?.id === key) paintActive(ctx);
        focusFeedback(ctx, key, state.errors[action] ? '[data-cr-error="' + action + '"]' : '[data-cr-feedback="' + action + '"]');
        // Status returns only {ok,status}. Refresh dates/details separately; a failed
        // refresh keeps the successful status and the unsent reply visible.
        if (current(ctx) && action === 'status' && !state.errors.status && ctx.active?.id === key && ctx.active.host.isConnected) load();
      }
    }
    load();
  }

  MApp.route('confidential-reports', function (view, params) {
    if (!MApp.can('reports.confidential')) { dispose(session); session = null; view.innerHTML = '<div class="m-error" role="alert">You don’t have access to anonymous reports.</div>'; return; }
    if (params?.id) detail(view, params.id, params.status);
    else list(view, params?.status);
  });
})();
