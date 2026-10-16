/* Timekeeping — Figma node 46:577 (adapted 2026-10-10: slot tiles instead of the action
   dropdown + review screen, approved by Kyle; the Figma frame still shows the old flow).
   The employee picks what they're recording — the kiosk's four slots: Time in, Afternoon out,
   Afternoon in, Time out — and the rest runs by itself: scan the office QR (GPS is fetched
   meanwhile), an auto-captured selfie, done. Re-doing a slot replaces its time and photo.
   The server stays authoritative for QR validity, GPS/geofence and where the punch lands
   (src/modules/hr/punch-holds.ts, clock.ts setSlotPunch). */
(function () {
  var ticker = null;
  var SLOTS = [
    { key: 'in', label: 'Time in', kind: 'in' },
    { key: 'lunchOut', label: 'Afternoon out', kind: 'out' },
    { key: 'lunchIn', label: 'Afternoon in', kind: 'in' },
    { key: 'out', label: 'Time out', kind: 'out' }
  ];
  var SEG_LABEL = {
    morning_in: 'Time in', lunch_out: 'Afternoon out', afternoon_in: 'Afternoon in',
    afternoon_out: 'Time out', other_in: 'Time in', other_out: 'Time out'
  };
  var WHERE_KEY = 'vds_m_clock_where'; // clock_anywhere staff: 'office' (scan QR) | 'outside'
  var SELFIE_SECONDS = 2;
  var AUTO_HOME_MS = 2500;

  function slotDef(key) { return SLOTS.filter(function (x) { return x.key === key; })[0]; }

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
  function stateText(s) {
    if (s.slots && s.slots.out) return 'Completed today';
    return s.clocked_in ? 'Clocked in' : 'Not clocked in';
  }
  function getWhere() {
    try { return localStorage.getItem(WHERE_KEY) === 'outside' ? 'outside' : 'office'; } catch (e) { return 'office'; }
  }
  function setWhere(v) { try { localStorage.setItem(WHERE_KEY, v); } catch (e) {} }
  function noticeText(s, remote) {
    if (remote) return 'Outside the office: your GPS location and a selfie are kept for HR.';
    if (s.location_required) return 'Scan the office QR, then a selfie is taken. Your location is checked — time-in only works at the office.';
    return 'Scan the office QR, then a selfie is taken. Your time is the moment you scan.';
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
    var slots = s.slots || {};
    var page = mEl('<section class="v2-clock" data-figma-node="46:577"></section>');
    page.appendChild(mEl('<header class="v2-clock-heading"><h1>Timekeeping</h1><p>Tap what you’re recording — then scan and smile</p></header>'));
    page.appendChild(mEl(
      '<section class="v2-live-time"><strong data-live-time>--:--:--</strong>' +
      '<p data-live-date></p><span>' + mEsc(stateText(s)) + '</span></section>'
    ));

    var where = s.can_clock_anywhere ? getWhere() : 'office';
    if (s.can_clock_anywhere) {
      var toggle = mEl(
        '<div class="v2-clock-where" role="radiogroup" aria-label="Where are you?">' +
        '<button type="button" role="radio" data-where="office">At the office</button>' +
        '<button type="button" role="radio" data-where="outside">Outside the office</button></div>'
      );
      page.appendChild(toggle);
    }

    page.appendChild(mEl('<h2>Record</h2>'));
    var grid = mEl('<div class="v2-clock-slots"></div>');
    SLOTS.forEach(function (d) {
      var at = slots[d.key];
      var isNext = s.next_slot === d.key;
      var tile = mEl(
        '<button type="button" class="v2-clock-slot' + (at ? ' is-filled' : '') + (isNext ? ' is-next' : '') + '" data-slot="' + d.key + '">' +
        '<span>' + mEsc(d.label) + (isNext ? ' <i>Next</i>' : '') + '</span>' +
        '<b>' + (at ? mEsc(at) : '–') + '</b></button>'
      );
      grid.appendChild(tile);
    });
    page.appendChild(grid);
    var replaceBar = mEl('<div class="v2-clock-replace" role="alert" hidden></div>');
    page.appendChild(replaceBar);
    var notice = mEl('<section class="v2-clock-notice"><p></p></section>');
    page.appendChild(notice);
    var fix = mEl('<button type="button" class="v2-clock-fix">Fix a missed or incorrect punch on another day</button>');
    fix.onclick = function () { MApp.go('time-fix'); };
    page.appendChild(fix);

    page.appendChild(mEl('<h2 class="v2-clock-log-title">Today’s log</h2>'));
    var punches = s.punches || [];
    page.appendChild(punches.length
      ? mEl('<ul class="v2-clock-log">' + punches.map(logRow).join('') + '</ul>')
      : mEl('<div class="v2-clock-empty"><span><b>No entries yet</b><small>Tap Time in to begin today’s record</small></span></div>'));

    function paintWhere() {
      notice.querySelector('p').textContent = noticeText(s, where === 'outside');
      Array.prototype.forEach.call(page.querySelectorAll('[data-where]'), function (b) {
        var on = b.getAttribute('data-where') === where;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    Array.prototype.forEach.call(page.querySelectorAll('[data-where]'), function (b) {
      b.onclick = function () { where = b.getAttribute('data-where'); setWhere(where); paintWhere(); };
    });
    paintWhere();

    Array.prototype.forEach.call(grid.querySelectorAll('[data-slot]'), function (tile) {
      tile.onclick = function () {
        var d = slotDef(tile.getAttribute('data-slot'));
        var at = slots[d.key];
        if (!at) { start(view, s, d, where === 'outside'); return; }
        // Re-doing a slot replaces its time and selfie — one explicit step so a stray tap can't.
        replaceBar.hidden = false;
        replaceBar.innerHTML = '<p>Replace your <b>' + mEsc(d.label.toLowerCase()) + '</b> at ' + mEsc(at) +
          '? The new time and selfie replace the old ones.</p>' +
          '<div><button type="button" class="m-btn" data-replace>Replace</button>' +
          '<button type="button" class="m-btn m-btn-secondary" data-keep>Keep ' + mEsc(at) + '</button></div>';
        replaceBar.querySelector('[data-replace]').onclick = function () { start(view, s, d, where === 'outside'); };
        replaceBar.querySelector('[data-keep]').onclick = function () { replaceBar.hidden = true; };
      };
    });

    view.appendChild(page);
    startLiveClock(page);
  }

  /** The phone's GPS position — resolves { location } or { error } (never rejects, so it can be
      started early and awaited only if needed). */
  function locate() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve({ error: 'This phone can’t share its location' }); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ location: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy } });
      }, function (err) {
        resolve({ error: err && err.code === 1
          ? 'Location is blocked — allow location for this site, then try again'
          : 'Could not get your location — turn on GPS and try again' });
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  /* From the slot tap, everything runs by itself: the office QR scan (GPS fetched meanwhile), or —
     outside the office — just the GPS; then the selfie. */
  function start(view, s, d, remote) {
    if (ticker) clearInterval(ticker);
    function withLoc(loc, body) {
      view.innerHTML = '<div class="m-hint">Checking your location…</div>';
      loc.then(function (r) {
        if (r.error) { mToast(r.error, 'err'); load(view); return; }
        body.location = r.location;
        punch(view, body, d);
      });
    }
    if (remote) { withLoc(locate(), {}); return; }
    var loc = s.location_required ? locate() : null;
    mScanner.open({
      title: 'Scan the office screen — ' + d.label,
      onResult: function (code) {
        code = String(code || '').trim();
        if (!code) return;
        if (loc) withLoc(loc, { code: code });
        else punch(view, { code: code }, d);
      }
    });
  }

  /* Two steps (server: src/modules/hr/punch-holds.ts). The scan is checked and held at its own
     time; the selfie then records the chosen slot at that time, so the camera step never makes
     anyone late. No selfie, no punch. */
  function punch(view, body, d) {
    view.innerHTML = '<div class="m-hint">Checking your scan…</div>';
    API.post('/hr/clock/punch/scan', body)
      .then(function (hold) {
        view.innerHTML = '<div class="m-hint">Look at the camera…</div>';
        return mSelfie.take({ title: d.label + ' — selfie', note: 'Look at the camera — the photo takes itself.', auto: SELFIE_SECONDS })
          .then(function (photo) {
            view.innerHTML = '<div class="m-hint">Recording ' + mEsc(d.label.toLowerCase()) + '…</div>';
            var fd = new FormData();
            fd.append('hold_id', String(hold.hold_id));
            fd.append('slot', d.key);
            fd.append('photo', photo, 'selfie.jpg');
            return API.upload('/hr/clock/punch/selfie', fd);
          });
      })
      .then(function (r) {
        chime(d.kind);
        var d0 = new Date();
        var localToday = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
        // Before today's time-in time, a Time out closes yesterday's still-open shift (server-side
        // openShiftToClose in src/modules/hr/clock.ts) — the hours are that shift's, not today's.
        var prevShift = r.work_date && r.work_date !== localToday;
        var title = d.label + (r.replaced ? ' updated' : ' recorded');
        var lines = [
          d.label + ' · ' + r.at,
          r.hours_today + (prevShift ? ' h — closes your ' + r.work_date + ' shift' : ' h today')
        ];
        var actions = [
          { label: 'Done', onClick: function () { MApp.go('home'); } },
          { label: 'Today’s log', secondary: true, onClick: function () { load(view); } }
        ];
        function show(autoHome) {
          if (autoHome) lines.push('Back to Home in a moment');
          mSuccess(view, { title: title, lines: lines, actions: actions });
          if (!autoHome) return;
          var box = view.querySelector('.m-success');
          setTimeout(function () { if (box && box.isConnected) MApp.go('home'); }, AUTO_HOME_MS);
        }
        if (d.key !== 'out') { show(true); return; }
        var day = r.work_date;
        API.get('/me/unrecorded-ot').then(function (rows) {
          var mine = (rows || []).filter(function (x) { return x.work_date === day; })[0];
          if (!mine) { show(true); return; }
          // Overtime to request: stay on this screen so the button can be used.
          lines.push(Math.round(mine.ot_minutes / 60 * 10) / 10 + ' h unrecorded overtime');
          actions.unshift({ label: 'Request OT', onClick: function () {
            MApp.go('requests', { type: 'overtime_request', date: day });
          } });
          show(false);
        }).catch(function () { show(true); });
      })
      .catch(function (ex) {
        mToast(ex && ex.offline ? 'You’re offline — connect to record timekeeping'
          : ex && ex.message === 'cancelled' ? 'Not recorded — a selfie is needed to finish'
          : ((ex && ex.message) || 'Punch failed'), 'err');
        load(view);
      });
  }

  MApp.route('clock', function (view) { load(view); });
})();
