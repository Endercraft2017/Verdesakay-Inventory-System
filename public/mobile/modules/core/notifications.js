/* Notifications — V2 activity hub.
   Leads with the person's stored notification history (GET /api/notifications, written by the
   server whenever it notifies them — parts issued, QA holds, release reports …): unread first
   in bold, tap = mark read (POST /notifications/:id/read) and open the record it names (its
   phone route; for one with only a desktop screen, it says where on the desktop). #/notifications
   ?id=<n> — where a push without a phone screen lands — opens that one notification on top.
   Below it, the existing employee-scoped sources: requests, payslips, messages, notices. */
(function () {
  function statusClass(s) {
    s = String(s || '').toLowerCase();
    if (s === 'approved' || s === 'finalized') return 'ok';
    if (s === 'rejected' || s === 'failed') return 'err';
    return '';
  }
  function openRow(title, detail, meta, route, params, cls) {
    var row = mEl(
      '<button type="button" class="m-list-row v2-notification-row ' + (cls || '') + '">' +
      '<div><b>' + mEsc(title) + '</b><span>' + mEsc(detail || '') + '</span></div>' +
      '<small>' + mEsc(meta || '') + '</small></button>'
    );
    row.onclick = function () { MApp.go(route, params); };
    return row;
  }
  function section(view, title) {
    var h = mEl('<div class="m-sectitle">' + mEsc(title) + '</div>');
    view.appendChild(h);
  }
  var DESK = { orders: 'Sales → Sales Orders', 'job-orders': 'Production → Job Orders', releasing: 'Inventory → Releasing',
    repairs: 'Production → Repairs', 'hr-employees': 'HR → Employees', inventory: 'Inventory' };
  function when(ts) {
    if (!ts) return '';
    var d = new Date(String(ts).replace(' ', 'T') + (String(ts).indexOf('Z') === -1 ? 'Z' : ''));
    return (d.toDateString() === new Date().toDateString() ? 'Today ' : d.toLocaleDateString() + ' ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function markRead(n) {
    if (n.read_at) return Promise.resolve();
    if (n.readPending) return n.readPending;
    n.readPending = API.post('/notifications/' + n.id + '/read', {}).then(function () { n.read_at = 'now'; }).finally(function () { n.readPending = null; });
    return n.readPending;
  }
  /** One stored notification: tap opens its record (or, desktop-only, the notification itself). */
  function ledgerRow(n, view) {
    var row = mEl(
      '<button type="button" class="m-list-row v2-notification-row' + (n.read_at ? '' : ' unread') + '" data-nid="' + n.id + '">' +
      '<div><b>' + mEsc(n.title) + '</b><span>' + mEsc(n.body || '') + '</span></div>' +
      '<small>' + mEsc(when(n.created_at)) + (n.read_at ? '' : ' · new') + '</small></button>'
    );
    row.onclick = function () {
      if (row.disabled) return;
      row.disabled = true;
      markRead(n).then(function () {
        if (!row.isConnected) return;
        var phone = n.url && n.url.indexOf('#/notifications') !== 0;
        if (phone) MApp.go('work',{notice:n.url});
        else MApp.go('notifications', { id: n.id, t: Date.now() });
      }).catch(function () {
        if (!row.isConnected) return;
        row.disabled = false;
        var error = mEl('<div class="m-error" role="alert">Could not save read status. Retry or <button type="button" class="m-btn m-btn-sm">open without marking read</button>.</div>');
        var previous = view.querySelector('[data-read-error]'); if (previous) previous.remove();
        error.dataset.readError = '';
        error.querySelector('button').onclick = function () {
          if (n.url && n.url.indexOf('#/notifications') !== 0) MApp.go('work',{notice:n.url});
          else MApp.go('notifications', { id: n.id });
        };
        if (row.isConnected) row.after(error);
      });
    };
    return row;
  }
  function focusCard(n) {
    var desk = n.link && (DESK[n.link.route] || n.link.route);
    var phone = n.url && n.url.indexOf('#/notifications') !== 0;
    var card = mEl(
      '<div class="m-card v2-notification-focus"><span class="v2-role-chip">' + mEsc(when(n.created_at)) + '</span>' +
      '<h2>' + mEsc(n.title) + '</h2><p>' + mEsc(n.body || '') + '</p>' +
      (desk ? '<p class="m-hint">Open it on the desktop: <b>' + mEsc(desk) + '</b>' + (n.link.params && n.link.params.id ? ' (#' + mEsc(String(n.link.params.id)) + ')' : '') + '.</p>' : '') +
      (phone ? '<button type="button" class="m-btn" data-open>Open</button>' : '') + '</div>'
    );
    var b = card.querySelector('[data-open]');
    if (b) b.onclick = function () { MApp.go('work',{notice:n.url}); };
    return card;
  }
  function render(view, params) {
    params = params || {};
    MApp.setTitle('Notifications');
    var marker = mEl('<div class="m-hint">Loading updates…</div>');
    view.replaceChildren(marker);
    function active() { return view.isConnected && view.__notificationRender === marker && (marker.isConnected || view.dataset.route === 'notifications'); }
    view.__notificationRender = marker;
    // Each source degrades on its own, but a failure is counted so an offline or failing
    // load never masquerades as "You're all caught up".
    var failed = 0, lastError = null;
    function soft(p, fallback) {
      return p.catch(function (ex) { failed++; lastError = ex; return fallback; });
    }
    Promise.all([
      soft(API.get('/notifications'), { items: [], unread: 0 }),
      soft(API.get('/me/requests'), []),
      soft(API.get('/me/payslips'), []),
      soft(API.get('/messages/unread-count'), { count: 0 }),
      soft(API.get('/announcements'), []),
      params.id ? soft(API.get('/notifications/' + encodeURIComponent(params.id)), null) : Promise.resolve(null)
    ]).then(function (all) {
      if (!active()) return;
      if (failed === (params.id ? 6 : 5)) {
        view.innerHTML = '';
        var box = mEl('<div class="m-error">' + mEsc((lastError && lastError.offline)
          ? 'You’re offline — updates can’t be checked right now.'
          : (lastError && lastError.message) || 'Could not load updates') +
          ' <button type="button" class="m-btn m-btn-sm">Try again</button></div>');
        box.querySelector('button').onclick = function () { render(view, params); };
        view.appendChild(box);
        return;
      }
      var ledger = (all[0] && all[0].items) || [];
      var all4 = all.slice(1);
      var requests = all4[0] || [];
      var payslips = all4[1] || [];
      var unread = Number((all4[2] && (all4[2].count != null ? all4[2].count : all4[2].unread)) || 0);
      var announcements = all4[3] || [];
      view.innerHTML = '';
      var focused = params.id ? all[5] && String(all[5].id) === String(params.id) ? all[5] : ledger.filter(function (n) { return String(n.id) === String(params.id); })[0] : null;
      if (params.id) {
        var back = mEl('<button type="button" class="m-btn m-btn-sm m-btn-secondary">Back to notifications</button>');
        back.onclick = function () { MApp.go('notifications'); }; view.appendChild(back);
        if (!focused) view.appendChild(mEl('<div class="m-error" role="alert">' + (failed ? 'This notification could not be loaded. Retry missing updates below.' : 'This notification is unavailable or no longer accessible.') + '</div>'));
      }
      if (focused) {
        var card = focusCard(focused); view.appendChild(card);
        markRead(focused).catch(function () { if (card.isConnected) card.appendChild(mEl('<p class="m-error" role="alert">Could not save read status. This notification remains unread. Reopen it to retry.</p>')); });
      }

      var intro = mEl(
        '<div class="m-card v2-notification-intro"><span class="v2-role-chip">Updates</span>' +
        '<h2>What needs your attention</h2><p>Requests, payroll, messages and official notices appear here.</p></div>'
      );
      view.appendChild(intro);

      var count = 0;
      if (ledger.length) {
        var head = mEl('<div class="m-sectitle" style="display:flex;align-items:center;gap:8px">Recent' +
          (ledger.some(function (n) { return !n.read_at; }) ? '<button type="button" class="m-btn m-btn-sm" data-readall style="margin-left:auto">Mark all read</button>' : '') + '</div>');
        view.appendChild(head);
        var ra = head.querySelector('[data-readall]');
        if (ra) ra.onclick = function () { if (ra.disabled) return; ra.disabled = true; API.post('/notifications/read-all', {}).then(function () { if (active()) render(view, params); }).catch(function () { ra.disabled = false; if (head.isConnected) { var error = head.querySelector('[role=alert]'); if (!error) { error = mEl('<span role="alert"></span>'); head.appendChild(error); } error.textContent = 'Could not mark all read. Reconnect and retry.'; } }); };
        ledger.slice(0, 30).forEach(function (n) { count++; view.appendChild(ledgerRow(n, view)); });
      }
      var recentRequests = requests.filter(function (r) {
        return ['approved', 'rejected', 'pending'].indexOf(String(r.status || '').toLowerCase()) !== -1;
      }).slice(0, 5);
      if (recentRequests.length) {
        section(view, 'Requests');
        recentRequests.forEach(function (r) {
          count++;
          view.appendChild(openRow(
            r.form_name || r.type || 'Employee request',
            r.number || 'Open request details',
            r.status || 'Pending',
            'requests', { id: r.id }, statusClass(r.status)
          ));
        });
      }

      // Only payslips the server marks finalized (HR marked them Paid) — never inferred from status text.
      var released = payslips.filter(function (r) { return r.finalized === true; }).slice(0, 3);
      if (released.length) {
        section(view, 'Pay & documents');
        released.forEach(function (r) {
          count++;
          view.appendChild(openRow(
            'Payslip available',
            r.period || (r.data && r.data.payroll_period) || r.number || 'Payroll record',
            'Finalized',
            'payslips', null, 'ok'
          ));
        });
      }

      if (unread) {
        section(view, 'Messages');
        count++;
        view.appendChild(openRow(
          unread === 1 ? '1 unread message' : unread + ' unread messages',
          'Open your inbox to read and reply.',
          'Inbox',
          'inbox'
        ));
      }

      if (announcements.length) {
        section(view, 'Official notices');
        announcements.slice(0, 4).forEach(function (a) {
          count++;
          view.appendChild(openRow(
            a.title || 'Announcement',
            a.body || a.summary || 'Open official notice',
            (a.created_at || a.published_at || '').slice(0, 10),
            'announcements'
          ));
        });
      }

      if (failed) {
        view.appendChild(mEl('<div class="m-hint">Some updates couldn’t be loaded' + ((lastError && lastError.offline) ? ' while offline' : '') + ' — this list may be incomplete.</div>'));
      }
      if (failed) { var retry = mEl('<button type="button" class="m-btn m-btn-sm m-btn-secondary">Retry missing updates</button>'); retry.onclick = function () { render(view, params); }; view.appendChild(retry); }
      if (!count && !failed) {
        view.appendChild(mEl('<div class="m-empty"><b>You’re all caught up</b><br><span>New work and employee updates will appear here.</span></div>'));
      }
    }).catch(function (ex) {
      if (!active()) return;
      view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Could not load notifications') + '</div>';
    });
  }

  MApp.route('notifications', render);
})();
