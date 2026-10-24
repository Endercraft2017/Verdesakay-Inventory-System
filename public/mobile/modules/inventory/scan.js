/* Scan — camera → resolve code via GET /api/inventory/lookup → choose Stock In/Out,
   then hand off to the shared stock-move form. */
(function () {
  function chooseAction(view, item, code, scope, openScan) {
    var tag = '';
    if (item.unit && item.unit.identifier != null) {
      tag = '<div class="m-hint">Unit ' + mEsc(item.unit.identifier || ('#' + item.unit.id)) +
        ' · ' + mEsc(item.unit.status) + (item.unit.job_order_number ? ' · ' + mEsc(item.unit.job_order_number) : '') + '</div>';
    } else if (item.batch && item.batch.number) {
      tag = '<div class="m-hint">Batch ' + mEsc(item.batch.number) +
        (item.batch.identifier ? ' · ' + mEsc(item.batch.identifier) : '') +
        ' · qty ' + mEsc(item.batch.qty) + ' · ' + mEsc(item.batch.status) + '</div>';
    }
    if (item.batch && item.batch.balances) {
      tag += item.batch.balances.map(function(b){return '<div class="m-hint">'+mEsc(b.location_name)+': '+mEsc(b.on_hand)+' in batch · '+mEsc(b.reserved)+' reserved · '+mEsc(b.available)+' free</div>';}).join('');
      tag += (item.batch.allocations || []).map(function(a){return '<div class="m-hint">'+mEsc(a.order_number)+' · '+mEsc(a.quantity)+' '+mEsc(a.state)+'</div>';}).join('');
      if (!item.batch.balances.length && item.batch.received_quantity > 0) tag += '<div class="m-hint">Older batch stock needs reconciliation before exact-batch allocation.</div>';
    }
    var uom = typeof item.unit === 'string' ? item.unit : '';
    var recTarget = (item.unit && item.unit.id) ? { unit: item.unit.id }
      : (item.batch && item.batch.id) ? { batch: item.batch.id } : null;
    var box = mEl(
      '<div class="m-choose">' +
      '  <div class="m-picked"><h1 class="scan-item-title">' + mEsc(item.name || (item.batch ? 'Batch ' + item.batch.number : '—')) + '</h1>' +
      (item.sku ? '<span>#' + mEsc(item.sku) + '</span>' : '') + '</div>' +
      '<p class="m-hint">Matched code: ' + mEsc(code) + '</p>' +
      tag +
      '  <div class="m-choose-qty">On hand: ' + (item.quantity != null ? mEsc(item.quantity) + ' ' + mEsc(uom) : '—') + '</div>' +
      '  <div class="m-actions">' +
      (recTarget && MApp.canOpen('record') ? '    <button class="m-btn" data-record>Open production record</button>' : '') +
      (item.id && !recTarget && MApp.can('inventory.adjust') && MApp.canOpen('stock-move') ? '    <button class="m-btn ' + (recTarget ? 'm-btn-secondary' : '') + '" data-in>Stock In</button>' +
      '    <button class="m-btn m-btn-secondary" data-out>Stock Out</button>' : '') +
      (!recTarget && !MApp.can('inventory.adjust') ? '<p class="m-hint">You can view this match. Your account cannot adjust stock.</p>' : '') +
      '    <button class="m-btn m-btn-secondary" data-again>Scan another</button>' +
      '  </div>' +
      '</div>'
    );
    var brec = box.querySelector('[data-record]');
    if (brec) brec.onclick = function () { if (scope.current() && brec.isConnected && MApp.canOpen('record')) { brec.disabled = true; MApp.go('record', recTarget); } };
    var bin = box.querySelector('[data-in]'), bout = box.querySelector('[data-out]');
    function move(mode) {
      if (!scope.current() || !box.isConnected || !MApp.can('inventory.adjust') || !MApp.canOpen('stock-move')) return;
      scope.release();
      // Keep a detached destination safe if the existing form finishes after navigation.
      view.innerHTML = '<p class="m-hint" role="status">Opening stock adjustment…</p>';
      mStockMoveForm(view, {item:item,mode:mode});
    }
    if (bin) bin.onclick = function () { move('in'); };
    if (bout) bout.onclick = function () { move('out'); };
    box.querySelector('[data-again]').onclick = function () { if (scope.current() && box.isConnected) openScan(); };
    MApp.setTitle('Scanned'); view.replaceChildren(box);
  }

  MApp.route('scan', function (view) {
    var root = mEl('<section class="m-scan-page"></section>'), scanner, busy = false, code = '';
    view.replaceChildren(root);
    var scope = mReadScope.create(root,function () { scanner?.close(); });
    function openScan() {
      if (!scope.current() || busy) return;
      MApp.setTitle('Scan');
      root.innerHTML = '<h1>Scan</h1><div class="m-scan-intro"><p>Point the camera at an item’s barcode or QR code.</p><button type="button" class="m-btn" id="m-open-scan">Open scanner</button><button type="button" class="m-btn m-btn-secondary" id="m-scan-home">Back</button><p class="m-hint">You can also type the code inside the scanner. Scanning finds the record; it does not change stock.</p></div><div data-scan-feedback></div>';
      root.querySelector('#m-open-scan').onclick = run;
      root.querySelector('#m-scan-home').onclick = function () { if (scope.current()) MApp.go('home'); };
      root.querySelector('#m-open-scan').focus();
      run();
    }
    function run() {
      if (!scope.current() || busy) return;
      scanner = mScanner.open({title:'Scan item',key:'inventory-lookup',initialCode:code,isCurrent:scope.current,onResult:function (value) {
        if (!scope.current() || busy) return;
        code = String(value || '').trim();
        if (code) lookup();
      }});
    }
    async function lookup() {
      if (!scope.current() || busy) return;
      busy = true;
      var feedback = root.querySelector('[data-scan-feedback]'), opener = root.querySelector('#m-open-scan');
      opener.disabled = true; root.setAttribute('aria-busy','true');
      feedback.innerHTML = '<p class="scan-feedback" role="status">Checking code <b>'+mEsc(code)+'</b>…</p>';
      try {
        var item = await scope.run(function (opts) { return API.get('/inventory/lookup?code='+encodeURIComponent(code),opts); });
        if (!scope.current()) return;
        if (!item || !(Number(item.id)>0 || Number(item.batch?.id)>0 || Number(item.unit?.id)>0)) throw new Error('The lookup response could not be read. Retry this code.');
        if (item.batch && ((item.batch.balances != null && !Array.isArray(item.batch.balances)) || (item.batch.allocations != null && !Array.isArray(item.batch.allocations)))) throw new Error('The batch details could not be read. Retry this code.');
        chooseAction(root,item,code,scope,openScan);
        root.querySelector('h1')?.setAttribute('tabindex','-1'); root.querySelector('h1')?.focus();
      } catch (error) {
        if (error.cancelled || !scope.current()) return;
        feedback.innerHTML = '<div class="scan-feedback error" role="alert" tabindex="-1"><b>'+mEsc(code)+'</b><p>'+mEsc(error.message || 'The lookup could not be confirmed.')+'</p><div class="m-actions"><button type="button" class="m-btn" data-scan-retry>Retry lookup</button><button type="button" class="m-btn m-btn-secondary" data-scan-edit>Edit code / scan again</button></div></div>';
        feedback.querySelector('[data-scan-retry]').onclick = function () { if (this.isConnected) lookup(); };
        feedback.querySelector('[data-scan-edit]').onclick = function () { if (this.isConnected) run(); };
        feedback.querySelector('[role=alert]').focus();
      } finally {
        busy = false;
        if (scope.current()) { root.removeAttribute('aria-busy'); if (opener.isConnected) opener.disabled = false; }
      }
    }
    openScan();
  });
})();
