/* Employee payslips — Figma V2 nodes 46:895 and 46:924.
   Viewing uses the existing employee-scoped endpoint. Download is fail-closed:
   it requires explicit finalized === true and a server-issued download_url. */
(function () {
  var HIDE = {
    employee_name: 1, dept_position: 1, name: 1, department: 1, position: 1,
    period: 1, payroll_period: 1, finalized: 1, finalized_at: 1, download_url: 1, employee_id: 1,
    _calculation_snapshot: 1, cutoff_id: 1,
    // generate-payslips bookkeeping (which statutory deductions were applied), not pay lines
    sss_applied: 1, philhealth_applied: 1, pagibig_applied: 1, withholding_tax_applied: 1
  };
  // Counts, not money — shown as plain numbers, never with a peso sign.
  function isCount(key) { return /^days_|_hours$|^hours_|_days$/.test(key); }

  function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function amount(value) {
    var number = Number(value);
    if (!isFinite(number) || String(value).trim() === '') return String(value == null ? '' : value);
    return '₱' + number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dateText(value) {
    if (!value) return '';
    var raw = String(value);
    var date = new Date(raw.length === 10 ? raw + 'T00:00:00' : raw.replace(' ', 'T') + (raw.indexOf('Z') >= 0 ? '' : 'Z'));
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
    return isFinalized(record) && typeof record.download_url === 'string' && record.download_url.length > 0;
  }

  function netPay(record) {
    var data = record.data || {};
    return data.net_pay != null ? data.net_pay :
      Number(data.total_earnings || data.gross_pay || 0) - Number(data.total_deductions || data.deductions || 0);
  }

  function shell(view, node, heading, subheading, back) {
    view.setAttribute('data-figma-node', node);
    view.innerHTML = '<section class="m-v2-page m-payslip-v2"><header class="m-v2-heading m-payslip-heading">' +
      (back ? '<button class="m-payslip-back" type="button" aria-label="Back">‹</button>' : '') +
      '<div><h1>' + mEsc(heading) + '</h1><p>' + mEsc(subheading) + '</p></div></header><div id="m-payslip-body"></div></section>';
    if (back) view.querySelector('.m-payslip-back').onclick = back;
    return view.querySelector('#m-payslip-body');
  }

  function list(view) {
    MApp.setTitle('Payslips');
    var host = shell(view, '46:895', 'Payslips', 'Available after payroll is finalized', function () { MApp.go('settings'); });
    host.innerHTML =
      '<aside class="m-payslip-rule">Payslips appear here after HR marks them Paid.</aside>' +
      '<div id="m-payslip-list"><div class="m-hint">Loading…</div></div>' +
      '<p class="m-payslip-access-note">Open Profile → Pay & documents anytime.</p>';
    var rowsHost = host.querySelector('#m-payslip-list');

    API.get('/me/payslips').then(function (rows) {
      if (!rows || !rows.length) {
        rowsHost.innerHTML = '<div class="m-empty">No paid payslips are available yet.</div>';
        return;
      }
      rowsHost.innerHTML = '';
      rows.forEach(function (record) {
        var finalized = isFinalized(record);
        var downloadable = canDownload(record);
        var description = finalized
          ? 'Finalized' + (record.finalized_at ? ' · Released ' + dateText(record.finalized_at) : '')
          : 'Payroll in progress · Amounts may still change';
        var state = downloadable ? 'Ready' : (finalized ? 'Final' : 'Wait');
        var button = mEl('<button class="m-payslip-row' + (downloadable ? ' ready' : '') + '" type="button">' +
          '<span><b>' + mEsc(periodText(record)) + '</b><small>' + mEsc(description) + '</small></span>' +
          '<em class="' + (finalized ? 'final' : 'wait') + '">' + state + '</em><i aria-hidden="true">›</i></button>');
        button.onclick = function () { detail(view, record); };
        rowsHost.appendChild(button);
      });
    }).catch(function (error) {
      rowsHost.innerHTML = '<div class="m-error">' + mEsc(error.message) + '</div><button class="m-v2-secondary" id="m-pay-retry" type="button">Try again</button>';
      rowsHost.querySelector('#m-pay-retry').onclick = function () { list(view); };
    });
  }

  function preferredRows(data) {
    var keys = ['basic_pay', 'overtime', 'overtime_pay', 'allowances', 'total_allowances', 'deductions', 'total_deductions', 'gross_pay', 'total_earnings'];
    var used = {};
    var rows = [];
    keys.forEach(function (key) {
      if (data[key] == null || data[key] === '' || used[key]) return;
      used[key] = true;
      rows.push({ key: key, value: data[key] });
    });
    Object.keys(data).forEach(function (key) {
      if (used[key] || HIDE[key] || data[key] == null || String(data[key]).trim() === '' || typeof data[key] === 'object') return;
      rows.push({ key: key, value: data[key] });
    });
    return rows;
  }

  function detail(view, record) {
    MApp.setTitle('Payslip detail');
    var data = record.data || {};
    var finalized = isFinalized(record);
    var downloadable = canDownload(record);
    var host = shell(view, '46:924', 'Payslip detail', periodText(record), function () { list(view); });
    host.innerHTML =
      '<section class="m-payslip-net-card"><small>Net pay</small><strong>' + mEsc(amount(netPay(record))) + '</strong>' +
        '<span>' + (finalized ? 'Finalized' + (record.finalized_at ? ' · ' + mEsc(dateText(record.finalized_at)) : '') : 'Preview · not finalized') + '</span></section>' +
      '<div class="m-payslip-lines">' + preferredRows(data).map(function (row) {
        var numeric = isFinite(Number(row.value)) && String(row.value).trim() !== '';
        var shown = !numeric ? String(row.value) : isCount(row.key) ? String(Number(row.value)) : amount(row.value);
        return '<div><span>' + mEsc(titleCase(row.key)) + '</span><b>' + mEsc(shown) + '</b></div>';
      }).join('') + '</div>' +
      '<button class="m-v2-secondary m-payslip-time-button" type="button">View timekeeping records</button>' +
      '<div id="m-payslip-ot-alert"></div>' +
      (downloadable
        ? '<button class="m-v2-primary m-payslip-download" id="m-pay-download" type="button">↓ Download PDF</button>' +
          '<p class="m-payslip-download-note">Download is enabled because the payroll record is finalized and released.</p>'
        : '<aside class="m-payslip-wait"><b>' + (finalized ? 'PDF not released yet' : 'Payroll is still being finalized') + '</b>' +
          '<span>' + (finalized ? 'HR has finalized this record, but no authenticated PDF is available yet.' : 'You can review this preview, but it may change. Download will appear only after finalization.') + '</span></aside>') +
      '<button class="m-v2-secondary m-payslip-request" type="button">File a payroll request</button>';

    var download = host.querySelector('#m-pay-download');
    if (download) download.onclick = function () {
      download.disabled = true;
      download.textContent = 'Preparing download…';
      API.download(record.download_url, 'Payslip-' + String(periodText(record)).replace(/[^a-z0-9]+/gi, '-') + '.pdf')
        .then(function () { download.textContent = '✓ Downloaded'; })
        .catch(function (error) {
          mToast(error.message || 'Download failed', 'err');
          download.disabled = false;
          download.textContent = '↓ Download PDF';
        });
    };
    host.querySelector('.m-payslip-request').onclick = function () { MApp.go('requests'); };
    host.querySelector('.m-payslip-time-button').onclick = function () { openTimekeeping(record); };

    var slipPeriod = String(record.period || data.payroll_period || data.period || '').trim().toLowerCase();
    API.get('/me/unrecorded-ot').then(function (allDays) {
      var mine = (allDays || []).filter(function (day) {
        return !slipPeriod || String(day.period_label || '').trim().toLowerCase() === slipPeriod;
      });
      if (!mine.length) return;
      var hours = Math.round(mine.reduce(function (sum, day) { return sum + day.ot_minutes; }, 0) / 60 * 10) / 10;
      var alertHost = host.querySelector('#m-payslip-ot-alert');
      alertHost.innerHTML = '<aside class="m-payslip-ot"><b>Unrecorded overtime</b><span>' + hours +
        ' hour(s) may need HR review before they can be included.</span><button type="button">File OT request</button></aside>';
      alertHost.querySelector('button').onclick = function () {
        MApp.go('requests', { type: 'overtime_request', date: mine[0].work_date });
      };
    }).catch(function () {});
  }

  function openTimekeeping(record) {
    var shade = mEl('<div class="m-payslip-time-shade"><aside class="m-payslip-time-panel" role="dialog" aria-modal="true" aria-label="Timekeeping records"><header><div><h2>Timekeeping records</h2><small>' + mEsc(periodText(record)) + '</small></div><button type="button" aria-label="Close timekeeping records">×</button></header><div class="m-payslip-time-content"><p class="m-hint">Loading…</p></div></aside></div>');
    document.body.appendChild(shade);
    var close = function () { shade.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', close); };
    var onKey = function (event) { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close);
    shade.onclick = function (event) { if (event.target === shade) close(); };
    shade.querySelector('header button').onclick = close;
    shade.querySelector('header button').focus();
    var content = shade.querySelector('.m-payslip-time-content');
    API.get('/me/payslips/' + record.id + '/timekeeping').then(function (result) {
      if (!shade.isConnected) return;
      var days = result.days || [];
      content.innerHTML = (result.notice ? '<p class="m-payslip-time-notice">' + mEsc(result.notice) + '</p>' : '') +
        (days.length ? days.map(function (day) {
          var fields = [['Time in', day.time_in], ['Lunch out', day.lunch_out], ['Lunch in', day.lunch_in], ['Time out', day.time_out]];
          var figures = [['Late', day.late_minutes, 'min'], ['Undertime', day.undertime_minutes, 'min'], ['OT', day.ot_hours, 'hr']].filter(function (row) { return Number(row[1]) > 0; });
          return '<article class="m-payslip-time-day"><h3>' + mEsc(dateText(day.work_date)) + '</h3><div class="m-payslip-time-grid">' + fields.map(function (field) {
            return '<div><small>' + field[0] + '</small><b>' + mEsc(field[1] || '—') + '</b></div>';
          }).join('') + '</div>' + (figures.length ? '<p>' + figures.map(function (row) { return mEsc(row[0] + ': ' + row[1] + ' ' + row[2]); }).join(' · ') + '</p>' : '') + '</article>';
        }).join('') : '<div class="m-empty">No timekeeping rows are available for this cutoff.</div>');
    }).catch(function (error) { if (shade.isConnected) content.innerHTML = '<div class="m-error">' + mEsc(error.message || 'Could not load timekeeping records') + '</div>'; });
  }

  MApp.route('payslips', function (view) { list(view); });
})();
