/* Announcements — everyone reads; `announce` holders can post / remove. */
(function () {
  function canPost() { return MApp.can('announce'); }
  function all() { MApp.go('announcements'); }

  // Reuse the app's modal focus/Escape behavior for both destructive actions and drafts.
  function confirmAction(owner, options) {
    var pending = false;
    var root = mEl('<div class="m-task-confirm-backdrop m-ann-confirm-backdrop" aria-label="' + mEsc(options.heading) + '"><section class="m-task-confirm m-ann-confirm">' +
      '<h2>' + mEsc(options.heading) + '</h2><blockquote>' + mEsc(options.title) + '</blockquote><p>' + mEsc(options.message) + '</p>' +
      '<p class="m-error" data-confirm-error role="alert" tabindex="-1"></p><div class="m-actions"><button class="m-btn m-btn-secondary" type="button" data-keep>' + mEsc(options.keep) + '</button>' +
      '<button class="m-btn m-btn-danger" type="button" data-confirm>' + mEsc(options.accept) + '</button></div></section></div>');
    owner.inert = true; document.body.appendChild(root);
    var control = MessageOverlay.mount(root, { initialFocus: '[data-keep]', canClose: function () { return !pending; }, onClose: function () { owner.inert = false; options.onClose(); } });
    var keep = root.querySelector('[data-keep]'), accept = root.querySelector('[data-confirm]'), error = root.querySelector('[data-confirm-error]');
    keep.onclick = control.close;
    accept.onclick = async function () {
      if (pending) return;
      if (!options.perform) { control.close(); options.onAccept(); return; }
      pending = true; options.onBusy(true); keep.disabled = true; accept.disabled = true; accept.textContent = 'Deleting…'; error.textContent = ''; root.setAttribute('aria-busy', 'true');
      try { await options.perform(); pending = false; options.onBusy(false); control.close(); options.onAccept(); }
      catch (failure) { if (!owner.isConnected) { pending = false; control.close(); } else if (root.isConnected) { error.textContent = 'Could not delete this announcement. ' + (failure.message || 'Check your connection and try again.'); error.focus(); } }
      finally { pending = false; options.onBusy(false); keep.disabled = false; accept.disabled = false; accept.textContent = options.accept; root.removeAttribute('aria-busy'); }
    };
    return control;
  }

  function list(view, params) {
    MApp.setTitle('Announcements');
    view.innerHTML = (canPost() ? '<div class="m-actions"><button type="button" class="m-btn" id="m-ann-new">＋ New announcement</button></div>' : '') + '<div id="m-ann-list" aria-live="polite"></div>';
    var add = view.querySelector('#m-ann-new'); if (add) add.onclick = function () { MApp.go('announcements', { new: 1 }); };
    var host = view.querySelector('#m-ann-list'), loading = false;
    async function load() {
      if (loading || !host.isConnected) return;
      var restoreFocus = host.contains(document.activeElement);
      loading = true; host.innerHTML = '<div class="m-hint" role="status">Loading announcements…</div>'; host.setAttribute('aria-busy', 'true');
      try {
        var rows = await API.get('/announcements'); if (!host.isConnected) return;
        if (params && params.id) {
          var selected = rows.find(function (row) { return String(row.id) === String(params.id); });
          if (selected) { detail(view, selected); return; }
          host.innerHTML = '<div class="m-error" role="alert">This announcement is no longer available. It may have expired or been removed.</div><button class="m-btn m-btn-secondary" type="button" data-back>Back to announcements</button>';
          host.querySelector('[data-back]').onclick = all; return;
        }
        if (!rows.length) { host.innerHTML = '<div class="m-empty">No announcements right now.</div>'; return; }
        var ul = mEl('<ul class="m-list m-ann-list"></ul>');
        rows.forEach(function (row) {
          var li = mEl('<li><button class="m-list-row m-ann-row" type="button" data-ann-id="' + mEsc(row.id) + '"><div><b>' + (row.pinned ? 'Pinned · ' : '') + mEsc(row.title) + '</b>' +
            '<span>' + mEsc(row.created_by_name || 'Unknown author') + ' · ' + mEsc(PersonalUX.format(row.created_at)) + '</span></div><span class="m-list-qty" aria-hidden="true">›</span></button></li>');
          li.querySelector('button').onclick = function () { MApp.go('announcements', { id: row.id }); }; ul.appendChild(li);
        });
        host.replaceChildren(ul);
      } catch (failure) {
        if (host.isConnected) { host.innerHTML = '<div class="m-error" role="alert">' + mEsc(failure.message || 'Could not load announcements.') + '</div><button class="m-btn" type="button" data-retry>Retry</button>'; host.querySelector('[data-retry]').onclick = load; }
      } finally { loading = false; host.removeAttribute('aria-busy'); if (restoreFocus && host.isConnected) { host.tabIndex = -1; (host.querySelector('button') || host).focus(); } }
    }
    load();
  }

  function detail(view, row) {
    MApp.setTitle(row.title);
    var busy = false, confirmation = null;
    var article = mEl('<article class="m-ann-detail">' + (row.pinned ? '<p class="m-hint">📌 Pinned</p>' : '') + '<h1>' + mEsc(row.title) + '</h1>' +
      '<p class="m-hint">Posted by ' + mEsc(row.created_by_name || 'Unknown author') + ' · ' + mEsc(PersonalUX.format(row.created_at)) + '</p>' +
      (row.expires_at ? '<p class="m-hint">Visible until ' + mEsc(PersonalUX.format(row.expires_at)) + '</p>' : '') + '<div class="m-ann-body"></div>' +
      '<div class="m-actions"><button class="m-btn m-btn-secondary" type="button" data-back>Back to announcements</button>' + (canPost() ? '<button class="m-btn m-btn-warn" type="button" data-del>Delete announcement</button>' : '') + '</div></article>');
    article.querySelector('.m-ann-body').textContent = row.body; view.replaceChildren(article);
    article.querySelector('[data-back]').onclick = all;
    mPersonalDraft.arm(function () { return !!confirmation; }, function () { return busy; }, {
      busyText: function () { return 'Please wait for deletion to finish.'; },
      confirmLeave: function () { confirmation?.focus(); }
    });
    var del = article.querySelector('[data-del]'); if (del) del.onclick = function () {
      if (busy || confirmation) { confirmation?.focus(); return; }
      if (!canPost()) { mToast('You no longer have permission to delete announcements.', 'err'); return; }
      confirmation = confirmAction(article, {
        heading: 'Delete this announcement?', title: row.title, message: 'It will be removed from Announcements for everyone.', keep: 'Cancel', accept: 'Delete announcement',
        onClose: function () { confirmation = null; }, onBusy: function (value) { busy = value; },
        perform: function () { if (!canPost()) return Promise.reject(new Error('You no longer have permission to delete announcements.')); return API.del('/announcements/' + row.id); },
        onAccept: function () { if (article.isConnected) { mPersonalDraft.clear(); mToast('Announcement deleted'); all(); } }
      });
    };
  }

  function compose(view) {
    MApp.setTitle('New announcement');
    if (!canPost()) { view.innerHTML = '<div class="m-error" role="alert">You do not have permission to post announcements.</div><button class="m-btn m-btn-secondary" type="button" data-back>Back to announcements</button>'; view.querySelector('[data-back]').onclick = all; return; }
    var busy = false, confirmation = null, proceedLeave = null;
    var form = mEl('<form class="m-form m-ann-editor" novalidate>' +
      '<label class="m-field"><span class="m-label">Title *</span><input class="m-input" data-k="title" maxlength="160" required /></label>' +
      '<label class="m-field"><span class="m-label">Message *</span><textarea class="m-input" data-k="body" rows="5" maxlength="5000" required></textarea></label>' +
      '<label class="m-field"><span class="m-label">Hide after (optional)</span><input class="m-input" type="date" data-k="expires" /></label><p class="m-hint">Leave blank to keep the announcement visible.</p>' +
      '<label class="m-field m-check"><input type="checkbox" data-k="pinned" /><span>Pin to top</span></label>' +
      '<label class="m-field m-check"><input type="checkbox" data-k="notify" /><span>Also send a notification to everyone</span></label>' +
      '<p class="m-error" data-post-error role="alert" tabindex="-1" hidden></p><div class="m-ann-post-actions"><span class="personal-save-status" data-post-status aria-live="polite"></span><div class="m-actions">' +
      '<button class="m-btn" type="submit">Post</button><button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button></div></div></form>');
    view.replaceChildren(form);
    var title = form.querySelector('[data-k="title"]'), body = form.querySelector('[data-k="body"]'), expires = form.querySelector('[data-k="expires"]');
    var submit = form.querySelector('[type="submit"]'), feedback = form.querySelector('[data-post-error]'); expires.min = mPersonalTime.today();
    function snapshot() { return JSON.stringify(Array.prototype.map.call(form.querySelectorAll('input,textarea'), function (field) { return field.type === 'checkbox' ? field.checked : field.value; })); }
    var initial = snapshot(), status = PersonalUX.status(form, form.querySelector('[data-post-status]'), function () { return snapshot() !== initial; }, false);
    form.querySelector('[data-post-status]').textContent = 'Not posted yet';
    function fail(message, field) { status.failed('Not posted'); feedback.textContent = message; feedback.hidden = false; if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } else feedback.focus(); }
    form.addEventListener('input', function (event) { event.target.removeAttribute('aria-invalid'); });
    mPersonalDraft.arm(function () { return !!confirmation || snapshot() !== initial; }, function () { return busy; }, {
      busyText: function () { return 'Please wait for posting to finish.'; },
      confirmLeave: function (proceed) {
        proceedLeave = proceed;
        if (confirmation) { confirmation.focus(); return; }
        confirmation = confirmAction(form, { heading: 'Discard announcement draft?', title: title.value.trim() || 'New announcement', message: 'Your title, message and posting options haven’t been saved or posted. Keep editing to finish your announcement.', keep: 'Keep editing', accept: 'Discard draft', onClose: function () { confirmation = null; }, onAccept: function () { proceedLeave(); } });
      }
    });
    form.querySelector('[data-cancel]').onclick = all;
    form.onsubmit = async function (event) {
      event.preventDefault(); if (busy || confirmation) return;
      feedback.hidden = true;
      if (!canPost()) { fail('You no longer have permission to post announcements. Your draft is still here.'); return; }
      if (!title.value.trim()) { fail('Enter an announcement title.', title); return; }
      if (!body.value.trim()) { fail('Enter an announcement message.', body); return; }
      expires.min = mPersonalTime.today();
      if (expires.value && expires.value < expires.min) { fail('The hide-after date has passed. Choose today or later, or leave it blank.', expires); return; }
      var invalid = [title, body, expires].find(function (field) { return !field.checkValidity(); });
      if (invalid) { fail(invalid.validationMessage, invalid); return; }
      var data = { title: title.value.trim(), body: body.value.trim(), pinned: form.querySelector('[data-k="pinned"]').checked, notify: form.querySelector('[data-k="notify"]').checked, expires_at: expires.value ? expires.value + ' 23:59' : null };
      busy = true; form.inert = true; submit.disabled = true; submit.textContent = 'Posting…'; status.saving(); form.querySelector('[data-post-status]').textContent = 'Posting…'; form.setAttribute('aria-busy', 'true');
      try { await API.post('/announcements', data); if (form.isConnected) { mPersonalDraft.clear(); mToast('Announcement posted'); all(); } }
      catch (failure) { if (form.isConnected) { form.inert = false; fail((failure.message || 'Could not post this announcement.') + ' Your draft is still here. If the connection was lost, check Announcements before retrying in case it was posted.'); } }
      finally { busy = false; form.inert = false; submit.disabled = false; submit.textContent = 'Post'; form.removeAttribute('aria-busy'); }
    };
  }

  MApp.route('announcements', function (view, params) { if (params && params.new) compose(view); else list(view, params); });
})();
