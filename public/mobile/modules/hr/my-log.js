/* My recent activity — the stock movements this user recorded, newest first.
   Lets a warehouseman review what they logged and catch a mistake. */
MApp.route('my-log', function (view) {
  MApp.setTitle('My activity');
  var me = MApp.getMe();
  view.innerHTML = '<div class="m-hint">Loading…</div>';

  API.get('/inventory/movements?user_id=' + me.id + '&limit=50')
    .then(function (res) {
      var rows = res.rows || [];
      view.innerHTML = '';
      if (!rows.length) {
        view.appendChild(mEl('<div class="m-empty">You haven’t recorded any stock movements yet.</div>'));
        return;
      }
      var ul = mEl('<ul class="m-moves wide"></ul>');
      rows.forEach(function (h) {
        var cls = h.change < 0 ? 'out' : 'in';
        var li = mEl(
          '<li>' +
          '<span class="m-move-d ' + cls + '">' + (h.change > 0 ? '+' : '') + h.change + '</span>' +
          '<span class="m-move-main"><b>' + mEsc(h.item_name || '') + '</b>' +
          '<span>' + mEsc(h.reason || '—') + (h.location_name ? ' · ' + mEsc(h.location_name) : '') + '</span></span>' +
          '<span class="m-move-t">' + mEsc((h.created_at || '').slice(5, 16).replace('T', ' ')) + '</span>' +
          '</li>'
        );
        if (h.item_id) li.onclick = function () { MApp.go('item', { id: h.item_id }); };
        ul.appendChild(li);
      });
      view.appendChild(ul);
    })
    .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
});
