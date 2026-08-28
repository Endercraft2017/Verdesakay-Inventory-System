/* Reusable "find an item" control: type-ahead search + a Scan button.
   mItemPicker({ label, onPick }) -> { el }. onPick(item) fires on selection.
   When the search box is empty it shows recently-used items (mRecent). */
(function () {
  function itemPicker(opts) {
    opts = opts || {};
    var box = mEl(
      '<div class="m-picker">' +
      '  <span class="m-label">' + mEsc(opts.label || 'Item') + '</span>' +
      '  <div class="m-picker-row">' +
      '    <input type="search" class="m-input" placeholder="Search name or SKU" autocomplete="off" />' +
      '    <button type="button" class="m-scan-btn" aria-label="Scan barcode or QR" title="Scan">' +
      '      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>' +
      '    </button>' +
      '  </div>' +
      '  <ul class="m-picker-list"></ul>' +
      '</div>'
    );
    var input = box.querySelector('input');
    var list = box.querySelector('.m-picker-list');
    var timer = null;

    function pick(it) {
      if (window.mRecent) mRecent.push(it);
      opts.onPick(it);
    }

    function clear() { list.innerHTML = ''; }

    function rowsFor(items, heading) {
      clear();
      if (heading) list.appendChild(mEl('<li class="m-picker-head">' + mEsc(heading) + '</li>'));
      if (!items.length) {
        if (!heading) list.appendChild(mEl('<li class="m-picker-empty">No matches</li>'));
        return;
      }
      items.forEach(function (it) {
        var sub = [it.sku ? '#' + it.sku : null, (it.quantity != null ? it.quantity + ' ' + (it.unit || '') : null)]
          .filter(Boolean).join(' · ');
        var li = mEl(
          '<li class="m-picker-item"><b>' + mEsc(it.name) + '</b>' +
          (sub ? '<span>' + mEsc(sub) + '</span>' : '') + '</li>'
        );
        li.onclick = function () { pick(it); };
        list.appendChild(li);
      });
    }

    function showRecent() {
      var r = window.mRecent ? mRecent.read() : [];
      if (r.length) rowsFor(r, 'Recent'); else clear();
    }

    function search(q) {
      if (!q) { showRecent(); return; }
      API.get('/inventory?q=' + encodeURIComponent(q) + '&limit=20')
        .then(function (items) { rowsFor(items); })
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
            .then(function (it) { pick(it); })
            .catch(function (e) { mToast(e.message || 'No item for that code', 'err'); });
        },
      });
    };

    showRecent();
    return { el: box, focus: function () { input.focus(); } };
  }

  window.mItemPicker = itemPicker;
})();
