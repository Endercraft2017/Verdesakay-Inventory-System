/* To Approve — a swipeable review deck. Swipe left/right to move between pending
   items; Reject / Note / Approve to decide. A decision is held for a few seconds
   with an Undo toast before it's sent. */
(function () {
  function titleCase(k) {
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  function relDays(s) {
    if (!s) return '';
    var d = Math.round((Date.now() - new Date(s.slice(0, 10) + 'T00:00:00').getTime()) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }

  var state = { items: [], idx: 0, pending: null, view: null };

  MApp.route('approvals', function (view) {
    flushPending();
    state.view = view;
    MApp.setTitle('Approvals');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/approvals')
      .then(function (res) {
        var items = [];
        (res.requests || []).forEach(function (r) {
          var d = r.data || {};
          items.push({
            kind: 'req', id: r.id, path: '/me/approvals/requests/' + r.id + '/decide',
            type: r.form_name, number: r.number,
            who: r.employee_name || r.filed_by || 'Someone', role: '',
            created_at: r.created_at,
            // An information change is shown as a before/after so HR sees exactly what approving
            // writes to the employee record (the server applies it on approval).
            data: r.slug === 'information_change'
              ? { Change: d.field, 'On record now': d.current_value || '—', 'Correct value': d.requested_value, Reason: d.reason }
              : d,
          });
        });
        (res.time_corrections || []).forEach(function (r) {
          items.push({
            kind: 'tc', id: r.id, path: '/me/approvals/time-corrections/' + r.id + '/decide',
            type: 'Time fix', number: '',
            who: r.employee_name, role: '',
            created_at: r.created_at,
            data: { 'Work date': r.work_date, 'Time in': r.requested_in || '', 'Time out': r.requested_out || '', Reason: r.reason },
          });
        });
        state.items = items;
        state.idx = 0;
        draw();
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  });

  function draw() {
    var view = state.view;
    view.innerHTML = '';
    if (!state.items.length) {
      view.appendChild(mEl('<div class="m-stack-empty">Nothing waiting on you. 🎉</div>'));
      return;
    }
    if (state.idx >= state.items.length) state.idx = state.items.length - 1;
    if (state.idx < 0) state.idx = 0;
    var it = state.items[state.idx];
    var d = it.data || {};

    var kv = Object.keys(d)
      .filter(function (k) { return d[k] != null && String(d[k]).trim() !== '' && /^decid/.test(k) === false; })
      .map(function (k) { return '<div><span class="k">' + mEsc(titleCase(k)) + '</span><span>' + mEsc(String(d[k])) + '</span></div>'; })
      .join('');
    var fileKey = Object.keys(d).find(function (k) { return /file|attach|document|itinerary/i.test(k) && typeof d[k] === 'string'; });

    var card = mEl(
      '<div class="m-appr-card">' +
      '<div class="m-appr-top"><span class="m-appr-type">' + mEsc(it.type) + '</span>' +
      '<span class="m-appr-count">' + state.items.length + ' remaining</span></div>' +
      '<div class="m-appr-who"><span class="m-appr-av">' + mEsc(initials(it.who)) + '</span>' +
      '<span><b>' + mEsc(it.who) + '</b><span>' + mEsc(it.role || (it.kind === 'tc' ? 'Attendance correction' : 'Request')) + '</span></span>' +
      (it.number ? '<span class="m-appr-tag">' + mEsc(it.number) + '</span>' : '') + '</div>' +
      (kv ? '<div class="m-appr-kv">' + kv + '</div>' : '') +
      (fileKey ? '<div class="m-appr-file">📎 ' + mEsc(String(d[fileKey])) + '</div>' : '') +
      '<div class="m-appr-tl">' +
      '<div class="done">Filed ' + mEsc(relDays(it.created_at)) + '</div>' +
      '<div class="now">Pending your approval</div>' +
      '</div>' +
      '<label class="m-field m-appr-notewrap hidden"><span class="m-label">Note</span><input class="m-input" data-note maxlength="1000" /></label>' +
      '<div class="m-appr-acts">' +
      '<button class="rej">✕ Reject</button>' +
      '<button class="note">✎ Note</button>' +
      '<button class="ok">✓ Approve</button>' +
      '</div></div>'
    );

    // swipe left / right to navigate
    wireSwipe(card);

    card.querySelector('.note').onclick = function () {
      card.querySelector('.m-appr-notewrap').classList.toggle('hidden');
      var i = card.querySelector('[data-note]'); if (i) i.focus();
    };
    card.querySelector('.rej').onclick = function () { decide('rejected', card); };
    card.querySelector('.ok').onclick = function () { decide('approved', card); };

    var nav = mEl('<div class="m-appr-nav"><button class="m-icbtn" data-prev>‹</button>' +
      (state.idx + 1) + ' of ' + state.items.length +
      '<button class="m-icbtn" data-next>›</button></div>');
    nav.querySelector('[data-prev]').onclick = function () { move(-1); };
    nav.querySelector('[data-next]').onclick = function () { move(1); };

    var wrap = mEl('<div class="m-appr-wrap"></div>');
    wrap.appendChild(card);
    wrap.appendChild(nav);
    view.appendChild(wrap);
  }

  function move(dir) {
    state.idx += dir;
    if (state.idx < 0) state.idx = 0;
    if (state.idx > state.items.length - 1) state.idx = state.items.length - 1;
    draw();
  }

  function wireSwipe(card) {
    var x0 = null, dx = 0;
    card.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; dx = 0; card.classList.remove('swipe'); }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (x0 == null) return;
      dx = e.touches[0].clientX - x0;
      card.style.transform = 'translateX(' + (dx * 0.5) + 'px) rotate(' + (dx * 0.01) + 'deg)';
    }, { passive: true });
    card.addEventListener('touchend', function () {
      card.classList.add('swipe');
      if (dx < -70) { card.style.transform = 'translateX(-120%)'; setTimeout(function () { move(1); }, 160); }
      else if (dx > 70) { card.style.transform = 'translateX(120%)'; setTimeout(function () { move(-1); }, 160); }
      else { card.style.transform = ''; }
      x0 = null;
    });
  }

  /* ---- deferred decision + undo ---- */
  function decide(decision, card) {
    flushPending();
    var it = state.items[state.idx];
    if (!it) return;
    var note = card.querySelector('[data-note]') ? card.querySelector('[data-note]').value.trim() : '';
    var at = state.idx;
    state.items.splice(at, 1);              // remove optimistically
    state.pending = { it: it, decision: decision, note: note, at: at, timer: null };
    if (state.idx > state.items.length - 1) state.idx = Math.max(0, state.items.length - 1);
    draw();
    showUndo(decision);
    state.pending.timer = setTimeout(flushPending, 4200);
    window.addEventListener('hashchange', flushOnLeave);
  }

  function flushOnLeave() { flushPending(); }

  function flushPending() {
    var p = state.pending;
    if (!p) return;
    state.pending = null;
    clearTimeout(p.timer);
    window.removeEventListener('hashchange', flushOnLeave);
    hideUndo();
    API.post(p.it.path, { decision: p.decision, note: p.note || null })
      .then(function (res) {
        mToast(res && res.applied_note ? 'Approved — ' + res.applied_note
          : res && res.applied ? 'Approved — employee record updated'
          : p.decision === 'approved' ? 'Approved' : 'Rejected');
        MApp.refreshInboxBadge && MApp.refreshInboxBadge();
      })
      .catch(function (ex) {
        mToast(ex.message || 'Could not save — restored', 'err');
        state.items.splice(Math.min(p.at, state.items.length), 0, p.it);
        if (location.hash.indexOf('approvals') !== -1) draw();
      });
  }

  function showUndo(decision) {
    hideUndo();
    var bar = mEl('<div class="m-undo" id="m-appr-undo">' +
      '<span class="ok-ic">✓</span>' + (decision === 'approved' ? 'Approved.' : 'Rejected.') +
      ' You can undo this action. <button>Undo</button></div>');
    bar.querySelector('button').onclick = undo;
    document.body.appendChild(bar);
  }
  function hideUndo() { var e = document.getElementById('m-appr-undo'); if (e) e.remove(); }

  function undo() {
    var p = state.pending;
    if (!p) return;
    clearTimeout(p.timer);
    state.pending = null;
    window.removeEventListener('hashchange', flushOnLeave);
    hideUndo();
    state.items.splice(Math.min(p.at, state.items.length), 0, p.it);
    state.idx = p.at;
    draw();
  }
})();
