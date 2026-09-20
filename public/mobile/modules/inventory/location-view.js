/* Location contents — pick a location, see what's stored there. */
MApp.route('location', function (view) {
  MApp.setTitle('Location');
  view.innerHTML = '<div class="m-hint">Loading…</div>';

  mLocations.load()
    .then(function (locs) {
      view.innerHTML = '';
      var sel = mLocations.select({ label: 'Which location?' });
      view.appendChild(sel.el);
      var out = mEl('<div data-out></div>');
      view.appendChild(out);

      function load() {
        var id = sel.value();
        if (!id) return;
        out.innerHTML = '<div class="m-hint">Loading…</div>';
        API.get('/locations/' + id)
          .then(function (loc) {
            var items = loc.items || [];
            if (!items.length) { out.innerHTML = '<div class="m-empty">Nothing stored here.</div>'; return; }
            out.innerHTML = '<div class="m-hint">' + items.length + ' item(s) · ' +
              items.reduce(function (s, i) { return s + i.quantity; }, 0) + ' units</div>';
            var ul = mEl('<ul class="m-list"></ul>');
            items.forEach(function (i) {
              var li = mEl(
                '<li class="m-list-row"><div><b>' + mEsc(i.name) + '</b><span>' + mEsc(i.sku || '') + '</span></div>' +
                '<div class="m-list-qty">' + i.quantity + ' ' + mEsc(i.unit || '') + '</div></li>'
              );
              li.onclick = function () { MApp.go('item', { id: i.id }); };
              ul.appendChild(li);
            });
            out.appendChild(ul);
          })
          .catch(function (ex) { out.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
      }
      sel.select.addEventListener('change', load);
      load();
    })
    .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
});
