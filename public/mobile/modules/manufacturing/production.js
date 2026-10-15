/* Production tab — shop-floor hub: job orders, QC/QA inspection, and repairs /
   parts requests. Split out from the general Work queue so production execution
   has its own home, separate from warehouse put-away/pick/ship tasks. */
(function () {
  // perm (or perms, for a row more than one narrow role can open — QC / QA): the narrow
  // permission(s) that person's role needs (see src/shared/permissions.ts). inventory.adjust
  // always also qualifies (admin/warehouse/admin_staff/releasing keep seeing every tile,
  // unchanged) — a row only hides for an account that holds NONE of its perm(s), so e.g. a
  // qc_inspector-only account still sees "QC / QA" (its own inspect_qc permission covers it)
  // but not the other three.
  var ROWS = [
    { icon: '🏭', label: 'Awaiting approval', sub: 'review draft production plans', route: 'job-orders', params: { view: 'approval' }, color: '#6d4a91', perm: 'production.approve', strict: true,
      count: function () { return API.get('/job-orders?stage=awaiting_approval').then(function (rows) { return mProductionDrafts.approvalCount(rows || []); }); } },
    { icon: '🏭', label: 'Job Orders', sub: 'shop floor', route: 'job-orders', color: '#7c3aed', perm: 'production.record',
      count: function () {
        return API.get('/job-orders').then(function (j) {
          return (j || []).filter(function (x) { return ['released', 'in_progress', 'paused'].indexOf(x.status) !== -1; }).length;
        });
      } },
    { icon: '✅', label: 'QC / QA', sub: 'units waiting on inspection', route: 'qc', color: 'var(--m-ok)', perms: ['production.inspect_qc', 'production.inspect_qa'],
      // units_actionable (job-orders.routes.ts GET /) is already scoped server-side to
      // what THIS account's permissions cover — not every open unit regardless of stage —
      // so a qc_inspector-only account's badge matches what qc.js's own queue shows it.
      // Counted from the inspector's own queue (a floor desk can't list every job order).
      count: function () {
        return API.get('/qc/queue').then(function (q) { return ((q && q.units) || []).length; });
      } },
    { icon: '🔧', label: 'Repairs', sub: 'parts requests to accept', route: 'repairs', color: '#d97706', perm: 'production.repairs',
      count: function () {
        return API.get('/production/repairs?status=requested').then(function (r) { return (r || []).length; }).catch(function () { return 0; });
      } },
    { icon: '📦', label: 'Products In', sub: 'passed units/batches to receive', route: 'receiving', color: '#0ea5e9', perm: 'production.receive',
      // Counted from the RTS desk's own queue (a floor desk can't list every job order).
      count: function () {
        return API.get('/rts/queue').then(function (q) {
          return ((q && q.units) || []).filter(function (u) { return !u.hold; }).length + ((q && q.batches) || []).length;
        });
      } },
  ];

  function mProductionQueue() {
    var wrap = mEl('<div class="m-wq"></div>');
    ROWS.filter(function (r) {
      var perms = r.perms || (r.perm ? [r.perm] : []);
      return (!r.strict && MApp.can('inventory.adjust')) || perms.some(function (p) { return MApp.can(p); });
    }).forEach(function (r) {
      var row = mEl(
        '<div class="m-wq-row" style="--wq:' + r.color + '">' +
        '<span class="m-wq-ic">' + r.icon + '</span>' +
        '<span class="m-wq-tx"><b>' + mEsc(r.label) + '</b><span>' + mEsc(r.sub) + '</span></span>' +
        '<span class="m-wq-eta" data-eta></span>' +
        '<span class="m-wq-ch"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
        '</div>'
      );
      row.onclick = function () { MApp.go(r.route, r.params); };
      wrap.appendChild(row);
      r.count().then(function (n) {
        var e = row.querySelector('[data-eta]');
        if (e) e.textContent = n ? n + ' waiting' : 'clear';
      }).catch(function () {});
    });
    return wrap;
  }

  MApp.route('production', function (view) {
    view.setAttribute('data-role-screen', 'production-manager');
    view.setAttribute('data-role-title', 'Production control');
    view.setAttribute('data-role-subtitle', 'Job orders, inspection handoffs and finished output');
    MApp.setTitle('Production');
    view.appendChild(mProductionQueue());
  });
})();
