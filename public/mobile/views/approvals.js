/* To Approve — department heads and HR decide pending requests + time fixes. */
(function () {
  function titleCase(k) {
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function list(view) {
    MApp.setTitle('To Approve');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/approvals')
      .then(function (res) {
        view.innerHTML = '';
        var reqs = res.requests || [];
        var tcs = res.time_corrections || [];
        if (!reqs.length && !tcs.length) {
          view.appendChild(mEl('<div class="m-empty">Nothing waiting on you. 🎉</div>'));
          return;
        }
        if (reqs.length) {
          view.appendChild(mEl('<h3 class="m-sec">Requests</h3>'));
          var ru = mEl('<ul class="m-list"></ul>');
          reqs.forEach(function (r) {
            var li = mEl(
              '<li class="m-list-row"><div><b>' + mEsc(r.form_name) + '</b>' +
              '<span>' + mEsc(r.employee_name || r.filed_by || '') + ' · ' + mEsc(r.number) + '</span></div>' +
              '<div class="m-list-qty">›</div></li>'
            );
            li.onclick = function () { reqDetail(view, r); };
            ru.appendChild(li);
          });
          view.appendChild(ru);
        }
        if (tcs.length) {
          view.appendChild(mEl('<h3 class="m-sec">Time fixes</h3>'));
          var tu = mEl('<ul class="m-list"></ul>');
          tcs.forEach(function (r) {
            var times = [r.requested_in ? 'in ' + r.requested_in : '', r.requested_out ? 'out ' + r.requested_out : '']
              .filter(Boolean).join(' · ');
            var li = mEl(
              '<li class="m-list-row"><div><b>' + mEsc(r.employee_name) + '</b>' +
              '<span>' + mEsc(r.work_date) + ' · ' + mEsc(times) + '</span></div>' +
              '<div class="m-list-qty">›</div></li>'
            );
            li.onclick = function () { tcDetail(view, r); };
            tu.appendChild(li);
          });
          view.appendChild(tu);
        }
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /** Shared decide UI: renders a note field + Approve / Reject that POST to `path`. */
  function decideBar(view, path, onDone) {
    var bar = mEl(
      '<form class="m-form"><label class="m-field"><span class="m-label">Note (optional)</span>' +
      '<input class="m-input" data-k="note" maxlength="1000" /></label>' +
      '<div class="m-actions"><button class="m-btn" data-ok type="button">Approve</button>' +
      '<button class="m-btn m-btn-warn" data-no type="button">Reject</button></div>' +
      '<div class="m-actions"><button class="m-btn m-btn-secondary" data-back type="button">Back</button></div></form>'
    );
    function send(decision) {
      var btns = bar.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
      API.post(path, { decision: decision, note: bar.querySelector('[data-k="note"]').value.trim() || null })
        .then(function () { mToast(decision === 'approved' ? 'Approved' : 'Rejected'); onDone(); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btns.forEach(function (b) { b.disabled = false; }); });
    }
    bar.querySelector('[data-ok]').onclick = function () { send('approved'); };
    bar.querySelector('[data-no]').onclick = function () { send('rejected'); };
    bar.querySelector('[data-back]').onclick = function () { list(view); };
    view.appendChild(bar);
  }

  function reqDetail(view, r) {
    MApp.setTitle(r.form_name);
    view.innerHTML = '';
    view.appendChild(mEl('<div class="m-hint">' + mEsc(r.number) + ' · filed ' +
      mEsc((r.created_at || '').slice(0, 10)) + ' by ' + mEsc(r.filed_by || r.employee_name || '') + '</div>'));
    var d = r.data || {};
    var rows = Object.keys(d)
      .filter(function (k) { return d[k] != null && String(d[k]).trim() !== '' && typeof d[k] !== 'object' && k !== 'decided_by' && k !== 'decided_at' && k !== 'decision_note'; })
      .map(function (k) { return '<li><span>' + mEsc(titleCase(k)) + '</span><b>' + mEsc(String(d[k])) + '</b></li>'; })
      .join('');
    view.appendChild(mEl('<ul class="m-kv">' + rows + '</ul>'));
    decideBar(view, '/me/approvals/requests/' + r.id + '/decide', function () { list(view); });
  }

  function tcDetail(view, r) {
    MApp.setTitle('Time fix · ' + r.employee_name);
    view.innerHTML = '';
    var kv = '<li><span>Employee</span><b>' + mEsc(r.employee_name) + '</b></li>' +
      '<li><span>Work date</span><b>' + mEsc(r.work_date) + '</b></li>' +
      (r.requested_in ? '<li><span>Time in</span><b>' + mEsc(r.requested_in) + '</b></li>' : '') +
      (r.requested_out ? '<li><span>Time out</span><b>' + mEsc(r.requested_out) + '</b></li>' : '');
    view.appendChild(mEl('<ul class="m-kv">' + kv + '</ul>'));
    view.appendChild(mEl('<div class="m-hint">Reason: ' + mEsc(r.reason) + '</div>'));
    decideBar(view, '/me/approvals/time-corrections/' + r.id + '/decide', function () { list(view); });
  }

  MApp.route('approvals', function (view) { list(view); });
})();
