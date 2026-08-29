/* Work tab — the by-urgency work queue for warehouse users; a short task list for
   other employees. `mWorkQueue()` is reused by the Warehouse home hub. */
(function () {
  var ROWS = [
    { icon: '📦', label: 'Receive PR', sub: 'purchase requests', route: 'receive', color: 'var(--m-high)',
      count: function () { return openCount('/orders?type=purchase'); } },
    { icon: '🚚', label: 'Pick Order', sub: 'sales orders', route: 'pick', color: 'var(--m-low)',
      count: function () { return openCount('/orders?type=sale'); } },
    { icon: '🔢', label: 'Cycle Count', sub: 'spot check a location', route: 'cycle-count', color: 'var(--m-med)', count: null },
    { icon: '🏭', label: 'Job Orders', sub: 'shop floor', route: 'job-orders', color: '#7c3aed',
      count: function () {
        return API.get('/job-orders').then(function (j) {
          return (j || []).filter(function (x) { return ['released', 'in_progress', 'paused'].indexOf(x.status) !== -1; }).length;
        });
      } },
    { icon: '🚀', label: 'Ship Units', sub: 'allocate QC-passed units', route: 'allocate', color: 'var(--m-ok)', count: null },
  ];

  function openCount(path) {
    return API.get(path).then(function (o) {
      return (o || []).filter(function (x) { return x.status !== 'cancelled' && x.status !== 'closed' && x.status !== 'completed'; }).length;
    });
  }

  function mWorkQueue() {
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
      if (r.count) {
        r.count().then(function (n) {
          var e = row.querySelector('[data-eta]');
          if (e) e.textContent = n ? n + ' waiting' : 'clear';
        }).catch(function () {});
      }
    });
    return wrap;
  }
  window.mWorkQueue = mWorkQueue;

  MApp.route('work', function (view) {
    if (MApp.isWarehouse()) {
      MApp.setTitle('Work queue');
      view.appendChild(mWorkQueue());
      return;
    }
    MApp.setTitle('My work');
    var LIST = [
      ['✅', 'My Tasks', 'tasks'], ['📝', 'Requests', 'requests'],
      ['🛠️', 'Fix a Punch', 'time-fix'], ['📅', 'My Schedule', 'schedule'],
    ];
    if (MApp.canApprove()) LIST.unshift(['✔️', 'To Approve', 'approvals']);
    var wrap = mEl('<div class="m-wq"></div>');
    LIST.forEach(function (x) {
      var row = mEl(
        '<div class="m-wq-row" style="--wq:var(--m-accent)">' +
        '<span class="m-wq-ic">' + x[0] + '</span>' +
        '<span class="m-wq-tx"><b>' + mEsc(x[1]) + '</b></span>' +
        '<span class="m-wq-ch"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
        '</div>'
      );
      row.onclick = function () { MApp.go(x[2]); };
      wrap.appendChild(row);
    });
    view.appendChild(wrap);
  });
})();
