/* Time clock — scan the office kiosk QR to clock in / out. With the office location lock on
   (HR → Time Keeping → Policy Settings), the phone's GPS position is sent too and must be
   on-site; staff allowed to clock in anywhere get a no-QR "Clock in here" button instead.
   See src/modules/hr/clock-geofence.ts. */
(function () {
  var SEG_LABEL = {
    morning_in: 'Morning time-in', lunch_out: 'Lunch out', afternoon_in: 'Back from lunch',
    afternoon_out: 'Time-out', other_in: 'Time-in', other_out: 'Time-out',
  };

  function chime(kind) {
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var notes = kind === 'in' ? [523, 659, 784] : [784, 659, 523];
      notes.forEach(function (f, i) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = f; o.type = 'sine';
        o.connect(g); g.connect(ac.destination);
        var t = ac.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.start(t); o.stop(t + 0.2);
      });
    } catch (e) { /* no audio, no problem */ }
  }

  function statusCard(view, s) {
    var body = s.clocked_in
      ? '<div class="m-clock-state in">● Clocked IN since ' + mEsc(s.since) + '</div>'
      : '<div class="m-clock-state out">○ Not clocked in</div>';
    var list = (s.punches || []).map(function (p) {
      return '<li><span>' + mEsc(p.at) + '</span><b>' + (p.kind === 'in' ? 'IN' : 'OUT') + '</b>' +
        '<span class="m-clock-seg">' + mEsc(SEG_LABEL[p.segment] || p.segment) + '</span></li>';
    }).join('');
    return mEl(
      '<div class="m-clock-card">' + body +
      '<div class="m-clock-hours">' + s.hours_today + ' h today</div>' +
      (list ? '<ul class="m-clock-log">' + list + '</ul>' : '') +
      '</div>'
    );
  }

  function load(view) {
    MApp.setTitle('Time clock');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/hr/clock/my-status')
      .then(function (s) { draw(view, s); })
      .catch(function (ex) {
        view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Could not load your clock') + '</div>';
      });
  }

  function draw(view, s) {
    view.innerHTML = '';
    view.appendChild(mEl('<div class="m-hint">' + mEsc(s.employee_name || '') + '</div>'));
    view.appendChild(statusCard(view, s));
    var btn = mEl('<div class="m-actions"><button class="m-btn">📷  Scan office code</button></div>');
    btn.querySelector('button').onclick = function () {
      mScanner.open({
        title: 'Scan the time-in screen',
        onResult: function (code) {
          code = (code || '').trim();
          if (!code) return;
          // With the office location lock on, the server also needs to know the phone is on-site.
          if (s.location_required) withLocation(view, function (loc) { punch(view, { code: code, location: loc }); });
          else punch(view, { code: code });
        },
      });
    };
    view.appendChild(btn);
    view.appendChild(mEl('<div class="m-hint">Point at the QR on the office time-in monitor. It changes every minute.' +
      (s.location_required ? ' Your location is checked — time-in only works at the office.' : '') + '</div>'));

    // Field staff (HR's "can time in outside the office") can't see the QR — punch where they are.
    if (s.can_clock_anywhere) {
      var here = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary">📍  Clock ' +
        (s.clocked_in ? 'out' : 'in') + ' here (outside the office)</button></div>');
      here.querySelector('button').onclick = function () {
        withLocation(view, function (loc) { punch(view, { location: loc }); });
      };
      view.appendChild(here);
      view.appendChild(mEl('<div class="m-hint">Your location is saved with the punch for HR.</div>'));
    }
  }

  /** Ask the phone for a GPS fix, then call `done({lat, lng, accuracy_m})`. */
  function withLocation(view, done) {
    if (!navigator.geolocation) { mToast('This phone can’t share its location', 'err'); return; }
    view.innerHTML = '<div class="m-hint">Getting your location…</div>';
    navigator.geolocation.getCurrentPosition(function (p) {
      done({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy });
    }, function (err) {
      mToast(err && err.code === 1
        ? 'Location is blocked — allow location for this site in your browser settings, then try again'
        : 'Could not get your location — turn on location / GPS and try again', 'err');
      load(view);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function punch(view, body) {
    view.innerHTML = '<div class="m-hint">Recording…</div>';
    API.post('/hr/clock/punch', body)
      .then(function (r) {
        chime(r.kind);
        var actions = [
          { label: 'Done', onClick: function () { load(view); } },
          { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
        ];
        var lines = [
          (SEG_LABEL[r.segment] || r.segment) + ' · ' + r.at,
          r.hours_today + ' h today' + (r.duplicate ? ' (already recorded)' : ''),
        ];
        if (r.kind !== 'out') {
          mSuccess(view, { title: 'Clocked IN', lines: lines, actions: actions });
          return;
        }
        // Clocking out: check whether HR's already-entered time for today shows unrecorded
        // OT (a shift-aware check against attendance_records — this raw punch alone doesn't
        // know the shift) with no Overtime Request form linked, and offer to file one right
        // here if so.
        var today = r.work_date; // the server's local date (toISOString would be UTC — wrong before 8 AM in PH)
        API.get('/me/unrecorded-ot').then(function (rows) {
          var mine = (rows || []).filter(function (d) { return d.work_date === today; })[0];
          if (mine) {
            lines.push('⏱️ ' + Math.round(mine.ot_minutes / 60 * 10) / 10 + ' h unrecorded OT — no request filed');
            actions.unshift({ label: 'Request OT', onClick: function () { MApp.go('requests', { type: 'overtime_request', date: today }); } });
          }
          mSuccess(view, { title: 'Clocked OUT', lines: lines, actions: actions });
        }).catch(function () {
          mSuccess(view, { title: 'Clocked OUT', lines: lines, actions: actions });
        });
      })
      .catch(function (ex) {
        if (ex && ex.offline) { mToast('You’re offline — connect to punch', 'err'); }
        else { mToast(ex.message || 'Punch failed', 'err'); }
        load(view);
      });
  }

  MApp.route('clock', function (view) { load(view); });
})();
