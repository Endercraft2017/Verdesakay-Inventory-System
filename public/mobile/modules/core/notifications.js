/* Notifications — V2 activity hub.
   This first adapter composes existing employee-scoped sources. It intentionally does
   not invent a durable notification ledger; a future server endpoint can replace the
   loader without changing the route or visual contract. */
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
  function render(view) {
    MApp.setTitle('Notifications');
    view.innerHTML = '<div class="m-hint">Loading updates…</div>';
    // Each source degrades on its own, but a failure is counted so an offline or failing
    // load never masquerades as "You're all caught up".
    var failed = 0, lastError = null;
    function soft(p, fallback) {
      return p.catch(function (ex) { failed++; lastError = ex; return fallback; });
    }
    Promise.all([
      soft(API.get('/me/requests'), []),
      soft(API.get('/me/payslips'), []),
      soft(API.get('/messages/unread-count'), { count: 0 }),
      soft(API.get('/announcements'), [])
    ]).then(function (all) {
      if (failed === 4) {
        view.innerHTML = '';
        var box = mEl('<div class="m-error">' + mEsc((lastError && lastError.offline)
          ? 'You’re offline — updates can’t be checked right now.'
          : (lastError && lastError.message) || 'Could not load updates') +
          ' <button type="button" class="m-btn m-btn-sm">Try again</button></div>');
        box.querySelector('button').onclick = function () { render(view); };
        view.appendChild(box);
        return;
      }
      var requests = all[0] || [];
      var payslips = all[1] || [];
      var unread = Number((all[2] && (all[2].count != null ? all[2].count : all[2].unread)) || 0);
      var announcements = all[3] || [];
      view.innerHTML = '';

      var intro = mEl(
        '<div class="m-card v2-notification-intro"><span class="v2-role-chip">Updates</span>' +
        '<h2>What needs your attention</h2><p>Requests, payroll, messages and official notices appear here.</p></div>'
      );
      view.appendChild(intro);

      var count = 0;
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
      if (!count && !failed) {
        view.appendChild(mEl('<div class="m-empty"><b>You’re all caught up</b><br><span>New work and employee updates will appear here.</span></div>'));
      }
    }).catch(function (ex) {
      view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Could not load notifications') + '</div>';
    });
  }

  MApp.route('notifications', render);
})();