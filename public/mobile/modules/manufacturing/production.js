/* Production tab — shop-floor hub: job orders, QA/QC inspection, and repairs /
   parts requests. Split out from the general Work queue so production execution
   has its own home, separate from warehouse put-away/pick/ship tasks. */
(function () {
  var ROWS = [
    { icon: '🏭', label: 'Job Orders', sub: 'shop floor', route: 'job-orders', color: '#7c3aed',
      count: function () {
        return API.get('/job-orders').then(function (j) {
          return (j || []).filter(function (x) { return ['released', 'in_progress', 'paused'].indexOf(x.status) !== -1; }).length;
        });
      } },
    { icon: '✅', label: 'QA / QC', sub: 'units waiting on inspection', route: 'qc', color: 'var(--m-ok)',
      count: function () {
        return API.get('/job-orders').then(function (j) {
          return (j || []).reduce(function (a, x) { return a + (x.units_pending || 0) + (x.units_rework || 0); }, 0);
        });
      } },
    { icon: '🔧', label: 'Repairs', sub: 'parts requests to accept', route: 'repairs', color: '#d97706',
      count: function () {
        return API.get('/production/repairs?status=requested').then(function (r) { return (r || []).length; }).catch(function () { return 0; });
      } },
  ];

  function mProductionQueue() {
    var wrap = mEl('<div class="m-wq"></div>');
    ROWS.forEach(function (r) {
      var row = mEl(
        '<div class="m-wq-row" style="--wq:' + r.color + '">' +
        '<span class="m-wq-ic">' + r.icon + '</span>' +
        '<span class="m-wq-tx"><b>' + mEsc(r.label) + '</b><span>' + mEsc(r.sub) + '</span></span>' +
        '<span class="m-wq-eta" data-eta></span>' +
        '<span class="m-wq-ch"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
        '</div>'
      );
      row.onclick = function () { MApp.go(r.route); };
      wrap.appendChild(row);
      r.count().then(function (n) {
        var e = row.querySelector('[data-eta]');
        if (e) e.textContent = n ? n + ' waiting' : 'clear';
      }).catch(function () {});
    });
    return wrap;
  }

  MApp.route('production', function (view) {
    MApp.setTitle('Production');
    view.appendChild(mProductionQueue());
  });
})();
