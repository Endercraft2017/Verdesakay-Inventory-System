/* My schedule — this employee's roster days + shift times for the current/next cutoff. */
MApp.route('schedule', function (view) {
  MApp.setTitle('My Schedule');
  view.innerHTML = '<div class="m-hint">Loading…</div>';
  var today = new Date().toISOString().slice(0, 10);
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  API.get('/me/schedule')
    .then(function (s) {
      view.innerHTML = '';
      if (s.default_shift) {
        view.appendChild(mEl('<div class="m-clock-card"><div class="m-clock-state">Usual shift: <b>' +
          mEsc(s.default_shift.name) + '</b> ' + mEsc(s.default_shift.start_time) + '–' + mEsc(s.default_shift.end_time) + '</div></div>'));
      }
      if (!s.days || !s.days.length) {
        view.appendChild(mEl('<div class="m-empty">No schedule published for the current cutoff yet.</div>'));
        return;
      }
      var byPeriod = {};
      s.days.forEach(function (d) { (byPeriod[d.period_label] = byPeriod[d.period_label] || []).push(d); });
      Object.keys(byPeriod).forEach(function (label) {
        view.appendChild(mEl('<h3 class="m-sec">' + mEsc(label) + '</h3>'));
        var ul = mEl('<ul class="m-list"></ul>');
        byPeriod[label].forEach(function (d) {
          var dt = new Date(d.work_date + 'T00:00');
          var isToday = d.work_date === today;
          var shift = d.shift_name
            ? d.shift_name + ' · ' + (d.start_time || '') + '–' + (d.end_time || '')
            : (d.time_in ? d.time_in + '–' + (d.time_out || '…') : 'No shift set');
          var li = mEl(
            '<li class="m-list-row' + (isToday ? ' unread' : '') + '">' +
            '<div><b>' + DOW[dt.getDay()] + ' ' + d.work_date.slice(5) + (isToday ? ' · Today' : '') + '</b>' +
            '<span>' + mEsc(shift) + '</span></div></li>'
          );
          ul.appendChild(li);
        });
        view.appendChild(ul);
      });
    })
    .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
});
