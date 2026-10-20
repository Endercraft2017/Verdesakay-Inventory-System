/* Mobile Sales: commercial follow-up and open sale creation. Physical stock-out stays in Release orders. */
(function () {
  function permitted(create) {
    return MApp.hasModule('sales') && MApp.can('orders.view') &&
      (create ? MApp.can('orders.create') : MApp.can('orders.create') || MApp.can('orders.edit'));
  }
  function denied(view) { view.innerHTML = '<div class="m-error">Sales access is required for this screen.</div>'; }
  function loading(view) { view.innerHTML = '<section class="rk-page"><div class="rk-empty">Loading sales…</div></section>'; }
  function problem(view, error) {
    view.innerHTML = '<section class="rk-page"><div class="m-error" role="alert">' + mEsc(error.message || 'Sales could not load. Refresh to retry.') + '</div></section>';
  }
  function number(value) { return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money(value, currency) { return (currency || 'PHP') + ' ' + number(value); }
  function stage(order, queue) {
    var status = String(order.status || '').toLowerCase();
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'completed' || status === 'fulfilled') return 'Complete';
    if (order.release_slip_number && !order.backordered) return 'Shipped';
    if (status === 'released' || order.release_slip_number || (queue && queue.releasing.some(function (r) { return Number(r.id) === Number(order.id); }))) return 'Picking & release';
    if (status === 'approved' || (queue && queue.to_accept.some(function (r) { return Number(r.id) === Number(order.id); }))) return 'Awaiting warehouse';
    return 'CSR review';
  }
  function openOrder(host) {
    host.querySelectorAll('[data-sale-id]').forEach(function (button) {
      button.onclick = function () { MApp.go('sales-order', { id: button.dataset.saleId }); };
    });
  }
  function saleCard(order, status) {
    return '<button type="button" class="rk-card rk-unitcard" data-sale-id="' + Number(order.id) + '">' +
      '<b>' + mEsc(order.number) + ' · ' + mEsc(order.customer_name || 'Walk-in') + '</b>' +
      '<span>' + mEsc(status) + (order.backordered ? ' · Goods pending' : '') + '</span>' +
      '<small>' + mEsc(money(order.total, order.currency)) + '</small></button>';
  }
  MApp.route('sales', async function (view) {
    MApp.setTitle('Sales pipeline');
    if (!permitted(false)) return denied(view);
    loading(view);
    try {
      var data = await Promise.all([API.get('/orders?type=sale'), API.get('/release-slips/queue')]);
      if (!view.isConnected || location.hash.split('?')[0] !== '#/sales') return;
      var orders = data[0] || [], queue = data[1] || { to_accept: [], releasing: [] };
      var groups = ['CSR review', 'Awaiting warehouse', 'Picking & release', 'Shipped / complete'];
      var buckets = [[], [], [], []];
      orders.forEach(function (order) {
        var s = stage(order, queue);
        if (s === 'Cancelled') return;
        buckets[s === 'CSR review' ? 0 : s === 'Awaiting warehouse' ? 1 : s === 'Picking & release' ? 2 : 3].push(order);
      });
      view.innerHTML = '<section class="rk-page"><h1>Sales pipeline</h1>' +
        '<p class="m-hint">Follow orders from CSR review to warehouse release. A slip records physical stock-out.</p>' +
        '<div class="m-actions"><button type="button" class="m-btn" id="sales-service">Customer service</button>' +
        (MApp.can('orders.create') ? '<button type="button" class="m-btn m-btn-secondary" id="sales-new">New sale order</button>' : '') + '</div>' +
        groups.map(function (title, index) {
          return '<section class="rk-card"><h2>' + title + ' · ' + buckets[index].length + '</h2>' +
            (buckets[index].length ? buckets[index].slice(0, 5).map(function (order) { return saleCard(order, stage(order, queue)); }).join('') : '<p class="m-hint">No orders at this stage.</p>') +
            (buckets[index].length > 5 ? '<p class="m-hint">Use Customer service to find other orders.</p>' : '') + '</section>';
        }).join('') + '</section>';
      view.querySelector('#sales-service').onclick = function () { MApp.go('sales-service'); };
      view.querySelector('#sales-new')?.addEventListener('click', function () { MApp.go('sales-new'); });
      openOrder(view);
    } catch (error) { if (view.isConnected) problem(view, error); }
  });

  MApp.route('sales-service', async function (view) {
    MApp.setTitle('Customer service');
    if (!permitted(false)) return denied(view);
    loading(view);
    try {
      var data = await Promise.all([API.get('/orders?type=sale'), API.get('/release-slips/queue')]);
      if (!view.isConnected || location.hash.split('?')[0] !== '#/sales-service') return;
      var orders = data[0] || [], queue = data[1] || { to_accept: [], releasing: [] };
      view.innerHTML = '<section class="rk-page"><h1>Customer service</h1>' +
        '<p class="m-hint">Find a customer order and check its live handoff stage.</p>' +
        (MApp.can('orders.create') ? '<div class="m-actions"><button type="button" class="m-btn" id="sales-new">New sale order</button></div>' : '') +
        '<label class="m-field"><span class="m-label">Search customer or order</span><input class="m-input" id="sales-search" type="search" autocomplete="off" placeholder="Name or SO number"></label>' +
        '<label class="m-field"><span class="m-label">Stage</span><select class="m-input" id="sales-stage"><option value="active">Active orders</option><option value="all">All orders</option>' +
        '<option>CSR review</option><option>Awaiting warehouse</option><option>Picking &amp; release</option><option value="shipped">Shipped / complete</option></select></label>' +
        '<div id="sales-results" aria-live="polite"></div></section>';
      var search = view.querySelector('#sales-search'), filter = view.querySelector('#sales-stage'), results = view.querySelector('#sales-results');
      function draw() {
        var query = search.value.trim().toLowerCase();
        var matches = orders.filter(function (order) {
          var s = stage(order, queue);
          return (!query || (String(order.number) + ' ' + String(order.customer_name || '')).toLowerCase().includes(query)) &&
            (filter.value === 'all' || filter.value === 'active' && !['Cancelled', 'Complete', 'Shipped'].includes(s) ||
              filter.value === 'shipped' && ['Complete', 'Shipped'].includes(s) || filter.value === s);
        });
        results.innerHTML = matches.length ? matches.map(function (order) { return saleCard(order, stage(order, queue)); }).join('') : '<div class="rk-empty">No matching customer orders.</div>';
        openOrder(results);
      }
      search.oninput = draw; filter.onchange = draw; draw();
      view.querySelector('#sales-new')?.addEventListener('click', function () { MApp.go('sales-new'); });
    } catch (error) { if (view.isConnected) problem(view, error); }
  });

  MApp.route('sales-order', async function (view, params) {
    MApp.setTitle('Sale order');
    if (!permitted(false)) return denied(view);
    var id = Number(params && params.id);
    if (!Number.isInteger(id) || id < 1) return problem(view, new Error('Choose a sale order from the pipeline or customer-service list.'));
    loading(view);
    try {
      var data = await Promise.all([API.get('/orders/' + id), API.get('/release-slips/queue')]);
      var order = data[0], queue = data[1];
      if (!view.isConnected || Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id')) !== id) return;
      if (order.type !== 'sale') throw new Error('This is not a sale order.');
      var current = stage(order, queue);
      var next = current === 'CSR review' ? 'CSR review or approval' : current === 'Awaiting warehouse' ? 'Warehouse acceptance' : current === 'Picking & release' ? 'Releasing and trip slip' : 'Follow up on the issued trip';
      view.innerHTML = '<section class="rk-page"><h1>' + mEsc(order.number) + '</h1>' +
        '<div class="rk-card"><b>' + mEsc(order.customer_name || 'Walk-in') + '</b><p>' + mEsc(current) + '</p>' +
        '<small>Next owner: ' + mEsc(next) + '</small></div>' +
        '<div class="rk-card"><h2>Order lines</h2>' + (order.items || []).map(function (line) {
          var mode = line.fulfillment_mode === 'ckd' ? 'CKD' : line.fulfillment_mode === 'semi_built' ? 'Semi-built' : 'Fully built / part';
          return '<div class="m-field"><b>' + mEsc(line.name) + '</b><small>' + mEsc(mode) + ' · ' + mEsc(line.quantity) + ' ' + mEsc(line.unit || '') + ' × ' + mEsc(money(line.unit_price, order.currency)) + '</small></div>';
        }).join('') + '<p><b>Total ' + mEsc(money(order.total, order.currency)) + '</b></p></div>' +
        (order.release_slip_number ? '<p class="m-hint">Latest release slip: ' + mEsc(order.release_slip_number) + '</p>' : '') +
        '<div class="m-actions"><button type="button" class="m-btn m-btn-secondary" id="sales-back">Customer service</button></div></section>';
      view.querySelector('#sales-back').onclick = function () { MApp.go('sales-service'); };
    } catch (error) { if (view.isConnected) problem(view, error); }
  });

  MApp.route('sales-new', async function (view) {
    MApp.setTitle('New sale order');
    if (!permitted(true)) return denied(view);
    loading(view);
    try {
      var attempt = await mWorkflow.draft('sales-new');
      if (!view.isConnected || location.hash.split('?')[0] !== '#/sales-new') return;
      if (attempt.operation.state !== 'draft') return mWorkflow.paint(view, attempt);
      var lines = [], selected = null;
      view.innerHTML = '<section class="rk-page"><h1>New sale order</h1>' +
        '<p class="m-hint">Save an open order for Sales review. Warehouse release follows approval; creating this order moves no stock.</p>' +
        '<label class="m-field"><span class="m-label">Customer name *</span><input class="m-input" data-f="customer" maxlength="160" autocomplete="organization"></label>' +
        '<label class="m-field"><span class="m-label">Contact</span><input class="m-input" data-f="contact" maxlength="160"></label>' +
        '<div data-picker></div><p class="m-hint" data-selected>Choose an item or product to add.</p>' +
        '<div class="m-two"><label class="m-field"><span class="m-label">Quantity</span><input class="m-input" data-f="qty" type="number" inputmode="decimal" min="0.001" step="any" value="1"></label>' +
        '<label class="m-field"><span class="m-label">Unit price (PHP)</span><input class="m-input" data-f="price" type="number" inputmode="decimal" min="0" step="0.01" value="0"></label></div>' +
        '<label class="m-field" data-mode-row hidden><span class="m-label">Build / shipping form</span><select class="m-input" data-f="mode"><option value="assembled">Fully built</option><option value="semi_built">Semi-built</option><option value="ckd">CKD · boxed parts</option></select></label>' +
        '<div class="m-actions"><button type="button" class="m-btn m-btn-secondary" id="sales-add-item">Add item</button></div>' +
        '<div class="rk-card"><h2>Additional fee</h2><p class="m-hint">Shipping, admin or another fee can be added as a separate line.</p>' +
        '<label class="m-field"><span class="m-label">Fee name</span><input class="m-input" data-f="fee-name" maxlength="200"></label>' +
        '<label class="m-field"><span class="m-label">Amount (PHP)</span><input class="m-input" data-f="fee-amount" type="number" inputmode="decimal" min="0" step="0.01"></label>' +
        '<button type="button" class="m-btn m-btn-secondary" id="sales-add-fee">Add fee</button></div>' +
        '<div class="rk-card"><h2>Order lines</h2><div data-lines>No lines yet.</div><p data-total></p></div>' +
        '<label class="m-field"><span class="m-label">Notes</span><textarea class="m-input" data-f="notes" maxlength="2000"></textarea></label>' +
        '<div class="m-actions"><button type="button" class="m-btn" id="sales-save">Save open sale order</button></div></section>';
      var get = function (key) { return view.querySelector('[data-f="' + key + '"]'); };
      var picker = mItemPicker({ label: 'Find item / product', onPick: function (item) {
        selected = item;
        view.querySelector('[data-selected]').textContent = item.name + (item.sku ? ' · ' + item.sku : '');
        view.querySelector('[data-mode-row]').hidden = !item.is_finished_product;
        get('mode').value = 'assembled';
        var price = Number(item.attributes && item.attributes.sale_price);
        get('price').value = Number.isFinite(price) && price >= 0 ? price.toFixed(2) : '0.00';
      } });
      view.querySelector('[data-picker]').appendChild(picker.el);
      function drawLines() {
        view.querySelector('[data-lines]').innerHTML = lines.length ? lines.map(function (line, index) {
          return '<div class="m-field"><b>' + mEsc(line.name) + '</b><small>' + mEsc(line.quantity) + ' × ' + mEsc(money(line.unit_price)) +
            (line.item_id && line.fulfillment_mode !== 'assembled' ? ' · ' + mEsc(line.fulfillment_mode === 'ckd' ? 'CKD' : 'Semi-built') : '') + '</small> ' +
            '<button type="button" class="m-btn m-btn-sm m-btn-secondary" data-remove="' + index + '">Remove</button></div>';
        }).join('') : 'No lines yet.';
        view.querySelectorAll('[data-remove]').forEach(function (button) { button.onclick = function () { lines.splice(Number(button.dataset.remove), 1); drawLines(); }; });
        view.querySelector('[data-total]').textContent = 'Subtotal ' + money(lines.reduce(function (sum, line) { return sum + line.quantity * line.unit_price; }, 0));
      }
      view.querySelector('#sales-add-item').onclick = function () {
        var qty = Number(get('qty').value), price = Number(get('price').value);
        if (!selected) return mToast('Choose an item first.', 'err');
        if (!get('price').value || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) return mToast('Enter a valid quantity and price.', 'err');
        lines.push({ item_id: selected.id, name: selected.name, sku: selected.sku || null, unit: selected.unit || 'pcs', quantity: qty, unit_price: price,
          fulfillment_mode: selected.is_finished_product ? get('mode').value : 'assembled' });
        selected = null; view.querySelector('[data-selected]').textContent = 'Choose another item or product to add.'; drawLines();
      };
      view.querySelector('#sales-add-fee').onclick = function () {
        var name = get('fee-name').value.trim(), amount = Number(get('fee-amount').value);
        if (!name || !get('fee-amount').value || !Number.isFinite(amount) || amount < 0) return mToast('Enter a fee name and a valid amount.', 'err');
        lines.push({ name: name, quantity: 1, unit_price: amount, unit: 'fee' });
        get('fee-name').value = ''; get('fee-amount').value = ''; drawLines();
      };
      view.querySelector('#sales-save').onclick = async function () {
        var customer = get('customer').value.trim();
        if (!customer || !lines.length) return mToast('Enter a customer and at least one order line.', 'err');
        if (navigator.onLine === false) return mToast('Reconnect before creating a sale order.', 'err');
        var button = this; button.disabled = true;
        var payload = { type: 'sale', status: 'open', customer_name: customer, customer_contact: get('contact').value.trim() || null,
          notes: get('notes').value.trim() || null, currency: 'PHP', items: lines.map(function (line) { return Object.assign({}, line); }) };
        try {
          await mWorkflow.start(attempt, { path: '/orders', payload: payload, title: 'Open sale order for ' + customer,
            successLabel: 'Sale order saved for Sales review', role: 'sales', reviewRoute: 'sales-order', reviewPath: '/orders?type=sale', resultParam: 'id' });
          if (view.isConnected && location.hash.split('?')[0] === '#/sales-new') mWorkflow.paint(view, attempt);
        } catch (error) { mToast(error.message || 'Sale order could not be saved.', 'err'); button.disabled = false; }
      };
      drawLines();
    } catch (error) { if (view.isConnected) problem(view, error); }
  });
})();
