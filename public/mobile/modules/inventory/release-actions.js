/* Acceptance and allocation recovery: one immutable scoped JSON attempt per order.
   Allocation reserves goods; only a release slip records physical warehouse-out. */
(function () {
  var R = RoleUI;
  function slot(id) { return 'release:' + id; }
  function scope(s) { return MApp.getMe() && s.key === mProductionDrafts.key(slot(s.operation.orderId) + ':action'); }
  function visible(s) { return scope(s) && location.hash.split('?')[0] === '#/so' && Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id')) === s.operation.orderId && new URLSearchParams(location.hash.split('?')[1] || '').get('step') === 'recovery'; }
  function go(s) { MApp.go('so', { id: s.operation.orderId, step: 'recovery' }); }
  async function send(s) {
    var a = s.operation;
    if (!scope(s)) throw new Error('Recover this action using its original account and server.');
    if (a.local || ['confirmed','rejected','conflict'].indexOf(a.state) !== -1) return;
    if (Date.now() - a.created >= 7 * 86400000) { a.state = 'conflict'; a.error = 'Original attempt expired. Ask a supervisor to reconcile it before another action.'; await mProductionDrafts.save(s); return; }
    a.state = 'sending'; await mProductionDrafts.save(s);
    if (!scope(s)) throw new Error('Account or server changed before submitting.');
    try {
      var r = await API.post(a.path, a.payload, { idempotencyKey: a.key });
      a.state = 'confirmed'; a.local = API.syncLocal(r); a.error = null; await mProductionDrafts.save(s);
    } catch (err) {
      a.state = !err.status || err.status >= 500 || err.status === 429 ? 'unknown' : err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected';
      a.error = err.message; await mProductionDrafts.save(s);
    }
  }
  async function start(c, kind, path, payload, label) {
    if (navigator.onLine === false) { mToast('Reconnect before accepting or allocating goods.', 'err'); return; }
    var owner = mProductionDrafts.key(slot(c.order.id) + ':action'), hash = location.hash;
    var existing = await mProductionDrafts.loadAction(slot(c.order.id));
    if (owner !== mProductionDrafts.key(slot(c.order.id) + ':action') || hash !== location.hash) return;
    if (existing) { go(existing); return; }
    var s = { key: owner, rows: [], operation: { kind: 'release-action', action: kind, orderId: c.order.id, number: c.order.number,
      location: c.order.location_name || 'Ship-from location #' + c.order.location_id, path: path, payload: JSON.parse(JSON.stringify(payload)), label: label,
      key: 'rel-' + crypto.randomUUID(), created: Date.now(), state: 'new' } };
    await mProductionDrafts.save(s);
    try { await send(s); } finally {
      if (scope(s) && hash === location.hash) {
        if (s.operation.state === 'confirmed' && !s.operation.local && ['accept','allocate'].includes(kind)) {
          // A fresh confirmed action continues through a newly loaded order context.
          // Retries, refusals, unknown results and site-local saves retain recovery.
          await mProductionDrafts.remove(s);
          if (scope(s) && hash === location.hash) MApp.go('so', { id: c.order.id, step: 'scan' });
        } else go(s);
      }
    }
  }
  function paint(view, s) {
    if (!visible(s)) return;
    var a = s.operation, final = a.state === 'confirmed' && !a.local;
    var body = R.page(view, { role: 'releasing', node: a.action === 'accept' ? '78:68' : '78:109', title: 'Review saved release action', subtitle: a.number });
    body.innerHTML = R.result(final ? a.action === 'accept' ? 'Acceptance confirmed' : a.action==='unreserve'?'Allocation correction confirmed':'Allocation confirmed' : a.local ? 'Saved on site PC — confirmation pending' : a.state === 'rejected' ? 'Action refused' : 'Confirmation unresolved', a.label, final ? '' : 'queued', final ? '✓' : '⏳') +
      (a.payload.order_item_id || a.payload.bulk && a.payload.bulk[0] && a.payload.bulk[0].order_item_id ? R.field('Original sale line', '#' + (a.payload.order_item_id || a.payload.bulk[0].order_item_id)) : '') + R.field('Ship from', a.location) + (a.error ? R.note('warn', mEsc(a.error)) : '') +
      R.note(final ? 'info' : 'warn', final ? 'Review the current order before continuing. Allocation reserves goods; stock leaves only when a release slip is issued.' : a.state === 'conflict' ? 'Supervisor reconciliation required. Keep the original attempt.' : a.local ? 'Wait for the original command. Do not submit another copy.' : a.state === 'rejected' ? 'Review the current order and stock before a corrected attempt with a fresh key.' : 'Retry reuses the exact original request and key, including its quantity and serials.') +
      R.actions((!a.local && ['new','unknown','sending'].indexOf(a.state) !== -1 ? [{ id: 'rel-retry', label: 'Retry original', kind: 'primary' }] : [])
        .concat(!a.local && (final || a.state === 'rejected') ? [{ id: 'rel-review-current', label: 'Review current order', kind: 'primary' }] : [])
        .concat([{ id: 'rel-queue', label: 'Back to queue', kind: 'secondary' }])) + '<div data-sync></div>';
    var retry = body.querySelector('#rel-retry'); if (retry) retry.onclick = function () {
      if (navigator.onLine === false) { mToast('Reconnect to recover the original action.', 'err'); return; }
      body.querySelectorAll('button').forEach(function (b) { b.disabled = true; }); send(s).then(function () { paint(view,s); }).catch(function (err) { mToast(err.message,'err'); paint(view,s); });
    };
    var review = body.querySelector('#rel-review-current'); if (review) review.onclick = function () { mProductionDrafts.remove(s).then(function () { if (visible(s)) MApp.go('so', { id: a.orderId }); }).catch(function (err) { mToast(err.message,'err'); }); };
    body.querySelector('#rel-queue').onclick = function () { MApp.go('so'); };
    if (a.local) body.querySelector('[data-sync]').appendChild(R.syncWatch(a.local, function (r) {
      if (!visible(s)) return;
      if (r.state === 'confirmed') { a.local = null; a.state = 'confirmed'; }
      else if (['failed','rejected','conflict'].indexOf(r.state) !== -1 && a.state !== 'conflict') { a.state = 'conflict'; a.error = r.error || 'Site-PC action was not confirmed; reconcile the original command.'; }
      else return;
      mProductionDrafts.save(s).then(function () { paint(view,s); }).catch(function (err) { mToast(err.message,'err'); });
    }));
  }
  function cards(host) {
    var owner = mProductionDrafts.key('release-list');
    mProductionDrafts.listActions('release-action','release').then(function (rows) {
      if (!host.isConnected || owner !== mProductionDrafts.key('release-list')) return;
      host.innerHTML = rows.length ? R.section('Saved release actions') + rows.map(function (a) { var s = a.record.operation; return R.jobCard({ id: s.orderId, number: s.number, name: s.label, pill: { text: 'Review saved action', tone: 'warn' }, meta: s.local ? 'Confirmation pending' : s.state }); }).join('') : '';
      host.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { MApp.go('so',{ id: b.dataset.id, step: 'recovery' }); }; });
    }).catch(function (err) { if (host.isConnected) host.appendChild(R.error(err,function () { cards(host); })); });
  }
  window.mReleaseActions = { start: start, send: send, paint: paint, cards: cards, load: function (id) { return mProductionDrafts.loadAction(slot(id)); } };
})();
