/* Durable handoff evidence and immutable final warehouse-out attempt. Explicit retry only.
   Files stay in the shared account/server-scoped IndexedDB store; evidence (including
   acknowledgement) uploads before stock moves and transfers atomically to the slip. */
(function () {
  var R = RoleUI, records = {}, busy = {};
  function slot(id) { return 'handoff:' + id + ':action'; }
  function owns(s) { return s.key === mProductionDrafts.key(slot(s.operation.orderId)); }
  function guard(s) { if (!owns(s)) throw new Error('Use the original account and server to recover this handoff.'); }
  async function load(id) {
    var k = mProductionDrafts.key(slot(id));
    if (records[k]) return records[k];
    var s = await mProductionDrafts.load(slot(id));
    if (s) records[k] = s;
    return s;
  }
  async function saveDraft(id, draft) {
    if (draft._scope && draft._scope !== mProductionDrafts.key('release-owner')) throw new Error('Account or server changed. Reopen the original handoff.');
    var k = mProductionDrafts.key(slot(id)), s = await load(id);
    if (k !== mProductionDrafts.key(slot(id))) throw new Error('Account or server changed.');
    // Another tab can win creation; the store's revision check refuses its stale peer.
    s = records[k] || s || { key: k, rows: [], operation: { kind: 'release-handoff', orderId: Number(id), state: 'draft' } };
    records[k] = s;
    if (s.operation.state !== 'draft') throw new Error('Recover the original release attempt before changing evidence.');
    s.batch = Object.assign({}, draft, { photos: draft.photos.slice() });
    await mProductionDrafts.save(s);
    return s;
  }
  async function start(c, draft, payload) {
    var s = await saveDraft(c.order.id, draft);
    guard(s);
    s.operation = { kind: 'release-handoff', orderId: c.order.id, number: c.order.number,
      state: 'new', created: Date.now(), key: 'handoff-' + crypto.randomUUID(), payload: JSON.parse(JSON.stringify(payload)) };
    s.rows = draft.photos.map(function (f, i) { return { identifier: 'handoff-' + (i + 1) + '.jpg', file: f }; });
    s.rows.push({ identifier: 'acknowledgement.png', file: draft.sign });
    await mProductionDrafts.save(s);
    await send(s);
  }
  async function send(s) {
    guard(s);
    var a = s.operation;
    if (busy[s.key] || a.local || ['confirmed','rejected','conflict'].indexOf(a.state) !== -1) return;
    if (navigator.onLine === false) throw new Error('Reconnect to recover this handoff.');
    if (Date.now() - a.created >= 7 * 86400000) {
      a.state = 'conflict'; a.error = 'Original attempt expired. Ask a supervisor to reconcile it before another release.';
      await mProductionDrafts.save(s); return;
    }
    busy[s.key] = true;
    try {
      a.state = 'sending'; await mProductionDrafts.save(s);
      for (var i = 0; i < s.rows.length; i++) {
        guard(s);
        var row = s.rows[i];
        if (row.saved) continue;
        var r = await mPhoto.attachBlob('release_proof', a.orderId, row.file, row.identifier,
          i === s.rows.length - 1 ? 'Recipient acknowledgement' : 'Handoff proof', { idempotencyKey: a.key + ':photo:' + i });
        guard(s);
        row.unitId = r.id; row.saved = true;
        await mProductionDrafts.save(s);
      }
      guard(s);
      // Freeze and persist the exact body before its first submission.
      if (!a.payload.evidence_ids) { a.payload.evidence_ids = s.rows.map(function (row) { return row.unitId; }); await mProductionDrafts.save(s); }
      var result = await API.post('/orders/' + a.orderId + '/release-slip', a.payload, { idempotencyKey: a.key });
      guard(s);
      a.result = result; a.local = API.syncLocal(result); a.state = 'confirmed'; a.error = null;
      await mProductionDrafts.save(s);
    } catch (err) {
      if (!owns(s)) throw err;
      a.state = !err.status || err.status >= 500 || [401,403,429].indexOf(err.status) !== -1 ? 'unknown' : err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected';
      a.error = err.message; await mProductionDrafts.save(s);
    } finally { delete busy[s.key]; }
  }
  function paint(view, s) {
    guard(s);
    var a = s.operation, hash = location.hash, owner = s.key;
    function visible() { return view.isConnected && hash === location.hash && owner === mProductionDrafts.key(slot(a.orderId)); }
    var final = a.state === 'confirmed' && !a.local;
    var body = R.page(view, { role: 'releasing', node: '78:401', title: final ? 'Release recorded' : 'Recover warehouse-out', subtitle: a.number });
    body.innerHTML = R.result(final ? 'Warehouse-out confirmed' : a.local ? 'Saved on site PC — confirmation pending' : a.state === 'rejected' ? 'Release refused' : 'Release confirmation unresolved',
      final ? 'Handoff photos and acknowledgement are attached to the release slip.' : 'Original evidence and release attempt are saved on this device.', final ? '' : 'queued', final ? '✓' : '⏳') +
      (a.result && a.result.backorder ? R.note('warn', 'Backorder ' + mEsc(a.result.backorder.number) + ' was created for the goods that did not leave.') : '') +
      (a.error ? R.note('warn', mEsc(a.error)) : '') + R.note(final ? 'info' : 'warn', final ? 'Stock and release history were recorded together.' : a.state === 'conflict' ? 'Keep this attempt for supervisor reconciliation.' : 'Retry uses the same photos, signature, request and key. Do not hand over another set of goods.') +
      R.actions((!a.local && ['new','sending','unknown'].indexOf(a.state) !== -1 ? [{ id: 'handoff-retry', label: 'Retry original release', kind: 'primary' }] : [])
        .concat(final || a.state === 'rejected' ? [{ id: 'handoff-review', label: final ? 'View receipt' : 'Review current order', kind: 'primary' }] : [])
        .concat([{ id: 'handoff-queue', label: 'Back to queue', kind: 'secondary' }])) + '<div data-sync></div>';
    var retry = body.querySelector('#handoff-retry');
    if (retry) retry.onclick = async function () { retry.disabled = true; try { await send(s); if (visible()) paint(view,s); } catch (err) { mToast(err.message,'err'); if (visible()) retry.disabled = false; } };
    var review = body.querySelector('#handoff-review');
    if (review) review.onclick = async function () {
      review.disabled = true;
      try {
        // Re-fetch before clearing a resolved attempt. Never discard an unknown result.
        await API.get('/release-slips/orders/' + a.orderId + '/context');
        guard(s);
        if (final) { await mProductionDrafts.remove(s); delete records[s.key]; }
        else { s.operation = { kind: 'release-handoff', orderId: a.orderId, state: 'draft' }; s.rows = []; await mProductionDrafts.save(s); }
        if (visible()) MApp.go('so', { id: a.orderId, step: final ? 'receipt' : 'handoff', t: Date.now() });
      } catch (err) { mToast(err.message,'err'); review.disabled = false; }
    };
    body.querySelector('#handoff-queue').onclick = function () { MApp.go('so'); };
    if (a.local) body.querySelector('[data-sync]').appendChild(R.syncWatch(a.local, function (r) {
      if (!visible()) return;
      if (r.state === 'confirmed') { a.local = null; a.state = 'confirmed'; }
      else if (['failed','rejected','conflict'].indexOf(r.state) !== -1) { a.state = 'conflict'; a.error = r.error || 'Reconcile the original site-PC command.'; }
      else return;
      mProductionDrafts.save(s).then(function () { if (visible()) paint(view,s); }).catch(function (err) { mToast(err.message,'err'); });
    }));
  }
  function cards(host) {
    var owner = mProductionDrafts.key('handoff-list');
    mProductionDrafts.listActions('release-handoff','handoff').then(function (rows) {
      if (!host.isConnected || owner !== mProductionDrafts.key('handoff-list')) return;
      var box = host.querySelector('[data-handoff-drafts]');
      if (!box) { box = document.createElement('div'); box.dataset.handoffDrafts = ''; host.prepend(box); }
      box.innerHTML = rows.length ? R.section('Saved handoffs') + rows.map(function (row) {
        var a = row.record.operation;
        return R.jobCard({ id: a.orderId, number: a.number || 'Order #' + a.orderId, name: a.state === 'draft' ? 'Resume handoff evidence' : 'Review original warehouse-out', pill: { text: 'Saved on device', tone: 'warn' }, meta: a.local ? 'Confirmation pending' : a.state });
      }).join('') : '';
      box.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { MApp.go('so', { id: b.dataset.id, step: 'proof' }); }; });
    }).catch(function (err) { if (host.isConnected) host.appendChild(R.error(err,function () { cards(host); })); });
  }
  window.mReleaseHandoff = { load: load, saveDraft: saveDraft, start: start, send: send, paint: paint, cards: cards };
})();
