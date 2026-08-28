/* Home — the action menu. */
MApp.route('home', function (view) {
  MApp.setTitle('Warehouse');
  var me = MApp.getMe();

  var tiles = [
    { icon: '📥', label: 'Stock In', go: ['stock-move', { mode: 'in' }] },
    { icon: '📤', label: 'Stock Out', go: ['stock-move', { mode: 'out' }] },
    { icon: '🔁', label: 'Transfer', go: ['transfer'] },
    { icon: '⚠️', label: 'Damaged', go: ['damage'] },
    { icon: '➕', label: 'New Item', go: ['new-item'] },
    { icon: '▦', label: 'Add QR', go: ['assign-qr'] },
    { icon: '📷', label: 'Scan', go: ['scan'] },
  ];

  var wrap = mEl('<div class="m-home2"></div>');
  wrap.appendChild(mEl(
    '<div class="m-greeting">Hi, <b>' + mEsc((me.full_name || me.username || '').split(' ')[0]) + '</b>' +
    '<span>' + mEsc(me.role || '') + (me.department_name ? ' · ' + mEsc(me.department_name) : '') + '</span></div>'
  ));

  var grid = mEl('<div class="m-tiles"></div>');
  tiles.forEach(function (t) {
    var el = mEl('<button class="m-tile"><span class="m-tile-icon">' + t.icon + '</span><span>' + mEsc(t.label) + '</span></button>');
    el.onclick = function () { MApp.go(t.go[0], t.go[1]); };
    grid.appendChild(el);
  });
  wrap.appendChild(grid);
  view.appendChild(wrap);
});
