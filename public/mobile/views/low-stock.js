/* Low stock — items at or below their reorder point. Tap one to open its detail. */
MApp.route('low-stock', function (view) {
  MApp.setTitle('Low stock');
  view.innerHTML = '<div class="m-hint">Loading…</div>';
  API.get('/inventory?low=1')
    .then(function (items) {
      view.innerHTML = '';
      if (!items.length) {
        view.appendChild(mEl('<div class="m-empty">👍 Nothing is below its reorder point.</div>'));
        return;
      }
      view.appendChild(mEl('<div class="m-hint">' + items.length + ' item(s) need restocking.</div>'));
      var ul = mEl('<ul class="m-list"></ul>');
      items.forEach(function (it) {
        var li = mEl(
          '<li class="m-list-row">' +
          '<div><b>' + mEsc(it.name) + '</b><span>' + mEsc(it.sku || '') + '</span></div>' +
          '<div class="m-list-qty low">' + it.quantity + ' / ' + it.min_quantity + '</div>' +
          '</li>'
        );
        li.onclick = function () { MApp.go('item', { id: it.id }); };
        ul.appendChild(li);
      });
      view.appendChild(ul);
    })
    .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
});
