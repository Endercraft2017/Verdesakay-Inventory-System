/* Time clock — scan the office kiosk QR to clock in / out. */
(function () {
  var SEG_LABEL = {
    morning_in: 'Morning time-in', lunch_out: 'Lunch out', afternoon_in: 'Afternoon time-in',
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
        onResult: function (code) { punch(view, (code || '').trim()); },
      });
    };
    view.appendChild(btn);
    view.appendChild(mEl('<div class="m-hint">Point at the QR on the office time-in monitor. It changes every minute.</div>'));
  }

  function punch(view, code) {
    if (!code) return;
    view.innerHTML = '<div class="m-hint">Recording…</div>';
    API.post('/hr/clock/punch', { code: code })
      .then(function (r) {
        chime(r.kind);
        mSuccess(view, {
          title: r.kind === 'in' ? 'Clocked IN' : 'Clocked OUT',
          lines: [
            (SEG_LABEL[r.segment] || r.segment) + ' · ' + r.at,
            r.hours_today + ' h today' + (r.duplicate ? ' (already recorded)' : ''),
          ],
          actions: [
            { label: 'Done', onClick: function () { load(view); } },
            { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
          ],
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
