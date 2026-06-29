/* Main application controller: auth, routing, ECOUNT-style chrome wiring.
   The navigation tree lives in nav-config.js (global NAV / ROUTE_NAMES). */
const App = (() => {
  let me = null;
  let departments = [];
  const routes = {}; // name -> render(viewEl, filter)

  // Active chrome selection (which primary/subtab the tree+subnav reflect).
  let activePrimaryId = null;
  let activeSubtabId = null;
  let suppressHash = false; // guard so programmatic hash changes don't re-navigate

  function register(name, renderFn) { routes[name] = renderFn; }

  function getMe() { return me; }
  function getDepartments() { return departments; }
  function isAdmin() { return me && me.role === 'admin'; }

  async function reloadDepartments() {
    try { departments = await API.get('/users/departments/list'); } catch { /* ignore */ }
    return departments;
  }

  /** Patch the current user and refresh the chrome (used after profile edits). */
  function setMe(patch) {
    me = { ...me, ...patch };
    const nameEl = document.getElementById('me-name');
    const avEl = document.getElementById('me-avatar');
    if (nameEl) nameEl.textContent = me.full_name;
    if (avEl) avEl.textContent = UI.initials(me.full_name);
  }

  /* ---------- Theme ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) {
      // Show the icon for the theme you'd switch TO.
      btn.innerHTML = UI.icon(theme === 'dark' ? 'sun' : 'moon');
      btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('vds_theme', next); } catch (e) { /* ignore */ }
    applyTheme(next);
  }

  const loginScreen = () => document.getElementById('login-screen');
  const appScreen = () => document.getElementById('app-screen');

  function showLogin() {
    me = null;
    appScreen().classList.add('hidden');
    loginScreen().classList.remove('hidden');
    document.getElementById('login-password').value = '';
  }

  async function showApp() {
    loginScreen().classList.add('hidden');
    appScreen().classList.remove('hidden');

    document.getElementById('me-name').textContent = me.full_name;
    document.getElementById('me-role').textContent = me.role;
    document.getElementById('me-dept').textContent = me.department_name || 'No dept';
    document.getElementById('me-avatar').textContent = UI.initials(me.full_name);

    try { departments = await API.get('/users/departments/list'); } catch { departments = []; }

    renderPrimaryNav(); // (re)build chrome; honours admin-only visibility

    refreshUnread();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    App._unreadTimer = setInterval(refreshUnread, 20000);

    const parsed = parseHash();
    const start = routes[parsed.route] ? parsed.route : 'dashboard';
    navigate(start, parsed.route === start ? parsed.filter : undefined);
  }

  async function refreshUnread() {
    try {
      const { count } = await API.get('/messages/unread-count');
      const badge = document.getElementById('msg-badge');
      if (!badge) return;
      badge.textContent = count;
      badge.classList.toggle('hidden', !count);
    } catch { /* ignore */ }
  }

  /* ---------- Nav-config helpers ---------- */

  /** Visible primaries (admin-only sections hidden from employees). */
  function visiblePrimaries() {
    return NAV.filter((p) => !p.adminOnly || isAdmin());
  }

  function filtersEqual(a, b) {
    const ax = a || {}, bx = b || {};
    const ak = Object.keys(ax), bk = Object.keys(bx);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => String(ax[k]) === String(bx[k]));
  }

  /** Find the first {primary, subtab, leaf} matching a route (+ optional filter). */
  function findLeaf(route, filter) {
    let routeFallback = null;
    for (const primary of NAV) {
      for (const subtab of primary.subtabs) {
        for (const leaf of subtab.tree) {
          if (leaf.route !== route) continue;
          if (filter === undefined) {
            if (!routeFallback) routeFallback = { primary, subtab, leaf };
            if (!leaf.filter) return { primary, subtab, leaf };
          } else if (filtersEqual(leaf.filter, filter)) {
            return { primary, subtab, leaf };
          }
        }
      }
    }
    return routeFallback;
  }

  /* ---------- Hash <-> location ---------- */

  function hashFor(route, filter) {
    const keys = filter ? Object.keys(filter) : [];
    if (!keys.length) return route;
    const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filter[k])}`).join('&');
    return `${route}?${qs}`;
  }

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return { route: 'dashboard', filter: undefined };
    const [route, qs] = raw.split('?');
    let filter;
    if (qs) {
      filter = {};
      for (const pair of qs.split('&')) {
        const [k, v] = pair.split('=');
        if (k) filter[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    return { route, filter };
  }

  /* ---------- Chrome rendering ---------- */

  function renderPrimaryNav() {
    const nav = document.getElementById('primary-nav');
    if (!nav) return;
    nav.innerHTML = visiblePrimaries().map((p) =>
      `<button class="primary-item" data-primary="${p.id}">${UI.icon(p.icon, 16)}<span>${UI.esc(p.label)}</span></button>`
    ).join('');
    nav.querySelectorAll('[data-primary]').forEach((b) =>
      b.addEventListener('click', () => selectPrimary(b.dataset.primary)));
  }

  /** Switch to a primary section: show its subnav and open its first leaf. */
  function selectPrimary(id) {
    const primary = NAV.find((p) => p.id === id);
    if (!primary) return;
    const subtab = primary.subtabs[0];
    const leaf = subtab && subtab.tree[0];
    if (leaf) navigate(leaf.route, leaf.filter);
  }

  function renderSubnav(primary) {
    const el = document.getElementById('subnav');
    if (!el) return;
    if (!primary) { el.innerHTML = ''; return; }
    el.innerHTML = primary.subtabs.map((s) =>
      `<button class="subtab ${s.id === activeSubtabId ? 'active' : ''}" data-subtab="${s.id}">${UI.esc(s.label)}</button>`
    ).join('');
    el.querySelectorAll('[data-subtab]').forEach((b) =>
      b.addEventListener('click', () => {
        const sub = primary.subtabs.find((s) => s.id === b.dataset.subtab);
        const leaf = sub && sub.tree[0];
        if (leaf) navigate(leaf.route, leaf.filter);
      }));
  }

  function renderTree(primary, subtab, activeRoute, activeFilter) {
    const el = document.getElementById('tree-nav');
    if (!el) return;
    if (!primary || !subtab) { el.innerHTML = ''; return; }
    const leaves = subtab.tree.map((leaf) => {
      const on = leaf.route === activeRoute && filtersEqual(leaf.filter, activeFilter);
      return `<button class="tree-leaf ${on ? 'active' : ''}" data-route="${leaf.route}"
        data-filter='${leaf.filter ? UI.esc(JSON.stringify(leaf.filter)) : ''}'>
        ${UI.icon(leaf.icon, 16)}<span>${UI.esc(leaf.label)}</span></button>`;
    }).join('');
    el.innerHTML = `<div class="tree-group"><div class="tree-group-label">${UI.esc(subtab.label)}</div>${leaves}</div>`;
    el.querySelectorAll('[data-route]').forEach((b) =>
      b.addEventListener('click', () => {
        const f = b.dataset.filter ? JSON.parse(b.dataset.filter) : undefined;
        navigate(b.dataset.route, f);
      }));
  }

  function setActivePrimaryHighlight() {
    document.querySelectorAll('#primary-nav [data-primary]').forEach((b) =>
      b.classList.toggle('active', b.dataset.primary === activePrimaryId));
  }

  /* ---------- Navigation ---------- */

  function navigate(name, filter) {
    if (!routes[name]) { name = 'dashboard'; filter = undefined; }

    // Resolve where this lives in the nav tree (for chrome highlighting).
    const loc = findLeaf(name, filter);
    if (loc) {
      activePrimaryId = loc.primary.id;
      activeSubtabId = loc.subtab.id;
    }

    // Reflect in the URL without triggering a re-navigation.
    suppressHash = true;
    location.hash = hashFor(name, filter);
    suppressHash = false;

    // Repaint chrome.
    const primary = NAV.find((p) => p.id === activePrimaryId);
    const subtab = primary && primary.subtabs.find((s) => s.id === activeSubtabId);
    setActivePrimaryHighlight();
    renderSubnav(primary);
    renderTree(primary, subtab, name, filter);

    // Render the view.
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty">Loading…</div>';
    Promise.resolve(routes[name](view, filter)).catch((e) => {
      view.innerHTML = `<div class="empty">Failed to load: ${UI.esc(e.message)}</div>`;
    });
  }

  /* ---------- Menu search + site map ---------- */

  /** Flat list of every leaf with its breadcrumb, for search + site map. */
  function allLeaves() {
    const out = [];
    visiblePrimaries().forEach((p) =>
      p.subtabs.forEach((s) =>
        s.tree.forEach((leaf) =>
          out.push({ primary: p, subtab: s, leaf, path: `${p.label} › ${leaf.label}` }))));
    return out;
  }

  function wireMenuSearch() {
    const input = document.getElementById('menu-search');
    const results = document.getElementById('menu-search-results');
    if (!input || !results) return;

    const close = () => { results.classList.add('hidden'); results.innerHTML = ''; };
    const goto = (route, filter) => { close(); input.value = ''; navigate(route, filter); };

    function renderMatches() {
      const q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      const matches = allLeaves().filter((x) => x.path.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) {
        results.innerHTML = '<div class="menu-search-empty">No menu matches</div>';
      } else {
        results.innerHTML = matches.map((m, i) =>
          `<button class="menu-search-item" data-i="${i}">${UI.icon(m.leaf.icon, 15)}
            <span>${UI.esc(m.path)}</span></button>`).join('');
        results.querySelectorAll('[data-i]').forEach((b) =>
          b.addEventListener('click', () => {
            const m = matches[Number(b.dataset.i)];
            goto(m.leaf.route, m.leaf.filter);
          }));
      }
      results.classList.remove('hidden');
    }

    input.addEventListener('input', renderMatches);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); input.blur(); }
      if (e.key === 'Enter') {
        const first = results.querySelector('[data-i]');
        if (first) first.click();
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-search')) close();
    });
  }

  function openSiteMap() {
    const sections = visiblePrimaries().map((p) => `
      <div class="sitemap-col">
        <div class="sitemap-col-head">${UI.icon(p.icon, 16)}<span>${UI.esc(p.label)}</span></div>
        ${p.subtabs.map((s) => `
          <div class="sitemap-sub">${UI.esc(s.label)}</div>
          ${s.tree.map((leaf) =>
            `<button class="sitemap-leaf" data-route="${leaf.route}"
              data-filter='${leaf.filter ? UI.esc(JSON.stringify(leaf.filter)) : ''}'>
              ${UI.icon(leaf.icon, 14)}<span>${UI.esc(leaf.label)}</span></button>`).join('')}
        `).join('')}
      </div>`).join('');

    const m = UI.modal({
      title: 'Site Map',
      bodyHTML: `<div class="sitemap-grid">${sections}</div>`,
      cancelText: 'Close',
    });
    m.overlay.querySelectorAll('[data-route]').forEach((b) =>
      b.addEventListener('click', () => {
        const f = b.dataset.filter ? JSON.parse(b.dataset.filter) : undefined;
        m.close();
        navigate(b.dataset.route, f);
      }));
  }

  async function login(username, password) {
    const data = await API.post('/auth/login', { username, password });
    API.setToken(data.token);
    me = data.user;
    await showApp();
  }

  async function logout() {
    try { await API.post('/auth/logout'); } catch { /* ignore */ }
    API.clearToken();
    if (App._unreadTimer) clearInterval(App._unreadTimer);
    showLogin();
  }

  async function boot() {
    // Wire login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');
      const u = document.getElementById('login-username').value.trim();
      const p = document.getElementById('login-password').value;
      try {
        await login(u, p);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });

    // Utility bar: menu search + site map + pin glyph.
    document.getElementById('menu-search')
      .insertAdjacentHTML('beforebegin', UI.icon('search', 16));
    wireMenuSearch();
    document.getElementById('sitemap-btn').addEventListener('click', openSiteMap);
    document.getElementById('pin-btn').innerHTML = UI.icon('archive');

    // Right icon rail.
    const railMsg = document.getElementById('rail-messages');
    railMsg.insertAdjacentHTML('afterbegin', UI.icon('messages'));
    railMsg.addEventListener('click', () => navigate('messages', { box: 'inbox' }));
    const railAcct = document.getElementById('rail-account');
    railAcct.innerHTML = UI.icon('user'); // default profile image icon
    railAcct.addEventListener('click', () => navigate('account'));
    const logoutBtn = document.getElementById('logout-btn');
    logoutBtn.innerHTML = UI.icon('logout');
    logoutBtn.addEventListener('click', logout);
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    applyTheme(currentTheme()); // set the correct toggle icon

    // Browser back/forward or manual hash edits.
    window.addEventListener('hashchange', () => {
      if (suppressHash || !me) return;
      const parsed = parseHash();
      if (routes[parsed.route]) navigate(parsed.route, parsed.filter);
    });

    // Resume session if token present.
    if (API.getToken()) {
      try {
        const { user } = await API.get('/auth/me');
        me = user;
        await showApp();
        return;
      } catch { API.clearToken(); }
    }
    showLogin();
  }

  /** Where the user is right now (for bookmarking the current page). */
  function currentLocation() {
    const { route, filter } = parseHash();
    const r = routes[route] ? route : 'dashboard';
    const loc = findLeaf(r, filter);
    const label = loc ? `${loc.primary.label} › ${loc.leaf.label}` : r;
    return { route: r, filter: filter || null, label };
  }

  return {
    register, navigate, getMe, getDepartments, isAdmin, showLogin, refreshUnread,
    logout, boot, reloadDepartments, setMe, currentLocation,
    _routeNames: () => Object.keys(routes), // test/debug seam
  };
})();

document.addEventListener('DOMContentLoaded', () => App.boot());
