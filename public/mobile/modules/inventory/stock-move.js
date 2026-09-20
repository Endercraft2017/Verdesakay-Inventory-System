/* Stock In / Stock Out — wraps POST /api/inventory/:id/adjust.
   Exposes mStockMoveForm(view, {item, mode}) so the Scan view can reuse the form. */
(function () {
  function label(mode) { return mode === 'out' ? 'Stock Out' : 'Stock In'; }

  function moveForm(view, o) {
    var mode = o.mode === 'out' ? 'out' : 'in';
    var item = o.item;
    MApp.setTitle(label(mode));
    view.innerHTML = '';

    var form = mEl(
      '<form class="m-form">' +
      '  <div class="m-picked"><b>' + mEsc(item.name) + '</b>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') +
      '    <button type="button" class="m-change" data-change>Change</button></div>' +
      '  <div data-loc></div>' +
      '  <div data-qty></div>' +
      '  <label class="m-field"><span class="m-label">Note (optional)</span>' +
      '    <input type="text" class="m-input" data-note maxlength="200" placeholder="Reference / remark" /></label>' +
      '  <div class="m-actions"><button class="m-btn" type="submit">Confirm ' + label(mode) + '</button></div>' +
      '</form>'
    );
    form.querySelector('[data-change]').onclick = function () { pick(view, mode); };

    var qty = mQtyField('Quantity', 1);
    form.querySelector('[data-qty]').appendChild(qty.el);

    mLocations.load()
      .then(function () { return API.get('/inventory/' + item.id + '/stock'); })
      .then(function (breakdown) {
        var byLoc = {};
        (breakdown || []).forEach(function (b) { byLoc[b.location_id] = b.quantity; });
        var loc = mLocations.select({ label: 'Location', stockByLoc: byLoc });
        form.querySelector('[data-loc]').appendChild(loc.el);

        form.onsubmit = function (e) {
          e.preventDefault();
          var n = qty.value();
          if (n < 1) { mToast('Enter a quantity', 'err'); return; }
          var btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          mSubmit('/inventory/' + item.id + '/adjust', {
            change: mode === 'out' ? -n : n,
            location_id: loc.value(),
            reason: form.querySelector('[data-note]').value.trim() || null,
          }, { label: label(mode) + ' — ' + item.name + ' ×' + n })
            .then(function (r) {
              var qtyLine = item.name + '  ' + (mode === 'out' ? '−' : '+') + n + ' ' + (item.unit || '');
              mSuccess(view, {
                title: r.queued ? 'Saved — will sync' : label(mode) + ' recorded',
                lines: r.queued
                  ? [qtyLine, 'You’re offline. It will send automatically when back online.']
                  : [qtyLine, 'On hand here: ' + r.response.location_quantity, 'Total on hand: ' + r.response.quantity],
                actions: [
                  { label: 'Another ' + label(mode), onClick: function () { pick(view, mode); } },
                  { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
                ],
              });
            })
            .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
        };
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });

    view.appendChild(form);
  }

  function pick(view, mode) {
    MApp.setTitle(label(mode));
    view.innerHTML = '';
    var picker = mItemPicker({ label: 'Which item?', onPick: function (it) { moveForm(view, { item: it, mode: mode }); } });
    view.appendChild(picker.el);
    picker.focus();
  }

  MApp.route('stock-move', function (view, params) {
    pick(view, params.mode === 'out' ? 'out' : 'in');
  });

  window.mStockMoveForm = moveForm;
})();
