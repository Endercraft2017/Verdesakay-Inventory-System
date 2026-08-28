/* Reusable "find an item" control: type-ahead search + a Scan button.
   mItemPicker({ label, onPick }) -> { el }. onPick(item) fires on selection. */
(function () {
  function itemPicker(opts) {
    opts = opts || {};
    var box = mEl(
      '<div class="m-picker">' +
      '  <span class="m-label">' + mEsc(opts.label || 'Item') + '</span>' +
      '  <div class="m-picker-row">' +
      '    <input type="search" class="m-input" placeholder="Search name or SKU" autocomplete="off" />' +
      '    <button type="button" class="m-scan-btn" aria-label="Scan">&#9783;</button>' +
      '  </div>' +
      '  <ul class="m-picker-list"></ul>' +
      '</div>'
    );
    var input = box.querySelector('input');
    var list = box.querySelector('.m-picker-list');
    var timer = null;

    function clear() { list.innerHTML = ''; }

    function rowsFor(items) {
      clear();
      if (!items.length) {
        list.appendChild(mEl('<li class="m-picker-empty">No matches</li>'));
        return;
      }
      items.forEach(function (it) {
        var sub = [it.sku ? '#' + it.sku : null, (it.quantity != null ? it.quantity + ' ' + (it.unit || '') : null)]
          .filter(Boolean).join(' · ');
        var li = mEl(
          '<li class="m-picker-item"><b>' + mEsc(it.name) + '</b>' +
          (sub ? '<span>' + mEsc(sub) + '</span>' : '') + '</li>'
        );
        li.onclick = function () { opts.onPick(it); };
        list.appendChild(li);
      });
    }

    function search(q) {
      if (!q) { clear(); return; }
      API.get('/inventory?q=' + encodeURIComponent(q) + '&limit=20')
        .then(rowsFor)
        .catch(function (e) { mToast(e.message || 'Search failed', 'err'); });
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      timer = setTimeout(function () { search(q); }, 250);
    });

    box.querySelector('.m-scan-btn').onclick = function () {
      mScanner.open({
        title: 'Scan item',
        onResult: function (code) {
          API.get('/inventory/lookup?code=' + encodeURIComponent(code))
            .then(function (it) { opts.onPick(it); })
            .catch(function (e) { mToast(e.message || 'No item for that code', 'err'); });
        },
      });
    };

    return { el: box, focus: function () { input.focus(); } };
  }

  window.mItemPicker = itemPicker;
})();
