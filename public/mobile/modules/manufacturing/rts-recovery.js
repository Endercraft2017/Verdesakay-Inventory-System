/* Durable Products In attempts. Persist each exact request before sending; never
   replay in the background. Confirmed job orders are skipped on grouped recovery. */
(function () {
  var R = RoleUI;
  function owns(s) { return MApp.getMe() && s.key === mProductionDrafts.key(s.operation.slot + ':action'); }
  function visible(s) { return owns(s) && location.hash.split('?')[0] === '#/receiving' && new URLSearchParams(location.hash.split('?')[1] || '').get('record') === s.operation.slot; }
  function go(s) { MApp.go('receiving', { step: 'recovery', record: s.operation.slot }); }
  function complete(s) { return s.operation.entries.every(function (a) { return a.state === 'confirmed' && !a.local; }); }
  function normalize(s) { s.operation.entries.forEach(function (a) { if (a.state === 'sending') a.state = 'unknown'; }); return s; }
  function saved() {
    return Promise.all(['rts-unit', 'rts-batch'].map(function (n) { return mProductionDrafts.listActions('rts-receipt', n); })).then(function (both) {
      return both.flat().map(function (a) { return normalize(a.record); });
    });
  }
  function matches(s, unitIds, batchId) {
    return s.operation.entries.some(function (a) { return batchId ? a.payload.batch_id === batchId : (a.payload.unit_ids || []).some(function (id) { return unitIds.indexOf(id) !== -1; }); });
  }
  async function begin(slot, entries, locationName) {
    var owner = mProductionDrafts.key(slot + ':action');
    var existing = (await saved()).find(function (s) { return entries.some(function (a) { return matches(s, a.payload.unit_ids || [], a.payload.batch_id); }); });
    if (owner !== mProductionDrafts.key(slot + ':action')) throw new Error('Account or server changed. Reopen RTS.');
    if (existing) return { record: existing, existing: true };
    var s = { key: owner, rows: [], operation: { kind: 'rts-receipt', slot: slot, location: locationName, entries: entries.map(function (a) {
      return Object.assign({}, a, { key: 'rts-' + crypto.randomUUID(), state: 'new', local: null });
    }) } };
    await mProductionDrafts.save(s); // revision check also prevents same-batch tab races
    return { record: s, existing: false };
  }
  function uncertain(err) { return !err.status || err.status >= 500 || err.status === 429; }
  async function send(s) {
    for (var a of s.operation.entries) {
      if (!owns(s)) throw new Error('Recover this receipt using its original account and server.');
      if (a.local || a.state === 'rejected' || a.state === 'conflict') return;
      if (a.state === 'confirmed') continue;
      if (a.created && Date.now() - a.created >= 7 * 86400000) {
        a.state = 'conflict'; a.error = 'This original attempt has expired. Ask a supervisor to reconcile the receipt; do not replace its key.'; await mProductionDrafts.save(s); return;
      }
      a.created = a.created || Date.now(); a.state = 'sending'; a.error = null;
      await mProductionDrafts.save(s);
      if (!owns(s)) throw new Error('Account or server changed before posting.');
      try {
        var res = await API.post(a.path, a.payload, { idempotencyKey: a.key });
        a.receipt = res.number; a.receiptId = res.id; a.local = API.syncLocal(res); a.at = new Date().toISOString(); a.state = 'confirmed';
        await mProductionDrafts.save(s);
      } catch (err) {
        a.state = uncertain(err) ? 'unknown' : err.status === 409 && /save key|different request/i.test(err.message) ? 'conflict' : 'rejected';
        a.error = err.message; a.errorData = err.data || null; await mProductionDrafts.save(s); return;
      }
      if (a.local) return;
    }
  }
  function status(a) { return a.local ? 'Saved on site PC — confirmation pending' : a.state === 'confirmed' ? 'Confirmed by site authority' : a.state === 'rejected' ? 'Refused — review required' : a.state === 'conflict' ? 'Supervisor reconciliation required' : a.state === 'new' ? 'Not started' : 'Confirmation unknown'; }
  function render(view, s) {
    if (!visible(s)) return;
    var entries = s.operation.entries, final = complete(s), pending = entries.some(function (a) { return a.local; });
    var refused = entries.some(function (a) { return a.state === 'rejected'; });
    var locked = entries.some(function (a) { return a.local || ['sending','unknown','conflict'].indexOf(a.state) !== -1; });
    var conflict = entries.some(function (a) { return a.state === 'conflict'; });
    var confirmed = entries.filter(function (a) { return a.state === 'confirmed' && !a.local; });
    var qty = function (rows) { return rows.reduce(function (n, a) { return n + (a.payload.unit_ids ? a.payload.unit_ids.length : a.payload.quantity); }, 0); };
    var body = R.page(view, { role: 'rts', node: final ? '74:356' : '74:316', title: final ? 'Ready-to-sell recorded' : 'Review saved stock entry', subtitle: final ? 'Finished-goods inventory is updated' : 'Exact receipt requests retained on this phone' });
    body.innerHTML = R.result(final ? 'Ready to sell' : pending ? 'Stock entry confirmation pending' : 'Stock entry incomplete', qty(confirmed) + ' of ' + qty(entries) + ' confirmed · ' + s.operation.location, final ? '' : 'queued', final ? '✓' : '⏳') +
      entries.map(function (a) { return R.section(a.jobNumber || 'Job order #' + a.jobId) + R.field('Units / batch', a.labels.join(', ')) + R.field('Status', status(a)) +
        (a.receipt ? R.field('Inventory transaction', a.receipt) : '') + (a.error ? R.note('warn', mEsc(a.error)) : ''); }).join('') +
      R.note(final ? 'info' : 'warn', final ? 'Stock entry is confirmed. These goods can enter allocation and releasing.' : conflict ? 'Keep the original record for supervisor reconciliation.' : pending ? 'Wait for the original site-PC command. Do not submit another receipt.' : refused ? 'Confirmed entries stay recorded. Review the remaining entries against the current queue before a corrected attempt.' : 'Retry reuses the exact location, units or quantity, note and keys. Confirmed job orders are skipped.') +
      R.actions((!final && !pending && !refused && !conflict ? [{ id: 'rts-retry', label: 'Retry original', kind: 'primary' }] : [])
        .concat(refused && !locked ? [{ id: 'rts-correct', label: 'Review remaining entries', kind: 'secondary' }] : [])
        .concat(final ? [{ id: 'rts-next', label: 'Record next unit', kind: 'primary' }, { id: 'rts-look', label: 'View stock record', kind: 'secondary' }] : [])
        .concat([{ id: 'rts-queue', label: 'Back to queue', kind: 'secondary' }])) + '<div data-sync></div>';
    var retry = body.querySelector('#rts-retry'); if (retry) retry.onclick = function () {
      if (navigator.onLine === false) { mToast('Reconnect to recover the original receipt.', 'err'); return; }
      body.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      send(s).then(function () { render(view, s); }).catch(function (err) { mToast(err.message, 'err'); render(view, s); });
    };
    body.querySelector('#rts-queue').onclick = function () { MApp.go('receiving'); };
    var correct = body.querySelector('#rts-correct'); if (correct) correct.onclick = function () {
      var a = entries.find(function (e) { return e.state !== 'confirmed'; });
      mProductionDrafts.remove(s).then(function () { if (visible(s)) MApp.go('receiving', a.payload.batch_id ? { batch: a.payload.batch_id } : { unit: a.payload.unit_ids[0] }); }).catch(function (err) { mToast(err.message, 'err'); });
    };
    var next = body.querySelector('#rts-next'); if (next) next.onclick = function () { mProductionDrafts.remove(s).then(function () { if (visible(s)) MApp.go('receiving'); }).catch(function (err) { mToast(err.message, 'err'); }); };
    var lookup = body.querySelector('#rts-look'); if (lookup) lookup.onclick = function () { MApp.go('receiving', { step: 'lookup', q: entries[0].labels[0] }); };
    if (final && entries.every(function (a) { return a.payload.unit_ids; }) && window.mProductionPrint) {
      body.appendChild(mEl(R.actions([{ id: 'rts-print', label: 'Print unit records', kind: 'secondary' }])));
      body.querySelector('#rts-print').onclick = function () {
        Promise.all(entries.flatMap(function (a) { return a.payload.unit_ids; }).map(function (id) { return API.get('/production/record?unit=' + id); }))
          .then(function (records) { return mProductionPrint.printUnitRecords(records); }).catch(function (err) { mToast(err.message, 'err'); });
      };
    }
    entries.filter(function (a) { return a.local; }).forEach(function (a) {
      body.querySelector('[data-sync]').appendChild(R.syncWatch(a.local, function (r) {
        if (!visible(s)) return;
        if (r.state === 'confirmed') { a.local = null; mProductionDrafts.save(s).then(function () { render(view, s); }).catch(function (err) { mToast(err.message, 'err'); }); }
        else if (['rejected','failed','conflict'].indexOf(r.state) !== -1 && a.state !== 'conflict') {
          a.state = 'conflict'; a.error = r.error || 'The site-PC receipt was not confirmed. Ask a supervisor to reconcile its command.';
          mProductionDrafts.save(s).then(function () { render(view, s); }).catch(function (err) { mToast(err.message, 'err'); });
        }
      }));
    });
  }
  function open(view, slot) {
    if (!/^rts-(unit|batch):\d+$/.test(slot || '')) { MApp.go('receiving'); return; }
    var hash = location.hash, owner = mProductionDrafts.key(slot + ':action');
    view.innerHTML = '<section class="rk-page">' + R.skeleton(2) + '</section>';
    mProductionDrafts.loadAction(slot).then(function (s) {
      if (location.hash !== hash || owner !== mProductionDrafts.key(slot + ':action')) return;
      if (!s) { MApp.go('receiving'); return; }
      render(view, normalize(s));
    }).catch(function (err) { if (location.hash === hash) { view.innerHTML = ''; view.appendChild(R.error(err, function () { open(view, slot); })); } });
  }
  function cards(host) {
    var owner = mProductionDrafts.key('rts-list');
    saved().then(function (rows) {
      if (!host.isConnected || owner !== mProductionDrafts.key('rts-list')) return;
      host.innerHTML = rows.length ? R.section('Saved stock entries') + rows.map(function (s) {
        return R.jobCard({ id: s.operation.slot, number: s.operation.entries[0].labels[0], name: s.operation.location, pill: { text: complete(s) ? 'Confirmed receipt' : 'Review saved receipt', tone: complete(s) ? 'ok' : 'warn' }, meta: s.operation.entries.map(function (a) { return status(a); }).join(' · ') });
      }).join('') : '';
      host.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { go(rows.find(function (s) { return s.operation.slot === b.dataset.id; })); }; });
    }).catch(function (err) { if (host.isConnected) { host.innerHTML = ''; host.appendChild(R.error(err, function () { cards(host); })); } });
  }
  async function count(q) {
    var ids = new Set((q.units || []).filter(function (u) { return !u.hold; }).map(function (u) { return 'u:' + u.id; }).concat((q.batches || []).map(function (b) { return 'b:' + b.id; })));
    (await saved()).forEach(function (s) { s.operation.entries.filter(function (a) { return a.state !== 'confirmed' || a.local; }).forEach(function (a) { if (a.payload.unit_ids) a.payload.unit_ids.forEach(function (id) { ids.add('u:' + id); }); else ids.add('b:' + a.payload.batch_id); }); });
    return ids.size;
  }
  window.mRtsRecovery = { saved: saved, matches: matches, begin: begin, send: send, open: open, go: go, cards: cards, complete: complete, count: count };
})();
