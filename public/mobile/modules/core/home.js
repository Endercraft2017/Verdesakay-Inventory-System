/* Home / Today — Figma node 46:519.
   Employee-first overview: attendance, four universal shortcuts, and one highest-value update. */
(function () {
  function dayLabel() {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date());
  }
  function shiftText(c) {
    if (!c || !c.shift) return 'No shift assigned';
    return String(c.shift.start_time || '—') + ' – ' + String(c.shift.end_time || '—');
  }
  function placeText(t) {
    var me = MApp.getMe() || {};
    var bits = [];
    if (me.department_name) bits.push(me.department_name);
    if (t.clock && t.clock.location_name) bits.push(t.clock.location_name);
    return bits.length ? bits.join(' · ') : 'Main workplace';
  }
  function shortcut(title, detail, route, tone) {
    var b = mEl(
      '<button type="button" class="v2-home-shortcut ' + (tone || '') + '">' +
      '<b>' + mEsc(title) + '</b><span>' + mEsc(detail) + '</span></button>'
    );
    b.onclick = function () { MApp.go(route); };
    return b;
  }
  function updateRow(t) {
    var stack = t.stack || [];
    var item = stack[0];
    if (item) {
      var row = mEl(
        '<button type="button" class="v2-home-update ' + mEsc(item.urgency || '') + '">' +
        '<span><b>' + mEsc(item.title || 'Update') + '</b>' +
        '<small>' + mEsc(item.subtitle || 'Open for details') + '</small></span>' +
        '<span class="v2-update-meta">' + mEsc(item.urgency || '') + '</span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
      );
      row.onclick = function () { MApp.go(item.route || 'notifications', item.params); };
      return row;
    }
    if (t.announcement) {
      var a = t.announcement;
      var ann = mEl(
        '<button type="button" class="v2-home-update">' +
        '<span><b>' + mEsc(a.title || 'Official announcement') + '</b>' +
        '<small>' + mEsc((a.body || '').slice(0, 74)) + ((a.body || '').length > 74 ? '…' : '') + '</small></span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
      );
      ann.onclick = function () { MApp.go('announcements'); };
      return ann;
    }
    var empty = mEl(
      '<button type="button" class="v2-home-update">' +
      '<span><b>No employee updates</b><small>No urgent employee updates right now.</small></span>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    empty.onclick = function () { MApp.go('notifications'); };
    return empty;
  }
  function render(view, t, preview) {
    view.innerHTML = '';
    var greeting = t.greeting || {};
    var employee = MApp.getMe() || {};
    var name = greeting.name || employee.nickname || employee.full_name || '';
    var part = greeting.part_of_day || 'day';

    var page = mEl('<section class="v2-home" data-figma-node="46:519"></section>');
    page.appendChild(mEl(
      '<header class="v2-home-heading"><h1>Good ' + mEsc(part) + (name ? ', ' + mEsc(name) : '') +
      '</h1><p>' + mEsc(dayLabel()) + (employee.department_name ? ' · ' + mEsc(employee.department_name) : '') + '</p></header>'
    ));

    if(t.todayLoading||t.todayUnavailable){page.appendChild(mEl('<section class="v2-attendance-hero"><div class="v2-attendance-label">TODAY’S ATTENDANCE</div><strong>'+(t.todayLoading?'Checking attendance…':'Attendance unavailable')+'</strong><p>Work queues are checked separately below.</p></section>'));}
    else if (t.clock && t.clock.linked) {
      var c = t.clock;
      var clock = mEl(
        '<section class="v2-attendance-hero ' + (c.clocked_in ? 'is-in' : '') + '">' +
        '<span class="v2-attendance-orb" aria-hidden="true"></span>' +
        '<div class="v2-attendance-label">TODAY’S ATTENDANCE</div>' +
        '<strong>' + mEsc(shiftText(c)) + '</strong>' +
        '<p>' + mEsc(placeText(t)) + '</p>' +
        '<button type="button">' + (c.clocked_in ? 'Open clock' : 'Clock in') + '</button>' +
        (c.clocked_in ? '<small>Clocked in' + (c.hours_today != null ? ' · ' + mEsc(c.hours_today) + ' h today' : '') + '</small>' : '') +
        '</section>'
      );
      clock.querySelector('button').onclick = function () { MApp.go('clock'); };
      page.appendChild(clock);
    } else {
      var unlinked = mEl(
        '<section class="v2-attendance-hero is-unlinked"><div class="v2-attendance-label">TODAY’S ATTENDANCE</div>' +
        '<strong>Employee record needed</strong><p>Ask HR to link your account before using the mobile clock.</p></section>'
      );
      page.appendChild(unlinked);
    }

    if(preview)page.appendChild(preview);else if(window.mHomeWorkPreview)mHomeWorkPreview(page);
    page.appendChild(mEl('<h2 class="v2-home-section-title">Quick access</h2>'));
    var grid = mEl('<div class="v2-home-grid"></div>');
    grid.appendChild(shortcut('New request', 'Leave, overtime, offset', 'requests'));
    grid.appendChild(shortcut('Payslips', 'Finalized payroll records', 'payslips'));
    grid.appendChild(shortcut('Report issue', 'HR, safety or operations', 'report-problem', 'warn'));
    grid.appendChild(shortcut('Schedule', 'Shifts and changes', 'schedule'));
    page.appendChild(grid);
    if(t.todayUnavailable){var failed=mEl('<div class="m-error" role="status">Employee updates unavailable. <button type="button" class="rk-back">Retry</button></div>');failed.querySelector('button').onclick=function(){MApp.render();};page.appendChild(failed);}else if(!t.todayLoading)page.appendChild(updateRow(t));

    if (MApp.canApprove()) {
      var approvals = mEl('<button type="button" class="v2-home-secondary">Review pending approvals</button>');
      approvals.onclick = function () { MApp.go('approvals'); };
      page.appendChild(approvals);
    }
    if (MApp.hasProductionAccess() || MApp.can('orders.release') && MApp.canOpen('so')) {
      var role = mEl('<button type="button" class="v2-home-secondary">Open my role work queue</button>');
      role.onclick = function () { MApp.go('work'); };
      page.appendChild(role);
    }
    view.appendChild(page);
    return page;
  }

  var homeRender=0;
  MApp.route('home', function (view) {
    var generation=++homeRender,hash=location.hash,owner=MApp.getMe().id;
    function current(){return generation===homeRender&&hash===location.hash&&MApp.getMe()&&MApp.getMe().id===owner;}
    MApp.setTitle('Today');
    var shell=render(view,{todayLoading:true});
    function preview(){return shell.querySelector('.v2-home-work');}
    API.get('/me/today')
      .then(function (t) { if(current())render(view, t || {},preview()); })
      .catch(function (ex) {
        if(!current())return;
        render(view,{todayUnavailable:true},preview());
      });
  });
})();