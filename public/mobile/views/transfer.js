/* Stock Transfer — wraps POST /api/inventory/:id/transfer. */
(function () {
  function form(view, item) {
    MApp.setTitle('Transfer');
    view.innerHTML = '';

    var f = mEl(
      '<form class="m-form">' +
      '  <div class="m-picked"><b>' + mEsc(item.name) + '</b>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') +
      '    <button type="button" class="m-change" data-change>Change</button></div>' +
      '  <div data-from></div>' +
      '  <div data-to></div>' +
      '  <div data-qty></div>' +
      '  <label class="m-field"><span class="m-label">Note (optional)</span>' +
      '    <input type="text" class="m-input" data-note maxlength="200" /></label>' +
      '  <div class="m-actions"><button class="m-btn" type="submit">Confirm transfer</button></div>' +
      '</form>'
    );
    f.querySelector('[data-change]').onclick = function () { pick(view); };

    var qty = mQtyField('Amount', 1);
    f.querySelector('[data-qty]').appendChild(qty.el);

    mLocations.load()
      .then(function () { return API.get('/inventory/' + item.id + '/stock'); })
      .then(function (breakdown) {
        var byLoc = {};
        (breakdown || []).forEach(function (b) { byLoc[b.location_id] = b.quantity; });
        var from = mLocations.select({ label: 'From', stockByLoc: byLoc });
        var to = mLocations.select({ label: 'To', stockByLoc: byLoc });
        // default the "to" select to a different location than "from"
        if (to.select.options.length > 1 && to.select.value === from.select.value) to.select.selectedIndex = 1;
        f.querySelector('[data-from]').appendChild(from.el);
        f.querySelector('[data-to]').appendChild(to.el);

        f.onsubmit = function (e) {
          e.preventDefault();
          if (from.value() === to.value()) { mToast('Pick two different locations', 'err'); return; }
          var n = qty.value();
          if (n < 1) { mToast('Enter an amount', 'err'); return; }
          var btn = f.querySelector('button[type=submit]');
          btn.disabled = true;
          API.post('/inventory/' + item.id + '/transfer', {
            from_location_id: from.value(),
            to_location_id: to.value(),
            amount: n,
            reason: f.querySelector('[data-note]').value.trim() || null,
          })
            .then(function (res) {
              var fromName = from.select.options[from.select.selectedIndex].text.split(' — ')[0];
              var toName = to.select.options[to.select.selectedIndex].text.split(' — ')[0];
              mSuccess(view, {
                title: 'Transfer done',
                lines: [
                  n + ' ' + (item.unit || '') + ' of ' + item.name,
                  fromName + ': ' + res.from + ' left',
                  toName + ': ' + res.to + ' now',
                ],
                actions: [
                  { label: 'Another transfer', onClick: function () { pick(view); } },
                  { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
                ],
              });
            })
            .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
        };
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });

    view.appendChild(f);
  }

  function pick(view) {
    MApp.setTitle('Transfer');
    view.innerHTML = '';
    var picker = mItemPicker({ label: 'Which item?', onPick: function (it) { form(view, it); } });
    view.appendChild(picker.el);
    picker.focus();
  }

  MApp.route('transfer', function (view) { pick(view); });
  window.mTransferForm = form; // also used from the item-detail screen
})();
