/* Schedule — Figma mobile V2 node 46:606.
   The API remains authoritative; this view turns published roster data into a
   guided week view without inventing shifts for rest/unpublished days. */
MApp.route('schedule', function (view) {
  MApp.setTitle('Schedule');
  view.setAttribute('data-figma-node', '46:606');
  view.innerHTML =
    '<section class="m-v2-page m-schedule-v2">' +
      '<header class="m-v2-heading"><p class="m-v2-eyebrow">My work week</p><h1>Schedule</h1><p id="scheduleRange">Loading published schedule…</p></header>' +
      '<div class="m-schedule-week" id="scheduleWeek" aria-label="Choose a day"></div>' +
      '<div id="scheduleDetail"><div class="m-hint">Loading…</div></div>' +
      '<section class="m-schedule-upcoming" aria-labelledby="upcomingTitle">' +
        '<div class="m-v2-section-title"><div><p class="m-v2-eyebrow">Plan ahead</p><h2 id="upcomingTitle">Upcoming</h2></div></div>' +
        '<div id="scheduleUpcoming"></div>' +
      '</section>' +
      '<button class="m-v2-primary m-schedule-request" id="scheduleRequest" type="button">' +
        '<span class="m-v2-button-icon" aria-hidden="true">↔</span><span>Request schedule change</span>' +
      '</button>' +
    '</section>';

  var weekEl = view.querySelector('#scheduleWeek');
  var detailEl = view.querySelector('#scheduleDetail');
  var upcomingEl = view.querySelector('#scheduleUpcoming');
  var rangeEl = view.querySelector('#scheduleRange');
  var todayKey = localDateKey(new Date());
  var selectedKey = todayKey;
  var schedule = null;
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function localDateKey(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function parseDay(key) {
    var parts = key.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function addDays(date, amount) {
    var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + amount);
    return next;
  }

  function mondayOf(date) {
    var day = date.getDay();
    return addDays(date, day === 0 ? -6 : 1 - day);
  }

  function compactTime(value) {
    if (!value) return '';
    var parts = String(value).split(':');
    var hour = Number(parts[0]);
    var minute = parts[1] || '00';
    if (isNaN(hour)) return value;
    return ((hour + 11) % 12 + 1) + ':' + minute + (hour >= 12 ? ' PM' : ' AM');
  }

  function dayMap(days) {
    var map = {};
    (days || []).forEach(function (day) { map[day.work_date] = day; });
    return map;
  }

  function shiftText(day) {
    if (!day) return 'Rest day';
    if (day.shift_name || day.start_time || day.end_time) {
      var times = day.start_time ? compactTime(day.start_time) : '';
      if (day.end_time) times += (times ? ' – ' : '') + compactTime(day.end_time);
      return (day.shift_name || 'Work shift') + (times ? ' · ' + times : '');
    }
    if (day.time_in || day.time_out) {
      return 'Work shift · ' + compactTime(day.time_in) + (day.time_out ? ' – ' + compactTime(day.time_out) : '');
    }
    return 'Rest day';
  }

  function statusText(day) {
    if (!day) return 'No published shift';
    if (day.status) return String(day.status).replace(/_/g, ' ');
    return (day.shift_name || day.start_time || day.time_in) ? 'Published' : 'Rest day';
  }

  function renderWeek(anchor) {
    var start = mondayOf(anchor);
    var end = addDays(start, 6);
    var map = dayMap(schedule.days);
    rangeEl.textContent = MONTH[start.getMonth()] + ' ' + start.getDate() + ' – ' +
      MONTH[end.getMonth()] + ' ' + end.getDate() + ', ' + end.getFullYear();
    weekEl.innerHTML = '';

    for (var i = 0; i < 7; i += 1) {
      var date = addDays(start, i);
      var key = localDateKey(date);
      var day = map[key];
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'm-schedule-day' + (key === selectedKey ? ' is-selected' : '') +
        (key === todayKey ? ' is-today' : '') + (day ? ' has-shift' : '');
      button.setAttribute('data-date', key);
      button.setAttribute('aria-pressed', key === selectedKey ? 'true' : 'false');
      button.innerHTML = '<span>' + DOW[date.getDay()] + '</span><b>' + date.getDate() + '</b><i aria-hidden="true"></i>';
      button.addEventListener('click', function () {
        selectedKey = this.getAttribute('data-date');
        renderWeek(parseDay(selectedKey));
        renderDetail();
      });
      weekEl.appendChild(button);
    }
  }

  function renderDetail() {
    var map = dayMap(schedule.days);
    var day = map[selectedKey];
    var date = parseDay(selectedKey);
    var hasShift = day && (day.shift_name || day.start_time || day.time_in);
    detailEl.innerHTML =
      '<article class="m-schedule-detail ' + (hasShift ? 'has-shift' : 'is-rest') + '">' +
        '<div class="m-schedule-detail-top">' +
          '<div><p class="m-v2-eyebrow">' + (selectedKey === todayKey ? 'Today' : DOW[date.getDay()]) + '</p>' +
          '<h2>' + MONTH[date.getMonth()] + ' ' + date.getDate() + '</h2></div>' +
          '<span class="m-schedule-status">' + mEsc(statusText(day)) + '</span>' +
        '</div>' +
        '<div class="m-schedule-shift">' +
          '<span class="m-schedule-shift-icon" aria-hidden="true">' + (hasShift ? '◷' : '☾') + '</span>' +
          '<div><b>' + mEsc(hasShift ? (day.shift_name || 'Work shift') : 'Rest day') + '</b>' +
          '<span>' + mEsc(hasShift ? shiftText(day).replace((day.shift_name || 'Work shift') + ' · ', '') : 'No clock activity expected') + '</span></div>' +
        '</div>' +
        '<div class="m-schedule-meta">' +
          '<span><i aria-hidden="true">⌖</i>' + mEsc((day && (day.location || day.work_location)) || 'Assigned workplace') + '</span>' +
          '<span><i aria-hidden="true">●</i>' + mEsc((day && day.department) || 'Regular assignment') + '</span>' +
        '</div>' +
      '</article>';
  }

  function renderUpcoming() {
    var future = (schedule.days || []).filter(function (day) { return day.work_date > selectedKey; }).slice(0, 4);
    if (!future.length) {
      upcomingEl.innerHTML = '<div class="m-empty m-schedule-empty">No more published shifts in this schedule window.</div>';
      return;
    }
    upcomingEl.innerHTML = future.map(function (day) {
      var date = parseDay(day.work_date);
      var hasShift = day.shift_name || day.start_time || day.time_in;
      return '<button class="m-schedule-row" type="button" data-date="' + mEsc(day.work_date) + '">' +
        '<span class="m-schedule-row-date"><b>' + date.getDate() + '</b><small>' + MONTH[date.getMonth()] + '</small></span>' +
        '<span class="m-schedule-row-copy"><b>' + DOW[date.getDay()] + ' · ' + mEsc(hasShift ? (day.shift_name || 'Work shift') : 'Rest day') + '</b>' +
        '<small>' + mEsc(shiftText(day)) + '</small></span><span class="m-schedule-chevron" aria-hidden="true">›</span></button>';
    }).join('');
    Array.prototype.forEach.call(upcomingEl.querySelectorAll('[data-date]'), function (button) {
      button.addEventListener('click', function () {
        selectedKey = this.getAttribute('data-date');
        renderWeek(parseDay(selectedKey));
        renderDetail();
        view.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  view.querySelector('#scheduleRequest').addEventListener('click', function () {
    var future = (schedule && schedule.days || []).filter(function (day) { return day.work_date > todayKey && day.is_working_day !== false; });
    var target = future.some(function (day) { return day.work_date === selectedKey; })
      ? selectedKey : (future[0] && future[0].work_date);
    if (!target) { mToast('No future roster day is published yet. Ask HR to publish your schedule first.', 'err'); return; }
    MApp.go('requests', { type: 'schedule_change', date: target });
  });

  API.get('/me/schedule').then(function (response) {
    schedule = response || {};
    schedule.days = schedule.days || [];
    var map = dayMap(schedule.days);
    if (!map[selectedKey] && schedule.days.length) {
      var next = schedule.days.filter(function (day) { return day.work_date >= todayKey; })[0];
      selectedKey = (next || schedule.days[0]).work_date;
    }
    renderWeek(parseDay(selectedKey));
    renderDetail();
    renderUpcoming();
  }).catch(function (error) {
    rangeEl.textContent = 'Schedule unavailable';
    weekEl.innerHTML = '';
    detailEl.innerHTML = '<div class="m-error">' + mEsc(error.message) + '</div>';
    upcomingEl.innerHTML = '<button class="m-v2-secondary" type="button" id="scheduleRetry">Try again</button>';
    view.querySelector('#scheduleRetry').addEventListener('click', function () { MApp.go('schedule'); });
  });
});
