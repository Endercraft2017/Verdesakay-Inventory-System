/* Pending sync: the phone copy, an active send and cloud confirmation are distinct. */
MApp.route('queue',function (view) {
  MApp.setTitle('Pending sync');
  var root = mEl('<section class="m-queue-page"><h1>Pending sync</h1><p class="m-hint">Actions saved on this phone for the current account. Removing a copy here does not undo a result the server may already have received.</p><div data-queue-feedback></div><div data-queue-content></div></section>');
  view.replaceChildren(root);
  var off, modal, reading = false, dirty = false, writing = false, loaded = false, readError = '', actionError = '', message = '', snapshot = {ops:[],foreign:0}, poll;
  var scope = mReadScope.create(root,function () { off?.(); if (modal) { modal.force = true; modal.control.close(); } window.removeEventListener('online',refresh); window.removeEventListener('offline',refresh); });
  function refresh() { if (scope.current()) load(); }
  function pending(op) { return mQueue.busy(op); }
  function status(op) {
    if (op.local_command) return ['failed','rejected','conflict'].includes(op.local_state)
      ? 'Needs attention. The cloud did not accept this action. Check Sync on the site PC.'+(op.local_error ? ' '+op.local_error : '')
      : 'Saved on the site PC. Cloud confirmation is pending.';
    if (pending(op)) return 'Sending this saved request…';
    if (op.error) return op.error;
    if (op.uncertain || op.lease) return 'Result not confirmed. Retry uses the same saved request.';
    return navigator.onLine ? 'Waiting to send' : 'Waiting for connection';
  }
  function render() {
    if (!scope.current()) return;
    var focusKey = root.contains(document.activeElement) && document.activeElement.dataset.queueFocus;
    root.querySelector('[data-queue-feedback]').innerHTML = (readError ? '<div class="queue-feedback error" role="alert">'+mEsc(readError)+(loaded ? ' Showing last loaded actions. Refresh before retrying or discarding.' : ' Nothing has been removed.')+'<div class="m-actions"><button type="button" class="m-btn" data-queue-read>Retry reading actions</button></div></div>' : '')
      +(actionError ? '<p class="queue-feedback error" role="alert" tabindex="-1" data-queue-error>'+mEsc(actionError)+'</p>' : '')
      +(message ? '<p class="m-hint" role="status">'+mEsc(message)+'</p>' : '');
    root.querySelector('[data-queue-read]')?.addEventListener('click',load);
    var readButton = root.querySelector('[data-queue-read]'); if (readButton) { readButton.disabled = reading; readButton.textContent = reading ? 'Reading…' : 'Retry reading actions'; }
    var content = root.querySelector('[data-queue-content]'); content.innerHTML = '';
    if (!loaded) { if (!readError) content.innerHTML = '<p class="m-hint" role="status">Reading saved actions…</p>'; return; }
    if (snapshot.foreign) content.appendChild(mEl('<p class="queue-feedback">'+snapshot.foreign+' saved action'+(snapshot.foreign === 1 ? '' : 's')+' on this phone belong to another account or server. Their details stay private; they wait for that sign-in.</p>'));
    if (!snapshot.ops.length) { content.appendChild(mEl('<p class="queue-feedback" role="status">No pending actions for this account on this phone. Cloud and site-PC sync are tracked separately.</p>')); return; }
    content.appendChild(mEl('<p class="m-hint">'+snapshot.ops.length+' action'+(snapshot.ops.length === 1 ? '' : 's')+' saved locally'+(!navigator.onLine ? ' · you’re offline' : '')+'</p>'));
    var list = mEl('<ul class="m-list"></ul>');
    snapshot.ops.forEach(function (op) {
      var row = mEl('<li class="m-q-row'+(op.error || ['rejected','conflict','failed'].includes(op.local_state) ? ' err' : '')+'"><div class="m-q-main"><b>'+mEsc(op.label || op.path)+'</b><small>'+mEsc(Number.isFinite(Number(op.created)) ? 'Saved '+new Date(Number(op.created)).toLocaleString() : 'Saved time unavailable')+'</small><span role="status">'+mEsc(status(op))+'</span></div><div class="m-q-btns"><button type="button" class="m-btn m-btn-sm" data-retry>'+ (op.local_command ? 'Check status' : 'Retry')+'</button><button type="button" class="m-btn m-btn-sm m-btn-secondary" data-discard>Discard</button></div></li>');
      var retry = row.querySelector('[data-retry]'), discard = row.querySelector('[data-discard]');
      retry.dataset.queueFocus = 'retry:'+op.key; discard.dataset.queueFocus = 'discard:'+op.key;
      retry.disabled = writing || !!readError || pending(op) || !navigator.onLine;
      discard.disabled = writing || !!readError || pending(op);
      retry.onclick = function () { if (retry.isConnected) perform(op.local_command ? 'checkLocal' : 'retry',op.key); };
      discard.onclick = function () { if (discard.isConnected && !writing && scope.current()) confirm(op,discard); };
      list.appendChild(row);
    });
    content.appendChild(list);
    var button = mEl('<button type="button" class="m-btn queue-flush" data-queue-flush>'+ (writing ? 'Checking saved requests…' : 'Retry all now')+'</button>');
    button.disabled = writing || !!readError || !navigator.onLine || snapshot.ops.some(pending); button.dataset.queueFocus = 'flush';
    button.onclick = function () { if (button.isConnected) perform('flush'); }; content.appendChild(button);
    if (focusKey && !modal) Array.from(root.querySelectorAll('[data-queue-focus]')).find(function (b) { return b.dataset.queueFocus === focusKey && !b.disabled; })?.focus();
  }
  async function load() {
    if (!scope.current()) return;
    if (reading) { dirty = true; return; }
    reading = true; scope.cancelTimer(poll); render();
    try {
      var data = await scope.run(function () { return mQueue.snapshot(); });
      if (!scope.current()) return;
      if (!data || !Array.isArray(data.ops) || !Number.isFinite(data.foreign) || data.ops.some(function (op) { return !op || typeof op.key !== 'string'; })) throw new Error('The saved actions could not be read. Retry reading them.');
      snapshot = data; loaded = true; readError = '';
    } catch (error) {
      if (!error.cancelled && scope.current()) readError = error.message || 'Pending actions could not be read.';
    } finally {
      reading = false;
      if (scope.current()) { render(); if (dirty) { dirty = false; load(); } else if (snapshot.ops.some(pending)) poll = scope.later(load,5000); }
    }
  }
  async function perform(action,key) {
    if (!scope.current() || writing || readError) return;
    writing = true; actionError = message = ''; render();
    try { await mQueue[action](key); if (scope.current()) message = 'Saved requests checked. Read their current status below.'; }
    catch (error) { if (scope.current()) actionError = error.message || 'The request could not be checked. Your saved copy remains available.'; }
    finally { writing = false; if (scope.current()) { await load(); root.querySelector('[data-queue-error]')?.focus(); } }
  }
  function confirm(op,trigger) {
    if (modal) { modal.control.focus(); return; }
    var layer = mEl('<div class="queue-confirm-layer" role="dialog" aria-modal="true" aria-labelledby="queue-discard-title"><section class="queue-confirm-card"><h2 id="queue-discard-title">Discard this phone’s saved action?</h2><p><b>'+mEsc(op.label || op.path)+'</b></p><p>This removes the pending copy from this phone. It does not undo anything the server or site PC may already have received.</p><p>If the result is uncertain, check the existing record before starting a new action.</p><div class="m-actions"><button type="button" class="m-btn m-btn-secondary" data-keep>Keep action</button><button type="button" class="m-btn m-btn-danger" data-remove>Discard saved copy</button></div><p role="alert" tabindex="-1" data-discard-error></p><p role="status" data-discard-status></p></section></div>');
    (document.getElementById('m-overlay-root') || document.body).appendChild(layer);
    var card = layer.querySelector('section'), state = {busy:false,force:false}, control;
    control = MessageOverlay.mount(layer,{initialFocus:'[data-keep]',canClose:function () { return state.force || !state.busy; },onClose:function () { layer.remove(); modal = null; if (scope.current()) { var next = Array.from(root.querySelectorAll('[data-queue-focus]')).find(function (b) { return b.dataset.queueFocus === trigger.dataset.queueFocus && !b.disabled; }) || root.querySelector('h1'); if (next.tagName === 'H1') next.setAttribute('tabindex','-1'); next.focus(); } }});
    modal = {control:control,get force() { return state.force; },set force(value) { state.force = value; }};
    card.querySelector('[data-keep]').onclick = function () { control.close(); };
    layer.onclick = function (event) { if (event.target === layer) control.close(); };
    card.querySelector('[data-remove]').onclick = async function () {
      if (state.busy || !scope.current() || !card.isConnected) return;
      state.busy = writing = true; card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      card.querySelector('[data-discard-error]').textContent = ''; card.querySelector('[data-discard-status]').textContent = 'Removing saved copy…'; render();
      try {
        await mQueue.discard(op.key);
        if (!scope.current()) return;
        state.busy = false; message = 'Phone copy checked. No server result was reversed.'; control.close();
      } catch (error) {
        if (!scope.current()) return;
        card.querySelector('[data-discard-status]').textContent = '';
        var errorBox = card.querySelector('[data-discard-error]'); errorBox.textContent = error.message || 'The saved copy could not be removed. Try again or keep it.'; errorBox.focus();
      } finally {
        state.busy = writing = false;
        if (scope.current()) { card.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); await load(); }
      }
    };
  }
  off = mQueue.onChange(refresh); window.addEventListener('online',refresh); window.addEventListener('offline',refresh); load();
});
