/* My payslips — read-only view of this employee's HR Payroll records. */
(function () {
  function titleCase(k) {
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function num(v) {
    var n = Number(v);
    return isFinite(n) && String(v).trim() !== '' ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v;
  }
  var HIDE = { employee_name: 1, dept_position: 1, name: 1, department: 1, position: 1, period: 1 };

  function list(view) {
    MApp.setTitle('Payslips');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/payslips')
      .then(function (rows) {
        view.innerHTML = '';
        if (!rows.length) { view.appendChild(mEl('<div class="m-empty">No payslips yet.</div>')); return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.forEach(function (r) {
          var net = r.data.net_pay != null ? r.data.net_pay
            : (Number(r.data.total_earnings || 0) - Number(r.data.total_deductions || 0));
          var li = mEl(
            '<li class="m-list-row"><div><b>' + mEsc(r.period || r.data.period || r.number) + '</b>' +
            '<span>' + mEsc(r.status || '') + ' · ' + mEsc((r.created_at || '').slice(0, 10)) + '</span></div>' +
            '<div class="m-list-qty">₱' + mEsc(num(net)) + '</div></li>'
          );
          li.onclick = function () { detail(view, r); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function detail(view, r) {
    MApp.setTitle(r.period || (r.data && r.data.period) || 'Payslip');
    view.innerHTML = '';
    var d = r.data || {};
    var net = d.net_pay != null ? d.net_pay : (Number(d.total_earnings || 0) - Number(d.total_deductions || 0));
    view.appendChild(mEl(
      '<div class="m-payslip-top">' +
      '<div class="m-payslip-net">₱' + mEsc(num(net)) + '<span>net pay</span></div>' +
      '<div class="m-hint">' + mEsc(d.employee_name || '') + (d.dept_position ? ' · ' + mEsc(d.dept_position) : '') +
      ' · ' + mEsc(r.number) + '</div></div>'
    ));

    // Slot for the "unrecorded OT" callout — filled in async so it never delays the numbers.
    var alertHost = mEl('<div></div>');
    view.appendChild(alertHost);

    var rows = Object.keys(d)
      .filter(function (k) { return !HIDE[k] && d[k] != null && String(d[k]).trim() !== '' && typeof d[k] !== 'object'; })
      .map(function (k) { return '<li><span>' + mEsc(titleCase(k)) + '</span><b>' + mEsc(num(d[k])) + '</b></li>'; })
      .join('');
    view.appendChild(mEl('<ul class="m-kv">' + rows + '</ul>'));

    var acts = mEl(
      '<div class="m-actions">' +
      '<button class="m-btn m-btn-secondary" data-back>Back</button>' +
      '<button class="m-btn m-btn-secondary" data-file>File a request…</button>' +
      '</div>'
    );
    acts.querySelector('[data-back]').onclick = function () { list(view); };
    // Any other form — OT, half day, undertime, offset, leave, reimbursement, … (the picker).
    acts.querySelector('[data-file]').onclick = function () { MApp.go('requests'); };
    view.appendChild(acts);

    // Unrecorded OT for this payslip's cutoff — worked past the shift with no OT request filed,
    // so it wasn't paid. Match the /me/unrecorded-ot days to this slip by its period label;
    // if nothing matches (e.g. an old slip outside the 45-day window) the callout stays hidden.
    var slipPeriod = String(r.period || d.payroll_period || d.period || '').trim().toLowerCase();
    API.get('/me/unrecorded-ot').then(function (allDays) {
      var mine = (allDays || []).filter(function (x) {
        return !slipPeriod || String(x.period_label || '').trim().toLowerCase() === slipPeriod;
      });
      if (!mine.length) return;
      var totalH = Math.round(mine.reduce(function (s, x) { return s + x.ot_minutes; }, 0) / 60 * 10) / 10;
      var dayList = mine.map(function (x) {
        return x.work_date + ' (' + (Math.round(x.ot_minutes / 60 * 10) / 10) + ' h)';
      }).join(', ');
      var box = mEl(
        '<div class="m-payslip-alert">' +
        '<b>⏱️ Unrecorded overtime</b><br>' +
        'You worked past your shift on ' + mEsc(dayList) + ' — about <b>' + mEsc(String(totalH)) + ' h</b> total — ' +
        'with no Overtime Request filed, so it isn’t on this payslip. File one so HR can review and pay it.' +
        '<button class="m-btn" data-ot>File OT request</button>' +
        '</div>'
      );
      box.querySelector('[data-ot]').onclick = function () {
        MApp.go('requests', { type: 'overtime_request', date: mine[0].work_date });
      };
      alertHost.appendChild(box);
    }).catch(function () { /* non-fatal — the payslip still shows without the callout */ });
  }

  MApp.route('payslips', function (view) { list(view); });
})();
