/* Inbox — read / reply to internal messages. */
(function () {
  var box = 'inbox';

  function list(view) {
    MApp.setTitle('Messages');
    view.innerHTML =
      '<div class="m-tabs"><button data-b="inbox" class="on">Inbox</button><button data-b="sent">Sent</button></div>' +
      '<div data-list><div class="m-hint">Loading…</div></div>';
    view.querySelectorAll('.m-tabs button').forEach(function (b) {
      b.onclick = function () {
        box = b.dataset.b;
        view.querySelectorAll('.m-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        loadRows(view);
      };
    });
    loadRows(view);
  }

  function loadRows(view) {
    var host = view.querySelector('[data-list]');
    host.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/messages?box=' + box)
      .then(function (rows) {
        if (!rows.length) { host.innerHTML = '<div class="m-empty">Nothing here.</div>'; return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (m) {
          var unread = box === 'inbox' && !m.read_at;
          var clip = (m.attachments && m.attachments.length)
            ? ' <svg class="m-clip" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
            : '';
          var li = mEl(
            '<li class="m-list-row' + (unread ? ' unread' : '') + '">' +
            '<div><b>' + mEsc(m.other_name || m.other_username || '—') + '</b>' +
            '<span>' + mEsc(m.subject || '(no subject)') + ' · ' + mEsc((m.body || '').slice(0, 48)) + clip + '</span></div>' +
            '<div class="m-list-qty">' + mEsc((m.created_at || '').slice(5, 10)) + '</div></li>'
          );
          li.onclick = function () { detail(view, m); };
          ul.appendChild(li);
        });
        host.innerHTML = '';
        host.appendChild(ul);
      })
      .catch(function (ex) { host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function detail(view, m) {
    MApp.setTitle('Message');
    if (box === 'inbox' && !m.read_at) API.post('/messages/' + m.id + '/read').catch(function () {});
    view.innerHTML = '';
    var msgEl = mEl(
      '<div class="m-msg">' +
      '<div class="m-msg-head"><b>' + mEsc(m.other_name || m.other_username) + '</b>' +
      '<span>' + mEsc((m.created_at || '').replace('T', ' ').slice(0, 16)) + '</span></div>' +
      '<div class="m-msg-subj">' + mEsc(m.subject || '(no subject)') + '</div>' +
      '<div class="m-msg-body">' + mEsc(m.body || '') + '</div>' +
      '<div class="m-msg-attachments"></div>' +
      '</div>'
    );
    view.appendChild(msgEl);
    var attHost = msgEl.querySelector('.m-msg-attachments');
    (m.attachments || []).forEach(function (a) {
      var isImage = (a.mime_type || '').indexOf('image/') === 0;
      var row = mEl('<div class="m-msg-attach"></div>');
      if (isImage) {
        row.appendChild(mEl('<img class="m-msg-attach-img" alt="' + mEsc(a.name) + '" />'));
        API.blobUrl(a.url).then(function (u) { row.querySelector('img').src = u; }).catch(function () {});
      }
      row.appendChild(mEl(
        '<div class="m-msg-attach-meta"><span>' + mEsc(a.name) + '</span>' +
        '<span class="m-muted">' + mFmtBytes(a.size_bytes) + '</span></div>'
      ));
      row.onclick = function () { API.download(a.url, a.name).catch(function (e) { mToast(e.message || 'Download failed', 'err'); }); };
      attHost.appendChild(row);
    });
    var acts = mEl('<div class="m-actions"></div>');
    if (box === 'inbox') {
      var reply = mEl('<button class="m-btn">Reply</button>');
      reply.onclick = function () {
        compose(view, m.other_id, m.other_name, (m.subject || '').indexOf('Re:') === 0 ? m.subject : 'Re: ' + (m.subject || ''));
      };
      acts.appendChild(reply);
    }
    var back = mEl('<button class="m-btn m-btn-secondary">Back</button>');
    back.onclick = function () { list(view); };
    acts.appendChild(back);
    view.appendChild(acts);
  }

  function compose(view, toId, toName, subject) {
    MApp.setTitle('New message');
    view.innerHTML = '';

    var compressImages = true;
    API.get('/templates/company')
      .then(function (c) {
        compressImages = c.compress_images !== false;
        var hint = f && f.querySelector('.m-hint');
        if (hint) hint.style.display = compressImages ? '' : 'none';
      })
      .catch(function () {});

    function prepFiles(fileList) {
      var arr = [];
      for (var i = 0; i < fileList.length; i++) arr.push(fileList[i]);
      if (!arr.length || !compressImages || !window.ImageCompress) return Promise.resolve(arr);
      return Promise.all(arr.map(function (f2) { return window.ImageCompress.maybeCompress(f2); }));
    }

    var f = mEl(
      '<form class="m-form">' +
      '<div class="m-picked"><b>To: ' + mEsc(toName || ('#' + toId)) + '</b></div>' +
      '<label class="m-field"><span class="m-label">Subject</span><input class="m-input" data-subj value="' + mEsc(subject || '') + '" maxlength="200" /></label>' +
      '<label class="m-field"><span class="m-label">Message</span><textarea class="m-input" data-body rows="5" maxlength="5000" required></textarea></label>' +
      '<label class="m-field"><span class="m-label">Attach files (max 10 MB each)</span><input type="file" data-files multiple />' +
      '<span class="m-hint">Large images are compressed before sending to save space.</span></label>' +
      '<div class="m-actions"><button class="m-btn" type="submit">Send</button>' +
      '<button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div>' +
      '</form>'
    );
    f.querySelector('[data-cancel]').onclick = function () { list(view); };
    f.onsubmit = function (e) {
      e.preventDefault();
      var body = f.querySelector('[data-body]').value.trim();
      if (!body) { mToast('Write a message', 'err'); return; }
      var files = f.querySelector('[data-files]').files;
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > 10 * 1024 * 1024) { mToast('"' + files[i].name + '" is over 10 MB', 'err'); return; }
      }
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      var subject = f.querySelector('[data-subj]').value.trim() || null;
      prepFiles(files)
        .then(function (outFiles) {
          if (outFiles.length) {
            var fd = new FormData();
            fd.append('recipient_id', toId);
            fd.append('subject', subject || '');
            fd.append('body', body);
            outFiles.forEach(function (f2) { fd.append('files', f2); });
            return API.upload('/messages', fd);
          }
          return API.post('/messages', { recipient_id: toId, subject: subject, body: body });
        })
        .then(function () { mToast('Sent'); list(view); })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
    view.appendChild(f);
  }

  window.mCompose = function (toId, toName, subject) {
    var view = document.getElementById('m-view');
    compose(view, toId, toName, subject || '');
  };

  MApp.route('inbox', function (view) { list(view); });
})();
