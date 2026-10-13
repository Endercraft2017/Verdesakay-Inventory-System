/* Fix a punch — file an attendance correction for a missed / wrong time punch,
   and track the ones you've filed. */
(function () {
  var STATUS_CLASS = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '' };

  function view0(view) {
    MApp.setTitle('Fix a punch');
    view.innerHTML =
      '<div class="m-actions"><button class="m-btn" id="m-tf-new">＋ Report a missed punch</button></div>' +
      '<h3 class="m-sec">Your requests</h3>' +
      '<div id="m-tf-list"><div class="m-hint">Loading…</div></div>';
    view.querySelector('#m-tf-new').onclick = function () { form(view); };
    var host = view.querySelector('#m-tf-list');
    API.get('/me/time-corrections')
      .then(function (rows) {
        if (!rows.length) { host.innerHTML = '<div class="m-empty">Nothing filed yet.</div>'; return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (r) {
          var times = [r.requested_in ? 'in ' + r.requested_in : '', r.requested_out ? 'out ' + r.requested_out : '']
            .filter(Boolean).join(' · ');
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(r.work_date) + '</b>' +
            '<span>' + mEsc(times) + '</span></div>' +
            '<div class="m-list-qty"><span class="m-jo-status ' + (STATUS_CLASS[r.status] || '') + '">' +
            mEsc(r.status) + '</span></div></li>'
          );
          li.onclick = function () { detail(view, r); };
          ul.appendChild(li);
        });
        host.innerHTML = '';
        host.appendChild(ul);
      })
      .catch(function (ex) { host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function detail(view, r) {
    MApp.setTitle(r.work_date);
    view.innerHTML = '';
    var kv = '<li><span>Work date</span><b>' + mEsc(r.work_date) + '</b></li>' +
      (r.requested_in ? '<li><span>Time in</span><b>' + mEsc(r.requested_in) + '</b></li>' : '') +
      (r.requested_out ? '<li><span>Time out</span><b>' + mEsc(r.requested_out) + '</b></li>' : '') +
      '<li><span>Status</span><b>' + mEsc(r.status) + '</b></li>' +
      (r.decided_by_name ? '<li><span>Decided by</span><b>' + mEsc(r.decided_by_name) + '</b></li>' : '') +
      (r.decision_note ? '<li><span>Note</span><b>' + mEsc(r.decision_note) + '</b></li>' : '');
    view.appendChild(mEl('<ul class="m-kv">' + kv + '</ul>'));
    view.appendChild(mEl('<div class="m-hint">Reason: ' + mEsc(r.reason) + '</div>'));
    var acts = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary" data-back>Back</button></div>');
    acts.querySelector('[data-back]').onclick = function () { view0(view); };
    if (r.status === 'pending') {
      var cancel = mEl('<button class="m-btn m-btn-warn" data-cancel>Cancel request</button>');
      cancel.onclick = function () {
        cancel.disabled = true;
        API.post('/me/time-corrections/' + r.id + '/cancel')
          .then(function () { mToast('Cancelled'); view0(view); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); cancel.disabled = false; });
      };
      acts.appendChild(cancel);
    }
    view.appendChild(acts);
  }

  function form(view) {
    MApp.setTitle('Report a missed punch');
    view.innerHTML = '';
    var f = mEl(
      '<form class="m-form">' +
      '<label class="m-field"><span class="m-label">Work date *</span><input class="m-input" type="date" data-k="work_date" /></label>' +
      '<label class="m-field"><span class="m-label">Time in</span><input class="m-input" type="time" data-k="requested_in" /></label>' +
      '<label class="m-field"><span class="m-label">Time out</span><input class="m-input" type="time" data-k="requested_out" /></label>' +
      '<label class="m-field"><span class="m-label">Reason *</span><textarea class="m-input" data-k="reason" rows="3" maxlength="1000"></textarea></label>' +
      '<div class="m-hint">Enter at least a time-in or a time-out. Your department head or HR will review it.</div>' +
      '<div class="m-actions"><button class="m-btn" type="submit">Submit</button>' +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></form>'
    );
    f.querySelector('[data-cancel]').onclick = function () { view0(view); };
    f.onsubmit = function (e) {
      e.preventDefault();
      var wd = f.querySelector('[data-k="work_date"]').value;
      var ti = f.querySelector('[data-k="requested_in"]').value;
      var to = f.querySelector('[data-k="requested_out"]').value;
      var reason = f.querySelector('[data-k="reason"]').value.trim();
      if (!wd) { mToast('Work date is required', 'err'); return; }
      if (!ti && !to) { mToast('Enter a time-in or a time-out', 'err'); return; }
      if (reason.length < 3) { mToast('A short reason is required', 'err'); return; }
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      mSubmit('/me/time-corrections', {
        work_date: wd, requested_in: ti || null, requested_out: to || null, reason: reason,
      }, { label: 'Attendance correction · ' + wd })
        .then(function (sent) {
          if (sent.queued) { mToast('Saved on this phone. It will be sent when you reconnect.'); MApp.go('queue'); }
          else { mToast('Submitted'); view0(view); }
        })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
    view.appendChild(f);
  }

  MApp.route('time-fix', function (view) { view0(view); });
})();
