/* Employee payslips — Figma V2 nodes 46:895 and 46:924.
   Viewing uses the existing employee-scoped endpoint. Download is fail-closed:
   it requires explicit finalized === true and a server-issued download_url. */
(function () {
  var HIDE = {
    employee_name: 1,
    dept_position: 1,
    name: 1,
    department: 1,
    position: 1,
    period: 1,
    payroll_period: 1,
    finalized: 1,
    finalized_at: 1,
    download_url: 1,
    employee_id: 1,
    _calculation_snapshot: 1,
    cutoff_id: 1,
    // generate-payslips bookkeeping (which statutory deductions were applied), not pay lines
    sss_applied: 1,
    philhealth_applied: 1,
    pagibig_applied: 1,
    withholding_tax_applied: 1,
  };
  // Counts, not money — shown as plain numbers, never with a peso sign.
  function isCount(key) {
    return /^days_|_hours$|^hours_|_days$/.test(key);
  }

  function titleCase(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function amount(value) {
    if (!numeric(value)) return 'Unavailable';
    var number = Number(value);
    if (!isFinite(number) || String(value).trim() === '') return String(value == null ? '' : value);
    return '₱' + number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dateText(value) {
    if (!value) return '';
    var raw = String(value);
    var date = new Date(
      raw.length === 10 ? raw + 'T00:00:00' : raw.replace(' ', 'T') + (raw.indexOf('Z') >= 0 ? '' : 'Z'),
    );
    if (isNaN(date.getTime())) return raw;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function periodText(record) {
    var data = record.data || {};
    return record.period || data.payroll_period || data.period || record.number || 'Payroll period';
  }

  function isFinalized(record) {
    return record && record.finalized === true;
  }

  function canDownload(record) {
    return (
      isFinalized(record) && typeof record.download_url === 'string' && record.download_url.trim().length > 0
    );
  }

  function netPay(record) {
    return record.data?.net_pay;
  }
  function numeric(value) {
    return (
      value != null && typeof value !== 'boolean' && String(value).trim() !== '' && isFinite(Number(value))
    );
  }
  function preferredRows(data) {
    var keys = [
      'basic_pay',
      'overtime',
      'overtime_pay',
      'allowances',
      'total_allowances',
      'deductions',
      'total_deductions',
      'gross_pay',
      'total_earnings',
    ];
    var used = {};
    var rows = [];
    keys.forEach(function (key) {
      if (data[key] == null || data[key] === '' || used[key]) return;
      used[key] = true;
      rows.push({ key: key, value: data[key] });
    });
    Object.keys(data).forEach(function (key) {
      if (
        key === 'net_pay' ||
        used[key] ||
        HIDE[key] ||
        data[key] == null ||
        String(data[key]).trim() === '' ||
        typeof data[key] === 'object'
      )
        return;
      rows.push({ key: key, value: data[key] });
    });
    return rows;
  }

  // Private memory only; a new sign-in/server/employee never reuses the old data.
  var session = null;
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
  function cancel(ctx, key) {
    var job = ctx.jobs[key];
    if (job) {
      delete ctx.jobs[key];
      job.controller.abort();
    }
  }
  function stopPDF(ctx) {
    if (ctx.pdf) {
      var pdf = ctx.pdf;
      ctx.pdf = null;
      pdf.controller.abort();
    }
  }
  function depart(ctx) {
    closeTimekeeping(ctx, false);
    stopPDF(ctx);
    if (!same(ctx)) {
      Object.keys(ctx.jobs).forEach(function (key) {
        cancel(ctx, key);
      });
      ctx.values = {};
      if (ctx.active?.root.isConnected) ctx.active.root.textContent = '';
    }
    ctx.active = null;
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
        values: {},
        errors: {},
        jobs: {},
        pdf: null,
        pdfNote: '',
        pdfError: '',
        modal: null,
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
  function errorHTML(text) {
    return text
      ? '<p class="m-error m-payslip-feedback" role="alert" tabindex="-1">' + mEsc(text) + '</p>'
      : '';
  }
  function statusHTML(text) {
    return '<p class="m-payslip-feedback" role="status">' + mEsc(text) + '</p>';
  }
  function focus(ctx, selector) {
    if (alive(ctx) && !ctx.modal) ctx.active.root.querySelector(selector)?.focus({ preventScroll: true });
  }
  function recordFor(ctx) {
    return (ctx.values.rows || []).find(function (r) {
      return String(r.id) === String(ctx.active?.id);
    });
  }
  function read(ctx, key, path, force) {
    if (ctx.jobs[key] || (!force && ctx.values[key] !== undefined)) return;
    ctx.errors[key] = '';
    var controller = new AbortController(),
      job = { controller: controller },
      timer;
    ctx.jobs[key] = job;
    new Promise(function (resolve, reject) {
      controller.signal.addEventListener(
        'abort',
        function () {
          var e = new Error('The connection timed out. Try again.');
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
          return API.get(path, {
            signal: controller.signal,
            isCurrent: function () {
              return same(ctx) && ctx.jobs[key] === job && !controller.signal.aborted;
            },
          });
        })
        .then(resolve, reject);
    })
      .then(function (data) {
        if (same(ctx) && ctx.jobs[key] === job && !controller.signal.aborted) ctx.values[key] = data;
      })
      .catch(function (e) {
        if (!same(ctx) || ctx.jobs[key] !== job || e.cancelled) return;
        ctx.errors[key] = e.message || 'Could not load this record.';
        if ([401, 403, 404].indexOf(e.status) >= 0) {
          delete ctx.values[key];
          if (key === 'rows') closeTimekeeping(ctx, false);
        }
      })
      .finally(function () {
        clearTimeout(timer);
        if (ctx.jobs[key] !== job) return;
        delete ctx.jobs[key];
        if (!same(ctx)) {
          depart(ctx);
          return;
        }
        if (key.indexOf('time:') === 0) {
          if (ctx.modal?.key === key) drawTimekeeping(ctx);
        } else paint(ctx);
      });
  }
  function activate(ctx, view, kind, id) {
    closeTimekeeping(ctx, false);
    stopPDF(ctx);
    ctx.pdfNote = '';
    ctx.pdfError = '';
    view.setAttribute('data-figma-node', kind === 'list' ? '46:895' : '46:924');
    view.innerHTML = '<section class="m-v2-page m-payslip-v2"></section>';
    ctx.active = { view: view, root: view.firstElementChild, hash: location.hash, kind: kind, id: id };
  }
  function showList(ctx, view, backId) {
    activate(ctx, view, 'list');
    MApp.setTitle('Payslips');
    read(ctx, 'rows', '/me/payslips', false);
    paint(ctx);
    if (backId != null) focus(ctx, '[data-slip-id="' + backId + '"]');
  }
  function showDetail(ctx, record) {
    if (!alive(ctx)) return;
    var view = ctx.active.view;
    activate(ctx, view, 'detail', record.id);
    MApp.setTitle('Payslip detail');
    if (periodLabel(record)) read(ctx, 'ot', '/me/unrecorded-ot', false);
    paint(ctx);
    focus(ctx, '.m-payslip-back');
  }
  function heading(title, subtitle, label) {
    return (
      '<header class="m-v2-heading m-payslip-heading"><button class="m-payslip-back" type="button" aria-label="' +
      label +
      '">‹</button><div><h1>' +
      mEsc(title) +
      '</h1><p>' +
      mEsc(subtitle) +
      '</p></div></header>'
    );
  }
  function paint(ctx) {
    if (!alive(ctx)) return;
    var root = ctx.active.root,
      el = document.activeElement;
    var focused = root.contains(el)
      ? el.id
        ? '#' + el.id
        : el.dataset.slipId
          ? '[data-slip-id="' + el.dataset.slipId + '"]'
          : el.matches('.m-payslip-back')
            ? '.m-payslip-back'
            : null
      : null;
    root.setAttribute('data-figma-node', ctx.active.kind === 'list' ? '46:895' : '46:924');
    if (ctx.active.kind === 'list') drawList(ctx);
    else drawDetail(ctx);
    if (focused) focus(ctx, focused);
  }
  function refreshRows(ctx) {
    if (!alive(ctx) || ctx.jobs.rows || ctx.pdf) return;
    read(ctx, 'rows', '/me/payslips', true);
    paint(ctx);
  }
  function drawList(ctx) {
    var root = ctx.active.root,
      rows = ctx.values.rows;
    root.classList.remove('is-draft');
    root.innerHTML =
      heading('Payslips', 'Review your payroll and timekeeping', 'Back to Profile') +
      '<aside class="m-payslip-rule">Draft payslips are previews and may change. PDF download becomes available after HR marks a payslip Paid.</aside>' +
      errorHTML(ctx.errors.rows) +
      (ctx.errors.rows && rows ? statusHTML('Your last loaded list is still here.') : '') +
      (ctx.jobs.rows
        ? statusHTML(rows ? 'Refreshing payslips… Last loaded records remain visible.' : 'Loading payslips…')
        : '') +
      '<div id="m-payslip-list">' +
      (rows?.length
        ? rows
            .map(function (r) {
              return (
                '<button class="m-payslip-row' +
                (canDownload(r) ? ' ready' : '') +
                '" type="button" data-slip-id="' +
                mEsc(r.id) +
                '"><span><b>' +
                mEsc(periodText(r)) +
                '</b><small>' +
                mEsc(
                  isFinalized(r)
                    ? 'Finalized' + (r.finalized_at ? ' · Released ' + dateText(r.finalized_at) : '')
                    : 'Draft preview · amounts may change',
                ) +
                '</small></span><em class="' +
                (isFinalized(r) ? 'final' : 'wait') +
                '">' +
                (isFinalized(r) ? 'Paid' : 'Draft') +
                '</em><i aria-hidden="true">›</i></button>'
              );
            })
            .join('')
        : rows
          ? '<div class="m-empty" role="status">No payslips are available yet.</div>'
          : '') +
      '</div>' +
      '<button class="m-v2-secondary m-payslip-refresh" id="m-pay-refresh" type="button" ' +
      (ctx.jobs.rows ? 'disabled' : '') +
      '>' +
      (ctx.jobs.rows ? 'Refreshing…' : ctx.errors.rows ? 'Retry payslips' : 'Refresh payslips') +
      '</button><p class="m-payslip-access-note">Open Profile → Pay &amp; documents anytime.</p>';
    root.querySelector('.m-payslip-back').onclick = function () {
      if (alive(ctx)) MApp.go('settings');
    };
    root.querySelectorAll('[data-slip-id]').forEach(function (b) {
      b.onclick = function () {
        if (alive(ctx)) {
          var r = ctx.values.rows.find(function (r) {
            return String(r.id) === b.dataset.slipId;
          });
          if (r) showDetail(ctx, r);
        }
      };
    });
    root.querySelector('#m-pay-refresh').onclick = function () {
      refreshRows(ctx);
    };
  }
  function periodLabel(r) {
    return String(r.period || r.data?.payroll_period || r.data?.period || '')
      .trim()
      .toLowerCase();
  }
  function overtimeHTML(ctx, r) {
    if (!periodLabel(r))
      return statusHTML('This payslip has no period label. Overtime could not be matched to it.');
    if (ctx.jobs.ot) return statusHTML('Checking this payslip’s period…');
    if (ctx.errors.ot)
      return (
        errorHTML('Overtime could not be checked. Payslip figures are unchanged. ' + ctx.errors.ot) +
        '<button class="m-v2-secondary" id="m-pay-ot-retry" type="button">Retry overtime check</button>'
      );
    var mine = (ctx.values.ot || []).filter(function (d) {
      return (
        String(d.period_label || '')
          .trim()
          .toLowerCase() === periodLabel(r)
      );
    });
    if (!mine.length)
      return '<p class="m-payslip-hint">No unrecorded overtime was returned for this payslip’s period.</p>';
    var hours =
      Math.round(
        mine.reduce(function (sum, d) {
          return sum + (Number(d.ot_minutes) || 0);
        }, 0) / 6,
      ) / 10;
    return (
      '<aside class="m-payslip-ot"><b>Unrecorded overtime · ' +
      mEsc(periodText(r)) +
      '</b><span>' +
      hours +
      ' hour(s) may need HR review. This does not change the payslip figures above.</span><button type="button" data-ot-date="' +
      mEsc(mine[0].work_date) +
      '">File OT request</button></aside>'
    );
  }
  function drawDetail(ctx) {
    var root = ctx.active.root,
      r = recordFor(ctx),
      data = r?.data || {};
    if (!r) {
      root.classList.remove('is-draft');
      root.innerHTML =
        heading('Payslip detail', 'Record unavailable', 'Back to payslips') +
        errorHTML(
          ctx.errors.rows || 'This payslip is not in your latest list. Return to payslips and refresh.',
        );
      root.querySelector('.m-payslip-back').onclick = function () {
        showList(ctx, ctx.active.view);
      };
      return;
    }
    var finalized = isFinalized(r),
      downloadable = canDownload(r);
    root.classList.toggle('is-draft', !finalized);
    root.innerHTML =
      heading('Payslip detail', periodText(r), 'Back to payslips') +
      (!finalized
        ? '<div class="m-payslip-draft-banner" role="status"><b>DRAFT · NOT FINALIZED</b><span>Payroll can still change before payment. This preview cannot be downloaded.</span></div>'
        : '') +
      '<section class="m-payslip-net-card"><small>' +
      (finalized ? 'Net pay' : 'Estimated net pay') +
      '</small><strong>' +
      mEsc(amount(netPay(r))) +
      '</strong><span>' +
      (finalized
        ? 'Paid' + (r.finalized_at ? ' · ' + mEsc(dateText(r.finalized_at)) : '')
        : 'Draft · not finalized') +
      '</span></section>' +
      (!numeric(netPay(r))
        ? statusHTML('Net pay has not been provided. Missing amounts are not shown as zero.')
        : '') +
      '<div class="m-payslip-lines">' +
      preferredRows(data)
        .map(function (row) {
          var shown = !numeric(row.value)
            ? String(row.value)
            : isCount(row.key)
              ? String(Number(row.value))
              : amount(row.value);
          return '<div><span>' + mEsc(titleCase(row.key)) + '</span><b>' + mEsc(shown) + '</b></div>';
        })
        .join('') +
      '</div>' +
      errorHTML(ctx.errors.rows) +
      (ctx.errors.rows
        ? statusHTML('Last loaded figures remain visible.')
        : ctx.jobs.rows
          ? statusHTML('Refreshing payslip… Last loaded figures remain visible.')
          : '') +
      '<button class="m-v2-secondary m-payslip-time-button" id="m-pay-time" type="button">View timekeeping records</button>' +
      '<section class="m-payslip-ot-followup" aria-label="Overtime follow up"><h2>Overtime follow up</h2><div id="m-payslip-ot-alert">' +
      overtimeHTML(ctx, r) +
      '</div></section>' +
      (downloadable
        ? '<button class="m-v2-primary m-payslip-download" id="m-pay-download" type="button" ' +
          (ctx.pdf || ctx.jobs.rows ? 'disabled' : '') +
          '>' +
          (ctx.pdf ? 'Preparing PDF…' : ctx.pdfNote ? '↓ Download PDF again' : '↓ Download PDF') +
          '</button><p class="m-payslip-download-note">Available for this paid record. Check your browser’s downloads after preparation.</p>'
        : '<aside class="m-payslip-wait"><b>' +
          (finalized ? 'PDF not released yet' : 'Payroll is still being finalized') +
          '</b><span>' +
          (finalized
            ? 'HR has finalized this record, but no authenticated PDF is available yet.'
            : 'You can review this preview and its timekeeping. Download will appear only after HR marks it Paid.') +
          '</span></aside>') +
      errorHTML(ctx.pdfError) +
      (ctx.pdfNote ? statusHTML(ctx.pdfNote) : '') +
      '<button class="m-v2-secondary m-payslip-refresh" id="m-pay-refresh" type="button" ' +
      (ctx.jobs.rows || ctx.pdf ? 'disabled' : '') +
      '>' +
      (ctx.jobs.rows ? 'Refreshing…' : 'Refresh payslip') +
      '</button><button class="m-v2-secondary m-payslip-request" type="button">File a payroll request</button>';
    root.querySelector('.m-payslip-back').onclick = function () {
      if (alive(ctx)) showList(ctx, ctx.active.view, r.id);
    };
    root.querySelector('#m-pay-refresh').onclick = function () {
      refreshRows(ctx);
    };
    root.querySelector('#m-pay-download')?.addEventListener('click', function () {
      download(ctx);
    });
    root.querySelector('#m-pay-time').onclick = function () {
      openTimekeeping(ctx);
    };
    root.querySelector('#m-pay-ot-retry')?.addEventListener('click', function () {
      if (alive(ctx) && !ctx.jobs.ot) {
        read(ctx, 'ot', '/me/unrecorded-ot', true);
        paint(ctx);
      }
    });
    root.querySelector('[data-ot-date]')?.addEventListener('click', function (e) {
      if (alive(ctx)) MApp.go('requests', { type: 'overtime_request', date: e.currentTarget.dataset.otDate });
    });
    root.querySelector('.m-payslip-request').onclick = function () {
      if (alive(ctx)) MApp.go('requests');
    };
  }
  function download(ctx) {
    var r = recordFor(ctx);
    if (!alive(ctx) || ctx.pdf || ctx.jobs.rows || !canDownload(r)) return;
    var pdf = (ctx.pdf = { active: ctx.active, controller: new AbortController() }),
      timer;
    ctx.pdfError = '';
    ctx.pdfNote = '';
    function current() {
      return (
        ctx.pdf === pdf &&
        alive(ctx) &&
        ctx.active === pdf.active &&
        !pdf.controller.signal.aborted &&
        canDownload(recordFor(ctx)) &&
        recordFor(ctx).download_url === r.download_url
      );
    }
    timer = setTimeout(function () {
      if (ctx.pdf === pdf) {
        ctx.pdf = null;
        pdf.controller.abort();
        ctx.pdfError = 'PDF preparation timed out. Retry or refresh this payslip.';
        paint(ctx);
      }
    }, 60000);
    Promise.resolve()
      .then(function () {
        if (!current()) return;
        return API.download(
          r.download_url,
          'Payslip-' + String(periodText(r)).replace(/[^a-z0-9]+/gi, '-') + '.pdf',
          { signal: pdf.controller.signal, isCurrent: current },
        );
      })
      .then(function () {
        if (current())
          ctx.pdfNote = 'PDF prepared. Check your browser’s downloads. You can download it again.';
      })
      .catch(function (e) {
        if (current())
          ctx.pdfError = 'The PDF could not be prepared. Retry or refresh this payslip. ' + (e.message || '');
      })
      .finally(function () {
        clearTimeout(timer);
        if (ctx.pdf !== pdf) return;
        ctx.pdf = null;
        if (!same(ctx)) {
          depart(ctx);
          return;
        }
        paint(ctx);
        focus(ctx, ctx.pdfError ? '[role=alert]' : '#m-pay-download');
      });
    paint(ctx);
  }
  function closeTimekeeping(ctx, restore) {
    var modal = ctx.modal;
    if (!modal) return;
    ctx.modal = null;
    cancel(ctx, modal.key);
    modal.shade.remove();
    document.removeEventListener('keydown', modal.onKey);
    document.removeEventListener('focusin', modal.onFocus);
    modal.inert.forEach(function (item) {
      item.el.inert = item.value;
    });
    document.body.style.overflow = modal.overflow;
    if (restore && alive(ctx)) focus(ctx, '#m-pay-time');
  }
  function openTimekeeping(ctx) {
    if (!alive(ctx)) return;
    if (ctx.modal) {
      ctx.modal.shade.querySelector('header button').focus();
      return;
    }
    var r = recordFor(ctx);
    if (!r) return;
    var shade = mEl(
      '<div class="m-payslip-time-shade"><aside class="m-payslip-time-panel" role="dialog" aria-modal="true" aria-label="Timekeeping records"><header><div><h2>Timekeeping records</h2><small>' +
        mEsc(periodText(r)) +
        '</small></div><button type="button" aria-label="Close timekeeping records">×</button></header><div class="m-payslip-time-content"></div></aside></div>',
    );
    var modal = (ctx.modal = {
      shade: shade,
      key: 'time:' + r.id,
      active: ctx.active,
      inert: [],
      overflow: document.body.style.overflow,
    });
    document.body.appendChild(shade);
    Array.from(document.body.children).forEach(function (el) {
      if (el !== shade && el.tagName !== 'SCRIPT') {
        modal.inert.push({ el: el, value: el.inert });
        el.inert = true;
      }
    });
    document.body.style.overflow = 'hidden';
    shade.querySelector('.m-payslip-time-panel').classList.toggle('is-draft', !isFinalized(r));
    function close() {
      closeTimekeeping(ctx, true);
    }
    modal.onKey = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        var items = Array.from(shade.querySelectorAll('button:not([disabled]),[href],[tabindex="0"]')),
          first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !shade.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || !shade.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    modal.onFocus = function (e) {
      if (ctx.modal === modal && !shade.contains(e.target)) shade.querySelector('header button').focus();
    };
    document.addEventListener('keydown', modal.onKey);
    document.addEventListener('focusin', modal.onFocus);
    shade.onclick = function (e) {
      if (e.target === shade) close();
    };
    shade.querySelector('header button').onclick = close;
    delete ctx.values[modal.key];
    read(ctx, modal.key, '/me/payslips/' + r.id + '/timekeeping', true);
    drawTimekeeping(ctx);
    shade.querySelector('header button').focus();
  }
  function drawTimekeeping(ctx) {
    var modal = ctx.modal;
    if (!modal) return;
    if (!alive(ctx) || modal.active !== ctx.active) {
      closeTimekeeping(ctx, false);
      return;
    }
    var content = modal.shade.querySelector('.m-payslip-time-content'),
      key = modal.key,
      result = ctx.values[key];
    if (ctx.jobs[key]) {
      content.innerHTML = statusHTML('Loading timekeeping records…');
      return;
    }
    if (ctx.errors[key]) {
      content.innerHTML =
        errorHTML(ctx.errors[key]) +
        '<button class="m-v2-secondary" type="button" id="m-pay-time-retry">Retry timekeeping</button>';
      content.querySelector('button').onclick = function () {
        if (alive(ctx) && ctx.modal === modal) {
          read(ctx, key, '/me/payslips/' + ctx.active.id + '/timekeeping', true);
          drawTimekeeping(ctx);
          modal.shade.querySelector('header button').focus();
        }
      };
      return;
    }
    if (!result) return;
    modal.shade
      .querySelector('.m-payslip-time-panel')
      .classList.toggle('is-draft', result.finalized !== true);
    var source =
      result.source === 'saved_calculation'
        ? 'Saved payroll calculation'
        : result.source === 'attendance_record'
          ? 'Current recorded punches'
          : 'Timekeeping detail';
    content.innerHTML =
      (result.finalized !== true
        ? '<div class="m-payslip-draft-banner" role="status"><b>DRAFT · NOT FINALIZED</b><span>These time records and payroll figures may change before payment.</span></div>'
        : '') +
      statusHTML(source) +
      (result.notice ? '<p class="m-payslip-time-notice">' + mEsc(result.notice) + '</p>' : '') +
      (result.days?.length
        ? result.days
            .map(function (day) {
              var fields = [
                  ['Time in', day.time_in],
                  ['Lunch out', day.lunch_out],
                  ['Lunch in', day.lunch_in],
                  ['Time out', day.time_out],
                ],
                figures = [
                  ['Late', day.late_minutes, 'min'],
                  ['Undertime', day.undertime_minutes, 'min'],
                  ['OT', day.ot_hours, 'hr'],
                ].filter(function (row) {
                  return Number(row[1]) > 0;
                });
              return (
                '<article class="m-payslip-time-day"><h3>' +
                mEsc(dateText(day.work_date)) +
                '</h3><div class="m-payslip-time-grid">' +
                fields
                  .map(function (f) {
                    return '<div><small>' + f[0] + '</small><b>' + mEsc(f[1] || '—') + '</b></div>';
                  })
                  .join('') +
                '</div>' +
                (figures.length
                  ? '<p>' +
                    figures
                      .map(function (row) {
                        return mEsc(row[0] + ': ' + row[1] + ' ' + row[2]);
                      })
                      .join(' · ') +
                    '</p>'
                  : '') +
                '</article>'
              );
            })
            .join('')
        : '<div class="m-empty" role="status">No timekeeping rows are available for this cutoff.</div>');
  }
  MApp.route('payslips', function (view) {
    showList(context(), view);
  });
})();
