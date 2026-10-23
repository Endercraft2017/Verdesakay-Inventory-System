/* Mobile approval deck. The selected item stays visible through Undo and sending.
   All drafts, reads and immutable decision attempts belong to one sign-in only. */
(function () {
  var session = null;
  var UNDO_MS = 4200;
  function titleCase(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }); }
  function dateText(value) { if (!value) return 'Date unavailable'; var raw = String(value).slice(0,10), d = new Date(raw + 'T00:00:00'); return isNaN(d.getTime()) ? raw : d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0,2).map(function(w) { return w[0]; }).join('').toUpperCase(); }
  function identity() { var me = MApp.getMe?.() || {}; return JSON.stringify([API.base?.() || '',me.id,me.employee?.id,API.getToken?.() || '',!!API.isSharedSession?.(),me.can_approve]); }
  function same(ctx) { return session === ctx && ctx.identity === identity(); }
  function alive(ctx) { return same(ctx) && ctx.active?.root.isConnected && !ctx.active.root.closest('.hidden,[hidden]') && ctx.active.hash === location.hash; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function uniqueKey() { return 'approval-' + (window.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2)); }
  function label(item) { return item.number || (item.kind === 'correction' ? 'Time fix · ' + dateText(item.work_date) : item.type + ' #' + item.id); }
  function normalize(record, kind) {
    var data = record.data || {}, correction = kind === 'correction';
    return { id: record.id, key: kind + ':' + record.id, kind: kind, slug: record.slug,
      path: '/me/approvals/' + (correction ? 'time-corrections/' : 'requests/') + record.id + '/decide',
      type: correction ? 'Time fix' : record.form_name || 'Request', number: record.number,
      who: record.employee_name || record.filed_by || 'Name unavailable', created_at: record.created_at, work_date: record.work_date,
      data: correction ? {'Work date':record.work_date,'Time in':record.requested_in || '', 'Time out':record.requested_out || '',Reason:record.reason} :
        record.display_data || (record.slug === 'information_change' ? {Change:data.field,'On record now':data.current_value || '—','Correct value':data.requested_value,Reason:data.reason} : data) };
  }
  function pending(inbox) { return (inbox.requests || []).map(function(r) { return normalize(r,'request'); }).concat((inbox.time_corrections || []).map(function(r) { return normalize(r,'correction'); })); }
  function currentItem(ctx) { return ctx.intent?.item || ctx.items.find(function(it) { return it.key === ctx.selected; }) || ctx.items[0]; }
  function idle(ctx) { return ctx.phase === 'idle' && !ctx.readJob; }
  function canDecide(ctx) { return alive(ctx) && idle(ctx) && ctx.inbox && ctx.inbox.can_approve !== false && !ctx.needsFresh && !ctx.readError && !!currentItem(ctx); }
  function clearUndo(ctx) { clearTimeout(ctx.undoTimer); clearInterval(ctx.counter); ctx.undoTimer = ctx.counter = null; }
  function cancelRead(ctx) { var job = ctx.readJob; ctx.readJob = null; job?.controller.abort(); }
  function stopAttempt(ctx) { var a = ctx.attempt; ctx.attempt = null; a?.controller.abort(); }
  function depart(ctx) {
    closeDialog(ctx,false); cancelRead(ctx); clearUndo(ctx);
    if (ctx.phase === 'undo' || ctx.phase === 'balance') {
      ctx.phase = 'idle'; ctx.intent = null; ctx.notice = 'The unsent decision was cancelled when you left. Your note is retained for this sign-in.';
    } else if (ctx.phase === 'sending') {
      if (ctx.attempt) ctx.retry = {item:ctx.intent.item.key,body:JSON.stringify(ctx.attempt.body),key:ctx.attempt.key};
      ctx.phase = 'uncertain'; ctx.error = 'This screen closed before the decision was confirmed. Check its latest status before another decision.';
    }
    stopAttempt(ctx);
    if (!same(ctx)) {
      ctx.items = []; ctx.inbox = null; ctx.notes = {}; ctx.expanded = {}; ctx.intent = ctx.last = ctx.retry = null; ctx.phase = 'idle';
      if (ctx.active?.root.isConnected) ctx.active.root.textContent = '';
    }
    ctx.active = null;
  }
  function context() {
    var key = identity();
    if (!session || session.identity !== key) {
      if (session) { depart(session); session.observer.disconnect(); }
      var ctx = session = {identity:key,active:null,inbox:null,items:[],selected:null,notes:{},expanded:{},phase:'idle',intent:null,last:null,retry:null,readJob:null,attempt:null,dialog:null,error:'',readError:'',notice:'',needsFresh:false};
      ctx.observer = new MutationObserver(function() { if (ctx.active && !alive(ctx)) depart(ctx); });
      ctx.observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden']});
    }
    return session;
  }
  window.addEventListener('hashchange',function() { if (session?.active && !alive(session)) depart(session); });
  window.addEventListener('storage',function() { if (session?.active && !same(session)) depart(session); });
  ['pagehide','beforeunload'].forEach(function(name) { window.addEventListener(name,function() { if (session?.active) depart(session); }); });
  window.addEventListener('pageshow',function(e) { if (e.persisted && /^#\/?approvals(?:[?&]|$)/.test(location.hash)) MApp.render?.(); });
  function bounded(owner, ms, invoke) {
    var controller = owner.controller = new AbortController(), timer;
    return new Promise(function(resolve,reject) {
      function aborted() { var error = new Error(owner.timeout ? 'The connection timed out.' : 'Operation cancelled.'); error.cancelled = !owner.timeout; reject(error); }
      controller.signal.addEventListener('abort',aborted,{once:true});
      timer = setTimeout(function() { owner.timeout = true; controller.abort(); },ms);
      Promise.resolve().then(function() { if (controller.signal.aborted) { aborted(); return; } return invoke(controller.signal); }).then(resolve,reject);
    }).finally(function() { clearTimeout(timer); });
  }
  function focus(ctx, selector) { if (alive(ctx) && !ctx.dialog) ctx.active.root.querySelector(selector)?.focus({preventScroll:true}); }
  function message(text, error) { return text ? '<p class="m-appr-feedback' + (error ? ' m-error' : '') + '" role="' + (error ? 'alert' : 'status') + '" tabindex="-1">' + mEsc(text) + '</p>' : ''; }
  function read(ctx, reconcile) {
    if (!alive(ctx) || ctx.readJob || (reconcile ? ctx.phase !== 'uncertain' : ctx.phase !== 'idle')) return;
    var job = ctx.readJob = {}, selected = ctx.selected; ctx.readError = '';
    bounded(job,20000,function(signal) { return API.get('/me/approvals',{signal:signal,isCurrent:function() { return alive(ctx) && ctx.readJob === job && !signal.aborted; }}); }).then(function(inbox) {
      if (!alive(ctx) || ctx.readJob !== job || job.controller.signal.aborted) return;
      if (!inbox || !Array.isArray(inbox.requests) || !Array.isArray(inbox.time_corrections)) throw new Error('The approvals response could not be read. Try again.');
      ctx.inbox = inbox; ctx.items = pending(inbox); ctx.needsFresh = false;
      if (inbox.can_approve === false) { ctx.items = []; ctx.notes = {}; ctx.expanded = {}; ctx.intent = ctx.last = ctx.retry = null; ctx.phase = 'idle'; ctx.error = ''; ctx.notice = ''; return; }
      if (reconcile) reconcileResult(ctx,inbox);
      else {
        ctx.selected = ctx.items.some(function(it) { return it.key === selected; }) ? selected : ctx.items[0]?.key;
        ctx.error = ''; ctx.notice = selected && ctx.selected !== selected ? 'This item is no longer in your pending list. No decision status was confirmed here.' : 'Latest approvals loaded. Your place and notes are preserved.';
      }
    }).catch(function(e) {
      if (!same(ctx) || ctx.readJob !== job || e.cancelled) return;
      ctx.readError = e.message || 'Approvals could not be loaded.'; ctx.needsFresh = true;
      if (e.status === 401 || e.status === 403) { ctx.inbox = null; ctx.items = []; ctx.notes = {}; ctx.expanded = {}; ctx.last = ctx.intent = ctx.retry = null; ctx.phase = 'idle'; }
    }).finally(function() {
      if (ctx.readJob !== job) return; ctx.readJob = null;
      if (!alive(ctx)) { depart(ctx); return; }
      paint(ctx); if (ctx.readError) focus(ctx,'[role=alert]');
    });
    paint(ctx);
  }
  function reconcileResult(ctx,inbox) {
    var intent = ctx.intent; if (!intent) return;
    var history = (inbox.history || []).find(function(r) { return String(r.id) === String(intent.item.id) && r.kind === intent.item.kind && ['approved','rejected'].indexOf(r.status) >= 0; });
    if (history) {
      var data = history.data || {}, result = {status:history.status,applied:data.applied,applied_note:data.applied_note,warnings:String(data.leave_warnings || '').split('\n').filter(Boolean)};
      finish(ctx,intent,result,history); return;
    }
    if (ctx.items.some(function(it) { return it.key === intent.item.key; })) {
      ctx.selected = intent.item.key; ctx.phase = 'idle'; ctx.intent = null; ctx.error = '';
      ctx.notice = 'The latest response still lists this item as pending. Review its details before choosing another decision.';
    } else { ctx.notice = 'This item was not returned in pending items or recent history. Completion is not confirmed. Check again or ask HR.'; }
  }
  function choose(ctx,item,decision) {
    if (!canDecide(ctx) || currentItem(ctx)?.key !== item.key) return;
    var note = String(ctx.notes[item.key] || '').trim();
    if (note.length > 1000) { ctx.error = 'Keep the decision note within 1,000 characters.'; ctx.expanded[item.key] = true; paint(ctx); focus(ctx,'#m-appr-note'); return; }
    ctx.intent = {item:copy(item),decision:decision,note:note,at:ctx.items.findIndex(function(it) { return it.key === item.key; }),ends:Date.now() + UNDO_MS};
    var intent = ctx.intent; ctx.phase = 'undo'; ctx.error = ctx.notice = '';
    clearUndo(ctx);
    ctx.counter = setInterval(function() {
      if (!alive(ctx)) { depart(ctx); return; }
      var el = ctx.active.root.querySelector('#m-appr-countdown'); if (el) el.textContent = Math.max(0,(intent.ends-Date.now())/1000).toFixed(1);
    },100);
    ctx.undoTimer = setTimeout(function() { clearUndo(ctx); if (!alive(ctx)) { depart(ctx); return; } if (ctx.intent === intent && ctx.phase === 'undo') send(ctx,intent,false); },UNDO_MS);
    paint(ctx); focus(ctx,'#m-appr-undo-action');
  }
  function undo(ctx) {
    if (!alive(ctx) || ctx.phase !== 'undo') return;
    var decision = ctx.intent.decision; clearUndo(ctx); ctx.intent = null; ctx.phase = 'idle'; ctx.notice = 'Unsent decision cancelled. Your note is still here.';
    paint(ctx); focus(ctx,decision === 'approved' ? '#m-appr-approve' : '#m-appr-reject');
  }
  function attemptCurrent(ctx,a) { return alive(ctx) && ctx.attempt === a && ctx.intent === a.intent && ctx.phase === 'sending' && !a.controller.signal.aborted; }
  function uncertain(ctx,a,text) {
    ctx.retry = {item:a.intent.item.key,body:JSON.stringify(a.body),key:a.key};
    ctx.phase = 'uncertain'; ctx.error = text || 'Confirmation was not received. The decision may have been recorded. Check its latest status before deciding again.';
  }
  function send(ctx,intent,override) {
    if (!alive(ctx) || ctx.intent !== intent || ctx.attempt || (override ? ctx.phase !== 'balance' : ctx.phase !== 'undo')) return;
    clearUndo(ctx); closeDialog(ctx,false); ctx.phase = 'sending'; ctx.error = ctx.notice = '';
    var body = {decision:intent.decision,note:intent.note || null}; if (override) body.override_balance = true;
    // An explicit retry of the same uncertain body reuses its save key. A balance
    // override is a different body and never replays a cached balance refusal.
    var retry = ctx.retry, key = retry && retry.item === intent.item.key && retry.body === JSON.stringify(body) ? retry.key : uniqueKey();
    var a = ctx.attempt = {intent:intent,body:body,key:key};
    bounded(a,60000,function(signal) { if (!attemptCurrent(ctx,a)) throw Object.assign(new Error('Decision cancelled.'),{cancelled:true}); return API.post(intent.item.path,body,{signal:signal,idempotencyKey:key,isCurrent:function() { return attemptCurrent(ctx,a); }}); }).then(function(result) {
      if (!attemptCurrent(ctx,a)) return;
      if (!result || ['approved','rejected','cancelled','completed'].indexOf(result.status) < 0) { uncertain(ctx,a,'The response did not confirm a recorded decision. Check its latest status before another decision.'); return; }
      finish(ctx,intent,result);
    }).catch(function(e) {
      if (!alive(ctx) || ctx.attempt !== a || ctx.intent !== intent || ctx.phase !== 'sending') return;
      if (intent.item.kind === 'request' && intent.item.slug === 'leave_request' && intent.decision === 'approved' && !override && e.status === 400 && /approve anyway to override/i.test(e.message || '')) {
        ctx.phase = 'balance'; intent.balanceMessage = e.message; return;
      }
      if (e.status >= 400 && e.status < 500 && e.status !== 408) {
        ctx.phase = 'idle'; ctx.selected = intent.item.key; ctx.intent = null; ctx.needsFresh = true;
        ctx.error = e.message || 'The server refused this decision.'; ctx.notice = 'This attempt was not accepted. Refresh the latest approvals before another decision.';
        if (e.status === 401 || e.status === 403) { ctx.items = []; ctx.inbox = null; ctx.notes = {}; ctx.expanded = {}; ctx.last = ctx.retry = null; }
      } else uncertain(ctx,a,(e.timeout || a.timeout ? 'Confirmation timed out. ' : 'Confirmation was not received. ') + 'The decision may have been recorded. Check its latest status before another decision.');
    }).finally(function() {
      if (ctx.attempt !== a) return; ctx.attempt = null;
      if (!alive(ctx)) { depart(ctx); return; }
      paint(ctx);
      if (ctx.phase === 'balance') openDialog(ctx,'balance');
      else if (ctx.phase === 'receipt' && ctx.last.warnings.length) openDialog(ctx,'warnings');
      else focus(ctx,ctx.error ? '[role=alert]' : '#m-appr-request-title');
    });
    paint(ctx); focus(ctx,'#m-appr-request-title');
  }
  function finish(ctx,intent,response,history) {
    var local = !history && API.syncLocal?.(response), status = titleCase(response.status), facts = [];
    var heading = history ? 'Latest status: ' + status : response.clash ? 'Existing decision kept: ' + status : status;
    if (history) facts.push('The latest authorized history confirms this recorded status on this server. No decision was sent again.');
    else if (response.clash) facts.push('The existing ' + response.status + ' decision was kept. Your attempted decision did not replace it.');
    else facts.push('Decision confirmed by the server.');
    if (local) { heading = 'Saved on site PC · ' + status; facts.push('Awaiting cloud confirmation. This local save is not a final cloud receipt.'); }
    if (!response.clash && response.status === 'approved') {
      if (intent.item.kind === 'correction' && response.applied === false) { heading = local ? heading : 'Approved · time not applied yet'; facts.push('No matching cutoff was found. HR should add the matching cutoff and verify the recorded correction before payroll.'); }
      else if (intent.item.kind === 'correction' && response.applied === true) facts.push('The correction was applied to timekeeping.');
      else if (intent.item.slug === 'information_change' && response.applied === false) { heading = local ? heading : 'Approved · employee record not changed'; }
      else if (intent.item.slug === 'information_change' && response.applied === true) facts.push('The employee record was updated.');
      if (response.applied_note) facts.push(String(response.applied_note));
    }
    var warnings = Array.isArray(response.warnings) ? response.warnings.map(String) : [];
    ctx.last = {item:copy(intent.item),heading:heading,facts:facts,warnings:warnings,local:!!local,
      note:history ? String(history.data?.decision_note || history.decision_note || '') : intent.note,
      noteLabel:history ? 'Note in latest history' : response.clash ? 'Your attempted note (not confirmed)' : 'Decision note'};
    ctx.items = ctx.items.filter(function(it) { return it.key !== intent.item.key; });
    ctx.phase = 'receipt'; ctx.error = ctx.notice = ''; ctx.retry = null; ctx.needsFresh = false;
    if (!history) MApp.refreshInboxBadge?.();
  }
  function continueReview(ctx) {
    if (!alive(ctx) || ctx.phase !== 'receipt') return;
    var at = ctx.intent?.at || 0; ctx.intent = null; ctx.phase = 'idle'; ctx.selected = ctx.items[Math.min(at,Math.max(0,ctx.items.length-1))]?.key;
    paint(ctx); focus(ctx,currentItem(ctx) ? '#m-appr-request-title' : '#m-appr-refresh');
  }
  function move(ctx,delta) {
    if (!alive(ctx) || !idle(ctx)) return;
    var at = ctx.items.findIndex(function(it) { return it.key === currentItem(ctx)?.key; });
    ctx.selected = ctx.items[Math.min(ctx.items.length-1,Math.max(0,at+delta))]?.key;
    // A failed read/refused decision remains a decision gate when changing cards.
    ctx.notice = ''; paint(ctx); focus(ctx,'#m-appr-request-title');
  }
  function bind(ctx, selector, handler, event) {
    var root = ctx.active.root;
    root.querySelectorAll(selector).forEach(function(el) { el.addEventListener(event || 'click',function(e) {
      if (alive(ctx) && ctx.active.root === root && el.isConnected && root.contains(el)) handler(e,el);
    }); });
  }
  function paint(ctx) {
    if (!alive(ctx)) return;
    var root = ctx.active.root, item = currentItem(ctx), active = document.activeElement;
    var restore = root.contains(active) ? {id:active.id,start:active.selectionStart,end:active.selectionEnd} : null;
    var busy = !idle(ctx), enabled = canDecide(ctx), at = ctx.items.findIndex(function(it) { return it.key === item?.key; });
    var content = '<h1 class="m-appr-sr-only">Approvals</h1><div class="m-appr-intro"><p>Review one request at a time.</p><button id="m-appr-refresh" class="m-appr-link"' + (busy ? ' disabled' : '') + '>Refresh</button></div>';
    content += message(ctx.readError,true) + message(ctx.error,true) + message(ctx.notice,false);
    if (ctx.readJob) content += message(ctx.inbox ? 'Checking latest approvals…' : 'Loading approvals…',false);
    if (ctx.inbox?.can_approve === false) content += '<div class="m-card m-appr-empty"><h2>No approval access</h2><p>Your account does not currently have permission to review approvals.</p></div>';
    else if (item) {
      var fields = Object.entries(item.data || {}).map(function(pair) { var value = pair[1]; return '<div class="m-appr-field"><dt>' + mEsc(titleCase(pair[0])) + '</dt><dd>' + mEsc(value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)) + '</dd></div>'; }).join('');
      content += '<article class="m-appr-card"><div class="m-appr-top"><p class="m-appr-type">' + mEsc(item.type) + '</p><span class="m-appr-count">' + ctx.items.length + ' pending</span></div><header class="m-appr-who"><span class="m-appr-av" aria-hidden="true">' + mEsc(initials(item.who)) + '</span><div><h2 id="m-appr-request-title" tabindex="-1">' + mEsc(item.who) + '</h2><span>' + (item.kind === 'correction' ? 'Attendance correction' : 'Request') + '</span></div><span class="m-appr-tag">' + mEsc(label(item)) + '</span></header><dl class="m-appr-fields">' + fields + '</dl><div class="m-appr-tl"><div class="done">Filed ' + mEsc(dateText(item.created_at)) + '</div><div class="now">' + (ctx.phase === 'idle' ? 'Pending your approval' : ctx.phase === 'undo' ? 'Decision not sent yet' : ctx.phase === 'receipt' ? 'Decision result below' : ctx.phase === 'balance' ? 'Balance confirmation needed' : ctx.phase === 'uncertain' ? 'Confirmation needed' : 'Sending decision') + '</div></div>';
      var expanded = !!ctx.expanded[item.key];
      content += '<div id="m-appr-note-wrap"' + (!expanded ? ' hidden' : '') + '><label for="m-appr-note">Decision note <span>(optional)</span></label><textarea id="m-appr-note" data-note rows="3" maxlength="1000"' + (busy ? ' disabled' : '') + '>' + mEsc(ctx.notes[item.key] || '') + '</textarea><p class="m-appr-note-help">Kept with this request while you review. Up to 1,000 characters.</p></div>';
      content += '<div class="m-appr-actions m-appr-acts"><button id="m-appr-reject" class="no rej"' + (!enabled ? ' disabled' : '') + '>✕ Reject</button><button class="note" id="m-appr-note-toggle" aria-expanded="' + expanded + '" aria-controls="m-appr-note-wrap"' + (busy ? ' disabled' : '') + '>✎ ' + (expanded ? 'Hide note' : 'Note') + '</button><button id="m-appr-approve" class="ok"' + (!enabled ? ' disabled' : '') + '>✓ Approve</button></div></article>';
      if (ctx.phase === 'undo') content += '<div id="m-appr-undo" class="m-undo"><div><strong>' + (ctx.intent.decision === 'approved' ? 'Approve' : 'Reject') + ' ' + mEsc(label(item)) + '?</strong><p>Not sent yet · <span id="m-appr-countdown" aria-hidden="true">' + Math.max(0,(ctx.intent.ends-Date.now())/1000).toFixed(1) + '</span><span aria-hidden="true">s</span><span class="m-appr-sr-only">Sending after the Undo period.</span></p></div><button id="m-appr-undo-action">Undo</button></div><p class="m-appr-note-help">Leaving now cancels this unsent decision.</p>';
      if (ctx.phase === 'sending') content += message('Sending ' + (ctx.intent.decision === 'approved' ? 'approval' : 'rejection') + ' for ' + label(item) + '… Please wait for confirmation.',false);
      if (ctx.phase === 'uncertain') content += '<button id="m-appr-check" class="m-v2-primary"' + (ctx.readJob ? ' disabled' : '') + '>Check latest status</button>';
      if (ctx.phase === 'balance') content += '<p class="m-appr-feedback">No approval recorded yet. Review the balance warning before continuing.</p><button id="m-appr-balance" class="m-v2-primary">Review balance warning</button>';
      if (ctx.phase === 'receipt') content += '<section class="m-appr-result" aria-label="Decision result"><h3>' + mEsc(ctx.last.heading) + '</h3>' + ctx.last.facts.map(function(f) { return '<p>' + mEsc(f) + '</p>'; }).join('') + (ctx.last.warnings.length ? '<button class="m-appr-link" data-last>View ' + ctx.last.warnings.length + ' warning' + (ctx.last.warnings.length === 1 ? '' : 's') + '</button>' : '') + '<button id="m-appr-continue" class="m-v2-primary">Continue review</button></section>';
      content += '<nav class="m-appr-nav" aria-label="Pending approvals"><button data-prev' + (busy || at <= 0 ? ' disabled' : '') + '>← Previous</button><span>' + (ctx.phase === 'receipt' ? 'Decision result' : (at+1) + ' of ' + ctx.items.length) + '</span><button data-next' + (busy || at >= ctx.items.length-1 ? ' disabled' : '') + '>Next →</button></nav>';
    } else if (ctx.inbox && !ctx.readJob && !ctx.readError && ctx.inbox.can_approve !== false) content += '<div class="m-card m-appr-empty"><h2>All caught up</h2><p>No requests are waiting for your decision.</p></div>';
    if (ctx.readError || ctx.needsFresh && ctx.phase === 'idle') content += '<button id="m-appr-retry" class="m-v2-primary"' + (busy ? ' disabled' : '') + '>Retry latest approvals</button>';
    if (ctx.last && ctx.phase !== 'receipt') content += '<button class="m-appr-link" data-last>View last decision result</button>';
    root.innerHTML = content;
    bind(ctx,'#m-appr-refresh, #m-appr-retry',function() { read(ctx,false); });
    bind(ctx,'[data-prev]',function() { move(ctx,-1); }); bind(ctx,'[data-next]',function() { move(ctx,1); });
    bind(ctx,'#m-appr-note-toggle',function() { if (!idle(ctx) || currentItem(ctx)?.key !== item.key) return; ctx.expanded[item.key] = !expanded; paint(ctx); focus(ctx,expanded ? '#m-appr-note-toggle' : '#m-appr-note'); });
    bind(ctx,'#m-appr-note',function(e,el) { if (idle(ctx) && currentItem(ctx)?.key === item.key) ctx.notes[item.key] = el.value; },'input');
    bind(ctx,'#m-appr-approve',function() { choose(ctx,item,'approved'); }); bind(ctx,'#m-appr-reject',function() { choose(ctx,item,'rejected'); });
    bind(ctx,'#m-appr-undo-action',function() { undo(ctx); }); bind(ctx,'#m-appr-check',function() { read(ctx,true); });
    bind(ctx,'#m-appr-balance',function() { if (ctx.phase === 'balance') openDialog(ctx,'balance'); });
    bind(ctx,'#m-appr-continue',function() { continueReview(ctx); }); bind(ctx,'[data-last]',function() { openDialog(ctx,'warnings'); });
    var start;
    bind(ctx,'.m-appr-card',function(e) { if (idle(ctx) && !e.target.closest('button,input,textarea,a')) start = e.changedTouches?.[0]; },'touchstart');
    bind(ctx,'.m-appr-card',function(e) { var end = e.changedTouches?.[0]; if (start && end && idle(ctx) && Math.abs(end.clientX-start.clientX)>70 && Math.abs(end.clientX-start.clientX)>Math.abs(end.clientY-start.clientY)) move(ctx,end.clientX<start.clientX ? 1 : -1); start = null; },'touchend');
    if (restore?.id && !ctx.dialog) { var el = root.querySelector('#' + restore.id); if (el && !el.disabled) { el.focus({preventScroll:true}); if (typeof restore.start === 'number') el.setSelectionRange?.(restore.start,restore.end); } }
  }
  function closeDialog(ctx, restore) {
    var dialog = ctx.dialog; if (!dialog) return;
    ctx.dialog = null; dialog.shade.remove(); document.removeEventListener('keydown',dialog.keys,true); document.removeEventListener('focusin',dialog.trap,true);
    dialog.inert.forEach(function(entry) { entry[0].inert = entry[1]; }); document.body.style.overflow = dialog.overflow;
    if (restore && alive(ctx)) { if (dialog.returnTo?.isConnected && !dialog.returnTo.disabled) dialog.returnTo.focus(); else focus(ctx,'#m-appr-request-title'); }
  }
  function openDialog(ctx, kind) {
    if (!alive(ctx) || ctx.dialog || kind === 'balance' && ctx.phase !== 'balance' || kind === 'warnings' && !ctx.last) return;
    var balance = kind === 'balance', intent = ctx.intent, last = ctx.last, item = balance ? intent.item : last.item;
    var shade = document.createElement('div'); shade.className = 'm-appr-dialog-shade';
    shade.innerHTML = '<section class="m-appr-dialog" role="dialog" aria-modal="true" aria-labelledby="m-appr-dialog-title" aria-describedby="m-appr-dialog-context"><h2 id="m-appr-dialog-title">' + mEsc(balance ? 'Approve below leave balance?' : 'Decision result') + '</h2><p id="m-appr-dialog-context"><strong>' + mEsc(label(item)) + '</strong> · ' + mEsc(item.who) + '</p>' + (balance ? '<p class="m-appr-warning">' + mEsc(intent.balanceMessage) + '</p><p>The first attempt was not approved. Approving below balance sends a new decision with an explicit balance override.</p>' : '<h3>' + mEsc(last.heading) + '</h3>' + last.facts.map(function(f) { return '<p>' + mEsc(f) + '</p>'; }).join('') + (last.warnings.length ? '<h3>Warnings</h3><ul>' + last.warnings.map(function(w) { return '<li>' + mEsc(w) + '</li>'; }).join('') + '</ul>' : '<p>No warnings returned with this result.</p>')) + ((balance ? intent.note : last.note) ? '<div class="m-appr-dialog-note"><strong>' + mEsc(balance ? 'Decision note' : last.noteLabel) + '</strong><p>' + mEsc(balance ? intent.note : last.note) + '</p></div>' : '') + '<div class="m-appr-dialog-actions"><button id="m-appr-dialog-close">' + (balance ? 'Keep pending' : 'Close') + '</button>' + (balance ? '<button id="m-appr-override" class="m-v2-primary">Approve below balance</button>' : '') + '</div></section>';
    var dialog = ctx.dialog = {shade:shade,returnTo:document.activeElement,inert:Array.from(document.body.children).map(function(el) { return [el,el.inert]; }),overflow:document.body.style.overflow};
    function current() { return ctx.dialog === dialog && alive(ctx) && (!balance || ctx.intent === intent && ctx.phase === 'balance'); }
    function dismiss() { if (!current()) { if (!alive(ctx)) depart(ctx); return; } closeDialog(ctx,false); if (balance) { ctx.phase = 'idle'; ctx.intent = null; ctx.notice = 'No approval was recorded. The request remains pending.'; paint(ctx); focus(ctx,'#m-appr-approve'); } else if (dialog.returnTo?.isConnected) dialog.returnTo.focus(); else focus(ctx,'#m-appr-request-title'); }
    function controls() { return Array.from(shade.querySelectorAll('button:not(:disabled),[href],textarea:not(:disabled),[tabindex="0"]')); }
    dialog.keys = function(e) { if (!current()) { if (!alive(ctx)) depart(ctx); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } else if (e.key === 'Tab') { var els = controls(), first = els[0], end = els[els.length-1]; if (e.shiftKey && (document.activeElement === first || !shade.contains(document.activeElement))) { e.preventDefault(); end.focus(); } else if (!e.shiftKey && (document.activeElement === end || !shade.contains(document.activeElement))) { e.preventDefault(); first.focus(); } } };
    dialog.trap = function(e) { if (!current()) { if (!alive(ctx)) depart(ctx); return; } if (!shade.contains(e.target)) controls()[0]?.focus(); };
    dialog.inert.forEach(function(entry) { entry[0].inert = true; }); document.body.style.overflow = 'hidden'; document.body.appendChild(shade);
    document.addEventListener('keydown',dialog.keys,true); document.addEventListener('focusin',dialog.trap,true);
    shade.querySelector('#m-appr-dialog-close').onclick = dismiss;
    shade.querySelector('#m-appr-override')?.addEventListener('click',function() { if (current() && shade.isConnected) send(ctx,intent,true); });
    shade.addEventListener('click',function(e) { if (e.target === shade) dismiss(); });
    shade.querySelector('#m-appr-dialog-close').focus();
  }
  MApp.route('approvals',function(view) {
    var ctx = context(), continuing = !!ctx.active && ctx.active.hash === location.hash;
    closeDialog(ctx,false);
    var root = document.createElement('section'); root.className = 'm-approvals'; view.replaceChildren(root); ctx.active = {root:root,hash:location.hash};
    MApp.setTitle('Approvals'); paint(ctx);
    if (!continuing && ctx.phase === 'idle') read(ctx,false);
  });
})();
