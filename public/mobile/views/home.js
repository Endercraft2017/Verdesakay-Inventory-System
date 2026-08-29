/* Home — greeting, and role-adaptive sections: "Me" (any linked employee) and the
   warehouse sections (inventory.mobile). */
MApp.route('home', function (view) {
  var me = MApp.getMe();
  var warehouse = MApp.can('inventory.mobile');
  var employee = MApp.isEmployee();
  MApp.setTitle(warehouse ? 'Warehouse' : 'Verdesakay');

  var ME_SECTION = { title: 'Me', tiles: [
    { icon: '🕒', label: 'Time Clock', go: ['clock'] },
    { icon: '🛠️', label: 'Fix a Punch', go: ['time-fix'] },
    { icon: '📝', label: 'Requests', go: ['requests'] },
    { icon: '💵', label: 'Payslips', go: ['payslips'] },
    { icon: '📅', label: 'My Schedule', go: ['schedule'] },
    { icon: '✅', label: 'My Tasks', go: ['tasks'] },
  ] };
  var APPROVALS_SECTION = { title: 'Approvals', tiles: [
    { icon: '✔️', label: 'To Approve', go: ['approvals'] },
  ] };
  var COMMS_SECTION = { title: 'People', tiles: [
    { icon: '📣', label: 'Announcements', go: ['announcements'] },
    { icon: '✉️', label: 'Inbox', go: ['inbox'] },
    { icon: '👥', label: 'Directory', go: ['directory'] },
  ] };
  var WAREHOUSE_SECTIONS = [
    { title: 'Record', tiles: [
      { icon: '📥', label: 'Stock In', go: ['stock-move', { mode: 'in' }] },
      { icon: '📤', label: 'Stock Out', go: ['stock-move', { mode: 'out' }] },
      { icon: '🔁', label: 'Transfer', go: ['transfer'] },
      { icon: '⚠️', label: 'Damaged', go: ['damage'] },
      { icon: '➕', label: 'New Item', go: ['new-item'] },
      { icon: '🧾', label: 'Batch In/Out', go: ['batch', { mode: 'in' }] },
    ] },
    { title: 'Look up', tiles: [
      { icon: '🔎', label: 'Check Stock', go: ['item'] },
      { icon: '📉', label: 'Low Stock', go: ['low-stock'] },
      { icon: '📍', label: 'Location', go: ['location'] },
      { icon: '🕘', label: 'My Activity', go: ['my-log'] },
    ] },
    { title: 'Tasks', tiles: [
      { icon: '🔢', label: 'Cycle Count', go: ['cycle-count'] },
      { icon: '📦', label: 'Receive PR', go: ['receive'] },
      { icon: '🚚', label: 'Pick Order', go: ['pick'] },
      { icon: '🏭', label: 'Job Orders', go: ['job-orders'] },
      { icon: '🔬', label: 'QA / QC', go: ['qc'] },
      { icon: '🚀', label: 'Ship Units', go: ['allocate'] },
    ] },
    { title: 'Codes', tiles: [
      { icon: '▦', label: 'Add QR', go: ['assign-qr'] },
      { icon: '📷', label: 'Scan', go: ['scan'] },
    ] },
  ];

  var sections = [];
  if (employee) sections.push(ME_SECTION);
  if (me && me.can_approve) sections.push(APPROVALS_SECTION);
  sections.push(COMMS_SECTION);
  if (warehouse) sections = sections.concat(WAREHOUSE_SECTIONS);

  // Only show tiles whose route is actually registered (features roll out incrementally).
  var live = MApp.routes();
  sections = sections
    .map(function (s) { return { title: s.title, tiles: s.tiles.filter(function (t) { return live.indexOf(t.go[0]) !== -1; }) }; })
    .filter(function (s) { return s.tiles.length; });

  var wrap = mEl('<div class="m-home2"></div>');
  wrap.appendChild(mEl(
    '<div class="m-greeting">Hi, <b>' + mEsc((me.full_name || me.username || '').split(' ')[0]) + '</b>' +
    '<span>' + mEsc(me.role || '') + (me.department_name ? ' · ' + mEsc(me.department_name) : '') + '</span></div>'
  ));
  if (warehouse) wrap.appendChild(mStats.strip());

  sections.forEach(function (sec) {
    wrap.appendChild(mEl('<h3 class="m-sec">' + mEsc(sec.title) + '</h3>'));
    var grid = mEl('<div class="m-tiles"></div>');
    sec.tiles.forEach(function (t) {
      var el = mEl('<button class="m-tile"><span class="m-tile-icon">' + t.icon + '</span><span>' + mEsc(t.label) + '</span></button>');
      el.onclick = function () { MApp.go(t.go[0], t.go[1]); };
      grid.appendChild(el);
    });
    wrap.appendChild(grid);
  });

  if (warehouse) {
    var report = mEl('<button class="m-btn m-btn-warn m-report">⚠️  Report a problem to a superior</button>');
    report.onclick = function () { MApp.go('report-problem'); };
    wrap.appendChild(report);
  }

  view.appendChild(wrap);
});
