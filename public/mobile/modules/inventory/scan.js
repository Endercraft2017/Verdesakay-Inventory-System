/* Scan — camera → resolve code via GET /api/inventory/lookup → choose Stock In/Out,
   then hand off to the shared stock-move form. */
(function () {
  function chooseAction(view, item) {
    MApp.setTitle('Scanned');
    view.innerHTML = '';
    var tag = '';
    if (item.unit && item.unit.identifier != null) {
      tag = '<div class="m-hint">Unit ' + mEsc(item.unit.identifier || ('#' + item.unit.id)) +
        ' · ' + mEsc(item.unit.status) + (item.unit.job_order_number ? ' · ' + mEsc(item.unit.job_order_number) : '') + '</div>';
    } else if (item.batch && item.batch.number) {
      tag = '<div class="m-hint">Batch ' + mEsc(item.batch.number) +
        (item.batch.identifier ? ' · ' + mEsc(item.batch.identifier) : '') +
        ' · qty ' + item.batch.qty + ' · ' + mEsc(item.batch.status) + '</div>';
    }
    if (item.batch && item.batch.balances) {
      tag += item.batch.balances.map(function(b){return '<div class="m-hint">'+mEsc(b.location_name)+': '+b.on_hand+' in batch · '+b.reserved+' reserved · '+b.available+' free</div>';}).join('');
      tag += (item.batch.allocations || []).map(function(a){return '<div class="m-hint">'+mEsc(a.order_number)+' · '+a.quantity+' '+mEsc(a.state)+'</div>';}).join('');
      if (!item.batch.balances.length && item.batch.received_quantity > 0) tag += '<div class="m-hint">Older batch stock needs reconciliation before exact-batch allocation.</div>';
    }
    var uom = typeof item.unit === 'string' ? item.unit : '';
    var recTarget = (item.unit && item.unit.id) ? { unit: item.unit.id }
      : (item.batch && item.batch.id) ? { batch: item.batch.id } : null;
    var box = mEl(
      '<div class="m-choose">' +
      '  <div class="m-picked"><b>' + mEsc(item.name || (item.batch ? 'Batch ' + item.batch.number : '—')) + '</b>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') + '</div>' +
      tag +
      '  <div class="m-choose-qty">On hand: ' + (item.quantity != null ? item.quantity + ' ' + mEsc(uom) : '—') + '</div>' +
      '  <div class="m-actions">' +
      (recTarget ? '    <button class="m-btn" data-record>Open production record</button>' : '') +
      (item.id && !recTarget ? '    <button class="m-btn ' + (recTarget ? 'm-btn-secondary' : '') + '" data-in>Stock In</button>' +
      '    <button class="m-btn m-btn-secondary" data-out>Stock Out</button>' : '') +
      '    <button class="m-btn m-btn-secondary" data-again>Scan another</button>' +
      '  </div>' +
      '</div>'
    );
    var brec = box.querySelector('[data-record]');
    if (brec) brec.onclick = function () { MApp.go('record', recTarget); };
    var bin = box.querySelector('[data-in]'), bout = box.querySelector('[data-out]');
    if (bin) bin.onclick = function () { mStockMoveForm(view, { item: item, mode: 'in' }); };
    if (bout) bout.onclick = function () { mStockMoveForm(view, { item: item, mode: 'out' }); };
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
