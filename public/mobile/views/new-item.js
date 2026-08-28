/* New Item — basic fields only (full details are edited on the PC).
   Wraps POST /api/inventory. */
MApp.route('new-item', function (view) {
  MApp.setTitle('New Item');

  var f = mEl(
    '<form class="m-form">' +
    '  <label class="m-field"><span class="m-label">Name *</span>' +
    '    <input type="text" class="m-input" data-k="name" maxlength="160" required autofocus /></label>' +
    '  <label class="m-field"><span class="m-label">SKU (optional)</span>' +
    '    <input type="text" class="m-input" data-k="sku" maxlength="80" autocapitalize="characters" /></label>' +
    '  <label class="m-field"><span class="m-label">Category (optional)</span>' +
    '    <input type="text" class="m-input" data-k="category" maxlength="80" /></label>' +
    '  <label class="m-field"><span class="m-label">Unit</span>' +
    '    <input type="text" class="m-input" data-k="unit" maxlength="40" value="pcs" /></label>' +
    '  <div class="m-two">' +
    '    <label class="m-field"><span class="m-label">Starting qty</span>' +
    '      <input type="number" class="m-input" data-k="quantity" inputmode="numeric" min="0" step="1" value="0" /></label>' +
    '    <label class="m-field"><span class="m-label">Min / reorder</span>' +
    '      <input type="number" class="m-input" data-k="min_quantity" inputmode="numeric" min="0" step="1" value="0" /></label>' +
    '  </div>' +
    '  <div data-loc></div>' +
    '  <div class="m-hint">Add a photo, supplier, price and more later from the desktop system.</div>' +
    '  <div class="m-actions"><button class="m-btn" type="submit">Create item</button></div>' +
    '</form>'
  );

  mLocations.load().then(function () {
    var loc = mLocations.select({ label: 'Starting location' });
    f.querySelector('[data-loc]').appendChild(loc.el);

    f.onsubmit = function (e) {
      e.preventDefault();
      var get = function (k) { return f.querySelector('[data-k="' + k + '"]').value.trim(); };
      if (!get('name')) { mToast('Name is required', 'err'); return; }
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      var payload = {
        name: get('name'),
        sku: get('sku') || null,
        category: get('category') || null,
        unit: get('unit') || 'pcs',
        quantity: parseInt(get('quantity'), 10) || 0,
        min_quantity: parseInt(get('min_quantity'), 10) || 0,
        location_id: loc.value(),
      };
      API.post('/inventory', payload)
        .then(function (res) {
          var id = res.id;
          mSuccess(view, {
            title: 'Item created',
            lines: [payload.name, payload.quantity + ' ' + payload.unit + ' to start'],
            actions: [
              { label: 'Add QR to it', onClick: function () { MApp.go('assign-qr', { id: id }); } },
              { label: 'Add another', secondary: true, onClick: function () { MApp.render(); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        })
        .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); btn.disabled = false; });
    };
  });

  view.appendChild(f);
});
