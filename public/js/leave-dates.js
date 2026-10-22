/* Shared inclusive-range / separate-date picker for HR, desktop and mobile requests. */
(function (root) {
  'use strict';
  function valid(date) { var d = new Date(date + 'T00:00:00Z'); return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date; }
  function parse(data) {
    if (data && data.leave_dates) return Array.from(new Set(String(data.leave_dates).split(/[\s,;]+/).filter(valid))).sort();
    var from = data && data.date_from, to = data && data.date_to, dates = [];
    if (!valid(from || '') || !valid(to || '') || to < from) return dates;
    var cur = new Date(from + 'T00:00:00Z');
    while (cur.toISOString().slice(0, 10) <= to && dates.length < 366) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
    return dates;
  }
  function markup() {
    return '<fieldset class="leave-date-picker" style="min-width:0;width:100%;border:1px solid var(--border,#dce6df);border-radius:14px;padding:12px;margin:10px 0">' +
      '<legend style="padding:0 6px;font-weight:600">Inclusive leave dates *</legend>' +
      '<p style="font-size:12px;margin:0 0 10px">Add a date range, separate dates, or both. Only scheduled working days of paid leave consume the balance.</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:end">' +
      '<label style="flex:1;min-width:120px">From<input type="date" data-leave-from style="width:100%"></label>' +
      '<label style="flex:1;min-width:120px">Through<input type="date" data-leave-to style="width:100%"></label>' +
      '<button type="button" class="btn secondary small m-v2-secondary" data-leave-range style="width:auto">Add range</button></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:10px"><label style="flex:1;min-width:160px">Separate date<input type="date" data-leave-single style="width:100%"></label>' +
      '<button type="button" class="btn secondary small m-v2-secondary" data-leave-add style="width:auto">Add date</button></div>' +
      '<div data-leave-selected style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;max-height:150px;overflow:auto"></div>' +
      '<div data-leave-summary role="status" style="font-size:12px;margin-top:10px"></div>' +
      '<div data-leave-error role="alert" style="color:var(--danger,#c0392b);font-size:12px;margin-top:6px"></div></fieldset>';
  }
  function mount(host, options) {
    options = options || {};
    var picker = host.querySelector('.leave-date-picker'), dates = parse(options.data || {}), seq = 0, current = Promise.resolve();
    var esc = function (text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); };
    var error = picker.querySelector('[data-leave-error]'), summary = picker.querySelector('[data-leave-summary]');
    function value() { return { leave_dates: dates.join(','), date_from: dates[0] || '', date_to: dates[dates.length - 1] || '' }; }
    function render() {
      error.textContent = '';
      picker.querySelector('[data-leave-selected]').innerHTML = dates.map(function (d) { return '<button type="button" class="btn secondary small m-v2-secondary" data-leave-remove="' + d + '" aria-label="Remove ' + d + '" style="padding:5px 8px;width:auto">' + d + ' ×</button>'; }).join('');
      picker.querySelectorAll('[data-leave-remove]').forEach(function (button) { button.onclick = function () { dates = dates.filter(function (d) { return d !== button.dataset.leaveRemove; }); render(); }; });
      if (options.onChange) options.onChange(value());
      var stamp = ++seq;
      summary.textContent = dates.length ? dates.length + ' selected date(s). Calculating scheduled working days…' : 'No dates selected yet.';
      if (dates.length && options.preview) current = Promise.resolve(options.preview(value())).then(function (result) {
        if (stamp !== seq) return;
        summary.innerHTML = '<strong>' + result.days + ' scheduled working day(s)</strong> · ' + dates.length + ' selected date(s)' +
          (result.remaining == null ? '' : ' · ' + result.remaining + ' leave day(s) available') +
          (result.warnings && result.warnings.length ? '<ul style="margin:6px 0;padding-left:18px">' + result.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '');
      }).catch(function (e) { if (stamp === seq) { summary.textContent = dates.length + ' selected date(s).'; error.textContent = e.message || 'Could not calculate the leave-day count.'; } });
      else current = Promise.resolve();
    }
    function add(next) {
      var merged = Array.from(new Set(dates.concat(next))).sort();
      if (merged.length > 366) { error.textContent = 'Select no more than 366 dates.'; return; }
      dates = merged; render();
    }
    picker.querySelector('[data-leave-range]').onclick = function () {
      var from = picker.querySelector('[data-leave-from]').value, to = picker.querySelector('[data-leave-to]').value;
      if (!valid(from) || !valid(to) || to < from) { error.textContent = 'Enter valid From and Through dates in order.'; return; }
      var next = parse({ date_from: from, date_to: to });
      if ((Date.parse(to) - Date.parse(from)) / 86400000 >= 366) { error.textContent = 'Select no more than 366 dates.'; return; }
      add(next);
    };
    picker.querySelector('[data-leave-add]').onclick = function () {
      var input = picker.querySelector('[data-leave-single]');
      if (!valid(input.value)) { error.textContent = 'Choose a valid separate date.'; return; }
      add([input.value]); input.value = '';
    };
    picker.querySelector('[data-leave-from]').value = dates[0] || '';
    picker.querySelector('[data-leave-to]').value = dates[dates.length - 1] || '';
    render();
    return { value: value, ready: function () { return current; } };
  }
  root.LeaveDates = { parse: parse, markup: markup, mount: mount };
})(typeof window === 'undefined' ? globalThis : window);
