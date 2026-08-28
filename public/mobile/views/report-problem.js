/* Report a problem to a superior — sends an internal message (POST /api/messages).
   Reachable from Home and, with context, from an item's detail screen
   (#/report-problem?about=<text>). */
(function () {
  var CATEGORIES = ['Stock shortage', 'Damaged goods', 'Wrong / mislabeled item', 'Equipment / vehicle', 'Safety', 'Space / storage', 'Other'];

  MApp.route('report-problem', function (view, params) {
    MApp.setTitle('Report a problem');

    var f = mEl(
      '<form class="m-form">' +
      '  <label class="m-field"><span class="m-label">Send to</span>' +
      '    <select class="m-select" data-to></select></label>' +
      '  <label class="m-field"><span class="m-label">About</span>' +
      '    <select class="m-select" data-cat>' +
      CATEGORIES.map(function (c) { return '<option>' + mEsc(c) + '</option>'; }).join('') +
      '    </select></label>' +
      '  <label class="m-field"><span class="m-label">Item / location (optional)</span>' +
      '    <input type="text" class="m-input" data-ref maxlength="160" placeholder="e.g. Bond Paper A4 / Bay N" /></label>' +
      '  <label class="m-field"><span class="m-label">What’s wrong?</span>' +
      '    <textarea class="m-input" data-body rows="4" maxlength="1500" required placeholder="Describe the problem"></textarea></label>' +
      '  <div class="m-actions"><button class="m-btn m-btn-warn" type="submit">Send report</button></div>' +
      '</form>'
    );
    if (params && params.about) f.querySelector('[data-ref]').value = params.about;

    var sel = f.querySelector('[data-to]');
    sel.innerHTML = '<option>Loading…</option>';
    mUsers.load()
      .then(function () {
        var ranked = mUsers.ranked();
        if (!ranked.length) { sel.innerHTML = '<option value="">No one to notify</option>'; return; }
        var sup = ranked.filter(mUsers.isSupervisor);
        var other = ranked.filter(function (u) { return !mUsers.isSupervisor(u); });
        function opt(u) {
          return '<option value="' + u.id + '">' + mEsc(u.full_name) +
            (u.department_name ? ' — ' + mEsc(u.department_name) : '') + '</option>';
        }
        var html = '';
        if (sup.length) html += '<optgroup label="Supervisors">' + sup.map(opt).join('') + '</optgroup>';
        if (other.length) html += '<optgroup label="Other staff">' + other.map(opt).join('') + '</optgroup>';
        sel.innerHTML = html;
      })
      .catch(function () { sel.innerHTML = '<option value="">Could not load staff</option>'; });

    f.onsubmit = function (e) {
      e.preventDefault();
      var to = Number(sel.value);
      var body = f.querySelector('[data-body]').value.trim();
      if (!to) { mToast('Pick who to send this to', 'err'); return; }
      if (!body) { mToast('Describe the problem', 'err'); return; }
      var cat = f.querySelector('[data-cat]').value;
      var ref = f.querySelector('[data-ref]').value.trim();
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      var toName = sel.options[sel.selectedIndex].text;
      mSubmit('/messages', {
        recipient_id: to,
        subject: '⚠ Warehouse: ' + cat + (ref ? ' — ' + ref : ''),
        body: body + (ref ? '\n\nRe: ' + ref : '') + '\n\n— reported from the warehouse app',
      }, { label: 'Report to ' + toName + ' — ' + cat })
        .then(function (r) {
          mSuccess(view, {
            title: r.queued ? 'Saved — will send' : 'Report sent',
            lines: r.queued
              ? ['To ' + toName + ' · ' + cat, 'You’re offline. It will send when back online.']
              : ['Sent to ' + toName, cat],
            actions: [
              { label: 'Report another', onClick: function () { MApp.render(); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Could not send', 'err'); btn.disabled = false; });
    };

    view.appendChild(f);
  });
})();
