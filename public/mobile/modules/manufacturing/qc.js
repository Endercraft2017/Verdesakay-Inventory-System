/* QC / QA — a unit only becomes finished stock once it passes every inspection
   stage with its checklist completed; a failed unit is scrapped and never added.
   Every pass / fail is stamped with the signed-in account (the inspector).
     #/qc                 → worklist of job orders awaiting inspection
     #/qc?id=<jobOrderId>  → inspect: pass a batch by count, or unit-by-unit
   Checklists themselves are a named library, each belonging to one stage as a whole
   (QC = first pass, QA = final pass) — jo.qc_checklist_qc / jo.qc_checklist_qa carry
   the resolved one for each stage (the product's own link, or that stage's default).
   Mirrors public/js/modules/manufacturing/production-qc.js's checklistFor() /
   assign-checklist flow, adapted to mobile's full-view (not drawer) navigation. */
(function () {
  var SCAN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>';
  var canConfigQc = false;
  var canAdjust = false;
  var hasQc = false;
  var hasQa = false;
  var canInspect = false;

  MApp.route('qc', function (view, params) {
    canConfigQc = MApp.can('qc.configure');
    canAdjust = MApp.can('inventory.adjust');
    hasQc = MApp.can('production.inspect_qc');
    hasQa = MApp.can('production.inspect_qa');
    canInspect = canAdjust || hasQc || hasQa;
    var id = params && params.id;
    if (id) { load(view, id); }
    else { worklist(view); }
  });

  /* ---------- worklist ---------- */
  function worklist(view) {
    MApp.setTitle('QC / QA');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/job-orders')
      .then(function (rows) {
        view.innerHTML = '';
        var need = (rows || []).filter(function (j) {
          return j.qc_stages > 0 && ((j.units_pending || 0) > 0 || (j.units_rework || 0) > 0) && j.status !== 'cancelled';
        });
        if (!need.length) {
          view.appendChild(mEl('<div class="m-empty">Nothing waiting for inspection.</div>'));
          view.appendChild(mEl('<div class="m-hint">Units queue here after production progress on a job order that has QC/QA stages.</div>'));
          return;
        }
        var ul = mEl('<ul class="m-list"></ul>');
        need.forEach(function (j) {
          var bits = [];
          if (j.units_pending) bits.push(j.units_pending + ' to check');
          if (j.units_rework) bits.push(j.units_rework + ' repair');
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(j.number) + '</b>' +
            '<span>' + mEsc(j.product_name) + (j.qc_stages > 1 ? ' · ' + j.qc_stages + '-stage' : '') + '</span></div>' +
            '<div class="m-list-qty">' + mEsc(bits.join(' · ')) + '</div></li>'
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
      API.get('/production/repairs?job_order=' + id).catch(function () { return []; }),
    ])
      .then(function (r) { render(view, id, r[0], r[1], r[2] || [], r[3] || []); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /** The checklist(s) that apply to a set of units, by which pass(es) they're on — QC on
      a first pass, QA on a final one, both together on a single-stage job order. Mirrors
      desktop production-qc.js's checklistFor(). */
  function checklistFor(jo, units) {
    var totalStages = Math.max(1, jo.qc_stages || 1);
    var firstP = units.some(function (u) { return (u.stage || 0) + 1 === 1; });
    var finalP = units.some(function (u) { return (u.stage || 0) + 1 >= totalStages; });
    var items = [];
    var names = [];
    if (firstP && jo.qc_checklist_qc) {
      items = items.concat(jo.qc_checklist_qc.items.map(function (it) { return Object.assign({}, it, { _from: 'QC' }); }));
      names.push(jo.qc_checklist_qc.name);
    }
    if (finalP && jo.qc_checklist_qa) {
      items = items.concat(jo.qc_checklist_qa.items.map(function (it) { return Object.assign({}, it, { _from: 'QA' }); }));
      names.push(jo.qc_checklist_qa.name);
    }
    return { items: items, names: names };
  }

  /** Mirrors job-orders.routes.ts's /:id/units/inspect stage-aware check: a qc_inspector
      account may only pass/fail units on their first (QC) pass, a qa_inspector only their
      final (QA) one; a single-stage job order's one combined pass accepts either. Used to
      keep a narrow inspector's queue down to what they can actually act on, instead of
      offering units that will just 403 — same "guide, don't confuse" reasoning behind the
      rest of this app's mobile screens. */
  function passAllowed(jo, units) {
    if (canAdjust) return true;
    var totalStages = Math.max(1, jo.qc_stages || 1);
    var firstP = units.some(function (u) { return (u.stage || 0) + 1 === 1; });
    var finalP = units.some(function (u) { return (u.stage || 0) + 1 >= totalStages; });
    var combinedPass = totalStages <= 1;
    return combinedPass ? (hasQc || hasQa) : ((!firstP || hasQc) && (!finalP || hasQa));
  }

  function render(view, id, jo, units, log, repairs) {
    view.innerHTML = '';
    repairs = repairs || [];
    var stages = Math.max(1, jo.qc_stages || 1);
    var allPending = (units || []).filter(function (u) { return u.status === 'pending'; });
    var allRework = (units || []).filter(function (u) { return u.status === 'rework'; });
    // A narrow qc_inspector/qa_inspector account only sees the units it can actually act
    // on; inventory.adjust / combined-pass accounts see everything, so this is a no-op
    // for them.
    var pending = allPending.filter(function (u) { return passAllowed(jo, [u]); });
    var rework = allRework.filter(function (u) { return passAllowed(jo, [u]); });
    var otherStageCount = (allPending.length - pending.length) + (allRework.length - rework.length);
    // 'passed' = queued for Products In (not yet received); 'in_stock' = already received —
    // both count as "passed" here, since this is an inspection summary, not a stock count.
    var passed = (units || []).filter(function (u) { return u.status === 'passed' || u.status === 'in_stock'; }).length;
    var failed = (units || []).filter(function (u) { return u.status === 'failed'; }).length;
    var openReq = function (uid) {
      return repairs.filter(function (r) { return r.unit_id === uid && r.status === 'requested'; }).length;
    };
    var currentUnit = pending[0] || rework[0] || null;
    var currentStep = currentUnit ? ProductionSteps.unitStep(currentUnit, jo.qc_stages) : null;

    view.appendChild(mEl(
      '<div class="m-hint">' + mEsc(jo.number) + ' · ' + mEsc(jo.product_name) +
      (stages > 1 ? ' · ' + stages + '-stage QC' : '') +
      (currentStep ? ' · <b>' + mEsc(currentStep.label) + '</b>' : '') +
      ' · ' + passed + ' passed · ' + failed + ' scrapped</div>'
    ));

    if (canConfigQc) view.appendChild(checklistSummary(view, id, jo));

    if (!pending.length && !rework.length) {
      view.appendChild(mEl(otherStageCount > 0
        ? '<div class="m-empty">Nothing on your pass right now.</div>'
        : '<div class="m-empty">Nothing waiting for inspection.</div>'));
      if (otherStageCount > 0) {
        view.appendChild(mEl('<div class="m-hint">' + otherStageCount + ' unit(s) are waiting on the other inspection pass.</div>'));
      }
      if (log.length) view.appendChild(historyBlock(log));
      view.appendChild(actionBar([{ label: 'Back to QC/QA', fn: function () { worklist(view); } }]));
      return;
    }
    if (!canInspect) {
      view.appendChild(mEl('<div class="m-hint">You don\'t have permission to pass/fail units.</div>'));
      if (log.length) view.appendChild(historyBlock(log));
      view.appendChild(actionBar([{ label: 'Back to QC/QA', fn: function () { worklist(view); } }]));
      return;
    }

    var single = stages === 1;

    if (otherStageCount > 0) {
      view.appendChild(mEl('<div class="m-hint">' + otherStageCount + ' more unit(s) are waiting on the other inspection pass — not shown here.</div>'));
    }

    // ---- Pass a batch by count (fresh units only) ----
    if (pending.length) {
    var card = mEl(
      '<div class="m-jo-progress">' +
      '<h3 class="m-h3">Pass completed units</h3>' +
      '<div class="m-hint">' + pending.length + ' unit(s) awaiting inspection.' +
      (single ? ' Passing adds them to finished stock.' : ' Passing advances them one stage.') + '</div>' +
      '<label class="m-field"><span class="m-label">How many passed QC / QA?</span></label>' +
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
      var selected = pending.slice(0, n);
      var ids = selected.map(function (u) { return u.id; });
      var bid = card.querySelector('[data-bulk-id]').value.trim();
      var cl = checklistFor(jo, selected);
      checklistSheet(view, {
        title: 'Checklist — ' + n + ' unit(s)',
        items: cl.items, names: cl.names,
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
        '<div class="m-qc-id">Unit #' + u.id + (u.identifier ? ' · ' + mEsc(u.identifier) : '') + (stages > 1 ? ' · stage ' + uStage + ' / ' + stages : '') + '</div>' +
        '<div class="m-qc-btns">' +
        '<button class="m-btn m-btn-sm" data-pass>Pass</button>' +
        '<button class="m-btn m-btn-sm m-btn-warn" data-fail>Fail</button>' +
        '</div></div>'
      );
      row.querySelector('[data-pass]').onclick = function () {
        var cl = checklistFor(jo, [u]);
        checklistSheet(view, {
          title: 'Checklist — Unit #' + u.id,
          items: cl.items, names: cl.names,
          unitId: u.id,
          onCancel: function () { load(view, id); },
          onConfirm: function (payload) {
            submit(view, id, { unit_ids: [u.id], result: 'pass', checklist: payload.checklist, remarks: payload.remarks }, 'Unit #' + u.id + ' passed');
          },
        });
      };
      row.querySelector('[data-fail]').onclick = function () { failPrompt(view, id, u, checklistFor(jo, [u]).items); };
      wrap.appendChild(row);
    });
    view.appendChild(wrap);
    } // end if (pending.length)

    // ---- Units back from repair ----
    if (rework.length) {
      view.appendChild(mEl('<h3 class="m-h3">Back from repair (' + rework.length + ')</h3>'));
      var rw = mEl('<div class="m-qc-units"></div>');
      rework.forEach(function (u) {
        var uStage = u.stage + 1;
        var blocked = openReq(u.id) > 0;
        var row = mEl(
          '<div class="m-qc-unit">' +
          '<div class="m-qc-id">Unit #' + u.id + (u.identifier ? ' · ' + mEsc(u.identifier) : '') +
          (stages > 1 ? ' · stage ' + uStage + ' / ' + stages : '') + '</div>' +
          (blocked ? '<div class="m-hint">Waiting on the warehouse for parts — can\'t re-inspect yet.</div>' : '') +
          '<div class="m-qc-btns">' +
          '<button class="m-btn m-btn-sm" data-pass ' + (blocked ? 'disabled' : '') + '>Pass</button>' +
          '<button class="m-btn m-btn-sm m-btn-warn" data-fail>Fail</button>' +
          '<button class="m-btn m-btn-sm m-btn-secondary" data-parts>Request part</button>' +
          '</div></div>'
        );
        row.querySelector('[data-pass]').onclick = function () {
          if (blocked) return;
          var cl = checklistFor(jo, [u]);
          checklistSheet(view, {
            title: 'Re-inspect Unit #' + u.id,
            items: cl.items, names: cl.names,
            unitId: u.id,
            onCancel: function () { load(view, id); },
            onConfirm: function (payload) {
              submit(view, id, { unit_ids: [u.id], result: 'pass', checklist: payload.checklist, remarks: payload.remarks }, 'Unit #' + u.id + ' passed');
            },
          });
        };
        row.querySelector('[data-fail]').onclick = function () { failPrompt(view, id, u, checklistFor(jo, [u]).items); };
        row.querySelector('[data-parts]').onclick = function () { partsPrompt(view, id, u); };
        rw.appendChild(row);
      });
      view.appendChild(rw);
    }

    if (log.length) view.appendChild(historyBlock(log));
    view.appendChild(actionBar([{ label: 'Back to QC/QA', fn: function () { worklist(view); }, secondary: true }]));
  }

  /* ---------- checklist assignment (qc.configure only) ---------- */

  // A compact "QC: <name> · QA: <name>" line with a Change button per stage — sits at
  // the top of the job order's inspect view. Mirrors desktop's per-stage assign button.
  function checklistSummary(view, id, jo) {
    var box = mEl('<div class="m-qc-checklist-summary"></div>');
    [1, 2].forEach(function (stage) {
      var label = stage === 1 ? 'QC' : 'QA';
      var current = stage === 1 ? jo.qc_checklist_qc : jo.qc_checklist_qa;
      var row = mEl(
        '<div class="m-qc-checklist-row">' +
        '<span>' + label + ': <b>' + mEsc(current ? current.name : 'Default') + '</b></span>' +
        '<button type="button" class="m-btn m-btn-sm m-btn-secondary" data-change>Change</button>' +
        '</div>'
      );
      row.querySelector('[data-change]').onclick = function () { checklistPicker(view, id, jo, stage); };
      box.appendChild(row);
    });
    return box;
  }

  // Full-view searchable list of a stage's checklist library + "Use default" + "New
  // checklist" — assigning PATCHes /finished-products/:id/checklist (same endpoint
  // desktop uses) then returns to the job order view.
  function checklistPicker(view, id, jo, stage) {
    var label = stage === 1 ? 'QC' : 'QA';
    MApp.setTitle('Assign ' + label + ' checklist');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([
      API.get('/qc/checklists').catch(function () { return []; }),
      jo.product_item_id ? API.get('/finished-products/' + jo.product_item_id).catch(function () { return null; }) : Promise.resolve(null),
    ]).then(function (r) {
      var all = (r[0] || []).filter(function (c) { return Number(c.stage) === stage; });
      var product = r[1];
      var currentId = product ? (stage === 1 ? product.qc_checklist_qc_id : product.qc_checklist_qa_id) : null;
      var rows = [{ id: null, name: 'Use default', is_default: false }].concat(all);

      view.innerHTML = '';
      var search = mEl('<input class="m-input" placeholder="Search checklists…" style="margin-bottom:10px" />');
      view.appendChild(search);
      var listEl = mEl('<ul class="m-list"></ul>');
      view.appendChild(listEl);
      var newBtn = mEl('<button class="m-btn m-btn-secondary" style="margin-top:10px">+ New ' + label + ' checklist</button>');
      newBtn.onclick = function () { checklistEditor(view, id, jo, stage, null, function (newId) { assign(newId); }); };
      view.appendChild(newBtn);
      view.appendChild(actionBar([{ label: 'Cancel', fn: function () { load(view, id); }, secondary: true }]));

      function assign(checklistId) {
        API.patch('/finished-products/' + jo.product_item_id + '/checklist', { stage: stage, checklist_id: checklistId })
          .then(function () { mToast('Checklist assigned'); load(view, id); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); });
      }

      function renderList() {
        var q = search.value.trim().toLowerCase();
        var filtered = q ? rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; }) : rows;
        listEl.innerHTML = '';
        if (!filtered.length) { listEl.appendChild(mEl('<li class="m-hint">No checklists match.</li>')); return; }
        filtered.forEach(function (r) {
          var isCurrent = String(r.id == null ? '' : r.id) === String(currentId == null ? '' : currentId);
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(r.name) + (r.is_default ? ' <span class="m-badge-inline">default</span>' : '') + '</b></div>' +
            (isCurrent ? '<div class="m-list-qty">✓</div>' : '') + '</li>'
          );
          li.onclick = function () { assign(r.id); };
          listEl.appendChild(li);
        });
      }
      search.oninput = renderList;
      renderList();
    }).catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  // New/edit checklist form — name, stage (fixed to the stage passed in), default flag,
  // checks list. onSaved(id) fires once saved.
  function checklistEditor(view, id, jo, stage, existing, onSaved) {
    var label = stage === 1 ? 'QC' : 'QA';
    MApp.setTitle(existing ? 'Edit checklist' : 'New ' + label + ' checklist');
    var items = existing ? (existing.items || []).map(function (it) { return { label: it.label, required: !!it.required }; }) : [];

    var box = mEl(
      '<div class="m-form">' +
      '<label class="m-field"><span class="m-label">Name *</span><input class="m-input" data-name value="' + mEsc(existing ? existing.name : '') + '" /></label>' +
      '<label class="m-check"><input type="checkbox" data-default ' + (existing && existing.is_default ? 'checked' : '') + ' /> Default for ' + label + '</label>' +
      '<h3 class="m-h3">Checks</h3><div data-items></div>' +
      '<button type="button" class="m-btn m-btn-secondary" data-add>+ Add check</button>' +
      '</div>'
    );
    var itemsEl = box.querySelector('[data-items]');
    function drawItems() {
      itemsEl.innerHTML = '';
      if (!items.length) { itemsEl.appendChild(mEl('<div class="m-hint">No checks yet.</div>')); }
      items.forEach(function (it, i) {
        var row = mEl(
          '<div class="m-qc-check">' +
          '<input class="m-input" data-label value="' + mEsc(it.label) + '" placeholder="e.g. Dimensions within tolerance" />' +
          '<label class="m-check"><input type="checkbox" data-req ' + (it.required ? 'checked' : '') + ' /> Required</label>' +
          '<button type="button" class="m-btn m-btn-sm m-btn-secondary" data-rm>Remove</button>' +
          '</div>'
        );
        row.querySelector('[data-label]').oninput = function (e) { items[i].label = e.target.value; };
        row.querySelector('[data-req]').onchange = function (e) { items[i].required = e.target.checked; };
        row.querySelector('[data-rm]').onclick = function () { items.splice(i, 1); drawItems(); };
        itemsEl.appendChild(row);
      });
    }
    box.querySelector('[data-add]').onclick = function () { items.push({ label: '', required: false }); drawItems(); };
    drawItems();

    var acts = mEl('<div class="m-actions"><button class="m-btn" data-save>Save</button><button class="m-btn m-btn-secondary" data-cancel>Cancel</button></div>');
    box.appendChild(acts);
    acts.querySelector('[data-cancel]').onclick = function () { checklistPicker(view, id, jo, stage); };
    acts.querySelector('[data-save]').onclick = function () {
      var name = box.querySelector('[data-name]').value.trim();
      if (!name) { mToast('Name is required', 'err'); return; }
      var clean = items.map(function (it) { return { label: (it.label || '').trim(), required: !!it.required }; }).filter(function (it) { return it.label; });
      var body = { name: name, stage: stage, is_default: box.querySelector('[data-default]').checked, items: clean };
      acts.querySelector('[data-save]').disabled = true;
      var req = existing ? API.put('/qc/checklists/' + existing.id, body) : API.post('/qc/checklists', body);
      req.then(function (r) {
        mToast('Checklist saved');
        onSaved(existing ? existing.id : r.id);
      }).catch(function (ex) { mToast(ex.message || 'Failed', 'err'); acts.querySelector('[data-save]').disabled = false; });
    };

    view.innerHTML = '';
    view.appendChild(box);
  }

  /* ---------- request a part for a rework unit ---------- */
  function partsPrompt(view, id, unit) {
    var picked = null;
    var box = mEl(
      '<div class="m-qc-prompt"><div class="m-qc-prompt-t">Request a part — Unit #' + unit.id + '</div>' +
      '<label class="m-field"><span class="m-label">Kind</span><select class="m-input" data-kind>' +
      '<option value="replace">Replace a fitted part</option><option value="add">Add a missing part</option></select></label>' +
      '<div data-picker></div>' +
      '<div class="m-hint" data-pick-lbl>No component picked.</div>' +
      '<div class="m-two">' +
      '<label class="m-field"><span class="m-label">Qty</span><input type="number" inputmode="numeric" class="m-input" data-qty value="1" min="1" /></label>' +
      '<label class="m-field"><span class="m-label">Fault</span><select class="m-input" data-fault>' +
      '<option value="assembler">Assembler</option><option value="production">Production</option>' +
      '<option value="supplier">Supplier</option><option value="wear">Wear</option><option value="other">Other</option></select></label>' +
      '</div>' +
      '<label class="m-check"><input type="checkbox" data-dmg checked /> Old part goes to the damage record</label>' +
      '<label class="m-field"><span class="m-label">Note (optional)</span><input class="m-input" data-note /></label>' +
      '</div>'
    );
    var picker = mItemPicker({ label: 'Component', onPick: function (it) {
      picked = it;
      box.querySelector('[data-pick-lbl]').textContent = it.name + (it.sku ? ' (#' + it.sku + ')' : '');
    } });
    box.querySelector('[data-picker]').appendChild(picker.el);
    var acts = mEl('<div class="m-actions"><button class="m-btn" data-ok>Send request</button>' +
      '<button class="m-btn m-btn-secondary" data-cancel>Cancel</button></div>');
    box.appendChild(acts);
    acts.querySelector('[data-cancel]').onclick = function () { load(view, id); };
    acts.querySelector('[data-ok]').onclick = function () {
      if (!picked) { mToast('Pick a component', 'err'); return; }
      acts.querySelector('[data-ok]').disabled = true;
      var body = {
        kind: box.querySelector('[data-kind]').value,
        component_item_id: picked.id,
        quantity: parseInt(box.querySelector('[data-qty]').value, 10) || 1,
        fault: box.querySelector('[data-fault]').value,
        return_to_damage: box.querySelector('[data-dmg]').checked,
        notes: (box.querySelector('[data-note]').value || '').trim() || null,
      };
      mSubmit('/production/units/' + unit.id + '/repairs', body, { label: 'Part request · unit #' + unit.id })
        .then(function (res) { mToast(res && res.queued ? 'Queued (offline)' : 'Request sent to the warehouse'); load(view, id); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); acts.querySelector('[data-ok]').disabled = false; });
    };
    view.innerHTML = '';
    view.appendChild(box);
  }

  function submit(view, id, body, okMsg) {
    view.innerHTML = '<div class="m-hint">Saving…</div>';
    mSubmit('/job-orders/' + id + '/units/inspect', body, { label: okMsg })
      .then(function (r) { mToast(r && r.queued ? 'Queued (offline) — ' + okMsg : okMsg); load(view, id); })
      .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); load(view, id); });
  }

  /* ---------- checklist sheet (a pass needs every required check ticked OK) ---------- */
  function checklistSheet(view, opts) {
    var items = opts.items || [];
    var title = opts.title || 'QC / QA checklist';
    if (opts.names && opts.names.length) title += ' — ' + opts.names.join(' + ');
    var box = mEl('<div class="m-qc-prompt"><div class="m-qc-prompt-t">' + mEsc(title) + '</div></div>');
    if (!items.length) {
      box.appendChild(mEl('<div class="m-hint">No checklist configured for this stage.</div>'));
    }
    var rows = [];
    items.forEach(function (it, i) {
      var r = mEl(
        '<div class="m-qc-check">' +
        '<label class="m-check m-qc-check-lbl"><input type="checkbox" data-ok /> ' +
        mEsc(it.label) + (it.required ? ' <span class="m-req">*</span>' : '') +
        (it._from ? ' <span class="m-hint">(' + it._from + ')</span>' : '') + '</label>' +
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
        return { label: r._item.label, ok: ok };
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
      '<label class="m-field"><span class="m-label">What to do with it</span>' +
      '<select class="m-input" data-disp>' +
      '<option value="scrap">Scrap</option><option value="dispose">Dispose</option>' +
      '<option value="recycle">Recycle</option><option value="repair">Repair (send to rework)</option>' +
      '</select></label>' +
      '<div class="m-hint">Scrap / dispose / recycle are final. Repair sends the unit to rework — parts are then requested from the warehouse.</div>' +
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
      var disp = box.querySelector('[data-disp]').value;
      var body = { unit_ids: [unit.id], result: 'fail', disposition: disp, remarks: val };
      if (rows.length) {
        body.checklist = rows.map(function (r) { return { label: r._item.label, ok: r.querySelector('[data-ok]').checked }; });
      }
      acts.querySelector('[data-ok]').disabled = true;
      submit(view, id, body, disp === 'repair' ? 'Sent to repair' : 'Recorded — unit scrapped');
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
        'Unit #' + (q.unit_id || '?') + (q.stage ? ' · stage ' + q.stage : '') +
        (q.disposition ? ' · ' + mEsc(q.disposition) : '') + '</div>' +
        '<div class="m-qc-log-meta">' + mEsc(q.inspector_name || 'unknown') + ' · ' + mEsc((q.created_at || '').slice(0, 16).replace('T', ' ')) + '</div>' +
        (q.remarks ? '<div class="m-qc-log-note">' + mEsc(q.remarks) + '</div>' : '') +
        (fails ? '<div class="m-qc-log-note">Checklist issues: ' + mEsc(fails) + '</div>' : '') +
        '</div>'
      );
      if (q.unit_id && !seenUnits[q.unit_id]) {
        seenUnits[q.unit_id] = 1;
        var link = mEl('<button class="m-btn m-btn-sm m-btn-secondary" style="margin-top:4px">View record</button>');
        link.onclick = function () { MApp.go('record', { unit: q.unit_id }); };
        row.appendChild(link);
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
