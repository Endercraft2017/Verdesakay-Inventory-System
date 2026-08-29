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
    var rows = Object.keys(d)
      .filter(function (k) { return !HIDE[k] && d[k] != null && String(d[k]).trim() !== '' && typeof d[k] !== 'object'; })
      .map(function (k) { return '<li><span>' + mEsc(titleCase(k)) + '</span><b>' + mEsc(num(d[k])) + '</b></li>'; })
      .join('');
    view.appendChild(mEl('<ul class="m-kv">' + rows + '</ul>'));
    var back = mEl('<div class="m-actions"><button class="m-btn m-btn-secondary">Back</button></div>');
    back.querySelector('button').onclick = function () { list(view); };
    view.appendChild(back);
  }

  MApp.route('payslips', function (view) { list(view); });
})();
