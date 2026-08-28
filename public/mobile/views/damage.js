/* Damaged stock — wraps POST /api/inventory/:id/damage. Moves units into the item's
   "damage twin" (a category=Damage copy the backend creates / tops up). */
(function () {
  function form(view, item) {
    MApp.setTitle('Report Damage');
    view.innerHTML = '';

    var f = mEl(
      '<form class="m-form">' +
      '  <div class="m-picked"><b>' + mEsc(item.name) + '</b>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') +
      '    <button type="button" class="m-change" data-change>Change</button></div>' +
      '  <div data-loc></div>' +
      '  <div data-qty></div>' +
      '  <label class="m-field"><span class="m-label">What happened?</span>' +
      '    <input type="text" class="m-input" data-note maxlength="200" placeholder="e.g. water damage, dropped" required /></label>' +
      '  <div class="m-hint">Damaged units are moved to a separate "Damage" record and hidden from the normal list.</div>' +
      '  <div class="m-actions"><button class="m-btn m-btn-warn" type="submit">Report damage</button></div>' +
      '</form>'
    );
    f.querySelector('[data-change]').onclick = function () { pick(view); };

    var qty = mQtyField('Quantity damaged', 1);
    f.querySelector('[data-qty]').appendChild(qty.el);

    mLocations.load()
      .then(function () { return API.get('/inventory/' + item.id + '/stock'); })
      .then(function (breakdown) {
        var byLoc = {};
        (breakdown || []).forEach(function (b) { byLoc[b.location_id] = b.quantity; });
        var loc = mLocations.select({ label: 'From location', stockByLoc: byLoc });
        f.querySelector('[data-loc]').appendChild(loc.el);

        f.onsubmit = function (e) {
          e.preventDefault();
          var note = f.querySelector('[data-note]').value.trim();
          if (!note) { mToast('Describe the damage', 'err'); return; }
          var n = qty.value();
          if (n < 1) { mToast('Enter a quantity', 'err'); return; }
          var btn = f.querySelector('button[type=submit]');
          btn.disabled = true;
          API.post('/inventory/' + item.id + '/damage', {
            quantity: n, location_id: loc.value(), reason: note,
          })
            .then(function (res) {
              mSuccess(view, {
                title: 'Damage reported',
                lines: [
                  'Moved ' + n + ' ' + (item.unit || '') + ' of ' + item.name + ' to the damage record',
                  'Good stock remaining: ' + res.source_quantity,
                  'Damage record total: ' + res.twin_quantity,
                ],
                actions: [
                  { label: 'Report another', onClick: function () { pick(view); } },
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
    MApp.setTitle('Report Damage');
    view.innerHTML = '';
    var picker = mItemPicker({ label: 'Which item is damaged?', onPick: function (it) { form(view, it); } });
    view.appendChild(picker.el);
    picker.focus();
  }

  MApp.route('damage', function (view) { pick(view); });
  window.mDamageForm = form; // also used from the item-detail screen
})();
