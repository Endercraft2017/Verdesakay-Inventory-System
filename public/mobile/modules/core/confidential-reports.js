/* Confidential reports — case-handler view of the anonymous channel (reports.confidential).
   Separate from Inbox and Bug Reports on purpose: these cases have no reporter identity, and
   replies go back only through the reporter's number + access code (report-problem.js).
   #/confidential-reports → queue   ·   #/confidential-reports?id=<id> → case */
(function () {
  var STATUSES = ['new', 'triaged', 'investigating', 'resolved', 'closed'];

  function shell(view, heading, sub, back) {
    view.innerHTML = '<section class="m-v2-page m-report-v2"><header class="m-v2-heading m-report-heading">' +
      (back ? '<button class="m-report-back" type="button" aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(sub) + '</p></div></header><div id="m-cr-body"></div></section>';
    if (back) view.querySelector('.m-report-back').onclick = back;
    return view.querySelector('#m-cr-body');
  }

  function list(view, filter) {
    MApp.setTitle('Anonymous reports');
    var host = shell(view, 'Anonymous reports', 'No reporter identity is stored for these cases');
    var chips = mEl('<div class="m-cr-filter"></div>');
    ['open'].concat(STATUSES).forEach(function (s) {
      var b = mEl('<button type="button"' + ((filter || 'open') === s ? ' class="on"' : '') + '>' + mEsc(s) + '</button>');
      b.onclick = function () { list(view, s); };
      chips.appendChild(b);
    });
    host.appendChild(chips);
    var out = mEl('<div><div class="m-hint">Loading…</div></div>');
    host.appendChild(out);
    var status = filter && filter !== 'open' ? filter : '';
    API.get('/confidential-reports' + (status ? '?status=' + status : '')).then(function (rows) {
      if (!status) rows = rows.filter(function (r) { return r.status !== 'resolved' && r.status !== 'closed'; });
      if (!rows.length) { out.innerHTML = '<div class="m-empty">No ' + mEsc(filter && filter !== 'open' ? filter : 'open') + ' reports.</div>'; return; }
      out.innerHTML = '';
      rows.forEach(function (r) {
        var row = mEl('<button class="m-report-row" type="button"><span><b>' + mEsc(r.number) + ' · ' + mEsc(r.subject || r.category) + '</b>' +
          '<small>' + mEsc(r.category) + ' · ' + mEsc(r.status) + ' · updated ' + mEsc(r.updated_on) +
          (r.reporter_replies ? ' · ' + r.reporter_replies + ' reporter message' + (r.reporter_replies === 1 ? '' : 's') : '') +
          (r.photo_count ? ' · ' + r.photo_count + ' photo' + (r.photo_count === 1 ? '' : 's') : '') +
          '</small></span><i aria-hidden="true">›</i></button>');
        row.onclick = function () { MApp.go('confidential-reports', { id: r.id }); };
        out.appendChild(row);
      });
    }).catch(function (e) {
      out.innerHTML = '';
      var box = mEl('<div class="m-error">' + mEsc(e.offline ? 'You’re offline — reports can’t be loaded.' : e.message) + ' <button class="m-btn m-btn-sm" type="button">Try again</button></div>');
      box.querySelector('button').onclick = function () { list(view, filter); };
      out.appendChild(box);
    });
  }

  function detail(view, id) {
    MApp.setTitle('Anonymous report');
    var host = shell(view, 'Anonymous report', 'Reply through the reporter’s access code only', function () { MApp.go('confidential-reports'); });
    host.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/confidential-reports/' + id).then(function (r) { render(host, r); })
      .catch(function (e) { host.innerHTML = '<div class="m-error">' + mEsc(e.message) + '</div>'; });

    function render(host, r) {
      host.innerHTML =
        '<section class="m-report-review">' +
          '<div><span>' + mEsc(r.number) + '</span><b>' + mEsc(r.subject || r.category) + '</b></div>' +
          '<div><span>Category</span><b>' + mEsc(r.category) + '</b></div>' +
          '<div><span>Incident</span><b>' + mEsc([r.incident_date, r.location].filter(Boolean).join(' · ') || 'Not provided') + '</b></div>' +
          '<div><span>Filed · updated</span><b>' + mEsc(r.created_on) + ' · ' + mEsc(r.updated_on) + '</b></div>' +
        '</section>' +
        '<p class="m-cr-detail">' + mEsc(r.description) + '</p>' +
        (r.attachments && r.attachments.length ? '<div class="m-thumbs" data-cr-photos="report"></div>' : '') +
        '<form class="m-report-form" id="m-cr-status" novalidate><label><span>Status</span><select>' +
          STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select></label><button class="m-v2-secondary" type="submit">Update status</button></form>' +
        '<div class="m-anon-thread">' + (r.messages.length ? r.messages.map(function (m) {
          return '<div class="m-anon-msg ' + mEsc(m.author) + '"><small>' + (m.author === 'handler' ? mEsc(m.handler_name || 'Case handler') : 'Reporter') +
            ' · ' + mEsc(m.created_on) + '</small><p>' + mEsc(m.body) + '</p>' +
            (m.attachments && m.attachments.length ? '<div class="m-thumbs" data-cr-photos="' + m.id + '"></div>' : '') + '</div>';
        }).join('') : '<div class="m-empty">No messages yet. The reporter sees replies when they check with their access code.</div>') + '</div>' +
        '<form class="m-report-form" id="m-cr-reply" novalidate><label class="is-tall"><span>Reply to reporter</span><textarea rows="3" maxlength="3000" placeholder="The reporter sees this as “Case handler”"></textarea></label>' +
        '<button class="m-v2-primary" type="submit">Send reply</button></form>';
      // Photos (metadata already stripped server-side) — fetched with the handler's token.
      function fillPhotos(key, list) {
        var strip = host.querySelector('[data-cr-photos="' + key + '"]');
        if (!strip) return;
        list.forEach(function (a, i) {
          var cell = mEl('<button class="m-thumb" type="button" aria-label="Open photo ' + (i + 1) + '"><img alt="" /></button>');
          API.blobUrl(a.url).then(function (u) { cell.querySelector('img').src = u; }).catch(function () {});
          cell.onclick = function () { mPhoto.view(a.url); };
          strip.appendChild(cell);
        });
      }
      fillPhotos('report', r.attachments || []);
      r.messages.forEach(function (m) { fillPhotos(m.id, m.attachments || []); });
      var st = host.querySelector('#m-cr-status');
      st.onsubmit = function (event) {
        event.preventDefault();
        var b = st.querySelector('button'); b.disabled = true;
        API.post('/confidential-reports/' + r.id + '/status', { status: st.querySelector('select').value })
          .then(function () { mToast('Status updated'); detail(view, r.id); })
          .catch(function (e) { mToast(e.message, 'err'); b.disabled = false; });
      };
      var rp = host.querySelector('#m-cr-reply');
      rp.onsubmit = function (event) {
        event.preventDefault();
        var text = rp.querySelector('textarea').value.trim();
        if (!text) { mToast('Write a reply', 'err'); return; }
        var b = rp.querySelector('button'); b.disabled = true;
        API.post('/confidential-reports/' + r.id + '/reply', { body: text })
          .then(function (updated) { render(host, updated); mToast('Reply sent'); })
          .catch(function (e) { mToast(e.message, 'err'); b.disabled = false; });
      };
    }
  }

  MApp.route('confidential-reports', function (view, params) {
    if (!MApp.can('reports.confidential')) {
      view.innerHTML = '<div class="m-error">You don’t have access to anonymous reports.</div>';
      return;
    }
    if (params && params.id) detail(view, params.id);
    else list(view, params && params.status);
  });
})();
