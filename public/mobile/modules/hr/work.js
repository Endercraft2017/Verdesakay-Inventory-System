/* Work Hub — Figma node 46:548.
   Work answers “what do I need to do now?” and exposes only permission-backed operations. */
(function () {
  var OPS = [
    { label: 'Receive PR', sub: 'Purchase requests', route: 'receive', permission: 'inventory.adjust', count: function () { return openCount('/orders?type=purchase'); } },
    { label: 'Pick order', sub: 'Sales orders', route: 'pick', permission: 'inventory.adjust', count: function () { return openCount('/orders?type=sale'); } },
    { label: 'Release orders', sub: 'Allocated units ready for handoff', route: 'so', permission: 'orders.release',
      count: function () { return API.get('/orders?type=sale').then(function (rows) {
        return (rows || []).filter(function (x) { return ['approved', 'released'].indexOf(String(x.status).toLowerCase()) !== -1; }).length;
      }); } },
    { label: 'Kit releases', sub: 'Pick and release job-order kits', route: 'kit-release', permission: 'inventory.adjust',
      count: function () { return API.get('/job-orders?stage=awaiting_release').then(function (rows) { return (rows || []).length; }); } },
    { label: 'Cycle count', sub: 'Spot-check a stock location', route: 'cycle-count', permission: 'inventory.adjust' },
    { label: 'Allocate units', sub: 'Assign passed units to orders', route: 'allocate', permission: 'inventory.adjust' },
    { label: 'Parts requests', sub: 'Issue parts for repair or rework', route: 'repairs', permission: 'production.repairs',
      count: function () { return API.get('/production/repairs?status=requested').then(function (r) { return (r || []).length; }); } },
    { label: 'RTS recording', sub: 'Record QA-passed finished goods', route: 'receiving', permission: 'production.receive',
      count: function () { return readyToReceive(); } },
    { label: 'Awaiting production approval', sub: 'Review draft quantities, components and stock', route: 'job-orders', params: { view: 'approval' }, permission: 'production.approve',
      count: function () { return API.get('/job-orders?stage=awaiting_approval').then(function (rows) { return mProductionDrafts.approvalCount(rows || []); }); } },
    { label: 'Production job orders', sub: 'Accept kits and record active work', route: 'job-orders', permission: 'production.record',
      count: function () { return API.get('/job-orders').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'released' || x.status === 'in_progress'; }).length;
      }); } },
    { label: 'Saved unit issue reports', sub: 'Resume reports and their photos', route: 'unit-issues', any: ['production.inspect_qc', 'production.inspect_qa', 'production.record', 'production.manage'],
      count: function () { return mProductionDrafts.listActions('unit-issue', 'issue').then(function (saved) { return saved.length; }); } },
    { label: 'QC technical inspection', sub: 'Inspect units waiting for QC', route: 'qc', params: { role: 'qc' }, permission: 'production.inspect_qc',
      count: function () { return actionableInspection('qc'); } },
    { label: 'QA appearance inspection', sub: 'Inspect units waiting for QA', route: 'qc', params: { role: 'qa' }, permission: 'production.inspect_qa',
      count: function () { return actionableInspection('qa'); } },
    // Someone who decides QA holds without inspecting (production.qa_review, e.g. the Production Manager).
    { label: 'QA holds', sub: 'Decide units QA held for review', route: 'qc', params: { role: 'qa', tab: 'hold' }, permission: 'production.qa_review',
      count: function () { return Promise.all([API.get('/qc/holds'), mProductionDrafts.listActions('hold-decision', 'hold')]).then(function (both) { return new Set(both[0].map(function (h) { return h.id; }).concat(both[1].map(function (a) { return a.id; }))).size; }); } },
    { label: 'Deliveries', sub: 'Field drops and proof of delivery', route: 'deliveries', any: ['delivery.run', 'delivery.manage'],
      count: function () { return API.get('/deliveries?mine=1').then(function (rows) {
        return (rows || []).filter(function (x) { return x.status === 'pending' || x.status === 'out_for_delivery'; }).length;
      }); } }
  ];

  function openCount(path) {
    return API.get(path).then(function (rows) {
      return (rows || []).filter(function (x) {
        return ['cancelled', 'closed', 'completed'].indexOf(String(x.status).toLowerCase()) === -1;
      }).length;
    });
  }
  // Counted from the desk's own queue: a floor desk can't list every job order (shared/desk-access.ts).
  function actionableInspection(role) {
    return API.get('/qc/queue?role=' + role).then(function (q) { return ((q && q.units) || []).length; });
  }
  function readyToReceive() {
    return API.get('/rts/queue').then(function (q) {
      return mRtsRecovery.count(q);
    });
  }
  function allowed(op) {
    if (MApp.can('inventory.adjust') && op.permission !== 'orders.release' && op.permission !== 'production.approve') return true;
    if (op.permission && MApp.can(op.permission)) return true;
    return op.any && op.any.some(function (p) { return MApp.can(p); });
  }
  function roleName() {
    var me = MApp.getMe() || {};
    return String(me.role || 'employee').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function opRow(op) {
    var row = mEl(
      '<button type="button" class="v2-work-row"><span><b>' + mEsc(op.label) + '</b>' +
      '<small>' + mEsc(op.sub) + '</small></span><em data-count>OPEN</em>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    row.onclick = function () { MApp.go(op.route, op.params); };
    if (op.count) op.count().then(function (n) {
      var e = row.querySelector('[data-count]');
      if (e) e.textContent = n ? n + ' WAITING' : 'CLEAR';
    }).catch(function () {
      var e = row.querySelector('[data-count]'); if (e) e.textContent = 'OPEN';
    });
    return row;
  }
  function commonTool(label, route) {
    var b = mEl('<button type="button" class="v2-work-tool">' + mEsc(label) + '</button>');
    b.onclick = function () { MApp.go(route); };
    return b;
  }
  function employeeTasks(host) {
    API.get('/tasks').then(function (rows) {
      var open = (rows || []).filter(function (x) { return !x.done; }).slice(0, 3);
      host.innerHTML = '';
      if (!open.length) {
        host.appendChild(mEl('<div class="v2-work-empty">No personal tasks waiting.</div>'));
        return;
      }
      open.forEach(function (x) {
        var r = mEl(
          '<button type="button" class="v2-work-row"><span><b>' + mEsc(x.title) + '</b>' +
          '<small>' + mEsc(x.due_date ? 'Due ' + x.due_date : 'No due date') + '</small></span>' +
          '<em>TO DO</em><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
        );
        r.onclick = function () { MApp.go('tasks', { id: x.id }); };
        host.appendChild(r);
      });
    }).catch(function () { host.innerHTML = '<div class="v2-work-empty">Tasks are unavailable offline.</div>'; });
  }

  function mWorkQueue() {
    var wrap = mEl('<div class="v2-work-list"></div>');
    OPS.filter(allowed).forEach(function (op) { wrap.appendChild(opRow(op)); });
    return wrap;
  }
  window.mWorkQueue = mWorkQueue;

  MApp.route('work', function (view) {
    MApp.setTitle('Work');
    var me = MApp.getMe() || {};
    var ops = OPS.filter(allowed);
    view.innerHTML = '';
    var page = mEl('<section class="v2-work" data-figma-node="46:548"></section>');
    page.appendChild(mEl('<header class="v2-work-heading"><h1>Work</h1><p>What do I need to do now?</p></header>'));
    page.appendChild(mEl(
      '<section class="v2-work-assignment"><span>CURRENT WORK CONTEXT</span><strong>' +
      mEsc(roleName()) + (me.department_name ? ' · ' + mEsc(me.department_name) : '') +
      '</strong><p>' + (ops.length ? mEsc(ops[0].sub) : 'Personal tasks and employee services') + '</p></section>'
    ));

    var taskHead = mEl('<div class="v2-work-title"><h2>My tasks</h2><span>' + (ops.length ? ops.length + ' authorized queue' + (ops.length === 1 ? '' : 's') : 'Today') + '</span></div>');
    page.appendChild(taskHead);
    var list = mEl('<div class="v2-work-list"></div>');
    page.appendChild(list);
    if (ops.length) ops.slice(0, 4).forEach(function (op) { list.appendChild(opRow(op)); });
    else employeeTasks(list);

    var blocker = mEl(
      '<button type="button" class="v2-work-row blocker"><span><b>Report a blocker</b>' +
      '<small>Missing part, defect or safety issue</small></span>' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></button>'
    );
    blocker.onclick = function () { MApp.go('report-problem'); };
    page.appendChild(blocker);

    page.appendChild(mEl('<div class="v2-work-title tools"><h2>My tools</h2></div>'));
    var tools = mEl('<div class="v2-work-tools"></div>');
    tools.appendChild(commonTool('Tasks & reminders', 'tasks'));
    tools.appendChild(commonTool('Notes / checklists', 'notes'));
    tools.appendChild(commonTool('Guides', 'guides'));
    tools.appendChild(commonTool('Schedule', 'schedule'));
    tools.appendChild(commonTool('Announcements', 'announcements'));
    if (ops.length > 4) tools.appendChild(commonTool('All role queues', 'production'));
    // Case handlers for the anonymous channel (HR/admin by default).
    if (MApp.can('reports.confidential')) tools.appendChild(commonTool('Anonymous reports', 'confidential-reports'));
    page.appendChild(tools);

    if (MApp.canApprove()) {
      var approve = commonTool('Approvals', 'approvals');
      approve.classList.add('v2-work-wide-tool');
      page.appendChild(approve);
    }
    view.appendChild(page);
  });
})();