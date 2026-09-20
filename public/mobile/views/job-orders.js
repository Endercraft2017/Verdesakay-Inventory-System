/* Manufacturing shop-floor — job order board. List by status, open one, record
   production progress, pause / resume / close, release a draft. */
(function () {
  var OPEN = ['draft', 'released', 'in_progress', 'paused'];

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
            '<div class="m-list-qty"><span class="m-jo-status ' + j.status + '">' + j.status.replace('_', ' ') + '</span>' +
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

    var acts = mEl('<div class="m-actions"></div>');

    if (jo.status === 'draft') {
      addBtn(acts, 'Release to production', function () { act(view, jo.id, 'release'); });
    }
    if (jo.status === 'released' || jo.status === 'in_progress') {
      var prog = mEl(
        '<div class="m-jo-progress">' +
        '<h3 class="m-h3">Record production (' + remaining + ' left)</h3>' +
        '<div class="m-two">' +
        '<label class="m-field"><span class="m-label">Finished</span><input type="number" inputmode="numeric" class="m-input" data-done value="0" min="0" /></label>' +
        '<label class="m-field"><span class="m-label">Scrapped</span><input type="number" inputmode="numeric" class="m-input" data-scrap value="0" min="0" /></label>' +
        '</div>' +
        '<label class="m-field"><span class="m-label">Batch / lot ' + (jo.qc_stages > 0 ? '(optional)' : '(auto)') + '</span>' +
        '<input class="m-input" data-batch placeholder="' + (jo.qc_stages > 0 ? 'label to group these units' : 'auto BATCH-#####') + '" /></label>' +
        '</div>'
      );
      view.appendChild(prog);
      addBtn(acts, 'Save progress', function () {
        var d = parseInt(prog.querySelector('[data-done]').value, 10) || 0;
        var s = parseInt(prog.querySelector('[data-scrap]').value, 10) || 0;
        if (d + s < 1) { mToast('Enter finished and/or scrapped', 'err'); return; }
        var bl = (prog.querySelector('[data-batch]').value || '').trim();
        act(view, jo.id, 'progress', { done_delta: d, scrapped_delta: s, batch_label: bl || null });
      });
      addBtn(acts, 'Pause', function () { act(view, jo.id, 'pause'); }, true);
      addBtn(acts, 'Close out early', function () { act(view, jo.id, 'close'); }, true);
    }
    if (jo.status === 'paused') {
      addBtn(acts, 'Resume', function () { act(view, jo.id, 'resume'); });
    }
    if (jo.qc_stages > 0 && jo.units_summary && jo.units_summary.pending > 0) {
      addBtn(acts, 'Inspect ' + jo.units_summary.pending + ' unit(s)', function () { MApp.go('qc', { id: jo.id }); });
    }
    addBtn(acts, 'Back to board', function () { board(view); }, true);
    view.appendChild(acts);
  }

  function addBtn(host, label, fn, secondary) {
    var b = mEl('<button class="m-btn ' + (secondary ? 'm-btn-secondary' : '') + '">' + mEsc(label) + '</button>');
    b.onclick = fn;
    host.appendChild(b);
  }

  MApp.route('job-orders', function (view) { board(view); });
})();
