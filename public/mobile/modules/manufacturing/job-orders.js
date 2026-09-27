/* Manufacturing shop-floor — job order board. List by status, open one, accept the
   released parts kit, record production progress, pause / resume / close, release a draft. */
(function () {
  var OPEN = ['draft', 'released', 'in_progress', 'paused'];
  var SCAN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>';

  function board(view) {
    MApp.setTitle('Job orders');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/job-orders')
      .then(function (rows) {
        view.innerHTML = '';
        var open = rows.filter(function (j) { return OPEN.indexOf(j.status) !== -1; });
        if (!open.length) { view.appendChild(mEl('<div class="m-empty">No open job orders.</div>')); return; }
        var ul = mEl('<ul class="m-list"></ul>');
        open.forEach(function (j) {
          var li = mEl(
            '<li class="m-list-row">' +
            '<div><b>' + mEsc(j.number) + '</b><span>' + mEsc(j.product_name) + '</span></div>' +
            '<div class="m-list-qty"><span class="m-jo-status ' + j.status + '">' +
            (j.status === 'released' && !j.accepted_at && !(j.qty_done > 0 || j.qty_scrapped > 0) ? 'to accept' : j.status.replace('_', ' ')) + '</span>' +
            '<br>' + j.qty_done + '/' + j.qty_ordered + '</div></li>'
          );
          li.onclick = function () { open1(view, j.id); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function open1(view, id) {
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/job-orders/' + id).then(function (jo) { detail(view, jo); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function act(view, id, path, body) {
    return API.post('/job-orders/' + id + '/' + path, body || {})
      .then(function (r) { detail(view, r.job_order || null, id); })
      .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); });
  }

  function detail(view, jo, id) {
    if (!jo && id) { return open1(view, id); }
    MApp.setTitle(jo.number);
    view.innerHTML = '';
    var remaining = jo.qty_ordered - jo.qty_done - jo.qty_scrapped;
    // canAdjust: broad job-order-lifecycle actions (release/pause/close/resume) stay
    // restricted to it. canRecord/canInspect: a production_lead/qc_inspector/qa_inspector
    // account (production.record/production.inspect_qc/production.inspect_qa, no
    // inventory.adjust) also gets just its own section — same narrowing as the backend's
    // recordGate/inspectDoorGate. canInspect is only this door check (does the callout
    // render at all) — which specific pass a qc_inspector/qa_inspector account may actually
    // perform is enforced per-unit once inside the QC/QA screen (mobile/modules/manufacturing/qc.js).
    var canAdjust = MApp.can('inventory.adjust');
    var canRecord = canAdjust || MApp.can('production.record');
    var canInspect = canAdjust || MApp.can('production.inspect_qc') || MApp.can('production.inspect_qa');

    view.appendChild(mEl(
      '<div class="m-jo-head">' +
      '<h2>' + mEsc(jo.product_name) + '</h2>' +
      '<div class="m-jo-meta"><span class="m-jo-status ' + jo.status + '">' + jo.status.replace('_', ' ') + '</span>' +
      ' · done ' + jo.qty_done + ' · scrap ' + jo.qty_scrapped + ' · of ' + jo.qty_ordered + '</div>' +
      (jo.team_name ? '<div class="m-hint">Team: ' + mEsc(jo.team_name) + (jo.due_date ? ' · due ' + mEsc(jo.due_date) : '') + '</div>' : (jo.due_date ? '<div class="m-hint">Due ' + mEsc(jo.due_date) + '</div>' : '')) +
      (jo.released_by_name
        ? '<div class="m-hint">Released from warehouse by ' + mEsc(jo.released_by_name) +
          (jo.released_at ? ' · ' + mEsc((jo.released_at || '').slice(0, 16).replace('T', ' ')) : '') + '</div>'
        : '') +
      (jo.accepted_by_name
        ? '<div class="m-hint">Accepted by production: ' + mEsc(jo.accepted_by_name) +
          (jo.accepted_at ? ' · ' + mEsc((jo.accepted_at || '').slice(0, 16).replace('T', ' ')) : '') +
          (jo.accept_notes ? ' — ' + mEsc(jo.accept_notes) : '') + '</div>'
        : '') +
      '</div>'
    ));

    // components
    var comps = jo.components || [];
    if (comps.length) {
      view.appendChild(mEl('<h3 class="m-h3">Components</h3>'));
      var cu = mEl('<ul class="m-kv"></ul>');
      comps.forEach(function (c) {
        var short = (c.component_on_hand != null && c.component_on_hand < (c.qty_planned - c.qty_consumed));
        cu.appendChild(mEl('<li><span>' + mEsc(c.component_name) + (short ? ' ⚠' : '') + '</span><b>' +
          c.qty_consumed + ' / ' + c.qty_planned + '</b></li>'));
      });
      view.appendChild(cu);
    }

    // ---- The one thing most likely to need attention right now: units already
    // recorded and waiting on QC/QA. Shown before "Record production" — inspecting a
    // backlog is usually more urgent than adding to it. ----
    if (canInspect && jo.qc_stages > 0 && jo.units_summary && jo.units_summary.pending > 0) {
      var inspectCard = mEl(
        '<button type="button" class="m-jo-callout">' +
        '<span>🔍 ' + jo.units_summary.pending + ' unit(s) waiting for inspection</span>' +
        '<span class="m-jo-callout-go">Inspect →</span>' +
        '</button>'
      );
      inspectCard.onclick = function () { MApp.go('qc', { id: jo.id }); };
      view.appendChild(inspectCard);
    }

    if (jo.status === 'draft') {
      // Before release: approval (production.approve) → warehouse accepts → picks the kit →
      // releases, which issues the parts release slip (server 409s any step out of order).
      view.appendChild(mEl('<div class="m-hint">' + (!jo.approved_at
        ? 'Waiting for approval before the parts can be released.'
        : !jo.warehouse_accepted_at ? 'Approved by ' + mEsc(jo.approved_by_name || '—') + ' — waiting for the warehouse.'
        : !jo.prepared_at ? 'Warehouse is preparing the parts kit.'
        : 'Kit prepared — ready to release.') + '</div>'));
      var acts0 = mEl('<div class="m-actions"></div>');
      if (MApp.can('production.approve') && !jo.approved_at) addBtn(acts0, 'Approve', function () { act(view, jo.id, 'approve'); });
      if (canAdjust && jo.approved_at && !jo.warehouse_accepted_at) addBtn(acts0, 'Accept (warehouse)', function () { bulk(view, jo.id, 'warehouse-accept', { job_order_ids: [jo.id] }); });
      if (canAdjust && jo.warehouse_accepted_at && !jo.prepared_at) addBtn(acts0, 'Mark kit picked', function () { bulk(view, jo.id, 'prepare', { job_orders: [{ id: jo.id }] }); });
      if (canAdjust && jo.prepared_at) addBtn(acts0, 'Release & issue slip', function () {
        var who = window.prompt('Received by (production) — optional', jo.team_name || '');
        if (who === null) return;
        act(view, jo.id, 'release', { received_by: who.trim() || null });
      });
      if (acts0.children.length) view.appendChild(acts0);
    }
    if (jo.parts_slip_number) view.appendChild(mEl('<div class="m-hint">Parts release slip ' + mEsc(jo.parts_slip_number) + '</div>'));
    if (jo.status === 'paused' && jo.pause_reason) {
      view.appendChild(mEl('<div class="m-hint">Paused by ' + mEsc(jo.paused_by_name || '—') + ': ' + mEsc(jo.pause_reason) + '</div>'));
    }
    // The production lead signs for the released parts kit before any output can be
    // recorded (POST /:id/accept — the server 409s /progress and /units until then).
    var awaitingAccept = awaitingAcceptance(jo);
    if (canRecord && awaitingAccept && jo.status !== 'paused') {
      acceptBox(view, jo);
    }
    var canBuild = canRecord && !awaitingAccept && (jo.status === 'released' || jo.status === 'in_progress');
    if (canBuild && jo.qc_stages > 0) {
      recordUnitsBox(view, jo, remaining);
    }
    if (canBuild && jo.qc_stages <= 0) {
      var prog = mEl(
        '<div class="m-jo-progress">' +
        '<h3 class="m-h3">Record production (' + remaining + ' left)</h3>' +
        '<div class="m-two">' +
        '<label class="m-field"><span class="m-label">Finished</span><input type="number" inputmode="numeric" class="m-input" data-done value="0" min="0" /></label>' +
        '<label class="m-field"><span class="m-label">Scrapped</span><input type="number" inputmode="numeric" class="m-input" data-scrap value="0" min="0" /></label>' +
        '</div>' +
        '<label class="m-field"><span class="m-label">Batch / lot (auto)</span>' +
        '<input class="m-input" data-batch placeholder="auto BATCH-#####" /></label>' +
        '<div class="m-actions"><button type="button" class="m-btn" data-save>Save progress</button></div>' +
        '</div>'
      );
      prog.querySelector('[data-save]').onclick = function () {
        var d = parseInt(prog.querySelector('[data-done]').value, 10) || 0;
        var s = parseInt(prog.querySelector('[data-scrap]').value, 10) || 0;
        if (d + s < 1) { mToast('Enter finished and/or scrapped', 'err'); return; }
        var bl = (prog.querySelector('[data-batch]').value || '').trim();
        act(view, jo.id, 'progress', { done_delta: d, scrapped_delta: s, batch_label: bl || null });
      };
      view.appendChild(prog);
    }
    // production.pause: a line lead trusted to hold the line (e.g. for a higher-priority job order).
    var canPause = canAdjust || MApp.can('production.pause');
    if (!canAdjust && canPause && (jo.status === 'released' || jo.status === 'in_progress')) {
      var actsP = mEl('<div class="m-actions"></div>');
      addBtn(actsP, 'Pause', function () { pauseJo(view, jo); }, true);
      view.appendChild(actsP);
    }
    if (canPause && jo.status === 'paused') {
      var actsR = mEl('<div class="m-actions"></div>');
      addBtn(actsR, 'Resume', function () { act(view, jo.id, 'resume'); });
      view.appendChild(actsR);
    }

    // ---- Rare/admin actions, tucked behind a toggle so they don't compete with the
    // actual production work above. Pause/Close stay inventory.adjust-only — not part
    // of what a narrow production_lead/qc_inspector account does. ----
    if (canAdjust && (jo.status === 'released' || jo.status === 'in_progress')) {
      view.appendChild(moreActions(view, jo));
    }

    var back = mEl('<div class="m-actions"><button type="button" class="m-btn m-btn-secondary">Back to board</button></div>');
    back.querySelector('button').onclick = function () { board(view); };
    view.appendChild(back);
  }

  // Mirrors job-orders.routes.ts needsAcceptance(): released, not yet accepted, and no
  // output on record (older job orders built before the accept step stay exempt).
  function awaitingAcceptance(jo) {
    if (jo.accepted_at || jo.status === 'draft') return false;
    if (['released', 'in_progress', 'paused'].indexOf(jo.status) === -1) return false;
    if ((jo.qty_done || 0) > 0 || (jo.qty_scrapped || 0) > 0) return false;
    var s = jo.units_summary || {};
    return !Object.keys(s).some(function (k) { return s[k] > 0; });
  }

  // "Accept parts kit" — the production lead counts the kit against the Components list
  // above, then signs for it. A short/damaged kit goes back through Report a problem
  // instead (only the warehouse / a supervisor can fix a release).
  function acceptBox(view, jo) {
    var box = mEl(
      '<div class="m-jo-progress">' +
      '<h3 class="m-h3">Accept parts kit</h3>' +
      '<div class="m-hint" style="margin:0 0 10px">Count the parts you received against the Components list above. ' +
      'Accept only if the kit is complete — you cannot record production until you do.</div>' +
      '<label class="m-check"><input type="checkbox" data-counted /> I counted the kit and it matches the list</label>' +
      '<label class="m-field"><span class="m-label">Note (optional)</span>' +
      '<input class="m-input" data-note maxlength="500" placeholder="e.g. bolts swapped for equivalent" /></label>' +
      '<div class="m-actions"><button type="button" class="m-btn" data-accept>Accept job order</button>' +
      '<button type="button" class="m-btn m-btn-secondary" data-problem>Report a kit problem</button></div>' +
      '</div>'
    );
    box.querySelector('[data-accept]').onclick = function () {
      if (!box.querySelector('[data-counted]').checked) { mToast('Count the kit first, then tick the box', 'err'); return; }
      var note = (box.querySelector('[data-note]').value || '').trim();
      this.disabled = true;
      act(view, jo.id, 'accept', { notes: note || null });
    };
    box.querySelector('[data-problem]').onclick = function () {
      MApp.go('report-problem', { about: 'Parts kit for ' + jo.number + ' (' + jo.product_name + ')' });
    };
    view.appendChild(box);
  }

  // "More actions" — Pause / Close out early, collapsed by default. These are rare,
  // job-management actions a floor worker doesn't need staring at them alongside the
  // actual production work every time they open a job order.
  function moreActions(view, jo) {
    var wrap = mEl('<div class="m-jo-more"></div>');
    var toggle = mEl('<button type="button" class="m-jo-more-toggle">⋯ More actions</button>');
    var body = mEl('<div class="m-actions" hidden></div>');
    addBtn(body, 'Pause', function () { pauseJo(view, jo); }, true);
    addBtn(body, 'Close out early', function () { act(view, jo.id, 'close'); }, true);
    toggle.onclick = function () {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? '⋯ More actions' : '⋯ Hide';
    };
    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  // Serialized (QC-gated) job orders: scrap stays a bulk count via /progress, but each
  // finished unit needs its own identifier + a required photo, so it's added one at a
  // time through POST /:id/units, identifier + photo in one multipart request (saved as
  // attachment kind 'qc_unit', the same kind QC/QA's pass/fail flow uses for defect photos). `rows` holds
  // { identifier, file } per unit (index-aligned with the on-screen rows); a File is
  // kept in memory from mPhoto.pickFile() rather than a native <input type=file>, so
  // redrawing a row on count-change doesn't lose an already-picked photo.
  function recordUnitsBox(view, jo, remaining) {
    var rows = [{ identifier: '', file: null }];

    var box = mEl(
      '<div class="m-jo-progress">' +
      '<h3 class="m-h3">Record production (' + remaining + ' left)</h3>' +
      '<div class="m-hint" style="margin:0 0 10px">Each finished unit needs its own identifier and a photo.</div>' +
      '<div class="m-two" style="align-items:center;margin-bottom:10px">' +
      '<button type="button" class="m-btn m-btn-secondary" data-dec>−</button>' +
      '<input type="number" inputmode="numeric" class="m-input" data-count value="1" min="1" style="text-align:center" />' +
      '<button type="button" class="m-btn m-btn-secondary" data-inc>+</button>' +
      '</div>' +
      '<div data-rows></div>' +
      '<label class="m-field"><span class="m-label">Batch / lot (optional)</span><input class="m-input" data-ubatch placeholder="label to group these units" /></label>' +
      '<div class="m-actions"><button type="button" class="m-btn" data-submit>Record unit(s)</button></div>' +
      '<div class="m-hint" data-uprogress></div>' +
      '<button type="button" class="m-jo-more-toggle" data-scrap-toggle style="margin-top:14px">⋯ Report scrap instead</button>' +
      '<div hidden data-scrap-body style="margin-top:8px">' +
      '<label class="m-field"><span class="m-label">Scrapped now</span><input type="number" inputmode="numeric" class="m-input" data-scrap value="0" min="0" /></label>' +
      '<div class="m-actions"><button type="button" class="m-btn m-btn-secondary" data-scrap-btn>Record scrap</button></div>' +
      '</div>' +
      '</div>'
    );
    view.appendChild(box);

    var scrapToggle = box.querySelector('[data-scrap-toggle]');
    var scrapBody = box.querySelector('[data-scrap-body]');
    scrapToggle.onclick = function () {
      scrapBody.hidden = !scrapBody.hidden;
      scrapToggle.textContent = scrapBody.hidden ? '⋯ Report scrap instead' : '⋯ Hide';
    };

    var rowsEl = box.querySelector('[data-rows]');
    var countEl = box.querySelector('[data-count]');

    function renderRows() {
      rowsEl.innerHTML = '';
      rows.forEach(function (r, i) {
        var row = mEl(
          '<div class="m-unit-row" style="margin-bottom:8px;padding:8px;border:1px solid var(--m-border,#333);border-radius:8px">' +
          '<label class="m-field"><span class="m-label">Unit ' + (i + 1) + ' identifier *</span>' +
          '<span class="m-picker-row"><input class="m-input" data-ident value="' + mEsc(r.identifier) + '" placeholder="motor / serial no." />' +
          '<button type="button" class="m-scan-btn" data-scan aria-label="Scan">' + SCAN_SVG + '</button></span></label>' +
          '<button type="button" class="m-btn m-btn-secondary" data-photo>' + (r.file ? '✓ Photo attached (retake)' : '📷 Take photo *') + '</button>' +
          '</div>'
        );
        row.querySelector('[data-ident]').oninput = function (e) { rows[i].identifier = e.target.value; };
        row.querySelector('[data-scan]').onclick = function () {
          mScanner.open({ title: 'Scan the part\'s serial/motor tag', onResult: function (c) {
            rows[i].identifier = (c || '').trim();
            renderRows();
          } });
        };
        row.querySelector('[data-photo]').onclick = function () {
          mPhoto.pickFile().then(function (file) { rows[i].file = file; renderRows(); }).catch(function () {});
        };
        rowsEl.appendChild(row);
      });
    }
    function setCount(n) {
      n = Math.max(1, n);
      while (rows.length < n) rows.push({ identifier: '', file: null });
      while (rows.length > n) rows.pop();
      countEl.value = rows.length;
      renderRows();
    }
    box.querySelector('[data-dec]').onclick = function () { setCount(rows.length - 1); };
    box.querySelector('[data-inc]').onclick = function () { setCount(rows.length + 1); };
    countEl.oninput = function () { setCount(parseInt(countEl.value, 10) || 1); };
    renderRows();

    box.querySelector('[data-scrap-btn]').onclick = function () {
      var s = parseInt(box.querySelector('[data-scrap]').value, 10) || 0;
      if (s <= 0) { mToast('Enter a scrapped quantity', 'err'); return; }
      act(view, jo.id, 'progress', { scrapped_delta: s });
    };

    var progressEl = box.querySelector('[data-uprogress]');
    box.querySelector('[data-submit]').onclick = function () {
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].identifier.trim()) { mToast('Every unit needs an identifier', 'err'); return; }
        if (!rows[i].file) { mToast('Every unit needs a photo', 'err'); return; }
      }
      var batch_label = (box.querySelector('[data-ubatch]').value || '').trim() || null;
      var submitBtn = box.querySelector('[data-submit]');
      submitBtn.disabled = true;
      var total = rows.length;
      // Not offline-queueable like the rest of this app's shop-floor writes (repairs,
      // receiving, QC pass/fail): each unit needs the server-assigned id back before its
      // photo can attach, and the identifier + photo are both required together at
      // creation by design (see the pipeline note above) — queuing the identifier alone
      // and hoping the photo follows later would defeat that. A dropped connection here
      // just fails the row and leaves it for a retry once back online.
      // Completed rows are dropped from `rows` below (once, after the chain settles) so a
      // retry after a partial failure only re-submits what's actually left, instead of
      // re-creating the units that already went through.
      var chain = Promise.resolve();
      var succeeded = [];
      rows.forEach(function (r) {
        chain = chain.then(function () {
          progressEl.textContent = 'Recording unit ' + (succeeded.length + 1) + ' of ' + total + '…';
          // Identifier + photo in one request — the server refuses a unit without its photo.
          var fd = new FormData();
          fd.append('identifier', r.identifier.trim());
          if (batch_label) fd.append('batch_label', batch_label);
          fd.append('image', r.file, r.file.name || 'unit.jpg');
          return API.upload('/job-orders/' + jo.id + '/units', fd)
            .then(function () { succeeded.push(r); });
        });
      });
      chain.then(function () {
        mToast('Recorded ' + succeeded.length + ' unit' + (succeeded.length === 1 ? '' : 's'));
        open1(view, jo.id);
      }).catch(function (e) {
        rows = rows.filter(function (r) { return succeeded.indexOf(r) === -1; });
        setCount(rows.length || 1);
        mToast('Recorded ' + succeeded.length + ' of ' + total + ' — ' + (e.message || 'connection lost — retry once back online'), 'err');
        submitBtn.disabled = false;
      });
    };
  }

  function pauseJo(view, jo) {
    var reason = window.prompt('Why pause this job order? (optional)', '');
    if (reason === null) return;
    act(view, jo.id, 'pause', { reason: reason.trim() || null });
  }

  // Warehouse steps that take one or more job orders (POST /job-orders/<path>).
  function bulk(view, id, path, body) {
    return API.post('/job-orders/' + path, body)
      .then(function () { open1(view, id); })
      .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); });
  }

  function addBtn(host, label, fn, secondary) {
    var b = mEl('<button class="m-btn ' + (secondary ? 'm-btn-secondary' : '') + '">' + mEsc(label) + '</button>');
    b.onclick = fn;
    host.appendChild(b);
  }

  MApp.route('job-orders', function (view) { board(view); });
})();
