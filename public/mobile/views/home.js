/* Home — greeting, stats strip, grouped action tiles, and Report a problem. */
MApp.route('home', function (view) {
  MApp.setTitle('Warehouse');
  var me = MApp.getMe();

  var SECTIONS = [
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
    ] },
    { title: 'Codes', tiles: [
      { icon: '▦', label: 'Add QR', go: ['assign-qr'] },
      { icon: '📷', label: 'Scan', go: ['scan'] },
    ] },
  ];

  var wrap = mEl('<div class="m-home2"></div>');
  wrap.appendChild(mEl(
    '<div class="m-greeting">Hi, <b>' + mEsc((me.full_name || me.username || '').split(' ')[0]) + '</b>' +
    '<span>' + mEsc(me.role || '') + (me.department_name ? ' · ' + mEsc(me.department_name) : '') + '</span></div>'
  ));
  wrap.appendChild(mStats.strip());

  SECTIONS.forEach(function (sec) {
    wrap.appendChild(mEl('<h3 class="m-sec">' + mEsc(sec.title) + '</h3>'));
    var grid = mEl('<div class="m-tiles"></div>');
    sec.tiles.forEach(function (t) {
      var el = mEl('<button class="m-tile"><span class="m-tile-icon">' + t.icon + '</span><span>' + mEsc(t.label) + '</span></button>');
      el.onclick = function () { MApp.go(t.go[0], t.go[1]); };
      grid.appendChild(el);
    });
    wrap.appendChild(grid);
  });

  var report = mEl('<button class="m-btn m-btn-warn m-report">⚠️  Report a problem to a superior</button>');
  report.onclick = function () { MApp.go('report-problem'); };
  wrap.appendChild(report);

  view.appendChild(wrap);
});
