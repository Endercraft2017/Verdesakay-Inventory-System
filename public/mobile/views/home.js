/* Home — one of four hubs picked by the segmented control in the shell:
   Me (Today feed) · Approvals · People · Warehouse. */
(function () {
  var STACK_ICON = {
    punch: '🕒', task: '✅', request: '📝', correction: '🛠️', approval: '✔️', message: '✉️',
  };

  MApp.route('home', function (view) {
    var s = MApp.seg();
    if (s === 'warehouse') return warehouseHub(view);
    if (s === 'approvals') return approvalsHub(view);
    if (s === 'people') return peopleHub(view);
    return meHub(view);
  });

  /* ---------------- Me — the "Today" feed ---------------- */
  function meHub(view) {
    MApp.setTitle('Today');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/today')
      .then(function (t) { drawMe(view, t); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function drawMe(view, t) {
    view.innerHTML = '';
    var g = t.greeting || {};
    view.appendChild(mEl('<div class="m-hello">Good ' + mEsc(g.part_of_day || 'day') +
      (g.name ? ', ' + mEsc(g.name) : '') + '</div>'));

    // clock card
    if (t.clock && t.clock.linked) {
      var c = t.clock;
      var inNow = c.clocked_in;
      var card = mEl(
        '<div class="m-panel m-clockcard ' + (inNow ? 'in' : 'out') + '">' +
        '<span class="m-cc-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>' +
        '<span class="m-cc-body ' + (inNow ? 'in' : 'out') + '"><b>' +
        (inNow ? 'Clocked in · ' + mEsc(c.hours_today) + ' h today' : 'Not clocked in') + '</b>' +
        '<span>' + (c.shift ? mEsc(c.shift.start_time) + ' – ' + mEsc(c.shift.end_time) + ' · Today’s shift'
          : (inNow ? 'since ' + mEsc(c.since) : 'Scan the office code')) + '</span></span>' +
        '<button class="m-cc-btn">' + (inNow ? 'Clock' : 'Clock') + '</button>' +
        '</div>'
      );
      card.querySelector('.m-cc-btn').onclick = function () { MApp.go('clock'); };
      view.appendChild(card);
    }

    // today stack
    view.appendChild(mEl('<div class="m-sectitle">Today’s stack</div>'));
    var stack = t.stack || [];
    if (!stack.length) {
      view.appendChild(mEl('<div class="m-stack-empty">Nothing needs you right now. 🎉</div>'));
    } else {
      var wrap = mEl('<div class="m-stack"></div>');
      stack.forEach(function (it) {
        var row = mEl(
          '<div class="m-stack-item ' + mEsc(it.urgency) + '">' +
          '<span class="m-stack-ic">' + (STACK_ICON[it.kind] || '•') + '</span>' +
          '<span class="m-stack-tx"><b>' + mEsc(it.title) + '</b>' +
          (it.subtitle ? '<span>' + mEsc(it.subtitle) + '</span>' : '') + '</span>' +
          '<span class="m-urg ' + mEsc(it.urgency) + '">' + mEsc(it.urgency) + '</span>' +
          '<span class="m-stack-ch"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
          '</div>'
        );
        row.onclick = function () { MApp.go(it.route); };
        wrap.appendChild(row);
      });
      view.appendChild(wrap);
    }

    if (t.next_shift) {
      var ns = t.next_shift;
      view.appendChild(mEl('<div class="m-nextshift">📅 Next shift <b>' + mEsc(ns.work_date) + '</b>' +
        (ns.start_time ? ' · ' + mEsc(ns.start_time) + ' – ' + mEsc(ns.end_time || '') : '') + '</div>'));
    }

    if (t.announcement) {
      var a = t.announcement;
      var ab = mEl(
        '<div class="m-annc"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 0 1-5.8-1.6"/></svg>' +
        '<span class="m-annc-tx"><b>' + mEsc(a.title) + '</b>' +
        '<span>' + mEsc((a.body || '').slice(0, 90)) + ((a.body || '').length > 90 ? '…' : '') + '</span></span>' +
        '<button>View all</button></div>'
      );
      ab.querySelector('button').onclick = function () { MApp.go('announcements'); };
      view.appendChild(ab);
    }

    // Quick pull
    view.appendChild(quickPull());
  }

  function quickPull() {
    var TILES = [
      ['🕒', 'Time Clock', 'clock'], ['🛠️', 'Fix Punch', 'time-fix'],
      ['📝', 'Requests', 'requests'], ['💵', 'Payslips', 'payslips'],
      ['📅', 'Schedule', 'schedule'], ['✅', 'Tasks', 'tasks'],
      ['📣', 'News', 'announcements'], ['👥', 'Directory', 'directory'],
    ];
    var box = mEl('<div class="m-panel" style="padding:4px 10px 8px"></div>');
    var t = mEl('<button class="m-qp-toggle">Quick pull <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></button>');
    var grid = mEl('<div class="m-qp-grid"></div>');
    TILES.forEach(function (x) {
      var b = mEl('<button><span>' + x[0] + '</span><span>' + mEsc(x[1]) + '</span></button>');
      b.onclick = function () { MApp.go(x[2]); };
      grid.appendChild(b);
    });
    var open = true;
    t.onclick = function () { open = !open; grid.style.display = open ? '' : 'none'; t.style.opacity = open ? '' : '.6'; };
    box.appendChild(t); box.appendChild(grid);
    return box;
  }

  /* ---------------- Approvals hub ---------------- */
  function approvalsHub(view) {
    MApp.setTitle('Approvals');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/me/approvals')
      .then(function (r) {
        view.innerHTML = '';
        var reqs = r.requests || [], tcs = r.time_corrections || [];
        var n = reqs.length + tcs.length;
        var head = mEl(
          '<div class="m-panel" style="text-align:center">' +
          '<div style="font-size:34px;font-weight:800">' + n + '</div>' +
          '<div class="m-hint">' + (n ? 'items waiting on your review' : 'nothing waiting on you') + '</div>' +
          (n ? '<button class="m-btn" style="margin-top:12px">Open review deck</button>' : '') +
          '</div>'
        );
        var btn = head.querySelector('button');
        if (btn) btn.onclick = function () { MApp.go('approvals'); };
        view.appendChild(head);
        if (!n) return;
        var ul = mEl('<ul class="m-list"></ul>');
        reqs.slice(0, 8).forEach(function (x) {
          var li = mEl('<li class="m-list-row"><div><b>' + mEsc(x.form_name) + '</b><span>' +
            mEsc(x.employee_name || x.filed_by || '') + ' · ' + mEsc(x.number) + '</span></div><div class="m-list-qty">›</div></li>');
          li.onclick = function () { MApp.go('approvals'); };
          ul.appendChild(li);
        });
        tcs.slice(0, 8).forEach(function (x) {
          var li = mEl('<li class="m-list-row"><div><b>Time fix</b><span>' + mEsc(x.employee_name) + ' · ' + mEsc(x.work_date) + '</span></div><div class="m-list-qty">›</div></li>');
          li.onclick = function () { MApp.go('approvals'); };
          ul.appendChild(li);
        });
        view.appendChild(ul);
      })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  /* ---------------- People hub ---------------- */
  function peopleHub(view) {
    MApp.setTitle('People');
    view.innerHTML = '';
    var acts = mEl('<div class="m-panel" style="display:flex;gap:10px">' +
      '<button class="m-btn" data-inbox>Open inbox</button>' +
      '<button class="m-btn m-btn-secondary" data-dir>Directory</button></div>');
    acts.querySelector('[data-inbox]').onclick = function () { MApp.go('inbox'); };
    acts.querySelector('[data-dir]').onclick = function () { MApp.go('directory'); };
    view.appendChild(acts);
    view.appendChild(mEl('<div class="m-sectitle">Recent messages</div>'));
    var host = mEl('<div><div class="m-hint">Loading…</div></div>');
    view.appendChild(host);
    API.get('/messages?box=inbox')
      .then(function (rows) {
        host.innerHTML = '';
        if (!rows.length) { host.appendChild(mEl('<div class="m-stack-empty">No messages.</div>')); return; }
        var ul = mEl('<ul class="m-list"></ul>');
        rows.slice(0, 8).forEach(function (m) {
          var li = mEl('<li class="m-list-row"><div><b>' + mEsc(m.subject || m.sender_name || 'Message') + '</b>' +
            '<span>' + mEsc((m.body || '').slice(0, 60)) + '</span></div>' +
            '<div class="m-list-qty">' + (m.read_at ? '' : '●') + '</div></li>');
          li.onclick = function () { MApp.go('inbox'); };
          ul.appendChild(li);
        });
        host.appendChild(ul);
      })
      .catch(function () { host.innerHTML = '<div class="m-hint">Could not load messages.</div>'; });
  }

  /* ---------------- Warehouse hub ---------------- */
  function warehouseHub(view) {
    MApp.setTitle('Warehouse');
    view.innerHTML = '';

    // Type an item name / SKU (or scan) → open its Scan Result.
    var picker = mItemPicker({
      label: 'Search or scan an item',
      onPick: function (it) { MApp.go('item', { id: it.id }); },
    });
    view.appendChild(picker.el);
    view.appendChild(mEl('<div class="m-scanbar-sub">type a name or SKU, or tap the scanner</div>'));

    var stat = mEl('<div class="m-stat3">' +
      '<button data-go="low-stock"><span class="n" data-k="low">–</span><span class="l warn">Low Stock</span></button>' +
      '<button data-go="pick"><span class="n" data-k="picks">–</span><span class="l">Picks</span></button>' +
      '<button data-go="qc"><span class="n" data-k="qa">–</span><span class="l ok">QA</span></button>' +
      '</div>');
    stat.querySelectorAll('button').forEach(function (b) { b.onclick = function () { MApp.go(b.dataset.go); }; });
    view.appendChild(stat);

    API.get('/inventory/stats').then(function (s) {
      var el = stat.querySelector('[data-k="low"]'); if (el) el.textContent = s.low_stock != null ? s.low_stock : '0';
    }).catch(function () {});
    API.get('/orders?type=sale').then(function (o) {
      var open = (o || []).filter(function (x) { return x.status !== 'cancelled' && x.status !== 'closed' && x.status !== 'completed'; }).length;
      var el = stat.querySelector('[data-k="picks"]'); if (el) el.textContent = open;
    }).catch(function () {});
    API.get('/job-orders').then(function (j) {
      var qa = (j || []).reduce(function (a, x) { return a + (x.units_pending || 0); }, 0);
      var el = stat.querySelector('[data-k="qa"]'); if (el) el.textContent = qa;
    }).catch(function () {});

    view.appendChild(mEl('<div class="m-sectitle">Work queue (by urgency)</div>'));
    view.appendChild(window.mWorkQueue ? mWorkQueue() : mEl('<div class="m-hint">Loading…</div>'));
  }
})();
