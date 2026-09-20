/* Production record — read-only dossier for one produced unit or batch, opened from a
   scanned QR label or the QC screen. #/record?unit=<id> | #/record?batch=<id>. */
(function () {
  function dt(s) { return mEsc((s || '').slice(0, 16).replace('T', ' ')); }

  function load(view, params) {
    var qs = params && params.unit ? 'unit=' + encodeURIComponent(params.unit)
      : params && params.batch ? 'batch=' + encodeURIComponent(params.batch) : '';
    if (!qs) { view.innerHTML = '<div class="m-empty">No record selected.</div>'; return; }
    MApp.setTitle('Record');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/production/record?' + qs)
      .then(function (d) { render(view, d); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Not found') + '</div>'; });
  }

  function render(view, d) {
    view.innerHTML = '';
    var p = d.product || {};
    var jo = d.job_order || {};
    var u = d.unit || null;
    var b = d.batch || null;
    var head = u ? (u.identifier || ('Unit #' + u.id)) : (b.number + (b.identifier ? ' · ' + b.identifier : ''));
    MApp.setTitle(head);

    view.appendChild(mEl(
      '<div class="m-jo-head"><h2>' + mEsc(p.name || jo.product_name || '—') + '</h2>' +
      '<div class="m-jo-meta">' + mEsc(head) + '</div>' +
      (p.variant ? '<div class="m-hint">Variant: ' + mEsc(p.variant) + (p.model ? ' · ' + mEsc(p.model) : '') + '</div>' : '') +
      '</div>'
    ));

    var kv = mEl('<ul class="m-kv"></ul>');
    function row(k, v) { kv.appendChild(mEl('<li><span>' + mEsc(k) + '</span><b>' + v + '</b></li>')); }
    if (u) {
      row('Status', mEsc(u.status) + (u.disposition ? ' (' + mEsc(u.disposition) + ')' : ''));
      row('Location', mEsc(u.location_name || '—'));
      if (u.batch_number) row('Batch', mEsc(u.batch_number));
      if (u.order_number) row('Sales order', mEsc(u.order_number));
    } else {
      row('Batch status', mEsc(b.status));
      row('Quantity', b.qty);
      if (b.created_by_name) row('Created by', mEsc(b.created_by_name));
    }
    row('Built', dt((u || b).created_at));
    if (jo.number) {
      row('Job order', mEsc(jo.number));
      if (jo.team_name) row('Team', mEsc(jo.team_name));
      if (jo.created_by_name) row('Made by', mEsc(jo.created_by_name));
      if (jo.released_by_name) row('Released by', mEsc(jo.released_by_name));
    }
    view.appendChild(kv);

    // QA/QC
    view.appendChild(mEl('<h3 class="m-h3">QA / QC</h3>'));
    var qc = d.qc || [];
    if (!qc.length) {
      view.appendChild(mEl('<div class="m-hint">No inspection recorded.</div>'));
    } else {
      var ql = mEl('<div class="m-qc-log"></div>');
      qc.forEach(function (q) {
        var fails = (Array.isArray(q.checklist) ? q.checklist : []).filter(function (c) { return c.ok === false; })
          .map(function (c) { return c.label; }).join(', ');
        ql.appendChild(mEl(
          '<div class="m-qc-log-row"><div><b class="m-qc-log-' + (q.result === 'pass' ? 'ok' : 'bad') + '">' +
          (q.result === 'pass' ? 'PASS' : 'FAIL') + '</b>' + (q.stage ? ' · stage ' + q.stage : '') +
          (q.disposition ? ' · ' + mEsc(q.disposition) : '') + '</div>' +
          '<div class="m-qc-log-meta">' + mEsc(q.inspector_name || 'unknown') + ' · ' + dt(q.created_at) + '</div>' +
          (q.remarks ? '<div class="m-qc-log-note">' + mEsc(q.remarks) + '</div>' : '') +
          (fails ? '<div class="m-qc-log-note">Issues: ' + mEsc(fails) + '</div>' : '') + '</div>'
        ));
      });
      view.appendChild(ql);
    }

    // Repairs
    if (d.repairs && d.repairs.length) {
      view.appendChild(mEl('<h3 class="m-h3">Repairs</h3>'));
      var rl = mEl('<ul class="m-list"></ul>');
      d.repairs.forEach(function (r) {
        rl.appendChild(mEl(
          '<li class="m-list-row"><div><b>' + mEsc(r.number) + ' · ' + mEsc(r.kind) + '</b>' +
          '<span>' + mEsc(r.component_name) + ' ×' + r.quantity + (r.fault ? ' · ' + mEsc(r.fault) : '') + '</span></div>' +
          '<div class="m-list-qty">' + mEsc(r.status) + '</div></li>'
        ));
      });
      view.appendChild(rl);
    }

    // Movements
    if (d.movements && d.movements.length) {
      view.appendChild(mEl('<h3 class="m-h3">Stock movements</h3>'));
      var ml = mEl('<ul class="m-kv"></ul>');
      d.movements.slice(0, 15).forEach(function (m) {
        ml.appendChild(mEl('<li><span>' + dt(m.created_at) + ' · ' + mEsc(m.reason || '') + '</span><b>' +
          (m.change > 0 ? '+' : '') + m.change + '</b></li>'));
      });
      view.appendChild(ml);
    }

    var acts = mEl('<div class="m-actions"></div>');
    var back = mEl('<button class="m-btn m-btn-secondary">Back</button>');
    back.onclick = function () { history.length > 1 ? history.back() : MApp.go('home'); };
    acts.appendChild(back);
    view.appendChild(acts);
  }

  MApp.route('record', function (view, params) { load(view, params); });
})();
