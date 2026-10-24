/* Schedule — Figma mobile V2 node 46:606. Published roster rows are authoritative;
   missing dates, non-working dates and recorded punches are different states. */
(function () {
  var session = null;
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function identity() {
    var me = MApp.getMe() || {};
    return JSON.stringify([
      API.base?.() || '',
      me.id,
      me.employee?.id,
      API.getToken?.() || '',
      !!API.isSharedSession?.(),
    ]);
  }
  function same(ctx) {
    return session === ctx && ctx.identity === identity();
  }
  function alive(ctx) {
    return same(ctx) && ctx.active?.root.isConnected && ctx.active.hash === location.hash;
  }
  function depart(ctx) {
    if (!same(ctx) && ctx.active?.root.isConnected) ctx.active.root.textContent = '';
    ctx.active = null;
    var job = ctx.job;
    ctx.job = null;
    job?.controller.abort();
  }
  function context() {
    var key = identity();
    if (!session || session.identity !== key) {
      if (session) {
        depart(session);
        session.observer.disconnect();
      }
      var ctx = (session = {
        identity: key,
        active: null,
        days: null,
        error: '',
        job: null,
        selected: localDateKey(new Date()),
      });
      ctx.observer = new MutationObserver(function () {
        if (ctx.active && !alive(ctx)) depart(ctx);
      });
      ctx.observer.observe(document.body, { childList: true, subtree: true });
    }
    return session;
  }
  window.addEventListener('hashchange', function () {
    if (session?.active && !alive(session)) depart(session);
  });
  window.addEventListener('storage', function () {
    if (session?.active && !same(session)) depart(session);
  });
  function localDateKey(d) {
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }
  function parseDay(key) {
    return new Date(key + 'T00:00:00');
  }
  function addDays(d, n) {
    var next = new Date(d);
    next.setDate(next.getDate() + n);
    return next;
  }
  function mondayOf(d) {
    return addDays(d, d.getDay() === 0 ? -6 : 1 - d.getDay());
  }
  function shortDate(key) {
    var d = parseDay(key);
    return MONTH[d.getMonth()] + ' ' + d.getDate();
  }
  function compactTime(value) {
    if (!value) return '—';
    var parts = String(value).split(':'),
      hour = Number(parts[0]);
    if (isNaN(hour)) return String(value);
    return ((hour + 11) % 12) + 1 + ':' + (parts[1] || '00') + (hour >= 12 ? ' PM' : ' AM');
  }
  function times(day) {
    if (!day.start_time && !day.end_time) return 'Shift time unavailable';
    return (
      compactTime(day.start_time) +
      ' – ' +
      compactTime(day.end_time) +
      (day.start_time && day.end_time && day.end_time < day.start_time ? ' · next day' : '')
    );
  }
  function row(ctx, key) {
    return (ctx.days || []).find(function (d) {
      return d.work_date === key;
    });
  }
  function hasShift(day) {
    return day && day.is_working_day !== false && (day.start_time || day.end_time);
  }
  function dayTitle(day) {
    return !day
      ? 'Schedule not published'
      : day.is_working_day === false
        ? 'Non-working day'
        : day.shift_name || 'Work day';
  }
  function eligible(ctx) {
    var day = row(ctx, ctx.selected);
    return !!(
      day &&
      day.is_working_day === true &&
      ctx.selected > localDateKey(new Date()) &&
      !ctx.job &&
      !ctx.error
    );
  }
  function focus(ctx, selector) {
    if (alive(ctx)) ctx.active.root.querySelector(selector)?.focus({ preventScroll: true });
  }
  function select(ctx, key) {
    if (!alive(ctx)) return;
    ctx.selected = key;
    paint(ctx);
    focus(ctx, '#scheduleWeek [data-date="' + key + '"]');
  }
  function load(ctx, force) {
    if (ctx.job || (!force && ctx.days !== null)) return;
    ctx.error = '';
    var controller = new AbortController(),
      job = { controller: controller },
      timer;
    ctx.job = job;
    new Promise(function (resolve, reject) {
      controller.signal.addEventListener(
        'abort',
        function () {
          var e = new Error('Schedule refresh timed out. Try again.');
          e.cancelled = !job.timeout;
          reject(e);
        },
        { once: true },
      );
      timer = setTimeout(function () {
        job.timeout = true;
        controller.abort();
      }, 20000);
      Promise.resolve()
        .then(function () {
          if (!same(ctx) || controller.signal.aborted) return;
          return API.get('/me/schedule', {
            signal: controller.signal,
            isCurrent: function () {
              return same(ctx) && ctx.job === job && !controller.signal.aborted;
            },
          });
        })
        .then(resolve, reject);
    })
      .then(function (response) {
        if (same(ctx) && !controller.signal.aborted)
          ctx.days = (Array.isArray(response?.days) ? response.days : []).slice().sort(function (a, b) {
            return String(a.work_date).localeCompare(String(b.work_date));
          });
      })
      .catch(function (error) {
        if (!same(ctx) || error.cancelled) return;
        ctx.error = error.message || 'Schedule could not be loaded.';
        if (error.status === 401 || error.status === 403) ctx.days = null;
      })
      .finally(function () {
        clearTimeout(timer);
        if (ctx.job !== job) return;
        ctx.job = null;
        if (!same(ctx)) {
          depart(ctx);
          return;
        }
        paint(ctx);
        if (ctx.error) focus(ctx, '[role=alert]');
      });
  }
  function paint(ctx) {
    if (!alive(ctx)) return;
    var root = ctx.active.root,
      selected = ctx.selected,
      today = localDateKey(new Date());
    var focused = root.contains(document.activeElement) ? document.activeElement.id : '';
    var day = row(ctx, selected),
      start = mondayOf(parseDay(selected)),
      end = addDays(start, 6);
    var status = !day
      ? 'Not published'
      : day.is_working_day === false
        ? 'Non-working day'
        : hasShift(day)
          ? 'Published shift'
          : 'Shift time unavailable';
    var limits = [mondayOf(new Date())]
      .concat(
        (ctx.days || []).map(function (d) {
          return mondayOf(parseDay(d.work_date));
        }),
      )
      .sort(function (a, b) {
        return a - b;
      });
    var future = (ctx.days || [])
      .filter(function (d) {
        return d.work_date > (selected > today ? selected : today);
      })
      .slice(0, 4);
    root.innerHTML =
      '<header class="m-v2-heading"><p class="m-v2-eyebrow">My work week</p><h1>Schedule</h1><p id="scheduleRange">' +
      mEsc(
        MONTH[start.getMonth()] +
          ' ' +
          start.getDate() +
          ' – ' +
          MONTH[end.getMonth()] +
          ' ' +
          end.getDate() +
          ', ' +
          end.getFullYear(),
      ) +
      '</p></header>' +
      '<div class="m-schedule-week-controls"><button class="m-v2-secondary" type="button" id="schedulePrev" aria-label="Previous week" ' +
      (start <= limits[0] ? 'disabled' : '') +
      '>‹ Previous</button><button class="m-v2-secondary" type="button" id="scheduleToday">This week</button><button class="m-v2-secondary" type="button" id="scheduleNext" aria-label="Next week" ' +
      (start >= limits[limits.length - 1] ? 'disabled' : '') +
      '>Next ›</button></div>' +
      '<div class="m-schedule-week" id="scheduleWeek" role="group" aria-label="Choose a day">' +
      Array.from({ length: 7 }, function (_, i) {
        var d = addDays(start, i),
          key = localDateKey(d);
        return (
          '<button type="button" class="m-schedule-day' +
          (key === selected ? ' is-selected' : '') +
          (key === today ? ' is-today' : '') +
          (row(ctx, key) ? ' has-shift' : '') +
          '" data-date="' +
          key +
          '" aria-label="' +
          mEsc(
            d.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }) +
              (key === today ? ', Today' : '') +
              (row(ctx, key) ? ', roster available' : ', not published'),
          ) +
          '" aria-pressed="' +
          (key === selected) +
          '"><span>' +
          DOW[d.getDay()] +
          '</span><b>' +
          d.getDate() +
          '</b><i aria-hidden="true"></i></button>'
        );
      }).join('') +
      '</div>' +
      (ctx.error
        ? '<p class="m-error m-schedule-feedback" role="alert" tabindex="-1">' +
          mEsc(ctx.error) +
          (ctx.days ? ' Last loaded dates are shown. Refresh before requesting a change.' : '') +
          '</p>'
        : '') +
      (ctx.job
        ? '<p class="m-hint" role="status">' +
          (ctx.days
            ? 'Refreshing schedule… Last loaded dates remain visible.'
            : 'Loading published schedule…') +
          '</p>'
        : '') +
      (ctx.days !== null
        ? '<article class="m-schedule-detail ' +
          (hasShift(day) ? 'has-shift' : 'is-rest') +
          '"><div class="m-schedule-detail-top"><div><p class="m-v2-eyebrow">' +
          (selected === today ? 'Today' : DOW[parseDay(selected).getDay()]) +
          '</p><h2>' +
          shortDate(selected) +
          '</h2></div><span class="m-schedule-status">' +
          status +
          '</span></div><div class="m-schedule-shift"><span class="m-schedule-shift-icon" aria-hidden="true">' +
          (hasShift(day) ? '◷' : '—') +
          '</span><div><b>' +
          mEsc(dayTitle(day)) +
          '</b><span>' +
          mEsc(
            !day
              ? 'Check with HR before making plans.'
              : day.is_working_day === false
                ? 'This roster does not mark a regular workday.'
                : times(day),
          ) +
          '</span></div></div>' +
          (day?.time_in || day?.time_out
            ? '<p class="m-schedule-recorded">Recorded punches · Time in ' +
              mEsc(compactTime(day.time_in)) +
              ' / Time out ' +
              mEsc(compactTime(day.time_out)) +
              '</p>'
            : '') +
          '<div class="m-schedule-meta">' +
          [day?.period_label, day?.location || day?.work_location, day?.department]
            .filter(Boolean)
            .map(function (v) {
              return '<span>' + mEsc(v) + '</span>';
            })
            .join('') +
          '</div></article>'
        : '') +
      '<section class="m-schedule-upcoming" aria-labelledby="upcomingTitle"><div class="m-v2-section-title"><div><p class="m-v2-eyebrow">Plan ahead</p><h2 id="upcomingTitle">Upcoming</h2></div></div><div id="scheduleUpcoming">' +
      (future.length
        ? future
            .map(function (d) {
              var date = parseDay(d.work_date);
              return (
                '<button class="m-schedule-row" type="button" data-date="' +
                mEsc(d.work_date) +
                '"><span class="m-schedule-row-date"><b>' +
                date.getDate() +
                '</b><small>' +
                MONTH[date.getMonth()] +
                '</small></span><span class="m-schedule-row-copy"><b>' +
                DOW[date.getDay()] +
                ' · ' +
                mEsc(dayTitle(d)) +
                '</b><small>' +
                mEsc(d.is_working_day === false ? 'No regular workday' : times(d)) +
                '</small></span><span aria-hidden="true">›</span></button>'
              );
            })
            .join('')
        : '<div class="m-empty m-schedule-empty">No more published dates in this schedule window.</div>') +
      '</div></section>' +
      '<button class="m-v2-primary m-schedule-request" id="scheduleRequest" type="button" ' +
      (eligible(ctx) ? '' : 'disabled') +
      '>' +
      (eligible(ctx) ? 'Request change for ' + shortDate(selected) : 'Request schedule change') +
      '</button><p class="m-schedule-hint">' +
      (eligible(ctx)
        ? 'Opens the existing request form for this date. HR must approve the change.'
        : 'Choose a future published working day to request a change.') +
      '</p>' +
      '<button class="m-v2-secondary m-schedule-refresh" id="scheduleRefresh" type="button" ' +
      (ctx.job ? 'disabled' : '') +
      '>' +
      (ctx.job ? 'Refreshing…' : ctx.error ? 'Retry schedule' : 'Refresh schedule') +
      '</button>';
    root.querySelectorAll('[data-date]').forEach(function (b) {
      b.onclick = function () {
        select(ctx, b.dataset.date);
      };
    });
    root.querySelector('#schedulePrev').onclick = function () {
      select(ctx, localDateKey(addDays(start, -7)));
    };
    root.querySelector('#scheduleNext').onclick = function () {
      select(ctx, localDateKey(addDays(start, 7)));
    };
    root.querySelector('#scheduleToday').onclick = function () {
      select(ctx, today);
    };
    root.querySelector('#scheduleRequest').onclick = function () {
      if (alive(ctx) && eligible(ctx)) MApp.go('requests', { type: 'schedule_change', date: ctx.selected });
    };
    root.querySelector('#scheduleRefresh').onclick = function () {
      if (alive(ctx) && !ctx.job) {
        load(ctx, true);
        paint(ctx);
        focus(ctx, '#scheduleRefresh');
      }
    };
    if (focused) focus(ctx, '#' + focused);
  }
  MApp.route('schedule', function (view) {
    var ctx = context();
    MApp.setTitle('Schedule');
    view.setAttribute('data-figma-node', '46:606');
    view.innerHTML = '<section class="m-v2-page m-schedule-v2"></section>';
    ctx.active = { root: view.firstElementChild, hash: location.hash };
    load(ctx, false);
    paint(ctx);
  });
})();
