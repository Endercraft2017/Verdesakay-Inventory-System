/* Announcements — everyone reads; `announce` holders can post / pin / remove. */
(function () {
  function canPost() { return MApp.can('announce'); }

  function list(view) {
    MApp.setTitle('Announcements');
    var head = canPost()
      ? '<div class="m-actions"><button class="m-btn" id="m-ann-new">＋ New announcement</button></div>'
      : '';
    view.innerHTML = head + '<div id="m-ann-list"><div class="m-hint">Loading…</div></div>';
    if (canPost()) view.querySelector('#m-ann-new').onclick = function () { compose(view); };
    var host = view.querySelector('#m-ann-list');
    API.get('/announcements')
      .then(function (rows) {
        if (!rows.length) { host.innerHTML = '<div class="m-empty">No announcements right now.</div>'; return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (r) {
          var li = mEl(
            '<li class="m-list-row"><div><b>' + (r.pinned ? '📌 ' : '') + mEsc(r.title) + '</b>' +
            '<span>' + mEsc(r.created_by_name || '') + ' · ' + mEsc((r.created_at || '').slice(0, 10)) + '</span></div>' +
            '<div class="m-list-qty">›</div></li>'
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
    MApp.setTitle(r.title);
    view.innerHTML = '';
    view.appendChild(mEl(
      '<div class="m-hint">' + (r.pinned ? '📌 Pinned · ' : '') +
      mEsc(r.created_by_name || '') + ' · ' + mEsc((r.created_at || '').slice(0, 16).replace('T', ' ')) +
      (r.expires_at ? ' · until ' + mEsc(r.expires_at.slice(0, 10)) : '') + '</div>'
    ));
    var body = mEl('<div class="m-ann-body"></div>');
    body.textContent = r.body;
    view.appendChild(body);
    var acts = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary" data-back>Back</button></div>');
    acts.querySelector('[data-back]').onclick = function () { list(view); };
    if (canPost()) {
      var del = mEl('<button class="m-btn m-btn-warn" data-del>Delete</button>');
      del.onclick = function () {
        del.disabled = true;
        API.del('/announcements/' + r.id)
          .then(function () { mToast('Deleted'); list(view); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); del.disabled = false; });
      };
      acts.appendChild(del);
    }
    view.appendChild(acts);
  }

  function compose(view) {
    MApp.setTitle('New announcement');
    view.innerHTML = '';
    var f = mEl(
      '<form class="m-form">' +
      '<label class="m-field"><span class="m-label">Title *</span><input class="m-input" data-k="title" maxlength="160" /></label>' +
      '<label class="m-field"><span class="m-label">Message *</span><textarea class="m-input" data-k="body" rows="5" maxlength="5000"></textarea></label>' +
      '<label class="m-field"><span class="m-label">Hide after (optional)</span><input class="m-input" type="date" data-k="expires" /></label>' +
      '<label class="m-field m-check"><input type="checkbox" data-k="pinned" /> Pin to top</label>' +
      '<label class="m-field m-check"><input type="checkbox" data-k="notify" /> Also send a notification to everyone</label>' +
      '<div class="m-actions"><button class="m-btn" type="submit">Post</button>' +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></form>'
    );
    f.querySelector('[data-cancel]').onclick = function () { list(view); };
    f.onsubmit = function (e) {
      e.preventDefault();
      var title = f.querySelector('[data-k="title"]').value.trim();
      var body = f.querySelector('[data-k="body"]').value.trim();
      if (!title || !body) { mToast('Title and message are required', 'err'); return; }
      var exp = f.querySelector('[data-k="expires"]').value;
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      API.post('/announcements', {
        title: title, body: body,
        pinned: f.querySelector('[data-k="pinned"]').checked,
        notify: f.querySelector('[data-k="notify"]').checked,
        expires_at: exp ? exp + ' 23:59' : null,
      })
        .then(function () { mToast('Posted'); list(view); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
    view.appendChild(f);
  }

  MApp.route('announcements', function (view) { list(view); });
})();
