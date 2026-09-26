/* Timekeeping — Figma node 46:577.
   The employee selects/reviews the next valid action; the server remains authoritative
   for punch classification, QR validity, GPS/geofence, duplicate and final-out rules. */
(function () {
  var ticker = null;
  var SEG_LABEL = {
    morning_in: 'Morning time-in', lunch_out: 'Lunch out', afternoon_in: 'Back from lunch',
    afternoon_out: 'Time-out', other_in: 'Time-in', other_out: 'Time-out'
  };

  function chime(kind) {
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var notes = kind === 'in' ? [523, 659, 784] : [784, 659, 523];
      notes.forEach(function (f, i) {
        var osc = ac.createOscillator(), gain = ac.createGain();
        osc.frequency.value = f; osc.type = 'sine'; osc.connect(gain); gain.connect(ac.destination);
        var at = ac.currentTime + i * .12;
        gain.gain.setValueAtTime(.0001, at);
        gain.gain.exponentialRampToValueAtTime(.25, at + .02);
        gain.gain.exponentialRampToValueAtTime(.0001, at + .18);
        osc.start(at); osc.stop(at + .2);
      });
    } catch (e) {}
  }
  function dateText(d) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  }
  function timeText(d) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  }
  function nextAction(s) {
    var punches = s.punches || [];
    var last = punches[punches.length - 1];
    if (punches.some(function (p) { return p.segment === 'afternoon_out'; })) return { value: 'complete', label: 'Day completed', disabled: true };
    if (!last) return { value: 'punch', label: 'Clock in' };
    if (last.kind === 'in') {
      var hasAfternoon = punches.some(function (p) { return p.segment === 'afternoon_in'; });
      return { value: 'punch', label: hasAfternoon ? 'Clock out' : 'Start lunch / Clock out' };
    }
    return { value: 'punch', label: 'Return from lunch / Clock in' };
  }
  function stateText(s) {
    if ((s.punches || []).some(function (p) { return p.segment === 'afternoon_out'; })) return 'Completed today';
    return s.clocked_in ? 'Clocked in' : 'Not clocked in';
  }
  function locationNotice(s) {
    if (s.can_clock_anywhere) return {
      title: 'Location will be recorded',
      copy: 'Your current GPS location and device time will be retained for HR.'
    };
    if (s.location_required) return {
      title: 'Location confirmation required',
      copy: 'Scan the current office QR. Your location is checked — time-in only works at the office.'
    };
    return {
      title: 'Office QR confirmation required',
      copy: 'Scan the current office code. It changes every minute and device time is retained.'
    };
  }
  function startLiveClock(root) {
    if (ticker) clearInterval(ticker);
    function paint() {
      var now = new Date();
      var time = root.querySelector('[data-live-time]');
      var date = root.querySelector('[data-live-date]');
      if (time) time.textContent = timeText(now);
      if (date) date.textContent = dateText(now);
    }
    paint();
    ticker = setInterval(paint, 1000);
  }
  function logRow(p) {
    return '<li><span><b>' + mEsc(SEG_LABEL[p.segment] || p.segment) + '</b><small>' +
      mEsc(p.source ? p.source.replace(/_/g, ' ') : 'Recorded') + '</small></span><time>' +
      mEsc(p.at || '') + '</time></li>';
  }

  function load(view) {
    MApp.setTitle('Timekeeping');
    if (ticker) clearInterval(ticker);
    view.innerHTML = '<div class="m-hint">Loading timekeeping…</div>';
    API.get('/hr/clock/my-status')
      .then(function (s) { draw(view, s); })
      .catch(function (ex) {
        view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Could not load your clock') +
          '</div><button class="m-btn" data-retry>Retry</button>';
        var retry = view.querySelector('[data-retry]');
        if (retry) retry.onclick = function () { load(view); };
      });
  }

  function draw(view, s) {
    view.innerHTML = '';
    var action = nextAction(s);
    var notice = locationNotice(s);
    var page = mEl('<section class="v2-clock" data-figma-node="46:577"></section>');
    page.appendChild(mEl('<header class="v2-clock-heading"><h1>Timekeeping</h1><p>Select an action before confirming</p></header>'));
    page.appendChild(mEl(
      '<section class="v2-live-time"><strong data-live-time>--:--:--</strong>' +
      '<p data-live-date></p><span>' + mEsc(stateText(s)) + '</span></section>'
    ));

    page.appendChild(mEl('<h2>Choose action</h2>'));
    var selector = mEl(
      '<label class="v2-clock-select"><select aria-label="Timekeeping action">' +
      '<option value="' + action.value + '"' + (action.disabled ? ' disabled' : '') + '>' + mEsc(action.label) + '</option>' +
      '<option value="correct">Fix a missed or incorrect punch</option>' +
      '</select><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></label>'
    );
    page.appendChild(selector);
    page.appendChild(mEl(
      '<section class="v2-clock-notice"><b>' + mEsc(notice.title) + '</b><p>' + mEsc(notice.copy) + '</p></section>'
    ));
    var review = mEl('<button type="button" class="v2-clock-primary"' + (action.disabled ? ' disabled' : '') + '>Review &amp; confirm</button>');
    page.appendChild(review);

    page.appendChild(mEl('<h2 class="v2-clock-log-title">Today’s log</h2>'));
    var punches = s.punches || [];
    if (punches.length) {
      page.appendChild(mEl('<ul class="v2-clock-log">' + punches.map(logRow).join('') + '</ul>'));
    } else {
      var empty = mEl(
        '<button type="button" class="v2-clock-empty"><span><b>No entries yet</b><small>Clock in to begin today’s record</small></span>' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
      );
      empty.onclick = function () { selector.querySelector('select').focus(); };
      page.appendChild(empty);
    }

    review.onclick = function () {
      var selected = selector.querySelector('select').value;
      if (selected === 'correct') { MApp.go('time-fix'); return; }
      confirmAction(view, s, action);
    };
    selector.querySelector('select').onchange = function () {
      review.disabled = this.value === 'complete';
      review.textContent = this.value === 'correct' ? 'Continue to correction' : 'Review & confirm';
    };
    view.appendChild(page);
    startLiveClock(page);
  }

  function confirmAction(view, s, action) {
    if (ticker) clearInterval(ticker);
    view.innerHTML = '';
    var notice = locationNotice(s);
    var page = mEl(
      '<section class="v2-clock-confirm"><span class="v2-role-chip">Confirm timekeeping</span>' +
      '<h1>' + mEsc(action.label) + '</h1><p>Review the action and required verification before recording it.</p>' +
      '<dl><div><dt>Employee</dt><dd>' + mEsc(s.employee_name || '') + '</dd></div>' +
      '<div><dt>Action</dt><dd>' + mEsc(action.label) + '</dd></div>' +
      '<div><dt>Verification</dt><dd>' + mEsc(notice.title) + '</dd></div></dl>' +
      '<div class="v2-clock-confirm-actions"></div></section>'
    );
    var actions = page.querySelector('.v2-clock-confirm-actions');
    var scan = mEl('<button type="button" class="m-btn">Scan office QR & confirm</button>');
    scan.onclick = function () {
      mScanner.open({
        title: 'Scan the time-in screen',
        onResult: function (code) {
          code = String(code || '').trim();
          if (!code) return;
          if (s.location_required) withLocation(view, function (loc) { punch(view, { code: code, location: loc }); });
          else punch(view, { code: code });
        }
      });
    };
    actions.appendChild(scan);

    if (s.can_clock_anywhere) {
      var here = mEl('<button type="button" class="m-btn m-btn-secondary">Clock ' +
        (s.clocked_in ? 'out' : 'in') + ' here</button>');
      here.onclick = function () { withLocation(view, function (loc) { punch(view, { location: loc }); }); };
      actions.appendChild(here);
    }
    var back = mEl('<button type="button" class="m-btn m-btn-secondary">Back</button>');
    back.onclick = function () { draw(view, s); };
    actions.appendChild(back);
    view.appendChild(page);
  }

  function withLocation(view, done) {
    if (!navigator.geolocation) { mToast('This phone can’t share its location', 'err'); return; }
    view.innerHTML = '<div class="m-hint">Getting your location…</div>';
    navigator.geolocation.getCurrentPosition(function (p) {
      done({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy });
    }, function (err) {
      mToast(err && err.code === 1
        ? 'Location is blocked — allow location for this site, then try again'
        : 'Could not get your location — turn on GPS and try again', 'err');
      load(view);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function punch(view, body) {
    view.innerHTML = '<div class="m-hint">Recording timekeeping…</div>';
    API.post('/hr/clock/punch', body)
      .then(function (r) {
        chime(r.kind);
        var actions = [
          { label: 'Done', onClick: function () { load(view); } },
          { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } }
        ];
        var lines = [
          (SEG_LABEL[r.segment] || r.segment) + ' · ' + r.at,
          r.hours_today + ' h today' + (r.duplicate ? ' (already recorded)' : '')
        ];
        if (r.kind !== 'out') {
          mSuccess(view, { title: 'Clocked IN', lines: lines, actions: actions });
          return;
        }
        var today = r.work_date;
        API.get('/me/unrecorded-ot').then(function (rows) {
          var mine = (rows || []).filter(function (d) { return d.work_date === today; })[0];
          if (mine) {
            lines.push(Math.round(mine.ot_minutes / 60 * 10) / 10 + ' h unrecorded overtime');
            actions.unshift({ label: 'Request OT', onClick: function () {
              MApp.go('requests', { type: 'overtime_request', date: today });
            } });
          }
          mSuccess(view, { title: 'Clocked OUT', lines: lines, actions: actions });
        }).catch(function () { mSuccess(view, { title: 'Clocked OUT', lines: lines, actions: actions }); });
      })
      .catch(function (ex) {
        mToast(ex && ex.offline ? 'You’re offline — connect to record timekeeping' : (ex.message || 'Punch failed'), 'err');
        load(view);
      });
  }

  MApp.route('clock', function (view) { load(view); });
})();