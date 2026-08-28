/* Home stats strip — GET /inventory/stats. */
(function () {
  function strip() {
    var el = mEl('<div class="m-stats"><div class="m-stat"><b>–</b><span>Items</span></div></div>');
    API.get('/inventory/stats')
      .then(function (s) {
        el.innerHTML =
          cell(s.items, 'Items') +
          cell(s.total_units, 'Units') +
          cell(s.low_stock, 'Low', s.low_stock > 0 ? 'warn' : '') +
          cell(s.out_of_stock, 'Out', s.out_of_stock > 0 ? 'bad' : '');
      })
      .catch(function () { el.remove(); });
    return el;
  }
  function cell(n, label, tone) {
    return '<div class="m-stat ' + (tone || '') + '"><b>' + (n == null ? '–' : n) + '</b><span>' + mEsc(label) + '</span></div>';
  }
  window.mStats = { strip: strip };
})();
