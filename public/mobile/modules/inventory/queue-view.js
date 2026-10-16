/* Pending sync — the offline write queue. Shows queued operations, lets the user
   retry or discard the ones that hit an error. */
MApp.route('queue', function (view) {
  MApp.setTitle('Pending sync');

  var off = null;
  function active() { return location.hash.replace(/^#\/?/, '').split('?')[0] === 'queue'; }
  function draw() {
    if (!active()) { if (off) off(); return; } // navigated away — stop listening
    Promise.all([mQueue.all(), mQueue.foreignCount().catch(function () { return 0; })]).then(function (r) {
      var ops = r[0], foreign = r[1];
      if (!active()) { if (off) off(); return; }
      view.innerHTML = '';
      // Account/company boundaries and unbound older actions are never silently replayed.
      if (foreign) {
        view.appendChild(mEl('<div class="m-hint">' + foreign + ' unsent action' + (foreign === 1 ? '' : 's') +
          ' on this phone were kept separately. Use the original account and company; older saved actions need administrator review.</div>'));
      }
      if (!ops.length) {
        view.appendChild(mEl('<div class="m-empty">' + (foreign ? 'No pending actions for this account and company.' : '✅ Everything is synced.') + '</div>'));
        return;
      }
      var offline = !navigator.onLine;
      view.appendChild(mEl('<div class="m-hint">' + ops.length + ' operation(s) waiting' +
        (offline ? ' · you’re offline' : '') + '.</div>'));

      var ul = mEl('<ul class="m-list"></ul>');
      ops.forEach(function (op) {
        var errored = !!op.error;
        var li = mEl(
          '<li class="m-q-row' + (errored ? ' err' : '') + '">' +
          '  <div class="m-q-main"><b>' + mEsc(op.label || op.path) + '</b>' +
          '    <span>' + (errored ? mEsc(op.error) : (offline ? 'waiting for connection' : 'sending…')) + '</span></div>' +
          '  <div class="m-q-btns">' +
          (errored ? '<button class="m-btn m-btn-sm" data-retry>Retry</button>' : '') +
          '    <button class="m-btn m-btn-sm m-btn-secondary" data-discard>Discard</button>' +
          '  </div>' +
          '</li>'
        );
        var r = li.querySelector('[data-retry]');
        if (r) r.onclick = function () { mQueue.retry(op.key).then(draw); };
        li.querySelector('[data-discard]').onclick = function () { mQueue.discard(op.key).then(draw); };
        ul.appendChild(li);
      });
      view.appendChild(ul);

      var bar = mEl('<div class="m-actions">' +
        '<button class="m-btn" data-flush' + (offline ? ' disabled' : '') + '>Retry all now</button></div>');
      bar.querySelector('[data-flush]').onclick = function () {
        bar.querySelector('[data-flush]').disabled = true;
        mQueue.flush().then(draw);
      };
      view.appendChild(bar);
    }).catch(function () {
      if (!active()) return;
      view.innerHTML = '<div class="m-error" role="alert">Could not load saved actions. Their status is unknown. <button class="m-btn" data-retry-queue>Retry</button></div>';
      view.querySelector('[data-retry-queue]').onclick = draw;
    });
  }

  off = mQueue.onChange(draw);
  draw();
});
