/* QC inspection — pass / fail the units a job order has queued for inspection.
   #/qc?id=<jobOrderId> */
(function () {
  MApp.route('qc', function (view, params) {
    var id = params && params.id;
    if (!id) { view.innerHTML = '<div class="m-error">No job order.</div>'; return; }
    load(view, id);
  });

  function load(view, id) {
    MApp.setTitle('QC inspection');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/job-orders/' + id), API.get('/job-orders/' + id + '/units')])
      .then(function (r) { render(view, id, r[0], r[1]); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function render(view, id, jo, units) {
    view.innerHTML = '';
    view.appendChild(mEl('<div class="m-hint">' + mEsc(jo.number) + ' · ' + mEsc(jo.product_name) + '</div>'));
    var pending = (units || []).filter(function (u) { return u.status === 'pending'; });
    if (!pending.length) {
      view.appendChild(mEl('<div class="m-empty">Nothing waiting for inspection.</div>'));
      view.appendChild(actionBar([{ label: 'Back to job order', fn: function () { MApp.go('job-orders'); } }]));
      return;
    }

    var ul = mEl('<ul class="m-list"></ul>');
    pending.forEach(function (u) {
      var li = mEl(
        '<li class="m-qc-row">' +
        '  <div class="m-qc-id">Unit #' + u.id + (u.identifier ? ' · ' + mEsc(u.identifier) : '') +
        (u.stage ? ' · stage ' + u.stage : '') + '</div>' +
        '  <div class="m-qc-btns">' +
        '    <button class="m-btn m-btn-sm" data-pass>Pass</button>' +
        '    <button class="m-btn m-btn-sm m-btn-warn" data-fail>Fail</button>' +
        '  </div>' +
        '</li>'
      );
      li.querySelector('[data-pass]').onclick = function () { inspect(view, id, u, 'pass'); };
      li.querySelector('[data-fail]').onclick = function () { inspect(view, id, u, 'fail'); };
      ul.appendChild(li);
    });
    view.appendChild(ul);
    view.appendChild(actionBar([{ label: 'Back to job order', fn: function () { MApp.go('job-orders'); }, secondary: true }]));
  }

  function inspect(view, id, unit, result) {
    var isPass = result === 'pass';
    var promptEl = mEl(
      '<div class="m-qc-prompt">' +
      '  <div class="m-qc-prompt-t">Unit #' + unit.id + ' — ' + (isPass ? 'Pass' : 'Fail') + '</div>' +
      (isPass
        ? '  <div class="m-picker-row"><input class="m-input" data-val placeholder="Serial / identifier (optional)" autocapitalize="characters" />' +
          '    <button type="button" class="m-scan-btn" data-scan aria-label="Scan">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg></button></div>'
        : '  <input class="m-input" data-val placeholder="What failed?" />') +
      '  <div class="m-actions"><button class="m-btn" data-ok>Confirm</button>' +
      '    <button class="m-btn m-btn-secondary" data-cancel>Cancel</button></div>' +
      '</div>'
    );
    var scan = promptEl.querySelector('[data-scan]');
    if (scan) scan.onclick = function () {
      mScanner.open({ title: 'Scan serial', onResult: function (c) { promptEl.querySelector('[data-val]').value = c; } });
    };
    promptEl.querySelector('[data-cancel]').onclick = function () { load(view, id); };
    promptEl.querySelector('[data-ok]').onclick = function () {
      var val = promptEl.querySelector('[data-val]').value.trim();
      var body = { unit_ids: [unit.id], result: result };
      if (isPass) { if (val) body.identifier = val; }
      else { if (!val) { mToast('Say what failed', 'err'); return; } body.remarks = val; }
      promptEl.querySelector('[data-ok]').disabled = true;
      API.post('/job-orders/' + id + '/units/inspect', body)
        .then(function () { mToast('Recorded'); load(view, id); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); promptEl.querySelector('[data-ok]').disabled = false; });
    };
    view.innerHTML = '';
    view.appendChild(promptEl);
  }

  function actionBar(items) {
    var bar = mEl('<div class="m-actions"></div>');
    items.forEach(function (i) {
      var b = mEl('<button class="m-btn ' + (i.secondary ? 'm-btn-secondary' : '') + '">' + mEsc(i.label) + '</button>');
      b.onclick = i.fn;
      bar.appendChild(b);
    });
    return bar;
  }
})();
