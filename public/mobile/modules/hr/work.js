/* Work tab — the by-urgency work queue for warehouse users; a short task list for
   other employees. `mWorkQueue()` is reused by the Warehouse home hub. */
(function () {
  var ROWS = [
    { icon: '📦', label: 'Receive PR', sub: 'purchase requests', route: 'receive', color: 'var(--m-high)',
      count: function () { return openCount('/orders?type=purchase'); } },
    { icon: '🚚', label: 'Pick Order', sub: 'sales orders', route: 'pick', color: 'var(--m-low)',
      count: function () { return openCount('/orders?type=sale'); } },
    { icon: '🏷️', label: 'Release SOs', sub: 'scan units out to a sale order', route: 'so', color: 'var(--m-ok)',
      count: function () {
        return API.get('/orders?type=sale').then(function (o) {
          return (o || []).filter(function (x) { var s = String(x.status).toLowerCase(); return s === 'approved' || s === 'released'; }).length;
        }).catch(function () { return 0; });
      } },
    { icon: '🔢', label: 'Cycle Count', sub: 'spot check a location', route: 'cycle-count', color: 'var(--m-med)', count: null },
    { icon: '🚀', label: 'Ship Units', sub: 'allocate QC-passed units', route: 'allocate', color: 'var(--m-ok)', count: null },
  ];

  function openCount(path) {
    return API.get(path).then(function (o) {
      return (o || []).filter(function (x) { return x.status !== 'cancelled' && x.status !== 'closed' && x.status !== 'completed'; }).length;
    });
  }

  function canDeliver() { return MApp.can('delivery.run') || MApp.can('delivery.manage'); }

  var DELIVERY_ROW = {
    icon: '🛻', label: 'Deliveries', sub: 'field drops + proof of delivery', route: 'deliveries', color: '#0891b2',
    count: function () {
      return API.get('/deliveries?mine=1').then(function (rows) {
        return (rows || []).filter(function (r) { return r.status === 'pending' || r.status === 'out_for_delivery'; }).length;
      });
    },
  };

  function mWorkQueue() {
    var wrap = mEl('<div class="m-wq"></div>');
    var rows = canDeliver() ? [DELIVERY_ROW].concat(ROWS) : ROWS;
    rows.forEach(function (r) {
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
    if (canDeliver()) LIST.unshift(['🛻', 'Deliveries', 'deliveries']);
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
