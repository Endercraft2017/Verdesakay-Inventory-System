/* Cycle count / stock take — pick a location, scan items and enter the counted
   quantity; the app posts an adjustment for every line whose count differs from the
   system figure (reason "Cycle count"). */
(function () {
  MApp.route('cycle-count', function (view) {
    MApp.setTitle('Cycle count');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    mLocations.load().then(function () {
      view.innerHTML = '';
      var sel = mLocations.select({ label: 'Counting which location?' });
      var start = mEl('<div class="m-actions"><button class="m-btn">Start count</button></div>');
      view.appendChild(sel.el);
      view.appendChild(start);
      start.querySelector('button').onclick = function () {
        runCount(view, sel.value(), sel.select.options[sel.select.selectedIndex].text.split(' — ')[0]);
      };
    }).catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  });

  function runCount(view, locId, locName) {
    MApp.setTitle('Count · ' + locName);
    view.innerHTML = '';
    var rows = []; // { item, system, counted }

    var picker = mItemPicker({
      label: 'Scan / add an item', onPick: function (it) {
        if (rows.some(function (r) { return r.item.id === it.id; })) { mToast('Already in the list', 'err'); return; }
        API.get('/inventory/' + it.id + '/stock').then(function (bd) {
          var here = (bd || []).find(function (b) { return b.location_id === locId; });
          rows.push({ item: it, system: here ? here.quantity : 0, counted: here ? here.quantity : 0 });
          draw();
        });
      },
    });
    view.appendChild(picker.el);

    var listWrap = mEl('<div class="m-count-list"></div>');
    view.appendChild(listWrap);
    var bar = mEl('<div class="m-actions"><button class="m-btn" data-post>Post adjustments</button></div>');
    view.appendChild(bar);

    function draw() {
      listWrap.innerHTML = '';
      if (!rows.length) { listWrap.appendChild(mEl('<div class="m-hint">No items counted yet.</div>')); }
      rows.forEach(function (r, i) {
        var diff = r.counted - r.system;
        var row = mEl(
          '<div class="m-count-row">' +
          '  <div class="m-count-name"><b>' + mEsc(r.item.name) + '</b>' +
          '    <span>system ' + r.system + ' ' + mEsc(r.item.unit || '') + '</span></div>' +
          '  <input type="number" inputmode="numeric" class="m-input m-count-in" value="' + r.counted + '" />' +
          '  <span class="m-count-diff ' + (diff === 0 ? '' : (diff > 0 ? 'up' : 'down')) + '">' +
          (diff > 0 ? '+' : '') + diff + '</span>' +
          '  <button class="m-count-x" aria-label="Remove">&times;</button>' +
          '</div>'
        );
        row.querySelector('input').oninput = function (e) {
          r.counted = parseInt(e.target.value, 10);
          if (isNaN(r.counted)) r.counted = 0;
          var d = r.counted - r.system;
          var el = row.querySelector('.m-count-diff');
          el.textContent = (d > 0 ? '+' : '') + d;
          el.className = 'm-count-diff ' + (d === 0 ? '' : (d > 0 ? 'up' : 'down'));
        };
        row.querySelector('.m-count-x').onclick = function () { rows.splice(i, 1); draw(); };
        listWrap.appendChild(row);
      });
      var changed = rows.filter(function (r) { return r.counted !== r.system; }).length;
      bar.querySelector('[data-post]').textContent = changed ? 'Post ' + changed + ' adjustment(s)' : 'Nothing to post';
      bar.querySelector('[data-post]').disabled = !changed;
    }
    draw();

    bar.querySelector('[data-post]').onclick = function () {
      var todo = rows.filter(function (r) { return r.counted !== r.system; });
      if (!todo.length) return;
      bar.querySelector('[data-post]').disabled = true;
      var ok = 0, fail = 0;
      var chain = todo.reduce(function (p, r) {
        return p.then(function () {
          return API.post('/inventory/' + r.item.id + '/adjust', {
            change: r.counted - r.system, location_id: locId, reason: 'Cycle count (' + locName + ')',
          }).then(function () { ok++; }).catch(function () { fail++; });
        });
      }, Promise.resolve());
      chain.then(function () {
        mSuccess(view, {
          title: 'Count posted',
          lines: [ok + ' adjustment(s) applied at ' + locName].concat(fail ? [fail + ' failed'] : []),
          actions: [
            { label: 'Count another location', onClick: function () { MApp.go('cycle-count'); } },
            { label: 'Home', secondary: true, onClick: function () { MApp.go('home'); } },
          ],
        });
      });
    };
  }
})();
