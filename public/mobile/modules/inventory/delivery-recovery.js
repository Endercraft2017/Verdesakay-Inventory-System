/* Explicit, account/server-scoped delivery attempts. No background posting or optimistic finality. */
(function () {
  var cache = {}, busy = {};
  function slot(id) { return 'delivery:' + id + ':action'; }
  function owns(s) { return s.key === mProductionDrafts.key(slot(s.operation.id)); }
  function guard(s) { if (!owns(s)) throw new Error('Recover using the original account and server.'); }
  async function load(id) {
    var k = mProductionDrafts.key(slot(id));
    if (cache[k]) return cache[k];
    var s = await mProductionDrafts.load(slot(id));
    if (s) cache[k] = s;
    return s;
  }
  async function draft(d) {
    var k = mProductionDrafts.key(slot(d.id)), s = await load(d.id);
    if (k !== mProductionDrafts.key(slot(d.id))) throw new Error('Account or server changed.');
    s = cache[k] || s || { key: k, rows: [], batch: { photos: [], geo: { lat: null, lng: null }, recipient: '', note: '' }, operation: { kind: 'delivery', id: d.id, number: d.number, state: 'draft' } };
    cache[k] = s; return s;
  }
  async function save(s) { guard(s); await mProductionDrafts.save(s); }
  async function start(d, s, action, payload) {
    guard(s);
    if (s.operation.state !== 'draft') throw new Error('Recover the original delivery attempt first.');
    s.operation = { kind: 'delivery', id: d.id, orderId: d.order_id || null, number: d.number, deliveryMode: d.delivery_mode || 'own', action: action, state: 'new', key: 'delivery-' + crypto.randomUUID(), created: Date.now(), payload: JSON.parse(JSON.stringify(payload)) };
    s.rows = action === 'complete' ? s.batch.photos.map(function (file, i) { return { identifier: 'delivery-' + (i + 1) + '.jpg', file: file }; }) : [];
    if (action === 'complete' && s.batch.sign) s.rows.push({ identifier: 'signature.png', file: s.batch.sign });
    await save(s);
    if (navigator.onLine !== false) await send(s);
    else { s.operation.error = 'Connect to record the delivery. The original attempt is saved for explicit retry.'; await save(s); }
    return s;
  }
  async function send(s) {
    guard(s); var a = s.operation;
    if (busy[s.key] || a.local || ['confirmed','rejected','conflict'].indexOf(a.state) !== -1) return;
    if (navigator.onLine === false) throw new Error('Connect to record the delivery. Your attempt is saved on this device.');
    if (Date.now() - a.created >= 7 * 86400000) { a.state = 'conflict'; a.error = 'Original attempt expired. Ask dispatch to reconcile it.'; await save(s); return; }
    busy[s.key] = true;
    try {
      a.state = 'sending'; await save(s);
      for (var i = 0; i < s.rows.length; i++) {
        guard(s); var row = s.rows[i]; if (row.saved) continue;
        var signature = row.identifier === 'signature.png';
        var result = await mPhoto.attachBlob(signature ? 'signature' : 'delivery', a.id, row.file, row.identifier, signature ? 'Recipient signature' : 'Delivery proof', { idempotencyKey: a.key + ':photo:' + i });
        guard(s); row.unitId = result.id; row.saved = true; await save(s);
      }
      guard(s);
      var sign = s.rows.find(function (row) { return row.identifier === 'signature.png'; });
      if (sign && !a.payload.signature_attachment_id) { a.payload.signature_attachment_id = sign.unitId; await save(s); }
      var r = await API.post(a.action==='create'?'/deliveries':'/deliveries/' + a.id + '/' + a.action, a.payload, { idempotencyKey: a.key });
      guard(s); a.result = r; a.local = API.syncLocal(r); a.state = 'confirmed'; a.error = null; a.code = null; await save(s);
    } catch (err) {
      if (!owns(s)) throw err;
      a.state = !err.status || err.status >= 500 || [401,403,429].indexOf(err.status) !== -1 ? 'unknown' : err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected';
      a.error = err.message; a.code = err.data && err.data.code || null; await save(s);
    } finally { delete busy[s.key]; }
  }
  function paint(view, s) {
    guard(s); var a = s.operation, hash = location.hash;
    MApp.setTitle('Delivery · ' + a.number);
    function visible() { return view.isConnected && location.hash === hash && owns(s); }
    var final = a.state === 'confirmed' && !a.local;
    view.innerHTML = '<h2>' + mEsc(a.number) + '</h2>' + RoleUI.result(final ? a.action==='create'?'Delivery trip booked':a.action === 'status' ? 'Delivery started' : a.payload.outcome === 'courier_handoff' ? 'Picked up by courier' : a.payload.outcome === 'delivered' ? 'Delivered' : 'Marked not delivered' : a.local ? 'Saved on site PC — confirmation pending' : a.state === 'rejected' ? 'Delivery action refused' : 'Delivery confirmation unresolved', 'Saved evidence and the original request are retained on this device.', final ? '' : 'queued', final ? '✓' : '⏳') +
      (a.code === 'release_required' ? RoleUI.note('warn', 'Ask releasing staff to record the warehouse handoff first. Delivery and courier pickup do not move stock again.') : '') +
      (a.error ? RoleUI.note('warn', mEsc(a.error)) : '') + RoleUI.note(final ? 'info' : 'warn', final ? 'The server confirmed this delivery action.' : 'Retry reuses the original evidence and request. Do not submit a different outcome until this attempt is resolved.') +
      RoleUI.actions((!a.local && ['new','sending','unknown'].indexOf(a.state) !== -1 ? [{ id: 'delivery-retry', label: 'Retry original delivery', kind: 'primary' }] : [])
        .concat(final || a.state === 'rejected' ? [{ id: 'delivery-review', label: 'Review current delivery', kind: 'primary' }] : [])
        .concat(a.code === 'release_required' && a.orderId && MApp.canOpen('so') ? [{ id: 'delivery-release', label: 'Open release order', kind: 'secondary' }] : [])
        .concat([{ id: 'delivery-list', label: 'Back to deliveries', kind: 'secondary' }])) + '<div data-sync></div>';
    var retry = view.querySelector('#delivery-retry');
    if (retry) retry.onclick = async function () { retry.disabled = true; try { await send(s); if (visible()) paint(view,s); } catch (err) { mToast(err.message,'err'); if (visible()) retry.disabled = false; } };
    var review = view.querySelector('#delivery-review');
    if (review) review.onclick = async function () {
      review.disabled = true;
      try {
        var currentId=a.action==='create'&&a.result?a.result.id:a.id;
        await API.get('/deliveries/' + currentId); guard(s);
        if (final) { await mProductionDrafts.remove(s); delete cache[s.key]; }
        else { s.operation = { kind: 'delivery', id: a.id, number: a.number, state: 'draft' }; s.rows = []; await save(s); }
        if (visible()) MApp.go('deliveries', { id: currentId, t: Date.now() });
      } catch (err) { mToast(err.message,'err'); review.disabled = false; }
    };
    var release = view.querySelector('#delivery-release'); if (release) release.onclick = function () { MApp.go('so', { id: a.orderId }); };
    view.querySelector('#delivery-list').onclick = function () { MApp.go('deliveries'); };
    if (a.local) view.querySelector('[data-sync]').appendChild(RoleUI.syncWatch(a.local, function (r) {
      if (!visible()) return;
      if (r.state === 'confirmed') { a.local = null; a.state = 'confirmed'; }
      else if (['failed','rejected','conflict'].indexOf(r.state) !== -1) { a.state = 'conflict'; a.error = r.error || 'Dispatch must reconcile the original site-PC action.'; }
      else return;
      save(s).then(function () { if (visible()) paint(view,s); }).catch(function (err) { mToast(err.message,'err'); });
    }));
  }
  function cards(host) {
    var owner = mProductionDrafts.key('delivery-list');
    mProductionDrafts.listActions('delivery','delivery').then(function (rows) {
      if (!host.isConnected || owner !== mProductionDrafts.key('delivery-list')) return;
      host.innerHTML = rows.length ? RoleUI.section('Saved delivery actions') + rows.map(function (r) { var a = r.record.operation; return RoleUI.jobCard({ id: a.id, number: a.number, name: a.state === 'draft' ? 'Resume delivery evidence' : 'Review original delivery action', pill: { text: 'Saved on device', tone: 'warn' }, meta: a.local ? 'Confirmation pending' : a.state }); }).join('') : '';
      host.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { MApp.go('deliveries', Number(b.dataset.id)===0?{step:'plan'}:{ id: b.dataset.id, step: 'proof' }); }; });
    }).catch(function (err) { if (host.isConnected) host.appendChild(RoleUI.error(err,function () { cards(host); })); });
  }
  window.mDeliveryRecovery = { load: load, draft: draft, save: save, start: start, paint: paint, cards: cards, send: send };
})();
