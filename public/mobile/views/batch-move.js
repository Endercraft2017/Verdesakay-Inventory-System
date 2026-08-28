/* Batch stock in / out — scan a run of items, set quantities, submit them all.
   #/batch?mode=in|out */
(function () {
  MApp.route('batch', function (view, params) {
    var mode = params.mode === 'out' ? 'out' : 'in';
    var label = mode === 'out' ? 'Batch Stock Out' : 'Batch Stock In';
    MApp.setTitle(label);
    view.innerHTML = '<div class="m-hint">Loading…</div>';

    mLocations.load().then(function () {
      view.innerHTML = '';
      var loc = mLocations.select({ label: 'Location' });
      view.appendChild(loc.el);

      var rows = [];
      var picker = mItemPicker({
        label: 'Scan / add items', onPick: function (it) {
          var ex = rows.find(function (r) { return r.item.id === it.id; });
          if (ex) { ex.qty++; draw(); return; }
          rows.push({ item: it, qty: 1 });
          draw();
        },
      });
      view.appendChild(picker.el);

      var wrap = mEl('<div class="m-count-list"></div>');
      view.appendChild(wrap);
      var note = mEl('<label class="m-field"><span class="m-label">Note (optional)</span><input class="m-input" data-note maxlength="200" /></label>');
      view.appendChild(note);
      var bar = mEl('<div class="m-actions"><button class="m-btn" data-go>Submit</button></div>');
      view.appendChild(bar);

      function draw() {
        wrap.innerHTML = '';
        if (!rows.length) wrap.appendChild(mEl('<div class="m-hint">No items yet.</div>'));
        rows.forEach(function (r, i) {
          var row = mEl(
            '<div class="m-count-row">' +
            '  <div class="m-count-name"><b>' + mEsc(r.item.name) + '</b><span>' + mEsc(r.item.sku || '') + '</span></div>' +
            '  <span class="m-qty sm">' +
            '    <button type="button" data-d="-1">&minus;</button>' +
            '    <input type="number" inputmode="numeric" value="' + r.qty + '" />' +
            '    <button type="button" data-d="1">+</button></span>' +
            '  <button class="m-count-x" aria-label="Remove">&times;</button>' +
            '</div>'
          );
          var input = row.querySelector('input');
          input.oninput = function () { r.qty = parseInt(input.value, 10) || 0; };
          row.querySelectorAll('[data-d]').forEach(function (b) {
            b.onclick = function () { r.qty = Math.max(1, (r.qty || 0) + parseInt(b.dataset.d, 10)); input.value = r.qty; };
          });
          row.querySelector('.m-count-x').onclick = function () { rows.splice(i, 1); draw(); };
          wrap.appendChild(row);
        });
        var n = rows.reduce(function (s, r) { return s + (r.qty || 0); }, 0);
        bar.querySelector('[data-go]').textContent = rows.length ? 'Submit ' + rows.length + ' item(s) · ' + n + ' units' : 'Submit';
        bar.querySelector('[data-go]').disabled = !rows.length;
      }
      draw();

      bar.querySelector('[data-go]').onclick = function () {
        var todo = rows.filter(function (r) { return r.qty > 0; });
        if (!todo.length) return;
        bar.querySelector('[data-go]').disabled = true;
        var reason = note.querySelector('input').value.trim() || null;
        var ok = 0, queued = 0, fail = 0;
        todo.reduce(function (p, r) {
          return p.then(function () {
            return mSubmit('/inventory/' + r.item.id + '/adjust', {
              change: mode === 'out' ? -r.qty : r.qty, location_id: loc.value(), reason: reason,
            }, { label: label + ' — ' + r.item.name + ' ×' + r.qty })
              .then(function (res) { res.queued ? queued++ : ok++; })
              .catch(function () { fail++; });
          });
        }, Promise.resolve()).then(function () {
          mSuccess(view, {
            title: label + ' done',
            lines: [ok + ' posted'].concat(queued ? [queued + ' queued (offline)'] : [])
              .concat(fail ? [fail + ' failed — check stock levels'] : []),
            actions: [
              { label: 'New batch', onClick: function () { MApp.go('batch', { mode: mode }); } },
              { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
            ],
          });
        });
      };
    }).catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  });
})();
