/* Add QR to an item — ensures the item has a scannable code (its SKU, its existing
   barcode attribute, or a freshly generated one saved via PUT /api/inventory/:id),
   then renders the QR big enough to screenshot or print. */
(function () {
  function gen(id) {
    return 'VDS-' + id + '-' + Math.random().toString(16).slice(2, 6).toUpperCase();
  }

  function showQR(view, item, code) {
    MApp.setTitle('QR code');
    view.innerHTML = '';
    var qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    var box = mEl(
      '<div class="m-qr">' +
      '  <div class="m-qr-item">' + mEsc(item.name) + '</div>' +
      '  <img class="m-qr-img" alt="QR code" src="' + qr.createDataURL(7, 10) + '" />' +
      '  <div class="m-qr-code">' + mEsc(code) + '</div>' +
      '  <div class="m-hint">Screenshot or print this and stick it on the item / shelf.</div>' +
      '  <div class="m-actions">' +
      '    <button class="m-btn" data-done>Done</button>' +
      '    <button class="m-btn m-btn-secondary" data-more>Add to another</button>' +
      '  </div>' +
      '</div>'
    );
    box.querySelector('[data-done]').onclick = function () { MApp.go('home'); };
    box.querySelector('[data-more]').onclick = function () { start(view, {}); };
    view.appendChild(box);
  }

  function proceed(view, item) {
    var existing = (item.attributes && item.attributes.barcode) || item.sku || null;
    if (existing) { showQR(view, item, existing); return; }

    var code = gen(item.id);
    var attrs = {};
    if (item.attributes && typeof item.attributes === 'object') {
      for (var k in item.attributes) attrs[k] = item.attributes[k];
    }
    attrs.barcode = code;
    view.innerHTML = '<div class="m-hint">Saving code…</div>';
    API.put('/inventory/' + item.id, { attributes: attrs })
      .then(function () { showQR(view, item, code); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Could not save the code') + '</div>'; });
  }

  function start(view, params) {
    MApp.setTitle('Add QR');
    view.innerHTML = '';
    if (params && params.id) {
      API.get('/inventory/' + params.id)
        .then(function (it) { proceed(view, it); })
        .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
      return;
    }
    var picker = mItemPicker({ label: 'Which item needs a QR?', onPick: function (it) { proceed(view, it); } });
    view.appendChild(picker.el);
    picker.focus();
  }

  MApp.route('assign-qr', function (view, params) { start(view, params); });
})();
