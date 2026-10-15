/* Movable Quick Orbit — Figma V2 shared action control.
   Universal creation actions remain first; one role action is appended when useful. */
(function () {
  var KEY = 'vds_m_orbit_v2';
  var orbit;
  var dragging = false;
  var moved = false;
  var startX = 0, startY = 0, baseX = 0, baseY = 0;

  var icon = function (body) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };
  var ACTIONS = {
    request: { label: 'New request', route: 'requests', params: { new: '1' }, icon: icon('<path d="M12 5v14M5 12h14"/>') },
    report: { label: 'Report issue', route: 'report-problem', icon: icon('<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>') },
    message: { label: 'New message', route: 'inbox', params: { new: '1' }, icon: icon('<path d="M4 5h16v12H8l-4 4V5Z"/><path d="M8 9h8M8 13h5"/>') },
    scan: { label: 'Scan item', route: 'scan', icon: icon('<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M4 12h16"/>') },
    jobs: { label: 'Job orders', route: 'job-orders', icon: icon('<path d="M9 4h6l1 3H8l1-3Z"/><rect x="3" y="7" width="18" height="13" rx="2"/>') },
    qc: { label: 'Inspect unit', route: 'qc', icon: icon('<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/>') },
    repairs: { label: 'Parts requests', route: 'repairs', icon: icon('<path d="m14 7 3-3 3 3-3 3"/><path d="M17 7 7 17M5 15l4 4"/>') },
    receiving: { label: 'Record RTS', route: 'receiving', icon: icon('<path d="M4 8h16v12H4zM8 4h8v4M8 13h8"/>') },
    kitscan: { label: 'Scan job order', route: 'kit-release', params: { scan: '1' }, icon: icon('<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><path d="M8 9h8v6H8z"/>') },
    release: { label: 'Release order', route: 'so', icon: icon('<path d="M3 6h13v11H3zM16 10h3l2 3v4h-5M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>') }
  };

  function roleAction() {
    if (!window.MApp) return null;
    if (MApp.can('production.inspect_qc') || MApp.can('production.inspect_qa')) return ACTIONS.qc;
    if (MApp.can('production.repairs')) return ACTIONS.repairs;
    if (MApp.can('production.record')) return ACTIONS.jobs;
    if (MApp.can('production.receive')) return ACTIONS.receiving;
    if (MApp.can('orders.release')) return ACTIONS.release;
    // Warehouse: Figma 62:372 — the job-order scan shortcut into kit release.
    if (MApp.can('inventory.adjust')) return ACTIONS.kitscan;
    if (MApp.can('inventory.mobile')) return ACTIONS.scan;
    return null;
  }

  function renderActions() {
    if (!orbit || !window.MApp) return;
    var actions = [ACTIONS.request, ACTIONS.report, ACTIONS.message];
    var role = roleAction();
    if (role) actions.push(role);
    orbit.querySelector('.v2-orbit-menu').innerHTML = actions.map(function (a) {
      return '<button class="v2-orbit-action" type="button" data-route="' + a.route + '"' +
        (a.params ? ' data-params=\'' + JSON.stringify(a.params) + '\'' : '') + '>' +
        a.icon + '<span>' + a.label + '</span></button>';
    }).join('');
    orbit.querySelectorAll('.v2-orbit-action').forEach(function (b) {
      b.onclick = function () {
        var params = null;
        try { params = JSON.parse(b.dataset.params || 'null'); } catch (e) {}
        orbit.classList.remove('open');
        MApp.go(b.dataset.route, params);
      };
    });
  }

  function clamp(x, y) {
    var rect = orbit.getBoundingClientRect();
    var maxX = Math.max(8, window.innerWidth - rect.width - 8);
    var maxY = Math.max(76, window.innerHeight - rect.height - 104);
    return { x: Math.max(8, Math.min(maxX, x)), y: Math.max(76, Math.min(maxY, y)) };
  }
  function place(x, y, save) {
    var p = clamp(x, y);
    orbit.style.left = p.x + 'px';
    orbit.style.top = p.y + 'px';
    orbit.style.right = 'auto';
    orbit.style.bottom = 'auto';
    if (save) {
      try { localStorage.setItem(KEY, JSON.stringify({ x: p.x / window.innerWidth, y: p.y / window.innerHeight })); } catch (e) {}
    }
  }
  function restore() {
    try {
      var p = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (p && isFinite(p.x) && isFinite(p.y)) place(p.x * window.innerWidth, p.y * window.innerHeight, false);
    } catch (e) {}
  }
  function snap() {
    var r = orbit.getBoundingClientRect();
    var x = r.left + r.width / 2 < window.innerWidth / 2 ? 8 : window.innerWidth - r.width - 8;
    place(x, r.top, true);
  }
  function focusedEntry() {
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function keyboardState() {
    orbit.classList.toggle('is-keyboard', focusedEntry() || (window.visualViewport && window.visualViewport.height < window.innerHeight * .72));
  }

  function init() {
    if (document.getElementById('v2-quick-orbit')) return;
    orbit = document.createElement('div');
    orbit.id = 'v2-quick-orbit';
    orbit.className = 'v2-orbit';
    orbit.innerHTML =
      '<div class="v2-orbit-menu" role="group" aria-label="Quick actions"></div>' +
      '<button class="v2-orbit-handle" type="button" aria-expanded="false" aria-label="Open or move quick actions">' +
      '<span class="v2-orbit-grip" aria-hidden="true">⋮⋮</span><span class="v2-orbit-plus" aria-hidden="true">+</span></button>';
    document.body.appendChild(orbit);
    renderActions();
    restore();

    var h = orbit.querySelector('.v2-orbit-handle');
    h.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false; startX = e.clientX; startY = e.clientY;
      var r = orbit.getBoundingClientRect(); baseX = r.left; baseY = r.top;
      if (h.setPointerCapture) h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (moved) place(baseX + dx, baseY + dy, false);
    });
    h.addEventListener('pointerup', function () { if (dragging && moved) snap(); dragging = false; });
    h.addEventListener('click', function () {
      if (moved) { moved = false; return; }
      var open = orbit.classList.toggle('open');
      h.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('focusin', keyboardState);
    document.addEventListener('focusout', function () { setTimeout(keyboardState, 0); });
    window.addEventListener('resize', function () { restore(); keyboardState(); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', keyboardState);
    window.addEventListener('hashchange', function () { orbit.classList.remove('open'); renderActions(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.mQuickOrbit = { refresh: renderActions };
})();