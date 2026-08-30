/* QA / QC — a unit only becomes finished stock once it passes every inspection
   stage with its checklist completed; a failed unit is scrapped and never added.
   Every pass / fail is stamped with the signed-in account (the inspector).
     #/qc                 → worklist of job orders awaiting inspection
     #/qc?id=<jobOrderId>  → inspect: pass a batch by count, or unit-by-unit */
(function () {
  var SCAN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>';

  MApp.route('qc', function (view, params) {
    var id = params && params.id;
    if (id) { load(view, id); }
    else { worklist(view); }
  });

  /* ---------- worklist ---------- */
  function worklist(view) {
    MApp.setTitle('QA / QC');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/job-orders')
      .then(function (rows) {
        view.innerHTML = '';
        var need = (rows || []).filter(function (j) {
          return j.qc_stages > 0 && (j.units_pending || 0) > 0 && j.status !== 'cancelled';
        });
        if (!need.length) {
          view.appendChild(mEl('<div class="m-empty">Nothing waiting for inspection.</div>'));
          view.appendChild(mEl('<div class="m-hint">Units queue here after production progress on a job order that has QA/QC stages.</div>'));
          return;
        }
        var ul = mEl('<ul class="m-list"></ul>');
        need.forEach(function (j) {
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(j.number) + '</b>' +
            '<span>' + mEsc(j.product_name) + (j.qc_stages > 1 ? ' · ' + j.qc_stages + '-stage' : '') + '</span></div>' +
            '<div class="m-list-qty">' + j.units_pending + ' to check</div></li>'
          );
          li.onclick = function () { MApp.go('qc', { id: j.id }); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /* ---------- one job order ---------- */
  function load(view, id) {
    MApp.setTitle('QC inspection');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([
      API.get('/job-orders/' + id),
      API.get('/job-orders/' + id + '/units'),
      API.get('/job-orders/' + id + '/qc').catch(function () { return []; }),
    ])
      .then(function (r) {
        var checklist = (r[0] && r[0].qc_checklist && r[0].qc_checklist.items) || [];
        render(view, id, r[0], r[1], checklist, r[2] || []);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /** Checklist lines that apply to this pass: stage 0 always; stage 1 on the first
      inspection; stage 2 on the one that completes the unit (>= total stages). */
  function itemsForStage(all, stageNum, totalStages) {
    return (all || []).filter(function (it) {
      return it.stage === 0
        || (it.stage === 1 && stageNum === 1)
        || (it.stage === 2 && stageNum >= totalStages);
    });
  }

  function render(view, id, jo, units, checklist, log) {
    view.innerHTML = '';
    var stages = Math.max(1, jo.qc_stages || 1);
    var pending = (units || []).filter(function (u) { return u.status === 'pending'; });
    var passed = (units || []).filter(function (u) { return u.status === 'in_stock'; }).length;
    var failed = (units || []).filter(function (u) { return u.status === 'failed'; }).length;

    view.appendChild(mEl(
      '<div class="m-hint">' + mEsc(jo.number) + ' · ' + mEsc(jo.product_name) +
      (stages > 1 ? ' · ' + stages + '-stage QC' : '') +
      ' · ' + passed + ' passed · ' + failed + ' scrapped' +
      (jo.qc_checklist ? ' · checklist: ' + mEsc(jo.qc_checklist.name) : '') + '</div>'
    ));

    if (!pending.length) {
      view.appendChild(mEl('<div class="m-empty">Nothing waiting for inspection.</div>'));
      if (log.length) view.appendChild(historyBlock(log));
      view.appendChild(actionBar([{ label: 'Back to QA/QC', fn: function () { worklist(view); } }]));
      return;
    }

    // ---- Pass a batch by count ----
    var single = stages === 1;
    var batchStage = pending[0].stage + 1;
    var card = mEl(
      '<div class="m-jo-progress">' +
      '<h3 class="m-h3">Pass completed units</h3>' +
      '<div class="m-hint">' + pending.length + ' unit(s) awaiting inspection.' +
      (single ? ' Passing adds them to finished stock.' : ' Passing advances them one stage.') + '</div>' +
      '<label class="m-field"><span class="m-label">How many passed QA / QC?</span></label>' +
      '<div data-nslot></div>' +
      '<label class="m-field"><span class="m-label">Batch / lot ID — optional, applied to all</span>' +
      '<span class="m-picker-row"><input class="m-input" data-bulk-id placeholder="blank = keep untracked" autocapitalize="characters" />' +
      '<button type="button" class="m-scan-btn" data-bulk-scan aria-label="Scan">' + SCAN_SVG + '</button></span></label>' +
      '<div class="m-actions"><button class="m-btn" data-bulk-pass>Pass ' + (single ? '→ finished stock' : 'this stage') + '</button></div>' +
      '</div>'
    );
    var qn = mQtyField('', pending.length);
    card.querySelector('[data-nslot]').appendChild(qn.el);
    card.querySelector('[data-bulk-scan]').onclick = function () {
      mScanner.open({ title: 'Scan batch / lot ID', onResult: function (c) { card.querySelector('[data-bulk-id]').value = (c || '').trim(); } });
    };
    card.querySelector('[data-bulk-pass]').onclick = function () {
      var n = Math.min(qn.value(), pending.length);
      if (n < 1) { mToast('Enter how many passed', 'err'); return; }
      var ids = pending.slice(0, n).map(function (u) { return u.id; });
      var bid = card.querySelector('[data-bulk-id]').value.trim();
      checklistSheet(view, {
        title: 'Checklist — ' + n + ' unit(s)',
        items: itemsForStage(checklist, batchStage, stages),
        onCancel: function () { load(view, id); },
        onConfirm: function (payload) {
          var body = { unit_ids: ids, result: 'pass', checklist: payload.checklist, remarks: payload.remarks };
          if (bid) body.identifier = bid;
          submit(view, id, body, n + ' unit(s) passed');
        },
      });
    };
    view.appendChild(card);

    // ---- Or inspect each unit ----
    view.appendChild(mEl('<h3 class="m-h3">Or inspect each unit</h3>'));
    var wrap = mEl('<div class="m-qc-units"></div>');
    pending.forEach(function (u) {
      var uStage = u.stage + 1;
      var row = mEl(
        '<div class="m-qc-unit">' +
        '<div class="m-qc-id">Unit #' + u.id + (stages > 1 ? ' · stage ' + uStage + ' / ' + stages : '') + '</div>' +
        '<span class="m-picker-row"><input class="m-input m-qc-serial" placeholder="ID / serial (optional)" autocapitalize="characters" value="' + mEsc(u.identifier || '') + '" />' +
        '<button type="button" class="m-scan-btn" data-scan aria-label="Scan">' + SCAN_SVG + '</button></span>' +
        '<div class="m-qc-btns">' +
        '<button class="m-btn m-btn-sm" data-pass>Pass</button>' +
        '<button class="m-btn m-btn-sm m-btn-warn" data-fail>Fail</button>' +
        '</div></div>'
      );
      row.querySelector('[data-scan]').onclick = function () {
        mScanner.open({ title: 'Scan serial', onResult: function (c) { row.querySelector('.m-qc-serial').value = (c || '').trim(); } });
      };
      row.querySelector('[data-pass]').onclick = function () {
        var serial = row.querySelector('.m-qc-serial').value.trim();
        checklistSheet(view, {
          title: 'Checklist — Unit #' + u.id,
          items: itemsForStage(checklist, uStage, stages),
          unitId: u.id,
          onCancel: function () { load(view, id); },
          onConfirm: function (payload) {
            var body = { unit_ids: [u.id], result: 'pass', checklist: payload.checklist, remarks: payload.remarks };
            if (serial) body.identifier = serial;
            submit(view, id, body, 'Unit #' + u.id + ' passed');
          },
        });
      };
      row.querySelector('[data-fail]').onclick = function () { failPrompt(view, id, u, itemsForStage(checklist, uStage, stages)); };
      wrap.appendChild(row);
    });
    view.appendChild(wrap);
    if (log.length) view.appendChild(historyBlock(log));
    view.appendChild(actionBar([{ label: 'Back to QA/QC', fn: function () { worklist(view); }, secondary: true }]));
  }

  function submit(view, id, body, okMsg) {
    view.innerHTML = '<div class="m-hint">Saving…</div>';
    API.post('/job-orders/' + id + '/units/inspect', body)
      .then(function () { mToast(okMsg); load(view, id); })
      .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); load(view, id); });
  }

  /* ---------- checklist sheet (a pass needs every required check ticked OK) ---------- */
  function checklistSheet(view, opts) {
    var items = opts.items || [];
    var box = mEl('<div class="m-qc-prompt"><div class="m-qc-prompt-t">' + mEsc(opts.title || 'QA / QC checklist') + '</div></div>');
    if (!items.length) {
      box.appendChild(mEl('<div class="m-hint">No checklist configured for this stage.</div>'));
    }
    var rows = [];
    items.forEach(function (it, i) {
      var r = mEl(
        '<div class="m-qc-check">' +
        '<label class="m-check m-qc-check-lbl"><input type="checkbox" data-ok /> ' +
        mEsc(it.label) + (it.required ? ' <span class="m-req">*</span>' : '') + '</label>' +
        '<input class="m-input m-qc-check-note" data-note placeholder="note (optional)" />' +
        '</div>'
      );
      r._item = it;
      rows.push(r);
      box.appendChild(r);
    });
    var remarks = mEl('<label class="m-field"><span class="m-label">Remarks</span><textarea class="m-input" data-remarks rows="2" placeholder="overall notes (optional)"></textarea></label>');
    box.appendChild(remarks);
    if (opts.unitId) {
      box.appendChild(mEl('<div class="m-label" style="margin-top:6px">Photos</div>'));
      box.appendChild(mPhoto.thumbs('qc_unit', opts.unitId, { editable: true }));
    }
    var acts = mEl('<div class="m-actions"><button class="m-btn" data-ok>Confirm pass</button>' +
      '<button class="m-btn m-btn-secondary" data-cancel>Cancel</button></div>');
    box.appendChild(acts);

    acts.querySelector('[data-cancel]').onclick = function () { opts.onCancel && opts.onCancel(); };
    acts.querySelector('[data-ok]').onclick = function () {
      var missing = [];
      var checklist = rows.map(function (r) {
        var ok = r.querySelector('[data-ok]').checked;
        if (r._item.required && !ok) missing.push(r._item.label);
        return { label: r._item.label, ok: ok, note: r.querySelector('[data-note]').value.trim() || null };
      });
      if (missing.length) { mToast('Tick the required checks: ' + missing.join(', '), 'err'); return; }
      acts.querySelector('[data-ok]').disabled = true;
      opts.onConfirm({ checklist: checklist, remarks: remarks.querySelector('[data-remarks]').value.trim() || null });
    };
    view.innerHTML = '';
    view.appendChild(box);
  }

  function failPrompt(view, id, unit, items) {
    var box = mEl(
      '<div class="m-qc-prompt">' +
      '<div class="m-qc-prompt-t">Unit #' + unit.id + ' — Fail</div>' +
      '<input class="m-input" data-val placeholder="What failed? (required)" />' +
      '<div class="m-hint">A failed unit is scrapped and is not added to finished stock.</div>' +
      '</div>'
    );
    var rows = [];
    items.forEach(function (it) {
      var r = mEl('<label class="m-check m-qc-check-lbl"><input type="checkbox" data-ok /> ' + mEsc(it.label) + '</label>');
      r._item = it; rows.push(r); box.appendChild(r);
    });
    box.appendChild(mEl('<div class="m-label" style="margin-top:6px">Photos (e.g. where the defect is)</div>'));
    box.appendChild(mPhoto.thumbs('qc_unit', unit.id, { editable: true }));
    var acts = mEl('<div class="m-actions"><button class="m-btn m-btn-warn" data-ok>Confirm fail</button>' +
      '<button class="m-btn m-btn-secondary" data-cancel>Cancel</button></div>');
    box.appendChild(acts);
    acts.querySelector('[data-cancel]').onclick = function () { load(view, id); };
    acts.querySelector('[data-ok]').onclick = function () {
      var val = box.querySelector('[data-val]').value.trim();
      if (!val) { mToast('Say what failed', 'err'); return; }
      var body = { unit_ids: [unit.id], result: 'fail', remarks: val };
      if (rows.length) {
        body.checklist = rows.map(function (r) { return { label: r._item.label, ok: r.querySelector('[data-ok]').checked }; });
      }
      acts.querySelector('[data-ok]').disabled = true;
      submit(view, id, body, 'Recorded — unit scrapped');
    };
    view.innerHTML = '';
    view.appendChild(box);
  }

  /* ---------- inspection history (who did what) ---------- */
  function historyBlock(log) {
    var wrap = mEl('<div class="m-qc-log"><h3 class="m-h3">Inspection history</h3></div>');
    var seenUnits = {};
    log.slice(0, 40).forEach(function (q) {
      var fails = (q.checklist || []).filter(function (c) { return c.ok === false; })
        .map(function (c) { return c.label; }).join(', ');
      var row = mEl(
        '<div class="m-qc-log-row">' +
        '<div><b class="m-qc-log-' + (q.result === 'pass' ? 'ok' : 'bad') + '">' + (q.result === 'pass' ? 'PASS' : 'FAIL') + '</b> ' +
        'Unit #' + (q.unit_id || '?') + (q.stage ? ' · stage ' + q.stage : '') + '</div>' +
        '<div class="m-qc-log-meta">' + mEsc(q.inspector_name || 'unknown') + ' · ' + mEsc((q.created_at || '').slice(0, 16).replace('T', ' ')) + '</div>' +
        (q.remarks ? '<div class="m-qc-log-note">' + mEsc(q.remarks) + '</div>' : '') +
        (fails ? '<div class="m-qc-log-note">Checklist issues: ' + mEsc(fails) + '</div>' : '') +
        '</div>'
      );
      if (q.unit_id && !seenUnits[q.unit_id]) {
        seenUnits[q.unit_id] = 1;
        row.appendChild(mPhoto.thumbs('qc_unit', q.unit_id, { editable: false }));
      }
      wrap.appendChild(row);
    });
    return wrap;
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
