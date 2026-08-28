/* Scan — camera → resolve code via GET /api/inventory/lookup → choose Stock In/Out,
   then hand off to the shared stock-move form. */
(function () {
  function chooseAction(view, item) {
    MApp.setTitle('Scanned');
    view.innerHTML = '';
    var box = mEl(
      '<div class="m-choose">' +
      '  <div class="m-picked"><b>' + mEsc(item.name) + '</b>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') + '</div>' +
      '  <div class="m-choose-qty">On hand: ' + (item.quantity != null ? item.quantity + ' ' + mEsc(item.unit || '') : '—') + '</div>' +
      '  <div class="m-actions">' +
      '    <button class="m-btn" data-in>Stock In</button>' +
      '    <button class="m-btn" data-out>Stock Out</button>' +
      '    <button class="m-btn m-btn-secondary" data-again>Scan another</button>' +
      '  </div>' +
      '</div>'
    );
    box.querySelector('[data-in]').onclick = function () { mStockMoveForm(view, { item: item, mode: 'in' }); };
    box.querySelector('[data-out]').onclick = function () { mStockMoveForm(view, { item: item, mode: 'out' }); };
    box.querySelector('[data-again]').onclick = function () { openScan(view); };
    view.appendChild(box);
  }

  function openScan(view) {
    MApp.setTitle('Scan');
    view.innerHTML =
      '<div class="m-scan-intro">' +
      '<p>Point the camera at an item\'s barcode or QR code.</p>' +
      '<button class="m-btn" id="m-open-scan">Open scanner</button>' +
      '<button class="m-btn m-btn-secondary" id="m-scan-home">Back</button></div>';
    var run = function () {
      mScanner.open({
        title: 'Scan item',
        onResult: function (code) {
          API.get('/inventory/lookup?code=' + encodeURIComponent(code))
            .then(function (it) { chooseAction(view, it); })
            .catch(function (ex) {
              mToast(ex.message || 'No item for that code', 'err');
              openScan(view);
            });
        },
      });
    };
    view.querySelector('#m-open-scan').onclick = run;
    view.querySelector('#m-scan-home').onclick = function () { MApp.go('home'); };
    // Auto-open the first time the view is entered.
    run();
  }

  MApp.route('scan', function (view) { openScan(view); });
})();
